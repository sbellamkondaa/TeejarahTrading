// Tests for paperAccountService — buying power reservation, release, halt.
// Tests: reservation, insufficient buying power, duplicate prevention,
// release, double release prevention, realized P&L, halt/unhalt.

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  pool: {}
}));
jest.mock('../../src/services/trading/auditService', () => ({ recordEvent: jest.fn() }));

const db = require('../../src/config/database');
const paperAccount = require('../../src/services/trading/paperAccountService');
const auditService = require('../../src/services/trading/auditService');

function mockClient() {
  const handlers = {};
  const client = {
    query: jest.fn(async (text, params) => {
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (text.includes(pattern)) return handler(params);
      }
      return { rows: [] };
    }),
    release: jest.fn(),
    on: (pattern, handler) => { handlers[pattern] = handler; }
  };
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('paperAccountService', () => {
  test('getAccount creates account if missing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT returns nothing
    db.query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', starting_cash: '100000', available_cash: '100000' }] });
    const account = await paperAccount.getAccount();
    expect(account.id).toBe('acct-1');
  });

  test('getAccount returns existing account', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', starting_cash: '100000', available_cash: '50000' }] });
    const account = await paperAccount.getAccount();
    expect(account.id).toBe('acct-1');
  });

  test('getAccountSummary computes equity and buying power', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', starting_cash: '100000', available_cash: '80000', reserved_cash: '20000', total_realized_pnl: '5000', paper_trading_halted: false }]
    });
    const summary = await paperAccount.getAccountSummary([
      { remaining_qty: 100, avg_entry_price: '50', current_price: 55 }
    ]);
    // market_value = 100 * 55 = 5500
    // unrealized = 100 * (55 - 50) = 500
    // equity = 80000 + 5500 + 20000 = 105500
    // buying_power = 80000
    expect(summary.equity).toBe(105500);
    expect(summary.buying_power).toBe(80000);
    expect(summary.market_value).toBe(5500);
    expect(summary.unrealized_pnl).toBe(500);
  });

  test('reserveBuyingPower deducts from available cash', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    // Mock ledger duplicate check (no dup)
    client.on('paper_account_ledger', () => ({ rows: [] }));
    // Mock account SELECT FOR UPDATE
    client.on('paper_account ORDER BY', () => ({
      rows: [{ id: 'a', available_cash: '50000', reserved_cash: '10000' }]
    }));
    // Mock UPDATE and INSERT (return empty)
    client.on('UPDATE paper_account', () => ({ rows: [] }));
    client.on('INSERT INTO paper_account_ledger', () => ({ rows: [] }));

    const result = await paperAccount.reserveBuyingPower('pos-1', 5000);
    expect(result.available_cash).toBe(45000);
    expect(result.reserved_cash).toBe(15000);
  });

  test('reserveBuyingPower rejects insufficient buying power', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    client.on('paper_account_ledger', () => ({ rows: [] }));
    client.on('paper_account ORDER BY', () => ({
      rows: [{ id: 'a', available_cash: '3000', reserved_cash: '0' }]
    }));

    await expect(paperAccount.reserveBuyingPower('pos-1', 5000))
      .rejects.toThrow('Insufficient buying power');
  });

  test('reserveBuyingPower prevents double reservation (idempotent retry)', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    // Mock ledger duplicate check (already reserved)
    client.on('paper_account_ledger', () => ({ rows: [{ balance_after: 45000 }] }));

    // Also mock getAccount for the idempotent return
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', available_cash: '45000', reserved_cash: '15000' }]
    });

    const result = await paperAccount.reserveBuyingPower('pos-1', 5000);
    // Should return success (idempotent), not throw
    expect(result.available_cash).toBe(45000);
    expect(result.reserved_cash).toBe(15000);
    expect(result.idempotent).toBe(true);
  });

  test('releaseBuyingPower releases reserved cash + applies P&L', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    // No duplicate release
    client.on('paper_account_ledger', () => ({ rows: [] }));
    // Account with 70000 available, 20000 reserved, 5000 realized
    client.on('paper_account ORDER BY', () => ({
      rows: [{ id: 'a', available_cash: '70000', reserved_cash: '20000', total_realized_pnl: '5000' }]
    }));

    // Release 20000 reservation with 3000 P&L
    const result = await paperAccount.releaseBuyingPower('pos-1', 3000, 20000);
    // new_available = 70000 + 20000 + 3000 = 93000
    // new_reserved = 20000 - 20000 = 0
    // new_realized = 5000 + 3000 = 8000
    expect(result.available_cash).toBe(93000);
    expect(result.reserved_cash).toBe(0);
    expect(result.total_realized_pnl).toBe(8000);
  });

  test('releaseBuyingPower prevents double release (idempotent retry)', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    // Already released
    client.on('paper_account_ledger', () => ({ rows: [{ balance_after: 93000 }] }));

    // Mock getAccount for idempotent return
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', available_cash: '93000', reserved_cash: '0', total_realized_pnl: '8000' }]
    });

    const result = await paperAccount.releaseBuyingPower('pos-1', 1000, 5000);
    // Should return success (idempotent), not throw
    expect(result.available_cash).toBe(93000);
    expect(result.idempotent).toBe(true);
  });

  test('haltPaperTrading sets halted flag', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', available_cash: '50000', paper_trading_halted: false }]
    });
    db.query.mockResolvedValue({ rows: [] });
    const result = await paperAccount.haltPaperTrading('test halt');
    expect(result.halted).toBe(true);
  });

  test('unhaltPaperTrading clears halted flag', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', available_cash: '50000', paper_trading_halted: true }]
    });
    db.query.mockResolvedValue({ rows: [] });
    const result = await paperAccount.unhaltPaperTrading();
    expect(result.halted).toBe(false);
  });

  test('isPaperTradingHalted returns boolean', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', paper_trading_halted: true }]
    });
    const halted = await paperAccount.isPaperTradingHalted();
    expect(halted).toBe(true);

    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', paper_trading_halted: false }]
    });
    const notHalted = await paperAccount.isPaperTradingHalted();
    expect(notHalted).toBe(false);
  });

  test('getAccountSummary handles no open positions', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a', starting_cash: '100000', available_cash: '100000', reserved_cash: '0', total_realized_pnl: '0', paper_trading_halted: false }]
    });
    const summary = await paperAccount.getAccountSummary([]);
    expect(summary.equity).toBe(100000);
    expect(summary.buying_power).toBe(100000);
    expect(summary.market_value).toBe(0);
    expect(summary.unrealized_pnl).toBe(0);
  });
});

// ── Reconciliation tests ──

describe('reconcilePaperAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects reservation drift — open position without reservation', async () => {
    // getAccount uses the persistent mock (set last)
    // missingReservations
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'acct', available_cash: '80000', reserved_cash: '10000', total_realized_pnl: '0', paper_trading_halted: false }] }) // getAccount
      .mockResolvedValueOnce({ rows: [{ position_id: 'pos-1', proposal_id: 'p1', total_qty: '100', avg_entry_price: '50', remaining_qty: '100', status: 'OPEN' }] }) // missingReservations
      .mockResolvedValueOnce({ rows: [] }) // missingReleases
      .mockResolvedValueOnce({ rows: [{ total_pnl: '0' }] }) // pnlFromLedger
      .mockResolvedValueOnce({ rows: [{ net_reserved: '0' }] }) // reservedFromLedger
      .mockResolvedValueOnce({ rows: [] }); // orphanedReservations

    // Mock reserveBuyingPower — it uses db.connect internally
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    client.on('paper_account_ledger', () => ({ rows: [] })); // no dup
    client.on('paper_account ORDER BY', () => ({
      rows: [{ id: 'acct', available_cash: '80000', reserved_cash: '10000' }]
    }));

    const result = await paperAccount.reconcilePaperAccount('user-1');
    const hasRepair = result.repairs.some(r => r.repair === 'added_missing_reservation');
    const hasManual = result.manualInterventions.some(m => m.type === 'reservation');
    expect(hasRepair || hasManual).toBe(true);
    expect(auditService.recordEvent).toHaveBeenCalled();
  });

  test('detects release drift — closed position without release', async () => {
    // getAccount
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acct', available_cash: '50000', reserved_cash: '5000', total_realized_pnl: '0', paper_trading_halted: false }]
    });
    // missingReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // missingReleases
    db.query.mockResolvedValueOnce({
      rows: [{ position_id: 'pos-2', proposal_id: 'p2', total_qty: '100', avg_entry_price: '50', realized_pnl: '200', status: 'CLOSED', closed_at: '2024-01-01' }]
    });
    // pnlFromLedger (after release, P&L = 200)
    // Note: releaseBuyingPower will insert a realized_pnl entry, but since it uses
    // db.connect (mocked), the db.query for pnlFromLedger is called after
    db.query.mockResolvedValueOnce({ rows: [{ total_pnl: '0' }] });
    // reservedFromLedger
    db.query.mockResolvedValueOnce({ rows: [{ net_reserved: '5000' }] });
    // orphanedReservations
    db.query.mockResolvedValueOnce({ rows: [] });

    // Mock releaseBuyingPower (it uses db.connect)
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    client.on('paper_account_ledger', () => ({ rows: [] })); // no dup
    client.on('paper_account ORDER BY', () => ({
      rows: [{ id: 'acct', available_cash: '50000', reserved_cash: '5000', total_realized_pnl: '0' }]
    }));

    const result = await paperAccount.reconcilePaperAccount('user-1');
    expect(result.repairs.some(r => r.repair === 'added_missing_release')).toBe(true);
  });

  test('detects P&L drift — recomputes from ledger', async () => {
    // getAccount with total_realized_pnl = 0
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acct', available_cash: '90000', reserved_cash: '0', total_realized_pnl: '0', paper_trading_halted: false }]
    });
    // missingReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // missingReleases (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // pnlFromLedger returns 1500 (drift from account 0)
    db.query.mockResolvedValueOnce({ rows: [{ total_pnl: '1500' }] });
    // reservedFromLedger
    db.query.mockResolvedValueOnce({ rows: [{ net_reserved: '0' }] });
    // orphanedReservations
    db.query.mockResolvedValueOnce({ rows: [] });
    // UPDATE for P&L repair
    db.query.mockResolvedValueOnce({ rows: [] });

    const result = await paperAccount.reconcilePaperAccount('user-1');
    expect(result.repairs.some(r => r.repair === 'recomputed_realized_pnl')).toBe(true);
    expect(result.summary.ledger_pnl).toBe(1500);
  });

  test('detects reserved-cash drift — recomputes from ledger', async () => {
    // getAccount with reserved_cash = 10000 (drift)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acct', available_cash: '70000', reserved_cash: '10000', total_realized_pnl: '0', paper_trading_halted: false }]
    });
    // missingReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // missingReleases (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // pnlFromLedger
    db.query.mockResolvedValueOnce({ rows: [{ total_pnl: '0' }] });
    // reservedFromLedger returns 5000 (drift from account 10000)
    db.query.mockResolvedValueOnce({ rows: [{ net_reserved: '5000' }] });
    // orphanedReservations
    db.query.mockResolvedValueOnce({ rows: [] });
    // UPDATE for reserved_cash repair
    db.query.mockResolvedValueOnce({ rows: [] });

    const result = await paperAccount.reconcilePaperAccount('user-1');
    expect(result.repairs.some(r => r.repair === 'recomputed_reserved_cash')).toBe(true);
  });

  test('unsafe reserved-cash drift (negative available) → manual intervention', async () => {
    // getAccount: reserved_cash = 0, but ledger says 10000 (account understated reserved)
    // Fix: expectedReserved = 10000, diff = 10000 - 0 = 10000
    // newAvailable = 1000 - 10000 = -9000 → negative → unsafe
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acct', available_cash: '1000', reserved_cash: '0', total_realized_pnl: '0', paper_trading_halted: false }]
    });
    // missingReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // missingReleases (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // pnlFromLedger
    db.query.mockResolvedValueOnce({ rows: [{ total_pnl: '0' }] });
    // reservedFromLedger returns 10000 (account has 0 → fixing would make available negative)
    db.query.mockResolvedValueOnce({ rows: [{ net_reserved: '10000' }] });
    // orphanedReservations
    db.query.mockResolvedValueOnce({ rows: [] });

    const result = await paperAccount.reconcilePaperAccount('user-1');
    expect(result.manualInterventions.some(m => m.type === 'reserved_cash')).toBe(true);
    expect(auditService.recordEvent).toHaveBeenCalled();
  });

  test('orphaned reservation (position closed without release) → manual intervention', async () => {
    // getAccount
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acct', available_cash: '80000', reserved_cash: '5000', total_realized_pnl: '0', paper_trading_halted: false }]
    });
    // missingReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // missingReleases (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // pnlFromLedger
    db.query.mockResolvedValueOnce({ rows: [{ total_pnl: '0' }] });
    // reservedFromLedger
    db.query.mockResolvedValueOnce({ rows: [{ net_reserved: '5000' }] });
    // orphanedReservations (one found)
    db.query.mockResolvedValueOnce({
      rows: [{ position_id: 'pos-orphan', amount: '5000' }]
    });

    const result = await paperAccount.reconcilePaperAccount('user-1');
    expect(result.manualInterventions.some(m => m.type === 'orphaned_reservation')).toBe(true);
  });

  test('no drift — all reconciled', async () => {
    // getAccount
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acct', available_cash: '80000', reserved_cash: '5000', total_realized_pnl: '1000', paper_trading_halted: false }]
    });
    // missingReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // missingReleases (none)
    db.query.mockResolvedValueOnce({ rows: [] });
    // pnlFromLedger = 1000 (matches)
    db.query.mockResolvedValueOnce({ rows: [{ total_pnl: '1000' }] });
    // reservedFromLedger = 5000 (matches)
    db.query.mockResolvedValueOnce({ rows: [{ net_reserved: '5000' }] });
    // orphanedReservations (none)
    db.query.mockResolvedValueOnce({ rows: [] });

    const result = await paperAccount.reconcilePaperAccount('user-1');
    expect(result.repairs.length).toBe(0);
    expect(result.manualInterventions.length).toBe(0);
  });
});
