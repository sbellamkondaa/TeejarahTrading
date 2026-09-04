const db = require('../../config/database');
const logger = require('../../utils/logger');
const redisService = require('../redisService');
const redisCache = require('../../utils/redisCache');
const secClient = require('../secClient');

const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const CACHE_NAMESPACE = 'sec_ticker_map';
const CACHE_KEY = 'ticker_to_cik';

async function fetchTickerMapFromSec() {
  const response = await secClient.secFetch(TICKER_MAP_URL);

  if (!response.ok) {
    throw new Error(`SEC ticker map fetch failed: ${response.error || response.status}`);
  }

  const entries = Object.values(response.data || {});

  const normalized = entries
    .filter((entry) => entry && entry.ticker && entry.cik_str)
    .map((entry) => ({
      cik: String(entry.cik_str).padStart(10, '0'),
      ticker: String(entry.ticker).toUpperCase(),
      companyName: entry.title || null,
      exchange: entry.exchange || null,
      sic: entry.sic || null,
      sicDescription: entry.sic_description || null
    }));

  return normalized;
}

async function upsertCompanies(entries) {
  for (const entry of entries) {
    await db.query(`
      INSERT INTO sec_companies (
        cik,
        ticker,
        company_name,
        exchange,
        sic,
        sic_description,
        tickers_last_refreshed_at,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (cik) DO UPDATE SET
        ticker = EXCLUDED.ticker,
        company_name = EXCLUDED.company_name,
        exchange = EXCLUDED.exchange,
        sic = EXCLUDED.sic,
        sic_description = EXCLUDED.sic_description,
        tickers_last_refreshed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `, [entry.cik, entry.ticker, entry.companyName, entry.exchange, entry.sic, entry.sicDescription]);
  }
}

async function refreshTickerMap() {
  const entries = await fetchTickerMapFromSec();
  await upsertCompanies(entries);
  await redisCache.set(CACHE_NAMESPACE, CACHE_KEY, entries, 24 * 60 * 60 * 1000);
  return entries.length;
}

async function resolveTicker(ticker) {
  if (!ticker) return null;

  const upper = String(ticker).toUpperCase();

  let entries = await redisCache.get(CACHE_NAMESPACE, CACHE_KEY);

  if (!entries) {
    try {
      entries = await fetchTickerMapFromSec();
      await redisCache.set(CACHE_NAMESPACE, CACHE_KEY, entries, 24 * 60 * 60 * 1000);
    } catch (error) {
      const result = await db.query(
        'SELECT cik, ticker, company_name FROM sec_companies WHERE UPPER(ticker) = UPPER($1) LIMIT 1',
        [upper]
      );
      if (result.rows.length === 0) return null;
      return {
        cik: result.rows[0].cik,
        ticker: result.rows[0].ticker,
        companyName: result.rows[0].company_name
      };
    }
  }

  const match = entries.find((e) => e.ticker === upper);

  if (!match) {
    const result = await db.query(
      'SELECT cik, ticker, company_name FROM sec_companies WHERE UPPER(ticker) = UPPER($1) LIMIT 1',
      [upper]
    );
    if (result.rows.length === 0) return null;
    return {
      cik: result.rows[0].cik,
      ticker: result.rows[0].ticker,
      companyName: result.rows[0].company_name
    };
  }

  return match;
}

async function getCompanyIdByCik(cik) {
  const result = await db.query(
    'SELECT id FROM sec_companies WHERE cik = $1 LIMIT 1',
    [cik]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].id;
}

module.exports = {
  refreshTickerMap,
  resolveTicker,
  getCompanyIdByCik,
  fetchTickerMapFromSec,
  CACHE_NAMESPACE,
  CACHE_KEY
};
