const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const strategyService = require('../services/trading/strategyService');
const signalService = require('../services/trading/signalService');
const proposalService = require('../services/trading/proposalService');
const auditService = require('../services/trading/auditService');
const executionMode = require('../services/trading/executionMode');
const { runScan: runCatalystMomentumScan, STRATEGY_NAME: CATALYST_STRATEGY_NAME } = require('../services/trading/catalystMomentumStrategy');

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
      result = await runCatalystMomentumScan(strategy.id, strategy.config);
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
  runStrategyScan: asyncHandler(runStrategyScan)
};
