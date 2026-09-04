# TeejarahTrading Product Requirements

## Product Scope

TeejarahTrading is a private, single-user trading journal and market-intelligence platform.

The system should help the user:
- ingest broker/account/trade data
- understand positions and performance
- monitor market context and catalysts
- identify deterministic trading setups
- calculate risk and position size
- produce advisory trade plans
- validate strategies through paper trading

Live order placement is part of the long-term product scope but must remain
disabled until explicitly implemented, validated through PAPER/BACKTEST modes,
and explicitly enabled by the user.

## Data Source Strategy

### Schwab
Primary source for:
- quotes
- candles
- streaming prices
- positions
- balances
- transactions
- orders

### SEC
Use official SEC data for:
- filings
- Company Facts/XBRL
- insider filings
- institutional filings
- dilution-related filings

### Nasdaq
Use permitted/official sources for:
- halts
- resumptions

### FINRA
Use permitted feeds for:
- short-volume
- threshold data where available

### FRED / BLS
Use for:
- macroeconomic context
- rates/inflation/labor inputs

### Finnhub Free
Use for:
- news
- earnings
- company profiles
- fallback/enrichment

Do not use production scraping of Yahoo Finance, Finviz, Seeking Alpha, or similar sites.

## Realtime News Pipeline

Build a multi-source normalized event pipeline.

Preferred official/regulatory sources:
- SEC
- company investor relations
- exchange notices
- FDA
- DOJ/FTC
- government releases

Secondary sources:
- Finnhub
- permitted RSS
- GDELT where appropriate

Each event should store:
- source
- source priority
- original URL
- symbol
- `published_at`
- `received_at`
- `processed_at`
- event type
- novelty score
- relevance score
- sentiment
- source hash
- raw payload
- normalized payload

AI summaries must never be represented as original news.

## Technical Indicator Engine

Calculate internally from trusted candle/quote data:

- EMA 9 / 20 / 50 / 200
- VWAP
- ATR
- RVOL
- gap percentage
- opening range
- high/low of day
- support/resistance
- volume profile where data permits
- trend regime
- volatility regime
- relative strength
- bid/ask spread
- liquidity quality

Each calculation must include:
- `data_as_of`
- `received_at`
- candle timeframe
- source
- stale-data flag

## Scanner Engine

Start with deterministic scanners:

- gap up/down
- relative volume
- momentum
- VWAP reclaim/loss
- opening-range breakout
- breakout/breakdown
- unusual volume
- relative strength
- news catalyst
- halt/resumption
- earnings proximity
- spread/liquidity filters

The deterministic scanner narrows the universe before AI is involved.
Do not send thousands of symbols to OpenRouter for brute-force scanning.

## Risk / Setup Scoring

Never represent AI confidence as a guaranteed probability.

Display separately:

### Setup score
Deterministic score from 0-100.

### Historical estimate
- empirical win rate for comparable setups
- sample size
- time period
- filter conditions

### Data confidence
Consider:
- quote age
- news age
- candle source
- depth availability
- spread
- stale-data state

If samples are insufficient, display:
`Insufficient comparable trades`

Never fabricate probability.

## Position Sizing

Core formula:

`risk_capital = account_equity * risk_percent`

`per_share_risk = abs(entry - stop) + slippage + fees`

`quantity = floor(risk_capital / per_share_risk)`

Then enforce:
- buying-power limit
- max position percentage
- max daily loss
- max symbol exposure
- maximum spread
- minimum liquidity
- max participation rate
- asset-class multiplier
- options multiplier
- futures contract multiplier

Reject plans with:
- missing stop
- invalid entry
- negative risk/reward
- stale data
- excessive spread
- insufficient liquidity
- exceeded daily loss
- exceeded buying power

## OpenRouter Advisory

AI is backend-only and advisory.

Requirements:
- never expose OpenRouter API key to frontend
- send minimum necessary data
- validate structured JSON schema
- include citations and source names
- include timestamps and data age
- record model and prompt version
- defend against prompt injection
- enforce token/cost limits
- support timeout/retry/fallback behavior
- persist analysis and its input snapshot
- support paper-trade validation
- never submit live orders

Structured trade plans should include:
- symbol
- direction
- setup
- entry zone
- stop
- target 1
- target 2
- risk/reward
- invalidation
- technical factors
- fundamental factors
- news factors
- market regime
- liquidity
- spread
- data confidence
- historical estimate
- setup score
- citations
- `generated_at`
- `data_as_of`

## Performance

Frontend:
- avoid unnecessary renders and network requests
- paginate/filter large datasets
- lazy-load where useful
- avoid heavy dependencies for simple UI needs

Backend:
- avoid N+1 queries
- avoid redundant provider calls
- batch where appropriate
- use indexes deliberately
- paginate large datasets
- keep hot request paths simple

## Security

Never:
- expose secrets
- expose broker credentials in browser JavaScript
- log tokens or sensitive secrets
- expose PostgreSQL/Redis publicly
- treat untrusted article text as instructions
- allow AI output to directly place orders

Preserve:
- secure cookies
- WebAuthn
- TOTP
- recovery codes
- rate limiting
- audit logging
- encrypted broker tokens
- backups
- least-privilege Git keys
- Cloudflare Tunnel
- container health checks
- provider timeout/retry/circuit breakers

## Compatibility

Preserve existing TradeTally iOS compatibility unless explicitly approved otherwise.

Do not change:
- iOS bundle identifiers
- APNs identifiers
- mobile API contracts
- historical migrations
- database identifiers

## Delivery Philosophy

Prefer incremental, testable features over large rewrites.

For each new feature:
1. define the data contract
2. use deterministic logic first
3. verify source quality
4. add persistence only when needed
5. add API/UI incrementally
6. add AI only after deterministic inputs are trustworthy
7. validate with paper-trade or historical data before relying on it

## Semi-Automated Trading System

Primary production workflow:

SCAN
→ ANALYZE
→ RISK CHECK
→ USER APPROVAL
→ EXECUTE
→ MANAGE
→ JOURNAL

Live trading must never be unrestricted by default.

Required feature flags:

- ENABLE_LIVE_TRADING=false
- ENABLE_AUTO_EXECUTION=false
- ENABLE_SMALL_CAP_MOMENTUM=false

These defaults must remain false unless explicitly changed by the user.

### Core invariants

- No live order may be submitted without explicit user approval in initial production mode.
- Short selling is disabled initially.
- Net sell quantity must never exceed the actual long position quantity unless short selling is explicitly enabled.
- Schwab is the source of truth for broker order/position reconciliation.
- Strategy logic cannot override hard risk-engine constraints.
- Historical probability must come from observed/backtested data only.
- AI confidence must remain separate from empirical setup probability.
- Approval must reference an immutable/versioned trade proposal.
- A materially stale proposal must be revalidated before execution.

### Execution modes

- BACKTEST
- PAPER
- LIVE

Default development/production-safe mode:

PAPER

### Initial strategy

Catalyst Momentum + VWAP Reclaim

Default universe:
- NYSE/NASDAQ common stocks
- generally price > $5
- average daily volume > 1M
- OTC excluded
- low-float/small-cap disabled by default
- penny stocks require an exceptional verified catalyst and must pass dilution/liquidity checks

Primary timeframe:
- 5-minute

Supporting:
- 1-minute optional
- 15-minute confirmation
- daily context

Entry modes:
1. Reclaim candle closes above VWAP, entry above reclaim candle high
2. VWAP reclaim followed by successful VWAP retest/hold

Minimum preferred R:R to T1:
2.0, configurable

### Trade proposal lifecycle

A trade proposal must preserve:
- strategy version
- signal snapshot
- market snapshot
- catalyst evidence
- technical evidence
- fundamental evidence
- entry zone/trigger
- stop/invalidation
- T1/T2/runner
- position size
- risk dollars
- R:R
- warnings
- historical statistics snapshot
- timestamps

Lifecycle:
SIGNAL_DETECTED
→ SIGNAL_VALIDATING
→ READY_FOR_APPROVAL
→ APPROVED / REJECTED / WATCH
→ execution lifecycle

Approval alone must not bypass final broker/risk revalidation.

### Order state machine

Support persisted states:
- SIGNAL_DETECTED
- SIGNAL_VALIDATING
- READY_FOR_APPROVAL
- APPROVED
- REJECTED
- ENTRY_SUBMITTED
- ENTRY_PARTIALLY_FILLED
- ENTRY_FILLED
- ENTRY_CANCELLED
- POSITION_ACTIVE
- T1_FILLED
- T2_FILLED
- STOP_FILLED
- POSITION_CLOSED
- ERROR
- MANUAL_INTERVENTION_REQUIRED

System must survive:
- restarts
- network failure
- stale broker sessions
- duplicate responses/callbacks
- partial fills
- delayed fills

### Risk controls

Hard configurable controls:
- max risk/trade
- max daily loss
- max weekly loss
- max open positions
- max pending entries
- max total exposure
- max sector exposure
- max loss streak
- max trades/day
- max spread
- max slippage
- minimum liquidity
- minimum ADV
- minimum RVOL
- no averaging down
- no martingale
- no doubling after losses

Global controls:
- STOP NEW TRADING
- CANCEL ALL PENDING ENTRY ORDERS

Neither action should automatically liquidate existing positions.

### Live workstation

A single-tab trading workstation must eventually provide:
- Market context
- Movers
- Scanner
- News/catalysts
- Halts/resumptions
- Selected-symbol charts
- Technical/fundamental context
- Trade proposal panel
- APPROVE / REJECT / WATCH / EDIT
- Position/order management after approval
