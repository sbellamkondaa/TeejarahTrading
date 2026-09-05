/**
 * Journal Sync Service
 *
 * Projects PAPER execution state (paper_positions + paper_orders) into the
 * trades table (the trade journal).  This is a *projection* — the paper
 * broker tables remain the source of truth; the journal trade is a
 * read-optimised history that the user can annotate.
 *
 * Idempotency:
 *   A UNIQUE index on trades.paper_position_id guarantees at most one trade
 *   per paper position.  The upsert uses ON CONFLICT to update only
 *   execution-derived fields (entry_price, exit_price, exit_time, pnl,
 *   is_completed, quantity).  User-owned fields (notes, tags, strategy,
 *   setup, confidence, is_public, chart_url, etc.) are NEVER overwritten.
 *
 * Reconciliation safety:
 *   Replaying the same execution events produces the same journal result.
 *   The sync reads the current paper_positions row + FILLED sell orders and
 *   recomputes the trade fields deterministically from that state.
 */

const db = require('../../config/database');
const proposalService = require('./proposalService');

const { toNum, round2 } = require('./paperBroker');

/**
 * Sync a single paper position to the trades journal.
 *
 * @param {string} positionId  — paper_positions.id
 * @param {string|null} userId — for the user_id FK on trades
 * @returns {Promise<object|null>} the upserted trade row, or null if the
 *   position does not exist / has no entry fill yet.
 */
async function syncPositionToJournal(positionId, userId = null) {
  if (!positionId) return null;

  // 1. Read the position (with strategy name).
  const posResult = await db.query(
    `SELECT pp.*, ts.name AS strategy_name
     FROM paper_positions pp
     LEFT JOIN trading_strategies ts ON pp.strategy_id = ts.id
     WHERE pp.id = $1`,
    [positionId]
  );
  const position = posResult.rows[0];
  if (!position) return null;

  // 2. Read the FILLED entry order to get entry fill time.
  const entryOrderResult = await db.query(
    `SELECT filled_at, avg_fill_price, filled_qty
     FROM paper_orders
     WHERE position_id = $1 AND side = 'buy' AND status = 'FILLED'
     ORDER BY filled_at ASC LIMIT 1`,
    [positionId]
  );
  const entryOrder = entryOrderResult.rows[0];
  if (!entryOrder) return null; // entry not filled yet — nothing to journal

  // 3. Read proposal for stop_price.
  let stopLoss = null;
  try {
    const proposal = await proposalService.getById(position.proposal_id);
    if (proposal) {
      stopLoss = toNum(proposal.stop_price) || null;
    }
  } catch { /* ignore — stop_loss is optional */ }

  // 4. Compute weighted-average exit price from FILLED sell orders.
  const sellResult = await db.query(
    `SELECT filled_qty, avg_fill_price
     FROM paper_orders
     WHERE position_id = $1 AND side = 'sell' AND status = 'FILLED'
       AND filled_qty > 0`,
    [positionId]
  );
  let totalSoldQty = 0;
  let weightedSum = 0;
  for (const o of sellResult.rows) {
    const qty = toNum(o.filled_qty) || 0;
    const price = toNum(o.avg_fill_price) || 0;
    weightedSum += qty * price;
    totalSoldQty += qty;
  }
  const exitPrice = totalSoldQty > 0 ? round2(weightedSum / totalSoldQty) : null;

  // 5. Derive trade fields from position state.
  const entryPrice = toNum(position.avg_entry_price);
  const quantity = toNum(position.total_qty);
  const isCompleted = position.status === 'CLOSED';
  const entryTime = entryOrder.filled_at || position.opened_at;
  const exitTime = isCompleted ? (position.closed_at || entryOrder.filled_at) : null;
  const pnl = toNum(position.realized_pnl) || 0;

  // Resolve userId from the proposal's signal if not provided.
  if (!userId) {
    try {
      const proposal = await proposalService.getById(position.proposal_id);
      if (proposal) {
        const signalResult = await db.query(
          `SELECT user_id FROM trade_signals WHERE id = $1`,
          [proposal.signal_id]
        );
        userId = signalResult.rows[0]?.user_id || null;
      }
    } catch { /* ignore */ }
  }
  if (!userId) {
    console.warn('[JOURNAL-SYNC] cannot resolve userId for position', positionId, '— skipping journal sync');
    return null;
  }

  // 6. Upsert — ON CONFLICT updates ONLY execution-derived fields.
  //    User-owned fields (notes, tags, strategy, setup, confidence, is_public,
  //    chart_url, stop_loss, etc.) are NEVER overwritten.
  const result = await db.query(
    `INSERT INTO trades (
        user_id, symbol, entry_time, exit_time, entry_price, exit_price,
        quantity, side, pnl, is_completed, broker, execution_mode,
        paper_position_id, strategy, stop_loss, trade_date
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, 'PAPER', 'PAPER',
        $11, $12, $13, DATE($3)
      )
      ON CONFLICT (paper_position_id)
      DO UPDATE SET
        entry_price = EXCLUDED.entry_price,
        exit_price   = EXCLUDED.exit_price,
        exit_time    = EXCLUDED.exit_time,
        quantity     = EXCLUDED.quantity,
        pnl          = EXCLUDED.pnl,
        is_completed = EXCLUDED.is_completed,
        updated_at   = CURRENT_TIMESTAMP
      RETURNING *`,
    [
      userId,
      position.symbol,
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      quantity,
      position.direction,
      round2(pnl),
      isCompleted,
      positionId,
      position.strategy_name || null,
      stopLoss,
    ]
  );

  return result.rows[0] || null;
}

/**
 * Sync all OPEN or recently-CLOSED paper positions to the journal.
 * Called by the reconciliation scheduler after fill processing.
 *
 * @param {string|null} userId
 * @returns {Promise<{synced, errors}>}
 */
async function syncAllToJournal(userId = null) {
  const result = await db.query(
    `SELECT id FROM paper_positions
     WHERE execution_mode = 'PAPER'
       AND EXISTS (
         SELECT 1 FROM paper_orders po
         WHERE po.position_id = paper_positions.id
           AND po.side = 'buy' AND po.status = 'FILLED'
       )
     ORDER BY opened_at DESC
     LIMIT 500`
  );

  let synced = 0;
  const errors = [];

  for (const row of result.rows) {
    try {
      const trade = await syncPositionToJournal(row.id, userId);
      if (trade) synced++;
    } catch (err) {
      errors.push({ position_id: row.id, error: err.message });
    }
  }

  return { synced, errors };
}

/**
 * Get the journal trade linked to a paper position.
 */
async function getJournalTrade(positionId) {
  if (!positionId) return null;
  const result = await db.query(
    `SELECT * FROM trades WHERE paper_position_id = $1`,
    [positionId]
  );
  return result.rows[0] || null;
}

/**
 * Get the journal trade linked to a proposal (via its paper position).
 */
async function getJournalTradeByProposal(proposalId) {
  if (!proposalId) return null;
  const result = await db.query(
    `SELECT t.* FROM trades t
     JOIN paper_positions pp ON t.paper_position_id = pp.id
     WHERE pp.proposal_id = $1
     ORDER BY t.created_at DESC LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

module.exports = {
  syncPositionToJournal,
  syncAllToJournal,
  getJournalTrade,
  getJournalTradeByProposal,
};
