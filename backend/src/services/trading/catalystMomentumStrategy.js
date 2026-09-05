/**
 * Catalyst Momentum + VWAP Reclaim Strategy Engine
 *
 * Evaluates scanner candidates for the Catalyst Momentum + VWAP Reclaim setup:
 *   1. Price has reclaimed VWAP (trading above VWAP after being below)
 *   2. A verified catalyst exists (halt, earnings, SEC filing, Form 4)
 *   3. Volume confirmation (RVOL > 1 or strong volume trend)
 *
 * Uses existing infrastructure:
 *   - scanner.js (SETUP_TYPES.VWAP_RECLAIM scoring)
 *   - technicalIndicators.js (VWAP, ATR, EMA, opening range)
 *   - catalystEngine.js (typed catalysts with strength scoring)
 *   - schwabMarketData.js (intraday + daily candles)
 *   - finnhub.js (batch quotes)
 *
 * Entry modes (per PRODUCT_REQUIREMENTS.md):
 *   1. Reclaim candle closes above VWAP, entry above reclaim candle high
 *   2. VWAP reclaim followed by successful VWAP retest/hold
 *
 * The strategy generates a signal and a trade proposal with immutable snapshots.
 * No execution — advisory only.
 */

const db = require('../../config/database');
const logger = require('../../utils/logger');
const schwabMarketData = require('../../utils/schwabMarketData');
const finnhub = require('../../utils/finnhub');
const ti = require('../../utils/technicalIndicators');
const { getCatalystsForSymbols, getStrongestCatalyst } = require('../catalystEngine');
const { assessDilutionRisk } = require('../dilutionRiskEngine');
const { buildFundamentalProfiles } = require('../fundamentalEngine');
const signalService = require('./signalService');
const proposalService = require('./proposalService');
const { evaluateRisk, getAccountContext, getPortfolioRiskContext, persistEvaluation, DEFAULT_RISK_CONFIG } = require('./riskEngine');
const { getStatsForSetupType } = require('./setupStatsService');

const STRATEGY_NAME = 'catalyst_momentum_vwap_reclaim';

// Configurable parameters with defaults. Overridden by strategy.config from DB.
const DEFAULT_CONFIG = {
  minPrice: 5,
  minAvgDailyVolume: 1_000_000,
  minGapPct: 3.0,
  minRvol: 2.0,
  maxSpreadPct: 0.5,
  minRrToT1: 2.0,
  minCatalystStrength: 30,
  maxVwapDistancePct: 5, // too far above VWAP = chasing
  minVwapDistancePct: 0.1, // too close to VWAP = not a clean reclaim
  stopAtrMultiplier: 1.5,
  t1RrTarget: 2.0,
  t2RrTarget: 4.0,
  runnerRrTarget: 8.0,
  maxProposals: 5,
  excludeOtc: true,
  // Risk engine overrides (see riskEngine.DEFAULT_RISK_CONFIG)
  risk: {}
};

function mergeConfig(dbConfig) {
  return { ...DEFAULT_CONFIG, ...(dbConfig || {}) };
}

/**
 * Run the strategy scan on the current universe of scanner candidates.
 * @param {string} strategyId - UUID of the strategy row in trading_strategies
 * @param {object} config - Merged strategy config
 * @param {string} [userId] - Optional user id for account-equity-based position sizing
 * @returns {Promise<{ signals: array, proposals: array }>}
 */
async function runScan(strategyId, config, userId) {
  const cfg = mergeConfig(config);

  // 1. Get current movers from Schwab (reuse the same path as the scanner)
  const moverIndexes = ['$COMPX', '$DJI', '$SPX'];
  const allItems = [];
  for (const indexSymbol of moverIndexes) {
    try {
      const result = await schwabMarketData.getMovers(indexSymbol);
      if (result && result.items) allItems.push(...result.items);
    } catch (err) {
      logger.warn(`[CATALYST-VWAP] Movers fetch failed for ${indexSymbol}: ${err.message}`);
    }
  }

  if (allItems.length === 0) {
    return { signals: [], proposals: [], error: 'No movers data available' };
  }

  // Deduplicate by symbol
  const seen = new Set();
  const deduped = [];
  for (const item of allItems) {
    const sym = item.symbol?.toUpperCase();
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      deduped.push(item);
    }
  }

  // 2. Batch quotes for price filtering
  const symbolsToQuote = deduped.map((i) => i.symbol);
  let quotes = {};
  try {
    quotes = await finnhub.getQuotes(symbolsToQuote);
  } catch (err) {
    logger.warn(`[CATALYST-VWAP] Batch quotes failed: ${err.message}`);
  }

  // 3. Filter by price and volume (universe criteria)
  const candidates = deduped.filter((item) => {
    const q = quotes[item.symbol] || {};
    const price = q.c != null ? Number(q.c) : item.last_price;
    if (price == null || price < cfg.minPrice) return false;
    if (item.total_volume && item.total_volume < cfg.minAvgDailyVolume) return false;
    return true;
  });

  if (candidates.length === 0) {
    return { signals: [], proposals: [], filtered: 'universe' };
  }

  const candidateSymbols = candidates.map((c) => c.symbol);

  // Load account context once for deterministic position sizing.
  const accountContext = await getAccountContext(userId);

  // 4. Get catalysts for all candidates (batched)
  const priceContext = {};
  candidates.forEach((c) => {
    const q = quotes[c.symbol] || {};
    priceContext[c.symbol] = {
      change_percent: q.dp != null ? Number(q.dp) : c.net_percent_change,
      rvol: null
    };
  });
  const catalystMap = await getCatalystsForSymbols(candidateSymbols, priceContext).catch(() => ({}));

  // 5. For each candidate, fetch intraday 5-min candles and compute VWAP
  const signals = [];
  const proposals = [];
  const dataSources = [
    { source: 'schwab', data: 'movers', fetched_at: Date.now() },
    { source: 'schwab', data: 'quotes', fetched_at: Date.now() },
    { source: 'schwab', data: 'intraday_candles_5min', fetched_at: Date.now() },
    { source: 'schwab', data: 'daily_candles', fetched_at: Date.now() }
  ];

  // Process candidates with bounded concurrency (5 at a time)
  const BATCH_SIZE = 5;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (candidate) => {
      const sym = candidate.symbol;
      const q = quotes[sym] || {};
      const lastPrice = q.c != null ? Number(q.c) : candidate.last_price;
      const previousClose = q.pc != null ? Number(q.pc) : null;

      if (!lastPrice) return;

      try {
        // Fetch 5-min intraday candles for VWAP
        const nowSec = Math.floor(Date.now() / 1000);
        const dayStartSec = nowSec - (6 * 60 * 60); // last 6 hours of intraday
        const intradayCandles = await schwabMarketData.getCandles(sym, '5', dayStartSec, nowSec);

        // Fetch daily candles for EMA/ATR/trend context
        const dailyCandles = await schwabMarketData.getPriceHistory(sym, 60);

        if (!intradayCandles || intradayCandles.length < 3) return;

        // Compute indicators
        const indicators = ti.calculateAll({
          dailyCandles: dailyCandles || [],
          intradayCandles: intradayCandles || [],
          lastPrice,
          previousClose,
          bid: q.b != null ? Number(q.b) : null,
          ask: q.a != null ? Number(q.a) : null
        });

        const vwap = indicators.vwap;
        const vwapDist = indicators.vwap_distance;

        // ── Gap filter (require gap >= minGapPct) ──
        const gapPct = indicators.gap_pct;
        if (gapPct == null || gapPct < cfg.minGapPct) return;

        // ── RVOL filter (only when available) ──
        if (indicators.rvol != null && indicators.rvol < cfg.minRvol) return;

        // ── Liquidity / spread filter ──
        const liquidity = indicators.liquidity || {};
        if (liquidity.liquidity_rating === 'very_low') return;
        if (liquidity.spread_pct != null && liquidity.spread_pct > cfg.maxSpreadPct) return;

        // ── Entry condition: VWAP reclaim ──
        if (!vwap || vwapDist == null) return;
        if (vwapDist <= cfg.minVwapDistancePct) return; // not a clean reclaim
        if (vwapDist > cfg.maxVwapDistancePct) return; // too far = chasing

        // ── Catalyst requirement ──
        const catalysts = catalystMap[sym] || [];
        if (catalysts.length === 0) return;
        const strongestCatalyst = getStrongestCatalyst(catalysts);
        if (!strongestCatalyst || strongestCatalyst.strength < cfg.minCatalystStrength) return;

        // ── Determine entry mode ──
        // Mode 1: Reclaim candle closes above VWAP, entry above reclaim candle high
        // Mode 2: VWAP retest/hold (simplified: price near VWAP with support)
        let entryMode = 'reclaim_breakout';
        let entryPrice = lastPrice;

        const recentCandles = intradayCandles.slice(-3);
        const reclaimCandle = recentCandles[recentCandles.length - 1];
        if (reclaimCandle && reclaimCandle.high) {
          entryPrice = Math.max(Number(reclaimCandle.high), lastPrice);
        }

        // If price is close to VWAP (within 0.5%), treat as retest mode
        if (vwapDist < 0.5) {
          entryMode = 'vwap_retest_hold';
          entryPrice = lastPrice;
        }

        // ── Stop loss: ATR-based (from entry price) ──
        const atr = indicators.atr_14;
        const stopPrice = atr
          ? entryPrice - (atr * cfg.stopAtrMultiplier)
          : vwap * 0.99; // fallback: 1% below VWAP

        // ── Targets based on R:R (from entry price) ──
        const risk = entryPrice - stopPrice;
        if (risk <= 0) return;

        const t1Price = entryPrice + (risk * cfg.t1RrTarget);
        const t2Price = entryPrice + (risk * cfg.t2RrTarget);
        const runnerTarget = entryPrice + (risk * cfg.runnerRrTarget);
        const rrRatio = cfg.t1RrTarget;

        // ── Build feature snapshot ──
        const featureSnapshot = {
          vwap,
          vwap_distance_pct: vwapDist,
          last_price: lastPrice,
          previous_close: previousClose,
          gap_pct: gapPct,
          rvol: indicators.rvol,
          ema_9: indicators.ema_9,
          ema_20: indicators.ema_20,
          ema_50: indicators.ema_50,
          trend_regime: indicators.trend_regime,
          atr_14: indicators.atr_14,
          volatility_regime: indicators.volatility_regime,
          opening_range: indicators.opening_range,
          hod: indicators.hod,
          lod: indicators.lod,
          change_percent: priceContext[sym]?.change_percent,
          volume: candidate.volume,
          total_volume: candidate.total_volume,
          liquidity: liquidity,
          entry_mode: entryMode,
          reclaim_candle_high: reclaimCandle?.high || null,
          computed_at: Date.now()
        };

        // ── Create signal ──
        const signal = await signalService.createSignal({
          strategyId,
          symbol: sym,
          direction: 'long',
          signalData: {
            setup_type: 'vwap_reclaim_with_catalyst',
            entry_mode: entryMode,
            vwap_distance_pct: vwapDist,
            catalyst_strength: strongestCatalyst.strength,
            catalyst_type: strongestCatalyst.event_type
          },
          featureSnapshot
        });
        signals.push(signal);

        // ── Build market snapshot ──
        const marketSnapshot = {
          last_price: lastPrice,
          previous_close: previousClose,
          vwap,
          vwap_distance_pct: vwapDist,
          change_percent: priceContext[sym]?.change_percent,
          volume: candidate.volume,
          total_volume: candidate.total_volume,
          bid: q.b ?? null,
          ask: q.a ?? null,
          quote_timestamp: q.t ?? null,
          intraday_candle_count: intradayCandles.length,
          daily_candle_count: dailyCandles?.length || 0,
          computed_at: Date.now()
        };

        // ── Build technical evidence ──
        const technicalEvidence = [
          { indicator: 'vwap', value: vwap, source: 'schwab_5min' },
          { indicator: 'vwap_distance_pct', value: vwapDist },
          { indicator: 'gap_pct', value: gapPct },
          { indicator: 'rvol', value: indicators.rvol },
          { indicator: 'liquidity_rating', value: liquidity.liquidity_rating },
          { indicator: 'spread_pct', value: liquidity.spread_pct },
          { indicator: 'atr_14', value: indicators.atr_14, source: 'schwab_daily' },
          { indicator: 'trend_regime', value: indicators.trend_regime },
          { indicator: 'ema_9', value: indicators.ema_9 },
          { indicator: 'ema_20', value: indicators.ema_20 },
          { indicator: 'opening_range', value: indicators.opening_range },
          { indicator: 'entry_mode', value: entryMode }
        ];

        // ── Catalyst evidence (from existing catalyst engine) ──
        const catalystEvidence = catalysts.slice(0, 5).map((c) => ({
          event_type: c.event_type,
          label: c.label,
          event_time: c.event_time,
          source: c.source,
          source_url: c.source_url,
          strength: c.strength
        }));

        // ── Fundamental evidence (reuse existing engine) ──
        let fundamentalEvidence = [];
        try {
          const profiles = await buildFundamentalProfiles([sym]);
          const profile = profiles[sym];
          if (profile) {
            fundamentalEvidence = [{
              market_cap: profile.market_cap?.value ?? null,
              revenue_growth: profile.revenue_growth?.value ?? null,
              eps_ttm: profile.eps_ttm?.value ?? null,
              is_loss_making: profile.is_loss_making ?? null,
              source: 'finnhub_basic_financials'
            }];
          }
        } catch (err) {
          logger.warn(`[CATALYST-VWAP] Fundamental profile failed for ${sym}: ${err.message}`);
        }

        // ── Dilution risk ──
        const warnings = [];
        try {
          const dilutionMap = await assessDilutionRisk([sym]);
          const dilution = dilutionMap[sym];
          if (dilution && dilution.level !== 'LOW') {
            warnings.push({
              type: 'dilution_risk',
              level: dilution.level,
              reasons: dilution.reasons
            });
          }
        } catch (err) {
          logger.warn(`[CATALYST-VWAP] Dilution check failed for ${sym}: ${err.message}`);
        }

        // ── Deterministic position sizing + risk check ──
        const portfolioCtx = await getPortfolioRiskContext(userId, sym);
        const dilutionLevel = warnings.find((w) => w.type === 'dilution_risk')?.level || null;

        const riskEval = evaluateRisk({
          entryPrice: entryPrice,
          stopPrice: stopPrice,
          t1Price: t1Price,
          t2Price: t2Price,
          direction: 'long',
          accountEquity: accountContext.account_equity,
          strategyVersion: `${STRATEGY_NAME}@v1`,
          spreadPct: liquidity.spread_pct,
          liquidityRating: liquidity.liquidity_rating,
          avgDailyVolume: candidate.total_volume,
          rvol: indicators.rvol,
          dilutionLevel,
          dataAsOf: Date.now(),
          ...portfolioCtx
        }, { ...DEFAULT_RISK_CONFIG, ...(cfg.risk || {}) });

        let positionSize = null;
        let riskAmount = null;
        let proposalRrRatio = rrRatio;
        if (riskEval.state !== 'REJECTED' && riskEval.suggested_shares > 0) {
          positionSize = riskEval.suggested_shares;
          riskAmount = riskEval.total_dollar_risk;
          if (riskEval.rr_t1 != null) {
            proposalRrRatio = riskEval.rr_t1;
          }
        }
        if (riskEval.state === 'REJECTED') {
          warnings.push({
            type: 'risk_rejected',
            reasons: riskEval.rejection_reasons
          });
        }
        if (riskEval.warnings && riskEval.warnings.length) {
          warnings.push({ type: 'risk_warnings', items: riskEval.warnings });
        }

        // ── Empirical win rate from observed trade data ──
        let historicalStats = {};
        try {
          historicalStats = await getStatsForSetupType(userId, 'vwap_reclaim_with_catalyst');
        } catch (err) {
          logger.warn(`[CATALYST-VWAP] Setup stats lookup failed for ${sym}: ${err.message}`);
        }

        // ── Create proposal ──
        // Risk-rejected proposals are still created in SIGNAL_DETECTED state
        // (advisory) — they do NOT auto-promote to READY_FOR_APPROVAL.
        const riskRejected = riskEval.state === 'REJECTED';
        const proposal = await proposalService.createProposal({
          signalId: signal.id,
          strategyId,
          symbol: sym,
          direction: 'long',
          executionMode: 'PAPER',
          entryZone: { low: entryPrice, high: entryPrice * 1.005, mode: entryMode },
          stopPrice: stopPrice.toFixed(4),
          t1Price: t1Price.toFixed(4),
          t2Price: t2Price.toFixed(4),
          runnerTarget: runnerTarget.toFixed(4),
          positionSize,
          riskAmount,
          rrRatio: proposalRrRatio,
          marketSnapshot,
          catalystEvidence,
          technicalEvidence,
          fundamentalEvidence,
          warnings,
          historicalStats,
          dataSources,
          riskState: riskEval.state,
          riskRejected
        });
        proposals.push(proposal);

        // Persist the risk evaluation (reproducible).
        try {
          await persistEvaluation(proposal.id, riskEval);
        } catch (err) {
          logger.warn(`[CATALYST-VWAP] Risk eval persist failed for ${sym}: ${err.message}`);
        }

      } catch (err) {
        logger.warn(`[CATALYST-VWAP] Evaluation failed for ${sym}: ${err.message}`);
      }
    }));
  }

  // Sort proposals by catalyst strength (strongest first)
  proposals.sort((a, b) => {
    const aStrength = (a.catalyst_evidence[0] || {}).strength || 0;
    const bStrength = (b.catalyst_evidence[0] || {}).strength || 0;
    return bStrength - aStrength;
  });

  // Limit proposals
  const limitedProposals = proposals.slice(0, cfg.maxProposals);

  return { signals, proposals: limitedProposals };
}

module.exports = {
  STRATEGY_NAME,
  DEFAULT_CONFIG,
  runScan
};