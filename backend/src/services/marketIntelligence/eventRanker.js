/**
 * Event Ranker — computes a deterministic materiality/breaking score for
 * persisted market events and buckets them into display categories.
 *
 * Ranking inputs (all server-side, no LLM):
 *  - event_type (materiality base)
 *  - source_tier (trust)
 *  - primary_source confirmation
 *  - recency (published_at age)
 *  - symbol relevance (from market_event_symbols)
 *
 * The ranker is a pure function over an event row + optional price context.
 * No fabricated values; missing inputs reduce the score rather than invent it.
 */

const { EVENT_TYPES, SOURCE_TIERS, VERIFICATION_STATES } = require('./eventTypes');

const TIER_SCORE = {
  PRIMARY: 10,
  HIGH_QUALITY_SECONDARY: 8,
  AGGREGATOR: 6,
  SOCIAL_VERIFIED: 5,
  SOCIAL_UNVERIFIED: 2,
  OPINION: 1
};

const CATEGORY = Object.freeze({
  BREAKING: 'BREAKING',
  CATALYST: 'CATALYST',
  MARKET_MACRO: 'MARKET_MACRO',
  SCANNER_RELATED: 'SCANNER_RELATED',
  ALL_NEWS: 'ALL_NEWS',
  OPINION_LOW: 'OPINION_LOW'
});

const CATALYST_EVENT_TYPES = new Set([
  EVENT_TYPES.EARNINGS, EVENT_TYPES.GUIDANCE, EVENT_TYPES.FDA, EVENT_TYPES.CLINICAL_TRIAL,
  EVENT_TYPES.OFFERING, EVENT_TYPES.ATM, EVENT_TYPES.S3, EVENT_TYPES.F424B5,
  EVENT_TYPES.DILUTION, EVENT_TYPES.MERGER_ACQUISITION, EVENT_TYPES.CONTRACT,
  EVENT_TYPES.PARTNERSHIP, EVENT_TYPES.ANALYST_UPGRADE, EVENT_TYPES.ANALYST_DOWNGRADE,
  EVENT_TYPES.PRICE_TARGET, EVENT_TYPES.INSIDER, EVENT_TYPES.HALT, EVENT_TYPES.RESUMPTION
]);

const MACRO_EVENT_TYPES = new Set([
  EVENT_TYPES.MACRO_FED, EVENT_TYPES.MACRO_INFLATION, EVENT_TYPES.MACRO_JOBS, EVENT_TYPES.SECTOR
]);

function isNum(v) { return v != null && Number.isFinite(Number(v)); }

function daysAgo(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

function hoursAgo(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3600000;
}

/**
 * Score a persisted event row.
 * @param {object} event - row from market_events (with materiality, source_tier, ...)
 * @param {object} [priceContext] - optional { change_percent, rvol, gap_pct } for symbol relevance
 * @returns {number} 0-100
 */
function scoreEvent(event, priceContext = {}) {
  let score = 0;

  // Materiality base (0-10) -> 0-40
  const mat = isNum(event.materiality) ? Math.min(10, Math.max(0, event.materiality)) : 5;
  score += Math.round((mat / 10) * 40);

  // Source tier (0-10) -> 0-25
  const tier = TIER_SCORE[event.source_tier] ?? 4;
  score += Math.round((tier / 10) * 25);

  // Primary-source confirmation -> +10
  if (event.primary_source) score += 10;

  // Verification state
  if (event.verification_state === VERIFICATION_STATES.VERIFIED) score += 5;
  else if (event.verification_state === VERIFICATION_STATES.CORROBORATED) score += 3;
  else if (event.verification_state === VERIFICATION_STATES.UNVERIFIED) score -= 5;

  // Recency (0-15): <= 1h = 15, <= 4h = 12, <= 24h = 8, <= 7d = 4, else 1
  const h = hoursAgo(event.published_at);
  if (h == null) score += 1;
  else if (h <= 1) score += 15;
  else if (h <= 4) score += 12;
  else if (h <= 24) score += 8;
  else if (h <= 24 * 7) score += 4;
  else score += 1;

  // Price/volume confirmation (optional) -> +5
  if (priceContext && isNum(priceContext.change_percent) && Math.abs(priceContext.change_percent) >= 3) {
    score += 5;
  } else if (priceContext && isNum(priceContext.rvol) && priceContext.rvol >= 2) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Categorize an event into a display bucket.
 * @param {object} event
 * @param {object} [opts] - { scannerSymbols?: Set, catalystOnly?: boolean }
 */
function categorize(event, opts = {}) {
  const type = event.event_type;
  const h = hoursAgo(event.published_at);
  const recent = h != null && h <= 4;

  if (type === EVENT_TYPES.OPINION) return CATEGORY.OPINION_LOW;

  if (MACRO_EVENT_TYPES.has(type)) return CATEGORY.MARKET_MACRO;

  if (CATALYST_EVENT_TYPES.has(type) && recent) return CATEGORY.BREAKING;

  if (opts.scannerSymbols && event.symbols && event.symbols.some((s) => opts.scannerSymbols.has(s))) {
    return CATEGORY.SCANNER_RELATED;
  }

  if (CATALYST_EVENT_TYPES.has(type)) return CATEGORY.CATALYST;

  return CATEGORY.ALL_NEWS;
}

module.exports = { scoreEvent, categorize, CATEGORY, CATALYST_EVENT_TYPES, MACRO_EVENT_TYPES, TIER_SCORE };
