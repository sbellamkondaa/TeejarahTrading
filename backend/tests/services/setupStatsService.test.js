// Tests for setupStatsService — empirical win rate computation.
// Pure-function tests for normalization, aggregation, and lookup matching.
// I/O tests mock the database query.

const {
  normalizeSetup,
  aggregateStats,
  lookupBySetupType,
  getSetupStats,
  getStatsForSetupType,
  MIN_SAMPLE_SIZE
} = require('../../src/services/trading/setupStatsService');

jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
const db = require('../../src/config/database');

beforeEach(() => jest.clearAllMocks());

// ── normalizeSetup ──

describe('normalizeSetup', () => {
  test('lowercases and snake_cases spaces', () => {
    expect(normalizeSetup('VWAP Reclaim')).toBe('vwap_reclaim');
  });
  test('replaces hyphens with underscores', () => {
    expect(normalizeSetup('VWAP-Reclaim')).toBe('vwap_reclaim');
  });
  test('expands & to and', () => {
    expect(normalizeSetup('Gap & Catalyst')).toBe('gap_and_catalyst');
  });
  test('strips non-alphanumeric', () => {
    expect(normalizeSetup('VWAP! Reclaim?')).toBe('vwap_reclaim');
  });
  test('collapses repeated separators', () => {
    expect(normalizeSetup('VWAP  Reclaim')).toBe('vwap_reclaim');
  });
  test('trims leading/trailing underscores', () => {
    expect(normalizeSetup(' VWAP Reclaim ')).toBe('vwap_reclaim');
  });
  test('null returns empty', () => {
    expect(normalizeSetup(null)).toBe('');
    expect(normalizeSetup(undefined)).toBe('');
    expect(normalizeSetup('')).toBe('');
  });
});

// ── aggregateStats ──

describe('aggregateStats', () => {
  const rows = [
    { setup: 'VWAP Reclaim', sample_size: '10', wins: '7', losses: '3', avg_pnl: '120', avg_pnl_pct: '2.1', avg_win: '200', avg_loss: '-50', date_from: '2025-01-15', date_to: '2025-09-01' },
    { setup: 'Momentum', sample_size: '4', wins: '2', losses: '2', avg_pnl: '30', avg_pnl_pct: '0.8', avg_win: '150', avg_loss: '-90', date_from: '2025-06-01', date_to: '2025-08-15' },
    { setup: 'vwap reclaim', sample_size: '5', wins: '3', losses: '2', avg_pnl: '80', avg_pnl_pct: '1.5', avg_win: '180', avg_loss: '-70', date_from: '2025-03-01', date_to: '2025-07-30' }
  ];

  test('groups by normalized name — merges same-key rows', () => {
    const stats = aggregateStats(rows);
    // "VWAP Reclaim" (10, 7W) and "vwap reclaim" (5, 3W) merge → 15, 10W
    expect(stats.vwap_reclaim).toBeDefined();
    expect(stats.vwap_reclaim.sample_size).toBe(15);
    expect(stats.vwap_reclaim.wins).toBe(10);
    expect(stats.momentum).toBeDefined();
    expect(stats.momentum.sample_size).toBe(4);
  });

  test('marks sufficient when sample >= MIN_SAMPLE_SIZE', () => {
    const stats = aggregateStats(rows);
    expect(stats.vwap_reclaim.sufficient).toBe(true); // 15 >= 5
    expect(stats.momentum.sufficient).toBe(false);    // 4 < 5
  });

  test('computes merged win rate with one decimal precision', () => {
    const stats = aggregateStats(rows);
    expect(stats.vwap_reclaim.win_rate).toBe(66.7); // 10/15 * 100
    expect(stats.momentum.win_rate).toBe(50.0);    // 2/4 * 100
  });

  test('preserves original setup_label from first row', () => {
    const stats = aggregateStats(rows);
    expect(stats.vwap_reclaim.setup_label).toBe('VWAP Reclaim');
  });

  test('widens date range across merged rows', () => {
    const stats = aggregateStats(rows);
    expect(stats.vwap_reclaim.date_from).toBe('2025-01-15'); // min
    expect(stats.vwap_reclaim.date_to).toBe('2025-09-01');  // max
  });
});

// ── lookupBySetupType ──

describe('lookupBySetupType', () => {
  const stats = {
    vwap_reclaim: {
      setup_label: 'VWAP Reclaim', normalized: 'vwap_reclaim',
      sample_size: 12, wins: 8, losses: 4, win_rate: 66.7,
      avg_pnl: 110, avg_pnl_pct: 2.0, avg_win: 200, avg_loss: -60,
      date_from: '2025-01-01', date_to: '2025-09-01', sufficient: true
    },
    momentum: {
      setup_label: 'Momentum', normalized: 'momentum',
      sample_size: 3, wins: 2, losses: 1, win_rate: 66.7,
      avg_pnl: 50, avg_pnl_pct: 1.0, avg_win: 120, avg_loss: -80,
      date_from: '2025-06-01', date_to: '2025-08-01', sufficient: false
    }
  };

  test('exact match', () => {
    const r = lookupBySetupType(stats, 'vwap_reclaim');
    expect(r.sample_size).toBe(12);
    expect(r.win_rate).toBe(66.7);
    expect(r.sufficient).toBe(true);
    expect(r.setup_type).toBe('vwap_reclaim');
  });

  test('prefix match — vwap_reclaim_with_catalyst matches vwap_reclaim', () => {
    const r = lookupBySetupType(stats, 'vwap_reclaim_with_catalyst');
    expect(r.sample_size).toBe(12);
    expect(r.win_rate).toBe(66.7);
    expect(r.setup_type).toBe('vwap_reclaim_with_catalyst');
  });

  test('no match returns insufficient with sample_size 0', () => {
    const r = lookupBySetupType(stats, 'nonexistent_setup');
    expect(r.sample_size).toBe(0);
    expect(r.sufficient).toBe(false);
    expect(r.insufficient_reason).toBe('No comparable trades found');
  });

  test('insufficient setup returns stats with sufficient=false', () => {
    const r = lookupBySetupType(stats, 'momentum');
    expect(r.sample_size).toBe(3);
    expect(r.sufficient).toBe(false);
  });

  test('empty/null setupType returns null', () => {
    expect(lookupBySetupType(stats, '')).toBeNull();
    expect(lookupBySetupType(stats, null)).toBeNull();
  });

  test('longest prefix wins when multiple matches', () => {
    const stats2 = {
      vwap: { setup_label: 'VWAP', sample_size: 50, wins: 25, losses: 25, win_rate: 50, sufficient: true, avg_pnl: 0, avg_pnl_pct: 0, avg_win: 0, avg_loss: 0, date_from: '2025-01-01', date_to: '2025-09-01' },
      vwap_reclaim: { setup_label: 'VWAP Reclaim', sample_size: 12, wins: 8, losses: 4, win_rate: 66.7, sufficient: true, avg_pnl: 110, avg_pnl_pct: 2.0, avg_win: 200, avg_loss: -60, date_from: '2025-01-01', date_to: '2025-09-01' }
    };
    const r = lookupBySetupType(stats2, 'vwap_reclaim_with_catalyst');
    // Should match vwap_reclaim (longer prefix) not vwap
    expect(r.sample_size).toBe(12);
  });
});

// ── getSetupStats (I/O) ──

describe('getSetupStats', () => {
  test('queries completed trades and aggregates', async () => {
    db.query.mockResolvedValue({
      rows: [
        { setup: 'VWAP Reclaim', sample_size: '10', wins: '7', losses: '3', avg_pnl: '120', avg_pnl_pct: '2.1', avg_win: '200', avg_loss: '-50', date_from: '2025-01-15', date_to: '2025-09-01' }
      ]
    });
    const stats = await getSetupStats('user-uuid');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain('exit_price IS NOT NULL');
    expect(db.query.mock.calls[0][0]).toContain('pnl IS NOT NULL');
    expect(db.query.mock.calls[0][1]).toEqual(['user-uuid']);
    expect(stats.vwap_reclaim).toBeDefined();
    expect(stats.vwap_reclaim.sample_size).toBe(10);
  });

  test('empty result returns empty map', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const stats = await getSetupStats('user-uuid');
    expect(stats).toEqual({});
  });
});

// ── getStatsForSetupType (I/O) ──

describe('getStatsForSetupType', () => {
  test('returns matching stats', async () => {
    db.query.mockResolvedValue({
      rows: [
        { setup: 'VWAP Reclaim', sample_size: '10', wins: '7', losses: '3', avg_pnl: '120', avg_pnl_pct: '2.1', avg_win: '200', avg_loss: '-50', date_from: '2025-01-15', date_to: '2025-09-01' }
      ]
    });
    const r = await getStatsForSetupType('user-uuid', 'vwap_reclaim');
    expect(r.sample_size).toBe(10);
    expect(r.sufficient).toBe(true);
  });

  test('returns insufficient when no data', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await getStatsForSetupType('user-uuid', 'nonexistent');
    expect(r.sample_size).toBe(0);
    expect(r.sufficient).toBe(false);
    expect(r.insufficient_reason).toBe('No comparable trades found');
  });
});
