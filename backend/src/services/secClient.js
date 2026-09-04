const axios = require('axios');
const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../utils/logger');

const SEC_BASE = 'https://data.sec.gov';
const DEFAULT_USER_AGENT = 'TeejarahTrading [email protected]';
const DEFAULT_RATE_PER_SECOND = 1;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 4;

function getUserAgent() {
  return process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT;
}

function getRatePerSecond() {
  const raw = parseInt(process.env.SEC_RATE_LIMIT_PER_SECOND || '', 10);
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

async function secFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${SEC_BASE}${path}`;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    await waitForRateSlot();

    try {
      const response = await axios.get(url, {
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        headers: {
          'User-Agent': getUserAgent(),
          'Accept-Encoding': 'gzip, deflate',
          'Host': new URL(url).host
        },
        responseType: options.responseType ?? 'json',
        validateStatus: (status) => status >= 200 && status < 400
      });

      return {
        ok: true,
        status: response.status,
        data: response.data,
        url
      };
    } catch (error) {
      const status = error.response?.status;

      if ((status === 429 || status === 503) && attempt < maxRetries) {
        const backoffMs = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
        logger.warn(`[SEC] ${status} on ${path}, retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }

      logger.error(`[SEC] request failed: ${path} (${status || error.message})`);
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

async function getDistinctTickersForSecIngestion() {
  const candidateTables = [
    { table: 'trades', column: 'symbol' },
    { table: 'options_positions', column: 'underlying_symbol' },
    { table: 'watchlist_items', column: 'underlying' },
    { table: 'instruments', column: 'symbol' },
    { table: 'holdings', column: 'holding_symbol' }
  ];

  const tickers = new Set();

  for (const candidate of candidateTables) {
    try {
      const rows = await db.query(
        'SELECT DISTINCT UPPER(' + candidate.column + ') AS ticker FROM ' + candidate.table + ' WHERE ' + candidate.column + ' IS NOT NULL AND length(' + candidate.column + ') > 0'
      );
      for (const row of rows.rows) {
        if (row.ticker) tickers.add(row.ticker);
      }
    } catch (error) {
      continue;
    }
  }

  return Array.from(tickers);
}

module.exports = {
  SEC_BASE,
  secFetch,
  hashPayload,
  getDistinctTickersForSecIngestion,
  getUserAgent,
  getRatePerSecond
};
