jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  logDebug: jest.fn()
}));

const { parseNasdaqHaltsRss, hashPayload, ingestHaltEvent } = require('../../src/services/nasdaq/nasdaqClient');

const wrap = (inner) =>
  `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/rss/">
  <channel>
    <title>Nasdaq Trade Halts</title>
    <link>https://www.nasdaqtrader.com</link>
    <description>Trade Halt RSS Feed</description>
${inner}
  </channel>
</rss>`;

const marketItem = `
    <item>
      <title>Trade Halt: AAPL</title>
      <link>https://www.nasdaqtrader.com</link>
      <description>Halt for AAPL</description>
      <ndaq:IssueSymbol>AAPL</ndaq:IssueSymbol>
      <ndaq:IssueName>Apple Inc.   Common  Stock</ndaq:IssueName>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice>184.00</ndaq:PauseThresholdPrice>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
      <ndaq:HaltTime>09:30:54.916</ndaq:HaltTime>
    </item>`;

const mktItem = `
    <item>
      <title>Trade Halt: MSFT</title>
      <link>https://www.nasdaqtrader.com</link>
      <description>Resumption for MSFT</description>
      <ndaq:IssueSymbol>MSFT</ndaq:IssueSymbol>
      <ndaq:IssueName>Microsoft Corporation</ndaq:IssueName>
      <ndaq:Mkt>ARCA</ndaq:Mkt>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice>410.00</ndaq:PauseThresholdPrice>
      <ndaq:HaltDate>08/15/2026</ndaq:HaltDate>
      <ndaq:HaltTime>10:11:22</ndaq:HaltTime>
      <ndaq:ResumptionDate>08/15/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>10:25:00</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>10:25:30.000</ndaq:ResumptionTradeTime>
    </item>`;

describe('parseNasdaqHaltsRss', () => {
  test('A. current unresolved halt using <ndaq:Market>', () => {
    const events = parseNasdaqHaltsRss(wrap(marketItem));
    expect(events).toHaveLength(1);

    const e = events[0];
    expect(e.symbol).toBe('AAPL');
    expect(e.halt_type).toBe('LUDP');
    expect(e.reason).toBe('LUDP');
    expect(e.exchange).toBe('NASDAQ');
    expect(e.is_resumption).toBe(false);
    expect(e.resume_at).toBeNull();
    // Sept EDT = UTC-4
    expect(e.halted_at).toBe('2026-09-04T13:30:54Z');
    expect(e.raw.IssueName).toBe('Apple Inc. Common Stock');
    expect(e.raw.PauseThresholdPrice).toBe('184.00');
    expect(e.raw.HaltTime).toBe('09:30:54.916');
  });

  test('B. historical resumed halt using <ndaq:Mkt>', () => {
    const events = parseNasdaqHaltsRss(wrap(mktItem));
    expect(events).toHaveLength(1);

    const e = events[0];
    expect(e.symbol).toBe('MSFT');
    expect(e.exchange).toBe('ARCA');
    expect(e.halt_type).toBe('LUDP');
    expect(e.is_resumption).toBe(true);
    expect(e.halted_at).toBe('2026-08-15T14:11:22Z');
    // ResumptionDate + ResumptionTradeTime preferred over quote time
    expect(e.resume_at).toBe('2026-08-15T14:25:30Z');
    expect(e.raw.ResumptionQuoteTime).toBe('10:25:00');
    expect(e.raw.ResumptionTradeTime).toBe('10:25:30.000');
  });

  test('C. whitespace before fractional seconds normalizes safely', () => {
    const item = `
    <item>
      <ndaq:IssueSymbol>TSLA</ndaq:IssueSymbol>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>T1</ndaq:ReasonCode>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
      <ndaq:HaltTime>09:30:54                      .916</ndaq:HaltTime>
    </item>`;
    const events = parseNasdaqHaltsRss(wrap(item));
    expect(events).toHaveLength(1);
    expect(events[0].raw.HaltTime).toBe('09:30:54.916');
    expect(events[0].halted_at).toBe('2026-09-04T13:30:54Z');
  });

  test('D. missing resumption fields leave resume_at null', () => {
    const item = `
    <item>
      <ndaq:IssueSymbol>NVDA</ndaq:IssueSymbol>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
      <ndaq:HaltTime>14:00:00</ndaq:HaltTime>
    </item>`;
    const events = parseNasdaqHaltsRss(wrap(item));
    expect(events).toHaveLength(1);
    expect(events[0].resume_at).toBeNull();
    expect(events[0].is_resumption).toBe(false);
  });

  test('D2. resume_at ignores ResumptionQuoteTime when trade time absent (no guessing)', () => {
    const item = `
    <item>
      <ndaq:IssueSymbol>AMD</ndaq:IssueSymbol>
      <ndaq:Mkt>ARCA</ndaq:Mkt>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
      <ndaq:HaltTime>14:00:00</ndaq:HaltTime>
      <ndaq:ResumptionDate>09/04/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>14:30:00</ndaq:ResumptionQuoteTime>
    </item>`;
    const events = parseNasdaqHaltsRss(wrap(item));
    expect(events).toHaveLength(1);
    expect(events[0].resume_at).toBeNull();
  });

  test('E. malformed/incomplete items are skipped safely', () => {
    const items = `
    <item>
      <title>no fields</title>
      <description>empty</description>
    </item>
    <item>
      <ndaq:IssueSymbol>NOHALTDATE</ndaq:IssueSymbol>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
    </item>
    <item>
      <ndaq:IssueSymbol>NOHALTTIME</ndaq:IssueSymbol>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
    </item>
    <item>
      <ndaq:IssueSymbol>NOREASON</ndaq:IssueSymbol>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
      <ndaq:HaltTime>09:30:00</ndaq:HaltTime>
    </item>
    <item>
      <ndaq:IssueSymbol>0BAD</ndaq:IssueSymbol>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:HaltDate>09/04/2026</ndaq:HaltDate>
      <ndaq:HaltTime>09:30:00</ndaq:HaltTime>
    </item>`;
    const events = parseNasdaqHaltsRss(wrap(items));
    expect(events).toHaveLength(0);
  });

  test('returns [] for non-XML / empty input', () => {
    expect(parseNasdaqHaltsRss('')).toEqual([]);
    expect(parseNasdaqHaltsRss(null)).toEqual([]);
    expect(parseNasdaqHaltsRss('<not xml')).toEqual([]);
  });

  test('source_hash is deterministic for identical halt payloads', () => {
    const a = hashPayload({ symbol: 'AAPL', halt_type: 'LUDP', halted_at: '2026-09-04T13:30:54Z', exchange: 'NASDAQ' });
    const b = hashPayload({ symbol: 'AAPL', halt_type: 'LUDP', halted_at: '2026-09-04T13:30:54Z', exchange: 'NASDAQ' });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('ingestHaltEvent', () => {
  const db = require('../../src/config/database');

  afterEach(() => db.query.mockReset());

  const halt = {
    symbol: 'AAPL',
    halt_type: 'LUDP',
    reason: 'LUDP',
    exchange: 'NASDAQ',
    halted_at: '2026-09-04T13:30:54Z',
    resume_at: null,
    is_resumption: false,
    raw: { IssueSymbol: 'AAPL' }
  };

  test('returns inserted=true when xmax=0 (new row)', async () => {
    db.query.mockResolvedValue({ rows: [{ inserted: true }] });
    const result = await ingestHaltEvent(halt);
    expect(result.inserted).toBe(true);
    expect(result.sourceHash).toHaveLength(64);
  });

  test('returns inserted=false when xmax!=0 (conflict update)', async () => {
    db.query.mockResolvedValue({ rows: [{ inserted: false }] });
    const result = await ingestHaltEvent(halt);
    expect(result.inserted).toBe(false);
    expect(result.sourceHash).toHaveLength(64);
  });

  test('returns inserted=false when no rows returned', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const result = await ingestHaltEvent(halt);
    expect(result.inserted).toBe(false);
  });
});
