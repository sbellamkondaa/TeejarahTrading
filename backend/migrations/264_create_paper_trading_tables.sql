-- Paper Broker — simulated paper trading positions and order fills.
-- Additive, non-destructive. Tracks paper execution lifecycle for
-- PAPER-mode trade proposals (no live broker interaction).
--
-- Design:
--   paper_orders tracks the full order lifecycle (PENDING → SUBMITTED →
--   PARTIALLY_FILLED → FILLED / CANCELLED / REJECTED / EXPIRED) with
--   idempotent submission via client_order_id.
--   paper_positions tracks the aggregate position from filled orders.
--   PostgreSQL is the source of truth — all state is reconstructable
--   after restart. Redis is never authoritative for order/position state.

CREATE TABLE IF NOT EXISTS paper_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES trade_proposals(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES trade_signals(id) ON DELETE SET NULL,
  strategy_id UUID REFERENCES trading_strategies(id) ON DELETE SET NULL,
  strategy_version VARCHAR(80),
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  total_qty INTEGER NOT NULL,
  remaining_qty INTEGER NOT NULL,
  avg_entry_price NUMERIC(14, 4) NOT NULL,
  realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status VARCHAR(10) NOT NULL DEFAULT 'OPEN',
  execution_mode VARCHAR(10) NOT NULL DEFAULT 'PAPER',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ,
  CONSTRAINT paper_positions_direction_chk CHECK (direction IN ('long', 'short')),
  CONSTRAINT paper_positions_status_chk CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT paper_positions_mode_chk CHECK (execution_mode IN ('BACKTEST', 'PAPER', 'LIVE')),
  CONSTRAINT paper_positions_qty_chk CHECK (total_qty > 0 AND remaining_qty >= 0)
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_proposal
  ON paper_positions (proposal_id);

CREATE INDEX IF NOT EXISTS idx_paper_positions_status
  ON paper_positions (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS paper_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id UUID NOT NULL,
  position_id UUID REFERENCES paper_positions(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL REFERENCES trade_proposals(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES trade_signals(id) ON DELETE SET NULL,
  strategy_id UUID REFERENCES trading_strategies(id) ON DELETE SET NULL,
  strategy_version VARCHAR(80),
  symbol VARCHAR(20) NOT NULL,
  side VARCHAR(10) NOT NULL,
  order_type VARCHAR(20) NOT NULL,
  execution_mode VARCHAR(10) NOT NULL DEFAULT 'PAPER',
  quantity INTEGER NOT NULL,
  filled_qty INTEGER NOT NULL DEFAULT 0,
  limit_price NUMERIC(14, 4),
  stop_price NUMERIC(14, 4),
  avg_fill_price NUMERIC(14, 4),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  submitted_at TIMESTAMPTZ,
  filled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT paper_orders_client_id_unique UNIQUE (client_order_id),
  CONSTRAINT paper_orders_side_chk CHECK (side IN ('buy', 'sell')),
  CONSTRAINT paper_orders_order_type_chk CHECK (order_type IN ('entry', 't1', 't2', 'stop', 'manual_close', 'stop_close')),
  CONSTRAINT paper_orders_status_chk CHECK (status IN (
    'PENDING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED',
    'CANCELLED', 'REJECTED', 'EXPIRED'
  )),
  CONSTRAINT paper_orders_mode_chk CHECK (execution_mode IN ('BACKTEST', 'PAPER', 'LIVE')),
  CONSTRAINT paper_orders_qty_chk CHECK (quantity > 0),
  CONSTRAINT paper_orders_filled_qty_chk CHECK (filled_qty >= 0 AND filled_qty <= quantity)
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_position
  ON paper_orders (position_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_orders_proposal
  ON paper_orders (proposal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_orders_status
  ON paper_orders (status, created_at DESC);
