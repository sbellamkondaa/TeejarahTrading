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

Live order placement is out of scope until explicitly approved and separately implemented.

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
