const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const strategyService = require('../services/trading/strategyService');
const signalService = require('../services/trading/signalService');
const proposalService = require('../services/trading/proposalService');
const auditService = require('../services/trading/auditService');
const executionMode = require('../services/trading/executionMode');
const { runScan: runCatalystMomentumScan, STRATEGY_NAME: CATALYST_STRATEGY_NAME } = require('../services/trading/catalystMomentumStrategy');
const { evaluateRisk, getAccountContext, getPortfolioRiskContext, persistEvaluation, getLatestEvaluation, isEvaluationStale, DEFAULT_RISK_CONFIG, RISK_PRESETS } = require('../services/trading/riskEngine');
const paperBroker = require('../services/trading/paperBroker');

// --- Execution mode ---

async function getExecutionStatus(req, res) {
  return res.json(executionMode.getStatus());
}

// --- Strategies ---

async function listStrategies(req, res) {
  const status = req.query.status || null;
  const strategies = await strategyService.listStrategies({ status });
  return res.json({ strategies, count: strategies.length });
}

async function getStrategy(req, res) {
  const strategy = await strategyService.getById(req.params.id);
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
  return res.json(strategy);
}

async function createStrategy(req, res) {
  const { name, description, config } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Strategy name is required' });
  }
  try {
    const strategy = await strategyService.createStrategy({ name, description, config });
    return res.status(201).json(strategy);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
}

async function createStrategyVersion(req, res) {
  const { name } = req.params;
  const { description, config } = req.body || {};
  try {
    const strategy = await strategyService.createNewVersion(name, { description, config });
    return res.status(201).json(strategy);
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
}

async function updateStrategyStatus(req, res) {
  const { status } = req.body || {};
  const valid = ['draft', 'active', 'paused', 'archived'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const strategy = await strategyService.updateStatus(req.params.id, status);
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
  return res.json(strategy);
}

// --- Signals ---

async function listSignals(req, res) {
  const { strategyId, symbol, status } = req.query;
  const signals = await signalService.listSignals({ strategyId, symbol, status });
  return res.json({ signals, count: signals.length });
}

async function getSignal(req, res) {
  const signal = await signalService.getById(req.params.id);
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  return res.json(signal);
}

// --- Proposals ---

async function listProposals(req, res) {
  const { status, symbol, strategyId } = req.query;
  const proposals = await proposalService.listProposals({ status, symbol, strategyId });
  return res.json({ proposals, count: proposals.length });
}

async function getProposal(req, res) {
  const proposal = await proposalService.getById(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const [approvals, auditEvents] = await Promise.all([
    proposalService.getApprovals(proposal.id),
    auditService.getEventsForEntity('trade_proposal', proposal.id)
  ]);

  return res.json({ ...proposal, approvals, audit_events: auditEvents });
}

async function createProposal(req, res) {
  const body = req.body || {};
  if (!body.signalId || !body.strategyId || !body.symbol || !body.direction) {
    return res.status(400).json({ error: 'signalId, strategyId, symbol, and direction are required' });
  }
  if (!['long', 'short'].includes(body.direction)) {
    return res.status(400).json({ error: 'direction must be long or short' });
  }
  if (body.entryZone == null || typeof body.entryZone !== 'object') {
    return res.status(400).json({ error: 'entryZone is required' });
  }
  try {
    const proposal = await proposalService.createProposal(body);
    return res.status(201).json(proposal);
  } catch (err) {
    if (err.message.includes('Invalid execution mode') || err.message.includes('ENABLE_LIVE_TRADING')) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('[TRADING] createProposal error: ' + err.message);
    return res.status(500).json({ error: 'Failed to create proposal' });
  }
}

async function editProposal(req, res) {
  const proposal = await proposalService.getById(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  // Only proposals in READY_FOR_APPROVAL or WATCH can be edited.
  if (!['READY_FOR_APPROVAL', 'WATCH'].includes(proposal.lifecycle_state)) {
    return res.status(409).json({ error: 'Proposal can only be edited in READY_FOR_APPROVAL or WATCH state' });
  }

  const body = req.body || {};
  const updated = await proposalService.editProposal(req.params.id, body, req.user.id);
  return res.json(updated);
}

async function approveProposal(req, res) {
  const { decision } = req.body || {};
  if (!['approved', 'rejected', 'watch'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved, rejected, or watch' });
  }
  const { note } = req.body || {};
  try {
    const approval = await proposalService.recordApproval(
      req.params.id,
      req.user.id,
      decision,
      note || null
    );
    return res.json(approval);
  } catch (err) {
    if (err.message.includes('Invalid transition')) {
      return res.status(409).json({ error: err.message });
    }
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    logger.error('[TRADING] approveProposal error: ' + err.message);
    return res.status(500).json({ error: 'Failed to record approval' });
  }
}

async function transitionProposal(req, res) {
  const { newState } = req.body || {};
  if (!newState) {
    return res.status(400).json({ error: 'newState is required' });
  }
  try {
    const proposal = await proposalService.transitionState(
      req.params.id,
      newState,
      req.user.id
    );
    return res.json(proposal);
  } catch (err) {
    if (err.message.includes('Invalid transition')) {
      return res.status(409).json({ error: err.message });
    }
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    logger.error('[TRADING] transitionProposal error: ' + err.message);
    return res.status(500).json({ error: 'Failed to transition proposal' });
  }
}

// --- Strategy scan ---

async function runStrategyScan(req, res) {
  const strategy = await strategyService.getById(req.params.id);
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
  if (strategy.status !== 'active') {
    return res.status(409).json({ error: 'Strategy must be active to scan' });
  }

  try {
    let result;
    if (strategy.name === CATALYST_STRATEGY_NAME) {
      result = await runCatalystMomentumScan(strategy.id, strategy.config, req.user.id);
    } else {
      return res.status(400).json({ error: `Strategy "${strategy.name}" has no scan engine` });
    }

    return res.json({
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      strategy_version: strategy.version,
      signals_created: result.signals.length,
      proposals_created: result.proposals.length,
      proposals: result.proposals,
      error: result.error || null
    });
  } catch (err) {
    logger.error('[TRADING] scan error: ' + err.message);
    return res.status(500).json({ error: 'Strategy scan failed' });
  }
}

// --- Risk assessment ---

// Advisory-only deterministic position sizing + risk evaluation for a
// proposal. Recalculates from current proposal inputs + account context,
// persists the result, and returns it. Never places broker orders.
async function assessProposalRisk(req, res) {
  const proposal = await proposalService.getById(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const strategy = await strategyService.getById(proposal.strategy_id);
  const strategyRiskCfg = (strategy && strategy.config && strategy.config.risk) || {};

  // Risk preset selection (allowed presets only; cannot bypass hard limits).
  // Only riskPercent and entryPrice are accepted from the client — all
  // market-quality inputs (spread, liquidity, halted, dilution, etc.) are
  // sourced server-side to prevent fabrication of risk inputs.
  const bodyRisk = (req.body && req.body.risk) || {};
  let riskPercent = bodyRisk.riskPercent != null ? Number(bodyRisk.riskPercent) : (strategyRiskCfg.riskPercent || DEFAULT_RISK_CONFIG.riskPercent);
  if (!Number.isFinite(riskPercent) || riskPercent <= 0) {
    return res.status(400).json({ error: 'riskPercent must be a positive number' });
  }
  if (riskPercent > DEFAULT_RISK_CONFIG.maxRiskPerTradePct) {
    return res.status(400).json({ error: `riskPercent ${riskPercent} exceeds max ${DEFAULT_RISK_CONFIG.maxRiskPerTradePct}%` });
  }

  const overrides = { ...DEFAULT_RISK_CONFIG, ...strategyRiskCfg, riskPercent };

  const accountContext = await getAccountContext(req.user.id);
  const portfolioCtx = await getPortfolioRiskContext(req.user.id, proposal.symbol);

  const entryPrice = bodyRisk.entryPrice != null
    ? bodyRisk.entryPrice
    : (proposal.entry_zone && (proposal.entry_zone.high || proposal.entry_zone.low)) || null;

  const evalInput = {
    entryPrice,
    stopPrice: proposal.stop_price,
    t1Price: proposal.t1_price,
    t2Price: proposal.t2_price,
    direction: proposal.direction,
    accountEquity: accountContext.account_equity,
    strategyVersion: strategy ? `${strategy.name}@v${strategy.version}` : null,
    dataAsOf: Date.now(),
    ...portfolioCtx
    // Market-quality inputs (spread, liquidity, halted, dilution, etc.) are
    // intentionally NOT accepted from the client to prevent fabrication.
    // They are populated server-side by the strategy scan path.
  };

  const evaluation = evaluateRisk(evalInput, overrides);

  // Persist the reproducible evaluation.
  let persisted = null;
  try {
    persisted = await persistEvaluation(proposal.id, evaluation);
  } catch (err) {
    logger.error('[TRADING] risk eval persist error: ' + err.message);
  }

  return res.json({
    proposal_id: proposal.id,
    symbol: proposal.symbol,
    direction: proposal.direction,
    account_equity: accountContext.account_equity,
    evaluation,
    persisted_id: persisted ? persisted.id : null
  });
}

// Read the latest persisted risk evaluation for a proposal.
async function getProposalRisk(req, res) {
  const proposal = await proposalService.getById(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const evaluation = await getLatestEvaluation(proposal.id);
  if (!evaluation) return res.status(404).json({ error: 'No risk evaluation found' });

  return res.json({
    proposal_id: proposal.id,
    symbol: proposal.symbol,
    is_stale: isEvaluationStale(evaluation, proposal),
    evaluation
  });
}

// Return the allowed risk presets and current default.
async function getRiskPresets(req, res) {
  return res.json({
    presets: RISK_PRESETS,
    default: DEFAULT_RISK_CONFIG.riskPercent,
    max_risk_per_trade_pct: DEFAULT_RISK_CONFIG.maxRiskPerTradePct
  });
}

// --- Paper trading ---

async function paperEntry(req, res) {
  try {
    const result = await paperBroker.submitEntry(req.params.id, req.user.id, req.body?.options || {});
    return res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('must be') || err.message.includes('requires') || err.message.includes('disabled') || err.message.includes('missing') || err.message.includes('stale') || err.message.includes('REJECTED') || err.message.includes('No quote') || err.message.includes('Cannot determine')) {
      return res.status(409).json({ error: err.message });
    }
    logger.error('[TRADING] paperEntry error: ' + err.message);
    return res.status(500).json({ error: 'Paper entry failed' });
  }
}

async function paperProcessFills(req, res) {
  try {
    const result = await paperBroker.processFills(req.params.id, req.user.id, req.body?.options || {});
    return res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('Cannot') || err.message.includes('No ')) {
      return res.status(409).json({ error: err.message });
    }
    logger.error('[TRADING] paperProcessFills error: ' + err.message);
    return res.status(500).json({ error: 'Process fills failed' });
  }
}

async function paperCancelEntry(req, res) {
  try {
    const result = await paperBroker.cancelEntry(req.params.id, req.user.id);
    return res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('already filled') || err.message.includes('No entry')) {
      return res.status(409).json({ error: err.message });
    }
    logger.error('[TRADING] paperCancelEntry error: ' + err.message);
    return res.status(500).json({ error: 'Cancel entry failed' });
  }
}

async function paperUpdateStop(req, res) {
  const { stopPrice } = req.body || {};
  if (stopPrice == null || !Number.isFinite(Number(stopPrice)) || Number(stopPrice) <= 0) {
    return res.status(400).json({ error: 'stopPrice must be a positive number' });
  }
  try {
    const result = await paperBroker.updateStop(req.params.id, Number(stopPrice), req.user.id);
    return res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('No open') || err.message.includes('Invalid') || err.message.includes('must be') || err.message.includes('No remaining')) {
      return res.status(409).json({ error: err.message });
    }
    logger.error('[TRADING] paperUpdateStop error: ' + err.message);
    return res.status(500).json({ error: 'Update stop failed' });
  }
}

async function paperManualClose(req, res) {
  try {
    const result = await paperBroker.manualClose(req.params.id, req.user.id);
    return res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('No open') || err.message.includes('No valid') || err.message.includes('No remaining') || err.message.includes('Cannot')) {
      return res.status(409).json({ error: err.message });
    }
    logger.error('[TRADING] paperManualClose error: ' + err.message);
    return res.status(500).json({ error: 'Manual close failed' });
  }
}

async function paperReconcile(req, res) {
  const result = await paperBroker.reconcile(req.params.id);
  return res.json(result);
}

async function getPaperPosition(req, res) {
  const position = await paperBroker.getPosition(req.params.id);
  if (!position) return res.status(404).json({ error: 'No paper position for this proposal' });
  const orders = await paperBroker.getOrders(req.params.id);
  let unrealizedPnl = null;
  try {
    const proposal = await proposalService.getById(req.params.id);
    if (proposal) {
      const quote = await require('../../utils/finnhub').getQuote(proposal.symbol);
      unrealizedPnl = await paperBroker.getUnrealizedPnl(position, quote);
    }
  } catch { /* ignore */ }
  return res.json({ position, orders, unrealized_pnl: unrealizedPnl });
}

async function listPaperPositions(req, res) {
  const { status } = req.query;
  const positions = await paperBroker.listPositions({ status });
  return res.json({ positions, count: positions.length });
}

async function listPaperOrders(req, res) {
  const { status, proposalId } = req.query;
  const orders = await paperBroker.listOrders({ status, proposalId });
  return res.json({ orders, count: orders.length });
}

async function getPaperAccount(req, res) {
  const summary = await paperBroker.getAccountSummary();
  return res.json(summary);
}

module.exports = {
  listStrategies: asyncHandler(listStrategies),
  getStrategy: asyncHandler(getStrategy),
  createStrategy: asyncHandler(createStrategy),
  createStrategyVersion: asyncHandler(createStrategyVersion),
  updateStrategyStatus: asyncHandler(updateStrategyStatus),
  listSignals: asyncHandler(listSignals),
  getSignal: asyncHandler(getSignal),
  listProposals: asyncHandler(listProposals),
  getProposal: asyncHandler(getProposal),
  createProposal: asyncHandler(createProposal),
  editProposal: asyncHandler(editProposal),
  approveProposal: asyncHandler(approveProposal),
  transitionProposal: asyncHandler(transitionProposal),
  getExecutionStatus: asyncHandler(getExecutionStatus),
  runStrategyScan: asyncHandler(runStrategyScan),
  assessProposalRisk: asyncHandler(assessProposalRisk),
  getProposalRisk: asyncHandler(getProposalRisk),
  getRiskPresets: asyncHandler(getRiskPresets),
  paperEntry: asyncHandler(paperEntry),
  paperProcessFills: asyncHandler(paperProcessFills),
  paperCancelEntry: asyncHandler(paperCancelEntry),
  paperUpdateStop: asyncHandler(paperUpdateStop),
  paperManualClose: asyncHandler(paperManualClose),
  paperReconcile: asyncHandler(paperReconcile),
  getPaperPosition: asyncHandler(getPaperPosition),
  listPaperPositions: asyncHandler(listPaperPositions),
  listPaperOrders: asyncHandler(listPaperOrders),
  getPaperAccount: asyncHandler(getPaperAccount)
};
