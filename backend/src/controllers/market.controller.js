const db = require('../config/database');
const finnhub = require('../utils/finnhub');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { describeHaltReasonCode } = require('../services/nasdaq/haltReasonCodes');
const { isSchedulerEnabled, SCHEDULER_NAME } = require('../services/nasdaq/nasdaqHaltScheduler');
const SchedulerStatusService = require('../services/schedulerStatusService');
const schwabMarketData = require('../utils/schwabMarketData');
const { getMarketSession } = require('../utils/marketSession');
const { scanCandidates } = require('../utils/scanner');
const { buildFundamentalProfiles } = require('../services/fundamentalEngine');
const { assessDilutionRisk } = require('../services/dilutionRiskEngine');
const { getCatalystsForSymbols, getStrongestCatalyst } = require('../services/catalystEngine');

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Extended index set for the mover/scanner index strip. VIX and Nasdaq
// Composite use Schwab's index symbols ($VIX, $COMPX) which are verified to
// return real quotes via the existing getQuotes path.
const EXTENDED_INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', '$VIX', '$COMPX'];

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

// GET /api/market/indices?extended=true
async function getIndices(req, res) {
  const useExtended = String(req.query.extended || '').toLowerCase() === 'true';
  const symbols = useExtended ? EXTENDED_INDEX_SYMBOLS : INDEX_SYMBOLS;

  let quotes;
  try {
    quotes = await finnhub.getQuotes(symbols);
  } catch (error) {
    logger.error('[MARKET] indices quote error: ' + error.message);
    quotes = {};
  }

  const indices = symbols.map((symbol) => {
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

// Schwab indexes queried for movers. $COMPX (Nasdaq Composite) has the broadest
// coverage; $DJI and $SPX supplement. We fetch all three and merge, deduping by
// symbol, so the user sees the widest set of movers.
const MOVER_INDEXES = ['$COMPX', '$DJI', '$SPX'];
const MOVER_MAX_LIMIT = 100;
const MOVER_DEFAULT_LIMIT = 25;

function parseFloatParam(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// Categorize a mover based on net_change sign.
function categorizeMover(mover) {
  if (mover.net_change == null) return 'active';
  return mover.net_change >= 0 ? 'gainers' : 'losers';
}

// Calculate gap_pct: (last_price - previous_close) / previous_close * 100.
// Returns null if either value is missing/zero.
function calculateGapPct(lastPrice, previousClose) {
  if (!Number.isFinite(lastPrice) || !Number.isFinite(previousClose) || previousClose === 0) {
    return null;
  }
  return ((lastPrice - previousClose) / previousClose) * 100;
}

// Batch-enrich movers with catalyst badges from existing DB records.
// Queries halts, recent news, earnings, and SEC filings for the mover symbols.
async function enrichWithCatalysts(symbols) {
  if (!symbols.length) return {};
  const catalysts = {};

  // Initialize empty arrays
  for (const s of symbols) catalysts[s] = [];

  try {
    // Recent halts (last 7 days)
    const haltResult = await db.query(
      `SELECT symbol, halt_type, halted_at, resume_at, is_resumption
       FROM market_halts
       WHERE symbol = ANY($1::text[])
         AND halted_at >= NOW() - INTERVAL '7 days'
       ORDER BY halted_at DESC`,
      [symbols]
    );
    for (const row of haltResult.rows) {
      if (catalysts[row.symbol]) {
        catalysts[row.symbol].push({
          type: row.is_resumption ? 'halt_resumed' : 'halt',
          label: row.is_resumption ? 'Halt Resumed' : 'Halted',
          timestamp: row.halted_at
        });
      }
    }
  } catch (err) {
    logger.warn('[MARKET] Catalyst halt enrichment failed: ' + err.message);
  }

  try {
    // Recent earnings (within ±7 days of today)
    const today = new Date().toISOString().split('T')[0];
    const earningsResult = await db.query(
      `SELECT earnings_data FROM dashboard_earnings_cache
       WHERE date_to >= $1
       ORDER BY date_from DESC LIMIT 1`,
      [today]
    );
    if (earningsResult.rows.length) {
      const all = earningsResult.rows[0].earnings_data || [];
      const near = all.filter((e) => {
        if (!e.symbol || !e.date) return false;
        const diff = Math.abs(new Date(e.date).getTime() - Date.now());
        return diff <= 7 * 24 * 60 * 60 * 1000 && symbols.includes(e.symbol);
      });
      for (const e of near) {
        if (catalysts[e.symbol]) {
          catalysts[e.symbol].push({
            type: 'earnings',
            label: 'Earnings',
            timestamp: e.date
          });
        }
      }
    }
  } catch (err) {
    logger.warn('[MARKET] Catalyst earnings enrichment failed: ' + err.message);
  }

  try {
    // Recent SEC filings (last 7 days)
    const filingsResult = await db.query(
      `SELECT sc.ticker, sf.form_type, sf.filing_date
       FROM sec_filings sf
       JOIN sec_companies sc ON sc.id = sf.company_id
       WHERE sc.ticker = ANY($1::text[])
         AND sf.accepted_at >= NOW() - INTERVAL '7 days'
       ORDER BY sf.accepted_at DESC`,
      [symbols]
    );
    for (const row of filingsResult.rows) {
      if (catalysts[row.ticker]) {
        catalysts[row.ticker].push({
          type: 'sec_filing',
          label: row.form_type,
          timestamp: row.filing_date
        });
      }
    }
  } catch (err) {
    logger.warn('[MARKET] Catalyst SEC enrichment failed: ' + err.message);
  }

  return catalysts;
}

// GET /api/market/movers?category=gainers|losers|active&limit=25
//   &min_price=0&max_price=1000&min_gap=0&min_volume=0&include_halted=true
async function getMovers(req, res) {
  const category = parseToken(req.query.category, 16);
  const validCategories = ['gainers', 'losers', 'active'];
  const categoryFilter = validCategories.includes(category ? category.toLowerCase() : '')
    ? category.toLowerCase()
    : 'active';

  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MOVER_MAX_LIMIT)
    : MOVER_DEFAULT_LIMIT;

  const minPrice = parseFloatParam(req.query.min_price, null);
  const maxPrice = parseFloatParam(req.query.max_price, null);
  const minGap = parseFloatParam(req.query.min_gap, null);
  const minVolume = parseFloatParam(req.query.min_volume, null);
  const includeHalted = String(req.query.include_halted || '').toLowerCase() !== 'false';

  // Fetch movers from all Schwab indexes (cached 60s, single batch call each)
  const allItems = [];
  const fetchedAts = [];
  let source = 'schwab';

  for (const indexSymbol of MOVER_INDEXES) {
    const result = await schwabMarketData.getMovers(indexSymbol);
    if (result && result.items) {
      allItems.push(...result.items);
      fetchedAts.push(result.fetched_at);
      if (result.source === 'schwab-cached') source = 'schwab-cached';
    }
  }

  if (allItems.length === 0) {
    const session = getMarketSession();
    return res.json({
      session: session.session,
      session_label: session.label,
      as_of: Date.now(),
      source,
      stale: false,
      movers: [],
      indices: null,
      error: 'Movers data unavailable (Schwab connection may be inactive)'
    });
  }

  // Deduplicate by symbol (keep first occurrence — highest volume index wins)
  const seen = new Set();
  const deduped = [];
  for (const item of allItems) {
    const sym = item.symbol?.toUpperCase();
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      deduped.push(item);
    }
  }

  // Batch-quote for previous close (gap calculation). One Schwab call for all
  // mover symbols — no N+1.
  const symbolsToQuote = deduped.map((i) => i.symbol);
  let quotes = {};
  try {
    quotes = await finnhub.getQuotes(symbolsToQuote);
  } catch (err) {
    logger.warn('[MARKET] Movers batch quote failed: ' + err.message);
  }

  // Merge mover data + quote previous close, calculate gap_pct
  let movers = deduped.map((item) => {
    const sym = item.symbol;
    const q = quotes[sym] || {};
    const previousClose = q.pc != null ? Number(q.pc) : null;
    const gapPct = calculateGapPct(item.last_price, previousClose);
    return {
      symbol: sym,
      company_name: item.description,
      last_price: item.last_price,
      previous_close: previousClose,
      gap_pct: gapPct,
      change: item.net_change,
      change_percent: item.net_percent_change,
      volume: item.volume,
      total_volume: item.total_volume,
      trades: item.trades,
      market_share: item.market_share,
      // Premarket volume is NOT separately available from this Schwab endpoint.
      // The `volume` field reflects current session volume, not exclusively
      // 04:00–09:30 ET. Do not label it as premarket volume.
      premarket_volume: null,
      // RVOL requires historical average volume data not available from this
      // endpoint. Do not approximate with ordinary daily volume.
      rvol: null,
      exchange: null, // Schwab movers don't include exchange per-symbol
      data_timestamp: q.t || null,
      category: categorizeMover(item),
      halted: false, // enriched below
      catalysts: []   // enriched below
    };
  });

  // Filter by category
  if (categoryFilter === 'gainers') {
    movers = movers.filter((m) => m.change != null && m.change >= 0);
    movers.sort((a, b) => (b.change_percent || -Infinity) - (a.change_percent || -Infinity));
  } else if (categoryFilter === 'losers') {
    movers = movers.filter((m) => m.change != null && m.change < 0);
    movers.sort((a, b) => (a.change_percent || Infinity) - (b.change_percent || Infinity));
  } else {
    // active: sort by volume desc
    movers.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  }

  // Apply price/gap/volume filters
  movers = movers.filter((m) => {
    if (minPrice != null && (m.last_price == null || m.last_price < minPrice)) return false;
    if (maxPrice != null && (m.last_price == null || m.last_price > maxPrice)) return false;
    if (minGap != null && (m.gap_pct == null || m.gap_pct < minGap)) return false;
    if (minVolume != null && (m.volume == null || m.volume < minVolume)) return false;
    return true;
  });

  // Enrich with halt status
  if (seen.size > 0) {
    try {
      const haltResult = await db.query(
        `SELECT DISTINCT symbol FROM market_halts
         WHERE symbol = ANY($1::text[])
           AND is_resumption = false`,
        [Array.from(seen)]
      );
      const haltedSymbols = new Set(haltResult.rows.map((r) => r.symbol));
      movers.forEach((m) => { m.halted = haltedSymbols.has(m.symbol); });
    } catch (err) {
      logger.warn('[MARKET] Movers halt enrichment failed: ' + err.message);
    }

    // Exclude halted if requested
    if (!includeHalted) {
      movers = movers.filter((m) => !m.halted);
    }

    // Catalyst enrichment (batched DB queries, no N+1)
    const catalystMap = await enrichWithCatalysts(movers.map((m) => m.symbol));
    movers.forEach((m) => {
      m.catalysts = catalystMap[m.symbol] || [];
    });
  }

  movers = movers.slice(0, limit);

  // Fetch index quotes for market context (reuse existing infrastructure)
  let indices = null;
  try {
    const indexQuotes = await finnhub.getQuotes(EXTENDED_INDEX_SYMBOLS);
    indices = EXTENDED_INDEX_SYMBOLS.map((sym) => {
      const q = indexQuotes[sym];
      if (!q || q.c == null) return { symbol: sym, available: false };
      return {
        symbol: sym,
        available: true,
        price: numberOrNull(q.c),
        change: numberOrNull(q.d),
        change_percent: numberOrNull(q.dp),
        timestamp: numberOrNull(q.t)
      };
    });
  } catch (err) {
    logger.warn('[MARKET] Movers index quotes failed: ' + err.message);
  }

  const session = getMarketSession();
  const asOf = fetchedAts.length ? Math.min(...fetchedAts) : Date.now();
  const stale = (Date.now() - asOf) > 5 * 60 * 1000;

  return res.json({
    session: session.session,
    session_label: session.label,
    as_of: asOf,
    source,
    stale,
    movers,
    indices
  });
}

// Compact fundamental summary for scanner rows — avoids shipping the full
// per-metric metadata to the frontend.
function compactFundamental(profile) {
  if (!profile) return null;
  const g = (k) => (profile[k] && profile[k].value != null ? profile[k].value : null);
  return {
    symbol: profile.symbol,
    revenue_growth: g('revenue_growth'),
    eps_ttm: g('eps_ttm'),
    gross_margin: g('gross_margin'),
    operating_margin: g('operating_margin'),
    net_margin: g('net_margin'),
    cash_per_share: g('cash_per_share'),
    debt_to_equity: g('debt_to_equity'),
    fcf_per_share: g('fcf_per_share'),
    market_cap: g('market_cap'),
    shares_outstanding: g('shares_outstanding'),
    is_loss_making: profile.is_loss_making ?? null,
    cash_runway_months: g('cash_runway_months'),
    share_trend: profile.share_trend || null,
    unavailable: (profile._meta && profile._meta.unavailable) || []
  };
}

// GET /api/market/scanner?category=gainers&limit=25&min_score=40
async function getScanner(req, res) {
  const limit = parseLimit(req.query.limit);
  const minScoreRaw = parseInt(req.query.min_score, 10);
  const minScore = Number.isFinite(minScoreRaw) && minScoreRaw > 0
    ? Math.min(minScoreRaw, 100)
    : 40;

  const excludePennyStocks = String(req.query.exclude_penny ?? 'true').toLowerCase() !== 'false';

  // Fetch movers (reuse the same Schwab movers + enrichment pipeline)
  const allItems = [];
  const fetchedAts = [];
  let source = 'schwab';

  for (const indexSymbol of MOVER_INDEXES) {
    const result = await schwabMarketData.getMovers(indexSymbol);
    if (result && result.items) {
      allItems.push(...result.items);
      fetchedAts.push(result.fetched_at);
      if (result.source === 'schwab-cached') source = 'schwab-cached';
    }
  }

  if (allItems.length === 0) {
    const session = getMarketSession();
    return res.json({
      session: session.session,
      session_label: session.label,
      as_of: Date.now(),
      source,
      candidates: [],
      count: 0,
      error: 'Movers data unavailable (Schwab connection may be inactive)'
    });
  }

  // Deduplicate
  const seen = new Set();
  const deduped = [];
  for (const item of allItems) {
    const sym = item.symbol?.toUpperCase();
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      deduped.push(item);
    }
  }

  // Batch quote for previous close
  const symbolsToQuote = deduped.map((i) => i.symbol);
  let quotes = {};
  try {
    quotes = await finnhub.getQuotes(symbolsToQuote);
  } catch (err) {
    logger.warn('[MARKET] Scanner batch quote failed: ' + err.message);
  }

  // Build candidates with indicators (simplified — uses quote data, not full candles)
  const candidates = deduped.map((item) => {
    const sym = item.symbol;
    const q = quotes[sym] || {};
    const previousClose = q.pc != null ? Number(q.pc) : null;
    const lastPrice = item.last_price;
    const gapPct = calculateGapPct(lastPrice, previousClose);

    return {
      symbol: sym,
      company_name: item.description,
      last_price: lastPrice,
      change_percent: item.net_percent_change,
      gap_pct: gapPct,
      rvol: null, // requires intraday candle data not available here
      volume: item.volume,
      halted: false,
      catalysts: [],
      session: getMarketSession().session,
      indicators: {
        last_price: lastPrice,
        previous_close: previousClose,
        gap_pct: gapPct,
        change_percent: item.net_percent_change,
        rvol: null,
        vwap: null,
        vwap_distance: null,
        trend_regime: 'insufficient_data',
        opening_range: null,
        support_resistance: null,
        relative_strength: null,
        volume: item.volume,
        liquidity: {
          liquidity_rating: item.total_volume > 10_000_000 ? 'high' : item.total_volume > 1_000_000 ? 'moderate' : 'low',
          spread_rating: 'unknown'
        },
        volatility_regime: 'insufficient_data',
        atr_14: null
      }
    };
  });

  // Enrich with halts
  if (seen.size > 0) {
    try {
      const haltResult = await db.query(
        `SELECT DISTINCT symbol FROM market_halts
         WHERE symbol = ANY($1::text[]) AND is_resumption = false`,
        [Array.from(seen)]
      );
      const haltedSymbols = new Set(haltResult.rows.map((r) => r.symbol));
      candidates.forEach((c) => { c.halted = haltedSymbols.has(c.symbol); });
    } catch (err) {
      logger.warn('[MARKET] Scanner halt enrichment failed: ' + err.message);
    }

    // Catalyst enrichment via the catalyst engine (typed events + strength)
    const priceContext = {};
    candidates.forEach((c) => {
      priceContext[c.symbol] = { change_percent: c.change_percent, rvol: c.rvol };
    });
    const catalystMap = await getCatalystsForSymbols(candidates.map((c) => c.symbol), priceContext);
    candidates.forEach((c) => {
      c.catalysts = catalystMap[c.symbol] || [];
    });
  }

  // Fundamental profiles + dilution risk for scanner candidates (top N by rough volume)
  const fundamentalSymbols = candidates.slice(0, 20).map((c) => c.symbol);
  const [fundamentalMap, dilutionMap] = await Promise.all([
    buildFundamentalProfiles(fundamentalSymbols).catch(() => ({})),
    assessDilutionRisk(fundamentalSymbols).catch(() => ({}))
  ]);
  candidates.forEach((c) => {
    c.fundamental_summary = fundamentalMap[c.symbol] || null;
    c.dilution_risk = dilutionMap[c.symbol] || null;
  });

  // Run deterministic scanner
  const results = scanCandidates(candidates, {
    minScore,
    maxResults: limit,
    excludePennyStocks
  });

  // Post-scan enrichment: attach compact summaries + strongest catalyst + classification reasons
  for (const r of results) {
    const src = candidates.find((c) => c.symbol === r.symbol);
    if (!src) continue;
    r.fundamental_summary = compactFundamental(src.fundamental_summary);
    r.dilution_risk = src.dilution_risk
      ? { level: src.dilution_risk.level, reasons: src.dilution_risk.reasons, evidence: src.dilution_risk.evidence }
      : { level: 'LOW', reasons: ['No data'], evidence: [] };
    const strongest = getStrongestCatalyst(src.catalysts || []);
    r.catalyst_strength = strongest ? strongest.strength : null;
    r.catalyst_evidence = (src.catalysts || []).slice(0, 5).map((cat) => ({
      event_type: cat.event_type,
      label: cat.label,
      event_time: cat.event_time,
      source: cat.source,
      source_url: cat.source_url,
      strength: cat.strength
    }));
  }

  // Fetch extended index quotes for market context
  let indices = null;
  try {
    const indexQuotes = await finnhub.getQuotes(EXTENDED_INDEX_SYMBOLS);
    indices = EXTENDED_INDEX_SYMBOLS.map((sym) => {
      const q = indexQuotes[sym];
      if (!q || q.c == null) return { symbol: sym, available: false };
      return {
        symbol: sym,
        available: true,
        price: numberOrNull(q.c),
        change: numberOrNull(q.d),
        change_percent: numberOrNull(q.dp),
        timestamp: numberOrNull(q.t)
      };
    });
  } catch (err) {
    logger.warn('[MARKET] Scanner index quotes failed: ' + err.message);
  }

  const session = getMarketSession();
  const asOf = fetchedAts.length ? Math.min(...fetchedAts) : Date.now();

  return res.json({
    session: session.session,
    session_label: session.label,
    as_of: asOf,
    source,
    indices,
    candidates: results,
    count: results.length,
    min_score: minScore
  });
}

module.exports = {
  getIndices: asyncHandler(getIndices),
  getHalts: asyncHandler(getHalts),
  getNews: asyncHandler(getNews),
  getEarnings: asyncHandler(getEarnings),
  getFilings: asyncHandler(getFilings),
  getMovers: asyncHandler(getMovers),
  getScanner: asyncHandler(getScanner)
};
