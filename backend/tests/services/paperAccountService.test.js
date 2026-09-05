// Tests for paperAccountService — buying power reservation, release, halt.
// Tests: reservation, insufficient buying power, duplicate prevention,
// release, double release prevention, realized P&L, halt/unhalt.

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  pool: {}
}));

const db = require('../../src/config/database');
const paperAccount = require('../../src/services/trading/paperAccountService');

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

  test('reserveBuyingPower prevents double reservation', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    // Mock ledger duplicate check (already reserved)
    client.on('paper_account_ledger', () => ({ rows: [{ id: 'ledger-1' }] }));

    await expect(paperAccount.reserveBuyingPower('pos-1', 5000))
      .rejects.toThrow('already reserved');
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

  test('releaseBuyingPower prevents double release', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    // Already released
    client.on('paper_account_ledger', () => ({ rows: [{ id: 'ledger-1' }] }));

    await expect(paperAccount.releaseBuyingPower('pos-1', 1000, 5000))
      .rejects.toThrow('already released');
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
