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
- Classification: TRADE (score >= 70), WATCH, AVOID
- Technical indicator engine: EMA 9/20/50/200, VWAP, ATR, RVOL, gap, OR, HOD/LOD, volume trend, S/R, relative strength, volatility regime, liquidity
- Bounded polling: 30s auto-refresh

### Extended Market Indices — Production
- SPY, QQQ, IWM, DIA, $VIX (CBOE Volatility Index), $COMPX (Nasdaq Composite)
- Schwab-verified symbols: $VIX=14.19, $COMPX=26584 (live)
- /api/market/indices?extended=true returns all 6
- Movers and Scanner index strips show all 6

### Realtime Architecture
- No Schwab streaming/WebSocket available in codebase
- SSE infrastructure exists for notifications (Redis pub/sub + text/event-stream)
- Bounded polling fallback: 30s for market data, 60s for halts
- Redis quote cache: 30s TTL (Schwab quotes), 60s TTL (Schwab movers)
- Polling stops on tab hidden, resumes on visible
- No per-browser provider connections; no per-symbol API calls

## Planned Order After Nasdaq Validation

1. Technical indicator engine ← IN PROGRESS
2. Deterministic scanner
3. Fundamental / catalyst engine
4. Event / relationship graph
5. Additional official/free data (FRED/BLS, FINRA, FDA, ClinicalTrials.gov, 13F)
6. Empirical outcome / learning engine
7. AI model bake-off (OpenRouter multi-model)
8. AI trade advisor
9. Real-time plan re-evaluation
10. Daily trade candidates
11. Research trackers (Form 4, 13F, congressional)
12. Education (contextual Learn links)
13. Risk / position sizing
14. Automated QA / Playwright browser smoke tests

## Capability Audit (Phase 1)

### Exists — Production
- Schwab quotes/batch-quotes/candles/price-history/movers (`schwabMarketData.js`)
- Finnhub quotes/news/earnings/profile/candles/technical-indicators/patterns/support-resistance/basic-financials/financial-statements (`finnhubClient.js`)
- Finnhub recommendation trends — AVAILABLE (403 on upgrade-downgrade and price-target)
- SEC filings + company facts ingestion from EDGAR (`sec/`)
- Nasdaq halts RSS + scheduler + freshness
- Redis cache (`redisCache.js`), scheduler infrastructure (`IntervalScheduler`, `schedulerStatusService`)
- AI multi-provider (`aiProvider.js`: OpenAI, DeepSeek, Gemini, Claude, Kimi, Perplexity, Ollama, LMStudio, custom)
- AI session service for trade analysis chat (`aiSessionService.js`)
- 8-pillars stock scanner (`stockScannerService.js`, `eightPillarsService.js`) — Russell 2000 fundamentals scan
- Fundamental data service (`fundamentalDataService.js`) — financials, metrics, analyst estimates
- DCF valuation (`dcfValuationService.js`)
- Historical price cache (`historicalPriceCache.js`)
- Backtest sessions (`backtestService.js`)
- Chart service for trade data (`chartService.js`)
- Market Overview, Premarket & Movers, Trading Halts — all live

### Missing
- Server-side technical indicator calculations (EMA, VWAP, ATR, RVOL, opening range, HOD/LOD, etc.)
- Deterministic technical setup scanner (gap+catalyst, ORB, VWAP reclaim, momentum, etc.)
- S-3/shelf/ATM/424B5/Form 4 detection and dilution-risk analysis
- Event/relationship graph (sector, competitors, suppliers, ETF, correlation)
- Additional data: FDA, ClinicalTrials.gov, FRED/BLS, FINRA, USAspending, Congressional disclosures, 13F tracking
- Empirical outcome tracking (candidate snapshots, outcome measurement, setup statistics)
- OpenRouter multi-model benchmarking framework
- AI trade advisor (structured trade plans with entry/stop/targets)
- Real-time plan re-evaluation (deterministic triggers, plan versioning)
- Daily trade candidates page
- Research trackers (insider Form 4, 13F, congressional, analyst changes)
- Contextual education content
- Position sizing calculator
- Playwright/browser E2E smoke tests

## Compatibility / Safety Invariants

- Preserve TradeTally iOS compatibility.
- Do not rename the `tradetally` database without a planned migration.
- Do not delete existing trading data.
- Do not migrate the job queue to Redis without a dedicated design.
- Do not enable live trading automation without explicit approval.
