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

- `5fedf412` — Add experimental Nasdaq halt data integration

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

### Premarket & Movers (`/market/premarket`) — In Progress
- Schwab `/marketdata/v1/movers/{index}` for $DJI, $COMPX, $SPX
- Categories: Gainers, Losers, Most Active (derived from netChange)
- Gap % calculated from batch-quoted previous close
- Catalyst badges: halts, earnings, SEC filings (existing DB data)
- Premarket volume and RVOL: not available from current Schwab endpoint
- 60-second Redis cache for Schwab movers data

## Planned Order After Nasdaq Validation

1. FINRA short-volume
2. FRED/BLS macro
3. Technical indicator engine
4. Scanner
5. Risk score
6. Position sizing
7. OpenRouter advisory
8. Paper-trade validation
9. Failure/load/backup tests
10. Kubernetes migration manifests

## Compatibility / Safety Invariants

- Preserve TradeTally iOS compatibility.
- Do not rename the `tradetally` database without a planned migration.
- Do not delete existing trading data.
- Do not migrate the job queue to Redis without a dedicated design.
- Do not enable live trading automation without explicit approval.
