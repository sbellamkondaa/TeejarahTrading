/**
 * Catalyst Engine
 *
 * Normalizes existing events into typed catalysts with deterministic strength
 * scoring based only on evidence: source quality, recency, materiality,
 * specificity, and price/volume confirmation.
 *
 * Sources: market_halts, dashboard_earnings_cache, sec_filings, Finnhub news.
 * No LLM confidence. No causation claims — a catalyst badge means relevant
 * recent information exists, not that it caused the price move.
 */

const db = require('../config/database');
const logger = require('../utils/logger');

// Catalyst event types
const CATALYST_TYPES = Object.freeze({
  EARNINGS: 'earnings',
  SEC_MATERIAL_FILING: 'sec_material_filing',
  OFFERING_FINANCING: 'offering_financing',
  INSIDER_FORM_4: 'insider_form_4',
  HALT: 'halt',
  HALT_RESUMPTION: 'halt_resumption',
  COMPANY_NEWS: 'company_news',
  CORPORATE_TRANSACTION: 'corporate_transaction'
});

// Source quality scores (deterministic)
const SOURCE_QUALITY = Object.freeze({
  sec_filing: 10,        // official regulator
  halt_feed: 9,          // exchange feed
  earnings_cache: 8,     // structured provider data
  company_news: 6        // provider news wire
});

// Materiality per SEC form type
const FORM_MATERIALITY = Object.freeze({
  '8-K': 8, '10-K': 7, '10-Q': 6, 'S-1': 7, 'S-3': 7, '424B5': 8,
  'SC 13D': 7, 'SC 13G': 5, '4': 4, '13F-HR': 3,
  '8-K/A': 7, '10-K/A': 6, '10-Q/A': 6, 'S-1/A': 6, 'S-3/A': 6
});

// Form types that map to specific catalyst types
const OFFERING_FORMS = new Set(['S-1', 'S-3', 'S-1/A', 'S-3/A', '424B5', '424B4', '424B3']);
const MATERIAL_FORMS = new Set(['8-K', '10-K', '10-Q', '8-K/A', '10-K/A', '10-Q/A', 'SC 13D', 'SC 13G']);

function isNum(v) { return v != null && Number.isFinite(Number(v)); }

function daysAgo(timestamp) {
  if (!timestamp) return null;
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

/**
 * Compute deterministic catalyst strength score (0-100).
 *
 * Components:
 * - source quality (max 20)
 * - recency (max 30): <= 1d = 30, <= 3d = 22, <= 7d = 15, <= 14d = 8, else 3
 * - materiality (max 30)
 * - specificity (max 10): event tied to exact symbol+time vs vague
 * - price/volume confirmation (max 10): |change%| >= 3 or RVOL >= 2
 *
 * @param {object} catalyst - { event_type, source, event_time, materiality, has_price_confirmation }
 * @returns {number} 0-100
 */
function scoreCatalystStrength(catalyst) {
  if (!catalyst || !catalyst.event_type) return 0;

  let score = 0;

  // Source quality (max 20)
  const sourceQuality = SOURCE_QUALITY[catalyst.source] ?? 4;
  score += Math.round((sourceQuality / 10) * 20);

  // Recency (max 30)
  const d = daysAgo(catalyst.event_time);
  if (d == null) {
    score += 5; // unknown time — minimal credit
  } else if (d <= 1) score += 30;
  else if (d <= 3) score += 22;
  else if (d <= 7) score += 15;
  else if (d <= 14) score += 8;
  else score += 3;

  // Materiality (max 30) — expects 0-10 scale
  const materiality = isNum(catalyst.materiality) ? Math.min(10, Math.max(0, catalyst.materiality)) : 5;
  score += Math.round((materiality / 10) * 30);

  // Specificity (max 10): SEC filings and halts are exact events; news is vaguer
  const specificTypes = new Set([
    CATALYST_TYPES.EARNINGS, CATALYST_TYPES.OFFERING_FINANCING,
    CATALYST_TYPES.INSIDER_FORM_4, CATALYST_TYPES.HALT, CATALYST_TYPES.HALT_RESUMPTION
  ]);
  score += specificTypes.has(catalyst.event_type) ? 10 : 5;

  // Price/volume confirmation (max 10)
  if (catalyst.has_price_confirmation) score += 10;

  return Math.min(100, score);
}

/**
 * Normalize a raw event into a catalyst object.
 * @param {object} raw - event fields
 * @returns {object} normalized catalyst
 */
function normalizeCatalyst(raw) {
  const catalyst = {
    symbol: raw.symbol,
    event_type: raw.event_type,
    event_time: raw.event_time ?? null,
    source: raw.source ?? null,
    source_url: raw.source_url ?? null,
    label: raw.label ?? raw.event_type,
    materiality: isNum(raw.materiality) ? raw.materiality : null,
    has_price_confirmation: Boolean(raw.has_price_confirmation),
    evidence: raw.evidence ?? null
  };
  catalyst.strength = scoreCatalystStrength(catalyst);
  catalyst.freshness = daysAgo(raw.event_time);
  return catalyst;
}

/**
 * Fetch and normalize all catalysts for a set of symbols (batched DB queries).
 *
 * @param {string[]} symbols
 * @param {object} priceContext - map of symbol -> { change_percent, rvol } for confirmation
 * @returns {Promise<object>} map of symbol -> catalyst[]
 */
async function getCatalystsForSymbols(symbols, priceContext = {}) {
  const results = {};
  if (!Array.isArray(symbols) || symbols.length === 0) return results;
  const upperSymbols = symbols.map(s => String(s).toUpperCase());
  for (const s of upperSymbols) results[s] = [];

  // 1. Halts (last 7 days)
  try {
    const haltRows = await db.query(
      `SELECT symbol, halt_type, halted_at, resume_at, is_resumption, exchange
       FROM market_halts
       WHERE symbol = ANY($1::text[]) AND halted_at >= NOW() - INTERVAL '7 days'
       ORDER BY halted_at DESC`,
      [upperSymbols]
    );
    for (const row of haltRows.rows) {
      if (!results[row.symbol]) continue;
      results[row.symbol].push(normalizeCatalyst({
        symbol: row.symbol,
        event_type: row.is_resumption ? CATALYST_TYPES.HALT_RESUMPTION : CATALYST_TYPES.HALT,
        event_time: row.halted_at,
        source: 'halt_feed',
        label: row.is_resumption ? 'Halt Resumed' : `Halt (${row.halt_type})`,
        materiality: 7,
        has_price_confirmation: hasConfirmation(priceContext[row.symbol]),
        evidence: { exchange: row.exchange, halt_type: row.halt_type }
      }));
    }
  } catch (err) {
    logger.warn('[CATALYST] halt query failed: ' + err.message);
  }

  // 2. Earnings (upcoming within 7 days or recent within 3 days)
  try {
    const today = new Date().toISOString().split('T')[0];
    const earningsRows = await db.query(
      `SELECT earnings_data FROM dashboard_earnings_cache
       WHERE date_to >= $1 ORDER BY date_from DESC LIMIT 1`,
      [today]
    );
    if (earningsRows.rows.length) {
      const all = earningsRows.rows[0].earnings_data || [];
      for (const e of all) {
        if (!e.symbol || !e.date) continue;
        const sym = String(e.symbol).toUpperCase();
        if (!results[sym]) continue;
        const d = daysAgo(e.date);
        // include if in the next 7 days or past 3 days
        if (d != null && d < -7) continue;
        if (d != null && d > 3) continue;
        results[sym].push(normalizeCatalyst({
          symbol: sym,
          event_type: CATALYST_TYPES.EARNINGS,
          event_time: e.date,
          source: 'earnings_cache',
          label: 'Earnings',
          materiality: 8,
          has_price_confirmation: hasConfirmation(priceContext[sym]),
          evidence: { hour: e.hour, quarter: e.quarter }
        }));
      }
    }
  } catch (err) {
    logger.warn('[CATALYST] earnings query failed: ' + err.message);
  }

  // 3. SEC filings (last 14 days) — split by form type into catalyst types
  try {
    const filingRows = await db.query(
      `SELECT sc.ticker, sf.form_type, sf.filing_date, sf.accepted_at, sf.filing_url
       FROM sec_filings sf
       JOIN sec_companies sc ON sc.id = sf.company_id
       WHERE UPPER(sc.ticker) = ANY($1::text[])
         AND sf.filing_date >= NOW() - INTERVAL '14 days'
       ORDER BY sf.accepted_at DESC NULLS LAST`,
      [upperSymbols]
    );
    for (const row of filingRows.rows) {
      const sym = (row.ticker || '').toUpperCase();
      if (!results[sym]) continue;
      const form = String(row.form_type || '').toUpperCase();

      if (OFFERING_FORMS.has(form)) {
        results[sym].push(normalizeCatalyst({
          symbol: sym,
          event_type: CATALYST_TYPES.OFFERING_FINANCING,
          event_time: row.accepted_at || row.filing_date,
          source: 'sec_filing',
          source_url: row.filing_url,
          label: form,
          materiality: FORM_MATERIALITY[form] ?? 6,
          has_price_confirmation: hasConfirmation(priceContext[sym]),
          evidence: { form_type: row.form_type, filing_date: row.filing_date }
        }));
      } else if (form === '4' || form === '4/A') {
        results[sym].push(normalizeCatalyst({
          symbol: sym,
          event_type: CATALYST_TYPES.INSIDER_FORM_4,
          event_time: row.accepted_at || row.filing_date,
          source: 'sec_filing',
          source_url: row.filing_url,
          label: 'Form 4',
          materiality: FORM_MATERIALITY['4'],
          has_price_confirmation: hasConfirmation(priceContext[sym]),
          evidence: { form_type: row.form_type, filing_date: row.filing_date }
        }));
      } else if (MATERIAL_FORMS.has(form)) {
        results[sym].push(normalizeCatalyst({
          symbol: sym,
          event_type: CATALYST_TYPES.SEC_MATERIAL_FILING,
          event_time: row.accepted_at || row.filing_date,
          source: 'sec_filing',
          source_url: row.filing_url,
          label: form,
          materiality: FORM_MATERIALITY[form] ?? 5,
          has_price_confirmation: hasConfirmation(priceContext[sym]),
          evidence: { form_type: row.form_type, filing_date: row.filing_date }
        }));
      }
      // Other form types are not surfaced as catalysts
    }
  } catch (err) {
    logger.warn('[CATALYST] SEC filing query failed: ' + err.message);
  }

  return results;
}

function hasConfirmation(priceCtx) {
  if (!priceCtx) return false;
  return (isNum(priceCtx.change_percent) && Math.abs(priceCtx.change_percent) >= 3)
    || (isNum(priceCtx.rvol) && priceCtx.rvol >= 2);
}

/**
 * Compute the strongest catalyst for a symbol (max strength).
 * @param {object[]} catalysts
 * @returns {object|null} strongest catalyst
 */
function getStrongestCatalyst(catalysts) {
  if (!Array.isArray(catalysts) || catalysts.length === 0) return null;
  return catalysts.reduce((best, c) => (c.strength > best.strength ? c : best));
}

module.exports = {
  CATALYST_TYPES,
  SOURCE_QUALITY,
  FORM_MATERIALITY,
  scoreCatalystStrength,
  normalizeCatalyst,
  getCatalystsForSymbols,
  getStrongestCatalyst
};
