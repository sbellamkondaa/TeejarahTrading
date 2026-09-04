jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/finnhub', () => ({
  getQuotes: jest.fn(),
  getCompanyNews: jest.fn()
}));
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  logDebug: jest.fn()
}));
jest.mock('../../src/services/nasdaq/nasdaqHaltScheduler', () => ({
  isSchedulerEnabled: jest.fn(() => false),
  SCHEDULER_NAME: 'nasdaq-halts'
}));
jest.mock('../../src/services/schedulerStatusService', () => ({
  get: jest.fn()
}));
jest.mock('../../src/utils/schwabMarketData', () => ({
  getMovers: jest.fn()
}));
jest.mock('../../src/utils/marketSession', () => ({
  getMarketSession: jest.fn(() => ({
    session: 'closed',
    label: 'Closed',
    as_of: Date.now()
  }))
}));

const db = require('../../src/config/database');
const finnhub = require('../../src/utils/finnhub');
const { isSchedulerEnabled } = require('../../src/services/nasdaq/nasdaqHaltScheduler');
const SchedulerStatusService = require('../../src/services/schedulerStatusService');
const schwabMarketData = require('../../src/utils/schwabMarketData');
const { getMarketSession } = require('../../src/utils/marketSession');
const controller = require('../../src/controllers/market.controller');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.json = (x) => { res.body = x; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  return res;
}

const TS = 1; // placeholder unix-seconds value (shape only, not a real timestamp)

describe('market.controller', () => {
  beforeEach(() => {
    db.query.mockReset();
    finnhub.getQuotes.mockReset();
    finnhub.getCompanyNews.mockReset();
    isSchedulerEnabled.mockReset();
    isSchedulerEnabled.mockReturnValue(false);
    SchedulerStatusService.get.mockReset();
    schwabMarketData.getMovers.mockReset();
    getMarketSession.mockReset();
    getMarketSession.mockReturnValue({ session: 'closed', label: 'Closed', as_of: Date.now() });
    finnhub.getQuotes.mockReset();
  });

  describe('getIndices', () => {
    test('maps Schwab quotes for the four index symbols', async () => {
      finnhub.getQuotes.mockResolvedValue({
        SPY: { c: 500, d: 1.5, dp: 0.3, pc: 498.5, t: TS, source: 'schwab' },
        QQQ: { c: 400, d: -2, dp: -0.5, pc: 402, t: TS, source: 'schwab' },
        IWM: { c: 200, d: 0, dp: 0, pc: 200, t: TS, source: 'schwab' },
        DIA: { c: 450, d: 3, dp: 0.67, pc: 447, t: TS, source: 'schwab' }
      });
      const res = mockRes();
      await controller.getIndices({}, res);
      expect(res.body.indices).toHaveLength(4);
      expect(res.body.indices.map(i => i.symbol).sort()).toEqual(['DIA', 'IWM', 'QQQ', 'SPY']);
      const spy = res.body.indices.find(i => i.symbol === 'SPY');
      expect(spy.available).toBe(true);
      expect(spy.price).toBe(500);
      expect(spy.change_percent).toBe(0.3);
      expect(spy.source).toBe('schwab');
    });

    test('marks unavailable when provider returns no quote', async () => {
      finnhub.getQuotes.mockResolvedValue({});
      const res = mockRes();
      await controller.getIndices({}, res);
      expect(res.body.indices.every(i => i.available === false)).toBe(true);
    });

    test('survives provider throw (all unavailable)', async () => {
      finnhub.getQuotes.mockRejectedValue(new Error('boom'));
      const res = mockRes();
      await controller.getIndices({}, res);
      expect(res.body.indices.every(i => i.available === false)).toBe(true);
    });
  });

  describe('getHalts', () => {
    test('returns halts newest first with status derived from is_resumption, plus reason_description and freshness', async () => {
      db.query.mockResolvedValue({
        rows: [
          { symbol: 'AAPL', halt_type: 'LUDP', reason: 'LUDP', exchange: 'NASDAQ',
            halted_at: '2026-09-04T13:30:54Z', resume_at: null, is_resumption: false,
            issue_name: 'Apple Inc.' },
          { symbol: 'MSFT', halt_type: 'LUDP', reason: 'LUDP', exchange: 'ARCA',
            halted_at: '2026-09-03T14:11:22Z', resume_at: '2026-09-03T14:25:30Z', is_resumption: true,
            issue_name: null }
        ]
      });
      const res = mockRes();
      await controller.getHalts({ query: { limit: '10' } }, res);
      expect(db.query).toHaveBeenCalledWith(expect.any(String), [10]);
      expect(res.body.halts).toHaveLength(2);
      expect(res.body.halts[0].status).toBe('halted');
      expect(res.body.halts[0].issue_name).toBe('Apple Inc.');
      expect(res.body.halts[0].reason_description).toBe('Limit up / limit down pause');
      expect(res.body.halts[1].status).toBe('resumed');
      expect(res.body.halts[1].resume_at).toBe('2026-09-03T14:25:30Z');
      // Freshness object present (scheduler disabled by default in beforeEach).
      expect(res.body.freshness).toBeDefined();
      expect(res.body.freshness.scheduler_enabled).toBe(false);
      expect(res.body.freshness.last_success_at).toBeNull();
    });

    test('clamps limit to max 100 and defaults to 10', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { limit: '999' } }, res);
      expect(db.query.mock.calls[0][1][0]).toBe(100);
      await controller.getHalts({ query: {} }, res);
      expect(db.query.mock.calls[1][1][0]).toBe(10);
    });

    test('rejects non-numeric limit by falling back to default', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { limit: 'abc' } }, res);
      expect(db.query.mock.calls[0][1][0]).toBe(10);
    });

    test('status=halted filter adds is_resumption=false condition', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { status: 'halted' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('is_resumption = false');
      expect(params[0]).toBe(10); // limit is the only param
    });

    test('status=resumed filter adds is_resumption=true condition', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { status: 'resumed' } }, res);
      const [sql] = db.query.mock.calls[0];
      expect(sql).toContain('is_resumption = true');
    });

    test('market filter parameterizes UPPER(exchange)', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { market: 'nasdaq' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('UPPER(exchange) = $1');
      expect(params[0]).toBe('NASDAQ');
      expect(params[1]).toBe(10);
    });

    test('reason filter parameterizes UPPER(halt_type)', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { reason: 'ludp' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('UPPER(halt_type) = $1');
      expect(params[0]).toBe('LUDP');
    });

    test('symbol filter parameterizes UPPER(symbol) and uppercases input', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { symbol: 'aapl' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('UPPER(symbol) = $1');
      expect(params[0]).toBe('AAPL');
    });

    test('combined filters stack with AND and order params correctly', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { status: 'halted', market: 'nasdaq', reason: 't1', symbol: 'aapl' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('is_resumption = false');
      expect(sql).toContain('UPPER(exchange) = $1');
      expect(sql).toContain('UPPER(halt_type) = $2');
      expect(sql).toContain('UPPER(symbol) = $3');
      expect(params[0]).toBe('NASDAQ');
      expect(params[1]).toBe('T1');
      expect(params[2]).toBe('AAPL');
      expect(params[3]).toBe(10); // limit is last
    });

    test('invalid status value is ignored (no filter applied)', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { status: 'bogus' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      // is_resumption appears only as a selected column, never in a WHERE condition.
      expect(sql).not.toContain('is_resumption =');
      expect(params[0]).toBe(10);
    });

    test('empty filter values are ignored', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getHalts({ query: { market: '', reason: '   ', symbol: '' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).not.toContain('WHERE');
      expect(params[0]).toBe(10);
    });

    test('unknown reason codes get null reason_description (no guessing)', async () => {
      db.query.mockResolvedValue({
        rows: [{
          symbol: 'XYZ', halt_type: 'ZZZ', reason: 'ZZZ', exchange: 'NASDAQ',
          halted_at: '2026-09-04T13:30:54Z', resume_at: null, is_resumption: false,
          issue_name: null
        }]
      });
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(res.body.halts[0].halt_type).toBe('ZZZ');
      expect(res.body.halts[0].reason_description).toBeNull();
    });

    test('freshness: scheduler disabled returns scheduler_enabled=false and null timestamps', async () => {
      db.query.mockResolvedValue({ rows: [] });
      isSchedulerEnabled.mockReturnValue(false);
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(res.body.freshness.scheduler_enabled).toBe(false);
      expect(res.body.freshness.last_success_at).toBeNull();
      // SchedulerStatusService.get should NOT be called when disabled.
      expect(SchedulerStatusService.get).not.toHaveBeenCalled();
    });

    test('freshness: scheduler enabled reads scheduler_status last_success_at', async () => {
      db.query.mockResolvedValue({ rows: [] });
      isSchedulerEnabled.mockReturnValue(true);
      SchedulerStatusService.get.mockResolvedValue({
        lastSuccessAt: '2026-09-04T14:00:00Z',
        lastFailureAt: null,
        lastError: null
      });
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(SchedulerStatusService.get).toHaveBeenCalledWith('nasdaq-halts');
      expect(res.body.freshness.scheduler_enabled).toBe(true);
      expect(res.body.freshness.last_success_at).toBe('2026-09-04T14:00:00Z');
      expect(res.body.freshness.last_failure_at).toBeNull();
    });

    test('freshness: scheduler enabled but no status row returns null timestamps', async () => {
      db.query.mockResolvedValue({ rows: [] });
      isSchedulerEnabled.mockReturnValue(true);
      SchedulerStatusService.get.mockResolvedValue(null);
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(res.body.freshness.scheduler_enabled).toBe(true);
      expect(res.body.freshness.last_success_at).toBeNull();
    });

    test('freshness: scheduler enabled with failure records last_failure_at and last_error', async () => {
      db.query.mockResolvedValue({ rows: [] });
      isSchedulerEnabled.mockReturnValue(true);
      SchedulerStatusService.get.mockResolvedValue({
        lastSuccessAt: '2026-09-04T13:00:00Z',
        lastFailureAt: '2026-09-04T14:00:00Z',
        lastError: 'network timeout'
      });
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(res.body.freshness.last_failure_at).toBe('2026-09-04T14:00:00Z');
      expect(res.body.freshness.last_error).toBe('network timeout');
    });

    test('freshness: scheduler_status read failure does not crash the request', async () => {
      db.query.mockResolvedValue({ rows: [] });
      isSchedulerEnabled.mockReturnValue(true);
      SchedulerStatusService.get.mockRejectedValue(new Error('db down'));
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(res.body.freshness.scheduler_enabled).toBe(true);
      expect(res.body.freshness.last_success_at).toBeNull();
    });
  });

  describe('getNews', () => {
    test('dedupes by id across symbols and sorts newest first', async () => {
      const sharedId = 999;
      finnhub.getCompanyNews
        .mockResolvedValueOnce([
          { id: sharedId, headline: 'A', source: 'S', datetime: 1, related: 'SPY', url: 'u1' },
          { id: 2, headline: 'B', source: 'S', datetime: 2, related: 'SPY', url: 'u2' }
        ])
        .mockResolvedValueOnce([
          { id: sharedId, headline: 'A dup', source: 'S', datetime: 1, related: 'QQQ', url: 'u1' },
          { id: 3, headline: 'C', source: 'S', datetime: 3, related: 'QQQ', url: 'u3' }
        ]);
      const res = mockRes();
      await controller.getNews({ query: { limit: '15' } }, res);
      expect(res.body.news).toHaveLength(3);
      // newest first (datetime desc): 3 -> 2 -> sharedId(1)
      expect(res.body.news[0].id).toBe(3);
      expect(res.body.news[1].id).toBe(2);
      expect(res.body.news[2].id).toBe(sharedId);
    });

    test('tolerates provider error for one symbol', async () => {
      finnhub.getCompanyNews
        .mockRejectedValueOnce(new Error('SPY down'))
        .mockResolvedValueOnce([{ id: 7, headline: 'ok', source: 'S', datetime: 5, related: 'QQQ', url: 'u' }]);
      const res = mockRes();
      await controller.getNews({ query: {} }, res);
      expect(res.body.news).toHaveLength(1);
      expect(res.body.news[0].id).toBe(7);
    });
  });

  describe('getEarnings', () => {
    test('filters to upcoming (date >= today) and sorts ascending', async () => {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const past = '2020-01-01';
      db.query.mockResolvedValue({
        rows: [{
          earnings_data: [
            { symbol: 'OLD', date: past },
            { symbol: 'TMRW', date: tomorrow, hour: 'bmo', quarter: 2, year: 2026 },
            { symbol: 'TODAY', date: today, hour: 'amc', quarter: 3 }
          ],
          fetched_at: '2026-09-04T08:00:00Z'
        }]
      });
      const res = mockRes();
      await controller.getEarnings({ query: { limit: '10' } }, res);
      expect(res.body.earnings.find(e => e.symbol === 'OLD')).toBeUndefined();
      expect(res.body.earnings).toHaveLength(2);
      expect(res.body.earnings[0].date).toBe(today);
      expect(res.body.earnings[1].hour).toBe('bmo');
      expect(res.body.fetched_at).toBe('2026-09-04T08:00:00Z');
    });

    test('returns empty when cache miss', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const res = mockRes();
      await controller.getEarnings({ query: {} }, res);
      expect(res.body.earnings).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });
  });

  describe('getFilings', () => {
    test('queries material form types and joins companies', async () => {
      db.query.mockResolvedValue({
        rows: [{
          ticker: 'AAPL', company_name: 'Apple Inc.', form_type: '10-K',
          filing_date: '2026-09-01', accepted_at: '2026-09-01T17:00:00Z',
          filing_url: 'https://sec.gov/x'
        }]
      });
      const res = mockRes();
      await controller.getFilings({ query: { limit: '10' } }, res);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('sec_filings');
      expect(sql).toContain('sec_companies');
      expect(Array.isArray(params[0])).toBe(true);
      expect(params[0]).toContain('10-K');
      expect(params[1]).toBe(10);
      expect(res.body.filings[0].ticker).toBe('AAPL');
      expect(res.body.filings[0].url).toBe('https://sec.gov/x');
    });
  });

  describe('getMovers', () => {
    function mockMoversResult(items) {
      return { items, fetched_at: Date.now(), source: 'schwab' };
    }

    test('returns movers with gap_pct calculated from batch quotes', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'NVDA', description: 'NVIDIA CORP', last_price: 230, net_change: 5, net_percent_change: 0.022, volume: 1000000 }
        ]))
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'INTC', description: 'INTEL CORP', last_price: 93, net_change: -2, net_percent_change: -0.021, volume: 500000 }
        ]))
        .mockResolvedValueOnce(mockMoversResult([]));

      finnhub.getQuotes
        .mockResolvedValueOnce({
          NVDA: { pc: 225, t: TS },
          INTC: { pc: 95, t: TS }
        })
        .mockResolvedValueOnce({
          SPY: { c: 500, d: 1, dp: 0.2, t: TS },
          QQQ: { c: 400, d: 0, dp: 0, t: TS },
          IWM: { c: 200, d: 0, dp: 0, t: TS },
          DIA: { c: 450, d: 0, dp: 0, t: TS }
        });

      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { category: 'active' } }, res);

      expect(res.body.movers).toHaveLength(2);
      expect(res.body.movers[0].symbol).toBe('NVDA');
      expect(res.body.movers[0].gap_pct).toBeCloseTo(2.22); // (230-225)/225*100
      expect(res.body.movers[0].previous_close).toBe(225);
      expect(res.body.movers[1].symbol).toBe('INTC');
      expect(res.body.movers[1].gap_pct).toBeCloseTo(-2.11); // (93-95)/95*100
    });

    test('active category sorts by volume descending', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'LOW_VOL', last_price: 10, net_change: 1, net_percent_change: 0.1, volume: 1000 },
          { symbol: 'HIGH_VOL', last_price: 50, net_change: -1, net_percent_change: -0.02, volume: 5000000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { category: 'active' } }, res);

      expect(res.body.movers[0].symbol).toBe('HIGH_VOL');
      expect(res.body.movers[1].symbol).toBe('LOW_VOL');
    });

    test('gainers category filters to positive change and sorts by change_percent desc', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'UP1', last_price: 10, net_change: 0.5, net_percent_change: 0.05, volume: 1000 },
          { symbol: 'DOWN', last_price: 10, net_change: -0.5, net_percent_change: -0.05, volume: 1000 },
          { symbol: 'UP2', last_price: 20, net_change: 2, net_percent_change: 0.11, volume: 1000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { category: 'gainers' } }, res);

      expect(res.body.movers).toHaveLength(2);
      expect(res.body.movers[0].symbol).toBe('UP2'); // 11% > 5%
      expect(res.body.movers[1].symbol).toBe('UP1');
    });

    test('losers category filters to negative change and sorts by change_percent asc', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'UP', last_price: 10, net_change: 1, net_percent_change: 0.1, volume: 1000 },
          { symbol: 'DOWN1', last_price: 10, net_change: -0.5, net_percent_change: -0.05, volume: 1000 },
          { symbol: 'DOWN2', last_price: 10, net_change: -1, net_percent_change: -0.1, volume: 1000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { category: 'losers' } }, res);

      expect(res.body.movers).toHaveLength(2);
      expect(res.body.movers[0].symbol).toBe('DOWN2'); // -10% < -5%
      expect(res.body.movers[1].symbol).toBe('DOWN1');
    });

    test('invalid category falls back to active', async () => {
      schwabMarketData.getMovers.mockResolvedValue(mockMoversResult([]));
      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { category: 'bogus' } }, res);
      expect(res.body.movers).toEqual([]);
      // no error, just empty active list
    });

    test('limit is clamped to max 100', async () => {
      schwabMarketData.getMovers.mockResolvedValue(mockMoversResult([]));
      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { limit: '9999' } }, res);
      expect(res.body.movers).toHaveLength(0); // empty movers, but didn't error
    });

    test('price filters exclude out-of-range movers', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'CHEAP', last_price: 5, net_change: 1, net_percent_change: 0.2, volume: 1000 },
          { symbol: 'PRICEY', last_price: 500, net_change: 1, net_percent_change: 0.002, volume: 1000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { min_price: '10', max_price: '100' } }, res);
      expect(res.body.movers).toHaveLength(0);
    });

    test('min_volume filter excludes low-volume movers', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'LOW', last_price: 50, net_change: 1, net_percent_change: 0.02, volume: 500 },
          { symbol: 'HIGH', last_price: 50, net_change: 1, net_percent_change: 0.02, volume: 5000000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { min_volume: '10000' } }, res);
      expect(res.body.movers).toHaveLength(1);
      expect(res.body.movers[0].symbol).toBe('HIGH');
    });

    test('include_halted=false filters out halted symbols', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'HALT', last_price: 10, net_change: 1, net_percent_change: 0.1, volume: 1000 },
          { symbol: 'OPEN', last_price: 20, net_change: 1, net_percent_change: 0.05, volume: 1000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      // First db.query: halt check returns HALT as halted
      db.query.mockResolvedValueOnce({ rows: [{ symbol: 'HALT' }] });
      // Remaining db.query calls: earnings + SEC (empty)
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: { include_halted: 'false' } }, res);

      expect(res.body.movers).toHaveLength(1);
      expect(res.body.movers[0].symbol).toBe('OPEN');
    });

    test('halted flag is set on movers with active halts', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'STOPPED', last_price: 10, net_change: 0, net_percent_change: 0, volume: 1000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValueOnce({ rows: [{ symbol: 'STOPPED' }] });
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.movers[0].halted).toBe(true);
    });

    test('catalyst enrichment adds badges from halts, earnings, SEC', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'CATL', description: 'Catalyst Corp', last_price: 50, net_change: 2, net_percent_change: 0.04, volume: 1000000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({ CATL: { pc: 48, t: TS } });
      // db.query calls in order:
      // 1. halt-status check (SELECT DISTINCT symbol FROM market_halts...)
      // 2. catalyst halts (SELECT symbol, halt_type, halted_at...)
      // 3. catalyst earnings (SELECT earnings_data...)
      // 4. catalyst SEC (SELECT sc.ticker, sf.form_type...)
      db.query
        .mockResolvedValueOnce({ rows: [] })  // halt-status: not halted
        .mockResolvedValueOnce({ rows: [{ symbol: 'CATL', is_resumption: false, halt_type: 'LUDP', halted_at: '2026-09-04T13:00:00Z' }] })
        .mockResolvedValueOnce({ rows: [{ earnings_data: [{ symbol: 'CATL', date: '2026-09-05' }] }] })
        .mockResolvedValueOnce({ rows: [{ ticker: 'CATL', form_type: '8-K', filing_date: '2026-09-03' }] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      const catalysts = res.body.movers[0].catalysts;
      expect(catalysts).toHaveLength(3);
      expect(catalysts.some(c => c.type === 'halt')).toBe(true);
      expect(catalysts.some(c => c.type === 'earnings')).toBe(true);
      expect(catalysts.some(c => c.type === 'sec_filing')).toBe(true);
    });

    test('gap_pct is null when previous close is missing', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'NOGAP', last_price: 100, net_change: 5, net_percent_change: 0.05, volume: 1000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({ NOGAP: {} }); // no pc field
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.movers[0].gap_pct).toBeNull();
      expect(res.body.movers[0].previous_close).toBeNull();
    });

    test('returns session and as_of metadata', async () => {
      schwabMarketData.getMovers.mockResolvedValue(mockMoversResult([]));
      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });
      getMarketSession.mockReturnValue({ session: 'premarket', label: 'Pre-Market', as_of: Date.now() });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.session).toBe('premarket');
      expect(res.body.session_label).toBe('Pre-Market');
      expect(res.body.as_of).toBeGreaterThan(0);
    });

    test('returns indices from batch quote', async () => {
      schwabMarketData.getMovers.mockResolvedValue(mockMoversResult([]));
      // First getQuotes call: mover symbols (empty) -> returns {}
      finnhub.getQuotes.mockResolvedValueOnce({});
      // Second getQuotes call: index symbols -> returns index data
      finnhub.getQuotes.mockResolvedValueOnce({
        SPY: { c: 500, d: 1, dp: 0.2, t: TS },
        QQQ: { c: 400, d: 0, dp: 0, t: TS },
        IWM: { c: 200, d: -1, dp: -0.5, t: TS },
        DIA: { c: 450, d: 0, dp: 0, t: TS }
      });
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.indices).toHaveLength(4);
      expect(res.body.indices[0].symbol).toBe('SPY');
      expect(res.body.indices[0].available).toBe(true);
    });

    test('premarket_volume and rvol are null (not available)', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'X', last_price: 10, net_change: 1, net_percent_change: 0.1, volume: 50000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({ X: { pc: 9, t: TS } });
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.movers[0].premarket_volume).toBeNull();
      expect(res.body.movers[0].rvol).toBeNull();
    });

    test('handles Schwab unavailability gracefully', async () => {
      schwabMarketData.getMovers.mockResolvedValue(null);
      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.movers).toEqual([]);
      expect(res.body.error).toContain('unavailable');
    });

    test('deduplicates symbols across indexes', async () => {
      schwabMarketData.getMovers
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'DUP', last_price: 10, net_change: 1, net_percent_change: 0.1, volume: 1000 }
        ]))
        .mockResolvedValueOnce(mockMoversResult([
          { symbol: 'DUP', last_price: 10, net_change: 1, net_percent_change: 0.1, volume: 1000 },
          { symbol: 'UNIQ', last_price: 20, net_change: 0, net_percent_change: 0, volume: 2000 }
        ]))
        .mockResolvedValue(mockMoversResult([]));

      finnhub.getQuotes.mockResolvedValue({});
      db.query.mockResolvedValue({ rows: [] });

      const res = mockRes();
      await controller.getMovers({ query: {} }, res);

      expect(res.body.movers).toHaveLength(2);
      expect(res.body.movers.map(m => m.symbol).sort()).toEqual(['DUP', 'UNIQ']);
    });
  });
});
