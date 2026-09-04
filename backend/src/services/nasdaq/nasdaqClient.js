const axios = require('axios');
const crypto = require('crypto');
const db = require('../../config/database');
const logger = require('../../utils/logger');

const NASDAQ_HALTS_URL = 'https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalt';
const DEFAULT_USER_AGENT = 'TeejarahTrading [email protected]';
const DEFAULT_RATE_PER_SECOND = 1;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 4;
const CACHE_NAMESPACE = 'nasdaq_halts';
const CACHE_KEY = 'recent';

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

async function fetchNasdaqHaltsPage(options = {}) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    await waitForRateSlot();

    try {
      const response = await axios.get(NASDAQ_HALTS_URL, {
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        headers: {
          'User-Agent': getUserAgent(),
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'gzip, deflate'
        },
        responseType: 'text',
        validateStatus: (status) => status >= 200 && status < 400
      });

      return {
        ok: true,
        status: response.status,
        html: response.data,
        url: NASDAQ_HALTS_URL
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
        url: NASDAQ_HALTS_URL
      };
    }
  }

  return { ok: false, status: 0, error: 'max retries exceeded' };
}

function hashPayload(payload) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function parseHaltDateString(text) {
  if (!text) return null;
  const cleaned = String(text).trim();
  if (!cleaned) return null;

  const match = cleaned.match(/(\d{1,2}:\d{2}:\d{2})\s*(AM|PM)?/i);
  if (match) {
    const today = new Date();
    const datePart = today.toISOString().slice(0, 10);
    const timePart = match[1];
    const ampm = match[2] ? match[2].toUpperCase() : '';
    const iso = new Date(datePart + 'T' + timePart + ' ' + ampm + ' EST');
    if (!isNaN(iso.getTime())) {
      return iso.toISOString();
    }
  }

  const fallback = new Date(cleaned);
  if (!isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }
  return null;
}

function parseNasdaqHaltsHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const halts = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowPattern.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      const raw = cellMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
      cells.push(raw);
    }
    if (cells.length < 2) continue;

    const symbol = cells[0].toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) continue;

    const exchange = cells[1] || null;
    const reasonRaw = cells[2] || '';
    const haltedAtText = cells[3] || '';
    const resumeAtText = cells[4] || '';

    const haltedAt = parseHaltDateString(haltedAtText);
    if (!haltedAt) continue;

    const isResumption = resumeAtText.length > 0;
    const resumeAt = isResumption ? parseHaltDateString(resumeAtText) : null;

    halts.push({
      symbol,
      halt_type: isResumption ? 'Resume' : 'Halt',
      reason: reasonRaw || null,
      exchange: exchange || null,
      halted_at: haltedAt,
      resume_at: resumeAt,
      is_resumption: isResumption,
      raw_row: cells
    });
  }

  return halts;
}

async function ingestHaltEvent(halt) {
  const sourceHash = hashPayload({
    symbol: halt.symbol,
    halt_type: halt.halt_type,
    halted_at: halt.halted_at,
    exchange: halt.exchange
  });

  await db.query(
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

  return { inserted: true, sourceHash };
}

async function fetchAndIngestNasdaqHalts() {
  const result = await fetchNasdaqHaltsPage();

  if (!result.ok) {
    return { ok: false, error: result.error || result.status };
  }

  const events = parseNasdaqHaltsHtml(result.html);

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
  parseNasdaqHaltsHtml,
  ingestHaltEvent,
  fetchAndIngestNasdaqHalts,
  hashPayload,
  CACHE_NAMESPACE,
  CACHE_KEY
};
