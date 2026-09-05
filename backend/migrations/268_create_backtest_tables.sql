-- Backtesting + Empirical Strategy Statistics
-- Deterministic historical backtesting for versioned strategies.
-- Stores backtest runs with full reproducibility data and individual simulated trades.
-- BACKTEST mode only — no PAPER order creation, no LIVE execution, no Schwab order API calls.

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
  strategy_name VARCHAR(100) NOT NULL,
  strategy_version INTEGER NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  symbols TEXT[] NOT NULL DEFAULT '{}'::text[],
  execution_assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_trades INTEGER NOT NULL DEFAULT 0,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  segmented_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CONSTRAINT backtest_runs_status_chk CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy
  ON backtest_runs (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_date
  ON backtest_runs (date_from, date_to);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'long',
  entry_date DATE NOT NULL,
  entry_time TIMESTAMPTZ,
  entry_price NUMERIC(14, 4) NOT NULL,
  stop_price NUMERIC(14, 4) NOT NULL,
  t1_price NUMERIC(14, 4),
  t2_price NUMERIC(14, 4),
  exit_price NUMERIC(14, 4),
  exit_time TIMESTAMPTZ,
  exit_reason VARCHAR(20) NOT NULL,
  r_multiple NUMERIC(10, 4) NOT NULL,
  hold_bars INTEGER NOT NULL DEFAULT 0,
  hold_seconds INTEGER NOT NULL DEFAULT 0,
  t1_hit BOOLEAN NOT NULL DEFAULT FALSE,
  t2_hit BOOLEAN NOT NULL DEFAULT FALSE,
  stop_hit BOOLEAN NOT NULL DEFAULT FALSE,
  -- Segmentation attributes (recorded at signal time — no lookahead)
  gap_pct NUMERIC(10, 4),
  rvol NUMERIC(10, 4),
  catalyst_strength INTEGER,
  catalyst_type VARCHAR(40),
  market_regime VARCHAR(40),
  volatility_regime VARCHAR(40),
  liquidity_rating VARCHAR(20),
  dilution_risk_level VARCHAR(10),
  penny_stock BOOLEAN NOT NULL DEFAULT FALSE,
  strategy_version VARCHAR(40) NOT NULL,
  segment_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_run
  ON backtest_trades (run_id, entry_date);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_symbol
  ON backtest_trades (run_id, symbol);
