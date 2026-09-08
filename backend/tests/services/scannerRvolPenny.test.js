// Focused tests for RVOL and penny-stock filtering fixes.

jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/redisCache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(true)
}));

const { scoreOpportunity, applyDiscoveryFilters, PRICE_PRESETS } = require('../../src/services/marketIntelligence/opportunityScore');
const { scanCandidates } = require('../../src/utils/scanner');

describe('opportunityScore RVOL handling', () => {
  test('null rvol produces null factor + rvol_unknown flag, NOT 0', () => {
    const r = scoreOpportunity({
      gap_pct: 5, rvol: null, volume: 1_000_000,
      liquidity_rating: 'high', catalyst_strength: 50,
      best_setup: { score: 60 }, relative_strength: 5
    });
    expect(r.factors.rvol).toBeNull();
    expect(r.factors.rvol_unknown).toBe(true);
    // Score should NOT include a 0 for rvol as if it were a real value
    expect(r.score).toBeGreaterThan(0);
  });

  test('real rvol produces a numeric factor and no unknown flag', () => {
    const r = scoreOpportunity({
      gap_pct: 5, rvol: 4.0, volume: 1_000_000,
      liquidity_rating: 'high', catalyst_strength: 50,
      best_setup: { score: 60 }, relative_strength: 5
    });
    expect(r.factors.rvol).toBe(20);
    expect(r.factors.rvol_unknown).toBeUndefined();
  });

  test('rvol=0 (actual zero) is treated as a real value, not unknown', () => {
    const r = scoreOpportunity({ rvol: 0 });
    expect(r.factors.rvol).toBe(0);
    expect(r.factors.rvol_unknown).toBeUndefined();
  });
});

describe('applyDiscoveryFilters RVOL behavior', () => {
  const baseCandidate = {
    last_price: 10, gap_pct: 5, volume: 1_000_000
  };

  test('min_rvol excludes calculated rvol below threshold', () => {
    const cands = [
      { ...baseCandidate, symbol: 'A', rvol: 1.0 },
      { ...baseCandidate, symbol: 'B', rvol: 3.0 }
    ];
    const out = applyDiscoveryFilters(cands, { min_rvol: 2 });
    expect(out.map((c) => c.symbol)).toEqual(['B']);
  });

  test('min_rvol includes unknown rvol by default (include_unknown_rvol=true)', () => {
    const cands = [
      { ...baseCandidate, symbol: 'A', rvol: null },
      { ...baseCandidate, symbol: 'B', rvol: 3.0 }
    ];
    const out = applyDiscoveryFilters(cands, { min_rvol: 2 });
    expect(out.map((c) => c.symbol).sort()).toEqual(['A', 'B']);
  });

  test('min_rvol excludes unknown rvol when include_unknown_rvol=false', () => {
    const cands = [
      { ...baseCandidate, symbol: 'A', rvol: null },
      { ...baseCandidate, symbol: 'B', rvol: 3.0 }
    ];
    const out = applyDiscoveryFilters(cands, { min_rvol: 2, include_unknown_rvol: 'false' });
    expect(out.map((c) => c.symbol)).toEqual(['B']);
  });

  test('no min_rvol filter → all candidates pass regardless of rvol', () => {
    const cands = [
      { ...baseCandidate, symbol: 'A', rvol: null },
      { ...baseCandidate, symbol: 'B', rvol: 0.5 }
    ];
    const out = applyDiscoveryFilters(cands, {});
    expect(out.length).toBe(2);
  });
});

describe('scanner penny-stock exclusion', () => {
  const baseCandidate = {
    symbol: 'TEST',
    last_price: 10,
    change_percent: 8,
    gap_pct: 6,
    catalysts: [],
    indicators: {
      last_price: 10,
      gap_pct: 6,
      change_percent: 8,
      rvol: null,
      volume: 1_000_000,
      liquidity: { liquidity_rating: 'high', spread_rating: 'unknown' },
      trend_regime: 'insufficient_data'
    }
  };

  test('exclude_penny_stocks=true removes sub-$5 candidates without exception', () => {
    const penny = {
      ...baseCandidate,
      symbol: 'PENNY',
      last_price: 0.50,
      indicators: { ...baseCandidate.indicators, last_price: 0.50 }
    };
    const results = scanCandidates([baseCandidate, penny], { excludePennyStocks: true });
    const symbols = results.map((r) => r.symbol);
    expect(symbols).toContain('TEST');
    expect(symbols).not.toContain('PENNY');
  });

  test('exclude_penny_stocks=false includes sub-$5 candidates that qualify', () => {
    const penny = {
      ...baseCandidate,
      symbol: 'PENNY',
      last_price: 0.50,
      catalysts: [{ type: 'earnings', label: 'Earnings', strength: 60 }],
      indicators: {
        ...baseCandidate.indicators,
        last_price: 0.50,
        liquidity: { liquidity_rating: 'moderate', spread_rating: 'unknown' }
      }
    };
    const results = scanCandidates([penny], { excludePennyStocks: false, minScore: 0 });
    // With excludePennyStocks=false, the penny stock should appear in results
    // (it qualifies via gap_and_catalyst setup with the earnings catalyst)
    expect(results.some((r) => r.symbol === 'PENNY')).toBe(true);
  });

  test('penny stock with strong catalyst gets SPECULATIVE label', () => {
    const pennyWithCatalyst = {
      ...baseCandidate,
      symbol: 'CATLY',
      last_price: 2.00,
      catalysts: [{ type: 'halt', label: 'Halt', strength: 70 }],
      indicators: {
        ...baseCandidate.indicators,
        last_price: 2.00,
        liquidity: { liquidity_rating: 'moderate', spread_rating: 'unknown' }
      }
    };
    const results = scanCandidates([pennyWithCatalyst], { excludePennyStocks: true, minScore: 0 });
    const catly = results.find((r) => r.symbol === 'CATLY');
    expect(catly).toBeDefined();
    expect(catly.classification).toBe('SPECULATIVE');
    expect(catly.penny_exception).toBe(true);
  });
});

describe('scanner RVOL propagation', () => {
  test('real rvol from indicators propagates into result', () => {
    const candidate = {
      symbol: 'RVOL',
      last_price: 20,
      change_percent: 8,
      gap_pct: 6,
      catalysts: [],
      indicators: {
        last_price: 20,
        gap_pct: 6,
        change_percent: 8,
        rvol: 3.5,
        rvol_status: 'CALCULATED',
        rvol_method: 'daily_volume_ratio',
        volume: 5_000_000,
        liquidity: { liquidity_rating: 'high', spread_rating: 'unknown' },
        trend_regime: 'insufficient_data'
      }
    };
    const results = scanCandidates([candidate], { minScore: 0 });
    const r = results.find((x) => x.symbol === 'RVOL');
    expect(r).toBeDefined();
    expect(r.rvol).toBe(3.5);
    expect(r.rvol_status).toBe('CALCULATED');
    expect(r.rvol_method).toBe('daily_volume_ratio');
  });

  test('null rvol stays null in result, not 0', () => {
    const candidate = {
      symbol: 'NORVOL',
      last_price: 20,
      change_percent: 8,
      gap_pct: 6,
      catalysts: [],
      indicators: {
        last_price: 20,
        gap_pct: 6,
        change_percent: 8,
        rvol: null,
        volume: 5_000_000,
        liquidity: { liquidity_rating: 'high', spread_rating: 'unknown' },
        trend_regime: 'insufficient_data'
      }
    };
    const results = scanCandidates([candidate], { minScore: 0 });
    const r = results.find((x) => x.symbol === 'NORVOL');
    expect(r).toBeDefined();
    expect(r.rvol).toBeNull();
    expect(r.rvol_status).toBe('UNKNOWN');
  });
});

describe('price preset $5-$20 isolation (regression)', () => {
  test('$5-$20 preset filters out sub-$5 and over-$20', () => {
    const cands = [
      { last_price: 3, rvol: null },
      { last_price: 12, rvol: null },
      { last_price: 50, rvol: null }
    ];
    const preset = PRICE_PRESETS.find((p) => p.id === '5_20');
    const out = applyDiscoveryFilters(cands, preset);
    expect(out.map((c) => c.last_price)).toEqual([12]);
  });
});

describe('MCP no live-order tool (regression)', () => {
  test('no live-order tool registered', () => {
    const mcp = require('../../src/services/mcp/teejarahMcpServer');
    expect(mcp.isLiveOrderToolRegistered()).toBe(false);
  });
});

describe('LIVE trading flags remain false (regression)', () => {
  test('ENABLE_LIVE_TRADING is not set or false', () => {
    const v = process.env.ENABLE_LIVE_TRADING;
    expect(v === undefined || v === 'false' || v === '').toBe(true);
  });
});
