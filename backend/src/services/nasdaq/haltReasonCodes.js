/**
 * Human-friendly descriptions for Nasdaq trading-halt reason codes.
 *
 * Source: Nasdaq Trader "Halt Routing Codes" reference and the descriptions
 * published alongside the tradehalts RSS feed. Only well-established meanings
 * are mapped here; unknown codes are surfaced as the raw code by the caller so
 * we never guess at a description.
 *
 * Codes observed in the live RSS feed (T1, T12, H11, LUDP, M) are included, as
 * are the other commonly published Nasdaq halt codes.
 */

const HALT_REASON_DESCRIPTIONS = Object.freeze({
  // News pending / news dissemination
  T1: 'News pending',
  T2: 'News pending (news has been requested)',
  T3: 'News pending (news has not been requested)',
  T12: 'Trading halted pending additional information',
  T5: 'Single security circuit breaker (5-minute halt due to 10% move)',

  // Regulatory / ETF / limit-up limit-down
  LUDP: 'Limit up / limit down pause',
  LUD: 'Limit up / limit down pause',
  M: 'Market-wide circuit breaker halt',

  // Operational halts
  O1: 'Operations halt',
  O2: 'Operations halt (regulatory)',
  O3: 'Operations halt (news dissemination)',
  O4: 'Operations halt (additional information)',

  // Securities not yet trading
  S1: 'Security not yet trading',

  // Regulatory halts by other venues
  H1: 'Regulatory halt (non-Nasdaq market)',
  H10: 'Regulatory halt (SEC)',
  H11: 'Regulatory halt (self-regulatory organization)',

  // Information / embargo
  I: 'Information requested',
  IMB: 'Imbalance',

  // Quotation / volatility
  V1: 'Volatility trading pause',
  V2: 'Volatility trading pause (extended)',

  // Orders
  P1: 'Order imbalance'
});

function describeHaltReasonCode(code) {
  if (code == null) return null;
  const key = String(code).trim().toUpperCase();
  if (!key) return null;
  return HALT_REASON_DESCRIPTIONS[key] || null;
}

module.exports = {
  HALT_REASON_DESCRIPTIONS,
  describeHaltReasonCode
};
