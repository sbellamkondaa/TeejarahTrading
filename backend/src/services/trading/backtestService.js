/**
 * Backtest Service — Persistence + Candle Fetching Orchestration
 *
 * Fetches historical candles from Schwab, runs the deterministic backtest
 * engine, persists results to PostgreSQL.
 *
 * BACKTEST mode only — no PAPER/LIVE execution, no broker order API calls.
 */

const db = require('../../config/database');
const logger = require('../../utils/logger');
const schwabMarketData = require('../../utils/schwabMarketData');
const strategyService = require('./strategyService');
const engine = require('./backtestEngine');

const DEFAULT_EXECUTION_ASSUMPTIONS = {
  slippagePerShare: 0,
  feesPerShare: 0,
  fillMode: 'close_of_signal_bar',
  endOfDayExit: true,
  intradayResolution: '5min',
  note: 'Entry at signal bar close; stop-first same-bar ambiguity; EOD exit for open trades'
};

const MAX_SYMBOLS = 20;
const MAX_DAYS = 90;

/**
 * Create and run a backtest.
 *
 * @param {object} params
 * @param {string} params.strategyId - UUID of strategy
 * @param {string} params.dateFrom - YYYY-MM-DD
 * @param {string} params.dateTo - YYYY-MM-DD
 * @param {string[]} params.symbols - stock symbols to backtest
 * @param {object} [params.configOverrides] - config overrides merged over strategy.config
 * @param {string} [params.userId] - creating user
 * @returns {Promise<object>} backtest run with metrics
 */
async function createRun({ strategyId, dateFrom, dateTo, symbols, configOverrides, userId }) {
  const strategy = await strategyService.getById(strategyId);
  if (!strategy) throw new Error('Strategy not found');

  // Merge config: defaults ← strategy.config ← overrides
  const DEFAULT_CONFIG = {
    minPrice: 5,
    minAvgDailyVolume: 1_000_000,
    minGapPct: 3.0,
    minRvol: 2.0,
    maxSpreadPct: 0.5,
    minRrToT1: 2.0,
    minCatalystStrength: 30,
    maxVwapDistancePct: 5,
    minVwapDistancePct: 0.1,
    stopAtrMultiplier: 1.5,
    t1RrTarget: 2.0,
    t2RrTarget: 4.0,
    runnerRrTarget: 8.0,
    slippagePerShare: 0,
    feesPerShare: 0
  };
  const config = {
    ...DEFAULT_CONFIG,
    ...(strategy.config || {}),
    ...(configOverrides || {}),
    strategyVersion: `${strategy.name}@v${strategy.version}`
  };

  // Validate date range
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  if (isNaN(from) || isNaN(to)) throw new Error('Invalid date range');
  if (from >= to) throw new Error('dateFrom must be before dateTo');
  const dayDiff = (to - from) / (1000 * 60 * 60 * 24);
  if (dayDiff > MAX_DAYS) throw new Error(`Date range cannot exceed ${MAX_DAYS} days`);

  // Validate symbols
  const cleanSymbols = (symbols || [])
    .map(s => String(s).toUpperCase().trim())
    .filter(s => /^[A-Z][A-Z0-9.\-]{0,15}$/.test(s))
    .slice(0, MAX_SYMBOLS);
  if (cleanSymbols.length === 0) throw new Error('At least one valid symbol required');

  // Create run record
  const runResult = await db.query(
    `INSERT INTO backtest_runs
       (strategy_id, strategy_name, strategy_version, config, date_from, date_to,
        symbols, execution_assumptions, data_sources, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', $10)
     RETURNING *`,
    [
      strategyId,
      strategy.name,
      strategy.version,
      JSON.stringify(config),
      dateFrom,
      dateTo,
      cleanSymbols,
      JSON.stringify(DEFAULT_EXECUTION_ASSUMPTIONS),
      JSON.stringify([
        { source: 'schwab', data: 'daily_candles', note: 'getPriceHistory' },
        { source: 'schwab', data: 'intraday_candles_5min', note: 'getCandles resolution=5' }
      ]),
      userId || null
    ]
  );
  const run = runResult.rows[0];

  try {
    // Fetch candles and run backtest
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);
    const daysBack = Math.ceil(dayDiff) + 30; // extra for indicator warmup

    const allTrades = [];

    for (const symbol of cleanSymbols) {
      try {
        // Daily candles (need extra history for ATR/EMA warmup)
        const dailyCandles = await schwabMarketData.getPriceHistory(symbol, daysBack + 60);
        if (!dailyCandles || dailyCandles.length < 20) {
          logger.warn(`[BACKTEST] Insufficient daily candles for ${symbol}`);
          continue;
        }

        // Intraday 5-min candles for the backtest period
        const intradayCandles = await schwabMarketData.getCandles(symbol, '5', fromTs, toTs);
        if (!intradayCandles || intradayCandles.length === 0) {
          logger.warn(`[BACKTEST] No intraday candles for ${symbol}`);
          continue;
        }

        const segmentAttrs = {
          strategyVersion: `${strategy.name}@v${strategy.version}`,
          catalystStrength: null,
          catalystType: null,
          liquidityRating: null,
          dilutionRiskLevel: null
        };

        const { trades } = engine.runBacktest({
          dailyCandles,
          intradayCandles,
          config,
          symbol,
          segmentAttrs
        });

        allTrades.push(...trades);
      } catch (err) {
        logger.warn(`[BACKTEST] Symbol ${symbol} failed: ${err.message}`);
      }
    }

    // Compute metrics
    const metrics = engine.computeMetrics(allTrades);
    const segmentedMetrics = engine.segmentAll(allTrades);

    // Update run with results
    await db.query(
      `UPDATE backtest_runs
       SET status = 'completed', total_trades = $2, metrics = $3, segmented_metrics = $4,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [run.id, allTrades.length, JSON.stringify(metrics), JSON.stringify(segmentedMetrics)]
    );

    // Persist trades (batch insert)
    if (allTrades.length > 0) {
      await persistTrades(run.id, allTrades);
    }

    // Re-fetch the updated run
    const updated = await getRun(run.id);
    return updated;

  } catch (err) {
    logger.error(`[BACKTEST] Run ${run.id} failed: ${err.message}`);
    await db.query(
      `UPDATE backtest_runs SET status = 'failed', error = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [run.id, err.message]
    );
    throw err;
  }
}

/**
 * Persist trades to the backtest_trades table.
 */
async function persistTrades(runId, trades) {
  for (const t of trades) {
    await db.query(
      `INSERT INTO backtest_trades (
         run_id, symbol, direction, entry_date, entry_time,
         entry_price, stop_price, t1_price, t2_price, exit_price,
         exit_time, exit_reason, r_multiple, hold_bars, hold_seconds,
         t1_hit, t2_hit, stop_hit,
         gap_pct, rvol, catalyst_strength, catalyst_type,
         market_regime, volatility_regime, liquidity_rating,
         dilution_risk_level, penny_stock, strategy_version, segment_data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)`,
      [
        runId, t.symbol, t.direction, t.entryDate, t.entryTime ? new Date(t.entryTime * 1000) : null,
        t.entryPrice, t.stopPrice, t.t1Price, t.t2Price, t.exitPrice,
        t.exitTime ? new Date(t.exitTime * 1000) : null, t.exitReason, t.rMultiple, t.holdBars, t.holdSeconds,
        t.t1Hit, t.t2Hit, t.stopHit,
        t.gapPct || null, t.rvol || null, t.catalystStrength || null, t.catalystType || null,
        t.marketRegime || null, t.volatilityRegime || null, t.liquidityRating || null,
        t.dilutionRiskLevel || null, t.pennyStock, t.strategyVersion, JSON.stringify(t.segmentData || {})
      ]
    );
  }
}

/**
 * Get a backtest run by ID.
 */
async function getRun(runId) {
  const result = await db.query(`SELECT * FROM backtest_runs WHERE id = $1`, [runId]);
  return result.rows[0] || null;
}

/**
 * List backtest runs with optional filters.
 */
async function listRuns({ strategyId, status, limit = 20 } = {}) {
  const params = [];
  const conditions = [];
  if (strategyId) {
    params.push(strategyId);
    conditions.push(`strategy_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  const result = await db.query(
    `SELECT * FROM backtest_runs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

/**
 * Get trades for a backtest run.
 */
async function getRunTrades(runId) {
  const result = await db.query(
    `SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY entry_date, symbol`,
    [runId]
  );
  return result.rows;
}

module.exports = {
  createRun,
  getRun,
  listRuns,
  getRunTrades,
  DEFAULT_EXECUTION_ASSUMPTIONS,
  MAX_SYMBOLS,
  MAX_DAYS
};
