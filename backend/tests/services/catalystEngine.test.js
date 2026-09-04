const { scoreCatalystStrength, normalizeCatalyst, CATALYST_TYPES, getStrongestCatalyst } = require('../../src/services/catalystEngine');

describe('catalystEngine', () => {

  describe('scoreCatalystStrength', () => {
    test('fresh SEC filing with price confirmation scores high', () => {
      const score = scoreCatalystStrength({
        event_type: CATALYST_TYPES.OFFERING_FINANCING,
        source: 'sec_filing',
        event_time: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago
        materiality: 8,
        has_price_confirmation: true
      });
      expect(score).toBeGreaterThanOrEqual(85);
    });

    test('old vague news scores low', () => {
      const score = scoreCatalystStrength({
        event_type: CATALYST_TYPES.COMPANY_NEWS,
        source: 'company_news',
        event_time: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), // 30d ago
        materiality: 3,
        has_price_confirmation: false
      });
      expect(score).toBeLessThan(35);
    });

    test('unknown time gets minimal recency credit', () => {
      const score = scoreCatalystStrength({
        event_type: CATALYST_TYPES.EARNINGS,
        source: 'earnings_cache',
        event_time: null,
        materiality: 8
      });
      // source(8/10*20=16) + recency(5) + materiality(8/10*30=24) + specific(10) = 55
      expect(score).toBe(55);
    });

    test('recency tiers are deterministic', () => {
      const base = { event_type: CATALYST_TYPES.HALT, source: 'halt_feed', materiality: 7 };
      const now = Date.now();
      const day = 24 * 3600 * 1000;
      const s0 = scoreCatalystStrength({ ...base, event_time: new Date(now).toISOString() });
      const s3 = scoreCatalystStrength({ ...base, event_time: new Date(now - 2 * day).toISOString() });
      const s7 = scoreCatalystStrength({ ...base, event_time: new Date(now - 5 * day).toISOString() });
      const s14 = scoreCatalystStrength({ ...base, event_time: new Date(now - 10 * day).toISOString() });
      const s30 = scoreCatalystStrength({ ...base, event_time: new Date(now - 20 * day).toISOString() });
      expect(s0).toBeGreaterThan(s3);
      expect(s3).toBeGreaterThan(s7);
      expect(s7).toBeGreaterThan(s14);
      expect(s14).toBeGreaterThan(s30);
    });

    test('price confirmation adds points', () => {
      const base = { event_type: CATALYST_TYPES.EARNINGS, source: 'earnings_cache', materiality: 8, event_time: new Date().toISOString() };
      const without = scoreCatalystStrength(base);
      const withConf = scoreCatalystStrength({ ...base, has_price_confirmation: true });
      expect(withConf - without).toBe(10);
    });

    test('score caps at 100', () => {
      const score = scoreCatalystStrength({
        event_type: CATALYST_TYPES.HALT,
        source: 'halt_feed',
        event_time: new Date().toISOString(),
        materiality: 15, // over-scale — should clamp to 10
        has_price_confirmation: true
      });
      expect(score).toBeLessThanOrEqual(100);
    });

    test('returns 0 for null catalyst', () => {
      expect(scoreCatalystStrength(null)).toBe(0);
      expect(scoreCatalystStrength({})).toBe(0);
    });
  });

  describe('normalizeCatalyst', () => {
    test('normalizes a halt event with strength and freshness', () => {
      const c = normalizeCatalyst({
        symbol: 'AAPL',
        event_type: CATALYST_TYPES.HALT,
        event_time: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        source: 'halt_feed',
        label: 'Halt (T12)',
        materiality: 7
      });
      expect(c.symbol).toBe('AAPL');
      expect(c.strength).toBeGreaterThan(50);
      expect(c.freshness).toBeCloseTo(2 / 24, 1); // ~0.08 days
      expect(c.evidence).toBeNull();
    });

    test('sets strength 0-100 and carries source_url', () => {
      const c = normalizeCatalyst({
        symbol: 'TSLA',
        event_type: CATALYST_TYPES.SEC_MATERIAL_FILING,
        event_time: new Date().toISOString(),
        source: 'sec_filing',
        source_url: 'https://sec.gov/filing',
        materiality: 8
      });
      expect(c.source_url).toBe('https://sec.gov/filing');
      expect(c.strength).toBeGreaterThanOrEqual(0);
      expect(c.strength).toBeLessThanOrEqual(100);
    });
  });

  describe('getStrongestCatalyst', () => {
    test('returns the highest-strength catalyst', () => {
      const catalysts = [
        { event_type: 'news', strength: 30 },
        { event_type: 'earnings', strength: 80 },
        { event_type: 'halt', strength: 60 }
      ];
      expect(getStrongestCatalyst(catalysts).event_type).toBe('earnings');
    });

    test('returns null for empty list', () => {
      expect(getStrongestCatalyst([])).toBeNull();
      expect(getStrongestCatalyst(null)).toBeNull();
    });
  });
});
