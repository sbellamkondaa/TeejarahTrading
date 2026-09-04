const ti = require('../../src/utils/technicalIndicators');

// Generate sample daily candles for testing
function makeDailyCandles(count, startPrice = 100) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (Math.sin(i / 3) * 2);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    const volume = 1_000_000 + Math.floor(Math.random() * 500_000);
    candles.push({ open, high, low, close, volume, t: Date.now() - (count - i) * 86400000 });
    price = close;
  }
  return candles;
}

function makeIntradayCandles(count, startPrice = 100) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (Math.cos(i / 5) * 0.5);
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    const volume = 50_000 + Math.floor(Math.random() * 30_000);
    candles.push({ open, high, low, close, volume, t: Date.now() - (count - i) * 60000 });
    price = close;
  }
  return candles;
}

describe('technicalIndicators', () => {

  describe('calculateEMA', () => {
    test('calculates EMA-9 for sufficient data', () => {
      const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.1);
      const ema = ti.calculateEMA(closes, 9);
      expect(ema).not.toBeNull();
      expect(ema.length).toBe(50);
      expect(ema[8]).not.toBeNull(); // First valid EMA
      expect(ema[0]).toBeNull(); // Before period
    });

    test('returns null for insufficient data', () => {
      const closes = [1, 2, 3];
      const ema = ti.calculateEMA(closes, 9);
      expect(ema).toBeNull();
    });

    test('returns null for empty array', () => {
      expect(ti.calculateEMA([], 9)).toBeNull();
      expect(ti.calculateEMA(null, 9)).toBeNull();
    });
  });

  describe('getEMAValues', () => {
    test('returns EMA values for standard periods', () => {
      const closes = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 10) * 5);
      const result = ti.calculateAll({
        dailyCandles: makeDailyCandles(250),
        lastPrice: 100
      });
      expect(result.ema_9).not.toBeNull();
      expect(result.ema_20).not.toBeNull();
      expect(result.ema_50).not.toBeNull();
      expect(result.ema_200).not.toBeNull();
    });

    test('trend_regime is set', () => {
      const result = ti.calculateAll({
        dailyCandles: makeDailyCandles(250),
        lastPrice: 100
      });
      expect(['strong_uptrend', 'uptrend', 'strong_downtrend', 'downtrend', 'mixed', 'insufficient_data'])
        .toContain(result.trend_regime);
    });
  });

  describe('calculateVWAP', () => {
    test('calculates VWAP correctly', () => {
      const candles = [
        { high: 102, low: 98, close: 100, volume: 1000 },
        { high: 103, low: 99, close: 101, volume: 2000 },
        { high: 104, low: 100, close: 103, volume: 1500 }
      ];
      const vwap = ti.calculateVWAP(candles);
      expect(vwap).not.toBeNull();
      // VWAP = sum(tp*vol)/sum(vol)
      // tp1=(102+98+100)/3=100, tp2=(103+99+101)/3=101, tp3=(104+100+103)/3=102.33
      // = (100*1000 + 101*2000 + 102.33*1500) / 4500
      expect(vwap).toBeCloseTo(101.11, 1);
    });

    test('returns null for empty candles', () => {
      expect(ti.calculateVWAP([])).toBeNull();
      expect(ti.calculateVWAP(null)).toBeNull();
    });

    test('returns null when all volume is zero', () => {
      const candles = [{ high: 100, low: 99, close: 99.5, volume: 0 }];
      expect(ti.calculateVWAP(candles)).toBeNull();
    });
  });

  describe('calculateATR', () => {
    test('calculates ATR-14 for sufficient data', () => {
      const candles = makeDailyCandles(30);
      const atr = ti.calculateATR(candles, 14);
      expect(atr).not.toBeNull();
      expect(atr).toBeGreaterThan(0);
    });

    test('returns null for insufficient data', () => {
      expect(ti.calculateATR(makeDailyCandles(5), 14)).toBeNull();
      expect(ti.calculateATR([], 14)).toBeNull();
    });
  });

  describe('calculateRVOL', () => {
    test('calculates RVOL correctly', () => {
      const intraday = makeIntradayCandles(20);
      // Total volume = 20 * ~65000 = ~1.3M
      const adv = 1_000_000;
      const rvol = ti.calculateRVOL(intraday, adv);
      expect(rvol).not.toBeNull();
      expect(rvol).toBeGreaterThan(0);
    });

    test('returns null when adv is zero or missing', () => {
      expect(ti.calculateRVOL(makeIntradayCandles(10), 0)).toBeNull();
      expect(ti.calculateRVOL(makeIntradayCandles(10), null)).toBeNull();
      expect(ti.calculateRVOL([], 1_000_000)).toBeNull();
    });
  });

  describe('calculateGapPct', () => {
    test('calculates positive gap', () => {
      expect(ti.calculateGapPct(105, 100)).toBe(5);
    });

    test('calculates negative gap', () => {
      expect(ti.calculateGapPct(95, 100)).toBe(-5);
    });

    test('returns null for missing values', () => {
      expect(ti.calculateGapPct(null, 100)).toBeNull();
      expect(ti.calculateGapPct(100, null)).toBeNull();
    });

    test('returns null when previous close is zero', () => {
      expect(ti.calculateGapPct(100, 0)).toBeNull();
    });
  });

  describe('calculateOpeningRange', () => {
    test('calculates opening range from first N candles', () => {
      const candles = makeIntradayCandles(30);
      const or = ti.calculateOpeningRange(candles, 15);
      expect(or).not.toBeNull();
      expect(or.high).toBeGreaterThanOrEqual(or.low);
      expect(or.range_minutes).toBe(15);
    });

    test('returns null for empty candles', () => {
      expect(ti.calculateOpeningRange([], 15)).toBeNull();
    });
  });

  describe('calculateHODLOD', () => {
    test('finds high and low of day', () => {
      const candles = [
        { high: 101, low: 99 },
        { high: 105, low: 100 },
        { high: 103, low: 97 },
        { high: 104, low: 98 }
      ];
      const result = ti.calculateHODLOD(candles);
      expect(result.hod).toBe(105);
      expect(result.lod).toBe(97);
    });

    test('returns null for empty array', () => {
      expect(ti.calculateHODLOD([])).toBeNull();
    });
  });

  describe('getPreviousDayLevels', () => {
    test('extracts previous day high/low/close', () => {
      const candles = [
        { high: 100, low: 95, close: 98 },
        { high: 105, low: 99, close: 103 },
        { high: 107, low: 102, close: 106 }
      ];
      const result = ti.getPreviousDayLevels(candles);
      // Previous day is the 2nd-to-last
      expect(result.prev_high).toBe(105);
      expect(result.prev_low).toBe(99);
      expect(result.prev_close).toBe(103);
    });

    test('returns null for insufficient data', () => {
      expect(ti.getPreviousDayLevels([])).toBeNull();
      expect(ti.getPreviousDayLevels([{ high: 1, low: 1, close: 1 }])).toBeNull();
    });
  });

  describe('calculateVolumeTrend', () => {
    test('detects increasing volume trend', () => {
      const candles = [];
      for (let i = 0; i < 25; i++) {
        candles.push({ volume: 100_000 + i * 20_000 }); // increasing volume
      }
      const result = ti.calculateVolumeTrend(candles);
      expect(result.trend).toBe('increasing');
    });

    test('detects decreasing volume trend', () => {
      const candles = [];
      for (let i = 0; i < 25; i++) {
        candles.push({ volume: 500_000 - i * 20_000 }); // decreasing volume
      }
      const result = ti.calculateVolumeTrend(candles);
      expect(result.trend).toBe('decreasing');
    });

    test('returns null for insufficient data', () => {
      expect(ti.calculateVolumeTrend(makeDailyCandles(10))).toBeNull();
    });
  });

  describe('calculateSupportResistance', () => {
    test('calculates pivot and levels', () => {
      const candles = makeDailyCandles(25);
      const result = ti.calculateSupportResistance(candles);
      expect(result).not.toBeNull();
      expect(result.pivot).toBeGreaterThan(0);
      expect(Array.isArray(result.resistances)).toBe(true);
      expect(Array.isArray(result.supports)).toBe(true);
      // Resistances should be above pivot, supports below
      for (const r of result.resistances) {
        expect(r).toBeGreaterThan(result.pivot);
      }
      for (const s of result.supports) {
        expect(s).toBeLessThan(result.pivot);
      }
    });

    test('returns null for insufficient data', () => {
      expect(ti.calculateSupportResistance([])).toBeNull();
      expect(ti.calculateSupportResistance(makeDailyCandles(3))).toBeNull();
    });
  });

  describe('calculateRelativeStrength', () => {
    test('calculates RS vs benchmark', () => {
      const stock = makeDailyCandles(25, 100);
      const benchmark = makeDailyCandles(25, 400);
      const result = ti.calculateRelativeStrength(stock, benchmark, 20);
      expect(result).not.toBeNull();
      expect(result.rs).not.toBeNull();
      expect(result.stock_return).not.toBeNull();
      expect(result.benchmark_return).not.toBeNull();
    });

    test('returns null for insufficient data', () => {
      expect(ti.calculateRelativeStrength([], [], 20)).toBeNull();
      expect(ti.calculateRelativeStrength([{ close: 1 }], [], 20)).toBeNull();
    });
  });

  describe('calculateVolatilityRegime', () => {
    test('classifies low volatility', () => {
      const result = ti.calculateVolatilityRegime(0.5, 100);
      expect(result.regime).toBe('low_volatility');
      expect(result.atr_pct).toBe(0.5);
    });

    test('classifies normal volatility', () => {
      expect(ti.calculateVolatilityRegime(2, 100).regime).toBe('normal_volatility');
    });

    test('classifies elevated volatility', () => {
      expect(ti.calculateVolatilityRegime(4, 100).regime).toBe('elevated_volatility');
    });

    test('classifies high volatility', () => {
      expect(ti.calculateVolatilityRegime(6, 100).regime).toBe('high_volatility');
    });

    test('returns null for invalid input', () => {
      expect(ti.calculateVolatilityRegime(null, 100)).toBeNull();
      expect(ti.calculateVolatilityRegime(1, 0)).toBeNull();
    });
  });

  describe('calculateLiquidityMetrics', () => {
    test('rates liquidity from dollar volume', () => {
      const result = ti.calculateLiquidityMetrics(2_000_000, 1_000_000, 200);
      expect(result.dollar_volume).toBe(400_000_000);
      expect(result.avg_dollar_volume).toBe(200_000_000);
      expect(result.liquidity_rating).toBe('high');
    });

    test('calculates spread from bid/ask', () => {
      const result = ti.calculateLiquidityMetrics(1_000_000, 1_000_000, 100, 99.95, 100.05);
      expect(result.spread).toBe(0.1);
      expect(result.spread_pct).toBeCloseTo(0.1, 1);
      expect(result.spread_rating).toBe('normal');
    });

    test('handles missing bid/ask', () => {
      const result = ti.calculateLiquidityMetrics(1_000_000, 1_000_000, 100);
      expect(result.spread).toBeNull();
      expect(result.spread_rating).toBe('unknown');
    });

    test('returns null for missing price', () => {
      expect(ti.calculateLiquidityMetrics(1_000_000, 1_000_000, null)).toBeNull();
    });
  });

  describe('calculateAll', () => {
    test('returns all indicators with metadata', () => {
      const daily = makeDailyCandles(250);
      const intraday = makeIntradayCandles(30);
      const benchmark = makeDailyCandles(250, 400);
      const result = ti.calculateAll({
        dailyCandles: daily,
        intradayCandles: intraday,
        benchmarkCandles: benchmark,
        lastPrice: 100,
        previousClose: 98,
        bid: 99.95,
        ask: 100.05
      });

      expect(result.ema_9).not.toBeNull();
      expect(result.ema_200).not.toBeNull();
      expect(result.atr_14).not.toBeNull();
      expect(result.vwap).not.toBeNull();
      expect(result.hod).not.toBeNull();
      expect(result.lod).not.toBeNull();
      expect(result.opening_range).not.toBeNull();
      expect(result.prev_high).not.toBeNull();
      expect(result.prev_low).not.toBeNull();
      expect(result.prev_close).not.toBeNull();
      expect(result.gap_pct).toBeCloseTo(2.04, 1);
      expect(result.rvol).not.toBeNull();
      expect(result.volume_trend).not.toBeNull();
      expect(result.support_resistance).not.toBeNull();
      expect(result.relative_strength).not.toBeNull();
      expect(result.liquidity).not.toBeNull();
      expect(result.trend_regime).toBeDefined();
      expect(result.volatility_regime).toBeDefined();
      expect(result._meta).toBeDefined();
      expect(result._meta.source).toBe('schwab-candles');
      expect(result._meta.data_as_of).toBeGreaterThan(0);
      expect(Array.isArray(result._meta.unavailable)).toBe(true);
      expect(result._meta.fresh).toBe(true);
    });

    test('handles missing data gracefully', () => {
      const result = ti.calculateAll({});
      expect(result.ema_9).toBeNull();
      expect(result.atr_14).toBeNull();
      expect(result.vwap).toBeNull();
      expect(result.trend_regime).toBe('insufficient_data');
      expect(result._meta.unavailable.length).toBeGreaterThan(0);
    });

    test('does not fabricate unavailable indicators', () => {
      const result = ti.calculateAll({
        dailyCandles: makeDailyCandles(10), // too few for EMA-200
        lastPrice: 100
      });
      expect(result.ema_200).toBeNull();
      expect(result._meta.unavailable).toContain('ema_200');
    });
  });
});
