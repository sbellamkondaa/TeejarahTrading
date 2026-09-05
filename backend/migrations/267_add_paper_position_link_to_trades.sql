-- Journal + Execution Event Integration: link paper positions to trades table.
-- Additive, non-destructive. Adds paper_position_id and execution_mode to trades
-- so that the journal can auto-create/update trades from PAPER execution events.
--
-- Idempotency: a UNIQUE index on paper_position_id ensures at most one trade
-- per paper position. The journal sync service uses ON CONFLICT to upsert
-- only execution-derived fields — never user-entered notes, tags, strategy, etc.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS paper_position_id UUID REFERENCES paper_positions(id) ON DELETE SET NULL;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(10);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_paper_position_id_unique
  ON trades (paper_position_id)
  WHERE paper_position_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trades_execution_mode
  ON trades (execution_mode)
  WHERE execution_mode IS NOT NULL;

COMMENT ON COLUMN trades.paper_position_id IS 'FK to paper_positions — links auto-created journal trades to PAPER execution state';
COMMENT ON COLUMN trades.execution_mode IS 'Execution mode: PAPER (auto-created from paper broker), or NULL for manually imported trades';
