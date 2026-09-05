/**
 * Calibration Engine — Empirical Strategy Statistics + Confidence Intervals
 *
 * Pure functions: no I/O, no fabrication, no lookahead.
 *
 * Combines BACKTEST and PAPER observations without losing source identity.
 * Never fabricates probability — always returns sample size and evidence quality.
 *
 * Statistical methods:
 *   - Wilson score confidence interval for observed win rate (95% CI, z=1.96)
 *   - Evidence quality labels: INSUFFICIENT / LOW / MODERATE / STRONG
 *   - Source separation: BACKTEST and PAPER counts always visible
 *   - Strategy version isolation: never combines incompatible versions
 *
 * All percentages carry sample size + confidence interval.
 * Empirical historical rate is clearly distinct from predicted probability.
 */

// ─── Constants ────────────────────────────────────────────────────────────

const Z_95 = 1.96;

const EVIDENCE_THRESHOLDS = Object.freeze({
  INSUFFICIENT: 0,
  LOW: 10,
  MODERATE: 30,
  STRONG: 100
});

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

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Compute the Wilson score confidence interval for a proportion.
 *
 * This is statistically valid for all sample sizes (including 0 wins),
 * unlike the normal approximation which breaks down at extremes.
 *
 * @param {number} wins - number of successes
 * @param {number} n - total sample size
 * @param {number} [z=1.96] - z-score (95% CI default)
 * @returns {{ lower: number, upper: number, center: number } | null}
 */
function wilsonInterval(wins, n, z = Z_95) {
  if (n <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: round1(Math.max(0, center - margin) * 100),
    upper: round1(Math.min(100, center + margin) * 100),
    center: round1(center * 100)
  };
}

/**
 * Determine evidence quality label from sample size.
 * Deterministic — same sample size → same label.
 *
 * @param {number} n - total sample size
 * @returns {'INSUFFICIENT'|'LOW'|'MODERATE'|'STRONG'}
 */
function evidenceQuality(n) {
  if (n >= EVIDENCE_THRESHOLDS.STRONG) return 'STRONG';
  if (n >= EVIDENCE_THRESHOLDS.MODERATE) return 'MODERATE';
  if (n >= EVIDENCE_THRESHOLDS.LOW) return 'LOW';
  return 'INSUFFICIENT';
}

// ─── Observation Normalization ────────────────────────────────────────────

/**
 * Normalize a raw observation from either BACKTEST or PAPER source
 * into a uniform shape for calibration.
 *
 * @param {object} raw - raw observation
 * @param {'BACKTEST'|'PAPER'} source - data source
 * @returns {object} normalized observation
 */
function normalizeObservation(raw, source) {
  const rMultiple = toNum(raw.r_multiple ?? raw.rMultiple);
  const t1Hit = !!(raw.t1_hit ?? raw.t1Hit);
  const t2Hit = !!(raw.t2_hit ?? raw.t2Hit);
  const stopHit = !!(raw.stop_hit ?? raw.stopHit);
  const isWin = rMultiple != null ? rMultiple > 0 : (raw.is_win ?? raw.isWin ?? false);

  return {
    source: source,
    strategyVersion: raw.strategy_version ?? raw.strategyVersion ?? 'unknown',
    setupType: raw.setup_type ?? raw.setupType ?? null,
    symbol: raw.symbol ?? null,
    entryDate: raw.entry_date ?? raw.entryDate ?? null,
    rMultiple: rMultiple != null ? round4(rMultiple) : null,
    isWin: isWin,
    t1Hit: t1Hit,
    t2Hit: t2Hit,
    stopHit: stopHit,
    holdBars: toNum(raw.hold_bars ?? raw.holdBars) ?? 0,
    holdSeconds: toNum(raw.hold_seconds ?? raw.holdSeconds) ?? 0,
    // Segmentation attributes
    gapPct: toNum(raw.gap_pct ?? raw.gapPct),
    rvol: toNum(raw.rvol),
    catalystStrength: toNum(raw.catalyst_strength ?? raw.catalystStrength),
    catalystType: raw.catalyst_type ?? raw.catalystType ?? null,
    marketRegime: raw.market_regime ?? raw.marketRegime ?? null,
    volatilityRegime: raw.volatility_regime ?? raw.volatilityRegime ?? null,
    liquidityRating: raw.liquidity_rating ?? raw.liquidityRating ?? null,
    dilutionRiskLevel: raw.dilution_risk_level ?? raw.dilutionRiskLevel ?? null,
    pennyStock: !!(raw.penny_stock ?? raw.pennyStock ?? false),
    entryPrice: toNum(raw.entry_price ?? raw.entryPrice),
    // Segment bucket data (pre-computed or computed here)
    segmentData: raw.segment_data ?? raw.segmentData ?? null
  };
}

// ─── Bucketing (reused from backtestEngine approach) ──────────────────────

function gapBucket(gapPct) {
  if (gapPct == null) return 'unknown';
  if (gapPct < 5) return '<5%';
  if (gapPct < 10) return '5-10%';
  return '10%+';
}

function rvolBucket(rvol) {
  if (rvol == null) return 'unknown';
  if (rvol < 5) return '2-5';
  if (rvol < 10) return '5-10';
  return '10+';
}

function catalystStrengthBucket(strength) {
  if (strength == null) return 'unknown';
  if (strength < 40) return 'low';
  if (strength < 70) return 'medium';
  return 'high';
}

function priceBucket(price) {
  if (price == null) return 'unknown';
  if (price < 5) return 'sub-$5';
  if (price < 20) return '$5-$20';
  if (price < 50) return '$20-$50';
  return '$50+';
}

function timeOfDayBucket(entryTime) {
  if (entryTime == null) return 'unknown';
  const hour = new Date(entryTime).getUTCHours();
  if (hour < 14) return 'unknown';
  if (hour < 15) return '9:30-10:00';
  if (hour < 16) return '10:00-11:00';
  if (hour < 17) return '11:00-12:00';
  return 'afternoon';
}

/**
 * Compute segment data for an observation.
 */
function computeSegmentData(obs) {
  if (obs.segmentData) return obs.segmentData;
  return {
    gapBucket: gapBucket(obs.gapPct),
    rvolBucket: rvolBucket(obs.rvol),
    catalystStrengthBucket: catalystStrengthBucket(obs.catalystStrength),
    catalystType: obs.catalystType || 'none',
    marketRegime: obs.marketRegime || 'unknown',
    volatilityRegime: obs.volatilityRegime || 'unknown',
    liquidityRating: obs.liquidityRating || 'unknown',
    dilutionRiskLevel: obs.dilutionRiskLevel || 'unknown',
    priceBucket: priceBucket(obs.entryPrice),
    timeOfDayBucket: obs.entryDate ? timeOfDayBucket(obs.entryDate) : 'unknown',
    pennyStock: String(obs.pennyStock),
    strategyVersion: obs.strategyVersion
  };
}

// ─── Core Statistics ──────────────────────────────────────────────────────

/**
 * Compute full calibration statistics from a set of observations.
 *
 * @param {object[]} observations - normalized observations
 * @returns {object} calibration stats
 */
function computeCalibration(observations) {
  const n = observations.length;
  if (n === 0) {
    return emptyCalibration();
  }

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let t1Hits = 0;
  let t2Hits = 0;
  let stopHits = 0;
  let totalR = 0;
  let totalWinR = 0;
  let totalAbsLossR = 0;
  let peakR = 0;
  let maxDD = 0;
  let cumR = 0;
  let currentConsecLosses = 0;
  let maxConsecLosses = 0;
  const rMultiples = [];
  const holdBarsList = [];
  const holdSecondsList = [];

  let backtestCount = 0;
  let paperCount = 0;

  for (const obs of observations) {
    const r = obs.rMultiple != null ? obs.rMultiple : 0;

    if (r > 0.001) {
      wins++;
      totalWinR += r;
      currentConsecLosses = 0;
    } else if (r < -0.001) {
      losses++;
      totalAbsLossR += Math.abs(r);
      currentConsecLosses++;
      if (currentConsecLosses > maxConsecLosses) maxConsecLosses = currentConsecLosses;
    } else {
      breakeven++;
      currentConsecLosses = 0;
    }

    totalR += r;
    cumR += r;
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDD) maxDD = dd;

    if (obs.t1Hit) t1Hits++;
    if (obs.t2Hit) t2Hits++;
    if (obs.stopHit) stopHits++;

    rMultiples.push(r);
    holdBarsList.push(obs.holdBars || 0);
    holdSecondsList.push(obs.holdSeconds || 0);

    if (obs.source === 'BACKTEST') backtestCount++;
    else if (obs.source === 'PAPER') paperCount++;
  }

  const winRate = round1((wins / n) * 100);
  const ci = wilsonInterval(wins, n);
  const sortedR = [...rMultiples].sort((a, b) => a - b);
  const medianR = sortedR.length > 0
    ? round4(sortedR.length % 2 === 0
        ? (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2
        : sortedR[Math.floor(sortedR.length / 2)])
    : 0;
  const sortedBars = [...holdBarsList].sort((a, b) => a - b);
  const sortedSeconds = [...holdSecondsList].sort((a, b) => a - b);
  const median = (arr) => {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? round2((arr[mid - 1] + arr[mid]) / 2) : arr[mid];
  };
  const profitFactor = totalAbsLossR > 0 ? round4(totalWinR / totalAbsLossR) : (totalWinR > 0 ? null : 0);

  return {
    sampleSize: n,
    backtestCount,
    paperCount,
    wins,
    losses,
    breakeven,
    winRate,
    confidenceInterval: ci,
    t1HitRate: round1((t1Hits / n) * 100),
    t2HitRate: round1((t2Hits / n) * 100),
    stopHitRate: round1((stopHits / n) * 100),
    avgR: round4(totalR / n),
    medianR,
    expectancyR: round4(totalR / n),
    profitFactor,
    cumulativeR: round4(totalR),
    maxDrawdownR: round4(maxDD),
    maxConsecutiveLosses: maxConsecLosses,
    avgHoldBars: round2(holdBarsList.reduce((a, b) => a + b, 0) / n),
    medianHoldBars: median(sortedBars),
    avgHoldSeconds: round2(holdSecondsList.reduce((a, b) => a + b, 0) / n),
    medianHoldSeconds: median(sortedSeconds),
    evidenceQuality: evidenceQuality(n),
    sources: {
      backtest: backtestCount,
      paper: paperCount
    }
  };
}

function emptyCalibration() {
  return {
    sampleSize: 0,
    backtestCount: 0,
    paperCount: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: 0,
    confidenceInterval: null,
    t1HitRate: 0,
    t2HitRate: 0,
    stopHitRate: 0,
    avgR: 0,
    medianR: 0,
    expectancyR: 0,
    profitFactor: 0,
    cumulativeR: 0,
    maxDrawdownR: 0,
    maxConsecutiveLosses: 0,
    avgHoldBars: 0,
    medianHoldBars: 0,
    avgHoldSeconds: 0,
    medianHoldSeconds: 0,
    evidenceQuality: 'INSUFFICIENT',
    sources: { backtest: 0, paper: 0 }
  };
}

// ─── Source Separation ────────────────────────────────────────────────────

/**
 * Split observations by source (BACKTEST vs PAPER).
 * Returns separate calibration for each + combined with source counts visible.
 */
function calibrateBySource(observations) {
  const backtest = observations.filter(o => o.source === 'BACKTEST');
  const paper = observations.filter(o => o.source === 'PAPER');

  return {
    backtest: computeCalibration(backtest),
    paper: computeCalibration(paper),
    combined: computeCalibration(observations)
  };
}

// ─── Segmentation ─────────────────────────────────────────────────────────

const SEGMENT_DIMENSIONS = [
  'gapBucket', 'rvolBucket', 'catalystStrengthBucket', 'catalystType',
  'marketRegime', 'volatilityRegime', 'liquidityRating',
  'dilutionRiskLevel', 'priceBucket', 'timeOfDayBucket', 'strategyVersion'
];

/**
 * Segment observations by a dimension and compute calibration per segment.
 */
function segmentCalibration(observations, dimension) {
  if (!observations || observations.length === 0) return {};

  const groups = {};
  for (const obs of observations) {
    const segData = computeSegmentData(obs);
    const key = segData[dimension] ?? 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(obs);
  }

  const result = {};
  for (const [key, group] of Object.entries(groups)) {
    result[key] = computeCalibration(group);
  }
  return result;
}

/**
 * Segment by all supported dimensions.
 */
function segmentAll(observations) {
  const result = {};
  for (const dim of SEGMENT_DIMENSIONS) {
    result[dim] = segmentCalibration(observations, dim);
  }
  return result;
}

// ─── Strategy Version Isolation ───────────────────────────────────────────

/**
 * Filter observations to a specific strategy version.
 * Never combines incompatible versions.
 */
function filterByVersion(observations, strategyVersion) {
  if (!strategyVersion) return observations;
  return observations.filter(o => o.strategyVersion === strategyVersion);
}

/**
 * Group observations by strategy version, computing calibration per version.
 */
function calibrateByVersion(observations) {
  const groups = {};
  for (const obs of observations) {
    const v = obs.strategyVersion || 'unknown';
    if (!groups[v]) groups[v] = [];
    groups[v].push(obs);
  }

  const result = {};
  for (const [version, group] of Object.entries(groups)) {
    result[version] = computeCalibration(group);
  }
  return result;
}

// ─── Proposal Feature Matching ────────────────────────────────────────────

/**
 * Match a proposal's features to comparable observations.
 *
 * Matching criteria (deterministic, no fabrication):
 *   1. Same strategy version (never cross-version)
 *   2. Same setup type (exact or prefix match)
 *   3. Optionally narrow by segment attributes when sample is sufficient
 *
 * @param {object[]} observations - all observations (backtest + paper)
 * @param {object} proposalFeatures - { strategyVersion, setupType, gapPct, rvol, ... }
 * @returns {object} matched calibration
 */
function calibrateForProposal(observations, proposalFeatures) {
  if (!observations || observations.length === 0) return emptyCalibration();
  if (!proposalFeatures) return emptyCalibration();

  // 1. Filter by strategy version (strict isolation)
  let matched = filterByVersion(observations, proposalFeatures.strategyVersion);
  if (matched.length === 0) return emptyCalibration();

  // 2. Filter by setup type (exact match, then prefix)
  if (proposalFeatures.setupType) {
    const exactMatch = matched.filter(o => o.setupType === proposalFeatures.setupType);
    if (exactMatch.length > 0) {
      matched = exactMatch;
    } else {
      // Prefix match: any observation whose setupType starts with the proposal's
      const prefixMatch = matched.filter(o =>
        o.setupType && (o.setupType.startsWith(proposalFeatures.setupType + '_') ||
                        proposalFeatures.setupType.startsWith(o.setupType + '_'))
      );
      if (prefixMatch.length > 0) matched = prefixMatch;
    }
  }

  // 3. If sufficient sample, optionally narrow by gap bucket
  if (proposalFeatures.gapPct != null && matched.length >= EVIDENCE_THRESHOLDS.LOW) {
    const gBucket = gapBucket(proposalFeatures.gapPct);
    const narrowed = matched.filter(o => {
      const segData = computeSegmentData(o);
      return segData.gapBucket === gBucket;
    });
    if (narrowed.length >= EVIDENCE_THRESHOLDS.LOW) matched = narrowed;
  }

  // 4. If sufficient sample, optionally narrow by RVOL bucket
  if (proposalFeatures.rvol != null && matched.length >= EVIDENCE_THRESHOLDS.LOW) {
    const rBucket = rvolBucket(proposalFeatures.rvol);
    const narrowed = matched.filter(o => {
      const segData = computeSegmentData(o);
      return segData.rvolBucket === rBucket;
    });
    if (narrowed.length >= EVIDENCE_THRESHOLDS.LOW) matched = narrowed;
  }

  const calibration = computeCalibration(matched);
  const bySource = calibrateBySource(matched);

  return {
    ...calibration,
    backtest: bySource.backtest,
    paper: bySource.paper,
    segmented: segmentAll(matched),
    matchedSampleSize: matched.length,
    advisoryOnly: true
  };
}

module.exports = {
  Z_95,
  EVIDENCE_THRESHOLDS,
  wilsonInterval,
  evidenceQuality,
  normalizeObservation,
  computeCalibration,
  calibrateBySource,
  segmentCalibration,
  segmentAll,
  filterByVersion,
  calibrateByVersion,
  calibrateForProposal,
  computeSegmentData,
  gapBucket,
  rvolBucket,
  catalystStrengthBucket,
  priceBucket,
  timeOfDayBucket,
  emptyCalibration,
  SEGMENT_DIMENSIONS
};
