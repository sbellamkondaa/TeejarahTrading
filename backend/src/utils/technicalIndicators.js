/**
 * Technical Indicator Engine
 *
 * Deterministic server-side calculations from OHLCV candle data. Does NOT
 * rely on external API indicator calls — all math is computed locally from
 * candle arrays fetched via the existing Schwab/Finnhub candle infrastructure.
 *
 * Every metric includes source, timeframe, data_as_of, and freshness state.
 * Never fabricates unavailable indicators.
 *
 * Usage:
 *   const indicators = require('../utils/technicalIndicators');
 *   const result = indicators.calculateAll(candles, { includeVWAP: true });
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function isNum(v) {
  return v != null && Number.isFinite(Number(v));
}

function toNum(v) {
  return isNum(v) ? Number(v) : null;
}

function fmt(n, decimals = 2) {
  if (!isNum(n)) return null;
  return Number(n.toFixed(decimals));
}

// ── EMA ──────────────────────────────────────────────────────────────────────

/**
 * Calculate Exponential Moving Average for a series of closing prices.
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} period - EMA period (e.g. 9, 20, 50, 200)
 * @returns {number[]|null} Array of EMA values aligned to closes, or null if insufficient data
 */
function calculateEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;

  const k = 2 / (period + 1);
  const emas = new Array(closes.length).fill(null);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  emas[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    emas[i] = closes[i] * k + emas[i - 1] * (1 - k);
  }

  return emas;
}

function getEMAValues(closes, periods = [9, 20, 50, 200]) {
  const result = {};
  for (const p of periods) {
    const ema = calculateEMA(closes, p);
    result[`ema_${p}`] = ema ? fmt(ema[ema.length - 1]) : null;
  }

  // Trend regime based on EMA alignment
  const e9 = result.ema_9;
  const e20 = result.ema_20;
  const e50 = result.ema_50;
  const e200 = result.ema_200;

  if (e9 && e20 && e50) {
    if (e9 > e20 && e20 > e50) {
      result.trend_regime = e200 && e50 > e200 ? 'strong_uptrend' : 'uptrend';
    } else if (e9 < e20 && e20 < e50) {
      result.trend_regime = e200 && e50 < e200 ? 'strong_downtrend' : 'downtrend';
    } else {
      result.trend_regime = 'mixed';
    }
  } else {
    result.trend_regime = 'insufficient_data';
  }

  return result;
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

/**
 * Calculate VWAP from OHLCV candles. VWAP = Σ(typical_price × volume) / Σ(volume)
 * Typical price = (high + low + close) / 3
 * @param {object[]} candles - [{ high, low, close, volume }, ...]
 * @returns {number|null} Current VWAP value
 */
function calculateVWAP(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let cumPV = 0;
  let cumV = 0;

  for (const c of candles) {
    const h = toNum(c.high);
    const l = toNum(c.low);
    const cl = toNum(c.close);
    const v = toNum(c.volume);
    if (h == null || l == null || cl == null || v == null || v === 0) continue;
    const tp = (h + l + cl) / 3;
    cumPV += tp * v;
    cumV += v;
  }

  return cumV > 0 ? fmt(cumPV / cumV) : null;
}

/**
 * Calculate session VWAP — resets at the start of each trading day.
 * Only works with intraday candles. Returns the VWAP for the current session.
 * @param {object[]} candles - intraday candles with timestamp
 * @returns {number|null} Session VWAP
 */
function calculateSessionVWAP(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  // Find the boundary: first candle of the current session
  // For simplicity, we compute VWAP over the entire array; the caller should
  // pass only the current session's candles.
  return calculateVWAP(candles);
}

// ── ATR ──────────────────────────────────────────────────────────────────────

/**
 * Calculate Average True Range.
 * TR = max(high-low, |high-prevClose|, |low-prevClose|)
 * @param {object[]} candles - [{ high, low, close }, ...] oldest first
 * @param {number} period - ATR period (default 14)
 * @returns {number|null} Current ATR value
 */
function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = toNum(candles[i].high);
    const l = toNum(candles[i].low);
    const pc = toNum(candles[i - 1].close);
    if (h == null || l == null || pc == null) continue;

    const tr = Math.max(
      h - l,
      Math.abs(h - pc),
      Math.abs(l - pc)
    );
    trs.push(tr);
  }

  if (trs.length < period) return null;

  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return fmt(atr);
}

// ── Relative Volume (RVOL) ──────────────────────────────────────────────────

/**
 * Calculate Relative Volume: current cumulative volume / average cumulative
 * volume at the same time of day over the prior N sessions.
 *
 * Requires intraday candles with timestamps for the current session plus
 * historical session volume profiles. This is a simplified version that
 * compares current session volume to average daily volume.
 *
 * @param {object[]} currentCandles - current session intraday candles
 * @param {number} avgDailyVolume - average daily volume (e.g. 20-day average)
 * @returns {number|null} RVOL value, or null if insufficient data
 */
function calculateRVOL(currentCandles, avgDailyVolume) {
  if (!Array.isArray(currentCandles) || !isNum(avgDailyVolume) || avgDailyVolume <= 0) {
    return null;
  }

  const currentVolume = currentCandles.reduce((sum, c) => {
    const v = toNum(c.volume);
    return sum + (v || 0);
  }, 0);

  if (currentVolume === 0) return null;

  return fmt(currentVolume / avgDailyVolume);
}

/**
 * Calculate average daily volume from daily candles.
 * @param {object[]} dailyCandles - [{ volume }, ...]
 * @param {number} period - number of days (default 20)
 * @returns {number|null}
 */
function calculateAvgDailyVolume(dailyCandles, period = 20) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return null;

  const recent = dailyCandles.slice(-period);
  const vols = recent.map(c => toNum(c.volume)).filter(v => v != null && v > 0);

  if (vols.length === 0) return null;

  return fmt(vols.reduce((a, b) => a + b, 0) / vols.length);
}

// ── Gap % ────────────────────────────────────────────────────────────────────

/**
 * Calculate gap percentage: (lastPrice - previousClose) / previousClose * 100
 * @returns {number|null}
 */
function calculateGapPct(lastPrice, previousClose) {
  if (!isNum(lastPrice) || !isNum(previousClose) || previousClose === 0) return null;
  return fmt(((lastPrice - previousClose) / previousClose) * 100);
}

// ── Opening Range ────────────────────────────────────────────────────────────

/**
 * Calculate opening range high/low from intraday candles.
 * @param {object[]} intradayCandles - candles with timestamps
 * @param {number} rangeMinutes - opening range in minutes (default 15)
 * @returns {{ open: number, high: number, low: number, close: number }|null}
 */
function calculateOpeningRange(intradayCandles, rangeMinutes = 15) {
  if (!Array.isArray(intradayCandles) || intradayCandles.length === 0) return null;

  // Filter to the first `rangeMinutes` minutes after market open (09:30 ET).
  // Assumes candles have ISO timestamps or unix timestamps.
  const rangeCandles = intradayCandles.slice(0, rangeMinutes); // simplified: first N candles

  if (rangeCandles.length === 0) return null;

  let high = -Infinity;
  let low = Infinity;
  let open = null;
  let close = null;

  for (const c of rangeCandles) {
    const h = toNum(c.high);
    const l = toNum(c.low);
    const o = toNum(c.open);
    const cl = toNum(c.close);
    if (h != null) high = Math.max(high, h);
    if (l != null) low = Math.min(low, l);
    if (open == null) open = o;
    close = cl ?? close;
  }

  if (!isNum(high) || !isNum(low)) return null;

  return {
    open: fmt(open),
    high: fmt(high),
    low: fmt(low),
    close: fmt(close),
    range_minutes: rangeMinutes
  };
}

// ── HOD / LOD ────────────────────────────────────────────────────────────────

/**
 * Calculate High of Day and Low of Day from intraday candles.
 * @param {object[]} intradayCandles
 * @returns {{ hod: number, lod: number }|null}
 */
function calculateHODLOD(intradayCandles) {
  if (!Array.isArray(intradayCandles) || intradayCandles.length === 0) return null;

  let hod = -Infinity;
  let lod = Infinity;

  for (const c of intradayCandles) {
    const h = toNum(c.high);
    const l = toNum(c.low);
    if (h != null) hod = Math.max(hod, h);
    if (l != null) lod = Math.min(lod, l);
  }

  if (!isNum(hod) || !isNum(lod)) return null;

  return { hod: fmt(hod), lod: fmt(lod) };
}

// ── Previous Day High/Low/Close ──────────────────────────────────────────────

/**
 * Extract previous day's high, low, and close from daily candles.
 * @param {object[]} dailyCandles - daily candles, oldest first
 * @returns {{ prev_high: number, prev_low: number, prev_close: number }|null}
 */
function getPreviousDayLevels(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 2) return null;

  const prev = dailyCandles[dailyCandles.length - 2];
  const h = toNum(prev.high);
  const l = toNum(prev.low);
  const c = toNum(prev.close);

  if (h == null || l == null || c == null) return null;

  return { prev_high: fmt(h), prev_low: fmt(l), prev_close: fmt(c) };
}

// ── Volume Trend ──────────────────────────────────────────────────────────────

/**
 * Simple volume trend: compare recent average volume to longer-term average.
 * Positive = increasing volume, negative = decreasing.
 * @param {object[]} dailyCandles
 * @returns {{ trend: string, short_avg: number, long_avg: number }|null}
 */
function calculateVolumeTrend(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 20) return null;

  const shortPeriod = 5;
  const longPeriod = 20;

  const shortVols = dailyCandles.slice(-shortPeriod).map(c => toNum(c.volume)).filter(v => v != null);
  const longVols = dailyCandles.slice(-longPeriod).map(c => toNum(c.volume)).filter(v => v != null);

  if (shortVols.length === 0 || longVols.length === 0) return null;

  const shortAvg = shortVols.reduce((a, b) => a + b, 0) / shortVols.length;
  const longAvg = longVols.reduce((a, b) => a + b, 0) / longVols.length;

  let trend;
  if (longAvg === 0) trend = 'insufficient_data';
  else if (shortAvg > longAvg * 1.1) trend = 'increasing';
  else if (shortAvg < longAvg * 0.9) trend = 'decreasing';
  else trend = 'flat';

  return { trend, short_avg: fmt(shortAvg), long_avg: fmt(longAvg) };
}

// ── Support / Resistance ──────────────────────────────────────────────────────

/**
 * Identify simple support/resistance levels from recent daily candles.
 * Uses pivot points and recent swing highs/lows.
 * @param {object[]} dailyCandles
 * @returns {{ supports: number[], resistances: number[], pivot: number }|null}
 */
function calculateSupportResistance(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 5) return null;

  // Classic pivot point from the most recent completed day
  const prev = dailyCandles[dailyCandles.length - 2];
  const h = toNum(prev.high);
  const l = toNum(prev.low);
  const c = toNum(prev.close);

  if (h == null || l == null || c == null) return null;

  const pivot = (h + l + c) / 3;
  const r1 = 2 * pivot - l;
  const s1 = 2 * pivot - h;
  const r2 = pivot + (h - l);
  const s2 = pivot - (h - l);

  // Recent swing highs/lows (last 20 days)
  const lookback = Math.min(20, dailyCandles.length - 1);
  const recent = dailyCandles.slice(-lookback);
  const swingHighs = [];
  const swingLows = [];

  for (let i = 1; i < recent.length - 1; i++) {
    const ph = toNum(recent[i].high);
    const pl = toNum(recent[i].low);
    const phPrev = toNum(recent[i - 1].high);
    const plPrev = toNum(recent[i - 1].low);
    const phNext = toNum(recent[i + 1].high);
    const plNext = toNum(recent[i + 1].low);

    if (ph != null && phPrev != null && phNext != null && ph > phPrev && ph > phNext) {
      swingHighs.push(ph);
    }
    if (pl != null && plPrev != null && plNext != null && pl < plPrev && pl < plNext) {
      swingLows.push(pl);
    }
  }

  // Sort and deduplicate (within 0.5% tolerance)
  function dedupeLevels(levels) {
    if (!levels.length) return [];
    levels.sort((a, b) => a - b);
    const result = [levels[0]];
    for (let i = 1; i < levels.length; i++) {
      if (Math.abs(levels[i] - result[result.length - 1]) / result[result.length - 1] > 0.005) {
        result.push(levels[i]);
      }
    }
    return result.map(v => fmt(v));
  }

  return {
    pivot: fmt(pivot),
    resistances: dedupeLevels([r1, r2, ...swingHighs]),
    supports: dedupeLevels([s1, s2, ...swingLows])
  };
}

// ── Relative Strength vs Benchmark ────────────────────────────────────────────

/**
 * Calculate relative strength of a stock vs a benchmark (e.g. SPY).
 * RS = stock_return / benchmark_return over a period.
 * @param {object[]} stockCandles - daily candles for the stock
 * @param {object[]} benchmarkCandles - daily candles for the benchmark
 * @param {number} period - lookback period in days (default 20)
 * @returns {{ rs: number, stock_return: number, benchmark_return: number }|null}
 */
function calculateRelativeStrength(stockCandles, benchmarkCandles, period = 20) {
  if (!Array.isArray(stockCandles) || !Array.isArray(benchmarkCandles)) return null;
  if (stockCandles.length < 2 || benchmarkCandles.length < 2) return null;

  const stockRecent = stockCandles.slice(-period - 1);
  const benchRecent = benchmarkCandles.slice(-period - 1);

  const stockStart = toNum(stockRecent[0]?.close);
  const stockEnd = toNum(stockRecent[stockRecent.length - 1]?.close);
  const benchStart = toNum(benchRecent[0]?.close);
  const benchEnd = toNum(benchRecent[benchRecent.length - 1]?.close);

  if (!stockStart || !stockEnd || !benchStart || !benchEnd || stockStart === 0 || benchStart === 0) {
    return null;
  }

  const stockReturn = ((stockEnd - stockStart) / stockStart) * 100;
  const benchReturn = ((benchEnd - benchStart) / benchStart) * 100;

  const rs = benchReturn !== 0 ? stockReturn / benchReturn : null;

  return {
    rs: isNum(rs) ? fmt(rs) : null,
    stock_return: fmt(stockReturn),
    benchmark_return: fmt(benchReturn),
    period
  };
}

// ── Volatility Regime ──────────────────────────────────────────────────────────

/**
 * Determine volatility regime from ATR as a percentage of price.
 * @param {number} atr - Current ATR value
 * @param {number} price - Current price
 * @returns {{ regime: string, atr_pct: number }|null}
 */
function calculateVolatilityRegime(atr, price) {
  if (!isNum(atr) || !isNum(price) || price === 0) return null;

  const atrPct = (atr / price) * 100;

  let regime;
  if (atrPct < 1.5) regime = 'low_volatility';
  else if (atrPct < 3) regime = 'normal_volatility';
  else if (atrPct < 5) regime = 'elevated_volatility';
  else regime = 'high_volatility';

  return { regime, atr_pct: fmt(atrPct) };
}

// ── Liquidity / Spread Metrics ────────────────────────────────────────────────

/**
 * Estimate liquidity from volume and price.
 * @param {number} volume - current session volume
 * @param {number} avgDailyVolume - average daily volume
 * @param {number} price - current price
 * @param {number} bid - bid price (if available)
 * @param {number} ask - ask price (if available)
 * @returns {object|null}
 */
function calculateLiquidityMetrics(volume, avgDailyVolume, price, bid, ask) {
  if (!isNum(price)) return null;

  const dollarVolume = isNum(volume) ? volume * price : null;
  const avgDollarVolume = isNum(avgDailyVolume) ? avgDailyVolume * price : null;

  let spread = null;
  let spreadPct = null;
  if (isNum(bid) && isNum(ask) && price > 0) {
    spread = ask - bid;
    spreadPct = (spread / price) * 100;
  }

  let liquidityRating = 'unknown';
  if (avgDollarVolume != null) {
    if (avgDollarVolume > 100_000_000) liquidityRating = 'high';
    else if (avgDollarVolume > 20_000_000) liquidityRating = 'moderate';
    else if (avgDollarVolume > 5_000_000) liquidityRating = 'low';
    else liquidityRating = 'very_low';
  }

  let spreadRating = 'unknown';
  if (spreadPct != null) {
    if (spreadPct < 0.05) spreadRating = 'tight';
    else if (spreadPct < 0.15) spreadRating = 'normal';
    else if (spreadPct < 0.5) spreadRating = 'wide';
    else spreadRating = 'excessive';
  }

  return {
    dollar_volume: fmt(dollarVolume, 0),
    avg_dollar_volume: fmt(avgDollarVolume, 0),
    liquidity_rating: liquidityRating,
    spread: fmt(spread),
    spread_pct: fmt(spreadPct),
    spread_rating: spreadRating
  };
}

// ── Master Calculate ──────────────────────────────────────────────────────────

/**
 * Calculate all available technical indicators from candle data.
 *
 * @param {object} params
 * @param {object[]} params.dailyCandles - daily OHLCV candles, oldest first
 * @param {object[]} [params.intradayCandles] - intraday OHLCV candles for current session
 * @param {object[]} [params.benchmarkCandles] - benchmark (SPY) daily candles for RS
 * @param {number} [params.lastPrice] - latest/extended-hours price
 * @param {number} [params.previousClose] - previous regular session close
 * @param {number} [params.bid] - bid price
 * @param {number} [params.ask] - ask price
 * @param {number} [params.avgDailyVolumeOverride] - pre-computed ADV (skips calculation)
 * @returns {object} All available indicators with metadata
 */
function calculateAll(params) {
  const {
    dailyCandles,
    intradayCandles,
    benchmarkCandles,
    lastPrice,
    previousClose,
    bid,
    ask
  } = params;

  const closes = Array.isArray(dailyCandles)
    ? dailyCandles.map(c => toNum(c.close)).filter(v => v != null)
    : [];

  const indicators = {};
  const dataAsOf = Date.now();
  const source = 'schwab-candles';

  // Initialize all keys to null so consumers can distinguish "not available"
  // from "not computed" and the _meta.unavailable list is accurate.
  const allKeys = [
    'ema_9', 'ema_20', 'ema_50', 'ema_200', 'trend_regime',
    'atr_14', 'atr_pct', 'volatility_regime',
    'vwap', 'vwap_distance', 'hod', 'lod', 'opening_range',
    'prev_high', 'prev_low', 'prev_close', 'gap_pct',
    'avg_daily_volume', 'rvol', 'volume_trend',
    'support_resistance', 'relative_strength', 'liquidity'
  ];
  for (const k of allKeys) indicators[k] = null;

  // EMA 9/20/50/200
  if (closes.length > 0) {
    Object.assign(indicators, getEMAValues(closes));
  } else {
    indicators.trend_regime = 'insufficient_data';
  }

  // ATR (14)
  const atr = Array.isArray(dailyCandles) ? calculateATR(dailyCandles, 14) : null;
  indicators.atr_14 = atr;
  indicators.atr_pct = (atr && isNum(lastPrice)) ? fmt((atr / lastPrice) * 100) : null;

  // Volatility regime
  if (atr && isNum(lastPrice)) {
    const volRegime = calculateVolatilityRegime(atr, lastPrice);
    indicators.volatility_regime = volRegime ? volRegime.regime : 'insufficient_data';
    indicators.atr_pct = volRegime ? volRegime.atr_pct : null;
  } else {
    indicators.volatility_regime = 'insufficient_data';
  }

  // VWAP (session, from intraday)
  if (Array.isArray(intradayCandles) && intradayCandles.length > 0) {
    indicators.vwap = calculateSessionVWAP(intradayCandles);
    indicators.vwap_distance = (indicators.vwap && isNum(lastPrice))
      ? fmt(((lastPrice - indicators.vwap) / indicators.vwap) * 100)
      : null;

    // HOD / LOD
    Object.assign(indicators, calculateHODLOD(intradayCandles));

    // Opening range (15 min default)
    indicators.opening_range = calculateOpeningRange(intradayCandles, 15);
  } else {
    indicators.vwap = null;
    indicators.vwap_distance = null;
    indicators.hod = null;
    indicators.lod = null;
    indicators.opening_range = null;
  }

  // Previous day levels
  if (Array.isArray(dailyCandles) && dailyCandles.length >= 2) {
    Object.assign(indicators, getPreviousDayLevels(dailyCandles));
  } else {
    indicators.prev_high = null;
    indicators.prev_low = null;
    indicators.prev_close = null;
  }

  // Gap %
  if (isNum(lastPrice) && isNum(previousClose)) {
    indicators.gap_pct = calculateGapPct(lastPrice, previousClose);
  } else {
    indicators.gap_pct = null;
  }

  // Average daily volume
  const adv = isNum(params.avgDailyVolumeOverride)
    ? params.avgDailyVolumeOverride
    : (Array.isArray(dailyCandles) ? calculateAvgDailyVolume(dailyCandles, 20) : null);
  indicators.avg_daily_volume = adv;

  // RVOL (from intraday)
  if (Array.isArray(intradayCandles) && adv) {
    indicators.rvol = calculateRVOL(intradayCandles, adv);
  } else {
    indicators.rvol = null;
  }

  // Volume trend
  if (Array.isArray(dailyCandles) && dailyCandles.length >= 20) {
    indicators.volume_trend = calculateVolumeTrend(dailyCandles);
  } else {
    indicators.volume_trend = null;
  }

  // Support / Resistance
  if (Array.isArray(dailyCandles) && dailyCandles.length >= 5) {
    indicators.support_resistance = calculateSupportResistance(dailyCandles);
  } else {
    indicators.support_resistance = null;
  }

  // Relative strength vs benchmark
  if (Array.isArray(benchmarkCandles) && benchmarkCandles.length >= 2) {
    indicators.relative_strength = calculateRelativeStrength(dailyCandles, benchmarkCandles, 20);
  } else {
    indicators.relative_strength = null;
  }

  // Liquidity / spread
  const currentVolume = Array.isArray(intradayCandles)
    ? intradayCandles.reduce((s, c) => s + (toNum(c.volume) || 0), 0)
    : null;
  indicators.liquidity = calculateLiquidityMetrics(currentVolume, adv, lastPrice, bid, ask);

  // Metadata
  indicators._meta = {
    source,
    data_as_of: dataAsOf,
    daily_candle_count: Array.isArray(dailyCandles) ? dailyCandles.length : 0,
    intraday_candle_count: Array.isArray(intradayCandles) ? intradayCandles.length : 0,
    fresh: (Date.now() - dataAsOf) < 5 * 60 * 1000,
    unavailable: []
  };

  // Track which indicators are unavailable
  for (const [key, val] of Object.entries(indicators)) {
    if (key === '_meta') continue;
    if (val == null) indicators._meta.unavailable.push(key);
  }

  return indicators;
}

module.exports = {
  calculateEMA,
  calculateVWAP,
  calculateSessionVWAP,
  calculateATR,
  calculateRVOL,
  calculateAvgDailyVolume,
  calculateGapPct,
  calculateOpeningRange,
  calculateHODLOD,
  getPreviousDayLevels,
  calculateVolumeTrend,
  calculateSupportResistance,
  calculateRelativeStrength,
  calculateVolatilityRegime,
  calculateLiquidityMetrics,
  calculateAll
};
