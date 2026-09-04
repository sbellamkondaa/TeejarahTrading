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
const { isEvaluationStale, getLatestEvaluation, canBecomeReadyForApproval } = require('./riskEngine');

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
       proposal.symbol, proposal.direction, qty, fillPrice]
    );
    position = posResult.rows[0];

    // Update order with fill info
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

  const position = await getPosition(proposalId);
  if (!position || position.status !== 'OPEN') {
    return { fills: [], position_status: position?.status || 'NONE' };
  }

  // Get all active sell orders
  const activeOrders = await db.query(
    `SELECT * FROM paper_orders
     WHERE position_id = $1 AND side = 'sell'
       AND status IN ('SUBMITTED', 'PARTIALLY_FILLED')
     ORDER BY created_at ASC`,
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

    // Refresh position state after fill
    const updatedPos = await getPosition(proposalId);
    if (updatedPos.status === 'CLOSED' || updatedPos.remaining_qty <= 0) {
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
    `SELECT * FROM paper_positions ${where} ORDER BY opened_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
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
  const result = await db.query(
    `UPDATE paper_orders
     SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status IN ('SUBMITTED', 'PARTIALLY_FILLED', 'PENDING') RETURNING *`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function getAccountSummary() {
  const openResult = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(realized_pnl), 0) AS realized_pnl
     FROM paper_positions WHERE status = 'OPEN'`
  );
  const closedResult = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(realized_pnl), 0) AS realized_pnl
     FROM paper_positions WHERE status = 'CLOSED'`
  );
  const open = openResult.rows[0] || {};
  const closed = closedResult.rows[0] || {};
  const openPnl = toNum(open.realized_pnl) || 0;
  const closedPnl = toNum(closed.realized_pnl) || 0;
  return {
    open_positions: Number(open.count || 0),
    closed_positions: Number(closed.count || 0),
    open_realized_pnl: round2(openPnl),
    closed_realized_pnl: round2(closedPnl),
    total_realized_pnl: round2(openPnl + closedPnl)
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

module.exports = {
  // Execution adapter interface
  submitEntry,
  processFills,
  cancelEntry,
  updateStop,
  manualClose,
  reconcile,
  // Queries
  getOrder,
  getPosition,
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
