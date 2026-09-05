// Focused deterministic tests for Journal Sync Service.
// Tests: entry fill creates trade, exit fill updates trade, position close
// marks completed, idempotent replay, partial exits, user field preservation,
// syncAll, getJournalTradeByProposal.

const journalSync = require('../../src/services/trading/journalSyncService');

jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/services/trading/proposalService', () => ({
  getById: jest.fn(),
}));
jest.mock('../../src/services/trading/paperBroker', () => ({
  toNum: jest.fn((v) => (v == null ? null : Number(v))),
  round2: jest.fn((v) => Math.round(Number(v) * 100) / 100),
}));

const db = require('../../src/config/database');
const proposalService = require('../../src/services/trading/proposalService');

beforeEach(() => jest.clearAllMocks());

const MOCK_USER_ID = 'usr-123';
const MOCK_POSITION_ID = 'pos-abc';
const MOCK_PROPOSAL_ID = 'prop-xyz';

function mockPosition(overrides = {}) {
  return {
    id: MOCK_POSITION_ID,
    proposal_id: MOCK_PROPOSAL_ID,
    signal_id: 'sig-1',
    strategy_id: 'strat-1',
    strategy_version: 'v1',
    symbol: 'AAPL',
    direction: 'long',
    total_qty: 100,
    remaining_qty: 100,
    avg_entry_price: 150.00,
    realized_pnl: 0,
    status: 'OPEN',
    execution_mode: 'PAPER',
    opened_at: '2026-09-04T14:30:00Z',
    closed_at: null,
    strategy_name: 'catalyst_momentum_vwap_reclaim',
    ...overrides,
  };
}

function mockEntryOrder(overrides = {}) {
  return {
    filled_at: '2026-09-04T14:31:00Z',
    avg_fill_price: 150.00,
    filled_qty: 100,
    ...overrides,
  };
}

function mockSellOrders(orders) {
  return { rows: orders };
}

describe('syncPositionToJournal — entry fill creates trade', () => {
  test('creates trade on first sync (OPEN position, entry filled)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition()] })         // position lookup
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })        // entry order
      .mockResolvedValueOnce({ rows: [] })                       // sell orders (none yet)
      .mockResolvedValueOnce({                                    // upsert (INSERT)
        rows: [{
          id: 'trade-1',
          paper_position_id: MOCK_POSITION_ID,
          execution_mode: 'PAPER',
          symbol: 'AAPL',
          side: 'long',
          entry_price: 150.00,
          quantity: 100,
          is_completed: false,
          pnl: 0,
        }]
      });

    proposalService.getById.mockResolvedValue({
      stop_price: 145.00,
      signal_id: 'sig-1',
    });

    // Also need to return userId from trade_signals query
    // But proposalService.getById returns the proposal, and then we query trade_signals for user_id
    // Let's check: the code does db.query for trade_signals when userId is null
    // Since we pass userId=null, it will try to get userId from the signal
    // Let's re-mock with the trade_signals query

    const result = await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    expect(result).toBeTruthy();
    expect(result.paper_position_id).toBe(MOCK_POSITION_ID);
    expect(result.execution_mode).toBe('PAPER');

    // Verify the INSERT query was called
    const insertCall = db.query.mock.calls.find(
      c => c[0] && c[0].includes('INSERT INTO trades')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain('ON CONFLICT (paper_position_id)');
  });

  test('returns null when position does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await journalSync.syncPositionToJournal('nonexistent', MOCK_USER_ID);
    expect(result).toBeNull();
  });

  test('returns null when entry order not filled yet', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition()] })
      .mockResolvedValueOnce({ rows: [] }); // no filled entry order

    const result = await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);
    expect(result).toBeNull();
  });
});

describe('syncPositionToJournal — exit fill updates trade (idempotent)', () => {
  test('updates exit fields on second sync (position still OPEN with partial exit)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition({
        remaining_qty: 67,
        realized_pnl: 150.00,
      })] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({
        rows: [{
          filled_qty: 33,
          avg_fill_price: 154.55,
        }]
      })
      .mockResolvedValueOnce({ // ON CONFLICT update
        rows: [{
          id: 'trade-1',
          paper_position_id: MOCK_POSITION_ID,
          exit_price: 154.55,
          pnl: 150.00,
          is_completed: false,
        }]
      });

    proposalService.getById.mockResolvedValue({
      stop_price: 145.00,
      signal_id: 'sig-1',
    });

    const result = await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    expect(result).toBeTruthy();
    expect(result.exit_price).toBe(154.55);
    expect(result.pnl).toBe(150.00);
    expect(result.is_completed).toBe(false);
  });

  test('marks trade as completed when position is CLOSED', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition({
        status: 'CLOSED',
        remaining_qty: 0,
        realized_pnl: 500.00,
        closed_at: '2026-09-04T16:00:00Z',
      })] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({
        rows: [
          { filled_qty: 33, avg_fill_price: 155.00 },
          { filled_qty: 33, avg_fill_price: 158.00 },
          { filled_qty: 34, avg_fill_price: 152.00 },
        ]
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'trade-1',
          paper_position_id: MOCK_POSITION_ID,
          is_completed: true,
          pnl: 500.00,
          exit_price: 154.82,  // weighted avg: (33*155 + 33*158 + 34*152) / 100
        }]
      });

    proposalService.getById.mockResolvedValue({
      stop_price: 145.00,
      signal_id: 'sig-1',
    });

    const result = await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    expect(result).toBeTruthy();
    expect(result.is_completed).toBe(true);
    expect(result.pnl).toBe(500.00);
  });
});

describe('syncPositionToJournal — idempotent replay', () => {
  test('replaying same position state produces same result (ON CONFLICT)', async () => {
    // First sync
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition()] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'trade-1', paper_position_id: MOCK_POSITION_ID }] });

    proposalService.getById.mockResolvedValue({ stop_price: 145.00, signal_id: 'sig-1' });

    const result1 = await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    // Second sync — same state, should use ON CONFLICT DO UPDATE
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition()] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'trade-1', paper_position_id: MOCK_POSITION_ID }] });

    const result2 = await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    // Both should return the same trade id
    expect(result1.id).toBe(result2.id);
    expect(result1.paper_position_id).toBe(MOCK_POSITION_ID);

    // The upsert query should contain ON CONFLICT
    const upsertCalls = db.query.mock.calls.filter(
      c => c[0] && c[0].includes('ON CONFLICT')
    );
    expect(upsertCalls.length).toBe(2);
  });

  test('user fields are never set in the UPDATE clause', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition()] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'trade-1' }] });

    proposalService.getById.mockResolvedValue({ stop_price: 145.00, signal_id: 'sig-1' });

    await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    const upsertCall = db.query.mock.calls.find(
      c => c[0] && c[0].includes('ON CONFLICT')
    );
    const sql = upsertCall[0];

    // These user-owned fields should NOT be in the DO UPDATE SET clause
    expect(sql).not.toMatch(/DO UPDATE SET.*notes/i);
    expect(sql).not.toMatch(/DO UPDATE SET.*tags/i);
    expect(sql).not.toMatch(/DO UPDATE SET.*strategy/i);
    expect(sql).not.toMatch(/DO UPDATE SET.*setup/i);
    expect(sql).not.toMatch(/DO UPDATE SET.*is_public/i);
    expect(sql).not.toMatch(/DO UPDATE SET.*confidence/i);
    expect(sql).not.toMatch(/DO UPDATE SET.*chart_url/i);

    // But these execution-derived fields SHOULD be updated
    expect(sql).toMatch(/entry_price\s+= EXCLUDED\.entry_price/);
    expect(sql).toMatch(/exit_price\s+= EXCLUDED\.exit_price/);
    expect(sql).toMatch(/pnl\s+= EXCLUDED\.pnl/);
    expect(sql).toMatch(/is_completed\s+= EXCLUDED\.is_completed/);
  });
});

describe('syncPositionToJournal — P&L correctness', () => {
  test('weighted average exit price from multiple sell fills', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [mockPosition({
        status: 'CLOSED',
        remaining_qty: 0,
        realized_pnl: 300.00,
        closed_at: '2026-09-04T16:00:00Z',
      })] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder({ avg_fill_price: 150.00 })] })
      .mockResolvedValueOnce({
        rows: [
          { filled_qty: 50, avg_fill_price: 154.00 },  // +200
          { filled_qty: 50, avg_fill_price: 152.00 },  // +100
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: 'trade-1', exit_price: 153.00 }] });

    proposalService.getById.mockResolvedValue({ stop_price: 145.00, signal_id: 'sig-1' });

    await journalSync.syncPositionToJournal(MOCK_POSITION_ID, MOCK_USER_ID);

    // Check the values passed to the upsert query
    const upsertCall = db.query.mock.calls.find(
      c => c[0] && c[0].includes('INSERT INTO trades')
    );
    const params = upsertCall[1];

    // exit_price = (50*154 + 50*152) / 100 = 153.00
    // Check that exit_price (param index 6, 0-based: $6) is 153.00
    expect(params[5]).toBe(153);  // exit_price is $6 (0-based index 5)
  });
});

describe('syncAllToJournal', () => {
  test('syncs multiple positions and reports counts', async () => {
    const positionIds = [
      { id: 'pos-1' },
      { id: 'pos-2' },
      { id: 'pos-3' },
    ];

    db.query
      .mockResolvedValueOnce({ rows: positionIds })  // position list query
      // For each position: position lookup + entry order + sell orders + upsert
      .mockResolvedValueOnce({ rows: [mockPosition({ id: 'pos-1' })] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 't1' }] })
      .mockResolvedValueOnce({ rows: [mockPosition({ id: 'pos-2' })] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 't2' }] })
      .mockResolvedValueOnce({ rows: [mockPosition({ id: 'pos-3' })] })
      .mockResolvedValueOnce({ rows: [mockEntryOrder()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 't3' }] });

    proposalService.getById.mockResolvedValue({ stop_price: 145.00, signal_id: 'sig-1' });

    const result = await journalSync.syncAllToJournal(MOCK_USER_ID);

    expect(result.synced).toBe(3);
    expect(result.errors).toEqual([]);
  });

  test('reports errors for failed syncs', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'pos-bad' }] })
      .mockResolvedValueOnce({ rows: [] }); // position not found

    const result = await journalSync.syncAllToJournal(MOCK_USER_ID);

    expect(result.synced).toBe(0);
    // syncPositionToJournal returns null for missing position, doesn't throw
    // so no errors, just 0 synced
    expect(result.errors).toEqual([]);
  });
});

describe('getJournalTrade', () => {
  test('returns trade by position id', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'trade-1', paper_position_id: MOCK_POSITION_ID }]
    });

    const result = await journalSync.getJournalTrade(MOCK_POSITION_ID);
    expect(result).toBeTruthy();
    expect(result.paper_position_id).toBe(MOCK_POSITION_ID);
  });

  test('returns null when no trade linked', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await journalSync.getJournalTrade('no-trade');
    expect(result).toBeNull();
  });
});

describe('getJournalTradeByProposal', () => {
  test('returns trade by proposal id via join', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'trade-1', paper_position_id: MOCK_POSITION_ID }]
    });

    const result = await journalSync.getJournalTradeByProposal(MOCK_PROPOSAL_ID);
    expect(result).toBeTruthy();
    expect(result.id).toBe('trade-1');
  });

  test('returns null when no trade linked to proposal', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await journalSync.getJournalTradeByProposal('no-prop');
    expect(result).toBeNull();
  });
});
