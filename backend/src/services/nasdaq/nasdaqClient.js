const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { localToUTC } = require('../../utils/timezone');

const NASDAQ_HALTS_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const MARKET_TIMEZONE = 'America/New_York';
const DEFAULT_USER_AGENT = 'TeejarahTrading [email protected]';
const DEFAULT_RATE_PER_SECOND = 1;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 4;
const CACHE_NAMESPACE = 'nasdaq_halts';
const CACHE_KEY = 'recent';

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

function getUserAgent() {
  return process.env.NASDAQ_USER_AGENT || DEFAULT_USER_AGENT;
}

function getRatePerSecond() {
  const raw = parseInt(process.env.NASDAQ_RATE_LIMIT_PER_SECOND || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RATE_PER_SECOND;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
const rateMinIntervalMs = Math.ceil(1000 / Math.max(1, getRatePerSecond()));

async function waitForRateSlot() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < rateMinIntervalMs) {
    await sleep(rateMinIntervalMs - elapsed);
  }
  lastRequestAt = Date.now();
}

function buildFeedUrl(haltDate) {
  if (!haltDate) return NASDAQ_HALTS_URL;
  const digits = String(haltDate).replace(/\D/g, '');
  return NASDAQ_HALTS_URL + '&haltdate=' + digits;
}

async function fetchNasdaqHaltsPage(options = {}) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const url = buildFeedUrl(options.haltDate);
  const headers = {
    'User-Agent': getUserAgent(),
    'Accept': 'application/rss+xml, application/xml, text/xml',
    'Accept-Encoding': 'gzip, deflate'
  };

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    await waitForRateSlot();

    try {
      const response = await axios.get(url, {
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        headers,
        responseType: 'text',
        validateStatus: (status) => status >= 200 && status < 400
      });

      return {
        ok: true,
        status: response.status,
        xml: response.data,
        url
      };
    } catch (error) {
      const status = error.response?.status;

      if ((status === 429 || status === 503) && attempt < maxRetries) {
        const backoffMs = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
        logger.warn('[NASDAQ-HALTS] ' + status + ', retrying in ' + backoffMs + 'ms');
        await sleep(backoffMs);
        continue;
      }

      logger.error('[NASDAQ-HALTS] fetch failed: ' + (status || error.message));
      return {
        ok: false,
        status: status || 0,
        error: error.message,
        url
      };
    }
  }

  return { ok: false, status: 0, error: 'max retries exceeded', url };
}

function hashPayload(payload) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function cleanText(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

function cleanTimeToken(value) {
  if (value == null) return null;
  // Strip ALL whitespace. Historical Nasdaq values can embed large runs of
  // whitespace between the time and fractional seconds, e.g.
  // "09:30:54                      .916" -> "09:30:54.916"
  const s = String(value).replace(/\s+/g, '');
  return s === '' ? null : s;
}

function localName(tagName) {
  if (!tagName) return '';
  const idx = tagName.indexOf(':');
  return idx >= 0 ? tagName.slice(idx + 1) : tagName;
}

function extractItemFields($, $item) {
  const fields = {};
  $item.children().each((_, el) => {
    const name = localName(el.tagName || el.name);
    if (!name || fields[name] !== undefined) return;
    fields[name] = $(el).text();
  });
  return fields;
}

function getField(fields, ...names) {
  for (const n of names) {
    if (fields[n] !== undefined) return fields[n];
  }
  return undefined;
}

function normalizeUsDate(value) {
  const s = cleanText(value);
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return m[3] + '-' + m[1] + '-' + m[2];
}

function buildMarketTimestamp(dateStr, timeStr) {
  const date = normalizeUsDate(dateStr);
  if (!date) return null;
  const time = cleanTimeToken(timeStr);
  if (!time) return null;

  // Drop fractional seconds for the naive->UTC conversion (localToUTC handles
  // integer-second precision). Millisecond precision is preserved in raw_payload.
  const integerTime = time.replace(/\.\d+$/, '');
  if (!/^\d{2}:\d{2}:\d{2}$/.test(integerTime)) return null;

  const naive = date + 'T' + integerTime;
  return localToUTC(naive, MARKET_TIMEZONE);
}

function parseNasdaqHaltsRss(xml) {
  if (!xml || typeof xml !== 'string') return [];

  let $;
  try {
    $ = cheerio.load(xml, { xml: true });
  } catch (error) {
    logger.error('[NASDAQ-HALTS] RSS parse failed: ' + error.message);
    return [];
  }

  const halts = [];

  $('item').each((_, el) => {
    const $item = $(el);
    const fields = extractItemFields($, $item);

    const issueSymbol = cleanText(getField(fields, 'IssueSymbol'));
    const issueName = cleanText(getField(fields, 'IssueName'));
    const market = cleanText(getField(fields, 'Market', 'Mkt'));
    const reasonCode = cleanText(getField(fields, 'ReasonCode'));
    const pauseThresholdPrice = cleanText(getField(fields, 'PauseThresholdPrice'));
    const haltDate = getField(fields, 'HaltDate');
    const haltTime = getField(fields, 'HaltTime');
    const resumptionDate = getField(fields, 'ResumptionDate');
    const resumptionQuoteTime = cleanTimeToken(getField(fields, 'ResumptionQuoteTime'));
    const resumptionTradeTime = cleanTimeToken(getField(fields, 'ResumptionTradeTime'));

    if (!issueSymbol) return;
    const symbol = issueSymbol.toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) return;

    const haltedAt = buildMarketTimestamp(haltDate, haltTime);
    if (!haltedAt) return;

    const reasonCodeNorm = reasonCode || null;
    if (!reasonCodeNorm) return;

    const resumeAt = buildMarketTimestamp(resumptionDate, resumptionTradeTime);
    const isResumption = Boolean(resumeAt);

    const raw = {
      IssueSymbol: issueSymbol,
      IssueName: issueName || null,
      Market: market || null,
      ReasonCode: reasonCodeNorm,
      PauseThresholdPrice: pauseThresholdPrice || null,
      HaltDate: cleanText(haltDate) || null,
      HaltTime: cleanTimeToken(haltTime) || null,
      ResumptionDate: cleanText(resumptionDate) || null,
      ResumptionQuoteTime: resumptionQuoteTime || null,
      ResumptionTradeTime: resumptionTradeTime || null
    };

    halts.push({
      symbol,
      halt_type: reasonCodeNorm,
      reason: reasonCodeNorm,
      exchange: market || null,
      halted_at: haltedAt,
      resume_at: resumeAt,
      is_resumption: isResumption,
      raw
    });
  });

  return halts;
}

async function ingestHaltEvent(halt) {
  const sourceHash = hashPayload({
    symbol: halt.symbol,
    halt_type: halt.halt_type,
    halted_at: halt.halted_at,
    exchange: halt.exchange
  });

  const result = await db.query(
    `INSERT INTO market_halts (
      symbol, halt_type, reason, exchange,
      halted_at, resume_at, is_resumption,
      source_hash, raw_payload, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (symbol, halted_at, halt_type) DO UPDATE SET
      reason = EXCLUDED.reason,
      exchange = EXCLUDED.exchange,
      resume_at = EXCLUDED.resume_at,
      is_resumption = EXCLUDED.is_resumption,
      source_hash = EXCLUDED.source_hash,
      raw_payload = EXCLUDED.raw_payload
    RETURNING (xmax = 0) AS inserted`,
    [
      halt.symbol,
      halt.halt_type,
      halt.reason,
      halt.exchange,
      halt.halted_at,
      halt.resume_at,
      halt.is_resumption,
      sourceHash,
      JSON.stringify(halt)
    ]
  );

  const inserted = result.rows.length > 0 ? Boolean(result.rows[0].inserted) : false;
  return { inserted, sourceHash };
}

async function fetchAndIngestNasdaqHalts(options = {}) {
  const result = await fetchNasdaqHaltsPage(options);

  if (!result.ok) {
    return { ok: false, error: result.error || result.status };
  }

  const events = parseNasdaqHaltsRss(result.xml);

  let inserted = 0;
  let skipped = 0;

  for (const halt of events) {
    try {
      const upsertResult = await ingestHaltEvent(halt);
      if (upsertResult.inserted) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      logger.error('[NASDAQ-HALTS] ingest failed for ' + halt.symbol + ': ' + error.message);
      skipped += 1;
    }
  }

  return {
    ok: true,
    fetched: events.length,
    inserted,
    skipped
  };
}

module.exports = {
  NASDAQ_HALTS_URL,
  fetchNasdaqHaltsPage,
  parseNasdaqHaltsRss,
  ingestHaltEvent,
  fetchAndIngestNasdaqHalts,
  hashPayload,
  CACHE_NAMESPACE,
  CACHE_KEY
};
