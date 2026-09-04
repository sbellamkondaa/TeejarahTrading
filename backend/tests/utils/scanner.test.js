const { scoreSetup, evaluateCandidate, scanCandidates, SETUP_TYPES, MIN_CANDIDATE_SCORE } = require('../../src/utils/scanner');

function makeCandidate(overrides = {}) {
  return {
    symbol: 'TEST',
    company_name: 'Test Corp',
    last_price: 50,
    change_percent: 5,
    halted: false,
    catalysts: [],
    indicators: {
      last_price: 50,
      gap_pct: 3,
      rvol: 2.5,
      vwap: 49,
      vwap_distance: 2.04,
      change_percent: 5,
      trend_regime: 'uptrend',
      opening_range: { high: 49.5, low: 48.5, range_minutes: 15 },
      support_resistance: { pivot: 49, resistances: [50.5], supports: [47.5] },
      relative_strength: { rs: 1.5, stock_return: 10, benchmark_return: 6.67, period: 20 },
      liquidity: { liquidity_rating: 'high', spread_rating: 'tight' },
      volume: 2000000,
      volume_trend: { trend: 'increasing' },
      atr_14: 1.5,
      volatility_regime: 'normal_volatility'
    },
    session: 'premarket',
    ...overrides
  };
}

describe('scanner', () => {

  describe('scoreSetup', () => {
    test('scores gap_and_catalyst setup', () => {
      const candidate = makeCandidate({ catalysts: [{ type: 'earnings', label: 'Earnings', timestamp: '2026-09-04' }] });
      const result = scoreSetup(candidate, SETUP_TYPES.GAP_AND_CATALYST);
      expect(result).not.toBeNull();
      expect(result.triggered).toBe(true);
      expect(result.score).toBeGreaterThan(40);
      expect(result.reason).toContain('Gap');
    });

    test('gap_and_catalyst requires both gap > 2% and catalyst', () => {
      const noCatalyst = makeCandidate({ gap_pct: 3, catalysts: [] });
      expect(scoreSetup(noCatalyst, SETUP_TYPES.GAP_AND_CATALYST)).toBeNull();

      const smallGap = makeCandidate({ catalysts: [{ type: 'earnings' }] });
      smallGap.indicators.gap_pct = 1;
      expect(scoreSetup(smallGap, SETUP_TYPES.GAP_AND_CATALYST)).toBeNull();
    });

    test('scores momentum setup with strong move', () => {
      const candidate = makeCandidate({});
      const result = scoreSetup(candidate, SETUP_TYPES.MOMENTUM);
      expect(result).not.toBeNull();
      expect(result.triggered).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(40);
    });

    test('momentum requires > 3% move', () => {
      const candidate = makeCandidate({});
      candidate.indicators.change_percent = 1;
      expect(scoreSetup(candidate, SETUP_TYPES.MOMENTUM)).toBeNull();
    });

    test('scores rvol_surge when RVOL > 2', () => {
      const candidate = makeCandidate({});
      const result = scoreSetup(candidate, SETUP_TYPES.RVOL_SURGE);
      expect(result).not.toBeNull();
      expect(result.triggered).toBe(true);
    });

    test('rvol_surge not triggered when RVOL < 2', () => {
      const candidate = makeCandidate({});
      candidate.indicators.rvol = 1.2;
      expect(scoreSetup(candidate, SETUP_TYPES.RVOL_SURGE)).toBeNull();
    });

    test('scores vwap_reclaim when above VWAP', () => {
      const candidate = makeCandidate({});
      const result = scoreSetup(candidate, SETUP_TYPES.VWAP_RECLAIM);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('Above VWAP');
    });

    test('vwap_reclaim not triggered when below VWAP', () => {
      const candidate = makeCandidate({});
      candidate.indicators.vwap_distance = -1.5;
      expect(scoreSetup(candidate, SETUP_TYPES.VWAP_RECLAIM)).toBeNull();
    });

    test('scores opening_range_breakout', () => {
      const candidate = makeCandidate({});
      candidate.last_price = 51;
      candidate.indicators.last_price = 51;
      const result = scoreSetup(candidate, SETUP_TYPES.OPENING_RANGE_BREAKOUT);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('Broke OR high');
    });

    test('scores opening_range_breakdown', () => {
      const candidate = makeCandidate({});
      candidate.last_price = 47;
      candidate.indicators.last_price = 47;
      const result = scoreSetup(candidate, SETUP_TYPES.OPENING_RANGE_BREAKDOWN);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('Broke OR low');
    });

    test('scores relative_strength when RS > 1.2', () => {
      const candidate = makeCandidate({});
      const result = scoreSetup(candidate, SETUP_TYPES.RELATIVE_STRENGTH);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('RS');
    });

    test('relative_strength not triggered when RS < 1.2', () => {
      const candidate = makeCandidate({});
      candidate.indicators.relative_strength.rs = 1.0;
      expect(scoreSetup(candidate, SETUP_TYPES.RELATIVE_STRENGTH)).toBeNull();
    });

    test('scores earnings_reaction with earnings catalyst + move', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      const result = scoreSetup(candidate, SETUP_TYPES.EARNINGS_REACTION);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('Earnings reaction');
    });

    test('earnings_reaction not triggered without earnings', () => {
      const candidate = makeCandidate({ catalysts: [] });
      expect(scoreSetup(candidate, SETUP_TYPES.EARNINGS_REACTION)).toBeNull();
    });

    test('scores sec_catalyst with SEC filing + move', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'sec_filing', label: '8-K' }]
      });
      const result = scoreSetup(candidate, SETUP_TYPES.SEC_CATALYST);
      expect(result).not.toBeNull();
    });

    test('sec_catalyst flags dilution risk for S-3', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'sec_filing', label: 'S-3' }]
      });
      const result = scoreSetup(candidate, SETUP_TYPES.SEC_CATALYST);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('Dilution risk');
    });

    test('scores halt_resumption', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'halt_resumed', label: 'Halt Resumed' }]
      });
      const result = scoreSetup(candidate, SETUP_TYPES.HALT_RESUMPTION);
      expect(result).not.toBeNull();
      expect(result.reason).toContain('Halt resumption');
    });

    test('returns null for unknown setup type', () => {
      const candidate = makeCandidate({});
      expect(scoreSetup(candidate, 'bogus')).toBeNull();
    });

    test('returns null when price is missing', () => {
      const candidate = makeCandidate({});
      candidate.indicators.last_price = null;
      candidate.last_price = null;
      expect(scoreSetup(candidate, SETUP_TYPES.MOMENTUM)).toBeNull();
    });

    test('penny stock penalty reduces score', () => {
      const cheap = makeCandidate({ last_price: 2 });
      cheap.indicators.last_price = 2;
      cheap.indicators.change_percent = 5;
      const result = scoreSetup(cheap, SETUP_TYPES.MOMENTUM);
      expect(result.score).toBeLessThan(60); // Penalized for sub-$5 without catalyst
    });

    test('low liquidity penalty reduces score', () => {
      const illiquid = makeCandidate({});
      illiquid.indicators.liquidity = { liquidity_rating: 'very_low', spread_rating: 'excessive' };
      const result = scoreSetup(illiquid, SETUP_TYPES.MOMENTUM);
      expect(result.score).toBeLessThan(50);
    });

    test('score is capped at 100', () => {
      const superCandidate = makeCandidate({
        catalysts: [
          { type: 'earnings', label: 'Earnings' },
          { type: 'sec_filing', label: '8-K' },
          { type: 'halt', label: 'Halted' }
        ]
      });
      superCandidate.indicators.gap_pct = 15;
      superCandidate.indicators.rvol = 10;
      superCandidate.indicators.change_percent = 20;
      const result = scoreSetup(superCandidate, SETUP_TYPES.GAP_AND_CATALYST);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  describe('evaluateCandidate', () => {
    test('finds multiple triggered setups', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      const result = evaluateCandidate(candidate);
      expect(result.setups.length).toBeGreaterThan(1);
      expect(result.best_setup).not.toBeNull();
      expect(result.composite_score).toBe(result.setups[0].score);
    });

    test('qualifies when score >= MIN_CANDIDATE_SCORE', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      const result = evaluateCandidate(candidate);
      expect(result.qualifies).toBe(true);
    });

    test('does not qualify with weak candidate', () => {
      const weak = makeCandidate({});
      weak.indicators.change_percent = 0.5;
      weak.indicators.gap_pct = 0;
      weak.indicators.rvol = 0.5;
      weak.indicators.vwap_distance = 0;
      weak.indicators.opening_range = null;
      weak.indicators.support_resistance = null;
      weak.indicators.relative_strength = null;
      const result = evaluateCandidate(weak);
      expect(result.qualifies).toBe(false);
    });
  });

  describe('scanCandidates', () => {
    test('ranks candidates by composite score descending', () => {
      const strong = makeCandidate({
        symbol: 'STRONG',
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      strong.indicators.gap_pct = 8;
      strong.indicators.rvol = 5;
      strong.indicators.change_percent = 10;

      const weak = makeCandidate({ symbol: 'WEAK' });
      weak.indicators.change_percent = 3.5;
      weak.indicators.gap_pct = 0;
      weak.indicators.rvol = 0.5;

      const results = scanCandidates([strong, weak]);
      expect(results[0].symbol).toBe('STRONG');
    });

    test('filters out candidates below minScore', () => {
      const weak = makeCandidate({});
      weak.indicators.change_percent = 3.1;
      weak.indicators.gap_pct = 0;
      weak.indicators.rvol = 0.5;
      const results = scanCandidates([weak], { minScore: 80 });
      expect(results).toHaveLength(0);
    });

    test('limits results to maxResults', () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeCandidate({ symbol: `S${i}`, catalysts: [{ type: 'earnings' }] })
      );
      const results = scanCandidates(candidates, { maxResults: 3 });
      expect(results).toHaveLength(3);
    });

    test('excludes penny stocks without catalysts', () => {
      const penny = makeCandidate({ symbol: 'PENNY', last_price: 0.5 });
      penny.indicators.last_price = 0.5;
      penny.catalysts = [];
      const results = scanCandidates([penny]);
      expect(results).toHaveLength(0);
    });

    test('includes penny stocks with strong catalysts', () => {
      const penny = makeCandidate({
        symbol: 'CATLY',
        last_price: 2,
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      penny.indicators.last_price = 2;
      penny.indicators.gap_pct = 10;
      penny.indicators.rvol = 5;
      const results = scanCandidates([penny], { excludePennyStocks: true });
      // Should be included because it has a catalyst
      expect(results.length).toBeGreaterThan(0);
    });

    test('returns empty array for empty input', () => {
      expect(scanCandidates([])).toEqual([]);
    });

    test('each result includes setup details and key metrics', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      const results = scanCandidates([candidate]);
      expect(results[0]).toHaveProperty('symbol');
      expect(results[0]).toHaveProperty('composite_score');
      expect(results[0]).toHaveProperty('best_setup');
      expect(results[0]).toHaveProperty('setups');
      expect(results[0]).toHaveProperty('catalysts');
      expect(results[0]).toHaveProperty('liquidity_rating');
    });
  });
});
