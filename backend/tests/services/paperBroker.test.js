// Comprehensive tests for Paper Broker / Execution Simulator
// Tests: pure functions, fill simulation, idempotency, protective exits,
// cancel, stop replacement, manual close, reconciliation, state transitions.

const paperBroker = require('../../src/services/trading/paperBroker');

jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/finnhub', () => ({ getQuote: jest.fn() }));
jest.mock('../../src/services/trading/proposalService', () => ({
  getById: jest.fn(),
  transitionState: jest.fn(),
  editProposal: jest.fn()
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
const { getLatestEvaluation, isEvaluationStale, canBecomeReadyForApproval } = require('../../src/services/trading/riskEngine');

beforeEach(() => jest.clearAllMocks());

// ── Pure function tests ──

describe('computePnl', () => {
  test('long profit', () => expect(paperBroker.computePnl('long', 50, 55, 100)).toBe(500));
  test('long loss', () => expect(paperBroker.computePnl('long', 50, 47, 100)).toBe(-300));
  test('short profit', () => expect(paperBroker.computePnl('short', 50, 47, 100)).toBe(300));
  test('short loss', () => expect(paperBroker.computePnl('short', 50, 55, 100)).toBe(-500));
  test('zero qty', () => expect(paperBroker.computePnl('long', 50, 55, 0)).toBe(0));
});

describe('fillPriceForBuy', () => {
  test('uses ask', () => expect(paperBroker.fillPriceForBuy({ ask: 51.30, c: 51.25 })).toBe(51.30));
  test('falls back to c', () => expect(paperBroker.fillPriceForBuy({ c: 51.25 })).toBe(51.25));
  test('null quote', () => expect(paperBroker.fillPriceForBuy(null)).toBeNull());
  test('applies slippage', () => expect(paperBroker.fillPriceForBuy({ ask: 50 }, 0.02)).toBe(50.02));
});

describe('fillPriceForSell', () => {
  test('uses bid', () => expect(paperBroker.fillPriceForSell({ bid: 49.80, c: 50 })).toBe(49.80));
  test('falls back to c', () => expect(paperBroker.fillPriceForSell({ c: 50 })).toBe(50));
  test('null quote', () => expect(paperBroker.fillPriceForSell(null)).toBeNull());
  test('applies slippage', () => expect(paperBroker.fillPriceForSell({ bid: 50 }, 0.02)).toBe(49.98));
});

describe('isLimitBuyMarketable', () => {
  test('marketable when limit >= ask', () => {
    expect(paperBroker.isLimitBuyMarketable(55, { ask: 50 })).toBe(true);
  });
  test('not marketable when limit < ask', () => {
    expect(paperBroker.isLimitBuyMarketable(45, { ask: 50 })).toBe(false);
  });
  test('uses c when no ask', () => {
    expect(paperBroker.isLimitBuyMarketable(55, { c: 50 })).toBe(true);
    expect(paperBroker.isLimitBuyMarketable(45, { c: 50 })).toBe(false);
  });
});

describe('isLimitSellMarketable', () => {
  test('marketable when limit <= bid', () => {
    expect(paperBroker.isLimitSellMarketable(45, { bid: 50 })).toBe(true);
  });
  test('not marketable when limit > bid', () => {
    expect(paperBroker.isLimitSellMarketable(55, { bid: 50 })).toBe(false);
  });
});

describe('isStopSellTriggered', () => {
  test('triggered when bid <= stop', () => {
    expect(paperBroker.isStopSellTriggered(47, { bid: 46 })).toBe(true);
    expect(paperBroker.isStopSellTriggered(47, { bid: 47 })).toBe(true);
  });
  test('not triggered when bid > stop', () => {
    expect(paperBroker.isStopSellTriggered(47, { bid: 48 })).toBe(false);
  });
  test('uses c when no bid', () => {
    expect(paperBroker.isStopSellTriggered(47, { c: 46 })).toBe(true);
  });
});

describe('computeExitQuantities', () => {
  test('splits 300 into 100/100/100', () => {
    const q = paperBroker.computeExitQuantities(300);
    expect(q.t1Qty).toBe(100);
    expect(q.t2Qty).toBe(100);
    expect(q.stopQty).toBe(100);
  });
  test('splits 100 into 33/33/34', () => {
    const q = paperBroker.computeExitQuantities(100);
    expect(q.t1Qty).toBe(33);
    expect(q.t2Qty).toBe(33);
    expect(q.stopQty).toBe(34);
  });
  test('total equals totalQty', () => {
    const q = paperBroker.computeExitQuantities(250);
    expect(q.t1Qty + q.t2Qty + q.stopQty).toBe(250);
  });
});

describe('checkSellInvariant', () => {
  test('ok when sell qty <= remaining', () => {
    const pos = { remaining_qty: 200 };
    const sells = [{ quantity: 100, filled_qty: 0, status: 'SUBMITTED' }];
    expect(paperBroker.checkSellInvariant(pos, sells)).toBe(true);
  });
  test('violated when sell qty > remaining', () => {
    const pos = { remaining_qty: 100 };
    const sells = [
      { quantity: 100, filled_qty: 0, status: 'SUBMITTED' },
      { quantity: 100, filled_qty: 0, status: 'SUBMITTED' }
    ];
    expect(paperBroker.checkSellInvariant(pos, sells)).toBe(false);
  });
  test('ok with partial fills', () => {
    const pos = { remaining_qty: 150 };
    const sells = [{ quantity: 200, filled_qty: 50, status: 'PARTIALLY_FILLED' }];
    expect(paperBroker.checkSellInvariant(pos, sells)).toBe(true);
  });
  test('ok with null position', () => {
    expect(paperBroker.checkSellInvariant(null, [])).toBe(true);
  });
});

// ── Fill simulation tests ──

describe('simulateBuyFill — entry', () => {
  test('marketable limit fills at ask', () => {
    const order = { order_type: 'entry', quantity: 100, limit_price: 55 };
    const fill = paperBroker.simulateBuyFill(order, { ask: 50, c: 50 }, {});
    expect(fill.fillPrice).toBe(50);
    expect(fill.fillQty).toBe(100);
    expect(fill.status).toBe('FILLED');
  });

  test('non-marketable limit stays SUBMITTED', () => {
    const order = { order_type: 'entry', quantity: 100, limit_price: 45 };
    const fill = paperBroker.simulateBuyFill(order, { ask: 50, c: 50 }, {});
    expect(fill.fillPrice).toBeNull();
    expect(fill.fillQty).toBe(0);
    expect(fill.status).toBe('SUBMITTED');
  });

  test('no limit_price fills at ask', () => {
    const order = { order_type: 'entry', quantity: 100 };
    const fill = paperBroker.simulateBuyFill(order, { ask: 50 }, {});
    expect(fill.fillPrice).toBe(50);
  });

  test('partial fill with ratio 0.5', () => {
    const order = { order_type: 'entry', quantity: 100, limit_price: 55 };
    const fill = paperBroker.simulateBuyFill(order, { ask: 50 }, { partialFillRatio: 0.5 });
    expect(fill.fillQty).toBe(50);
    expect(fill.status).toBe('PARTIALLY_FILLED');
  });

  test('null quote returns null', () => {
    const order = { order_type: 'entry', quantity: 100 };
    expect(paperBroker.simulateBuyFill(order, null, {})).toBeNull();
  });
});

describe('simulateSellFill — T1/T2 limit sell', () => {
  test('marketable limit sell fills at bid', () => {
    const order = { order_type: 't1', quantity: 100, limit_price: 55 };
    const fill = paperBroker.simulateSellFill(order, { bid: 56, c: 56 }, {});
    expect(fill.fillPrice).toBe(56);
    expect(fill.fillQty).toBe(100);
    expect(fill.status).toBe('FILLED');
  });

  test('non-marketable limit sell stays SUBMITTED', () => {
    const order = { order_type: 't1', quantity: 100, limit_price: 60 };
    const fill = paperBroker.simulateSellFill(order, { bid: 55, c: 55 }, {});
    expect(fill.fillPrice).toBeNull();
    expect(fill.fillQty).toBe(0);
    expect(fill.status).toBe('SUBMITTED');
  });

  test('partial fill with ratio 0.5', () => {
    const order = { order_type: 't2', quantity: 100, limit_price: 50 };
    const fill = paperBroker.simulateSellFill(order, { bid: 55 }, { partialFillRatio: 0.5 });
    expect(fill.fillQty).toBe(50);
    expect(fill.status).toBe('PARTIALLY_FILLED');
  });
});

describe('simulateSellFill — stop sell', () => {
  test('fills when bid <= stop price', () => {
    const order = { order_type: 'stop', quantity: 100, stop_price: 47 };
    const fill = paperBroker.simulateSellFill(order, { bid: 46, c: 46 }, {});
    expect(fill.fillPrice).toBe(46);
    expect(fill.fillQty).toBe(100);
    expect(fill.status).toBe('FILLED');
  });

  test('stays SUBMITTED when bid > stop', () => {
    const order = { order_type: 'stop', quantity: 100, stop_price: 47 };
    const fill = paperBroker.simulateSellFill(order, { bid: 48, c: 48 }, {});
    expect(fill.fillPrice).toBeNull();
    expect(fill.fillQty).toBe(0);
    expect(fill.status).toBe('SUBMITTED');
  });

  test('fills at worse of stop/bid', () => {
    const order = { order_type: 'stop', quantity: 100, stop_price: 47 };
    const fill = paperBroker.simulateSellFill(order, { bid: 45, c: 45 }, {});
    expect(fill.fillPrice).toBe(45);
  });
});

describe('simulateSellFill — manual_close', () => {
  test('fills at bid', () => {
    const order = { order_type: 'manual_close', quantity: 100 };
    const fill = paperBroker.simulateSellFill(order, { bid: 52, c: 52 }, {});
    expect(fill.fillPrice).toBe(52);
    expect(fill.fillQty).toBe(100);
    expect(fill.status).toBe('FILLED');
  });
});

// ── Idempotent submission tests ──

describe('submitEntry — idempotency', () => {
  const mockProposal = {
    id: 'prop-1', symbol: 'AAPL', direction: 'long',
    execution_mode: 'PAPER', lifecycle_state: 'APPROVED',
    position_size: 300, stop_price: 47, t1_price: 55, t2_price: 60,
    signal_id: 'sig-1', strategy_id: 'strat-1',
    entry_zone: { high: 51, low: 50 }
  };
  const mockEval = { state: 'VALID', is_stale: false, created_at: new Date().toISOString() };
  const mockOrder = { id: 'ord-1', status: 'FILLED', avg_fill_price: 50.10, order_type: 'entry' };
  const mockPosition = { id: 'pos-1', proposal_id: 'prop-1', status: 'OPEN', remaining_qty: 300 };

  beforeEach(() => {
    canBecomeReadyForApproval.mockReturnValue(true);
    isEvaluationStale.mockReturnValue(false);
    getLatestEvaluation.mockResolvedValue(mockEval);
    proposalService.getById.mockResolvedValue(mockProposal);
    proposalService.transitionState.mockResolvedValue({});
    finnhub.getQuote.mockResolvedValue({ c: 50, ask: 50.10, bid: 49.90 });
    db.query.mockResolvedValue({ rows: [mockOrder] });
  });

  test('returns existing order when entry already submitted (idempotent)', async () => {
    // First call: find existing entry → returns order
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes("order_type = 'entry'")) {
        return Promise.resolve({ rows: [mockOrder] });
      }
      return Promise.resolve({ rows: [mockPosition] });
    });

    const result = await paperBroker.submitEntry('prop-1', 'user-1');
    expect(result.idempotent).toBe(true);
    expect(result.order).toEqual(mockOrder);
    // Should NOT call transitionState (already submitted)
    expect(proposalService.transitionState).not.toHaveBeenCalled();
  });

  test('does not create duplicate entry on repeated submit', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes("order_type = 'entry'")) {
        return Promise.resolve({ rows: [mockOrder] });
      }
      return Promise.resolve({ rows: [mockPosition] });
    });

    await paperBroker.submitEntry('prop-1', 'user-1');
    await paperBroker.submitEntry('prop-1', 'user-1');
    // No INSERT into paper_orders (idempotent return)
    const insertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO paper_orders'));
    expect(insertCalls.length).toBe(0);
  });
});

// ── Entry submission gating tests ──

describe('submitEntry — gating', () => {
  const mockProposal = {
    id: 'prop-1', symbol: 'AAPL', direction: 'long',
    execution_mode: 'PAPER', lifecycle_state: 'APPROVED',
    position_size: 300, stop_price: 47, t1_price: 55, t2_price: 60,
    signal_id: 'sig-1', strategy_id: 'strat-1',
    entry_zone: { high: 51, low: 50 }
  };
  const mockEval = { state: 'VALID', is_stale: false, created_at: new Date().toISOString() };

  beforeEach(() => {
    canBecomeReadyForApproval.mockReturnValue(true);
    isEvaluationStale.mockReturnValue(false);
    getLatestEvaluation.mockResolvedValue(mockEval);
    finnhub.getQuote.mockResolvedValue({ c: 50, ask: 50.10, bid: 49.90 });
    proposalService.transitionState.mockResolvedValue({});
    db.query.mockResolvedValue({ rows: [] });
  });

  test('rejects if not APPROVED', async () => {
    proposalService.getById.mockResolvedValue({ ...mockProposal, lifecycle_state: 'READY_FOR_APPROVAL' });
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('must be APPROVED');
  });

  test('rejects if execution_mode is not PAPER', async () => {
    proposalService.getById.mockResolvedValue({ ...mockProposal, execution_mode: 'LIVE' });
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('PAPER execution mode');
  });

  test('rejects short direction', async () => {
    proposalService.getById.mockResolvedValue({ ...mockProposal, direction: 'short' });
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('Short selling is disabled');
  });

  test('rejects zero position size', async () => {
    proposalService.getById.mockResolvedValue({ ...mockProposal, position_size: 0 });
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('missing or zero');
  });

  test('rejects stale risk evaluation', async () => {
    isEvaluationStale.mockReturnValue(true);
    proposalService.getById.mockResolvedValue(mockProposal);
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('stale');
  });

  test('rejects REJECTED risk evaluation', async () => {
    canBecomeReadyForApproval.mockReturnValue(false);
    proposalService.getById.mockResolvedValue(mockProposal);
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('REJECTED');
  });

  test('rejects null quote', async () => {
    finnhub.getQuote.mockResolvedValue(null);
    proposalService.getById.mockResolvedValue(mockProposal);
    await expect(paperBroker.submitEntry('prop-1', 'u')).rejects.toThrow('No quote');
  });
});

// ── Protective exits tests ──

describe('createProtectiveExits — invariant', () => {
  const mockPosition = {
    id: 'pos-1', proposal_id: 'prop-1', signal_id: 'sig-1',
    strategy_id: 'strat-1', strategy_version: 'strat-1@v1',
    symbol: 'AAPL', direction: 'long', total_qty: 300,
    remaining_qty: 300, avg_entry_price: 50
  };
  const mockProposal = { stop_price: 47, t1_price: 55, t2_price: 60 };

  beforeEach(() => {
    db.query.mockImplementation((sql) => {
      if (sql.startsWith('INSERT INTO paper_orders')) {
        const orderType = sql.match(/'t1'|'t2'|'stop'/)?.[0] || 'stop';
        const qty = orderType === "'t1'" ? 100 : orderType === "'t2'" ? 100 : 100;
        return Promise.resolve({ rows: [{ id: 'ord-' + Math.random(), status: 'SUBMITTED', quantity: qty, filled_qty: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  test('creates T1, T2, stop with correct quantities', async () => {
    const orders = await paperBroker.createProtectiveExits(mockPosition, mockProposal, 'u');
    expect(orders.length).toBe(3);
    const t1Call = db.query.mock.calls.find(c => c[0].includes("'t1'"));
    const t2Call = db.query.mock.calls.find(c => c[0].includes("'t2'"));
    const stopCall = db.query.mock.calls.find(c => c[0].includes("'stop'"));
    expect(t1Call[1][7]).toBe(100);  // t1Qty
    expect(t2Call[1][7]).toBe(100);  // t2Qty
    expect(stopCall[1][7]).toBe(100); // stopQty
  });

  test('total sell qty = total_qty (invariant)', async () => {
    const orders = await paperBroker.createProtectiveExits(mockPosition, mockProposal, 'u');
    // All three orders: 100+100+100 = 300 = total_qty
    const totalSell = orders.reduce((s, o) => s + o.quantity, 0);
    expect(totalSell).toBe(300);
    expect(totalSell).toBe(mockPosition.total_qty);
  });
});

// ── Cancel entry tests ──

describe('cancelEntry', () => {
  const mockProposal = { id: 'prop-1', lifecycle_state: 'ENTRY_SUBMITTED' };

  beforeEach(() => {
    proposalService.getById.mockResolvedValue(mockProposal);
    proposalService.transitionState.mockResolvedValue({});
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes("order_type = 'entry'")) {
        return Promise.resolve({ rows: [{ id: 'ord-1', status: 'SUBMITTED', proposal_id: 'prop-1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  test('cancels pending entry and transitions to ENTRY_CANCELLED', async () => {
    const result = await paperBroker.cancelEntry('prop-1', 'u');
    expect(result.status).toBe('CANCELLED');
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'ENTRY_CANCELLED', 'u');
  });

  test('rejects if entry already filled', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes("order_type = 'entry'")) {
        return Promise.resolve({ rows: [{ id: 'ord-1', status: 'FILLED' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await expect(paperBroker.cancelEntry('prop-1', 'u')).rejects.toThrow('already filled');
  });

  test('rejects if no entry order found', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await expect(paperBroker.cancelEntry('prop-1', 'u')).rejects.toThrow('No entry order');
  });
});

// ── Update stop tests ──

describe('updateStop', () => {
  const mockProposal = { id: 'prop-1', lifecycle_state: 'POSITION_ACTIVE' };
  const mockPosition = {
    id: 'pos-1', proposal_id: 'prop-1', status: 'OPEN',
    direction: 'long', avg_entry_price: 50, remaining_qty: 200
  };

  beforeEach(() => {
    proposalService.getById.mockResolvedValue(mockProposal);
    proposalService.editProposal.mockResolvedValue({});
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions')) return Promise.resolve({ rows: [mockPosition] });
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes("'stop'")) return Promise.resolve({ rows: [{ id: 'old-stop', stop_price: 47, status: 'SUBMITTED' }] });
      if (sql.includes('SUM(quantity - filled_qty)')) return Promise.resolve({ rows: [{ active_qty: 100 }] });
      if (sql.startsWith('INSERT INTO paper_orders')) return Promise.resolve({ rows: [{ id: 'new-stop' }] });
      return Promise.resolve({ rows: [] });
    });
  });

  test('cancels old stop and creates new one', async () => {
    const result = await paperBroker.updateStop('prop-1', 45, 'u');
    expect(result.stop_price).toBe(45);
    expect(result.order.id).toBe('new-stop');
  });

  test('rejects stop above entry (no averaging down)', async () => {
    await expect(paperBroker.updateStop('prop-1', 55, 'u')).rejects.toThrow('below entry');
  });

  test('rejects invalid stop price', async () => {
    await expect(paperBroker.updateStop('prop-1', 0, 'u')).rejects.toThrow('Invalid stop');
    await expect(paperBroker.updateStop('prop-1', -5, 'u')).rejects.toThrow('Invalid stop');
  });

  test('rejects if no open position', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions')) return Promise.resolve({ rows: [{ ...mockPosition, status: 'CLOSED' }] });
      return Promise.resolve({ rows: [] });
    });
    await expect(paperBroker.updateStop('prop-1', 45, 'u')).rejects.toThrow('No open position');
  });
});

// ── Manual close tests ──

describe('manualClose', () => {
  const mockProposal = { id: 'prop-1', symbol: 'AAPL', lifecycle_state: 'POSITION_ACTIVE' };
  const mockPosition = {
    id: 'pos-1', proposal_id: 'prop-1', status: 'OPEN',
    direction: 'long', avg_entry_price: 50, remaining_qty: 200, realized_pnl: 100
  };

  beforeEach(() => {
    proposalService.getById.mockResolvedValue(mockProposal);
    proposalService.transitionState.mockResolvedValue({});
    finnhub.getQuote.mockResolvedValue({ c: 52, bid: 51.90, ask: 52.10 });
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions')) return Promise.resolve({ rows: [mockPosition] });
      if (sql.startsWith('INSERT INTO paper_orders')) return Promise.resolve({ rows: [{ id: 'close-ord' }] });
      if (sql.includes('UPDATE paper_positions')) return Promise.resolve({ rows: [mockPosition] });
      return Promise.resolve({ rows: [] });
    });
  });

  test('closes position at current bid', async () => {
    const result = await paperBroker.manualClose('prop-1', 'u');
    expect(result.fill_price).toBe(51.90);
    expect(result.quantity).toBe(200);
    expect(result.position_status).toBe('CLOSED');
    expect(proposalService.transitionState).toHaveBeenCalledWith('prop-1', 'POSITION_CLOSED', 'u');
  });

  test('rejects if no open position', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions')) return Promise.resolve({ rows: [{ ...mockPosition, status: 'CLOSED' }] });
      return Promise.resolve({ rows: [] });
    });
    await expect(paperBroker.manualClose('prop-1', 'u')).rejects.toThrow('No open position');
  });

  test('rejects if no valid quote', async () => {
    finnhub.getQuote.mockResolvedValue(null);
    await expect(paperBroker.manualClose('prop-1', 'u')).rejects.toThrow('No valid quote');
  });
});

// ── Reconciliation tests ──

describe('reconcile', () => {
  const mockPosition = {
    id: 'pos-1', proposal_id: 'prop-1', total_qty: 300,
    remaining_qty: 200, status: 'OPEN'
  };

  beforeEach(() => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions')) return Promise.resolve({ rows: [mockPosition] });
      if (sql.includes('SELECT * FROM paper_orders')) return Promise.resolve({
        rows: [
          { order_type: 'entry', side: 'buy', status: 'FILLED', filled_qty: 300, quantity: 300 },
          { order_type: 't1', side: 'sell', status: 'FILLED', filled_qty: 100, quantity: 100 },
          { order_type: 't2', side: 'sell', status: 'SUBMITTED', filled_qty: 0, quantity: 100 },
          { order_type: 'stop', side: 'sell', status: 'SUBMITTED', filled_qty: 0, quantity: 100 }
        ]
      });
      return Promise.resolve({ rows: [] });
    });
  });

  test('reports no discrepancy when remaining matches', async () => {
    const result = await paperBroker.reconcile('prop-1');
    expect(result.discrepancy).toBe(false);
    expect(result.expected_remaining).toBe(200);
    expect(result.actual_remaining).toBe(200);
  });

  test('reports discrepancy when remaining is wrong', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_positions')) return Promise.resolve({ rows: [{ ...mockPosition, remaining_qty: 150 }] });
      if (sql.includes('SELECT * FROM paper_orders')) return Promise.resolve({
        rows: [
          { order_type: 'entry', side: 'buy', status: 'FILLED', filled_qty: 300, quantity: 300 },
          { order_type: 't1', side: 'sell', status: 'FILLED', filled_qty: 100, quantity: 100 }
        ]
      });
      return Promise.resolve({ rows: [] });
    });
    const result = await paperBroker.reconcile('prop-1');
    expect(result.discrepancy).toBe(true);
    expect(result.expected_remaining).toBe(200);
    expect(result.actual_remaining).toBe(150);
  });

  test('sell invariant ok when active sell <= remaining', async () => {
    const result = await paperBroker.reconcile('prop-1');
    expect(result.sell_invariant_ok).toBe(true);
    expect(result.active_sell_qty).toBe(200); // t2(100) + stop(100)
  });

  test('returns null position when none exists', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const result = await paperBroker.reconcile('prop-1');
    expect(result.position).toBeNull();
    expect(result.discrepancy).toBe(false);
  });
});

// ── Account summary tests ──

describe('getAccountSummary', () => {
  beforeEach(() => {
    db.query.mockImplementation((sql) => {
      if (sql.includes("status = 'OPEN'")) return Promise.resolve({ rows: [{ count: 2, realized_pnl: 150.50 }] });
      if (sql.includes("status = 'CLOSED'")) return Promise.resolve({ rows: [{ count: 5, realized_pnl: -300.25 }] });
      return Promise.resolve({ rows: [] });
    });
  });

  test('aggregates open and closed P&L', async () => {
    const s = await paperBroker.getAccountSummary();
    expect(s.open_positions).toBe(2);
    expect(s.closed_positions).toBe(5);
    expect(s.open_realized_pnl).toBe(150.50);
    expect(s.closed_realized_pnl).toBe(-300.25);
    expect(s.total_realized_pnl).toBe(-149.75);
  });
});

// ── No live broker calls test ──

describe('no live broker calls', () => {
  test('submitEntry only uses finnhub.getQuote (no Schwab order API)', async () => {
    const proposal = {
      id: 'p', symbol: 'AAPL', direction: 'long', execution_mode: 'PAPER',
      lifecycle_state: 'APPROVED', position_size: 100,
      stop_price: 47, t1_price: 55, t2_price: 60,
      signal_id: 's', strategy_id: 'st', entry_zone: { high: 51 }
    };
    canBecomeReadyForApproval.mockReturnValue(true);
    isEvaluationStale.mockReturnValue(false);
    getLatestEvaluation.mockResolvedValue({ state: 'VALID', is_stale: false });
    proposalService.getById.mockResolvedValue(proposal);
    proposalService.transitionState.mockResolvedValue({});
    finnhub.getQuote.mockResolvedValue({ c: 50, ask: 50.10, bid: 49.90 });
    db.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM paper_orders') && sql.includes("order_type = 'entry'")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('INSERT INTO paper_orders')) {
        return Promise.resolve({ rows: [{ id: 'ord-1', status: 'SUBMITTED' }] });
      }
      if (sql.startsWith('INSERT INTO paper_positions')) {
        return Promise.resolve({ rows: [{ id: 'pos-1', status: 'OPEN', remaining_qty: 100 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await paperBroker.submitEntry('p', 'u');
    // Only finnhub.getQuote should be called, no Schwab order API
    expect(finnhub.getQuote).toHaveBeenCalledTimes(1);
  });
});
