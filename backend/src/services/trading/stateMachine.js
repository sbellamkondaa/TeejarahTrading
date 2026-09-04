/**
 * Trading State Machine
 *
 * Pure transition tables + validation for the three lifecycle state machines
 * used by the trading automation layer:
 *
 *   1. Proposal lifecycle  — trade_proposals.lifecycle_state
 *   2. Order status        — paper_orders.status
 *   3. Position status     — paper_positions.status
 *
 * This module is intentionally side-effect free. Side-effect hooks (risk-guard
 * revalidation, audit recording) remain in the owning services, where they
 * have DB access. The state machine only owns the allowed-transition rules so
 * they can be reused by paperBroker.js, proposalService.js, and a future
 * SchwabExecutionAdapter without duplication.
 *
 * No new states are introduced — these tables formalize transitions that
 * already occur in the live code. Adding a runtime guard only throws on
 * genuinely invalid (buggy) transitions; it never fires on the existing valid
 * paths, so behavior is unchanged on the happy path.
 */

// ── Proposal lifecycle ──
// Mirrors the state machine in PRODUCT_REQUIREMENTS.md. Moved verbatim from
// proposalService.js (kept there as a re-export for backward compatibility).
const PROPOSAL_TRANSITIONS = {
  DRAFT: ['READY_FOR_APPROVAL', 'REJECTED', 'EXPIRED'],
  SIGNAL_DETECTED: ['SIGNAL_VALIDATING'],
  SIGNAL_VALIDATING: ['READY_FOR_APPROVAL', 'REJECTED'],
  READY_FOR_APPROVAL: ['APPROVED', 'REJECTED', 'WATCH', 'EXPIRED'],
  APPROVED: ['ENTRY_SUBMITTED', 'REJECTED'],
  REJECTED: [],
  WATCH: ['READY_FOR_APPROVAL', 'REJECTED', 'EXPIRED'],
  EXPIRED: [],
  ENTRY_SUBMITTED: ['ENTRY_PARTIALLY_FILLED', 'ENTRY_FILLED', 'ENTRY_CANCELLED', 'ERROR'],
  ENTRY_PARTIALLY_FILLED: ['ENTRY_FILLED', 'ENTRY_CANCELLED', 'ERROR'],
  ENTRY_FILLED: ['POSITION_ACTIVE', 'ERROR'],
  ENTRY_CANCELLED: [],
  POSITION_ACTIVE: ['T1_FILLED', 'STOP_FILLED', 'ERROR', 'MANUAL_INTERVENTION_REQUIRED'],
  T1_FILLED: ['T2_FILLED', 'STOP_FILLED', 'POSITION_CLOSED'],
  T2_FILLED: ['STOP_FILLED', 'POSITION_CLOSED'],
  STOP_FILLED: ['POSITION_CLOSED'],
  POSITION_CLOSED: [],
  ERROR: ['MANUAL_INTERVENTION_REQUIRED'],
  MANUAL_INTERVENTION_REQUIRED: []
};

// ── Order status ──
// Formalizes the transitions the paper broker actually performs. The schema
// (migration 264) also defines PENDING / REJECTED / EXPIRED, but the paper
// broker never produces those states, so they are omitted to avoid speculating
// about transitions that do not occur in live code.
const ORDER_TRANSITIONS = {
  SUBMITTED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
  PARTIALLY_FILLED: ['FILLED', 'CANCELLED'],
  FILLED: [],
  CANCELLED: []
};

// Orders may be inserted directly into one of these states (creation, not a
// transition from a prior state): SUBMITTED for entry/exit orders, FILLED for
// stop_close / manual_close orders that are recorded already-filled.
const ORDER_INITIAL_STATES = ['SUBMITTED', 'FILLED'];

// ── Position status ──
const POSITION_TRANSITIONS = {
  OPEN: ['CLOSED'],
  CLOSED: []
};

const POSITION_INITIAL_STATES = ['OPEN'];

// ── Generic helpers ──

function isValidTransition(table, from, to) {
  const allowed = table[from] || [];
  return allowed.includes(to);
}

/**
 * Idempotent check: transitioning to the current state is a no-op, not an
 * error. Callers should skip the write/audit when this returns true.
 */
function isIdempotent(from, to) {
  return from === to;
}

function assertTransition(table, from, to, label) {
  if (!isValidTransition(table, from, to)) {
    throw new Error(`Invalid ${label} transition: ${from} → ${to}`);
  }
}

/**
 * Assert that every state in `fromStates` may transition to `to`. Used to
 * guard bulk UPDATE ... WHERE status IN (...) statements without per-row reads.
 */
function assertTransitionFromAny(table, fromStates, to, label) {
  for (const from of fromStates) {
    if (!isValidTransition(table, from, to)) {
      throw new Error(`Invalid ${label} transition: ${from} → ${to}`);
    }
  }
}

// ── Typed wrappers ──

const isValidProposalTransition = (from, to) => isValidTransition(PROPOSAL_TRANSITIONS, from, to);
const isValidOrderTransition = (from, to) => isValidTransition(ORDER_TRANSITIONS, from, to);
const isValidPositionTransition = (from, to) => isValidTransition(POSITION_TRANSITIONS, from, to);

const assertProposalTransition = (from, to) => assertTransition(PROPOSAL_TRANSITIONS, from, to, 'proposal');
const assertOrderTransition = (from, to) => assertTransition(ORDER_TRANSITIONS, from, to, 'order');
const assertPositionTransition = (from, to) => assertTransition(POSITION_TRANSITIONS, from, to, 'position');
const assertOrderTransitionFromAny = (fromStates, to) =>
  assertTransitionFromAny(ORDER_TRANSITIONS, fromStates, to, 'order');

module.exports = {
  PROPOSAL_TRANSITIONS,
  ORDER_TRANSITIONS,
  POSITION_TRANSITIONS,
  ORDER_INITIAL_STATES,
  POSITION_INITIAL_STATES,
  isValidTransition,
  isIdempotent,
  assertTransition,
  assertTransitionFromAny,
  isValidProposalTransition,
  isValidOrderTransition,
  isValidPositionTransition,
  assertProposalTransition,
  assertOrderTransition,
  assertPositionTransition,
  assertOrderTransitionFromAny
};
