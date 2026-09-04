-- Trading Automation Foundation
-- Versioned strategies, signals, trade proposals, approvals, immutable audit events.
-- No execution logic here — live trading remains disabled behind feature flags.

CREATE TABLE IF NOT EXISTS trading_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT trading_strategies_name_version_unique UNIQUE (name, version),
  CONSTRAINT trading_strategies_status_chk CHECK (status IN ('draft', 'active', 'paused', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_trading_strategies_name
  ON trading_strategies (name, version DESC);

CREATE TABLE IF NOT EXISTS trade_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  signal_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(30) NOT NULL DEFAULT 'SIGNAL_DETECTED',
  CONSTRAINT trade_signals_direction_chk CHECK (direction IN ('long', 'short')),
  CONSTRAINT trade_signals_status_chk CHECK (status IN (
    'SIGNAL_DETECTED', 'SIGNAL_VALIDATING', 'READY_FOR_APPROVAL',
    'APPROVED', 'REJECTED', 'WATCH', 'EXPIRED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_trade_signals_strategy
  ON trade_signals (strategy_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_signals_symbol
  ON trade_signals (symbol, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_signals_status
  ON trade_signals (status)
  WHERE status IN ('SIGNAL_DETECTED', 'SIGNAL_VALIDATING', 'READY_FOR_APPROVAL');

CREATE TABLE IF NOT EXISTS trade_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES trade_signals(id) ON DELETE CASCADE,
  strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  execution_mode VARCHAR(10) NOT NULL DEFAULT 'PAPER',
  lifecycle_state VARCHAR(40) NOT NULL DEFAULT 'READY_FOR_APPROVAL',
  entry_zone JSONB NOT NULL,
  stop_price NUMERIC(14, 4),
  t1_price NUMERIC(14, 4),
  t2_price NUMERIC(14, 4),
  runner_target NUMERIC(14, 4),
  position_size INTEGER,
  risk_amount NUMERIC(14, 2),
  rr_ratio NUMERIC(8, 2),
  market_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  catalyst_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  technical_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  fundamental_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  historical_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT trade_proposals_direction_chk CHECK (direction IN ('long', 'short')),
  CONSTRAINT trade_proposals_mode_chk CHECK (execution_mode IN ('BACKTEST', 'PAPER', 'LIVE')),
  CONSTRAINT trade_proposals_state_chk CHECK (lifecycle_state IN (
    'SIGNAL_DETECTED', 'SIGNAL_VALIDATING', 'READY_FOR_APPROVAL',
    'APPROVED', 'REJECTED', 'WATCH',
    'ENTRY_SUBMITTED', 'ENTRY_PARTIALLY_FILLED', 'ENTRY_FILLED',
    'ENTRY_CANCELLED', 'POSITION_ACTIVE', 'T1_FILLED', 'T2_FILLED',
    'STOP_FILLED', 'POSITION_CLOSED', 'ERROR', 'MANUAL_INTERVENTION_REQUIRED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_trade_proposals_signal
  ON trade_proposals (signal_id);

CREATE INDEX IF NOT EXISTS idx_trade_proposals_strategy
  ON trade_proposals (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_proposals_symbol
  ON trade_proposals (symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_proposals_state
  ON trade_proposals (lifecycle_state)
  WHERE lifecycle_state IN ('READY_FOR_APPROVAL', 'APPROVED');

CREATE TABLE IF NOT EXISTS trade_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES trade_proposals(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision VARCHAR(20) NOT NULL,
  note TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT trade_approvals_decision_chk CHECK (decision IN ('approved', 'rejected', 'watch'))
);

CREATE INDEX IF NOT EXISTS idx_trade_approvals_proposal
  ON trade_approvals (proposal_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_approvals_user
  ON trade_approvals (user_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS trading_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_audit_entity
  ON trading_audit_events (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trading_audit_type
  ON trading_audit_events (event_type, created_at DESC);