/**
 * Dilution / Financing Risk Engine
 *
 * Detects and classifies dilution-related risk from SEC filings.
 * Sources: sec_filings table (EDGAR), Finnhub basic financials (share trend).
 *
 * Returns deterministic flags: LOW / MEDIUM / HIGH dilution risk.
 * Every flag carries evidence (filing URLs, dates, form types).
 * Never infers a financing event without source evidence.
 */

const db = require('../config/database');
const logger = require('../utils/logger');

// Form types indicating potential share issuance / dilution
const SHELF_REGISTRATION_FORMS = new Set(['S-3', 'S-3/A', 'S-1', 'S-1/A']);
const OFFERING_PROSPECTUS_FORMS = new Set(['424B5', '424B4', '424B3']);
// 8-K items that indicate offerings — detected from form type only where possible;
// item-level detection would require parsing filing documents (not done here).
const OFFERING_LOOKBACK_DAYS = 90;

/**
 * Classify dilution risk from a set of recent SEC filings.
 *
 * @param {object[]} filings - [{ form_type, filing_date, filing_url, accepted_at }]
 * @param {object} [context] - { share_trend: { trend, pct_change } | null, price }
 * @returns {{ level: 'LOW'|'MEDIUM'|'HIGH', evidence: object[], reasons: string[] }}
 */
function classifyDilutionRisk(filings, context = {}) {
  const evidence = [];
  const reasons = [];
  let level = 'LOW';

  const now = Date.now();
  const lookbackMs = OFFERING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const shelfFilings = [];
  const offeringFilings = [];
  const recentOfferingFilings = [];

  for (const f of filings || []) {
    const form = String(f.form_type || '').toUpperCase();
    const filedAt = f.accepted_at || f.filing_date ? new Date(f.accepted_at || f.filing_date).getTime() : null;
    const ageDays = filedAt ? (now - filedAt) / (24 * 60 * 60 * 1000) : null;

    if (SHELF_REGISTRATION_FORMS.has(form)) {
      shelfFilings.push(f);
      evidence.push({
        type: 'shelf_registration',
        form_type: f.form_type,
        filing_date: f.filing_date,
        url: f.filing_url,
        note: 'Shelf/registration filing'
      });
    } else if (OFFERING_PROSPECTUS_FORMS.has(form)) {
      offeringFilings.push(f);
      const isRecent = ageDays != null && ageDays <= OFFERING_LOOKBACK_DAYS;
      if (isRecent) recentOfferingFilings.push(f);
      evidence.push({
        type: 'offering_prospectus',
        form_type: f.form_type,
        filing_date: f.filing_date,
        url: f.filing_url,
        note: isRecent ? `Prospectus supplement (${Math.round(ageDays)}d ago)` : 'Prospectus supplement (older)'
      });
    }
  }

  // Share trend evidence
  if (context.share_trend && context.share_trend.trend === 'expanding') {
    evidence.push({
      type: 'share_expansion',
      pct_change: context.share_trend.pct_change,
      note: `Share count expanding ${context.share_trend.pct_change}% over period`
    });
  }

  // Classification logic (deterministic):
  // HIGH: recent offering prospectus (within 90 days) OR shelf + offering
  // MEDIUM: shelf registration (no offering yet) OR older prospectus OR strong share expansion
  // LOW: none of the above
  if (recentOfferingFilings.length > 0) {
    level = 'HIGH';
    reasons.push(`${recentOfferingFilings.length} offering prospectus filing(s) within ${OFFERING_LOOKBACK_DAYS} days`);
  } else if (offeringFilings.length > 0 && shelfFilings.length > 0) {
    level = 'HIGH';
    reasons.push('Shelf registration + prospectus on file');
  } else if (offeringFilings.length > 0) {
    level = 'MEDIUM';
    reasons.push('Offering prospectus on file (older than 90 days)');
  } else if (shelfFilings.length > 0) {
    level = 'MEDIUM';
    reasons.push(`${shelfFilings.length} shelf registration(s) — issuance capacity registered but not exercised`);
  } else if (context.share_trend && context.share_trend.pct_change > 20) {
    level = 'MEDIUM';
    reasons.push(`Share count expanded ${context.share_trend.pct_change}%`);
  }

  if (level === 'LOW') {
    reasons.push('No dilution-related filings detected');
  }

  return { level, evidence, reasons };
}

/**
 * Get recent SEC filings for symbols (batched single query).
 * @param {string[]} symbols
 * @param {number} lookbackDays
 * @returns {Promise<object>} map of symbol -> filings[]
 */
async function getFilingsForSymbols(symbols, lookbackDays = 365) {
  const results = {};
  if (!Array.isArray(symbols) || symbols.length === 0) return results;
  for (const s of symbols) results[s.toUpperCase()] = [];

  try {
    const result = await db.query(
      `SELECT sc.ticker, sf.form_type, sf.filing_date, sf.accepted_at, sf.filing_url
       FROM sec_filings sf
       JOIN sec_companies sc ON sc.id = sf.company_id
       WHERE UPPER(sc.ticker) = ANY($1::text[])
         AND sf.filing_date >= NOW() - ($2 || ' days')::interval
       ORDER BY sf.filing_date DESC`,
      [symbols.map(s => s.toUpperCase()), String(lookbackDays)]
    );
    for (const row of result.rows) {
      if (results[row.ticker]) {
        results[row.ticker].push({
          form_type: row.form_type,
          filing_date: row.filing_date,
          accepted_at: row.accepted_at,
          filing_url: row.filing_url
        });
      }
    }
  } catch (err) {
    logger.warn('[DILUTION] filings query failed: ' + err.message);
  }

  return results;
}

/**
 * Build dilution-risk assessments for multiple symbols (batched).
 * @param {string[]} symbols
 * @param {object} shareTrends - map of symbol -> { trend, pct_change } (optional)
 * @returns {Promise<object>} map of symbol -> { level, evidence, reasons }
 */
async function assessDilutionRisk(symbols, shareTrends = {}) {
  const filingsMap = await getFilingsForSymbols(symbols, 365);
  const results = {};

  for (const sym of symbols.map(s => s.toUpperCase())) {
    const context = shareTrends[sym] ? { share_trend: shareTrends[sym] } : {};
    results[sym] = classifyDilutionRisk(filingsMap[sym] || [], context);
  }

  return results;
}

module.exports = {
  SHELF_REGISTRATION_FORMS,
  OFFERING_PROSPECTUS_FORMS,
  OFFERING_LOOKBACK_DAYS,
  classifyDilutionRisk,
  getFilingsForSymbols,
  assessDilutionRisk
};
