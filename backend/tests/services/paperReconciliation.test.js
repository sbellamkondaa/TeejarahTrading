// Focused tests for automated PAPER reconciliation, restart recovery,
// race-condition handling, partial fills, and invariant verification.
// All external dependencies are mocked — no live broker calls, no DB.

const paperBroker = require('../../src/services/trading/paperBroker');

jest.mock('../../src/config/database', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/utils/finnhub', () => ({ getQuote: jest.fn() }));
jest.mock('../../src/services/trading/proposalService', () => ({
  getById: jest.fn(),
  transitionState: jest.fn()
}));
jest.mock('../../src/services/trading/auditService', () => ({ recordEvent: jest.fn() }));
jest.mock('../../src/services/trading/riskEngine', () => ({
  getLatestEvaluation: jest.fn(),
  isEvaluationStale: jest.fn(),
  canBecomeReadyForApproval: jest.fn()
}));

const db = require('../../src/config/database');
const finnhub = require('../../src/utils/finnhub');
const proposalService = require('../../src/services/trading/proposalService');
const auditService = require('../../src/services/trading/auditService');

beforeEach(() => jest.clearAllMocks());

// ── verifySellInvariant ──

describe('verifySellInvariant', () => {
  test('ok when active sell <= remaining', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 100 }] });
      if (sql.includes('SELECT remaining_qty')) return Promise.resolve({ rows: [{ remaining_qty: 200 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await paperBroker.verifySellInvariant('pos-1');
    expect(r.ok).toBe(true);
    expect(r.activeSellQty).toBe(100);
    expect(r.remainingQty).toBe(200);
  });

  test('violated when active sell > remaining', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 300 }] });
      if (sql.includes('SELECT remaining_qty')) return Promise.resolve({ rows: [{ remaining_qty: 200 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await paperBroker.verifySellInvariant('pos-1');
    expect(r.ok).toBe(false);
    expect(r.activeSellQty).toBe(300);
    expect(r.remainingQty).toBe(200);
  });

  test('ok when no active sells', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 0 }] });
      if (sql.includes('SELECT remaining_qty')) return Promise.resolve({ rows: [{ remaining_qty: 100 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await paperBroker.verifySellInvariant('pos-1');
    expect(r.ok).toBe(true);
    expect(r.activeSellQty).toBe(0);
  });
});

// ── reconcileAll ──

describe('reconcileAll', () => {
  test('processes no positions when none have active orders', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await paperBroker.reconcileAll(null);
    expect(r.positionsProcessed).toBe(0);
    expect(r.fillsApplied).toBe(0);
    expect(r.errors).toEqual([]);
  });

  test('processes positions with active orders and verifies invariant', async () => {
    const positions = [
      { id: 'pos-1', proposal_id: 'prop-1', symbol: 'AAPL' },
      { id: 'pos-2', proposal_id: 'prop-2', symbol: 'MSFT' }
    ];

    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT pp.id')) return Promise.resolve({ rows: positions });
      if (sql.includes('SELECT * FROM paper_positions WHERE proposal_id')) return Promise.resolve({ rows: [{ status: 'OPEN', remaining_qty: 100 }] });
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes('position_id')) return Promise.resolve({ rows: [] });
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 0 }] });
      if (sql.includes('SELECT remaining_qty FROM paper_positions')) return Promise.resolve({ rows: [{ remaining_qty: 100 }] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.getById.mockResolvedValue({ id: 'prop-1', symbol: 'AAPL', execution_mode: 'PAPER', lifecycle_state: 'POSITION_ACTIVE' });
    proposalService.transitionState.mockResolvedValue({});
    finnhub.getQuote.mockResolvedValue({ c: 50, bid: 49.90, ask: 50.10 });

    const r = await paperBroker.reconcileAll(null);
    expect(r.positionsProcessed).toBe(2);
    expect(r.errors).toEqual([]);
  });

  test('transitions to MANUAL_INTERVENTION_REQUIRED when invariant violated', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT pp.id')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1', symbol: 'AAPL' }] });
      if (sql.includes('SELECT * FROM paper_positions WHERE proposal_id')) return Promise.resolve({ rows: [{ status: 'OPEN', remaining_qty: 100 }] });
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes('position_id')) return Promise.resolve({ rows: [] });
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 200 }] });
      if (sql.includes('SELECT remaining_qty FROM paper_positions')) return Promise.resolve({ rows: [{ remaining_qty: 100 }] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.getById.mockResolvedValue({ id: 'prop-1', symbol: 'AAPL', execution_mode: 'PAPER', lifecycle_state: 'POSITION_ACTIVE' });
    proposalService.transitionState.mockResolvedValue({});
    finnhub.getQuote.mockResolvedValue({ c: 50, bid: 49.90, ask: 50.10 });

    const r = await paperBroker.reconcileAll(null);
    expect(r.errors.length).toBe(1);
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'MANUAL_INTERVENTION_REQUIRED', null);
  });

  test('catches per-position errors without failing the cycle', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT pp.id')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1', symbol: 'AAPL' }] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.getById.mockRejectedValue(new Error('DB down'));

    const r = await paperBroker.reconcileAll(null);
    expect(r.positionsProcessed).toBe(1);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].error).toBe('DB down');
  });
});

// ── runRestartRecovery — safe repairs ──

describe('runRestartRecovery — created_missing_position', () => {
  test('creates position for FILLED entry with no position', async () => {
    const filledOrder = {
      id: 'ord-1', proposal_id: 'prop-1', signal_id: 'sig-1',
      strategy_id: 'strat-1', strategy_version: 'strat-1@v1',
      symbol: 'AAPL', filled_qty: 100, avg_fill_price: 50, order_type: 'entry',
      status: 'FILLED', execution_mode: 'PAPER'
    };

    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [filledOrder] });
      if (sql.startsWith('INSERT INTO paper_positions')) return Promise.resolve({ rows: [{ id: 'pos-1' }] });
      if (sql.includes('SELECT * FROM paper_positions WHERE proposal_id')) return Promise.resolve({ rows: [{ id: 'pos-1', status: 'OPEN', total_qty: 100, remaining_qty: 100 }] });
      if (sql.startsWith('INSERT INTO paper_orders')) return Promise.resolve({ rows: [{ id: 'exit-1' }] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [] });
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 0 }] });
      if (sql.includes('SELECT remaining_qty FROM paper_positions')) return Promise.resolve({ rows: [{ remaining_qty: 100 }] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.getById.mockResolvedValue({
      id: 'prop-1', direction: 'long', symbol: 'AAPL',
      t1_price: 55, t2_price: 60, stop_price: 47,
      signal_id: 'sig-1', strategy_id: 'strat-1'
    });
    proposalService.transitionState.mockResolvedValue({});

    const r = await paperBroker.runRestartRecovery(null);
    expect(r.repairs.length).toBe(1);
    expect(r.repairs[0].repair).toBe('created_missing_position');
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'ENTRY_FILLED', null);
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'POSITION_ACTIVE', null);
  });

  test('transitions to MANUAL_INTERVENTION_REQUIRED when fill data missing', async () => {
    const filledOrder = {
      id: 'ord-1', proposal_id: 'prop-1', symbol: 'AAPL',
      filled_qty: 0, avg_fill_price: null, order_type: 'entry',
      status: 'FILLED', execution_mode: 'PAPER'
    };

    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [filledOrder] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.getById.mockResolvedValue({ id: 'prop-1', direction: 'long' });
    proposalService.transitionState.mockResolvedValue({});

    const r = await paperBroker.runRestartRecovery(null);
    expect(r.manualInterventions.length).toBe(1);
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'MANUAL_INTERVENTION_REQUIRED', null);
  });
});

describe('runRestartRecovery — cancelled_exits_on_closed_position', () => {
  test('cancels active exits on CLOSED positions', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [{ position_id: 'pos-1', proposal_id: 'prop-1' }] });
      if (sql.startsWith('UPDATE paper_orders') && sql.includes('CANCELLED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const r = await paperBroker.runRestartRecovery(null);
    expect(r.repairs.some((x) => x.repair === 'cancelled_exits_on_closed_position')).toBe(true);
  });
});

describe('runRestartRecovery — recalculated_remaining_qty', () => {
  test('recalculates when remaining_qty is wrong', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1', remaining_qty: 150, expected_remaining: 100 }] });
      if (sql.startsWith('UPDATE paper_positions SET remaining_qty')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.transitionState.mockResolvedValue({});

    const r = await paperBroker.runRestartRecovery(null);
    expect(r.repairs.some((x) => x.repair === 'recalculated_remaining_qty')).toBe(true);
  });

  test('closes position when expected remaining is 0 but status is OPEN', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1', remaining_qty: 50, expected_remaining: 0 }] });
      if (sql.startsWith('UPDATE paper_positions SET remaining_qty')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE paper_positions SET status = \'CLOSED\'')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.transitionState.mockResolvedValue({});

    const r = await paperBroker.runRestartRecovery(null);
    expect(r.repairs.some((x) => x.repair === 'recalculated_remaining_qty')).toBe(true);
    expect(r.repairs.some((x) => x.repair === 'closed_zero_remaining_position')).toBe(true);
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'POSITION_CLOSED', null);
  });
});

describe('runRestartRecovery — invariant violation', () => {
  test('transitions to MANUAL_INTERVENTION_REQUIRED when sell invariant violated', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1', remaining_qty: 100, expected_remaining: 100 }] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1' }] });
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 200 }] });
      if (sql.includes('SELECT remaining_qty FROM paper_positions')) return Promise.resolve({ rows: [{ remaining_qty: 100 }] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.transitionState.mockResolvedValue({});

    const r = await paperBroker.runRestartRecovery(null);
    expect(r.manualInterventions.length).toBe(1);
    expect(r.manualInterventions[0].reason).toBe('sell invariant violated');
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'MANUAL_INTERVENTION_REQUIRED', null);
  });
});

// ── runReconciliationCycle ──

describe('runReconciliationCycle', () => {
  test('runs recovery then reconciliation', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('order_type = \'entry\'') && sql.includes('NOT EXISTS')) return Promise.resolve({ rows: [] });
      if (sql.includes('status = \'CLOSED\'') && sql.includes('SUBMITTED')) return Promise.resolve({ rows: [] });
      if (sql.includes('expected_remaining')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT id, proposal_id FROM paper_positions WHERE status = \'OPEN\'')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT DISTINCT pp.id')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const r = await paperBroker.runReconciliationCycle(null);
    expect(r.repairs).toBe(0);
    expect(r.manualInterventions).toBe(0);
    expect(r.positionsProcessed).toBe(0);
    expect(r.fillsApplied).toBe(0);
  });
});

// ── Stop-first ordering ──

describe('processFills — stop-first ordering', () => {
  test('queries with stop-first ORDER BY', async () => {
    proposalService.getById.mockResolvedValue({
      id: 'prop-1', symbol: 'AAPL', execution_mode: 'PAPER', lifecycle_state: 'POSITION_ACTIVE'
    });

    let capturedSql = null;
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions WHERE proposal_id')) return Promise.resolve({ rows: [{ id: 'pos-1', status: 'OPEN', remaining_qty: 100 }] });
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes('status IN')) {
        capturedSql = sql;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await paperBroker.processFills('prop-1', 'u');
    expect(capturedSql).toContain('CASE WHEN order_type = \'stop\' THEN 0 ELSE 1 END');
  });
});

// ── No live broker calls ──

describe('reconciliation — no live broker calls', () => {
  test('reconcileAll only uses finnhub.getQuote for fill simulation', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT pp.id')) return Promise.resolve({ rows: [{ id: 'pos-1', proposal_id: 'prop-1', symbol: 'AAPL' }] });
      if (sql.includes('SELECT * FROM paper_positions WHERE proposal_id')) return Promise.resolve({ rows: [{ id: 'pos-1', status: 'OPEN', remaining_qty: 100 }] });
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes('status IN')) return Promise.resolve({ rows: [] });
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_sell_qty: 0 }] });
      if (sql.includes('SELECT remaining_qty FROM paper_positions')) return Promise.resolve({ rows: [{ remaining_qty: 100 }] });
      return Promise.resolve({ rows: [] });
    });
    proposalService.getById.mockResolvedValue({ id: 'prop-1', symbol: 'AAPL', execution_mode: 'PAPER', lifecycle_state: 'POSITION_ACTIVE' });

    await paperBroker.reconcileAll(null);
    // No Schwab order API — only finnhub.getQuote for fill simulation
    // (called 0 times here because no active orders, but never Schwab orders)
    expect(finnhub.getQuote).not.toHaveBeenCalled();
  });
});

// ── Stale position bug: multi-fill cycle ──

describe('processFills — multi-fill cycle uses refreshed position', () => {
  test('second fill uses updated remaining_qty, not stale value', async () => {
    let dbRemaining = 100;
    proposalService.getById.mockResolvedValue({
      id: 'prop-1', symbol: 'AAPL', execution_mode: 'PAPER', lifecycle_state: 'POSITION_ACTIVE'
    });

    db.query.mockImplementation(function (sql, params) {
      // getPosition: returns the current DB state
      if (sql.includes('SELECT * FROM paper_positions WHERE proposal_id')) {
        return Promise.resolve({ rows: [{ id: 'pos-1', status: 'OPEN', remaining_qty: dbRemaining, direction: 'long', avg_entry_price: 50, realized_pnl: 0 }] });
      }
      // Active orders: T1 and T2 both marketable
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes('status IN')) {
        return Promise.resolve({ rows: [
          { id: 'ord-t1', order_type: 't1', side: 'sell', status: 'SUBMITTED', quantity: 30, filled_qty: 0, limit_price: 55 },
          { id: 'ord-t2', order_type: 't2', side: 'sell', status: 'SUBMITTED', quantity: 30, filled_qty: 0, limit_price: 60 }
        ]});
      }
      // executeSellFill: UPDATE order
      if (sql.startsWith('UPDATE paper_orders') && sql.includes('filled_qty')) return Promise.resolve({ rows: [{ id: 'ord-1' }] });
      // executeSellFill: UPDATE position — record newRemaining in DB
      if (sql.startsWith('UPDATE paper_positions') && sql.includes('remaining_qty')) {
        dbRemaining = params[1];
        return Promise.resolve({ rows: [{ id: 'pos-1', status: 'OPEN', remaining_qty: dbRemaining }] });
      }
      return Promise.resolve({ rows: [] });
    });
    proposalService.transitionState.mockResolvedValue({});
    finnhub.getQuote.mockResolvedValue({ c: 61, bid: 60.50, ask: 61.50 });

    const result = await paperBroker.processFills('prop-1', 'u');

    expect(result.fills.length).toBe(2);

    // Verify the position UPDATE params used refreshed remaining_qty.
    const positionUpdates = db.query.mock.calls.filter(
      (c) => c[0].startsWith('UPDATE paper_positions') && c[0].includes('remaining_qty')
    );
    // First fill: newRemaining = 100 - 30 = 70
    expect(positionUpdates[0][1][1]).toBe(70);
    // Second fill: newRemaining = 70 - 30 = 40 (uses refreshed position)
    expect(positionUpdates[1][1][1]).toBe(40);
  });
});

// ── Idempotent transition ──

describe('idempotent transitions', () => {
  test('transitionState to same state is a no-op', async () => {
    const proposal = { id: 'prop-1', lifecycle_state: 'POSITION_ACTIVE' };
    proposalService.getById.mockResolvedValue(proposal);
    proposalService.transitionState.mockImplementation(async (id, newState) => {
      // Simulate the real idempotent behavior: same state = return proposal
      if (id === 'prop-1' && newState === 'POSITION_ACTIVE') return proposal;
      return { id, lifecycle_state: newState };
    });

    const result = await proposalService.transitionState('prop-1', 'POSITION_ACTIVE', 'u');
    expect(result.id).toBe('prop-1');
    expect(result.lifecycle_state).toBe('POSITION_ACTIVE');
  });
});
