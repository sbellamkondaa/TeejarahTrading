// Unit tests for the trading state machine module.
// Verifies the allowed-transition tables and the assert helpers without DB.

const {
  PROPOSAL_TRANSITIONS,
  ORDER_TRANSITIONS,
  POSITION_TRANSITIONS,
  isValidTransition,
  isValidProposalTransition,
  isValidOrderTransition,
  isValidPositionTransition,
  assertProposalTransition,
  assertOrderTransition,
  assertPositionTransition,
  assertOrderTransitionFromAny
} = require('../../src/services/trading/stateMachine');

describe('stateMachine — proposal transitions', () => {
  test('SIGNAL_DETECTED → SIGNAL_VALIDATING', () => {
    expect(isValidProposalTransition('SIGNAL_DETECTED', 'SIGNAL_VALIDATING')).toBe(true);
  });
  test('READY_FOR_APPROVAL → APPROVED/REJECTED/WATCH', () => {
    for (const to of ['APPROVED', 'REJECTED', 'WATCH']) {
      expect(isValidProposalTransition('READY_FOR_APPROVAL', to)).toBe(true);
    }
  });
  test('APPROVED → ENTRY_SUBMITTED', () => {
    expect(isValidProposalTransition('APPROVED', 'ENTRY_SUBMITTED')).toBe(true);
  });
  test('APPROVED → POSITION_ACTIVE is invalid (skips ENTRY_SUBMITTED)', () => {
    expect(isValidProposalTransition('APPROVED', 'POSITION_ACTIVE')).toBe(false);
  });
  test('POSITION_CLOSED is terminal', () => {
    expect(isValidProposalTransition('POSITION_CLOSED', 'POSITION_ACTIVE')).toBe(false);
    expect(isValidProposalTransition('POSITION_CLOSED', 'STOP_FILLED')).toBe(false);
  });
  test('REJECTED is terminal', () => {
    expect(isValidProposalTransition('REJECTED', 'APPROVED')).toBe(false);
  });
  test('ENTRY_CANCELLED is terminal', () => {
    expect(isValidProposalTransition('ENTRY_CANCELLED', 'ENTRY_SUBMITTED')).toBe(false);
  });
  test('STOP_FILLED → POSITION_CLOSED only', () => {
    expect(isValidProposalTransition('STOP_FILLED', 'POSITION_CLOSED')).toBe(true);
    expect(isValidProposalTransition('STOP_FILLED', 'T1_FILLED')).toBe(false);
  });
  test('unknown from-state yields false', () => {
    expect(isValidProposalTransition('NOPE', 'APPROVED')).toBe(false);
  });
  test('DRAFT → READY_FOR_APPROVAL', () => {
    expect(isValidProposalTransition('DRAFT', 'READY_FOR_APPROVAL')).toBe(true);
  });
  test('DRAFT → EXPIRED', () => {
    expect(isValidProposalTransition('DRAFT', 'EXPIRED')).toBe(true);
  });
  test('READY_FOR_APPROVAL → EXPIRED', () => {
    expect(isValidProposalTransition('READY_FOR_APPROVAL', 'EXPIRED')).toBe(true);
  });
  test('EXPIRED is terminal', () => {
    expect(isValidProposalTransition('EXPIRED', 'READY_FOR_APPROVAL')).toBe(false);
  });
  test('isIdempotent returns true for same state', () => {
    const { isIdempotent } = require('../../src/services/trading/stateMachine');
    expect(isIdempotent('APPROVED', 'APPROVED')).toBe(true);
    expect(isIdempotent('APPROVED', 'REJECTED')).toBe(false);
  });
  test('assertProposalTransition throws on invalid', () => {
    expect(() => assertProposalTransition('APPROVED', 'POSITION_ACTIVE')).toThrow(/Invalid proposal transition/);
  });
  test('assertProposalTransition silent on valid', () => {
    expect(() => assertProposalTransition('APPROVED', 'ENTRY_SUBMITTED')).not.toThrow();
  });
});

describe('stateMachine — order transitions', () => {
  test('SUBMITTED → FILLED', () => {
    expect(isValidOrderTransition('SUBMITTED', 'FILLED')).toBe(true);
  });
  test('SUBMITTED → PARTIALLY_FILLED', () => {
    expect(isValidOrderTransition('SUBMITTED', 'PARTIALLY_FILLED')).toBe(true);
  });
  test('SUBMITTED → CANCELLED', () => {
    expect(isValidOrderTransition('SUBMITTED', 'CANCELLED')).toBe(true);
  });
  test('PARTIALLY_FILLED → FILLED', () => {
    expect(isValidOrderTransition('PARTIALLY_FILLED', 'FILLED')).toBe(true);
  });
  test('FILLED is terminal', () => {
    expect(isValidOrderTransition('FILLED', 'CANCELLED')).toBe(false);
    expect(isValidOrderTransition('FILLED', 'SUBMITTED')).toBe(false);
  });
  test('CANCELLED is terminal', () => {
    expect(isValidOrderTransition('CANCELLED', 'FILLED')).toBe(false);
  });
  test('SUBMITTED → REJECTED not in paper table (not produced by paper broker)', () => {
    expect(isValidOrderTransition('SUBMITTED', 'REJECTED')).toBe(false);
  });
  test('assertOrderTransition throws on invalid', () => {
    expect(() => assertOrderTransition('FILLED', 'CANCELLED')).toThrow(/Invalid order transition/);
  });
  test('assertOrderTransitionFromAny passes when all valid', () => {
    expect(() => assertOrderTransitionFromAny(['SUBMITTED', 'PARTIALLY_FILLED'], 'CANCELLED')).not.toThrow();
  });
  test('assertOrderTransitionFromAny throws when any invalid', () => {
    expect(() => assertOrderTransitionFromAny(['SUBMITTED', 'FILLED'], 'CANCELLED')).toThrow(/Invalid order transition/);
  });
});

describe('stateMachine — position transitions', () => {
  test('OPEN → CLOSED', () => {
    expect(isValidPositionTransition('OPEN', 'CLOSED')).toBe(true);
  });
  test('CLOSED is terminal', () => {
    expect(isValidPositionTransition('CLOSED', 'OPEN')).toBe(false);
  });
  test('assertPositionTransition throws on invalid', () => {
    expect(() => assertPositionTransition('CLOSED', 'OPEN')).toThrow(/Invalid position transition/);
  });
});

describe('stateMachine — generic isValidTransition', () => {
  test('uses supplied table', () => {
    const table = { A: ['B'] };
    expect(isValidTransition(table, 'A', 'B')).toBe(true);
    expect(isValidTransition(table, 'A', 'C')).toBe(false);
    expect(isValidTransition(table, 'Z', 'B')).toBe(false);
  });
});

describe('stateMachine — tables are non-empty and consistent', () => {
  test('PROPOSAL_TRANSITIONS has expected states', () => {
    expect(Object.keys(PROPOSAL_TRANSITIONS).sort()).toEqual([
      'APPROVED', 'DRAFT', 'ENTRY_CANCELLED', 'ENTRY_FILLED', 'ENTRY_PARTIALLY_FILLED',
      'ENTRY_SUBMITTED', 'ERROR', 'EXPIRED', 'MANUAL_INTERVENTION_REQUIRED',
      'POSITION_ACTIVE', 'POSITION_CLOSED', 'READY_FOR_APPROVAL', 'REJECTED',
      'SIGNAL_DETECTED', 'SIGNAL_VALIDATING', 'STOP_FILLED', 'T1_FILLED',
      'T2_FILLED', 'WATCH'
    ]);
  });
  test('ORDER_TRANSITIONS has expected states', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([
      'CANCELLED', 'FILLED', 'PARTIALLY_FILLED', 'SUBMITTED'
    ]);
  });
  test('POSITION_TRANSITIONS has expected states', () => {
    expect(Object.keys(POSITION_TRANSITIONS).sort()).toEqual(['CLOSED', 'OPEN']);
  });
});
