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

- `1e155a5c` — Add Paper Broker / Execution Simulator with fill simulation, protective exits, idempotent submission, and reconciliation

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

## Deterministic Position Sizing + Risk Engine — Production

Migration: `263_create_trade_risk_evaluations.sql` (additive — persists
reproducible risk evaluations per proposal with full input snapshot, account
snapshot, computed sizing, diagnostics, freshness, and config version).

Engine: `backend/src/services/trading/riskEngine.js`

Pure, side-effect-free position sizing + hard-risk validation per
PRODUCT_REQUIREMENTS.md "Position Sizing":

  risk_per_share    = abs(entry - stop) + slippage + fees
  max_dollar_risk   = account_equity * risk_percent
  suggested_shares  = floor(max_dollar_risk / risk_per_share)

Also computes: total_position_value, total_dollar_risk, account_risk_pct,
R:R to T1, R:R to T2, exposure_pct.

Result state (deterministic):
- VALID    — all HARD checks passed and all required inputs present
- WATCH    — not rejected, but one or more HARD checks could not be evaluated
             (missing optional data); never VALID, never REJECTED
- REJECTED — at least one HARD check failed

Principle: a HARD check that cannot be evaluated due to missing data yields
WATCH. Values are NEVER fabricated.

Risk presets: 0.25%, 0.50%, 1.00% (configurable; cannot exceed maxRiskPerTradePct).

Hard checks (reject on failure):
- valid entry / stop (missing or non-positive)
- positive directional risk (stop on correct side)
- penny-stock policy (price >= $5)
- quantity > 0
- max risk per trade (default 2% of equity)
- max position % (default 25%)
- max total exposure (default 100%)
- max sector exposure (default 40%)
- max open positions (default 10)
- max pending entries (default 5)
- max trades per day (default 10)
- max consecutive losses (default 5)
- duplicate active position (rejected when not allowed)
- max daily loss (default 6%)
- max weekly loss (default 12%)
- buying power (when available)
- max spread (default 0.5%)
- max slippage (default $0.10/share)
- min liquidity rating (default `low`; rejects `very_low`)
- min ADV (default 1,000,000)
- min RVOL (default 1.0)
- max participation rate (default 10% of ADV)
- stale data (default 60s max quote age)
- halted security
- HIGH dilution risk
- min R:R to T1 (default 1.5)

Account equity sourced deterministically from `user_settings.account_equity`.
Portfolio context (open positions, exposure, duplicate detection) loaded from
`trade_proposals` via `getPortfolioRiskContext`.

Proposal integration (risk engine authoritative):
- Proposals are only READY_FOR_APPROVAL when risk state is VALID or WATCH.
  REJECTED/unevaluated proposals start in SIGNAL_DETECTED.
- `transitionState` and `recordApproval` reject approval when risk is
  REJECTED, missing, or stale (proposal edited after evaluation, or age > 60s).
- Strategy code cannot bypass risk rejection.
- Stale market/account data requires recalculation before approval.

Persistence: `persistEvaluation` stores the full input_snapshot, account_snapshot,
computed sizing, checks, warnings, rejection_reasons, data_as_of, is_stale,
config_version, and risk_percent — fully reproducible from stored inputs.

Integration: catalyst momentum strategy scan evaluates risk for each candidate,
populates position_size/risk_amount on VALID/WATCH proposals, persists the
evaluation, and creates REJECTED proposals in SIGNAL_DETECTED (advisory).

APIs (auth-gated, advisory only — never places broker orders):
- `POST /api/trading/proposals/:id/risk-assessment` — recalculate + persist.
  Accepts only riskPercent (preset) and entryPrice from client; all
  market-quality inputs sourced server-side to prevent fabrication.
- `GET /api/trading/proposals/:id/risk-evaluation` — read latest persisted.
- `GET /api/trading/risk-presets` — allowed presets + default + max.

Frontend: `/trading/proposals` detail modal shows risk section (state badge,
preset selector with Recalculate, account equity, max $ risk, risk/share,
suggested shares, position value, total risk, R:R T1/T2, exposure %,
warnings, rejection reasons, staleness indicator).

Tests: `backend/tests/services/riskEngine.test.js` (47 cases: sizing formula,
all hard-rejection paths, VALID/WATCH/REJECTED states, short direction,
determinism/reproducibility, approval-gate helpers). Route wiring covered by
`trading.routes.test.js`.

## Paper Broker / Execution Simulator — Production

Migration: `264_create_paper_trading_tables.sql` (additive — paper_positions +
paper_orders with full order lifecycle, client_order_id for idempotency).

Engine: `backend/src/services/trading/paperBroker.js`

Execution Adapter Pattern:
- PaperExecutionAdapter implements simulated fills from Schwab/Finnhub quotes.
- Future SchwabExecutionAdapter would implement the same interface with real
  broker API calls. Proposal/risk/state-machine interfaces are reusable.

Fill Simulation (deterministic — no random fills):
- Marketable limit buy:  fill when ask ≤ limit_price (fill at ask)
- Non-marketable limit:  stays SUBMITTED until market reaches limit
- Stop sell:             fill when bid ≤ stop_price (fill at worse of stop/bid)
- Limit sell (T1/T2):   fill when bid ≥ limit_price (fill at bid)
- Manual close:          fill at current bid
- Partial fills:         configurable fill ratio (default 1.0 = full fill)
- Slippage:              configurable per-share deduction (default $0.00)

Protective Exit Invariant:
- Exits split: T1 = floor(total/3), T2 = floor(total/3), Stop = runner (1/3)
- Hard invariant: total active sell quantity ≤ remaining position quantity
- When stop triggers: cancel pending T1/T2, sell full remaining at stop price
- No live broker OCO implemented (paper simulation only)

Order Lifecycle:
- States: PENDING, SUBMITTED, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, EXPIRED
- Idempotent submission via client_order_id (UUID)
- Persists: client_order_id, proposal_id, signal_id, strategy_id, strategy_version,
  symbol, side, order_type, execution_mode, quantity, filled_qty, limit_price,
  stop_price, avg_fill_price, status, submitted_at, filled_at, cancelled_at

Position Lifecycle:
- Tracks: symbol, direction, total_qty, remaining_qty, avg_entry_price,
  realized_pnl, unrealized_pnl (computed on demand), status, execution_mode,
  source proposal/signal/strategy, opened_at, closed_at
- Short positions unsupported (short selling disabled)

Operations:
- submitEntry: APPROVED → ENTRY_SUBMITTED → (fill) → ENTRY_FILLED → POSITION_ACTIVE
- processFills: checks active sell orders against current quotes, fills if conditions met
- cancelEntry: ENTRY_SUBMITTED → ENTRY_CANCELLED
- updateStop: cancel old stop, create new (no averaging down — stop must be below entry)
- manualClose: sell remaining at current bid, cancel all pending orders
- reconcile: verify position state matches order history from PostgreSQL

Reconciliation:
- PostgreSQL is source of truth. All order/position state reconstructable.
- Redis never authoritative for order/position state.

Safety:
- PAPER execution mode only (LIVE gated behind ENABLE_LIVE_TRADING)
- Short selling disabled
- Risk engine authoritative: stale/rejected evaluation blocks entry
- No position quantity increase above approved risk size
- No averaging down, no martingale
- Never places live broker orders (only finnhub.getQuote for fill simulation)
- processFills rejects if proposal in ERROR/MANUAL_INTERVENTION_REQUIRED state

APIs (auth-gated, PAPER only — never places broker orders):
- `POST /api/trading/proposals/:id/paper-entry` — submit entry (idempotent)
- `POST /api/trading/proposals/:id/paper-fills` — process fills for active orders
- `POST /api/trading/proposals/:id/paper-cancel-entry` — cancel pending entry
- `PATCH /api/trading/proposals/:id/paper-stop` — update stop price
- `POST /api/trading/proposals/:id/paper-manual-close` — close position at market
- `GET /api/trading/proposals/:id/paper-reconcile` — reconcile from PostgreSQL
- `GET /api/trading/proposals/:id/paper-position` — position + orders + unrealized P&L
- `GET /api/trading/paper-positions` — list all positions
- `GET /api/trading/paper-orders` — list all orders
- `GET /api/trading/paper-account` — account summary (open/closed P&L)

Frontend: `/trading/proposals` — PAPER-labeled execution UI with:
- Execute Paper Entry button (APPROVED + PAPER mode)
- Pending entry: Check Fills + Cancel Entry buttons
- Active position: entry price, qty, remaining, realized + unrealized P&L,
  paper orders list with status, Check Fills + Manual Close + Update Stop
- All PAPER state clearly labeled with indigo badge

Tests: `backend/tests/services/paperBroker.test.js` (71 cases: fill simulation
for all order types, idempotency, entry gating, protective exits with invariant,
cancel entry, update stop, manual close, reconciliation, account summary,
no live broker calls). Route wiring: `trading.routes.test.js` (4 cases).

Review: fast-review found 3 issues, all fixed:
- stop_close order missing filled_qty/avg_fill_price → fixed
- processFills missing lifecycle state guard → added ERROR/MANUAL_INTERVENTION check
- unused quoteStaleMs config → removed

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

3. Deterministic Position Sizing + Risk Engine ← COMPLETED
   - pure `riskEngine.js` (no I/O in sizing, no LLM, no fabricated values)
   - VALID / WATCH / REJECTED states
   - position sizing: floor(account_equity * risk% / (|entry-stop| + slip + fees))
   - 25+ hard checks (daily/weekly loss, open positions, pending entries,
     sector/total exposure, trades/day, consecutive losses, spread, slippage,
     liquidity, ADV, RVOL, stale data, halted, HIGH dilution, penny-stock,
     duplicate position, min R:R, max position %, buying power, participation)
   - risk presets: 0.25% / 0.50% / 1.00%
   - persistent reproducible evaluations (migration 263)
   - proposal lifecycle gating: risk authoritative, stale recalc required
   - API: recalc / read / presets
   - UI: risk section with preset selector

4. Paper Broker / Execution Simulator ← COMPLETED
   - ExecutionAdapter pattern (PaperExecutionAdapter; SchwabExecutionAdapter future)
   - Migration 264: paper_positions + paper_orders (additive, non-destructive)
   - Idempotent entry submission via client_order_id (no duplicate entries)
   - Fill simulation: marketable/non-marketable limit, stop sell, partial fills,
     configurable slippage (deterministic — no random fills)
   - Order lifecycle: PENDING → SUBMITTED → PARTIALLY_FILLED → FILLED /
     CANCELLED / REJECTED / EXPIRED
   - Position lifecycle: OPEN → CLOSED with realized + unrealized P&L
   - Protective exits: T1/T2/stop split (1/3 each); hard invariant
     (active sell qty ≤ remaining position qty)
   - When stop triggers: cancel pending T1/T2, sell full remaining at stop
   - Cancel pending entry, update stop (no averaging down), manual close
   - Reconciliation from PostgreSQL (source of truth; Redis never authoritative)
   - Safety: PAPER mode only, short selling disabled, risk engine authoritative,
     no live broker calls, no position qty increase above approved risk size
   - APIs (auth-gated): paper-entry, paper-fills, paper-cancel-entry,
     paper-stop (PATCH), paper-manual-close, paper-reconcile, paper-position,
     paper-positions, paper-orders, paper-account
   - UI: PAPER-labeled execution UI (entry, cancel, check fills, stop update,
     manual close, order list, unrealized P&L)
   - Tests: 71 tests (fill simulation, idempotency, gating, protective exits,
     cancel, stop replacement, manual close, reconcile, no live broker calls)

5. Order / Position State Machine ← COMPLETED
   - Canonical state machine module (stateMachine.js): proposal lifecycle
     (DRAFT → READY_FOR_APPROVAL → APPROVED → ENTRY_SUBMITTED →
     ENTRY_PARTIALLY_FILLED → ENTRY_FILLED → POSITION_ACTIVE → T1_FILLED →
     T2_FILLED / STOP_FILLED → POSITION_CLOSED; plus REJECTED, WATCH, EXPIRED,
     ENTRY_CANCELLED, ERROR, MANUAL_INTERVENTION_REQUIRED), order status
     (SUBMITTED → PARTIALLY_FILLED → FILLED / CANCELLED), position status
     (OPEN → CLOSED). Idempotent same-state transitions. Runtime guards via
     assertTransition at each status-change site.
   - Migration 265: additive DRAFT/EXPIRED states added to trade_proposals CHECK.
   - Stop-first ordering: protective stop processed before targets when
     intrabar ordering is ambiguous (conservative worst-case for longs).
   - Automated PAPER reconciliation scheduler (paperReconciliationScheduler.js):
     worker-only, env-gated (ENABLE_PAPER_RECONCILIATION), 5s default interval,
     Redis distributed lock (120s TTL) prevents overlap across workers,
     IntervalScheduler running guard prevents same-process overlap.
     Status recorded via SchedulerStatusService (enabled, last run, success,
     failure, error, summary with processed counts).
   - Automated fill/exit processing: reconcileAll() processes all open PAPER
     positions with active sell orders — fetches trusted quote, applies
     deterministic fill rules, processes partial fills, updates positions,
     evaluates T1/T2/stop conditions, persists state transitions, audits all.
   - Restart recovery (runRestartRecovery): detects and repairs safe
     inconsistencies — FILLED entry with missing position, CLOSED position
     with active exits, remaining_qty inconsistent with fills, zero-remaining
     OPEN position, sell-invariant violations. Ambiguous state →
     MANUAL_INTERVENTION_REQUIRED. All repairs audit-logged.
   - Sell-quantity invariant: total active sell qty <= remaining_qty,
     verified after every reconciliation and restart recovery. Violation →
     MANUAL_INTERVENTION_REQUIRED.
   - APIs: GET /paper-reconciliation/status, POST /paper-reconciliation/run.
   - Frontend: bounded auto-polling (15s) for active PAPER proposals +
     visibility-aware pause/resume + manual "Reconcile PAPER" button.
   - Tests: 179 focused tests (state machine, reconciliation, races, partial
     fills, restart recovery, invariant, multi-fill cycle, no live broker).
   - fast-review: fixed critical stale-position bug in multi-fill cycles,
     increased Redis lock TTL, added cancelOrder state-machine assertion,
     removed redundant assertion.

6. Journal + reconciliation integration

7. Backtesting / empirical probabilities

8. Schwab live execution behind feature flag + explicit approval

9. Automated T1/T2/stop management

10. Live Trading Workstation integration

11. AI model bake-off and advisory layer

12. Optional individually-approved automation strategies
