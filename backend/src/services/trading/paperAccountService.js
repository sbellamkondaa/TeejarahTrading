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
 * Atomic + idempotent: SELECT FOR UPDATE, check available, deduct, insert ledger.
 * On duplicate reservation (retry after transient failure), returns success
 * with the current account state — the unique DB index prevents actual
 * double-insertion, so the second attempt is a safe no-op.
 *
 * @param {string} positionId - UUID of the paper position
 * @param {number} positionValue - total $ value of the position (qty * entry_price)
 * @returns {object} updated account state
 */
async function reserveBuyingPower(positionId, positionValue) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check for duplicate reservation (idempotent retry)
    const dupCheck = await client.query(
      `SELECT balance_after FROM paper_account_ledger
       WHERE position_id = $1 AND entry_type = 'reservation'`,
      [positionId]
    );
    if (dupCheck.rows.length > 0) {
      // Already reserved — safe no-op for retry. Return current account state.
      await client.query('ROLLBACK');
      const account = await getAccount();
      return {
        available_cash: round2(toNum(account.available_cash) || 0),
        reserved_cash: round2(toNum(account.reserved_cash) || 0),
        idempotent: true
      };
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
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release reserved buying power when a position is closed.
 * Applies realized P&L at the same time.
 * Idempotent: on duplicate release (retry), returns success with current
 * account state — the unique DB index prevents double-release.
 *
 * @param {string} positionId - UUID of the paper position
 * @param {number} realizedPnl - realized P&L for this position (can be negative)
 * @param {number} originalPositionValue - the originally reserved amount
 * @returns {object} updated account state
 */
async function releaseBuyingPower(positionId, realizedPnl, originalPositionValue) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check for duplicate release (idempotent retry)
    const dupCheck = await client.query(
      `SELECT balance_after FROM paper_account_ledger
       WHERE position_id = $1 AND entry_type = 'release'`,
      [positionId]
    );
    if (dupCheck.rows.length > 0) {
      // Already released — safe no-op for retry. Return current account state.
      await client.query('ROLLBACK');
      const account = await getAccount();
      return {
        available_cash: round2(toNum(account.available_cash) || 0),
        reserved_cash: round2(toNum(account.reserved_cash) || 0),
        total_realized_pnl: round2(toNum(account.total_realized_pnl) || 0),
        idempotent: true
      };
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
    try { await client.query('ROLLBACK'); } catch (_) {}
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

/**
 * Reconcile the PAPER account ledger against actual position state.
 *
 * Detects and deterministically repairs:
 *   1. Reservation drift: open positions without a reservation ledger entry
 *      → add the missing reservation
 *   2. Release drift: closed positions without a release ledger entry
 *      → add the missing release + realized P&L
 *   3. P&L drift: total_realized_pnl doesn't match sum of realized_pnl
 *      ledger entries → recompute from ledger
 *   4. Reserved-cash drift: reserved_cash doesn't match sum of open
 *      reservations minus releases → recompute from ledger
 *
 * Unsafe ambiguity (position with ambiguous fill data, negative available
 * cash after repair, or conflicting ledger entries) → MANUAL_INTERVENTION_REQUIRED
 * via audit event, not auto-repaired.
 *
 * @param {string|null} userId - for audit attribution
 * @returns {{ repairs: array, manualInterventions: array, summary: object }}
 */
async function reconcilePaperAccount(userId = null) {
  const auditService = require('./auditService');
  const repairs = [];
  const manualInterventions = [];

  const account = await getAccount();
  const accountId = account.id;

  // ── 1. Reservation drift: open positions without reservation ──
  const missingReservations = await db.query(
    `SELECT pp.id AS position_id, pp.proposal_id, pp.total_qty, pp.avg_entry_price,
            pp.remaining_qty, pp.status
     FROM paper_positions pp
     WHERE pp.status = 'OPEN'
       AND pp.execution_mode = 'PAPER'
       AND NOT EXISTS (
         SELECT 1 FROM paper_account_ledger pal
         WHERE pal.position_id = pp.id AND pal.entry_type = 'reservation'
       )`
  );
  for (const pos of missingReservations.rows) {
    const qty = toNum(pos.total_qty) || 0;
    const price = toNum(pos.avg_entry_price) || 0;
    const positionValue = round2(qty * price);
    if (positionValue <= 0) {
      await auditService.recordEvent('paper_account_drift', 'paper_account', accountId, {
        type: 'reservation_drift_ambiguous', position_id: pos.position_id,
        reason: 'position value is zero or negative', qty, price
      });
      manualInterventions.push({ position_id: pos.position_id, type: 'reservation', reason: 'ambiguous position value' });
      continue;
    }
    try {
      await reserveBuyingPower(pos.position_id, positionValue);
      await auditService.recordEvent('paper_account_repair', 'paper_account', accountId, {
        repair: 'added_missing_reservation', position_id: pos.position_id, amount: positionValue
      });
      repairs.push({ position_id: pos.position_id, repair: 'added_missing_reservation', amount: positionValue });
    } catch (err) {
      // Insufficient buying power — can't safely auto-reserve
      await auditService.recordEvent('paper_account_drift', 'paper_account', accountId, {
        type: 'reservation_drift_insufficient_bp', position_id: pos.position_id,
        error: err.message
      });
      manualInterventions.push({ position_id: pos.position_id, type: 'reservation', reason: err.message });
    }
  }

  // ── 2. Release drift: closed positions without release ──
  const missingReleases = await db.query(
    `SELECT pp.id AS position_id, pp.proposal_id, pp.total_qty, pp.avg_entry_price,
            pp.realized_pnl, pp.status, pp.closed_at
     FROM paper_positions pp
     WHERE pp.status = 'CLOSED'
       AND pp.execution_mode = 'PAPER'
       AND NOT EXISTS (
         SELECT 1 FROM paper_account_ledger pal
         WHERE pal.position_id = pp.id AND pal.entry_type = 'release'
       )`
  );
  for (const pos of missingReleases.rows) {
    const qty = toNum(pos.total_qty) || 0;
    const price = toNum(pos.avg_entry_price) || 0;
    const originalValue = round2(qty * price);
    const realizedPnl = toNum(pos.realized_pnl) || 0;
    try {
      await releaseBuyingPower(pos.position_id, realizedPnl, originalValue);
      await auditService.recordEvent('paper_account_repair', 'paper_account', accountId, {
        repair: 'added_missing_release', position_id: pos.position_id,
        original_value: originalValue, realized_pnl: realizedPnl
      });
      repairs.push({ position_id: pos.position_id, repair: 'added_missing_release', realized_pnl: realizedPnl });
    } catch (err) {
      await auditService.recordEvent('paper_account_drift', 'paper_account', accountId, {
        type: 'release_drift_failed', position_id: pos.position_id, error: err.message
      });
      manualInterventions.push({ position_id: pos.position_id, type: 'release', reason: err.message });
    }
  }

  // ── 3. P&L drift: recompute total_realized_pnl from ledger ──
  const pnlFromLedger = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_pnl
     FROM paper_account_ledger
     WHERE account_id = $1 AND entry_type = 'realized_pnl'`,
    [accountId]
  );
  const ledgerPnl = round2(toNum(pnlFromLedger.rows[0]?.total_pnl) || 0);
  const accountPnl = round2(toNum(account.total_realized_pnl) || 0);
  if (ledgerPnl !== accountPnl) {
    await db.query(
      `UPDATE paper_account SET total_realized_pnl = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [accountId, ledgerPnl]
    );
    await auditService.recordEvent('paper_account_repair', 'paper_account', accountId, {
      repair: 'recomputed_realized_pnl', old: accountPnl, new: ledgerPnl
    });
    repairs.push({ repair: 'recomputed_realized_pnl', old: accountPnl, new: ledgerPnl });
  }

  // ── 4. Reserved-cash drift: recompute from ledger ──
  const reservedFromLedger = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'reservation' THEN amount ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN entry_type = 'release' THEN amount ELSE 0 END), 0)
        AS net_reserved
     FROM paper_account_ledger
     WHERE account_id = $1
       AND entry_type IN ('reservation', 'release')`,
    [accountId]
  );
  const ledgerReserved = round2(toNum(reservedFromLedger.rows[0]?.net_reserved) || 0);
  const accountReserved = round2(toNum(account.reserved_cash) || 0);
  const expectedReserved = Math.max(0, ledgerReserved);
  if (expectedReserved !== accountReserved) {
    // Adjust available_cash by the difference
    const diff = round2(expectedReserved - accountReserved);
    const currentAvailable = round2(toNum(account.available_cash) || 0);
    const newAvailable = round2(currentAvailable - diff);
    if (newAvailable < 0) {
      // Unsafe: fixing reserved drift would make available negative
      await auditService.recordEvent('paper_account_drift', 'paper_account', accountId, {
        type: 'reserved_cash_drift_unsafe',
        ledger_reserved: ledgerReserved, account_reserved: accountReserved,
        would_available: newAvailable
      });
      manualInterventions.push({ type: 'reserved_cash', reason: `fixing would make available negative (${newAvailable})` });
    } else {
      await db.query(
        `UPDATE paper_account SET reserved_cash = $2, available_cash = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [accountId, expectedReserved, newAvailable]
      );
      await auditService.recordEvent('paper_account_repair', 'paper_account', accountId, {
        repair: 'recomputed_reserved_cash', old: accountReserved, new: expectedReserved,
        available_after: newAvailable
      });
      repairs.push({ repair: 'recomputed_reserved_cash', old: accountReserved, new: expectedReserved });
    }
  }

  // ── 5. Orphaned reservations: reservation exists but position is CLOSED or missing ──
  const orphanedReservations = await db.query(
    `SELECT pal.position_id, pal.amount
     FROM paper_account_ledger pal
     WHERE pal.account_id = $1
       AND pal.entry_type = 'reservation'
       AND NOT EXISTS (
         SELECT 1 FROM paper_account_ledger pal2
         WHERE pal2.position_id = pal.position_id AND pal2.entry_type = 'release'
       )
       AND NOT EXISTS (
         SELECT 1 FROM paper_positions pp
         WHERE pp.id = pal.position_id AND pp.status = 'OPEN'
       )`,
    [accountId]
  );
  for (const orphan of orphanedReservations.rows) {
    // Position is closed/missing but reservation was never released
    // This is ambiguous — we don't know the P&L without the position
    await auditService.recordEvent('paper_account_drift', 'paper_account', accountId, {
      type: 'orphaned_reservation', position_id: orphan.position_id, amount: orphan.amount
    });
    manualInterventions.push({ position_id: orphan.position_id, type: 'orphaned_reservation', reason: 'reservation exists but position is closed/missing without release' });
  }

  return {
    repairs,
    manualInterventions,
    summary: {
      repairs_count: repairs.length,
      manual_count: manualInterventions.length,
      account_id: accountId,
      ledger_pnl: ledgerPnl,
      ledger_reserved: expectedReserved
    }
  };
}

module.exports = {
  getAccount,
  getAccountSummary,
  reserveBuyingPower,
  releaseBuyingPower,
  haltPaperTrading,
  unhaltPaperTrading,
  isPaperTradingHalted,
  reconcilePaperAccount,
  DEFAULT_STARTING_CASH
};
