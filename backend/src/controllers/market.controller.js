const db = require('../config/database');
const finnhub = require('../utils/finnhub');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { describeHaltReasonCode } = require('../services/nasdaq/haltReasonCodes');
const { isSchedulerEnabled, SCHEDULER_NAME } = require('../services/nasdaq/nasdaqHaltScheduler');
const SchedulerStatusService = require('../services/schedulerStatusService');

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Market-representative symbols used as a proxy for general market news. Reuses
// the existing Finnhub company-news pipeline (already cached) rather than a new
// provider; no scraper, no AI summarization.
const MARKET_NEWS_SYMBOLS = ['SPY', 'QQQ'];

// SEC form types surfaced in the overview. Insider Form 4 filings are noisy and
// excluded so the list reflects materially significant filings.
const OVERVIEW_FORM_TYPES = [
  '10-K', '10-Q', '8-K', 'S-1', 'S-3', '424B5',
  'SC 13D', 'SC 13G', '13F-HR',
  '10-K/A', '10-Q/A', '8-K/A'
];

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

function parseLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Coerce a query param to a trimmed, uppercased single token or null. Used for
// status/market/reason/symbol filters; bounded length prevents abuse.
function parseToken(value, maxLength = 32) {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  if (!s || s.length > maxLength) return null;
  return s;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// GET /api/market/indices
async function getIndices(req, res) {
  let quotes;
  try {
    quotes = await finnhub.getQuotes(INDEX_SYMBOLS);
  } catch (error) {
    logger.error('[MARKET] indices quote error: ' + error.message);
    quotes = {};
  }

  const indices = INDEX_SYMBOLS.map((symbol) => {
    const q = quotes && quotes[symbol];
    if (!q || q.c == null) {
      return { symbol, available: false };
    }
    return {
      symbol,
      available: true,
      price: numberOrNull(q.c),
      change: numberOrNull(q.d),
      change_percent: numberOrNull(q.dp),
      previous_close: numberOrNull(q.pc),
      timestamp: numberOrNull(q.t),
      source: q.source || null
    };
  });

  return res.json({ indices, fetched_at: Date.now() });
}

// GET /api/market/halts?limit=100&status=halted|resumed&market=NASDAQ&reason=LUDP&symbol=AAPL
async function getHalts(req, res) {
  const limit = parseLimit(req.query.limit);

  const status = parseToken(req.query.status, 16);
  const market = parseToken(req.query.market, 32);
  const reason = parseToken(req.query.reason, 50);
  const symbol = parseToken(req.query.symbol, 20);

  // Build a parameterized WHERE clause from the provided filters.
  const conditions = [];
  const params = [];

  if (status === 'HALTED') {
    conditions.push('is_resumption = false');
  } else if (status === 'RESUMED') {
    conditions.push('is_resumption = true');
  }

  if (market) {
    params.push(market);
    conditions.push(`UPPER(exchange) = $${params.length}`);
  }

  if (reason) {
    params.push(reason);
    conditions.push(`UPPER(halt_type) = $${params.length}`);
  }

  if (symbol) {
    params.push(symbol);
    conditions.push(`UPPER(symbol) = $${params.length}`);
  }

  const whereClause = conditions.length
    ? 'WHERE ' + conditions.join(' AND ')
    : '';

  params.push(limit);
  const limitIndex = params.length;

  const result = await db.query(
    `SELECT
       symbol,
       halt_type,
       reason,
       exchange,
       halted_at,
       resume_at,
       is_resumption,
       raw_payload->>'IssueName' AS issue_name
     FROM market_halts
     ${whereClause}
     ORDER BY halted_at DESC
     LIMIT $${limitIndex}`,
    params
  );

  const halts = result.rows.map((row) => {
    const resumed = Boolean(row.is_resumption);
    return {
      symbol: row.symbol,
      issue_name: row.issue_name || null,
      halt_type: row.halt_type,
      reason: row.reason,
      reason_description: describeHaltReasonCode(row.halt_type),
      exchange: row.exchange,
      halted_at: row.halted_at,
      resume_at: row.resume_at,
      is_resumption: resumed,
      status: resumed ? 'resumed' : 'halted'
    };
  });

  // Freshness: prefer the scheduler's last successful poll (from scheduler_status),
  // which records every healthy run even when no new rows are inserted. When the
  // scheduler is disabled, return scheduler_enabled=false so the UI can show
  // "Automatic updates off" instead of a misleading stale label.
  const freshness = await buildHaltFreshness();

  return res.json({ halts, count: halts.length, freshness });
}

async function buildHaltFreshness() {
  const schedulerEnabled = isSchedulerEnabled();

  let schedulerStatus = null;
  if (schedulerEnabled) {
    try {
      schedulerStatus = await SchedulerStatusService.get(SCHEDULER_NAME);
    } catch (err) {
      logger.warn('[MARKET] Failed to read scheduler_status for halts freshness: ' + err.message);
    }
  }

  return {
    scheduler_enabled: schedulerEnabled,
    last_success_at: schedulerStatus ? schedulerStatus.lastSuccessAt : null,
    last_failure_at: schedulerStatus ? schedulerStatus.lastFailureAt : null,
    last_error: schedulerStatus ? schedulerStatus.lastError : null
  };
}

// GET /api/market/news?limit=15
async function getNews(req, res) {
  const limit = parseLimit(req.query.limit);
  const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];

  const aggregated = [];
  const seenIds = new Set();

  for (const symbol of MARKET_NEWS_SYMBOLS) {
    try {
      const items = await finnhub.getCompanyNews(symbol, from, to);
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || item.id == null || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        aggregated.push({
          id: item.id,
          headline: item.headline || null,
          summary: item.summary || null,
          source: item.source || null,
          url: item.url || null,
          related: item.related || null,
          image: item.image || null,
          datetime: item.datetime || null
        });
      }
    } catch (error) {
      logger.warn('[MARKET] news fetch failed for ' + symbol + ': ' + error.message);
    }
  }

  aggregated.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  const news = aggregated.slice(0, limit);

  return res.json({ news, count: news.length, from, to });
}

// GET /api/market/earnings?limit=10
async function getEarnings(req, res) {
  const limit = parseLimit(req.query.limit);
  const today = new Date().toISOString().split('T')[0];

  const result = await db.query(
    `SELECT earnings_data, fetched_at
     FROM dashboard_earnings_cache
     WHERE date_to >= $1
     ORDER BY date_from DESC
     LIMIT 1`,
    [today]
  );

  if (result.rows.length === 0) {
    return res.json({ earnings: [], count: 0, fetched_at: null });
  }

  const row = result.rows[0];
  const all = Array.isArray(row.earnings_data) ? row.earnings_data : [];

  const upcoming = all
    .filter((e) => e && e.symbol && e.date && e.date >= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, limit)
    .map((e) => ({
      symbol: e.symbol,
      date: e.date,
      hour: e.hour || null,
      year: numberOrNull(e.year),
      quarter: numberOrNull(e.quarter),
      eps_estimate: numberOrNull(e.epsEstimate),
      eps_actual: numberOrNull(e.epsActual),
      revenue_estimate: numberOrNull(e.revenueEstimate),
      revenue_actual: numberOrNull(e.revenueActual)
    }));

  return res.json({ earnings: upcoming, count: upcoming.length, fetched_at: row.fetched_at });
}

// GET /api/market/filings?limit=10
async function getFilings(req, res) {
  const limit = parseLimit(req.query.limit);

  const result = await db.query(
    `SELECT
       sf.form_type,
       sf.filing_date,
       sf.accepted_at,
       sf.filing_url,
       sc.ticker,
       sc.company_name
     FROM sec_filings sf
     JOIN sec_companies sc ON sc.id = sf.company_id
     WHERE sf.form_type = ANY($1::text[])
     ORDER BY sf.accepted_at DESC NULLS LAST, sf.filing_date DESC NULLS LAST
     LIMIT $2`,
    [OVERVIEW_FORM_TYPES, limit]
  );

  const filings = result.rows.map((row) => ({
    ticker: row.ticker,
    company_name: row.company_name,
    form_type: row.form_type,
    filing_date: row.filing_date,
    accepted_at: row.accepted_at,
    url: row.filing_url
  }));

  return res.json({ filings, count: filings.length });
}

module.exports = {
  getIndices: asyncHandler(getIndices),
  getHalts: asyncHandler(getHalts),
  getNews: asyncHandler(getNews),
  getEarnings: asyncHandler(getEarnings),
  getFilings: asyncHandler(getFilings)
};
