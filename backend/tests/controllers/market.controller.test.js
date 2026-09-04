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

const db = require('../../src/config/database');
const finnhub = require('../../src/utils/finnhub');
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
    test('returns halts newest first with status derived from is_resumption, plus reason_description and last_updated', async () => {
      db.query.mockResolvedValue({
        rows: [
          { symbol: 'AAPL', halt_type: 'LUDP', reason: 'LUDP', exchange: 'NASDAQ',
            halted_at: '2026-09-04T13:30:54Z', resume_at: null, is_resumption: false,
            issue_name: 'Apple Inc.', created_at: '2026-09-04T13:31:00Z' },
          { symbol: 'MSFT', halt_type: 'LUDP', reason: 'LUDP', exchange: 'ARCA',
            halted_at: '2026-09-03T14:11:22Z', resume_at: '2026-09-03T14:25:30Z', is_resumption: true,
            issue_name: null, created_at: '2026-09-03T14:12:00Z' }
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
      expect(res.body.last_updated).toBe('2026-09-04T13:31:00Z');
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
      expect(sql).not.toContain('is_resumption');
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
          issue_name: null, created_at: '2026-09-04T13:31:00Z'
        }]
      });
      const res = mockRes();
      await controller.getHalts({ query: {} }, res);
      expect(res.body.halts[0].halt_type).toBe('ZZZ');
      expect(res.body.halts[0].reason_description).toBeNull();
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
});
