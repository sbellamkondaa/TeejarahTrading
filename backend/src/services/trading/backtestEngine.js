/**
 * Backtest Engine — Deterministic Historical Strategy Backtesting
 *
 * Pure functions: no I/O, no random fills, no lookahead bias.
 * Same candles + config → same trades + metrics, always.
 *
 * Execution model:
 *   - BACKTEST mode only (no PAPER/LIVE, no broker API calls)
 *   - Entry at the close of the signal bar (the bar where conditions are met)
 *   - Stop/T1/T2 set at signal bar; simulated through subsequent bars
 *   - Protective exit: position split into thirds (T1, T2, stop/runner)
 *   - Same-bar ambiguity: stop processed before targets (conservative for longs)
 *   - End-of-day: open trades closed at last bar's close
 *
 * No-lookahead rules:
 *   - VWAP computed from session start to current bar (not future bars)
 *   - ATR/EMA computed from daily candles up to the previous trading day
 *   - Gap = (today's open - yesterday's close) / yesterday's close
 *   - Entry cannot use information unavailable at signal time
 *
 * Limitations:
 *   - Historical intraday data from Schwab may have gaps (market holidays,
 *     half-days, data outages). Days with insufficient intraday bars are skipped.
 *   - No survivorship-bias correction (delisted symbols not included).
 *   - Catalyst data from DB tables may be incomplete for historical dates.
 */

const {
  calculateSessionVWAP,
  calculateATR,
  calculateEMA,
  calculateGapPct,
  calculateVolatilityRegime
} = require('../../utils/technicalIndicators');

// ─── Helpers ──────────────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Convert a candle timestamp (seconds) to a YYYY-MM-DD date string.
 */
function toDateStr(ts) {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Group intraday candles by trading day.
 * Returns Map<string, candle[]> keyed by YYYY-MM-DD.
 */
function groupByDay(intradayCandles) {
  const map = new Map();
  for (const c of intradayCandles) {
    const key = toDateStr(c.time);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  // Sort each day's candles by time
  for (const [, arr] of map) {
    arr.sort((a, b) => a.time - b.time);
  }
  return map;
}

/**
 * Gap bucket for segmentation.
 */
function gapBucket(gapPct) {
  if (gapPct == null) return 'unknown';
  if (gapPct < 5) return '3-5%';
  if (gapPct < 10) return '5-10%';
  return '10%+';
}

/**
 * RVOL bucket for segmentation.
 */
function rvolBucket(rvol) {
  if (rvol == null) return 'unknown';
  if (rvol < 5) return '2-5';
  if (rvol < 10) return '5-10';
  return '10+';
}

/**
 * Catalyst strength bucket for segmentation.
 */
function catalystStrengthBucket(strength) {
  if (strength == null) return 'unknown';
  if (strength < 40) return 'low';
  if (strength < 70) return 'medium';
  return 'high';
}

// ─── Core Backtest Logic ──────────────────────────────────────────────────

/**
 * Simulate a single trade from entry through subsequent bars.
 *
 * @param {object} entry - { entryPrice, stopPrice, t1Price, t2Price, entryBarIdx, signalBar, dailyCandles }
 * @param {object[]} sessionBars - intraday bars for the day (all of them)
 * @param {object} config - strategy config
 * @returns {object} trade result
 */
function simulateTrade(entry, sessionBars, config) {
  const {
    entryPrice, stopPrice, t1Price, t2Price,
    entryBarIdx
  } = entry;

  const t1Rr = toNum(config.t1RrTarget) || 2.0;
  const t2Rr = toNum(config.t2RrTarget) || 4.0;
  const slippagePerShare = toNum(config.slippagePerShare) || 0;
  const feesPerShare = toNum(config.feesPerShare) || 0;

  // Adjust prices for slippage/fees
  const adjEntry = entryPrice + slippagePerShare + feesPerShare;
  const adjStop = stopPrice - slippagePerShare - feesPerShare;
  const adjT1 = t1Price - slippagePerShare - feesPerShare;
  const adjT2 = t2Price - slippagePerShare - feesPerShare;

  let t1Hit = false;
  let t2Hit = false;
  let stopHit = false;
  let exitPrice = null;
  let exitReason = null;
  let exitBarIdx = null;
  let exitTime = null;

  // Walk forward from the bar after entry
  for (let i = entryBarIdx + 1; i < sessionBars.length; i++) {
    const bar = sessionBars[i];
    const barHigh = toNum(bar.high);
    const barLow = toNum(bar.low);

    // Conservative: check stop FIRST in same bar (worst case for longs)
    if (barLow != null && barLow <= adjStop) {
      stopHit = true;
      exitPrice = adjStop;
      exitReason = 'stop';
      exitBarIdx = i;
      exitTime = bar.time;
      break;
    }

    // Check T1
    if (!t1Hit && barHigh != null && barHigh >= adjT1) {
      t1Hit = true;
    }

    // Check T2
    if (t1Hit && !t2Hit && barHigh != null && barHigh >= adjT2) {
      t2Hit = true;
    }

    // If T1 hit but not T2, check if stop hits afterward in the same bar
    // (already checked stop at the top, so if we get here, stop didn't hit)
    // If T2 hit, the remaining runner position continues with stop
  }

  // If stop hasn't hit by end of day, close at last bar's close
  if (!stopHit) {
    const lastBar = sessionBars[sessionBars.length - 1];
    const lastClose = toNum(lastBar?.close);
    if (lastClose != null) {
      // If T1 and T2 both hit, the runner exits at last close
      if (t1Hit && t2Hit) {
        exitPrice = lastClose - slippagePerShare - feesPerShare;
        exitReason = 'end_of_day';
        exitBarIdx = sessionBars.length - 1;
        exitTime = lastBar.time;
      } else if (t1Hit) {
        // T1 hit but T2 didn't — remaining 2/3 exits at last close
        exitPrice = lastClose - slippagePerShare - feesPerShare;
        exitReason = 'end_of_day';
        exitBarIdx = sessionBars.length - 1;
        exitTime = lastBar.time;
      } else {
        // Neither T1 nor T2 hit — exit at last close
        exitPrice = lastClose - slippagePerShare - feesPerShare;
        exitReason = 'end_of_day';
        exitBarIdx = sessionBars.length - 1;
        exitTime = lastBar.time;
      }
    } else {
      // No valid close — force stop exit
      stopHit = true;
      exitPrice = adjStop;
      exitReason = 'stop';
      exitBarIdx = entryBarIdx + 1;
    }
  }

  // Compute R-multiple based on protective exit (thirds)
  // Risk per share = |adjEntry - adjStop|
  const actualRisk = Math.abs(adjEntry - adjStop);
  if (actualRisk <= 0) {
    return null; // degenerate trade
  }

  let rMultiple;
  if (stopHit && !t1Hit) {
    // Full stop — all 3 thirds at stop
    rMultiple = -1.0;
  } else if (stopHit && t1Hit && !t2Hit) {
    // T1 hit, then stop — 1/3 at T1 (R=t1Rr), 2/3 at stop (R=-1.0)
    rMultiple = (1 / 3) * t1Rr + (2 / 3) * (-1.0);
  } else if (stopHit && t1Hit && t2Hit) {
    // T1 + T2 hit, then stop on runner — 1/3 at T1, 1/3 at T2, 1/3 at stop
    rMultiple = (1 / 3) * t1Rr + (1 / 3) * t2Rr + (1 / 3) * (-1.0);
  } else if (!stopHit && t1Hit && t2Hit) {
    // T1 + T2 hit, runner exits at end_of_day
    const runnerR = (exitPrice - adjEntry) / actualRisk;
    rMultiple = (1 / 3) * t1Rr + (1 / 3) * t2Rr + (1 / 3) * runnerR;
  } else if (!stopHit && t1Hit && !t2Hit) {
    // T1 hit, remaining exits at end_of_day
    const remainingR = (exitPrice - adjEntry) / actualRisk;
    rMultiple = (1 / 3) * t1Rr + (2 / 3) * remainingR;
  } else {
    // Neither T1 nor T2 — all exits at end_of_day or stop
    rMultiple = (exitPrice - adjEntry) / actualRisk;
  }

  rMultiple = round4(rMultiple);

  // Hold time
  const holdBars = exitBarIdx != null ? exitBarIdx - entryBarIdx : 0;
  const entryTime = sessionBars[entryBarIdx]?.time || 0;
  const holdSeconds = exitTime ? exitTime - entryTime : 0;

  return {
    entryPrice: round4(adjEntry),
    stopPrice: round4(adjStop),
    t1Price: round4(adjT1),
    t2Price: round4(adjT2),
    exitPrice: round4(exitPrice),
    exitReason,
    rMultiple,
    holdBars,
    holdSeconds,
    t1Hit,
    t2Hit,
    stopHit
  };
}

/**
 * Run a backtest over a single symbol's candles.
 *
 * @param {string} symbol
 * @param {object[]} dailyCandles - daily candles for the full period (oldest first)
 * @param {object[]} intradayCandles - 5-min candles for the full period
 * @param {object} config - merged strategy config
 * @param {object} segmentAttrs - attributes to record per trade for segmentation
 * @returns {object[]} trades
 */
function runBacktestForSymbol(symbol, dailyCandles, intradayCandles, config, segmentAttrs) {
  const trades = [];
  if (!dailyCandles || dailyCandles.length < 15) return trades;
  if (!intradayCandles || intradayCandles.length === 0) return trades;

  const intradayByDay = groupByDay(intradayCandles);
  const dailyByDate = new Map();
  for (const c of dailyCandles) {
    const key = toDateStr(c.time);
    dailyByDate.set(key, c);
  }

  // Sort daily candles by time (oldest first)
  const sortedDaily = [...dailyCandles].sort((a, b) => a.time - b.time);

  // For each trading day (skip first 15 for indicator warmup)
  for (let dayIdx = 15; dayIdx < sortedDaily.length; dayIdx++) {
    const dayCandle = sortedDaily[dayIdx];
    const dateStr = toDateStr(dayCandle.time);
    const sessionBars = intradayByDay.get(dateStr);

    if (!sessionBars || sessionBars.length < 3) continue;

    // Previous day's close (no lookahead)
    const prevDaily = sortedDaily[dayIdx - 1];
    const prevClose = toNum(prevDaily.close);
    if (prevClose == null || prevClose <= 0) continue;

    // Daily candles up to previous day for ATR/EMA (no lookahead)
    const dailyUpToPrev = sortedDaily.slice(0, dayIdx);
    const atr = calculateATR(dailyUpToPrev, 14);
    if (atr == null || atr <= 0) continue;

    // EMA values for trend regime
    const closesUpToPrev = dailyUpToPrev.map(c => toNum(c.close)).filter(v => v != null);
    const ema9 = closesUpToPrev.length >= 9 ? calculateEMA(closesUpToPrev, 9) : null;
    const ema20 = closesUpToPrev.length >= 20 ? calculateEMA(closesUpToPrev, 20) : null;
    const trendRegime = ema9 != null && ema20 != null
      ? (ema9 > ema20 ? 'uptrend' : 'downtrend')
      : 'insufficient_data';
    const volatilityRegime = calculateVolatilityRegime(atr, toNum(dayCandle.open) || prevClose);
    const volRegimeLabel = volatilityRegime ? volatilityRegime.regime : 'unknown';

    // Gap from today's open vs yesterday's close
    const dayOpen = toNum(dayCandle.open);
    if (dayOpen == null) continue;
    const gapPct = calculateGapPct(dayOpen, prevClose);
    if (gapPct == null || gapPct < (config.minGapPct || 3.0)) continue;

    // Average daily volume (from prior 20 days — no lookahead)
    const avgDailyVol = dailyUpToPrev.slice(-20).reduce((s, c) => s + (toNum(c.volume) || 0), 0) / Math.min(20, dailyUpToPrev.length);

    // Walk through intraday bars to find VWAP reclaim
    let wasBelowVwap = false;
    let cumulativeIntradayVol = 0;
    for (let barIdx = 0; barIdx < sessionBars.length; barIdx++) {
      const barVol = toNum(sessionBars[barIdx].volume) || 0;
      cumulativeIntradayVol += barVol;

      const barsUpToCurrent = sessionBars.slice(0, barIdx + 1);
      const vwap = calculateSessionVWAP(barsUpToCurrent);
      if (!vwap) continue;

      const currentClose = toNum(sessionBars[barIdx].close);
      if (currentClose == null) continue;

      // RVOL from intraday cumulative volume (no full-day lookahead)
      const rvol = avgDailyVol > 0 ? cumulativeIntradayVol / avgDailyVol : null;

      // Track if price was below VWAP
      if (currentClose < vwap) {
        wasBelowVwap = true;
      }

      // Check reclaim: was below at some earlier bar, now above
      if (!wasBelowVwap) continue;
      if (currentClose <= vwap) continue;

      const vwapDist = ((currentClose - vwap) / vwap) * 100;
      if (vwapDist < (config.minVwapDistancePct || 0.1)) continue;
      if (vwapDist > (config.maxVwapDistancePct || 5)) continue;

      // RVOL filter (when available)
      if (rvol != null && rvol < (config.minRvol || 2.0)) continue;

      // ── Signal fires! Compute entry, stop, targets ──
      const entryPrice = currentClose;

      // Price filter (minPrice = penny-stock threshold)
      if (entryPrice < (config.minPrice || 5)) {
        // Still record as a penny-stock signal, but skip for backtest
        continue;
      }

      const stopPrice = entryPrice - (atr * (config.stopAtrMultiplier || 1.5));
      if (stopPrice >= entryPrice) continue;

      const risk = entryPrice - stopPrice;
      const t1Price = entryPrice + (risk * (config.t1RrTarget || 2.0));
      const t2Price = entryPrice + (risk * (config.t2RrTarget || 4.0));

      // Simulate the trade through remaining bars
      const trade = simulateTrade({
        entryPrice,
        stopPrice,
        t1Price,
        t2Price,
        entryBarIdx: barIdx
      }, sessionBars, config);

      if (!trade) continue;

      // Record segmentation attributes
      const isPenny = entryPrice < (config.minPrice || 5);
      const tradeRecord = {
        symbol,
        direction: 'long',
        entryDate: dateStr,
        entryTime: sessionBars[barIdx].time,
        entryPrice: trade.entryPrice,
        stopPrice: trade.stopPrice,
        t1Price: trade.t1Price,
        t2Price: trade.t2Price,
        exitPrice: trade.exitPrice,
        exitTime: trade.exitTime,
        exitReason: trade.exitReason,
        rMultiple: trade.rMultiple,
        holdBars: trade.holdBars,
        holdSeconds: trade.holdSeconds,
        t1Hit: trade.t1Hit,
        t2Hit: trade.t2Hit,
        stopHit: trade.stopHit,
        gapPct: round4(gapPct),
        rvol: rvol != null ? round4(rvol) : null,
        catalystStrength: segmentAttrs?.catalystStrength || null,
        catalystType: segmentAttrs?.catalystType || null,
        marketRegime: trendRegime,
        volatilityRegime: volRegimeLabel,
        liquidityRating: segmentAttrs?.liquidityRating || null,
        dilutionRiskLevel: segmentAttrs?.dilutionRiskLevel || null,
        pennyStock: isPenny,
        strategyVersion: segmentAttrs?.strategyVersion || 'unknown',
        segmentData: {
          gapBucket: gapBucket(gapPct),
          rvolBucket: rvolBucket(rvol),
          catalystStrengthBucket: catalystStrengthBucket(segmentAttrs?.catalystStrength),
          catalystType: segmentAttrs?.catalystType || 'none',
          marketRegime: trendRegime,
          volatilityRegime: volRegimeLabel,
          liquidityRating: segmentAttrs?.liquidityRating || 'unknown',
          dilutionRiskLevel: segmentAttrs?.dilutionRiskLevel || 'unknown',
          pennyStock: isPenny,
          strategyVersion: segmentAttrs?.strategyVersion || 'unknown'
        }
      };

      trades.push(tradeRecord);

      // Only one trade per symbol per day (avoid overlapping signals)
      break;
    }
  }

  return trades;
}

// ─── Metrics Computation ──────────────────────────────────────────────────

/**
 * Compute all required metrics from a list of trades.
 * Pure — no I/O. Returns all metrics even for small samples (sample size shown).
 */
function computeMetrics(trades) {
  if (!trades || trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      avgWinnerR: 0,
      avgLoserR: 0,
      expectancyR: 0,
      profitFactor: 0,
      cumulativeR: 0,
      maxDrawdownR: 0,
      maxConsecutiveLosses: 0,
      avgHoldBars: 0,
      medianHoldBars: 0,
      avgHoldSeconds: 0,
      medianHoldSeconds: 0,
      t1HitRate: 0,
      t2HitRate: 0,
      stopHitRate: 0,
      sampleSize: 0,
      sufficient: false
    };
  }

  const n = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalWinR = 0;
  let totalLossR = 0;
  let totalAbsLossR = 0;
  let cumulativeR = 0;
  let peakR = 0;
  let maxDD = 0;
  let currentConsecLosses = 0;
  let maxConsecLosses = 0;
  let t1Hits = 0;
  let t2Hits = 0;
  let stopHits = 0;
  const holdBarsList = [];
  const holdSecondsList = [];

  for (const t of trades) {
    const r = toNum(t.rMultiple) || 0;

    if (r > 0.001) {
      wins++;
      totalWinR += r;
      currentConsecLosses = 0;
    } else if (r < -0.001) {
      losses++;
      totalLossR += r;
      totalAbsLossR += Math.abs(r);
      currentConsecLosses++;
      if (currentConsecLosses > maxConsecLosses) maxConsecLosses = currentConsecLosses;
    } else {
      breakeven++;
      currentConsecLosses = 0;
    }

    cumulativeR += r;
    if (cumulativeR > peakR) peakR = cumulativeR;
    const dd = peakR - cumulativeR;
    if (dd > maxDD) maxDD = dd;

    if (t.t1Hit) t1Hits++;
    if (t.t2Hit) t2Hits++;
    if (t.stopHit) stopHits++;

    holdBarsList.push(t.holdBars || 0);
    holdSecondsList.push(t.holdSeconds || 0);
  }

  const avgWinnerR = wins > 0 ? round4(totalWinR / wins) : 0;
  const avgLoserR = losses > 0 ? round4(totalLossR / losses) : 0;
  const profitFactor = totalAbsLossR > 0 ? round4(totalWinR / totalAbsLossR) : (totalWinR > 0 ? Infinity : 0);
  const winRate = round2((wins / n) * 100);

  // Sort hold times for median
  const sortedBars = [...holdBarsList].sort((a, b) => a - b);
  const sortedSeconds = [...holdSecondsList].sort((a, b) => a - b);
  const median = (arr) => {
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? round2((arr[mid - 1] + arr[mid]) / 2) : arr[mid];
  };

  return {
    totalTrades: n,
    wins,
    losses,
    breakeven,
    winRate,
    avgWinnerR,
    avgLoserR,
    expectancyR: round4(cumulativeR / n),
    profitFactor: profitFactor === Infinity ? null : profitFactor,
    cumulativeR: round4(cumulativeR),
    maxDrawdownR: round4(maxDD),
    maxConsecutiveLosses: maxConsecLosses,
    avgHoldBars: round2(holdBarsList.reduce((a, b) => a + b, 0) / n),
    medianHoldBars: median(sortedBars),
    avgHoldSeconds: round2(holdSecondsList.reduce((a, b) => a + b, 0) / n),
    medianHoldSeconds: median(sortedSeconds),
    t1HitRate: round2((t1Hits / n) * 100),
    t2HitRate: round2((t2Hits / n) * 100),
    stopHitRate: round2((stopHits / n) * 100),
    sampleSize: n,
    sufficient: n >= MIN_SAMPLE_SIZE
  };
}

const MIN_SAMPLE_SIZE = 10;

// ─── Segmentation ─────────────────────────────────────────────────────────

/**
 * Segment trades by a given dimension and compute metrics for each segment.
 *
 * @param {object[]} trades
 * @param {string} dimension - one of: gapBucket, rvolBucket, catalystStrength, catalystType,
 *                              marketRegime, volatilityRegime, liquidityRating, dilutionRiskLevel,
 *                              pennyStock, strategyVersion
 * @returns {object} map of segmentValue → metrics
 */
function segmentTrades(trades, dimension) {
  if (!trades || trades.length === 0) return {};

  const groups = {};
  for (const t of trades) {
    let key;
    if (dimension === 'catalystStrength') {
      key = t.segmentData?.catalystStrengthBucket || 'unknown';
    } else if (dimension === 'pennyStock') {
      key = String(t.pennyStock);
    } else {
      key = t.segmentData?.[dimension] ?? t[dimension] ?? 'unknown';
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  const result = {};
  for (const [key, groupTrades] of Object.entries(groups)) {
    result[key] = computeMetrics(groupTrades);
  }
  return result;
}

/**
 * Segment trades by all supported dimensions.
 */
function segmentAll(trades) {
  const dimensions = [
    'gapBucket', 'rvolBucket', 'catalystStrength', 'catalystType',
    'marketRegime', 'volatilityRegime', 'liquidityRating',
    'dilutionRiskLevel', 'pennyStock', 'strategyVersion'
  ];
  const result = {};
  for (const dim of dimensions) {
    result[dim] = segmentTrades(trades, dim);
  }
  return result;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Run a full backtest.
 *
 * @param {object} params
 * @param {object[]} params.dailyCandles - daily candles: [{ time, open, high, low, close, volume }]
 * @param {object[]} params.intradayCandles - 5-min candles: [{ time, open, high, low, close, volume }]
 * @param {object} params.config - merged strategy config
 * @param {string} params.symbol - stock symbol
 * @param {object} [params.segmentAttrs] - extra segmentation attributes (catalyst, dilution, etc.)
 * @returns {{ trades: object[], metrics: object, segmentedMetrics: object }}
 */
function runBacktest({ dailyCandles, intradayCandles, config, symbol, segmentAttrs }) {
  const trades = runBacktestForSymbol(symbol, dailyCandles, intradayCandles, config, segmentAttrs);
  const metrics = computeMetrics(trades);
  const segmentedMetrics = segmentAll(trades);
  return { trades, metrics, segmentedMetrics };
}

/**
 * Run a backtest across multiple symbols.
 *
 * @param {object} params
 * @param {Map<string, { dailyCandles: object[], intradayCandles: object[] }>} params.symbolData
 * @param {object} params.config
 * @param {object} [params.segmentAttrsBySymbol] - Map of symbol → segmentAttrs
 * @returns {{ trades: object[], metrics: object, segmentedMetrics: object }}
 */
function runBacktestMulti({ symbolData, config, segmentAttrsBySymbol }) {
  const allTrades = [];
  for (const [symbol, data] of symbolData) {
    const segAttrs = segmentAttrsBySymbol?.get(symbol) || { strategyVersion: config.strategyVersion || 'unknown' };
    const { trades } = runBacktest({
      dailyCandles: data.dailyCandles,
      intradayCandles: data.intradayCandles,
      config,
      symbol,
      segmentAttrs: segAttrs
    });
    allTrades.push(...trades);
  }
  const metrics = computeMetrics(allTrades);
  const segmentedMetrics = segmentAll(allTrades);
  return { trades: allTrades, metrics, segmentedMetrics };
}

module.exports = {
  runBacktest,
  runBacktestMulti,
  runBacktestForSymbol,
  computeMetrics,
  segmentTrades,
  segmentAll,
  simulateTrade,
  groupByDay,
  toDateStr,
  gapBucket,
  rvolBucket,
  catalystStrengthBucket,
  MIN_SAMPLE_SIZE
};
