-- PAPER Account Cash Ledger
-- Persistent PAPER trading account with cash, reserved buying power, realized P&L.
-- PostgreSQL remains authoritative. No margin modeling.
-- Additive, non-destructive.

CREATE TABLE IF NOT EXISTS paper_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  starting_cash NUMERIC(14, 2) NOT NULL DEFAULT 100000,
  available_cash NUMERIC(14, 2) NOT NULL DEFAULT 100000,
  reserved_cash NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0,
  paper_trading_halted BOOLEAN NOT NULL DEFAULT FALSE,
  halted_at TIMESTAMPTZ,
  halted_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Single-row constraint: only one paper account (single-user platform).
-- If user_id is NULL, it's the global paper account.
INSERT INTO paper_account (starting_cash, available_cash)
SELECT 100000, 100000
WHERE NOT EXISTS (SELECT 1 FROM paper_account);

-- Ledger entries for audit trail (reservation, release, pnl application)
CREATE TABLE IF NOT EXISTS paper_account_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES paper_account(id) ON DELETE CASCADE,
  entry_type VARCHAR(20) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  position_id UUID REFERENCES paper_positions(id) ON DELETE SET NULL,
  proposal_id UUID,
  balance_after NUMERIC(14, 2) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT paper_ledger_type_chk CHECK (entry_type IN (
    'reservation', 'release', 'realized_pnl', 'adjustment', 'halt', 'unhalt'
  ))
);

CREATE INDEX IF NOT EXISTS idx_paper_account_ledger_account
  ON paper_account_ledger (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_account_ledger_position
  ON paper_account_ledger (position_id);

-- Prevent double reservation and double release at the database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_ledger_unique_reservation
  ON paper_account_ledger (position_id) WHERE entry_type = 'reservation';

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_ledger_unique_release
  ON paper_account_ledger (position_id) WHERE entry_type = 'release';
