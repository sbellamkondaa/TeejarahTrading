-- Deterministic Position Sizing + Risk Engine
-- Additive, non-destructive. Persists reproducible risk evaluations per proposal.
-- One row per evaluation (history preserved); latest = MAX(created_at) per proposal.

CREATE TABLE IF NOT EXISTS trade_risk_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES trade_proposals(id) ON DELETE CASCADE,
  strategy_version VARCHAR(40),                 -- strategy name + version snapshot
  state VARCHAR(10) NOT NULL,                    -- VALID | WATCH | REJECTED
  -- Reproducible inputs (exact values used to compute the result)
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Trade plan
  entry NUMERIC(14, 4),
  stop_price NUMERIC(14, 4),
  t1_price NUMERIC(14, 4),
  t2_price NUMERIC(14, 4),
  direction VARCHAR(10) NOT NULL DEFAULT 'long',
  -- Computed sizing
  risk_per_share NUMERIC(14, 4),
  max_dollar_risk NUMERIC(14, 2),
  suggested_shares INTEGER,
  total_position_value NUMERIC(14, 2),
  total_dollar_risk NUMERIC(14, 2),
  account_risk_pct NUMERIC(8, 4),
  rr_t1 NUMERIC(8, 2),
  rr_t2 NUMERIC(8, 2),
  exposure_pct NUMERIC(8, 4),
  -- Diagnostics
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Freshness / provenance
  data_as_of TIMESTAMPTZ,                        -- timestamp of freshest input used
  is_stale BOOLEAN NOT NULL DEFAULT FALSE,
  config_version VARCHAR(60) NOT NULL,           -- risk config hash/version for reproducibility
  risk_percent NUMERIC(6, 4) NOT NULL,           -- the risk % preset used
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT trade_risk_eval_state_chk CHECK (state IN ('VALID', 'WATCH', 'REJECTED')),
  CONSTRAINT trade_risk_eval_direction_chk CHECK (direction IN ('long', 'short'))
);

CREATE INDEX IF NOT EXISTS idx_risk_eval_proposal
  ON trade_risk_evaluations (proposal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_eval_state
  ON trade_risk_evaluations (state, created_at DESC);
