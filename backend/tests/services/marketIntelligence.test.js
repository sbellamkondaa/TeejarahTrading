// Focused tests for Market Intelligence V2 core: normalization, classification,
// ranking, dedup-key derivation, and source registry isolation.

const {
  normalize,
  collectSymbols,
  toTicker,
  buildDedupKey
} = require('../../src/services/marketIntelligence/eventNormalizer');
const { classify, defaultMaterialityForType } = require('../../src/services/marketIntelligence/eventClassifier');
const { scoreEvent, categorize, CATEGORY } = require('../../src/services/marketIntelligence/eventRanker');
const { EVENT_TYPES, SOURCE_TIERS } = require('../../src/services/marketIntelligence/eventTypes');
const { scoreOpportunity, applyDiscoveryFilters, PRICE_PRESETS } = require('../../src/services/marketIntelligence/opportunityScore');

describe('eventNormalizer', () => {
  test('normalize requires source + source_event_id', () => {
    expect(normalize({ source: 'x' })).toBeNull();
    expect(normalize({ source_event_id: '1' })).toBeNull();
  });

  test('normalize maps finnhub datetime (seconds) to ISO', () => {
    const ts = Math.floor(Date.now() / 1000) - 3600; // unix seconds, 1h ago
    const r = normalize({ source: 'finnhub_news', source_event_id: '1', published_at: ts, headline: 'A' });
    expect(r.published_at).toBe(new Date(ts * 1000).toISOString());
    expect(r.dedup_key).toMatch(/^[a-f0-9]+$/);
  });

  test('normalize handles ms timestamps', () => {
    const r = normalize({ source: 'x', source_event_id: '2', published_at: 1700000000000 });
    expect(r.published_at).toBe(new Date(1700000000000).toISOString());
  });

  test('collectSymbols dedups and uppercases, drops index tokens', () => {
    const syms = collectSymbols({ symbols: ['aapl', 'spy', '$VIX'], related: ['MSFT', 'aapl'] });
    expect(syms).toEqual(expect.arrayContaining(['AAPL', 'SPY', 'MSFT']));
    expect(syms).not.toContain('VIX');
  });

  test('toTicker rejects invalid and keeps tradeable ETFs', () => {
    expect(toTicker('aapl')).toBe('AAPL');
    expect(toTicker('SPY')).toBe('SPY');
    expect(toTicker('$$VIX')).toBeNull();
    expect(toTicker('')).toBeNull();
  });

  test('buildDedupKey is stable across reorderings of symbols', () => {
    const a = buildDedupKey({ source: 'x', source_event_id: '1', headline: 'Big news' }, ['AAPL', 'MSFT']);
    const b = buildDedupKey({ source: 'x', source_event_id: '2', headline: 'Big news' }, ['MSFT', 'AAPL']);
    expect(a).toBe(b);
  });

  test('buildDedupKey falls back when headline/symbols absent', () => {
    const k = buildDedupKey({ source: 'x', source_event_id: '1' }, []);
    expect(k).toMatch(/^[a-f0-9]+$/);
  });
});

describe('eventClassifier', () => {
  test('SEC offering form -> OFFERING/ATM/S3/424B5 classification', () => {
    expect(classify({ sec_form_type: 'S-1', headline: '' }).event_type).toBe(EVENT_TYPES.OFFERING);
    expect(classify({ sec_form_type: 'S-3', headline: '' }).event_type).toBe(EVENT_TYPES.S3);
    expect(classify({ sec_form_type: '424B5', headline: '' }).event_type).toBe(EVENT_TYPES.F424B5);
    expect(classify({ sec_form_type: '424B5', headline: 'at-the-market offering' }).event_type).toBe(EVENT_TYPES.ATM);
  });

  test('Form 4 -> INSIDER', () => {
    expect(classify({ sec_form_type: '4', headline: '' }).event_type).toBe(EVENT_TYPES.INSIDER);
  });

  test('material forms -> SEC_MATERIAL', () => {
    expect(classify({ sec_form_type: '8-K', headline: '' }).event_type).toBe(EVENT_TYPES.SEC_MATERIAL);
    expect(classify({ sec_form_type: '10-K', headline: '' }).event_type).toBe(EVENT_TYPES.SEC_MATERIAL);
  });

  test('halt -> HALT / RESUMPTION', () => {
    expect(classify({ halt_type: 'LUDP', is_resumption: false }).event_type).toBe(EVENT_TYPES.HALT);
    expect(classify({ halt_type: 'LUDP', is_resumption: true }).event_type).toBe(EVENT_TYPES.RESUMPTION);
  });

  test('headline keyword rules (FDA, earnings, fed, analyst upgrade)', () => {
    expect(classify({ headline: 'FDA approves phase 3 drug' }).event_type).toBe(EVENT_TYPES.FDA);
    expect(classify({ headline: 'Q3 earnings beat' }).event_type).toBe(EVENT_TYPES.EARNINGS);
    expect(classify({ headline: 'Fed cuts rates' }).event_type).toBe(EVENT_TYPES.MACRO_FED);
    expect(classify({ headline: 'Analyst upgrade to buy' }).event_type).toBe(EVENT_TYPES.ANALYST_UPGRADE);
    expect(classify({ headline: 'Price target raised' }).event_type).toBe(EVENT_TYPES.PRICE_TARGET);
  });

  test('default -> GENERAL_NEWS materiality 5', () => {
    const r = classify({ headline: 'Random update' });
    expect(r.event_type).toBe(EVENT_TYPES.GENERAL_NEWS);
    expect(r.materiality).toBe(5);
  });

  test('opinion keyword -> OPINION low materiality', () => {
    expect(classify({ headline: 'Opinion: markets may fall' }).event_type).toBe(EVENT_TYPES.OPINION);
  });
});

describe('eventRanker', () => {
  test('primary recent verified event scores high', () => {
    const event = {
      materiality: 9, source_tier: SOURCE_TIERS.PRIMARY, primary_source: true,
      verification_state: 'VERIFIED', published_at: new Date(Date.now() - 1800000).toISOString()
    };
    const score = scoreEvent(event);
    expect(score).toBeGreaterThan(70);
  });

  test('unverified old social event scores low', () => {
    const event = {
      materiality: 3, source_tier: SOURCE_TIERS.SOCIAL_UNVERIFIED, primary_source: false,
      verification_state: 'UNVERIFIED', published_at: new Date(Date.now() - 8 * 86400000).toISOString()
    };
    expect(scoreEvent(event)).toBeLessThan(40);
  });

  test('categorize buckets BREAKING vs CATALYST vs MARKET_MACRO vs OPINION_LOW', () => {
    const breaking = { event_type: EVENT_TYPES.FDA, published_at: new Date(Date.now() - 1800000).toISOString() };
    expect(categorize(breaking)).toBe(CATEGORY.BREAKING);
    const catalyst = { event_type: EVENT_TYPES.EARNINGS, published_at: new Date(Date.now() - 5 * 3600000).toISOString() };
    expect(categorize(catalyst)).toBe(CATEGORY.CATALYST);
    expect(categorize({ event_type: EVENT_TYPES.MACRO_FED, published_at: new Date().toISOString() })).toBe(CATEGORY.MARKET_MACRO);
    expect(categorize({ event_type: EVENT_TYPES.OPINION, published_at: new Date().toISOString() })).toBe(CATEGORY.OPINION_LOW);
  });

  test('scanner_symbols filter yields SCANNER_RELATED', () => {
    const e = { event_type: EVENT_TYPES.GENERAL_NEWS, published_at: new Date().toISOString(), symbols: ['AAPL'] };
    const scannerSymbols = new Set(['AAPL']);
    expect(categorize(e, { scannerSymbols })).toBe(CATEGORY.SCANNER_RELATED);
  });
});

describe('opportunityScore', () => {
  test('scoreOpportunity is explainable and bounded 0-100', () => {
    const r = scoreOpportunity({
      gap_pct: 8, rvol: 5, volume: 10_000_000, liquidity_rating: 'high',
      catalyst_strength: 80, best_setup: { score: 70 }, relative_strength: 8
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.factors).toHaveProperty('gap_pct');
    expect(r.factors).toHaveProperty('rvol');
    expect(r.factors).toHaveProperty('catalyst_strength');
  });

  test('missing values do not fabricate score (unknowns flagged)', () => {
    const r = scoreOpportunity({ gap_pct: null, rvol: null, volume: null });
    expect(r.score).toBeLessThan(40);
    expect(r.factors.gap_pct_unknown).toBe(true);
    expect(r.factors.rvol_unknown).toBe(true);
  });

  test('applyDiscoveryFilters price range filters $5-$20', () => {
    const cands = [
      { last_price: 4 }, { last_price: 7 }, { last_price: 15 }, { last_price: 50 }
    ];
    const out = applyDiscoveryFilters(cands, { min_price: 5, max_price: 20 });
    expect(out.map((c) => c.last_price)).toEqual([7, 15]);
  });

  test('$5-$20 preset isolates small/mid-cap movers (no mega-cap bias)', () => {
    const preset = PRICE_PRESETS.find((p) => p.id === '5_20');
    expect(preset.min_price).toBe(5);
    expect(preset.max_price).toBe(20);
    const cands = [
      { last_price: 3, volume: 100 },      // penny
      { last_price: 12, volume: 1000 },     // $5-$20
      { last_price: 400, volume: 10000 }   // mega-cap
    ];
    const out = applyDiscoveryFilters(cands, preset);
    expect(out.map((c) => c.last_price)).toEqual([12]);
  });

  test('min_rvol filter excludes below threshold', () => {
    const out = applyDiscoveryFilters([{ rvol: 1.5 }, { rvol: 3 }], { min_rvol: 2 });
    expect(out.map((c) => c.rvol)).toEqual([3]);
  });

  test('min_gap filter on absolute gap', () => {
    const out = applyDiscoveryFilters([{ gap_pct: 2 }, { gap_pct: -5 }], { min_gap: 3 });
    expect(out.map((c) => c.gap_pct)).toEqual([-5]);
  });
});
