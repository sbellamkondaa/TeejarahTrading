# TeejarahTrading Project State

Updated from project context provided 2026-09-04.

## Product

Private, single-user trading journal and market-intelligence platform.
Deployed at `journal.teejarah.com`.
Advisory trading functionality only; live trading automation remains disabled.

## Deployment

Host:
- Debian 13.6
- 4 shared vCPU
- 8 GB RAM
- 80 GB SSD
- Docker
- Cloudflare Tunnel

Production services:
- `tradetally-app`
- `teejarah-worker`
- `tradetally-db`
- `teejarah-redis`
- `teejarah-cloudflared`

Production Compose stack uses:
- `docker-compose.yaml`
- `docker-compose.production.yaml`
- `docker-compose.redis.yaml`

PostgreSQL and Redis are private to the Docker network.
PostgreSQL remains the durable source of truth.

## Current Development State

Active development branch:

- `feature/data-plane-foundation`

Current known HEAD when this state file was updated:

- `92cae75f` — Add Catalyst Momentum + VWAP Reclaim strategy engine

The Nasdaq migration and client are now committed and pushed to this branch.

Treat the live Git branch, HEAD, and working tree as authoritative if this document becomes stale.
Never silently switch branches based only on this file.

## Completed / Verified

### Authentication and security
- Password login
- HTTPS-only access
- Secure session handling
- Passkey/WebAuthn
- Apple Passwords/iCloud Keychain passkey compatibility
- TOTP MFA
- Recovery codes
- Registration disabled after initial account creation
- Schwab OAuth tokens encrypted in PostgreSQL
- Cloudflare Tunnel
- UFW firewall
- Rate limiting

### Schwab
- Accounts/Trading Production connected
- Market Data Production connected
- Positions
- Balances
- Transactions
- Orders
- Broker synchronization
- Trade reconstruction
- OAuth refresh
- Encrypted token storage
- Quotes / batch quotes
- Price history / intraday candles
- Bid/ask / volume / percentage change
- Redis cache + distributed locks

Schwab is primary for quotes/candles/history.
Finnhub remains fallback/enrichment for news, earnings, profiles, and selected failures.

### Redis
- Redis 8 Alpine
- password protected
- AOF persistence
- shared cache
- distributed locks
- pub/sub
- SSE event bridge
- L1 in-memory + L2 Redis cache model

### Process separation
API role:
- frontend / Nginx / REST API
- no background schedulers

Worker role:
- scheduled jobs
- PostgreSQL queues
- broker sync
- news / earnings / scanner / SEC schedulers

Do not add duplicate schedulers.

### PostgreSQL job queue
Existing durable PostgreSQL-backed queue supports:
- priority
- `FOR UPDATE SKIP LOCKED`
- sequential and parallel workers
- retries
- stuck-job recovery
- worker monitoring

### SEC EDGAR
Implemented:
- ticker -> CIK map
- submissions
- 10-K / 10-Q / 8-K / S-1 / S-3 / 424B5
- Form 4 / 13D / 13G / 13F-HR
- Company Facts/XBRL
- rate limiting / retry / idempotent upserts
- Redis ticker-map cache
- worker-only scheduler

Verified snapshot:
- 10,412 SEC companies
- 1,075 filings
- 1,989 Company Facts
- no duplicate fact growth on repeat ingestion

## Nasdaq Halts — Production Complete

Status:

- Production complete and deployed
- Nasdaq halt scheduler enabled (`ENABLE_NASDAQ_HALT_SCHEDULER=true`)
- 60-second polling interval (`NASDAQ_HALT_INTERVAL_SECONDS=60`)
- Scheduler-status freshness tracking via `scheduler_status` table
- Idempotent upsert validated (0 duplicates across repeated polls)

Migration:
- `backend/migrations/260_create_market_halts_table.sql`

Client:
- `backend/src/services/nasdaq/nasdaqClient.js` — RSS feed parser, idempotent ingest

Scheduler:
- `backend/src/services/nasdaq/nasdaqHaltScheduler.js` — IntervalScheduler, overlap guard, records to SchedulerStatusService

## Market Intelligence — Current Active Development

### Market Overview (`/market`)
- Live index quotes (SPY, QQQ, IWM, DIA) via Schwab
- Trading halts from `market_halts` with freshness metadata
- Market news via Finnhub company news
- Upcoming earnings from `dashboard_earnings_cache`
- Recent SEC filings from `sec_filings`

### Trading Halts (`/market/halts`)
- Dedicated page with status/market/reason/symbol filters
- Reason-code mapping (T1, T12, H11, LUDP, M, etc.)
- Freshness via `scheduler_status` (not row created_at)
- "Automatic updates off" when scheduler disabled

### Premarket & Movers (`/market/premarket`) — Production
- Schwab `/marketdata/v1/movers/{index}` for $DJI, $COMPX, $SPX
- Categories: Gainers, Losers, Most Active (derived from netChange)
- Gap % calculated from batch-quoted previous close
- Catalyst badges: halts, earnings, SEC filings (existing DB data)
- Premarket volume and RVOL: not available from current Schwab endpoint
- 60-second Redis cache for Schwab movers data
- Bounded polling: 30s auto-refresh, stops on tab hidden

### Scanner (`/market/scanner`) — Production
- 13 deterministic setup types (gap+catalyst, momentum, RVOL surge, VWAP, ORB, breakout, RS, earnings, SEC, halt, volume)
- Penny-stock policy: sub-$5 excluded by default; exception only with strong verified catalyst (earnings/halt) + acceptable liquidity + no dilution risk
- Dilution-risk detection: S-1, S-3, 424B5 filings flagged; penny stocks with dilution REJECTED; non-penny get WATCH + score penalty
- Classification: TRADE (score >= 70, no dilution), WATCH (qualifies/dilution), AVOID_CHASING (extended move), AVOID (penny/weak)
- Technical indicator engine: EMA 9/20/50/200, VWAP, ATR, RVOL, gap, OR, HOD/LOD, volume trend, S/R, relative strength, volatility regime, liquidity
- Bounded polling: 30s auto-refresh

### Fundamental + Catalyst Engine (Phase 4) — Production
- Fundamental Engine (`fundamentalEngine.js`): per-symbol profiles from Finnhub
  basic financials — revenue growth, EPS TTM, margins, cash, D/E, FCF, shares,
  market cap, cash runway (loss-making), share trend. Per-metric source/period/
  as_of metadata. 5-min cache, batched concurrency 5.
- Dilution Risk Engine (`dilutionRiskEngine.js`): S-1/S-3 shelf + 424B4/424B5
  prospectus detection with 90-day lookback. LOW/MEDIUM/HIGH with evidence
  (form, date, URL). Ordinary 8-K/10-K never flagged. Batched single query.
- Catalyst Engine (`catalystEngine.js`): normalizes halts/earnings/SEC filings/
  Form 4 into typed catalysts. Deterministic strength 0-100 (source quality 20,
  recency 30, materiality 30, specificity 10, price/volume confirmation 10).
  No LLM confidence. No causation claims.
- Scanner candidates enriched with fundamental_summary, dilution_risk,
  catalyst_strength, catalyst_evidence. Expandable UI details with evidence links.

### Extended Market Indices — Production
- SPY, QQQ, IWM, DIA, $VIX (CBOE Volatility Index), $COMPX (Nasdaq Composite)
- Schwab-verified symbols: $VIX=14.19, $COMPX=26584 (live)
- /api/market/indices?extended=true returns all 6
- Movers and Scanner index strips show all 6

### Event / Relationship Graph (`/market/relationships`) — Production
- Industry peers from Finnhub `/stock/peers` (24h cache in finnhubClient)
- Company profile (industry, market cap, country, exchange) from Finnhub `/stock/profile2`
- 30-day Pearson price correlation from Schwab daily candles
- 1h Redis cache for graph structure (peers + correlations); quotes always fresh
- Click-through peer navigation; symbol query param supported
- GET /api/market/relationships/:symbol (auth-gated, sanitized)

### Realtime Architecture
- No Schwab streaming/WebSocket available in codebase
- SSE infrastructure exists for notifications (Redis pub/sub + text/event-stream)
- Bounded polling fallback: 30s for market data, 60s for halts
- Redis quote cache: 30s TTL (Schwab quotes), 60s TTL (Schwab movers)
- Polling stops on tab hidden, resumes on visible
- No per-browser provider connections; no per-symbol API calls

## Trading Automation Foundation — Production

Migration: `261_create_trading_automation_tables.sql` (additive, non-destructive)

Tables:
- `trading_strategies` — versioned strategy definitions (name + version unique)
- `trade_signals` — signals with feature_snapshot, status lifecycle
- `trade_proposals` — immutable snapshots (market/catalyst/technical/fundamental),
  execution_mode (BACKTEST/PAPER/LIVE, default PAPER), lifecycle_state state machine
- `trade_approvals` — approval decisions (approved/rejected/watch)
- `trading_audit_events` — immutable append-only audit log

Services:
- `strategyService.js` — versioned strategy CRUD
- `signalService.js` — signal creation with feature snapshot
- `proposalService.js` — proposal lifecycle, state-machine transitions, edit (entry/stop/targets/risk only)
- `auditService.js` — append-only event recording
- `executionMode.js` — BACKTEST/PAPER/LIVE abstraction, LIVE gated behind ENABLE_LIVE_TRADING

API: `/api/trading/{strategies,signals,proposals,execution-mode}` (all auth-gated)

Feature flags (all default false):
- `ENABLE_LIVE_TRADING=false`
- `ENABLE_AUTO_EXECUTION=false`
- `ENABLE_SMALL_CAP_MOMENTUM=false`

Frontend: `/trading/proposals` — proposal list with filters, detail modal,
APPROVE / REJECT / WATCH / EDIT actions

Safety:
- Approval does NOT submit broker orders — advisory only
- No live execution implemented
- No autonomous trading implemented

## Catalyst Momentum + VWAP Reclaim Strategy — Production

Migration: `262_seed_catalyst_momentum_strategy.sql` (idempotent insert)

Strategy: `catalyst_momentum_vwap_reclaim` v1, status active

Engine: `backend/src/services/trading/catalystMomentumStrategy.js`
- Scans Schwab movers ($COMPX, $DJI, $SPX) for VWAP reclaim setups
- 5-minute primary timeframe, daily context
- Filters: gap >= 3%, RVOL >= 2 (when available), catalyst strength >= 30,
  VWAP distance 0.1–5%, spread <= 0.5%, liquidity (rejects very_low),
  price >= $5, ADV >= 1M, OTC excluded
- Penny-stock/dilution policy: dilution warnings from dilutionRiskEngine
- Two entry modes: reclaim_breakout (entry above reclaim candle high),
  vwap_retest_hold (price near VWAP)
- ATR-based stops, R:R-anchored T1 (2R) / T2 (4R) / runner (8R) targets
- Immutable snapshots: feature, market, catalyst, technical, fundamental evidence
- Advisory only — creates PAPER proposals snapshots, no broker execution

API: `POST /api/trading/strategies/:id/scan` (auth-gated)
Frontend: Run Scan button on `/trading/proposals`

## Compatibility / Safety Invariants

- Preserve TradeTally iOS compatibility.
- Do not rename the `tradetally` database without a planned migration.
- Do not delete existing trading data.
- Do not migrate the job queue to Redis without a dedicated design.
- Do not enable live trading automation without explicit approval.
## Active Product Direction

Teejarah is evolving from market intelligence + journaling into a semi-automated trading platform.

Initial production workflow:

SCAN
→ ANALYZE
→ RISK CHECK
→ USER APPROVAL
→ EXECUTE
→ MANAGE
→ JOURNAL

Current safety defaults:

- ENABLE_LIVE_TRADING=false
- ENABLE_AUTO_EXECUTION=false
- ENABLE_SMALL_CAP_MOMENTUM=false
- Short selling disabled

### Already complete

- Market Overview
- Premarket & Movers
- Trading Halts
- Nasdaq scheduler
- Technical Indicator Engine
- Deterministic Scanner
- Fundamental/Catalyst Engine
- Dilution-risk checks
- VIX / Nasdaq market context
- Schwab market-data integration
- Redis caching
- bounded live polling

### Next milestones

1. Trading Automation Foundation ← COMPLETED
   - versioned strategies
   - signals
   - trade proposals
   - approvals
   - immutable audit events
   - execution-mode abstraction

2. Catalyst Momentum + VWAP Reclaim strategy ← COMPLETED
   - versioned strategy seeded (migration 262)
   - VWAP reclaim + catalyst validation
   - gap/RVOL/liquidity/spread filters
   - two entry modes (reclaim breakout, retest/hold)
   - ATR stops, R:R targets
   - immutable proposal snapshots
   - advisory only (PAPER)

3. Deterministic Position Sizing + Risk Engine

4. Paper Broker

5. Order / Position State Machine

6. Journal + reconciliation integration

7. Backtesting / empirical probabilities

8. Schwab live execution behind feature flag + explicit approval

9. Automated T1/T2/stop management

10. Live Trading Workstation integration

11. AI model bake-off and advisory layer

12. Optional individually-approved automation strategies
