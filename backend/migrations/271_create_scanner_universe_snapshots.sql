-- Migration 271: Scanner universe snapshots
-- Additive. Persists the latest mover/scanner universe per session so the
-- scanner can serve a fallback candidate set when Schwab movers returns empty
-- (closed/after-hours/overnight/weekends). Stores symbols + source metadata
-- + timestamp; current prices are always re-fetched live, never served stale.

CREATE TABLE IF NOT EXISTS scanner_universe_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session VARCHAR(32) NOT NULL,
  source VARCHAR(64) NOT NULL,
  symbols TEXT[] NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scanner_snapshots_session_captured
  ON scanner_universe_snapshots (session, captured_at DESC);
