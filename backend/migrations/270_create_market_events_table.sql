-- Migration 270: Market Intelligence V2 — persistent normalized event store
-- Additive, non-destructive. Stores normalized market events/news with source
-- metadata, classification, materiality, deduplication keys, and symbol links.
-- Full copyrighted article bodies are NOT stored — only headlines, short
-- summaries (where permitted), source URLs, and structured event facts.

CREATE TABLE IF NOT EXISTS market_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(64) NOT NULL,
  source_event_id VARCHAR(255) NOT NULL,
  source_url TEXT,
  source_tier VARCHAR(32) NOT NULL DEFAULT 'AGGREGATOR',
  published_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  headline TEXT,
  summary TEXT,
  event_type VARCHAR(64) NOT NULL DEFAULT 'GENERAL_NEWS',
  materiality SMALLINT NOT NULL DEFAULT 5 CHECK (materiality >= 0 AND materiality <= 10),
  verification_state VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED',
  primary_source BOOLEAN NOT NULL DEFAULT FALSE,
  sentiment NUMERIC(4,2),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedup_key VARCHAR(255) NOT NULL,
  canonical_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT market_events_unique UNIQUE (source, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_market_events_published
  ON market_events (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_events_event_type
  ON market_events (event_type, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_events_source_tier
  ON market_events (source_tier, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_events_dedup
  ON market_events (dedup_key);

CREATE INDEX IF NOT EXISTS idx_market_events_canonical
  ON market_events (canonical_event_id)
  WHERE canonical_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_event_symbols (
  market_event_id UUID NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  symbol VARCHAR(32) NOT NULL,
  relevance SMALLINT NOT NULL DEFAULT 5 CHECK (relevance >= 0 AND relevance <= 10),
  PRIMARY KEY (market_event_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_market_event_symbols_symbol
  ON market_event_symbols (symbol, market_event_id);

-- Source health/freshness tracking (reuses the existing scheduler_status table
-- for scheduler runs; this table tracks per-source fetch health for adapters
-- that are not IntervalScheduler-based or need richer per-source diagnostics).
CREATE TABLE IF NOT EXISTS market_event_source_health (
  source VARCHAR(64) PRIMARY KEY,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  last_fetch_duration_ms INTEGER,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  dedup_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
