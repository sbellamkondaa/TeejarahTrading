/**
 * Teejarah MCP Server — sandbox / PAPER only.
 *
 * A lightweight Model Context Protocol-style tool registry exposing
 * Teejarah's existing read + PAPER-only services to an MCP client. Reuses
 * existing services rather than duplicating calculation logic.
 *
 * SAFETY INVARIANTS:
 *  - NO live order tool is registered (place_live_order, cancel_live_order,
 *    approve_live_order are explicitly NOT present).
 *  - request_paper_trade / approve_paper_trade only operate through the
 *    existing PAPER approval + risk-engine rules; they cannot bypass risk.
 *  - All tools are read-only except the PAPER request/approve tools, which
 *    reuse the existing proposalService + riskEngine gating.
 *  - Bound to internal HTTP only; auth-gated; rate-limited via the existing
 *    middleware where applicable.
 *
 * Tools are registered declaratively; each tool has a name, schema, and a
 * handler that delegates to an existing Teejarah service/controller function.
 */

const db = require('../../config/database');
const finnhub = require('../../utils/finnhub');
const schwabMarketData = require('../../utils/schwabMarketData');
const { queryEvents, getEventsForSymbol } = require('../marketIntelligence/eventQueryService');
const { listSources } = require('../marketIntelligence/sourceRegistry');
const { scoreEvent, categorize } = require('../marketIntelligence/eventRanker');
const { PRICE_PRESETS, applyDiscoveryFilters, scoreOpportunity } = require('../marketIntelligence/opportunityScore');

// Reuse existing trading services for PAPER-only tools.
const proposalService = require('../trading/proposalService');
const riskEngine = require('../trading/riskEngine');
const paperBroker = require('../trading/paperBroker');
const paperAccountService = require('../trading/paperAccountService');

const { getMarketSession } = require('../../utils/marketSession');

const { SOURCE_TIERS } = require('../marketIntelligence/eventTypes');
const { CATALYST_EVENT_TYPES } = require('../marketIntelligence/eventQueryService');

// Tool registry. Each tool: { name, description, inputSchema, handler }
const TOOLS = [];

function register(tool) {
  if (TOOLS.find((t) => t.name === tool.name)) {
    throw new Error('Duplicate MCP tool: ' + tool.name);
  }
  TOOLS.push(tool);
}

// ---------- Read-only market tools ----------

register({
  name: 'get_market_overview',
  description: 'Return top-of-book index quotes (SPY/QQQ/IWM/DIA/VIX) and market session status.',
  inputSchema: { type: 'object', properties: { extended: { type: 'boolean' } } },
  handler: async (args) => {
    const symbols = args.extended ? ['SPY', 'QQQ', 'IWM', 'DIA', '$VIX', '$COMPX'] : ['SPY', 'QQQ', 'IWM', 'DIA'];
    const quotes = await finnhub.getQuotes(symbols).catch(() => ({}));
    const indices = symbols.map((s) => {
      const q = quotes[s] || {};
      return {
        symbol: s,
        price: q.c ?? null,
        change: q.d ?? null,
        change_percent: q.dp ?? null,
        previous_close: q.pc ?? null,
        available: q.c != null
      };
    });
    const session = getMarketSession();
    return { indices, session: session.session, session_label: session.label };
  }
});

register({
  name: 'get_movers',
  description: 'Return Schwab movers for $COMPX/$DJI/$SPX with optional price-range filter.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['gainers', 'losers', 'active'] },
      min_price: { type: 'number' },
      max_price: { type: 'number' },
      limit: { type: 'integer' }
    }
  },
  handler: async (args) => {
    const schwabMarketDataMod = require('../../utils/schwabMarketData');
    const all = [];
    for (const idx of ['$COMPX', '$DJI', '$SPX']) {
      const r = await schwabMarketDataMod.getMovers(idx).catch(() => null);
      if (r && r.items) all.push(...r.items);
    }
    const seen = new Set();
    let movers = [];
    for (const it of all) {
      const s = (it.symbol || '').toUpperCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      movers.push({
        symbol: s,
        last_price: it.last_price,
        change: it.net_change,
        change_percent: it.net_percent_change,
        volume: it.volume
      });
    }
    movers = applyDiscoveryFilters(movers, {
      min_price: args.min_price,
      max_price: args.max_price
    });
    const limit = Math.min(parseInt(args.limit, 10) || 25, 100);
    return { movers: movers.slice(0, limit), count: Math.min(movers.length, limit) };
  }
});

register({
  name: 'search_market_events',
  description: 'Search the persistent market_events store with filters and cursor pagination.',
  inputSchema: {
    type: 'object',
    properties: {
      preset: { type: 'string' },
      symbol: { type: 'string' },
      q: { type: 'string' },
      source: { type: 'string' },
      event_type: { type: 'string' },
      source_tier: { type: 'string' },
      min_materiality: { type: 'integer' },
      catalyst_only: { type: 'boolean' },
      page_size: { type: 'integer' },
      cursor: { type: 'string' }
    }
  },
  handler: async (args) => {
    const result = await queryEvents(args);
    result.events = result.events.map((e) => ({ ...e, score: scoreEvent(e), category: categorize(e) }));
    return result;
  }
});

register({
  name: 'get_symbol_events',
  description: 'Return recent market events for a single symbol.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, limit: { type: 'integer' } }, required: ['symbol'] },
  handler: async (args) => {
    const events = await getEventsForSymbol(args.symbol, args.limit || 20);
    return { symbol: args.symbol, events: events.map((e) => ({ ...e, score: scoreEvent(e), category: categorize(e) })) };
  }
});

register({
  name: 'get_quotes',
  description: 'Batch quote for a list of symbols.',
  inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
  handler: async (args) => {
    const symbols = (args.symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean);
    if (!symbols.length) return { quotes: {} };
    const quotes = await finnhub.getQuotes(symbols).catch(() => ({}));
    return { quotes };
  }
});

register({
  name: 'get_price_history',
  description: 'Return daily price history for a symbol (Schwab first, Finnhub fallback).',
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string' }, period: { type: 'string', enum: ['1d', '1w', '1m', '3m'] } },
    required: ['symbol']
  },
  handler: async (args) => {
    const now = Math.floor(Date.now() / 1000);
    const periodSec = { '1d': 86400, '1w': 604800, '1m': 2592000, '3m': 7776000 }[args.period] || 2592000;
    const candles = await schwabMarketData.getCandles(args.symbol, '1', now - periodSec, now).catch(() => null);
    return { symbol: args.symbol, candles: candles || [] };
  }
});

register({
  name: 'get_scanner_results',
  description: 'Return deterministic scanner results with opportunity scores (read-only).',
  inputSchema: {
    type: 'object',
    properties: {
      min_price: { type: 'number' }, max_price: { type: 'number' },
      min_gap: { type: 'number' }, min_rvol: { type: 'number' },
      min_volume: { type: 'number' }, market_cap: { type: 'string' },
      limit: { type: 'integer' }
    }
  },
  handler: async (args) => {
    // Reuse the market controller's scanner by calling the same pipeline.
    const marketController = require('../../controllers/market.controller');
    const fakeRes = buildFakeRes();
    await marketController.getScanner({
      query: { ...args, limit: args.limit || 25, exclude_penny: true }
    }, fakeRes);
    return fakeRes.body;
  }
});

register({
  name: 'analyze_symbol',
  description: 'Advisory analysis of a single symbol using the PAPER-only AI advisory service.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  handler: async (args) => {
    const advisoryService = require('../ai/advisoryService');
    const result = await advisoryService.analyze(
      [{ symbol: args.symbol }],
      { mode: 'summary' }
    );
    return result;
  }
});

register({
  name: 'get_sources',
  description: 'List market event source adapters and their health/enablement state.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ sources: listSources() })
});

// ---------- Trading (PAPER-only) tools — reuse existing services ----------

register({
  name: 'get_paper_account',
  description: 'Return the PAPER trading account summary (cash, equity, buying power).',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    return await paperAccountService.getAccountSummary();
  }
});

register({
  name: 'get_paper_positions',
  description: 'List all PAPER positions.',
  inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed'] } } },
  handler: async (args) => {
    return await paperBroker.listPositions({ status: args.status });
  }
});

register({
  name: 'get_paper_orders',
  description: 'List all PAPER orders.',
  inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
  handler: async (args) => {
    return await paperBroker.listOrders({ status: args.status });
  }
});

register({
  name: 'get_trade_proposal',
  description: 'Return a single trade proposal by id (read-only).',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async (args) => {
    return await proposalService.getById(args.id);
  }
});

register({
  name: 'get_risk_evaluation',
  description: 'Return the latest persisted risk evaluation for a proposal (read-only).',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async (args) => {
    return await riskEngine.getLatestEvaluation(args.id);
  }
});

register({
  name: 'get_empirical_stats',
  description: 'Return empirical calibration stats for a strategy/setup (advisory only).',
  inputSchema: {
    type: 'object',
    properties: { strategyId: { type: 'string' }, strategyVersion: { type: 'string' }, setupType: { type: 'string' }
    }
  },
  handler: async (args) => {
    const calibrationService = require('../trading/calibrationService');
    return await calibrationService.getCalibration(args);
  }
});

register({
  name: 'get_journal',
  description: 'Return the journal trade linked to a paper position (read-only).',
  inputSchema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
  handler: async (args) => {
    const journalSyncService = require('../trading/journalSyncService');
    return await journalSyncService.getJournalTradeByProposal(args.proposalId);
  }
});

register({
  name: 'request_paper_trade',
  description: 'Create a PAPER trade proposal (advisory). Subject to the full risk engine + approval gate.',
  inputSchema: {
    type: 'object',
    properties: {
      strategyId: { type: 'string' }, symbol: { type: 'string' },
      entryPrice: { type: 'number' }, stopPrice: { type: 'number' },
      target1: { type: 'number' }, target2: { type: 'number' },
      riskPercent: { type: 'number' }
    },
    required: ['strategyId', 'symbol', 'entryPrice', 'stopPrice']
  },
  handler: async (args) => {
    // Reuses proposalService which enforces risk + lifecycle gating. Creates a
    // PAPER-mode proposal in SIGNAL_DETECTED (risk must be evaluated/approved
    // separately through the existing flow before any entry is submitted).
    return await proposalService.createProposal({
      strategyId: args.strategyId,
      symbol: args.symbol,
      direction: args.direction || 'long',
      executionMode: 'PAPER',
      entryZone: { price: args.entryPrice },
      stopPrice: args.stopPrice,
      t1Price: args.target1,
      t2Price: args.target2,
      riskPercent: args.riskPercent
    });
  }
});

register({
  name: 'approve_paper_trade',
  description: 'Approve a PAPER trade proposal. Reuses the existing approval rules; cannot bypass risk rejection.',
  inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, decision: { type: 'string' }, userId: { type: 'string' } }, required: ['proposalId', 'decision'] },
  handler: async (args) => {
    // Reuses proposalService.recordApproval which rejects when risk is REJECTED/stale.
    // userId is required by the service; MCP callers must supply it (auth-gated).
    const userId = args.userId || process.env.MCP_SYSTEM_USER_ID || null;
    if (!userId) {
      const err = new Error('approve_paper_trade requires a userId (set MCP_SYSTEM_USER_ID or pass userId)');
      err.code = 'USER_ID_REQUIRED';
      throw err;
    }
    return await proposalService.recordApproval(args.proposalId, userId, args.decision);
  }
});

register({
  name: 'run_backtest',
  description: 'Run a deterministic backtest for a strategy (BACKTEST mode only; no PAPER/LIVE orders).',
  inputSchema: {
    type: 'object',
    properties: { strategyId: { type: 'string' }, symbol: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' } },
    required: ['strategyId', 'symbol']
  },
  handler: async (args) => {
    // Reuses backtestService.createRun which fetches candles + persists the run.
    const backtestService = require('../trading/backtestService');
    return await backtestService.createRun(args);
  }
});

// ---------- Explicitly NOT registered (safety) ----------
// place_live_order, cancel_live_order, approve_live_order — NEVER registered.

function buildFakeRes() {
  const fakeRes = { statusCode: 200, body: null };
  fakeRes.status = (code) => { fakeRes.statusCode = code; return fakeRes; };
  fakeRes.json = (body) => { fakeRes.body = body; return fakeRes; };
  return fakeRes;
}

/**
 * List all registered tools (with schemas) for an MCP client.
 */
function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

/**
 * Invoke a tool by name. Throws for unknown tools or unregistered live tools.
 */
async function invokeTool(name, args = {}) {
  // Hard guard: any tool matching the live-order denylist must never run, even
  // before the unknown-tool lookup, so a future accidental registration or a
  // client request can never reach a live-order handler.
  if (/^(place_live_order|cancel_live_order|approve_live_order)$/i.test(name)) {
    const err = new Error('Live order tools are disabled in Teejarah MCP');
    err.code = 'LIVE_TOOL_DISABLED';
    throw err;
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const err = new Error('Unknown MCP tool: ' + name);
    err.code = 'UNKNOWN_TOOL';
    throw err;
  }
  return await tool.handler(args);
}

function isLiveOrderToolRegistered() {
  return TOOLS.some((t) => /^(place_live_order|cancel_live_order|approve_live_order)$/i.test(t.name));
}

module.exports = { listTools, invokeTool, isLiveOrderToolRegistered, TOOLS };
