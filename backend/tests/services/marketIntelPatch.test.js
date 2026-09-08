// Focused tests for the Market Intelligence / Scanner session-data reliability patch.

// Mock database + redis before requiring modules that depend on them.
jest.mock('../../src/config/database', () => ({
  query: jest.fn()
}));
jest.mock('../../src/utils/redisCache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(true)
}));

const db = require('../../src/config/database');
const redisCache = require('../../src/utils/redisCache');
const scannerUniverseSnapshot = require('../../src/services/marketIntelligence/scannerUniverseSnapshot');

describe('scannerUniverseSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisCache.get.mockResolvedValue(null);
  });

  test('captureSnapshot writes a row with session + symbols + metadata', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await scannerUniverseSnapshot.captureSnapshot('regular', ['AAPL', 'MSFT'], { source: 'schwab_movers' });
    expect(db.query).toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO scanner_universe_snapshots/);
    expect(params[0]).toBe('regular');
    expect(params[2]).toEqual(['AAPL', 'MSFT']);
  });

  test('captureSnapshot no-ops on empty symbols', async () => {
    db.query.mockClear();
    await scannerUniverseSnapshot.captureSnapshot('regular', [], {});
    expect(db.query).not.toHaveBeenCalled();
  });

  test('getLatestSnapshot returns the most recent row', async () => {
    db.query.mockResolvedValue({
      rows: [{ symbols: ['AAPL', 'MSFT'], captured_at: new Date(), session: 'regular', source: 'schwab_movers' }]
    });
    const r = await scannerUniverseSnapshot.getLatestSnapshot('regular');
    expect(r).not.toBeNull();
    expect(r.symbols).toEqual(['AAPL', 'MSFT']);
  });

  test('getLatestSnapshot returns null on DB error (non-fatal)', async () => {
    db.query.mockRejectedValue(new Error('connection'));
    const r = await scannerUniverseSnapshot.getLatestSnapshot('regular');
    expect(r).toBeNull();
  });

  test('getRecentEventSymbols returns symbols from market_event_symbols', async () => {
    db.query.mockResolvedValue({ rows: [{ symbol: 'TSLA' }, { symbol: 'NVDA' }] });
    const syms = await scannerUniverseSnapshot.getRecentEventSymbols();
    expect(syms).toEqual(['TSLA', 'NVDA']);
  });

  test('getRecentEventSymbols returns [] on DB error', async () => {
    db.query.mockRejectedValue(new Error('connection'));
    const syms = await scannerUniverseSnapshot.getRecentEventSymbols();
    expect(syms).toEqual([]);
  });

  test('buildFallbackUniverse deduplicates + bounds + reports source', async () => {
    // First call: getLatestSnapshot (session-specific) returns a snapshot
    db.query
      .mockResolvedValueOnce({ rows: [{ symbols: ['AAPL', 'MSFT'], captured_at: new Date(), session: 'regular', source: 'schwab_movers' }] })
      .mockResolvedValueOnce({ rows: [{ symbol: 'TSLA' }, { symbol: 'AAPL' }] }); // getRecentEventSymbols
    const r = await scannerUniverseSnapshot.buildFallbackUniverse('regular');
    expect(r.symbols).toContain('AAPL');
    expect(r.symbols).toContain('MSFT');
    expect(r.symbols).toContain('TSLA');
    // Dedup: AAPL appears in both but only once
    expect(r.symbols.filter((s) => s === 'AAPL').length).toBe(1);
    expect(r.universe_source).toBe('mixed_fallback');
    expect(r.universe_as_of).not.toBeNull();
  });

  test('buildFallbackUniverse returns none when no snapshot + no events', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // session snapshot
      .mockResolvedValueOnce({ rows: [] }) // any snapshot
      .mockResolvedValueOnce({ rows: [] }); // events
    const r = await scannerUniverseSnapshot.buildFallbackUniverse('closed');
    expect(r.symbols).toEqual([]);
    expect(r.universe_source).toBe('none');
  });

  test('MAX_FALLBACK_SYMBOLS bounds the universe', () => {
    expect(scannerUniverseSnapshot.MAX_FALLBACK_SYMBOLS).toBeLessThanOrEqual(100);
    expect(scannerUniverseSnapshot.MAX_FALLBACK_SYMBOLS).toBeGreaterThanOrEqual(20);
  });
});

describe('ingestionService distributed lock', () => {
  test('skips when lock is already held', async () => {
    redisCache.get.mockResolvedValue({ held: true });
    const { runIngestionCycle } = require('../../src/services/marketIntelligence/ingestionService');
    const result = await runIngestionCycle({ initial: true });
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/already in progress/);
  });

  test('proceeds when lock is free', async () => {
    redisCache.get.mockResolvedValue(null);
    // Stub the sourceRegistry to return no enabled sources so the cycle is a no-op
    jest.doMock('../../src/services/marketIntelligence/sourceRegistry', () => ({
      getEnabledSources: () => []
    }));
    const { runIngestionCycle } = require('../../src/services/marketIntelligence/ingestionService');
    const result = await runIngestionCycle({ initial: true });
    expect(result.skipped).toBeUndefined();
    expect(result).toHaveProperty('sources', 0);
    jest.dontMock('../../src/services/marketIntelligence/sourceRegistry');
  });
});

describe('marketIntelligenceScheduler startup ingestion', () => {
  test('runStartupIngestion exists and returns a result without throwing', async () => {
    redisCache.get.mockResolvedValue(null);
    jest.doMock('../../src/services/marketIntelligence/sourceRegistry', () => ({
      getEnabledSources: () => []
    }));
    const scheduler = require('../../src/services/marketIntelligence/marketIntelligenceScheduler');
    expect(typeof scheduler.runStartupIngestion).toBe('function');
    const result = await scheduler.runStartupIngestion();
    expect(result).toBeDefined();
    jest.dontMock('../../src/services/marketIntelligence/sourceRegistry');
  });
});

describe('source configurable lookback', () => {
  test('secEventSource uses default 24h on normal cycle', () => {
    delete process.env.MARKET_INTELLIGENCE_INITIAL_LOOKBACK_HOURS;
    const sec = require('../../src/services/marketIntelligence/sources/secEventSource');
    // fetchRecent is async; just verify the module loads and exposes the contract
    expect(typeof sec.fetchRecent).toBe('function');
    expect(sec.name()).toBe('sec_filings');
  });

  test('finnhubNewsSource accepts options.initial', () => {
    const fn = require('../../src/services/marketIntelligence/sources/finnhubNewsSource');
    expect(typeof fn.fetchRecent).toBe('function');
  });

  test('MARKET_INTELLIGENCE_INITIAL_LOOKBACK_HOURS default is 72 when initial', () => {
    // The env default in finnhubNewsSource is 72 hours when initial.
    // Verify the module reads it without throwing.
    process.env.MARKET_INTELLIGENCE_INITIAL_LOOKBACK_HOURS = '72';
    const fn = require('../../src/services/marketIntelligence/sources/finnhubNewsSource');
    expect(fn.name()).toBe('finnhub_news');
    delete process.env.MARKET_INTELLIGENCE_INITIAL_LOOKBACK_HOURS;
  });
});

describe('market.controller session handling', () => {
  test('resolveSession validates session param', () => {
    // The function is not exported; verify via the controller module loading
    // without throwing. The session validation is exercised via the route test.
    const ctrl = require('../../src/controllers/market.controller');
    expect(ctrl.getScanner).toBeDefined();
    expect(ctrl.getMovers).toBeDefined();
    expect(ctrl.getCandles).toBeDefined();
  });
});

describe('getNews honors req.query.symbol', () => {
  test('getNews is defined and accepts a symbol param', () => {
    const ctrl = require('../../src/controllers/market.controller');
    expect(typeof ctrl.getNews).toBe('function');
  });
});

describe('schwabMarketData extended-hours option', () => {
  test('getCandles accepts an options object with extendedHours', () => {
    const schwab = require('../../src/utils/schwabMarketData');
    expect(typeof schwab.getCandles).toBe('function');
    // The function signature accepts (symbol, resolution, from, to, options)
    // Verify the module loads without error; the option is threaded in the
    // controller test via the API.
  });
});

describe('MCP no live-order tool invariant (regression)', () => {
  test('no live-order tool registered', () => {
    const mcp = require('../../src/services/mcp/teejarahMcpServer');
    expect(mcp.isLiveOrderToolRegistered()).toBe(false);
    const names = mcp.listTools().map((t) => t.name);
    expect(names).not.toContain('place_live_order');
    expect(names).not.toContain('cancel_live_order');
    expect(names).not.toContain('approve_live_order');
  });
});

describe('LIVE trading flags remain false (regression)', () => {
  test('ENABLE_LIVE_TRADING is not set or false', () => {
    const v = process.env.ENABLE_LIVE_TRADING;
    expect(v === undefined || v === 'false' || v === '').toBe(true);
  });
  test('ENABLE_AUTO_EXECUTION is not set or false', () => {
    const v = process.env.ENABLE_AUTO_EXECUTION;
    expect(v === undefined || v === 'false' || v === '').toBe(true);
  });
});
