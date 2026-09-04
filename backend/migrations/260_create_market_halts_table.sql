CREATE TABLE IF NOT EXISTS market_halts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) NOT NULL,
  halt_type VARCHAR(50) NOT NULL,
  reason TEXT,
  exchange VARCHAR(32),
  halted_at TIMESTAMPTZ NOT NULL,
  resume_at TIMESTAMPTZ,
  is_resumption BOOLEAN NOT NULL DEFAULT FALSE,
  source_hash CHAR(64) NOT NULL,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT market_halts_unique UNIQUE (symbol, halted_at, halt_type)
);

CREATE INDEX IF NOT EXISTS idx_market_halts_symbol_halted
  ON market_halts (symbol, halted_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_halts_halted_at
  ON market_halts (halted_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_halts_resume
  ON market_halts (resume_at)
  WHERE resume_at IS NOT NULL;
