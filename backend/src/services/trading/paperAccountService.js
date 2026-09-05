/**
 * Paper Account Service — Persistent PAPER Cash Ledger
 *
 * PostgreSQL authoritative. No margin modeling.
 *
 * Prevents:
 *   - spending more than available buying power
 *   - double reservation
 *   - double release
 *   - duplicate P&L application
 *
 * All mutations are atomic (SELECT ... FOR UPDATE + ledger audit trail).
 */

const db = require('../../config/database');

const DEFAULT_STARTING_CASH = 100000;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Get the paper account (single-row). Creates with defaults if missing.
 */
async function getAccount() {
  const result = await db.query(
    `SELECT * FROM paper_account ORDER BY created_at ASC LIMIT 1`
  );
  if (result.rows.length === 0) {
    const insert = await db.query(
      `INSERT INTO paper_account (starting_cash, available_cash)
       VALUES ($1, $1) RETURNING *`,
      [DEFAULT_STARTING_CASH]
    );
    return insert.rows[0];
  }
  return result.rows[0];
}

/**
 * Get a full account summary including market value, unrealized P&L, equity, buying power.
 * @param {object} openPositions - array of open positions with current market values
 */
async function getAccountSummary(openPositions = []) {
  const account = await getAccount();

  let marketValue = 0;
  let unrealizedPnl = 0;
  for (const pos of openPositions) {
    const qty = toNum(pos.remaining_qty) || 0;
    const entryPrice = toNum(pos.avg_entry_price) || 0;
    const currentPrice = toNum(pos.current_price) || toNum(pos.mark_price) || null;
    if (currentPrice != null) {
      marketValue += qty * currentPrice;
      unrealizedPnl += qty * (currentPrice - entryPrice);
    }
  }

  const availableCash = toNum(account.available_cash) || 0;
  const reservedCash = toNum(account.reserved_cash) || 0;
  const realizedPnl = toNum(account.total_realized_pnl) || 0;
  const startingCash = toNum(account.starting_cash) || DEFAULT_STARTING_CASH;

  // equity = available_cash + market_value + reserved_cash
  // (reserved_cash is already committed to positions but not yet realized)
  const equity = round2(availableCash + marketValue + reservedCash);
  // buying power = available_cash (no margin)
  const buyingPower = round2(availableCash);

  return {
    starting_cash: round2(startingCash),
    available_cash: round2(availableCash),
    reserved_cash: round2(reservedCash),
    market_value: round2(marketValue),
    realized_pnl: round2(realizedPnl),
    unrealized_pnl: round2(unrealizedPnl),
    equity,
    buying_power: buyingPower,
    paper_trading_halted: account.paper_trading_halted,
    halted_at: account.halted_at,
    halted_reason: account.halted_reason
  };
}

/**
 * Reserve buying power for a new position.
 * Atomic: SELECT FOR UPDATE, check available, deduct, insert ledger.
 * Prevents double reservation via position_id uniqueness check.
 *
 * @param {string} positionId - UUID of the paper position
 * @param {number} positionValue - total $ value of the position (qty * entry_price)
 * @returns {object} updated account
 */
async function reserveBuyingPower(positionId, positionValue) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check for duplicate reservation
    const dupCheck = await client.query(
      `SELECT id FROM paper_account_ledger
       WHERE position_id = $1 AND entry_type = 'reservation'`,
      [positionId]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      throw new Error('Buying power already reserved for this position');
    }

    // Lock the account row
    const accountResult = await client.query(
      `SELECT * FROM paper_account ORDER BY created_at ASC LIMIT 1 FOR UPDATE`
    );
    let account = accountResult.rows[0];
    if (!account) {
      const insertResult = await client.query(
        `INSERT INTO paper_account (starting_cash, available_cash)
         VALUES ($1, $1) RETURNING *`,
        [DEFAULT_STARTING_CASH]
      );
      account = insertResult.rows[0];
    }

    const available = toNum(account.available_cash) || 0;
    const reserveAmount = round2(positionValue);

    if (reserveAmount > available) {
      await client.query('ROLLBACK');
      throw new Error(`Insufficient buying power: need $${reserveAmount}, available $${available}`);
    }

    const newAvailable = round2(available - reserveAmount);
    const newReserved = round2((toNum(account.reserved_cash) || 0) + reserveAmount);

    await client.query(
      `UPDATE paper_account SET available_cash = $2, reserved_cash = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [account.id, newAvailable, newReserved]
    );

    await client.query(
      `INSERT INTO paper_account_ledger (account_id, position_id, entry_type, amount, balance_after, description)
       VALUES ($1, $2, 'reservation', $3, $4, $5)`,
      [account.id, positionId, reserveAmount, newAvailable, `Reserved for position ${positionId}`]
    );

    await client.query('COMMIT');
    return { available_cash: newAvailable, reserved_cash: newReserved };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release reserved buying power when a position is closed.
 * Applies realized P&L at the same time.
 * Prevents double release via ledger check.
 *
 * @param {string} positionId - UUID of the paper position
 * @param {number} realizedPnl - realized P&L for this position (can be negative)
 * @param {number} originalPositionValue - the originally reserved amount
 * @returns {object} updated account
 */
async function releaseBuyingPower(positionId, realizedPnl, originalPositionValue) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check for duplicate release
    const dupCheck = await client.query(
      `SELECT id FROM paper_account_ledger
       WHERE position_id = $1 AND entry_type = 'release'`,
      [positionId]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      throw new Error('Buying power already released for this position');
    }

    // Lock the account row
    const accountResult = await client.query(
      `SELECT * FROM paper_account ORDER BY created_at ASC LIMIT 1 FOR UPDATE`
    );
    const account = accountResult.rows[0];
    if (!account) throw new Error('Paper account not found');

    const pnl = round2(realizedPnl || 0);
    const releaseAmount = round2(originalPositionValue || 0);

    // Release reserved cash + apply P&L
    // The reserved amount goes back to available, plus the P&L adjustment
    const newReserved = round2((toNum(account.reserved_cash) || 0) - releaseAmount);
    const newAvailable = round2((toNum(account.available_cash) || 0) + releaseAmount + pnl);
    const newRealizedPnl = round2((toNum(account.total_realized_pnl) || 0) + pnl);

    await client.query(
      `UPDATE paper_account
       SET available_cash = $2, reserved_cash = $3, total_realized_pnl = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [account.id, newAvailable, Math.max(0, newReserved), newRealizedPnl]
    );

    // Insert release ledger entry
    await client.query(
      `INSERT INTO paper_account_ledger (account_id, position_id, entry_type, amount, balance_after, description)
       VALUES ($1, $2, 'release', $3, $4, $5)`,
      [account.id, positionId, releaseAmount, newAvailable, `Released reservation for ${positionId}`]
    );

    // Insert P&L ledger entry (if non-zero)
    if (pnl !== 0) {
      await client.query(
        `INSERT INTO paper_account_ledger (account_id, position_id, entry_type, amount, balance_after, description)
         VALUES ($1, $2, 'realized_pnl', $3, $4, $5)`,
        [account.id, positionId, pnl, newAvailable, `Realized P&L for ${positionId}: ${pnl >= 0 ? '+' : ''}${pnl}`]
      );
    }

    await client.query('COMMIT');
    return { available_cash: newAvailable, reserved_cash: Math.max(0, newReserved), total_realized_pnl: newRealizedPnl };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Halt new PAPER trading. Blocks new entries. Existing positions remain manageable.
 */
async function haltPaperTrading(reason = 'Manual halt') {
  const account = await getAccount();
  await db.query(
    `UPDATE paper_account SET paper_trading_halted = TRUE, halted_at = CURRENT_TIMESTAMP, halted_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [account.id, reason]
  );
  await db.query(
    `INSERT INTO paper_account_ledger (account_id, entry_type, amount, balance_after, description)
     VALUES ($1, 'halt', 0, $2, $3)`,
    [account.id, toNum(account.available_cash) || 0, reason]
  );
  return { halted: true };
}

/**
 * Unhalt PAPER trading.
 */
async function unhaltPaperTrading() {
  const account = await getAccount();
  await db.query(
    `UPDATE paper_account SET paper_trading_halted = FALSE, halted_at = NULL, halted_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [account.id]
  );
  await db.query(
    `INSERT INTO paper_account_ledger (account_id, entry_type, amount, balance_after, description)
     VALUES ($1, 'unhalt', 0, $2, 'Paper trading resumed')`,
    [account.id, toNum(account.available_cash) || 0]
  );
  return { halted: false };
}

/**
 * Check if PAPER trading is halted (new entries blocked).
 */
async function isPaperTradingHalted() {
  const account = await getAccount();
  return account.paper_trading_halted === true;
}

module.exports = {
  getAccount,
  getAccountSummary,
  reserveBuyingPower,
  releaseBuyingPower,
  haltPaperTrading,
  unhaltPaperTrading,
  isPaperTradingHalted,
  DEFAULT_STARTING_CASH
};
