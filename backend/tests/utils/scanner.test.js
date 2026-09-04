const { scoreSetup, evaluateCandidate, scanCandidates, SETUP_TYPES, MIN_CANDIDATE_SCORE, checkDilutionRisk, checkPennyStockException, DILUTION_FORM_TYPES } = require('../../src/utils/scanner');

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

  describe('checkDilutionRisk', () => {
    test('detects S-3 filing as dilution risk', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'sec_filing', label: 'S-3' }]
      });
      const result = checkDilutionRisk(candidate);
      expect(result).not.toBeNull();
      expect(result.has_dilution_risk).toBe(true);
      expect(result.filings).toContain('S-3');
    });

    test('detects 424B5 as dilution risk', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'sec_filing', label: '424B5' }]
      });
      const result = checkDilutionRisk(candidate);
      expect(result).not.toBeNull();
      expect(result.filings).toContain('424B5');
    });

    test('does not flag 8-K as dilution risk', () => {
      const candidate = makeCandidate({
        catalysts: [{ type: 'sec_filing', label: '8-K' }]
      });
      const result = checkDilutionRisk(candidate);
      expect(result).toBeNull();
    });

    test('returns null when no SEC filings', () => {
      const candidate = makeCandidate({ catalysts: [] });
      expect(checkDilutionRisk(candidate)).toBeNull();
    });

    test('DILUTION_FORM_TYPES contains expected set', () => {
      expect(DILUTION_FORM_TYPES.has('S-3')).toBe(true);
      expect(DILUTION_FORM_TYPES.has('S-1')).toBe(true);
      expect(DILUTION_FORM_TYPES.has('424B5')).toBe(true);
      expect(DILUTION_FORM_TYPES.has('8-K')).toBe(false);
    });
  });

  describe('checkPennyStockException', () => {
    test('allows exception with earnings catalyst and good liquidity', () => {
      const candidate = makeCandidate({
        last_price: 3,
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      candidate.indicators.last_price = 3;
      candidate.indicators.liquidity.liquidity_rating = 'moderate';
      const result = checkPennyStockException(candidate);
      expect(result.allowed).toBe(true);
    });

    test('rejects exception without strong catalyst', () => {
      const candidate = makeCandidate({
        last_price: 3,
        catalysts: [{ type: 'sec_filing', label: '8-K' }]
      });
      candidate.indicators.last_price = 3;
      const result = checkPennyStockException(candidate);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('strong verified catalyst');
    });

    test('rejects exception with dilution risk', () => {
      const candidate = makeCandidate({
        last_price: 3,
        catalysts: [
          { type: 'earnings', label: 'Earnings' },
          { type: 'sec_filing', label: 'S-3' }
        ]
      });
      candidate.indicators.last_price = 3;
      candidate.indicators.liquidity.liquidity_rating = 'moderate';
      const result = checkPennyStockException(candidate);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('dilution');
    });

    test('rejects exception with very low liquidity', () => {
      const candidate = makeCandidate({
        last_price: 3,
        catalysts: [{ type: 'halt', label: 'Halted' }]
      });
      candidate.indicators.last_price = 3;
      candidate.indicators.liquidity.liquidity_rating = 'very_low';
      const result = checkPennyStockException(candidate);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('liquidity');
    });

    test('rejects exception with excessive spread', () => {
      const candidate = makeCandidate({
        last_price: 3,
        catalysts: [{ type: 'halt', label: 'Halted' }]
      });
      candidate.indicators.last_price = 3;
      candidate.indicators.liquidity.spread_rating = 'excessive';
      const result = checkPennyStockException(candidate);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('spread');
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
      // Penny stocks without strong catalysts are AVOID, not excluded from results
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID');
    });

    test('includes penny stocks with strong verified catalysts (earnings/halt)', () => {
      const penny = makeCandidate({
        symbol: 'CATLY',
        last_price: 2,
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      penny.indicators.last_price = 2;
      penny.indicators.gap_pct = 10;
      penny.indicators.rvol = 5;
      const results = scanCandidates([penny], { excludePennyStocks: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].classification).not.toBe('AVOID');
    });

    test('penny stock with weak catalyst (news only) is AVOID', () => {
      const penny = makeCandidate({
        symbol: 'WEAK',
        last_price: 2,
        catalysts: [{ type: 'sec_filing', label: '8-K' }]
      });
      penny.indicators.last_price = 2;
      penny.indicators.gap_pct = 5;
      penny.indicators.rvol = 3;
      const results = scanCandidates([penny], { excludePennyStocks: true });
      // SEC filing is not a STRONG catalyst type — should be AVOID
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID');
      expect(results[0].avoid_reason).toContain('strong verified catalyst');
    });

    test('penny stock with dilution risk (S-3) is AVOID even with earnings', () => {
      const penny = makeCandidate({
        symbol: 'DILUT',
        last_price: 2,
        catalysts: [
          { type: 'earnings', label: 'Earnings' },
          { type: 'sec_filing', label: 'S-3' }
        ]
      });
      penny.indicators.last_price = 2;
      penny.indicators.gap_pct = 10;
      penny.indicators.rvol = 5;
      const results = scanCandidates([penny], { excludePennyStocks: true });
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID');
      expect(results[0].avoid_reason).toContain('dilution');
    });

    test('penny stock with very low liquidity is AVOID even with earnings', () => {
      const penny = makeCandidate({
        symbol: 'ILLIQ',
        last_price: 2,
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      penny.indicators.last_price = 2;
      penny.indicators.liquidity.liquidity_rating = 'very_low';
      penny.indicators.gap_pct = 5;
      penny.indicators.rvol = 3;
      const results = scanCandidates([penny], { excludePennyStocks: true });
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID');
      expect(results[0].avoid_reason).toContain('liquidity');
    });

    test('non-penny stock with S-3 dilution gets WATCH classification with dilution fields', () => {
      const stock = makeCandidate({
        symbol: 'DILUT2',
        last_price: 50,
        catalysts: [
          { type: 'earnings', label: 'Earnings' },
          { type: 'sec_filing', label: 'S-3' }
        ]
      });
      stock.indicators.last_price = 50;
      stock.indicators.gap_pct = 8;
      stock.indicators.rvol = 5;
      const results = scanCandidates([stock]);
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('WATCH');
      expect(results[0].dilution_risk_level).toBe('MEDIUM');
      expect(results[0].dilution_reasons.length).toBeGreaterThan(0);
    });

    test('HIGH dilution risk from engine blocks TRADE even with strong catalyst', () => {
      const stock = makeCandidate({
        symbol: 'BIDIL',
        last_price: 100,
        catalysts: [{ type: 'earnings', label: 'Earnings' }],
        dilution_risk: { level: 'HIGH', reasons: ['424B5 filed 20d ago'], evidence: [] }
      });
      stock.indicators.last_price = 100;
      stock.indicators.gap_pct = 10;
      stock.indicators.rvol = 5;
      stock.indicators.change_percent = 12;
      const results = scanCandidates([stock]);
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('WATCH'); // NOT TRADE
      expect(results[0].dilution_risk_level).toBe('HIGH');
    });

    test('penny stock with engine HIGH dilution risk is AVOID even with earnings', () => {
      const penny = makeCandidate({
        symbol: 'PDIL',
        last_price: 3,
        catalysts: [{ type: 'earnings', label: 'Earnings' }],
        dilution_risk: { level: 'HIGH', reasons: ['recent offering'], evidence: [] }
      });
      penny.indicators.last_price = 3;
      penny.indicators.gap_pct = 8;
      penny.indicators.rvol = 4;
      const results = scanCandidates([penny], { excludePennyStocks: true });
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID');
      expect(results[0].avoid_reason).toContain('HIGH dilution');
    });

    test('AVOID_CHASING for extended move without fresh entry', () => {
      const extended = makeCandidate({
        symbol: 'CHASE',
        last_price: 50,
        catalysts: [{ type: 'earnings', label: 'Earnings' }]
      });
      extended.indicators.last_price = 50;
      extended.indicators.gap_pct = 5;
      extended.indicators.rvol = 4;
      extended.indicators.change_percent = 20; // huge move
      const results = scanCandidates([extended]);
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID_CHASING');
      expect(results[0].avoid_chasing_reason).toContain('chase risk');
    });

    test('AVOID_CHASING for price extended far from VWAP', () => {
      const extended = makeCandidate({ symbol: 'VWAPFAR' });
      extended.indicators.vwap_distance = 7; // 7% above VWAP
      extended.indicators.gap_pct = 3;
      const results = scanCandidates([extended]);
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('AVOID_CHASING');
      expect(results[0].avoid_chasing_reason).toContain('VWAP');
    });

    test('sort order: TRADE, WATCH, AVOID_CHASING, AVOID', () => {
      const trade = makeCandidate({ symbol: 'TR', catalysts: [{ type: 'earnings' }] });
      trade.indicators.gap_pct = 15; trade.indicators.rvol = 8; trade.indicators.change_percent = 12;

      const watch = makeCandidate({ symbol: 'WA' });
      watch.indicators.change_percent = 4; watch.indicators.gap_pct = 0; watch.indicators.rvol = 0.5;
      watch.indicators.opening_range = null; watch.indicators.support_resistance = null;
      watch.indicators.relative_strength = null; watch.indicators.vwap_distance = 0;

      const avoidChase = makeCandidate({ symbol: 'AC' });
      avoidChase.indicators.change_percent = 20;

      const avoid = makeCandidate({ symbol: 'AV' });
      avoid.indicators.last_price = 2; avoid.indicators.change_percent = 5; avoid.indicators.gap_pct = 3;

      const results = scanCandidates([avoid, avoidChase, watch, trade]);
      expect(results.map(r => r.classification)).toEqual(['TRADE', 'WATCH', 'AVOID_CHASING', 'AVOID']);
    });

    test('TRADE classification for high-scoring candidates', () => {
      const stock = makeCandidate({
        symbol: 'GREAT',
        last_price: 100,
        catalysts: [
          { type: 'earnings', label: 'Earnings' },
          { type: 'halt', label: 'Halted' }
        ]
      });
      stock.indicators.last_price = 100;
      stock.indicators.gap_pct = 8;
      stock.indicators.rvol = 5;
      stock.indicators.change_percent = 10;
      const results = scanCandidates([stock]);
      expect(results[0].classification).toBe('TRADE');
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
