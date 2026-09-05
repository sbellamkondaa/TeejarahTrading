/**
 * Paper Broker — Execution Simulator
 *
 * Simulated paper-trading execution for PAPER-mode trade proposals.
 * No live broker interaction — fills are simulated from current quotes.
 *
 * Execution Adapter Pattern:
 *   PaperExecutionAdapter implements the execution interface.
 *   A future SchwabExecutionAdapter would implement the same interface
 *   with real broker API calls. The proposal/risk/state-machine
 *   interfaces are reusable for LIVE mode.
 *
 * Fill Simulation:
 *   - Marketable limit buy:  fill when ask <= limit_price (fill at ask)
 *   - Non-marketable limit:  stays SUBMITTED until market reaches limit
 *   - Stop sell:             fill when bid <= stop_price (fill at stop_price)
 *   - Limit sell:            fill when bid >= limit_price (fill at bid)
 *   - Slippage:              configurable per-share deduction from fill price
 *   - Partial fills:        configurable fill ratio (default 1.0 = full fill)
 *
 * Protective Exit Invariant:
 *   The total active simulated sell quantity must NEVER exceed the
 *   current long position quantity. Exits are split:
 *     T1: floor(total_qty * 1/3)
 *     T2: floor(total_qty * 1/3)
 *     Stop: total_qty - T1.qty - T2.qty (the runner)
 *   When the stop fills, pending T1/T2 are cancelled and the full
 *   remaining position is exited at the stop price.
 *
 * Safety:
 *   - PAPER execution mode only (LIVE gated behind ENABLE_LIVE_TRADING)
 *   - Short selling disabled
 *   - Risk revalidation required before entry (stale/rejected → reject)
 *   - No position quantity increase above approved risk size
 *   - No averaging down, no martingale
 *   - Never places live broker orders
 *
 * Reconciliation:
 *   PostgreSQL is the source of truth. All order/position state is
 *   reconstructable from paper_orders and paper_positions tables.
 *   Redis is never authoritative for order/position state.
 */

const crypto = require('crypto');
const db = require('../../config/database');
const finnhub = require('../../utils/finnhub');
const proposalService = require('./proposalService');
const auditService = require('./auditService');
const journalSync = require('./journalSyncService');
const { isEvaluationStale, getLatestEvaluation, canBecomeReadyForApproval } = require('./riskEngine');
const paperAccount = require('./paperAccountService');
const {
  assertOrderTransition,
  assertOrderTransitionFromAny,
  assertPositionTransition
} = require('./stateMachine');

// ── Configuration ──

const FILL_CONFIG = {
  slippagePerShare: 0.00,       // default: no slippage in paper simulation
  partialFillRatio: 1.0         // default: full fill (1.0 = no partial fills)
};

// ── Utilities ──

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function computePnl(direction, entryPrice, exitPrice, qty) {
  if (direction === 'long') {
    return round2((exitPrice - entryPrice) * qty);
  }
  return round2((entryPrice - exitPrice) * qty);
}

function fillPriceForBuy(quote, slippage = 0) {
  if (!quote) return null;
  const ask = toNum(quote.ask);
  if (ask != null && ask > 0) return round4(ask + slippage);
  const c = toNum(quote.c);
  if (c != null && c > 0) return round4(c + slippage);
  return null;
}

function fillPriceForSell(quote, slippage = 0) {
  if (!quote) return null;
  const bid = toNum(quote.bid);
  if (bid != null && bid > 0) return round4(bid - slippage);
  const c = toNum(quote.c);
  if (c != null && c > 0) return round4(c - slippage);
  return null;
}

function generateClientOrderId() {
  return crypto.randomUUID();
}

/**
 * Check if a limit buy order is marketable given current quote.
 * Marketable: limit_price >= current ask → fill at ask.
 */
function isLimitBuyMarketable(limitPrice, quote) {
  const ask = toNum(quote?.ask);
  if (ask == null) {
    const c = toNum(quote?.c);
    return c != null && limitPrice >= c;
  }
  return limitPrice >= ask;
}

/**
 * Check if a limit sell order is marketable given current quote.
 * Marketable: limit_price <= current bid → fill at bid.
 */
function isLimitSellMarketable(limitPrice, quote) {
  const bid = toNum(quote?.bid);
  if (bid == null) {
    const c = toNum(quote?.c);
    return c != null && limitPrice <= c;
  }
  return limitPrice <= bid;
}

/**
 * Check if a stop sell order is triggerable given current quote.
 * Triggered: current bid <= stop_price (price dropped to stop).
 */
function isStopSellTriggered(stopPrice, quote) {
  const bid = toNum(quote?.bid) || toNum(quote?.c);
  return bid != null && bid <= stopPrice;
}

// ── Fill Simulation ──

/**
 * Simulate a fill for a buy order.
 * Returns { fillPrice, fillQty, status } or null if not fillable.
 */
function simulateBuyFill(order, quote, config = FILL_CONFIG) {
  const slippage = toNum(config.slippagePerShare) || 0;
  const limitPrice = toNum(order.limit_price);

  if (order.order_type === 'entry') {
    // Entry: marketable limit buy at ask
    const fp = fillPriceForBuy(quote, slippage);
    if (fp == null) return null;
    if (limitPrice != null && fp > limitPrice) {
      // Non-marketable: limit below ask, stays pending
      return { fillPrice: null, fillQty: 0, status: 'SUBMITTED' };
    }
    const fillQty = Math.floor(order.quantity * (toNum(config.partialFillRatio) || 1.0));
    return { fillPrice: fp, fillQty: Math.min(fillQty, order.quantity), status: fillQty >= order.quantity ? 'FILLED' : 'PARTIALLY_FILLED' };
  }

  return null;
}

/**
 * Simulate a fill for a sell order (T1, T2, stop, manual_close).
 */
function simulateSellFill(order, quote, config = FILL_CONFIG) {
  const slippage = toNum(config.slippagePerShare) || 0;

  if (order.order_type === 't1' || order.order_type === 't2') {
    const limitPrice = toNum(order.limit_price);
    if (limitPrice == null) return null;
    if (!isLimitSellMarketable(limitPrice, quote)) {
      return { fillPrice: null, fillQty: 0, status: 'SUBMITTED' };
    }
    const fp = fillPriceForSell(quote, slippage);
    if (fp == null) return null;
    const fillQty = Math.floor(order.quantity * (toNum(config.partialFillRatio) || 1.0));
    return { fillPrice: fp, fillQty: Math.min(fillQty, order.quantity), status: fillQty >= order.quantity ? 'FILLED' : 'PARTIALLY_FILLED' };
  }

  if (order.order_type === 'stop') {
    const stopPrice = toNum(order.stop_price);
    if (stopPrice == null) return null;
    if (!isStopSellTriggered(stopPrice, quote)) {
      return { fillPrice: null, fillQty: 0, status: 'SUBMITTED' };
    }
    // Stop triggered: fill at stop price (worst case) or bid, whichever is worse
    const bid = toNum(quote?.bid) || toNum(quote?.c);
    const fp = round4(Math.min(stopPrice, bid) - slippage);
    if (fp <= 0) return null;
    return { fillPrice: fp, fillQty: order.quantity, status: 'FILLED' };
  }

  if (order.order_type === 'manual_close') {
    const fp = fillPriceForSell(quote, slippage);
    if (fp == null) return null;
    return { fillPrice: fp, fillQty: order.quantity, status: 'FILLED' };
  }

  if (order.order_type === 'stop_close') {
    // Triggered by stop fill: sell remaining at stop price
    const stopPrice = toNum(order.stop_price);
    const fp = stopPrice != null ? round4(stopPrice - slippage) : fillPriceForSell(quote, slippage);
    if (fp == null || fp <= 0) return null;
    return { fillPrice: fp, fillQty: order.quantity, status: 'FILLED' };
  }

  return null;
}

// ── Protective Exit Calculation ──

/**
 * Compute protective exit quantities from total position size.
 * Split: T1 = floor(total/3), T2 = floor(total/3), Stop = total - T1 - T2 (runner)
 */
function computeExitQuantities(totalQty) {
  const t1Qty = Math.floor(totalQty / 3);
  const t2Qty = Math.floor(totalQty / 3);
  const stopQty = totalQty - t1Qty - t2Qty;
  return { t1Qty, t2Qty, stopQty };
}

/**
 * Hard invariant: total active sell quantity must never exceed remaining_qty.
 * Returns true if the invariant is satisfied.
 */
function checkSellInvariant(position, activeSellOrders) {
  if (!position) return true;
  const activeSellQty = activeSellOrders
    .filter(o => o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED')
    .reduce((sum, o) => sum + (o.quantity - o.filled_qty), 0);
  return activeSellQty <= position.remaining_qty;
}

// ── Idempotent Order Submission ──

async function findExistingEntry(proposalId) {
  const result = await db.query(
    `SELECT * FROM paper_orders
     WHERE proposal_id = $1 AND order_type = 'entry'
     ORDER BY created_at DESC LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

// ── PaperExecutionAdapter ──

/**
 * Submit a paper entry for an APPROVED proposal.
 *
 * Gating:
 *   - proposal must be APPROVED
 *   - execution_mode must be PAPER
 *   - direction must be long (short selling disabled)
 *   - position_size must be positive
 *   - risk evaluation must be VALID or WATCH, not stale
 *   - no existing entry order for this proposal (idempotent)
 *
 * Flow:
 *   APPROVED → ENTRY_SUBMITTED → (fill check) → ENTRY_FILLED → POSITION_ACTIVE
 *   or: APPROVED → ENTRY_SUBMITTED (non-marketable limit, stays pending)
 *
 * @returns { order, position, fillPrice, status }
 */
async function submitEntry(proposalId, userId, options = {}) {
  const proposal = await proposalService.getById(proposalId);
  if (!proposal) throw new Error('Proposal not found');

  if (proposal.lifecycle_state !== 'APPROVED') {
    throw new Error(`Proposal must be APPROVED to submit paper entry (current: ${proposal.lifecycle_state})`);
  }

  if (proposal.execution_mode !== 'PAPER') {
    throw new Error('Paper entry requires PAPER execution mode');
  }

  if (proposal.direction === 'short') {
    throw new Error('Short selling is disabled — paper short entry rejected');
  }

  const qty = toNum(proposal.position_size);
  if (qty == null || qty <= 0) {
    throw new Error('Position size is missing or zero — cannot submit entry');
  }

  // Idempotency: if an entry order already exists for this proposal, return it
  const existing = await findExistingEntry(proposalId);
  if (existing) {
    return {
      order: existing,
      position: await getPosition(proposalId),
      fillPrice: toNum(existing.avg_fill_price),
      status: existing.status,
      idempotent: true
    };
  }

  // Risk gating: evaluation must be VALID or WATCH, not stale
  const evaluation = await getLatestEvaluation(proposalId);
  if (!canBecomeReadyForApproval(evaluation)) {
    throw new Error('Risk evaluation is REJECTED or missing — recalculate before entry');
  }
  if (isEvaluationStale(evaluation, proposal)) {
    throw new Error('Risk evaluation is stale — recalculate before entry');
  }

  // PAPER trading halt check — blocks new entries, existing positions remain manageable
  const isHalted = await paperAccount.isPaperTradingHalted();
  if (isHalted) {
    throw new Error('PAPER trading is halted — new entries blocked. Existing positions remain manageable.');
  }

  // Get current quote for fill simulation
  let quote;
  try {
    quote = await finnhub.getQuote(proposal.symbol);
  } catch (err) {
    throw new Error(`Cannot retrieve quote for ${proposal.symbol}: ${err.message}`);
  }

  if (!quote) {
    throw new Error(`No quote available for ${proposal.symbol} — cannot simulate entry`);
  }

  // Determine entry limit price from proposal entry_zone
  const entryHigh = toNum(proposal.entry_zone?.high);
  const entryLow = toNum(proposal.entry_zone?.low);
  const limitPrice = entryHigh || entryLow || fillPriceForBuy(quote);
  if (limitPrice == null || limitPrice <= 0) {
    throw new Error(`Cannot determine entry limit price for ${proposal.symbol}`);
  }

  const clientOrderId = generateClientOrderId();
  const config = { ...FILL_CONFIG, ...options };

  await proposalService.transitionState(proposalId, 'ENTRY_SUBMITTED', userId);

  // Create the entry order (SUBMITTED status)
  const orderResult = await db.query(
    `INSERT INTO paper_orders (
       client_order_id, proposal_id, signal_id, strategy_id, strategy_version,
       symbol, side, order_type, execution_mode, quantity, limit_price, status, submitted_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, 'buy', 'entry', 'PAPER', $7, $8, 'SUBMITTED', CURRENT_TIMESTAMP
     ) RETURNING *`,
    [
      clientOrderId, proposalId, proposal.signal_id, proposal.strategy_id,
      `${proposal.strategy_id}@v1`,
      proposal.symbol, qty, limitPrice
    ]
  );
  const order = orderResult.rows[0];

  // Simulate fill
  const fill = simulateBuyFill(order, quote, config);
  let position = null;
  let fillPrice = null;

  if (fill && fill.fillPrice != null && fill.fillQty > 0) {
    // Entry filled — create position and fill the order
    fillPrice = fill.fillPrice;

    const actualFillQty = fill.fillQty;

    const posResult = await db.query(
      `INSERT INTO paper_positions (
         proposal_id, signal_id, strategy_id, strategy_version,
         symbol, direction, total_qty, remaining_qty, avg_entry_price, execution_mode
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $7, $8, 'PAPER'
       ) RETURNING *`,
      [proposalId, proposal.signal_id, proposal.strategy_id,
       `${proposal.strategy_id}@v1`,
       proposal.symbol, proposal.direction, actualFillQty, fillPrice]
    );
    position = posResult.rows[0];

    // Reserve buying power in the PAPER account ledger (based on actual filled qty)
    const positionValue = round2(actualFillQty * fillPrice);
    try {
      await paperAccount.reserveBuyingPower(position.id, positionValue);
    } catch (reserveErr) {
      // If reservation fails (insufficient buying power), roll back the position
      await db.query(`DELETE FROM paper_positions WHERE id = $1`, [position.id]);
      await db.query(
        `UPDATE paper_orders SET status = 'REJECTED', cancelled_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id]
      );
      await proposalService.transitionState(proposalId, 'REJECTED', userId);
      throw new Error(`Paper entry rejected: ${reserveErr.message}`);
    }

    // Update order with fill info
    assertOrderTransition(order.status, 'FILLED');
    await db.query(
      `UPDATE paper_orders
       SET filled_qty = $2, avg_fill_price = $3, status = 'FILLED',
           filled_at = CURRENT_TIMESTAMP, position_id = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [order.id, fill.fillQty, fillPrice, position.id]
    );

    await proposalService.transitionState(proposalId, 'ENTRY_FILLED', userId);
    await proposalService.transitionState(proposalId, 'POSITION_ACTIVE', userId);

    // Create protective exit orders (T1, T2, stop)
    await createProtectiveExits(position, proposal, userId);

    await auditService.recordEvent('paper_entry_filled', 'trade_proposal', proposalId, {
      symbol: proposal.symbol, quantity: fill.fillQty, fill_price: fillPrice,
      position_id: position.id, order_id: order.id, user_id: userId
    });

    // Sync to journal trade (idempotent — creates or updates trade from position state)
    try { await journalSync.syncPositionToJournal(position.id, userId); } catch (e) { console.error('[JOURNAL-SYNC] entry fill:', e.message); }
  } else {
    // Non-marketable: order stays SUBMITTED, position not created yet
    await auditService.recordEvent('paper_entry_submitted', 'trade_proposal', proposalId, {
      symbol: proposal.symbol, quantity: qty, limit_price: limitPrice,
      order_id: order.id, user_id: userId, status: 'SUBMITTED'
    });
  }

  return {
    order: await getOrder(order.id),
    position,
    fillPrice,
    status: fill && fill.fillPrice != null ? 'FILLED' : 'SUBMITTED'
  };
}

/**
 * Create protective exit orders (T1, T2, stop) after entry fill.
 * Quantities are split: T1 = floor(total/3), T2 = floor(total/3), stop = runner.
 *
 * Invariant: T1.qty + T2.qty + stop.qty = total_qty (never exceeds position).
 */
async function createProtectiveExits(position, proposal, userId) {
  const { t1Qty, t2Qty, stopQty } = computeExitQuantities(position.total_qty);

  const orders = [];

  if (t1Qty > 0 && proposal.t1_price) {
    const t1Order = await db.query(
      `INSERT INTO paper_orders (
         client_order_id, position_id, proposal_id, signal_id, strategy_id, strategy_version,
         symbol, side, order_type, execution_mode, quantity, limit_price, status, submitted_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, 'sell', 't1', 'PAPER', $8, $9, 'SUBMITTED', CURRENT_TIMESTAMP
       ) RETURNING *`,
      [generateClientOrderId(), position.id, position.proposal_id,
       position.signal_id, position.strategy_id, position.strategy_version,
       position.symbol, t1Qty, proposal.t1_price]
    );
    orders.push(t1Order.rows[0]);
  }

  if (t2Qty > 0 && proposal.t2_price) {
    const t2Order = await db.query(
      `INSERT INTO paper_orders (
         client_order_id, position_id, proposal_id, signal_id, strategy_id, strategy_version,
         symbol, side, order_type, execution_mode, quantity, limit_price, status, submitted_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, 'sell', 't2', 'PAPER', $8, $9, 'SUBMITTED', CURRENT_TIMESTAMP
       ) RETURNING *`,
      [generateClientOrderId(), position.id, position.proposal_id,
       position.signal_id, position.strategy_id, position.strategy_version,
       position.symbol, t2Qty, proposal.t2_price]
    );
    orders.push(t2Order.rows[0]);
  }

  if (stopQty > 0 && proposal.stop_price) {
    const stopOrder = await db.query(
      `INSERT INTO paper_orders (
         client_order_id, position_id, proposal_id, signal_id, strategy_id, strategy_version,
         symbol, side, order_type, execution_mode, quantity, stop_price, status, submitted_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, 'sell', 'stop', 'PAPER', $8, $9, 'SUBMITTED', CURRENT_TIMESTAMP
       ) RETURNING *`,
      [generateClientOrderId(), position.id, position.proposal_id,
       position.signal_id, position.strategy_id, position.strategy_version,
       position.symbol, stopQty, proposal.stop_price]
    );
    orders.push(stopOrder.rows[0]);
  }

  // Hard invariant check: total active sell <= remaining_qty
  const invariantOk = checkSellInvariant(position, orders);
  if (!invariantOk) {
    throw new Error('Protective exit invariant violated: sell qty exceeds position');
  }

  await auditService.recordEvent('paper_protective_exits_created', 'trade_proposal', position.proposal_id, {
    position_id: position.id, t1_qty: t1Qty, t2_qty: t2Qty, stop_qty: stopQty, user_id: userId
  });

  return orders;
}

/**
 * Process fills for all SUBMITTED sell orders on an open position.
 * This is the "fill check" that simulates the market hitting limit/stop prices.
 *
 * @param positionId - the paper position to process
 * @param userId - for audit
 * @param options - fill config overrides
 */
async function processFills(proposalId, userId, options = {}) {
  const proposal = await proposalService.getById(proposalId);
  if (!proposal) throw new Error('Proposal not found');

  if (['ERROR', 'MANUAL_INTERVENTION_REQUIRED'].includes(proposal.lifecycle_state)) {
    throw new Error(`Cannot process fills — proposal is in ${proposal.lifecycle_state}`);
  }

  if (proposal.execution_mode !== 'PAPER') {
    throw new Error('Process fills requires PAPER execution mode');
  }

  let position = await getPosition(proposalId);
  if (!position || position.status !== 'OPEN') {
    return { fills: [], position_status: position?.status || 'NONE' };
  }

  // Get all active sell orders.
  // Stop-first ordering: when the market could have triggered both the stop
  // and target limits within the same reconciliation cycle (intrabar
  // ambiguity), process the protective stop first. This is the conservative
  // worst-case rule for long positions — we cannot prove target hit before
  // stop from a single quote snapshot, so we assume the adverse outcome.
  // If the stop fills, pending T1/T2 are cancelled and the remaining position
  // is exited at the stop price. Never allows total sell > remaining_qty.
  const activeOrders = await db.query(
    `SELECT * FROM paper_orders
     WHERE position_id = $1 AND side = 'sell'
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED')
     ORDER BY CASE WHEN order_type = 'stop' THEN 0 ELSE 1 END, created_at ASC`,
    [position.id]
  );

  if (activeOrders.rows.length === 0) {
    return { fills: [], position_status: position.status };
  }

  let quote;
  try {
    quote = await finnhub.getQuote(proposal.symbol);
  } catch (err) {
    throw new Error(`Cannot retrieve quote for ${proposal.symbol}: ${err.message}`);
  }

  const config = { ...FILL_CONFIG, ...options };
  const fills = [];
  let positionClosed = false;

  for (const order of activeOrders.rows) {
    if (positionClosed) {
      // Cancel remaining orders if position is closed
      await cancelOrder(order.id, userId);
      continue;
    }

    const fill = simulateSellFill(order, quote, config);
    if (!fill || fill.fillPrice == null || fill.fillQty <= 0) {
      continue;
    }

    // Execute the fill
    const fillResult = await executeSellFill(position, order, fill, proposal, userId);
    fills.push(fillResult);

    // Refresh position state after fill — must use the updated position for
    // the next iteration so remaining_qty is not stale (prevents wrong
    // absolute-set on multi-fill cycles and incorrect status computation).
    position = await getPosition(proposalId);
    if (position.status === 'CLOSED' || position.remaining_qty <= 0) {
      positionClosed = true;
    }
  }

  return {
    fills,
    position_status: positionClosed ? 'CLOSED' : position.status
  };
}

/**
 * Execute a sell fill: update order, update position, handle state transitions.
 * When stop fills, cancel pending T1/T2 and sell remaining at stop price.
 */
async function executeSellFill(position, order, fill, proposal, userId) {
  const fillQty = Math.min(fill.fillQty, order.quantity - (order.filled_qty || 0));
  const fillPrice = fill.fillPrice;

  // Update order fill
  assertOrderTransition(order.status, fill.status);
  const updatedOrder = await db.query(
    `UPDATE paper_orders
     SET filled_qty = $2, avg_fill_price = $3, status = $4,
         filled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING *`,
    [order.id, (order.filled_qty || 0) + fillQty, fillPrice, fill.status]
  );

  // Update position
  const newRemaining = position.remaining_qty - fillQty;
  const pnl = computePnl(position.direction, toNum(position.avg_entry_price), fillPrice, fillQty);
  const newRealizedPnl = round2(toNum(position.realized_pnl) + pnl);
  const newStatus = newRemaining <= 0 ? 'CLOSED' : 'OPEN';
  if (newStatus !== position.status) {
    assertPositionTransition(position.status, newStatus);
  }

  const updatedPosition = await db.query(
    `UPDATE paper_positions
     SET remaining_qty = $2, realized_pnl = $3, status = $4
       ${newStatus === 'CLOSED' ? ', closed_at = CURRENT_TIMESTAMP' : ''}
     WHERE id = $1 RETURNING *`,
    [position.id, newRemaining, newRealizedPnl, newStatus]
  );

  await auditService.recordEvent('paper_exit_filled', 'trade_proposal', position.proposal_id, {
    order_id: order.id, order_type: order.order_type, quantity: fillQty,
    fill_price: fillPrice, realized_pnl: pnl, remaining_qty: newRemaining,
    position_status: newStatus, user_id: userId
  });

  // Handle stop-specific logic: cancel pending T1/T2 and sell remaining
  if (order.order_type === 'stop' && newRemaining > 0) {
    await cancelPendingTargets(position.id, userId);
    // Sell the remaining at stop price
    const stopPrice = toNum(order.stop_price);
    const remainingOrder = await db.query(
      `INSERT INTO paper_orders (
         client_order_id, position_id, proposal_id, signal_id, strategy_id, strategy_version,
         symbol, side, order_type, execution_mode, quantity, stop_price,
         filled_qty, avg_fill_price, status, submitted_at, filled_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, 'sell', 'stop_close', 'PAPER', $8, $9,
         $8, $9, 'FILLED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       ) RETURNING *`,
      [generateClientOrderId(), position.id, position.proposal_id,
       position.signal_id, position.strategy_id, position.strategy_version,
       position.symbol, newRemaining, stopPrice]
    );

    const stopClosePnl = computePnl(position.direction, toNum(position.avg_entry_price), stopPrice, newRemaining);
    const finalRealized = round2(newRealizedPnl + stopClosePnl);

    await db.query(
      `UPDATE paper_positions
       SET remaining_qty = 0, realized_pnl = $2, status = 'CLOSED', closed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [position.id, finalRealized]
    );

    await auditService.recordEvent('paper_stop_close', 'trade_proposal', position.proposal_id, {
      remaining_qty: newRemaining, fill_price: stopPrice, realized_pnl: stopClosePnl, user_id: userId
    });
  }

  // State transitions
  if (order.order_type === 't1') {
    await proposalService.transitionState(position.proposal_id, 'T1_FILLED', userId);
  } else if (order.order_type === 't2') {
    await proposalService.transitionState(position.proposal_id, 'T2_FILLED', userId);
  } else if (order.order_type === 'stop' || order.order_type === 'stop_close') {
    await proposalService.transitionState(position.proposal_id, 'STOP_FILLED', userId);
    await proposalService.transitionState(position.proposal_id, 'POSITION_CLOSED', userId);
  }

  // If position is closed after T2, transition to POSITION_CLOSED
  if (newStatus === 'CLOSED' && (order.order_type === 't1' || order.order_type === 't2')) {
    await proposalService.transitionState(position.proposal_id, 'STOP_FILLED', userId);
    await proposalService.transitionState(position.proposal_id, 'POSITION_CLOSED', userId);
  }

  // Sync to journal trade (idempotent — updates exit fields from position state)
  try { await journalSync.syncPositionToJournal(position.id, userId); } catch (e) { console.error('[JOURNAL-SYNC] sell fill:', e.message); }

  // Release buying power when position is fully closed
  if (newStatus === 'CLOSED') {
    const originalPositionValue = round2(position.total_qty * toNum(position.avg_entry_price));
    try {
      await paperAccount.releaseBuyingPower(position.id, newRealizedPnl, originalPositionValue);
    } catch (releaseErr) {
      console.error('[PAPER-ACCOUNT] release failed:', releaseErr.message);
    }
  }

  return {
    order_id: order.id,
    order_type: order.order_type,
    fill_price: fillPrice,
    quantity: fillQty,
    realized_pnl: pnl,
    remaining_qty: newRemaining,
    position_status: newStatus
  };
}

/**
 * Cancel all pending T1/T2 target orders for a position.
 * Called when the stop fills before T1/T2.
 */
async function cancelPendingTargets(positionId, userId) {
  assertOrderTransitionFromAny(['SUBMITTED', 'PARTIALLY_FILLED'], 'CANCELLED');
  const result = await db.query(
    `UPDATE paper_orders
     SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE position_id = $1 AND order_type IN ('t1', 't2')
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED') RETURNING *`,
    [positionId]
  );

  for (const order of result.rows) {
    await auditService.recordEvent('paper_order_cancelled', 'trade_proposal', order.proposal_id, {
      order_id: order.id, order_type: order.order_type, reason: 'stop_triggered', user_id: userId
    });
  }

  return result.rows;
}

// ── Cancel Entry ──

/**
 * Cancel a pending (SUBMITTED, non-filled) entry order.
 * Transitions proposal: ENTRY_SUBMITTED → ENTRY_CANCELLED
 */
async function cancelEntry(proposalId, userId) {
  const proposal = await proposalService.getById(proposalId);
  if (!proposal) throw new Error('Proposal not found');

  const order = await findExistingEntry(proposalId);
  if (!order) throw new Error('No entry order found for this proposal');
  if (order.status === 'FILLED') {
    throw new Error('Entry already filled — cannot cancel');
  }

  assertOrderTransition(order.status, 'CANCELLED');
  await db.query(
    `UPDATE paper_orders
     SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [order.id]
  );

  // Transition proposal to ENTRY_CANCELLED (valid from ENTRY_SUBMITTED)
  await proposalService.transitionState(proposalId, 'ENTRY_CANCELLED', userId);

  await auditService.recordEvent('paper_entry_cancelled', 'trade_proposal', proposalId, {
    order_id: order.id, user_id: userId
  });

  return { order_id: order.id, status: 'CANCELLED' };
}

// ── Update Stop ──

/**
 * Update the stop price for an open position.
 * Cancels the existing stop order and creates a new one with the updated price.
 */
async function updateStop(proposalId, newStopPrice, userId) {
  const proposal = await proposalService.getById(proposalId);
  if (!proposal) throw new Error('Proposal not found');

  const position = await getPosition(proposalId);
  if (!position || position.status !== 'OPEN') {
    throw new Error('No open position to update stop for');
  }

  const stopPrice = toNum(newStopPrice);
  if (stopPrice == null || stopPrice <= 0) {
    throw new Error('Invalid stop price');
  }

  // For longs: stop must be below current price (and below entry for no averaging down)
  if (position.direction === 'long' && stopPrice >= toNum(position.avg_entry_price)) {
    throw new Error('Stop price must be below entry price for long positions (no averaging down)');
  }

  // Cancel existing stop orders
  const existingStops = await db.query(
    `SELECT * FROM paper_orders
     WHERE position_id = $1 AND order_type = 'stop'
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED')`,
    [position.id]
  );

  for (const oldStop of existingStops.rows) {
    assertOrderTransition(oldStop.status, 'CANCELLED');
    await db.query(
      `UPDATE paper_orders
       SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [oldStop.id]
    );
    await auditService.recordEvent('paper_stop_cancelled', 'trade_proposal', proposalId, {
      order_id: oldStop.id, old_stop_price: oldStop.stop_price, user_id: userId
    });
  }

  // Create new stop order with remaining_qty
  const stopQty = position.remaining_qty -
    (await countActiveTargetQty(position.id));

  if (stopQty <= 0) {
    throw new Error('No remaining quantity to protect with stop');
  }

  const newStop = await db.query(
    `INSERT INTO paper_orders (
       client_order_id, position_id, proposal_id, signal_id, strategy_id, strategy_version,
       symbol, side, order_type, execution_mode, quantity, stop_price, status, submitted_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, 'sell', 'stop', 'PAPER', $8, $9, 'SUBMITTED', CURRENT_TIMESTAMP
     ) RETURNING *`,
    [generateClientOrderId(), position.id, position.proposal_id,
     position.signal_id, position.strategy_id, position.strategy_version,
     position.symbol, stopQty, stopPrice]
  );

  // Update proposal stop_price
  await proposalService.editProposal(proposalId, { stopPrice }, userId);

  await auditService.recordEvent('paper_stop_updated', 'trade_proposal', proposalId, {
    new_stop_price: stopPrice, new_stop_qty: stopQty, order_id: newStop.rows[0].id, user_id: userId
  });

  return { order: newStop.rows[0], stop_price: stopPrice, quantity: stopQty };
}

async function countActiveTargetQty(positionId) {
  const result = await db.query(
    `SELECT COALESCE(SUM(quantity - filled_qty), 0) AS active_qty
     FROM paper_orders
     WHERE position_id = $1 AND order_type IN ('t1', 't2')
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED')`,
    [positionId]
  );
  return toNum(result.rows[0]?.active_qty) || 0;
}

// ── Manual Close ──

/**
 * Manually close a paper position at current market price.
 * Cancels all pending exit orders and sells the full remaining at bid.
 */
async function manualClose(proposalId, userId) {
  const proposal = await proposalService.getById(proposalId);
  if (!proposal) throw new Error('Proposal not found');

  const position = await getPosition(proposalId);
  if (!position || position.status !== 'OPEN') {
    throw new Error('No open position to close');
  }

  let quote;
  try {
    quote = await finnhub.getQuote(proposal.symbol);
  } catch (err) {
    throw new Error(`Cannot retrieve quote for ${proposal.symbol}: ${err.message}`);
  }

  const fillPrice = fillPriceForSell(quote, toNum(FILL_CONFIG.slippagePerShare) || 0);
  if (fillPrice == null || fillPrice <= 0) {
    throw new Error(`No valid quote for ${proposal.symbol} — cannot close`);
  }

  const qty = position.remaining_qty;
  if (qty <= 0) {
    throw new Error('No remaining quantity to close');
  }

  // Cancel all pending exit orders
  await cancelPendingTargets(position.id, userId);
  const pendingStops = await db.query(
    `UPDATE paper_orders
     SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE position_id = $1 AND order_type = 'stop'
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED') RETURNING *`,
    [position.id]
  );

  // Create manual close order
  const closeOrder = await db.query(
    `INSERT INTO paper_orders (
       client_order_id, position_id, proposal_id, signal_id, strategy_id, strategy_version,
       symbol, side, order_type, execution_mode, quantity, filled_qty, avg_fill_price,
       status, submitted_at, filled_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, 'sell', 'manual_close', 'PAPER', $8, $8, $9,
       'FILLED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     ) RETURNING *`,
    [generateClientOrderId(), position.id, position.proposal_id,
     position.signal_id, position.strategy_id, position.strategy_version,
     position.symbol, qty, fillPrice]
  );

  const pnl = computePnl(position.direction, toNum(position.avg_entry_price), fillPrice, qty);
  const finalRealized = round2(toNum(position.realized_pnl) + pnl);

  assertPositionTransition(position.status, 'CLOSED');
  await db.query(
    `UPDATE paper_positions
     SET remaining_qty = 0, realized_pnl = $2, status = 'CLOSED', closed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [position.id, finalRealized]
  );

  // State transitions
  const state = proposal.lifecycle_state;
  if (state === 'POSITION_ACTIVE') {
    await proposalService.transitionState(proposalId, 'STOP_FILLED', userId);
  }
  await proposalService.transitionState(proposalId, 'POSITION_CLOSED', userId);

  await auditService.recordEvent('paper_manual_close', 'trade_proposal', proposalId, {
    order_id: closeOrder.rows[0].id, quantity: qty, fill_price: fillPrice,
    realized_pnl: pnl, user_id: userId
  });

  // Sync to journal trade (idempotent — final close updates is_completed + pnl)
  try { await journalSync.syncPositionToJournal(position.id, userId); } catch (e) { console.error('[JOURNAL-SYNC] manual close:', e.message); }

  // Release buying power
  const originalPositionValue = round2(position.total_qty * toNum(position.avg_entry_price));
  try {
    await paperAccount.releaseBuyingPower(position.id, finalRealized, originalPositionValue);
  } catch (releaseErr) {
    console.error('[PAPER-ACCOUNT] release failed (manual close):', releaseErr.message);
  }

  return {
    order: closeOrder.rows[0],
    fill_price: fillPrice,
    quantity: qty,
    realized_pnl: pnl,
    position_status: 'CLOSED'
  };
}

// ── Reconciliation ──

/**
 * Reconcile paper state from PostgreSQL.
 * Verifies that position remaining_qty matches the sum of unfilled sell orders.
 * Returns a report of any discrepancies.
 */
async function reconcile(proposalId) {
  const position = await getPosition(proposalId);
  if (!position) {
    return { proposal_id: proposalId, position: null, discrepancy: false };
  }

  const orders = await getOrders(proposalId);
  const entryOrders = orders.filter(o => o.order_type === 'entry');
  const sellOrders = orders.filter(o => o.side === 'sell');
  const activeSells = sellOrders.filter(o => o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED');

  const activeSellQty = activeSells.reduce((sum, o) => sum + (o.quantity - (o.filled_qty || 0)), 0);
  const filledSellQty = sellOrders
    .filter(o => o.status === 'FILLED')
    .reduce((sum, o) => sum + (o.filled_qty || 0), 0);

  const expectedRemaining = position.total_qty - filledSellQty;
  const discrepancy = position.remaining_qty !== expectedRemaining;
  const sellInvariantOk = activeSellQty <= position.remaining_qty;

  return {
    proposal_id: proposalId,
    position,
    orders,
    expected_remaining: expectedRemaining,
    actual_remaining: position.remaining_qty,
    discrepancy,
    sell_invariant_ok: sellInvariantOk,
    active_sell_qty: activeSellQty,
    remaining_qty: position.remaining_qty
  };
}

// ── Query Functions ──

async function getOrder(orderId) {
  const result = await db.query(
    `SELECT * FROM paper_orders WHERE id = $1`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function getPosition(proposalId) {
  const result = await db.query(
    `SELECT * FROM paper_positions WHERE proposal_id = $1 ORDER BY opened_at DESC LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

async function getOrders(proposalId) {
  const result = await db.query(
    `SELECT * FROM paper_orders WHERE proposal_id = $1 ORDER BY created_at ASC`,
    [proposalId]
  );
  return result.rows;
}

async function listPositions({ status, limit = 50 } = {}) {
  const params = [];
  const conditions = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);
  const result = await db.query(
    `SELECT pp.*, ts.name AS strategy_name
     FROM paper_positions pp
     LEFT JOIN trading_strategies ts ON pp.strategy_id = ts.id
     ${where} ORDER BY pp.opened_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function getPaperPositionById(positionId) {
  const result = await db.query(
    `SELECT pp.*, ts.name AS strategy_name
     FROM paper_positions pp
     LEFT JOIN trading_strategies ts ON pp.strategy_id = ts.id
     WHERE pp.id = $1`,
    [positionId]
  );
  return result.rows[0] || null;
}

async function listOrders({ status, proposalId, limit = 100 } = {}) {
  const params = [];
  const conditions = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (proposalId) {
    params.push(proposalId);
    conditions.push(`proposal_id = $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);
  const result = await db.query(
    `SELECT * FROM paper_orders ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function cancelOrder(orderId, userId) {
  const existing = await db.query(
    `SELECT status FROM paper_orders WHERE id = $1`,
    [orderId]
  );
  const order = existing.rows[0];
  if (!order) return null;
  if (order.status === 'CANCELLED') return null; // idempotent
  assertOrderTransition(order.status, 'CANCELLED');
  const result = await db.query(
    `UPDATE paper_orders
     SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status IN ('SUBMITTED', 'PARTIALLY_FILLED', 'PENDING') RETURNING *`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function getAccountSummary() {
  const openPositions = await listPositions({ status: 'OPEN', limit: 200 });
  // Fetch current quotes for unrealized P&L
  const symbols = [...new Set(openPositions.map(p => p.symbol))];
  let quotes = {};
  if (symbols.length > 0) {
    try { quotes = await finnhub.getQuotes(symbols); } catch { /* ignore */ }
  }
  const positionsWithPrices = openPositions.map(p => ({
    ...p,
    current_price: quotes[p.symbol] ? toNum(quotes[p.symbol].c) : null
  }));

  const accountSummary = await paperAccount.getAccountSummary(positionsWithPrices);

  const closedResult = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(realized_pnl), 0) AS realized_pnl
     FROM paper_positions WHERE status = 'CLOSED'`
  );
  const closed = closedResult.rows[0] || {};

  return {
    ...accountSummary,
    open_positions: Number(openPositions.length || 0),
    closed_positions: Number(closed.count || 0),
    closed_realized_pnl: round2(toNum(closed.realized_pnl) || 0)
  };
}

/**
 * Compute unrealized P&L for an open position given current quote.
 */
async function getUnrealizedPnl(position, quote) {
  if (!position || position.status !== 'OPEN' || !quote) return null;
  const currentPrice = position.direction === 'long'
    ? (toNum(quote.bid) || toNum(quote.c))
    : (toNum(quote.ask) || toNum(quote.c));
  if (currentPrice == null) return null;
  return computePnl(position.direction, toNum(position.avg_entry_price), currentPrice, position.remaining_qty);
}

// ── Automated Reconciliation ──

/**
 * Verify the sell-quantity invariant for a position from persisted state.
 * Hard invariant: total active sell qty <= remaining_qty.
 * Returns { ok, activeSellQty, remainingQty }.
 */
async function verifySellInvariant(positionId) {
  const result = await db.query(
    `SELECT
       COALESCE(SUM(quantity - filled_qty), 0) AS active_sell_qty
     FROM paper_orders
     WHERE position_id = $1 AND side = 'sell'
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED')`,
    [positionId]
  );
  const posResult = await db.query(
    `SELECT remaining_qty FROM paper_positions WHERE id = $1`,
    [positionId]
  );
  const activeSellQty = toNum(result.rows[0]?.active_sell_qty) || 0;
  const remainingQty = toNum(posResult.rows[0]?.remaining_qty) || 0;
  return { ok: activeSellQty <= remainingQty, activeSellQty, remainingQty };
}

/**
 * Reconcile all open PAPER positions that have active (SUBMITTED or
 * PARTIALLY_FILLED) sell orders. Called by the worker reconciliation
 * scheduler. Each position is processed via processFills, which applies
 * the deterministic fill rules and stop-first ordering.
 *
 * Concurrency: the scheduler wraps this in a Redis distributed lock to
 * prevent overlap. Per-position locking is provided by the Redis lock
 * in the scheduler's runReconciliation helper.
 *
 * @param userId - null for automated runs; a user id for manual triggers
 * @returns {{ positionsProcessed, fillsApplied, errors }}
 */
async function reconcileAll(userId = null) {
  const result = await db.query(
    `SELECT DISTINCT pp.id, pp.proposal_id, pp.symbol
     FROM paper_positions pp
     JOIN paper_orders po ON po.position_id = pp.id
     WHERE pp.status = 'OPEN'
       AND pp.execution_mode = 'PAPER'
       AND po.status IN ('SUBMITTED', 'PARTIALLY_FILLED')`
  );

  let positionsProcessed = 0;
  let fillsApplied = 0;
  const errors = [];

  for (const row of result.rows) {
    positionsProcessed++;
    try {
      const fillResult = await processFills(row.proposal_id, userId);
      fillsApplied += (fillResult.fills || []).length;

      // Verify invariant after processing
      const inv = await verifySellInvariant(row.id);
      if (!inv.ok) {
        await proposalService.transitionState(
          row.proposal_id,
          'MANUAL_INTERVENTION_REQUIRED',
          userId
        );
        await auditService.recordEvent(
          'paper_invariant_violation',
          'trade_proposal',
          row.proposal_id,
          { position_id: row.id, active_sell_qty: inv.activeSellQty, remaining_qty: inv.remainingQty }
        );
        errors.push({
          proposal_id: row.proposal_id,
          error: 'sell invariant violated after reconciliation',
          active_sell_qty: inv.activeSellQty,
          remaining_qty: inv.remainingQty
        });
      }
      // Sync position to journal trade after fill processing (idempotent)
      try { await journalSync.syncPositionToJournal(row.id, userId); } catch (e) { errors.push({ position_id: row.id, error: 'journal sync: ' + e.message }); }
    } catch (err) {
      errors.push({ proposal_id: row.proposal_id, error: err.message });
    }
  }

  return { positionsProcessed, fillsApplied, errors };
}

/**
 * Restart recovery — detect and repair safe inconsistencies at worker
 * startup or first reconciliation. Only deterministic safe repairs are
 * performed. Ambiguous state transitions the proposal to
 * MANUAL_INTERVENTION_REQUIRED.
 *
 * Safe repairs:
 *  1. FILLED entry order with no position → create the missing position.
 *  2. CLOSED position with active SUBMITTED/PARTIALLY_FILLED exits → cancel them.
 *  3. Position remaining_qty inconsistent with fills → recalculate.
 *  4. Proposal lifecycle behind the position/order state → advance.
 *
 * Each repair is recorded as an audit event.
 *
 * @returns {{ repairs, manualInterventions }}
 */
async function runRestartRecovery(userId = null) {
  const repairs = [];
  const manualInterventions = [];

  // 1. FILLED entry with no position → create position
  const missingPositions = await db.query(
    `SELECT po.* FROM paper_orders po
     WHERE po.order_type = 'entry'
       AND po.status = 'FILLED'
       AND po.execution_mode = 'PAPER'
       AND NOT EXISTS (
       SELECT 1 FROM paper_positions pp WHERE pp.proposal_id = po.proposal_id
     )`
  );
  for (const order of missingPositions.rows) {
    try {
      const proposal = await proposalService.getById(order.proposal_id);
      if (!proposal) continue;

      const fillQty = toNum(order.filled_qty) || 0;
      const fillPrice = toNum(order.avg_fill_price);
      if (fillQty <= 0 || fillPrice == null) {
        // Ambiguous: filled order but no fill data
        await proposalService.transitionState(order.proposal_id, 'MANUAL_INTERVENTION_REQUIRED', userId);
        await auditService.recordEvent('paper_recovery_ambiguous', 'trade_proposal', order.proposal_id, {
          reason: 'FILLED entry order with no fill quantity/price', order_id: order.id
        });
        manualInterventions.push({ proposal_id: order.proposal_id, reason: 'missing fill data' });
        continue;
      }

      await db.query(
        `INSERT INTO paper_positions (
           proposal_id, signal_id, strategy_id, strategy_version,
           symbol, direction, total_qty, remaining_qty, avg_entry_price, execution_mode
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'PAPER')`,
        [order.proposal_id, order.signal_id, order.strategy_id, order.strategy_version,
         order.symbol, proposal.direction, fillQty, fillPrice]
      );

      await proposalService.transitionState(order.proposal_id, 'ENTRY_FILLED', userId);
      await proposalService.transitionState(order.proposal_id, 'POSITION_ACTIVE', userId);

      // Recreate protective exits
      const position = await getPosition(order.proposal_id);
      if (position) {
        await createProtectiveExits(position, proposal, userId);
      }

      await auditService.recordEvent('paper_recovery_repair', 'trade_proposal', order.proposal_id, {
        repair: 'created_missing_position', position_id: position?.id, order_id: order.id
      });
      repairs.push({ proposal_id: order.proposal_id, repair: 'created_missing_position' });
    } catch (err) {
      await proposalService.transitionState(order.proposal_id, 'MANUAL_INTERVENTION_REQUIRED', userId);
      await auditService.recordEvent('paper_recovery_failed', 'trade_proposal', order.proposal_id, {
        repair: 'create_missing_position', error: err.message
      });
      manualInterventions.push({ proposal_id: order.proposal_id, reason: err.message });
    }
  }

  // 2. CLOSED position with active exits → cancel them
  const closedWithExits = await db.query(
    `SELECT DISTINCT pp.id AS position_id, pp.proposal_id
     FROM paper_positions pp
     JOIN paper_orders po ON po.position_id = pp.id
     WHERE pp.status = 'CLOSED'
       AND po.status IN ('SUBMITTED', 'PARTIALLY_FILLED')`
  );
  for (const row of closedWithExits.rows) {
    try {
      await db.query(
        `UPDATE paper_orders
         SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE position_id = $1 AND status IN ('SUBMITTED', 'PARTIALLY_FILLED')`,
        [row.position_id]
      );
      await auditService.recordEvent('paper_recovery_repair', 'trade_proposal', row.proposal_id, {
        repair: 'cancelled_exits_on_closed_position', position_id: row.position_id
      });
      repairs.push({ proposal_id: row.proposal_id, repair: 'cancelled_exits_on_closed_position' });
    } catch (err) {
      manualInterventions.push({ proposal_id: row.proposal_id, reason: err.message });
    }
  }

  // 3. Position remaining_qty inconsistent with fills → recalculate
  const inconsistent = await db.query(
    `SELECT pp.*,
       (pp.total_qty - COALESCE(
         (SELECT SUM(po.filled_qty) FROM paper_orders po
          WHERE po.position_id = pp.id AND po.side = 'sell' AND po.status = 'FILLED'), 0
       )) AS expected_remaining
     FROM paper_positions pp
     WHERE pp.status = 'OPEN' AND pp.execution_mode = 'PAPER'`
  );
  for (const pos of inconsistent.rows) {
    const expected = toNum(pos.expected_remaining) ?? 0;
    const actual = toNum(pos.remaining_qty) ?? 0;
    if (expected !== actual) {
      try {
        await db.query(
          `UPDATE paper_positions SET remaining_qty = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [pos.id, Math.max(0, expected)]
        );
        await auditService.recordEvent('paper_recovery_repair', 'trade_proposal', pos.proposal_id, {
          repair: 'recalculated_remaining_qty',
          position_id: pos.id, old_remaining: actual, new_remaining: Math.max(0, expected)
        });
        repairs.push({ proposal_id: pos.proposal_id, repair: 'recalculated_remaining_qty', old: actual, new: expected });

        // If remaining is 0 but status is OPEN, close the position
        if (expected <= 0) {
          await db.query(
            `UPDATE paper_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [pos.id]
          );
          await proposalService.transitionState(pos.proposal_id, 'POSITION_CLOSED', userId);
          await auditService.recordEvent('paper_recovery_repair', 'trade_proposal', pos.proposal_id, {
            repair: 'closed_zero_remaining_position', position_id: pos.id
          });
          repairs.push({ proposal_id: pos.proposal_id, repair: 'closed_zero_remaining_position' });
        }
      } catch (err) {
        await proposalService.transitionState(pos.proposal_id, 'MANUAL_INTERVENTION_REQUIRED', userId);
        manualInterventions.push({ proposal_id: pos.proposal_id, reason: err.message });
      }
    }
  }

  // 4. Verify sell invariant on all open positions
  const openPositions = await db.query(
    `SELECT id, proposal_id FROM paper_positions WHERE status = 'OPEN' AND execution_mode = 'PAPER'`
  );
  for (const pos of openPositions.rows) {
    const inv = await verifySellInvariant(pos.id);
    if (!inv.ok) {
      await proposalService.transitionState(pos.proposal_id, 'MANUAL_INTERVENTION_REQUIRED', userId);
      await auditService.recordEvent('paper_recovery_invariant_violation', 'trade_proposal', pos.proposal_id, {
        position_id: pos.id, active_sell_qty: inv.activeSellQty, remaining_qty: inv.remainingQty
      });
      manualInterventions.push({
        proposal_id: pos.proposal_id,
        reason: 'sell invariant violated',
        active_sell_qty: inv.activeSellQty,
        remaining_qty: inv.remainingQty
      });
    }
  }

  return { repairs, manualInterventions };
}

/**
 * Full reconciliation cycle: restart recovery + fill processing.
 * Called by the scheduler's execute() method.
 */
async function runReconciliationCycle(userId = null) {
  const recovery = await runRestartRecovery(userId);
  const fillResult = await reconcileAll(userId);

  // Sync all paper positions to journal trades (idempotent — safe to replay)
  let journalSynced = 0;
  let journalErrors = [];
  try {
    const syncResult = await journalSync.syncAllToJournal(userId);
    journalSynced = syncResult.synced;
    journalErrors = syncResult.errors;
  } catch (e) { journalErrors = [{ error: e.message }]; }

  return {
    repairs: recovery.repairs.length,
    manualInterventions: recovery.manualInterventions.length,
    positionsProcessed: fillResult.positionsProcessed,
    fillsApplied: fillResult.fillsApplied,
    errors: fillResult.errors,
    journalSynced,
    journalErrors,
    recoveryDetails: recovery
  };
}

module.exports = {
  // Execution adapter interface
  submitEntry,
  processFills,
  cancelEntry,
  updateStop,
  manualClose,
  reconcile,
  // Automated reconciliation
  reconcileAll,
  runRestartRecovery,
  runReconciliationCycle,
  verifySellInvariant,
  // Queries
  getOrder,
  getPosition,
  getPaperPositionById,
  getOrders,
  listPositions,
  listOrders,
  getAccountSummary,
  getUnrealizedPnl,
  cancelOrder,
  // Internal (exported for testing)
  createProtectiveExits,
  computeExitQuantities,
  checkSellInvariant,
  simulateBuyFill,
  simulateSellFill,
  isLimitBuyMarketable,
  isLimitSellMarketable,
  isStopSellTriggered,
  computePnl,
  fillPriceForBuy,
  fillPriceForSell,
  FILL_CONFIG
};
