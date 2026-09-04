/**
 * Human-friendly descriptions for Nasdaq trading-halt reason codes.
 * Mirrors backend/src/services/nasdaq/haltReasonCodes.js — kept in sync by
 * convention; only codes with established meanings are mapped. Unknown codes
 * are surfaced as the raw code (see describeHaltReasonCode).
 */

export const HALT_REASON_DESCRIPTIONS = Object.freeze({
  T1: 'News pending',
  T2: 'News pending (news has been requested)',
  T3: 'News pending (news has not been requested)',
  T12: 'Trading halted pending additional information',
  T5: 'Single security circuit breaker (5-minute halt due to 10% move)',
  LUDP: 'Limit up / limit down pause',
  LUD: 'Limit up / limit down pause',
  M: 'Market-wide circuit breaker halt',
  O1: 'Operations halt',
  O2: 'Operations halt (regulatory)',
  O3: 'Operations halt (news dissemination)',
  O4: 'Operations halt (additional information)',
  S1: 'Security not yet trading',
  H1: 'Regulatory halt (non-Nasdaq market)',
  H10: 'Regulatory halt (SEC)',
  H11: 'Regulatory halt (self-regulatory organization)',
  I: 'Information requested',
  IMB: 'Imbalance',
  V1: 'Volatility trading pause',
  V2: 'Volatility trading pause (extended)',
  P1: 'Order imbalance'
})

export function describeHaltReasonCode(code) {
  if (code == null) return null
  const key = String(code).trim().toUpperCase()
  if (!key) return null
  return HALT_REASON_DESCRIPTIONS[key] || null
}
