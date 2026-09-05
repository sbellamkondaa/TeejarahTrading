/**
 * Calibration Service — Empirical Strategy Statistics from Persisted Observations
 *
 * Queries BACKTEST trades from backtest_trades and PAPER positions from
 * paper_positions + paper_orders, normalizes them into uniform observations,
 * and runs the calibration engine.
 *
 * No fabrication: insufficient data returns INSUFFICIENT evidence quality.
 * No future-data leakage: all observations are historical (completed trades/positions).
 * Strategy version isolation: never combines incompatible versions.
 * Source separation: BACKTEST and PAPER counts always visible.
 */

const db = require('../../config/database');
const logger = require('../../utils/logger');
const engine = require('./calibrationEngine');

/**
 * Fetch all BACKTEST observations for a strategy.
 * Only completed backtest runs are included.
 */
async function getBacktestObservations({ strategyId, strategyVersion, setupType } = {}) {
  const params = [];
  const conditions = [`br.status = 'completed'`];

  if (strategyId) {
    params.push(strategyId);
    conditions.push(`br.strategy_id = $${params.length}`);
  }
  if (strategyVersion) {
    params.push(strategyVersion);
    conditions.push(`bt.strategy_version = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query(
    `SELECT
        bt.id, bt.run_id, bt.symbol, bt.direction, bt.entry_date, bt.entry_time,
        bt.entry_price, bt.stop_price, bt.t1_price, bt.t2_price, bt.exit_price,
        bt.exit_time, bt.exit_reason, bt.r_multiple, bt.hold_bars, bt.hold_seconds,
        bt.t1_hit, bt.t2_hit, bt.stop_hit,
        bt.gap_pct, bt.rvol, bt.catalyst_strength, bt.catalyst_type,
        bt.market_regime, bt.volatility_regime, bt.liquidity_rating,
        bt.dilution_risk_level, bt.penny_stock, bt.strategy_version,
        bt.segment_data,
        br.id AS run_id, br.strategy_id, br.strategy_name, br.strategy_version AS run_strategy_version
     FROM backtest_trades bt
     JOIN backtest_runs br ON bt.run_id = br.id
     ${where}
     ORDER BY bt.entry_date DESC`,
    params
  );

  return result.rows.map(row => {
    const obs = engine.normalizeObservation({
      r_multiple: row.r_multiple,
      t1_hit: row.t1_hit,
      t2_hit: row.t2_hit,
      stop_hit: row.stop_hit,
      hold_bars: row.hold_bars,
      hold_seconds: row.hold_seconds,
      gap_pct: row.gap_pct,
      rvol: row.rvol,
      catalyst_strength: row.catalyst_strength,
      catalyst_type: row.catalyst_type,
      market_regime: row.market_regime,
      volatility_regime: row.volatility_regime,
      liquidity_rating: row.liquidity_rating,
      dilution_risk_level: row.dilution_risk_level,
      penny_stock: row.penny_stock,
      strategy_version: row.strategy_version,
      segment_data: row.segment_data,
      symbol: row.symbol,
      entry_date: row.entry_date,
      entry_price: row.entry_price
    }, 'BACKTEST');
    // Attach setup_type from the strategy name if available
    obs.setupType = row.strategy_name ? `${row.strategy_name}_v${row.run_strategy_version}` : null;
    return obs;
  });
}

/**
 * Fetch all PAPER observations for a strategy.
 * Only CLOSED positions with realized P&L are included.
 * R-multiple computed from entry/stop prices and realized P&L.
 * T1/T2/stop hit determined from paper_orders.
 */
async function getPaperObservations({ strategyId, strategyVersion } = {}) {
  const params = [];
  const conditions = [`pp.status = 'CLOSED'`];

  if (strategyId) {
    params.push(strategyId);
    conditions.push(`pp.strategy_id = $${params.length}`);
  }
  if (strategyVersion) {
    params.push(strategyVersion);
    conditions.push(`pp.strategy_version = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query(
    `SELECT
        pp.id, pp.proposal_id, pp.signal_id, pp.strategy_id, pp.strategy_version,
        pp.symbol, pp.direction, pp.total_qty, pp.avg_entry_price, pp.realized_pnl,
        pp.opened_at, pp.closed_at,
        tp.stop_price, tp.t1_price, tp.t2_price,
        tp.market_snapshot, tp.technical_evidence, tp.signal_id AS proposal_signal_id,
        ts.name AS strategy_name, ts.version AS run_strategy_version,
        s.signal_data, s.feature_snapshot
     FROM paper_positions pp
     LEFT JOIN trade_proposals tp ON pp.proposal_id = tp.id
     LEFT JOIN trading_strategies ts ON pp.strategy_id = ts.id
     LEFT JOIN trade_signals s ON pp.signal_id = s.id
     ${where}
     ORDER BY pp.opened_at DESC`,
    params
  );

  // Batch-fetch all filled orders for the positions
  const positionIds = result.rows.map(r => r.id);
  let ordersByPosition = new Map();
  if (positionIds.length > 0) {
    const ordersResult = await db.query(
      `SELECT position_id, order_type FROM paper_orders WHERE position_id = ANY($1) AND status = 'FILLED'`,
      [positionIds]
    );
    for (const o of ordersResult.rows) {
      if (!ordersByPosition.has(o.position_id)) ordersByPosition.set(o.position_id, new Set());
      ordersByPosition.get(o.position_id).add(o.order_type);
    }
  }

  // For each position, compute R-multiple and determine T1/T2/stop hits
  const observations = [];
  for (const row of result.rows) {
    const entryPrice = parseFloat(row.avg_entry_price);
    const stopPrice = parseFloat(row.stop_price);
    const realizedPnl = row.realized_pnl != null ? parseFloat(row.realized_pnl) : 0;
    const qty = parseInt(row.total_qty, 10);

    if (entryPrice == null || stopPrice == null || qty == null || qty <= 0) continue;
    if (isNaN(entryPrice) || isNaN(stopPrice) || isNaN(realizedPnl)) continue;

    const riskPerShare = Math.abs(entryPrice - stopPrice);
    if (riskPerShare <= 0) continue;

    const rMultiple = Math.round((realizedPnl / (riskPerShare * qty)) * 10000) / 10000;

    const filledOrderTypes = ordersByPosition.get(row.id) || new Set();

    // Extract features from signal_data / market_snapshot for segmentation
    const signalData = row.signal_data || {};
    const marketSnapshot = row.market_snapshot || {};
    const featureSnapshot = row.feature_snapshot || {};

    const obs = engine.normalizeObservation({
      r_multiple: rMultiple,
      t1_hit: filledOrderTypes.has('t1'),
      t2_hit: filledOrderTypes.has('t2'),
      stop_hit: filledOrderTypes.has('stop') || filledOrderTypes.has('stop_close'),
      hold_bars: 0, // not tracked for paper positions
      hold_seconds: row.closed_at && row.opened_at
        ? Math.floor((new Date(row.closed_at) - new Date(row.opened_at)) / 1000)
        : 0,
      gap_pct: featureSnapshot.gap_pct ?? marketSnapshot.gap_pct ?? null,
      rvol: featureSnapshot.rvol ?? null,
      catalyst_strength: signalData.catalyst_strength ?? null,
      catalyst_type: signalData.catalyst_type ?? null,
      market_regime: featureSnapshot.trend_regime ?? null,
      volatility_regime: featureSnapshot.volatility_regime ?? null,
      liquidity_rating: featureSnapshot.liquidity?.liquidity_rating ?? null,
      dilution_risk_level: null, // not on paper positions
      penny_stock: entryPrice < 5,
      strategy_version: row.strategy_version || `${row.strategy_name}@v${row.run_strategy_version}`,
      symbol: row.symbol,
      entry_date: row.opened_at,
      entry_price: entryPrice
    }, 'PAPER');
    obs.setupType = signalData.setup_type || (row.strategy_name ? `${row.strategy_name}_v${row.run_strategy_version}` : null);
    observations.push(obs);
  }

  return observations;
}

/**
 * Get combined calibration for a setup type / strategy version.
 */
async function getCalibration({ strategyId, strategyVersion, setupType } = {}) {
  const [backtestObs, paperObs] = await Promise.all([
    getBacktestObservations({ strategyId, strategyVersion }),
    getPaperObservations({ strategyId, strategyVersion })
  ]);

  // Filter by setup type if provided
  let allObs = [...backtestObs, ...paperObs];
  if (setupType) {
    const exactMatch = allObs.filter(o => o.setupType === setupType);
    if (exactMatch.length > 0) {
      allObs = exactMatch;
    } else {
      const prefixMatch = allObs.filter(o =>
        o.setupType && (o.setupType.startsWith(setupType + '_') || setupType.startsWith(o.setupType + '_'))
      );
      if (prefixMatch.length > 0) allObs = prefixMatch;
    }
  }

  const calibration = engine.computeCalibration(allObs);
  const bySource = engine.calibrateBySource(allObs);
  const byVersion = engine.calibrateByVersion(allObs);
  const segmented = engine.segmentAll(allObs);

  return {
    ...calibration,
    backtest: bySource.backtest,
    paper: bySource.paper,
    byVersion,
    segmented
  };
}

/**
 * Get calibration for a specific trade proposal.
 * Matches the proposal's strategy version + features to comparable observations.
 */
async function getCalibrationForProposal(proposalId) {
  const proposalResult = await db.query(
    `SELECT tp.*, ts.name AS strategy_name, ts.version AS strategy_version_num,
            s.signal_data, s.feature_snapshot
     FROM trade_proposals tp
     LEFT JOIN trading_strategies ts ON tp.strategy_id = ts.id
     LEFT JOIN trade_signals s ON tp.signal_id = s.id
     WHERE tp.id = $1`,
    [proposalId]
  );

  if (proposalResult.rows.length === 0) return null;
  const proposal = proposalResult.rows[0];

  const strategyVersion = proposal.strategy_version
    || `${proposal.strategy_name}@v${proposal.strategy_version_num}`;
  const signalData = proposal.signal_data || {};
  const featureSnapshot = proposal.feature_snapshot || {};
  const marketSnapshot = proposal.market_snapshot || {};

  const proposalFeatures = {
    strategyVersion,
    setupType: signalData.setup_type || null,
    gapPct: featureSnapshot.gap_pct ?? marketSnapshot.gap_pct ?? null,
    rvol: featureSnapshot.rvol ?? null,
    catalystStrength: signalData.catalyst_strength ?? null,
    catalystType: signalData.catalyst_type ?? null,
    marketRegime: featureSnapshot.trend_regime ?? null
  };

  const [backtestObs, paperObs] = await Promise.all([
    getBacktestObservations({ strategyId: proposal.strategy_id, strategyVersion }),
    getPaperObservations({ strategyId: proposal.strategy_id, strategyVersion })
  ]);

  const allObs = [...backtestObs, ...paperObs];
  return engine.calibrateForProposal(allObs, proposalFeatures);
}

module.exports = {
  getCalibration,
  getCalibrationForProposal,
  getBacktestObservations,
  getPaperObservations
};
