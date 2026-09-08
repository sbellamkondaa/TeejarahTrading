# Teejarah MCP / Schwab-MCP Gap Analysis & Attribution

## Purpose

Documents the relationship between the Teejarah MCP sandbox (introduced in the
Market Intelligence V2 milestone) and the MIT-licensed reference project
[jkoelker/schwab-mcp](https://github.com/jkoelker/schwab-mcp).

Teejarah did **not** vendor or merge schwab-mcp. Concepts and patterns were
reviewed for inspiration only; all Teejarah MCP code is original and reuses
Teejarah's own existing services rather than duplicating schwab-mcp logic.

## What Teejarah Already Implemented (before this milestone)

Teejarah already had a complete market-intelligence + trading-automation
stack independent of any MCP reference:

- Schwab market-data client (`backend/src/utils/schwabMarketData.js`): quotes,
  batch quotes, candles, price history, movers ($COMPX/$DJI/$SPX).
- Finnhub enrichment client (`backend/src/utils/finnhubClient.js`): news,
  earnings, profiles, peers, fallback quotes.
- SEC EDGAR ingestion: submissions, filings, Company Facts/XBRL, ticker→CIK map.
- Nasdaq halt feed: RSS parser + idempotent ingest + scheduler.
- Deterministic scanner + technical indicator engine.
- Catalyst engine, dilution-risk engine, fundamental engine.
- Trading automation: versioned strategies, signals, proposals, approvals,
  immutable audit, execution-mode abstraction (BACKTEST/PAPER/LIVE).
- Deterministic risk engine (25+ hard checks, VALID/WATCH/REJECTED).
- Paper broker / execution simulator with protective exits + reconciliation.
- Backtest engine + calibration engine (empirical stats).
- PAPER trading workstation UI with chart, risk, empirical evidence.

## Concepts Referenced from schwab-mcp

The following high-level concepts from schwab-mcp informed Teejarah's MCP
tool design (concepts only — no code copied):

- **Tool-registry pattern**: declarative tool registration with name,
  description, JSON-schema input, and a handler that delegates to existing
  services. Teejarah's `teejarahMcpServer.js` uses the same shape but
  delegates to Teejarah services, not schwab-mcp handlers.
- **Token-efficient JSON output**: schwab-mcp's practice of returning compact
  structured JSON from market-data tools. Teejarah's MCP handlers return
  compact JSON reusing existing controller payloads.
- **Exact preview pattern**: schwab-mcp separates read-only market/account
  tools from write tools and gates write tools behind explicit approval.
  Teejarah adopted the same separation: read tools are open; PAPER write
  tools (`request_paper_trade`, `approve_paper_trade`) reuse the existing
  proposal + risk-engine approval gate.
- **MCP tool schemas**: schwab-mcp's use of JSON-schema for tool input
  validation. Teejarah's tools declare `inputSchema` on each tool.

No source code from schwab-mcp was copied into Teejarah. The schwab-mcp
project is MIT-licensed; this document serves as attribution for the
concepts referenced during design review.

## What Was NOT Integrated

The following schwab-mcp capabilities were intentionally NOT integrated:

- **Discord live approval flow** — Teejarah uses its own web UI + proposal
  lifecycle for approvals; no Discord integration.
- **Trading bypass flags** — schwab-mcp exposes flags to enable unrestricted
  trading. Teejarah explicitly does NOT register any live-order tool and has
  no bypass flag.
- **Unrestricted Schwab write capability** — no schwab-mcp order-placement
  code is present. Teejarah's MCP `approve_paper_trade` reuses the existing
  `proposalService.recordApproval` which enforces risk + freshness.
- **LIVE execution** — intentionally disabled. No live-order tool is
  registered in `teejarahMcpServer.js`. `invokeTool` and the MCP controller
  hard-deny `place_live_order`, `cancel_live_order`, `approve_live_order`
  regardless of future registration attempts.
- **Option-chain tool** — not yet exposed in Teejarah MCP. Schwab option-chain
  support exists in the codebase but was not surfaced as an MCP tool in this
  milestone; future work may add `get_option_chain` when safe.

## Teejarah MCP PAPER Sandbox Tools

Registered (all auth-gated, internal-bind, PAPER/sandbox only):

Read-only: `get_market_overview`, `get_movers`, `search_market_events`,
`get_symbol_events`, `get_quotes`, `get_price_history`,
`get_scanner_results`, `analyze_symbol`, `get_sources`, `get_trade_proposal`,
`get_risk_evaluation`, `get_empirical_stats`, `get_journal`,
`get_paper_account`, `get_paper_positions`, `get_paper_orders`, `run_backtest`.

PAPER write (reuse existing approval + risk gate): `request_paper_trade`,
`approve_paper_trade`.

NOT registered (safety): `place_live_order`, `cancel_live_order`,
`approve_live_order`.

## Future Schwab Read/Account/Preview/Live Work

Teejarah milestone #8 (Schwab live execution behind feature flag + explicit
approval) remains the next planned step. That milestone, when started, will:

- Add a `SchwabExecutionAdapter` implementing the same `ExecutionAdapter`
  interface as `PaperExecutionAdapter`, gated behind `ENABLE_LIVE_TRADING`
  (default false; requires explicit user approval).
- Never bypass the deterministic risk engine.
- Reuse the existing proposal → approval → risk → execution flow.
- Register LIVE order tools in MCP only when `ENABLE_LIVE_TRADING=true` AND
  after an explicit, persisted user approval per order.

Until milestone #8 is explicitly approved and implemented, LIVE MCP order
tools remain unregistered and hard-denied.

## License / Attribution

- [jkoelker/schwab-mcp](https://github.com/jkoelker/schwab-mcp) — MIT License.
  Reviewed for design concepts; no source code copied.
- Teejarah MCP implementation (`backend/src/services/mcp/teejarahMcpServer.js`
  and related controllers/routes) is original work, (c) Teejarah, and reuses
  Teejarah's own existing services under Teejarah's existing license.

## LIVE Features Intentionally Disabled

- `ENABLE_LIVE_TRADING=false`
- `ENABLE_AUTO_EXECUTION=false`
- `ENABLE_SMALL_CAP_MOMENTUM=false`
- No live-order MCP tool registered.
- Short selling disabled.
- Risk engine authoritative; cannot be bypassed by AI, MCP, or strategy code.
