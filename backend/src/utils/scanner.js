/**
 * Deterministic Scanner
 *
 * Screens the mover/candidate universe using deterministic rules BEFORE any AI
 * involvement. Uses the technical indicator engine to evaluate setups.
 *
 * Setups supported:
 * - gap_and_catalyst: Stock gapping with a recent catalyst (halt, earnings, SEC filing)
 * - momentum: Strong directional move with volume confirmation
 * - rvol_surge: Unusual relative volume
 * - vwap_reclaim: Price reclaiming VWAP after trading below
 * - vwap_loss: Price losing VWAP after trading above
 * - opening_range_breakout: Breaking above opening range
 * - opening_range_breakdown: Breaking below opening range
 * - breakout: Breaking above resistance
 * - relative_strength: Outperforming benchmark
 * - earnings_reaction: Moving on earnings day with volume
 *
 * Each candidate gets a deterministic setup score (0-100).
 * No LLM calls. No fabricated data.
 */

const ti = require('./technicalIndicators');

// Setup definitions with scoring weights
const SETUP_TYPES = Object.freeze({
  GAP_AND_CATALYST: 'gap_and_catalyst',
  MOMENTUM: 'momentum',
  RVOL_SURGE: 'rvol_surge',
  VWAP_RECLAIM: 'vwap_reclaim',
  VWAP_LOSS: 'vwap_loss',
  OPENING_RANGE_BREAKOUT: 'opening_range_breakout',
  OPENING_RANGE_BREAKDOWN: 'opening_range_breakdown',
  BREAKOUT: 'breakout',
  RELATIVE_STRENGTH: 'relative_strength',
  EARNINGS_REACTION: 'earnings_reaction',
  UNUSUAL_VOLUME: 'unusual_volume',
  SEC_CATALYST: 'sec_catalyst',
  HALT_RESUMPTION: 'halt_resumption'
});

// Minimum scores to qualify as a candidate
const MIN_CANDIDATE_SCORE = 40;

/**
 * Score a single setup for a given candidate.
 * @param {object} candidate - Mover data with indicators and catalysts
 * @param {string} setupType - One of SETUP_TYPES
 * @returns {{ score: number, triggered: boolean, reason: string }|null}
 */
function scoreSetup(candidate, setupType) {
  const ind = candidate.indicators || {};
  const price = ind.last_price ?? candidate.last_price;
  const gap = ind.gap_pct ?? candidate.gap_pct;
  const rvol = ind.rvol;
  const vwap = ind.vwap;
  const changePct = ind.change_percent ?? candidate.change_percent;
  const volume = ind.volume ?? candidate.volume;
  const catalysts = candidate.catalysts || [];
  const catalystTypes = new Set(catalysts.map(c => c.type));
  const hasEarnings = catalystTypes.has('earnings');
  const hasSecFiling = catalystTypes.has('sec_filing');
  const hasHalt = catalystTypes.has('halt') || candidate.halted;
  const hasHaltResumed = catalystTypes.has('halt_resumed');
  const openingRange = ind.opening_range;
  const supportResistance = ind.support_resistance;
  const relativeStrength = ind.relative_strength;
  const trendRegime = ind.trend_regime;
  const liquidity = ind.liquidity || {};
  const session = candidate.session || '';

  if (!price || price <= 0) return null;

  let score = 0;
  let triggered = false;
  const reasons = [];

  switch (setupType) {
    case SETUP_TYPES.GAP_AND_CATALYST:
      // Requires: gap > 2% AND a catalyst
      if (gap == null || Math.abs(gap) < 2) break;
      if (catalysts.length === 0) break;
      triggered = true;
      score = 30;
      if (Math.abs(gap) > 5) score += 15;
      if (Math.abs(gap) > 10) score += 10;
      if (rvol && rvol > 2) score += 15;
      if (rvol && rvol > 5) score += 10;
      if (liquidity.liquidity_rating === 'high') score += 10;
      if (liquidity.liquidity_rating === 'moderate') score += 5;
      if (hasHalt) { score += 10; reasons.push('Active halt'); }
      if (hasEarnings) { score += 10; reasons.push('Earnings catalyst'); }
      if (hasSecFiling) { score += 5; reasons.push('SEC filing'); }
      reasons.unshift(`Gap ${gap > 0 ? '+' : ''}${gap?.toFixed(1)}% with ${catalysts.length} catalyst(s)`);
      break;

    case SETUP_TYPES.MOMENTUM:
      // Requires: strong directional move (>3%) with volume
      if (changePct == null || Math.abs(changePct) < 3) break;
      triggered = true;
      score = 25;
      if (Math.abs(changePct) > 5) score += 15;
      if (Math.abs(changePct) > 10) score += 10;
      if (rvol && rvol > 1.5) score += 15;
      if (rvol && rvol > 3) score += 10;
      if (trendRegime === 'uptrend' && changePct > 0) score += 10;
      if (trendRegime === 'downtrend' && changePct < 0) score += 10;
      if (liquidity.liquidity_rating === 'high') score += 5;
      reasons.push(`${changePct > 0 ? '+' : ''}${changePct?.toFixed(1)}% move${rvol ? `, RVOL ${rvol.toFixed(1)}x` : ''}`);
      break;

    case SETUP_TYPES.RVOL_SURGE:
      // Requires: RVOL > 2
      if (!rvol || rvol < 2) break;
      triggered = true;
      score = 30;
      if (rvol > 5) score += 20;
      if (rvol > 10) score += 15;
      if (gap != null && Math.abs(gap) > 2) score += 10;
      if (catalysts.length > 0) score += 10;
      if (liquidity.liquidity_rating === 'high') score += 5;
      reasons.push(`RVOL ${rvol.toFixed(1)}x average`);
      break;

    case SETUP_TYPES.VWAP_RECLAIM:
      // Requires: price above VWAP after being below (simplified: vwap_distance > 0)
      if (!vwap || !price) break;
      const vwapDist = ind.vwap_distance;
      if (vwapDist == null || vwapDist <= 0) break;
      if (vwapDist < 0.1) break; // Too close to VWAP
      triggered = true;
      score = 25;
      if (vwapDist > 1) score += 15;
      if (rvol && rvol > 1.5) score += 10;
      if (trendRegime === 'uptrend') score += 10;
      if (changePct && changePct > 0) score += 5;
      reasons.push(`Above VWAP by ${vwapDist?.toFixed(2)}%`);
      break;

    case SETUP_TYPES.VWAP_LOSS:
      // Requires: price below VWAP (bearish setup)
      if (!vwap || !price) break;
      const vwapDistBelow = ind.vwap_distance;
      if (vwapDistBelow == null || vwapDistBelow >= 0) break;
      if (vwapDistBelow > -0.1) break;
      triggered = true;
      score = 25;
      if (vwapDistBelow < -1) score += 15;
      if (rvol && rvol > 1.5) score += 10;
      if (trendRegime === 'downtrend') score += 10;
      if (changePct && changePct < 0) score += 5;
      reasons.push(`Below VWAP by ${Math.abs(vwapDistBelow)?.toFixed(2)}%`);
      break;

    case SETUP_TYPES.OPENING_RANGE_BREAKOUT:
      // Requires: price above opening range high
      if (!openingRange || !openingRange.high) break;
      if (price <= openingRange.high) break;
      triggered = true;
      score = 30;
      const orBreakoutPct = ((price - openingRange.high) / openingRange.high) * 100;
      if (orBreakoutPct > 1) score += 15;
      if (rvol && rvol > 1.5) score += 15;
      if (changePct && changePct > 0) score += 10;
      if (catalysts.length > 0) score += 10;
      reasons.push(`Broke OR high ${openingRange.high?.toFixed(2)} (+${orBreakoutPct?.toFixed(1)}%)`);
      break;

    case SETUP_TYPES.OPENING_RANGE_BREAKDOWN:
      // Requires: price below opening range low
      if (!openingRange || !openingRange.low) break;
      if (price >= openingRange.low) break;
      triggered = true;
      score = 30;
      const orBreakdownPct = ((openingRange.low - price) / openingRange.low) * 100;
      if (orBreakdownPct > 1) score += 15;
      if (rvol && rvol > 1.5) score += 15;
      if (changePct && changePct < 0) score += 10;
      if (catalysts.length > 0) score += 10;
      reasons.push(`Broke OR low ${openingRange.low?.toFixed(2)} (-${orBreakdownPct?.toFixed(1)}%)`);
      break;

    case SETUP_TYPES.BREAKOUT:
      // Requires: price above nearest resistance
      if (!supportResistance || !supportResistance.resistances?.length) break;
      const nearestResistance = supportResistance.resistances[0];
      if (price <= nearestResistance * 1.005) break; // Must be within 0.5% above
      triggered = true;
      score = 25;
      if (rvol && rvol > 1.5) score += 15;
      if (trendRegime === 'uptrend') score += 10;
      if (catalysts.length > 0) score += 10;
      reasons.push(`Breaking resistance ${nearestResistance?.toFixed(2)}`);
      break;

    case SETUP_TYPES.RELATIVE_STRENGTH:
      // Requires: RS > 1.2 (stock outperforming benchmark by 20%+)
      if (!relativeStrength || !relativeStrength.rs) break;
      if (relativeStrength.rs < 1.2) break;
      triggered = true;
      score = 25;
      if (relativeStrength.rs > 2) score += 20;
      if (relativeStrength.rs > 3) score += 10;
      if (trendRegime === 'uptrend') score += 10;
      if (rvol && rvol > 1.5) score += 5;
      reasons.push(`RS ${relativeStrength.rs?.toFixed(2)}x vs benchmark`);
      break;

    case SETUP_TYPES.EARNINGS_REACTION:
      // Requires: earnings catalyst + meaningful move
      if (!hasEarnings) break;
      if (changePct == null || Math.abs(changePct) < 2) break;
      triggered = true;
      score = 30;
      if (Math.abs(changePct) > 5) score += 15;
      if (rvol && rvol > 2) score += 15;
      if (gap != null && Math.abs(gap) > 3) score += 10;
      if (liquidity.liquidity_rating === 'high') score += 5;
      reasons.push(`Earnings reaction: ${changePct > 0 ? '+' : ''}${changePct?.toFixed(1)}%`);
      break;

    case SETUP_TYPES.SEC_CATALYST:
      // Requires: SEC filing catalyst + price reaction
      if (!hasSecFiling) break;
      if (changePct == null || Math.abs(changePct) < 1) break;
      triggered = true;
      score = 25;
      if (Math.abs(changePct) > 3) score += 15;
      if (rvol && rvol > 1.5) score += 10;
      const secFiling = catalysts.find(c => c.type === 'sec_filing');
      if (secFiling) {
        if (['S-1', 'S-3', '424B5'].includes(secFiling.label)) {
          score += 10;
          reasons.push(`Dilution risk: ${secFiling.label}`);
        } else if (['8-K', '10-K', '10-Q'].includes(secFiling.label)) {
          score += 5;
          reasons.push(`${secFiling.label} filing`);
        } else {
          reasons.push(`SEC ${secFiling.label}`);
        }
      }
      break;

    case SETUP_TYPES.HALT_RESUMPTION:
      // Requires: halt resumed + meaningful move
      if (!hasHaltResumed) break;
      if (changePct == null || Math.abs(changePct) < 1) break;
      triggered = true;
      score = 30;
      if (rvol && rvol > 2) score += 15;
      if (gap != null && Math.abs(gap) > 3) score += 10;
      reasons.push(`Halt resumption: ${changePct > 0 ? '+' : ''}${changePct?.toFixed(1)}%`);
      break;

    case SETUP_TYPES.UNUSUAL_VOLUME:
      // Requires: RVOL > 1.5 without other catalysts
      if (!rvol || rvol < 1.5) break;
      triggered = true;
      score = 20;
      if (rvol > 3) score += 15;
      if (rvol > 5) score += 10;
      if (gap != null && Math.abs(gap) > 1) score += 5;
      if (changePct != null && Math.abs(changePct) > 1) score += 5;
      reasons.push(`Unusual volume: ${rvol.toFixed(1)}x avg`);
      break;

    default:
      return null;
  }

  if (!triggered) return null;

  // Cap score at 100
  score = Math.min(score, 100);

  // Liquidity penalty: very low liquidity reduces score
  if (liquidity.liquidity_rating === 'very_low') score -= 10;
  if (liquidity.spread_rating === 'excessive') score -= 10;

  // Penny stock penalty: sub-$5 stocks get penalized unless strong catalyst
  if (price < 5 && catalysts.length === 0) score -= 20;
  if (price < 1) score -= 15;

  score = Math.max(0, Math.min(100, score));

  return {
    score: Math.round(score),
    triggered,
    reason: reasons.join('; '),
    setup_type: setupType
  };
}

/**
 * Evaluate all setups for a candidate and return the best match.
 * @param {object} candidate - Mover data with indicators and catalysts
 * @returns {{ setups: array[], best_setup: object|null, composite_score: number }}
 */
function evaluateCandidate(candidate) {
  const allSetups = Object.values(SETUP_TYPES);
  const triggered = [];

  for (const setupType of allSetups) {
    const result = scoreSetup(candidate, setupType);
    if (result && result.triggered) {
      triggered.push(result);
    }
  }

  // Sort by score descending
  triggered.sort((a, b) => b.score - a.score);

  const bestSetup = triggered[0] || null;
  const compositeScore = bestSetup ? bestSetup.score : 0;

  return {
    setups: triggered,
    best_setup: bestSetup,
    composite_score: compositeScore,
    qualifies: compositeScore >= MIN_CANDIDATE_SCORE
  };
}

/**
 * Scan a list of candidates and return ranked results.
 * @param {object[]} candidates - Array of mover data (with indicators and catalysts)
 * @param {object} options - { minScore, maxResults, excludePennyStocks }
 * @returns {object[]} Ranked candidates with setup scores
 */
function scanCandidates(candidates, options = {}) {
  const minScore = options.minScore ?? MIN_CANDIDATE_SCORE;
  const maxResults = options.maxResults ?? 50;
  const excludePennyStocks = options.excludePennyStocks ?? true;

  const results = [];

  for (const candidate of candidates) {
    const price = candidate.indicators?.last_price ?? candidate.last_price;
    if (excludePennyStocks && price && price < 5) {
      // Skip penny stocks unless they have a strong catalyst
      if (!candidate.catalysts || candidate.catalysts.length === 0) continue;
    }

    const evaluation = evaluateCandidate(candidate);
    if (!evaluation.qualifies) continue;
    if (evaluation.composite_score < minScore) continue;

    results.push({
      symbol: candidate.symbol,
      company_name: candidate.company_name ?? candidate.indicators?.company_name,
      last_price: price,
      change_percent: candidate.indicators?.change_percent ?? candidate.change_percent,
      gap_pct: candidate.indicators?.gap_pct,
      rvol: candidate.indicators?.rvol,
      vwap: candidate.indicators?.vwap,
      trend_regime: candidate.indicators?.trend_regime,
      halted: candidate.halted,
      catalysts: candidate.catalysts || [],
      setups: evaluation.setups,
      best_setup: evaluation.best_setup,
      composite_score: evaluation.composite_score,
      liquidity_rating: candidate.indicators?.liquidity?.liquidity_rating,
      session: candidate.session
    });
  }

  // Sort by composite score descending
  results.sort((a, b) => b.composite_score - a.composite_score);

  return results.slice(0, maxResults);
}

module.exports = {
  SETUP_TYPES,
  MIN_CANDIDATE_SCORE,
  scoreSetup,
  evaluateCandidate,
  scanCandidates
};
