/**
 * Proposal Service
 *
 * Trade proposal lifecycle management. Proposals are immutable once created —
 * lifecycle transitions create audit events, not updates to the proposal
 * payload. The lifecycle_state column tracks the current state.
 *
 * Execution is NOT implemented here. Live trading remains disabled behind
 * feature flags (ENABLE_LIVE_TRADING=false, ENABLE_AUTO_EXECUTION=false).
 */

const db = require('../../config/database');
const audit = require('./auditService');
const { resolveMode } = require('./executionMode');

// Valid lifecycle transitions per the state machine in PRODUCT_REQUIREMENTS.md
const TRANSITIONS = {
  SIGNAL_DETECTED: ['SIGNAL_VALIDATING'],
  SIGNAL_VALIDATING: ['READY_FOR_APPROVAL', 'REJECTED'],
  READY_FOR_APPROVAL: ['APPROVED', 'REJECTED', 'WATCH'],
  APPROVED: ['ENTRY_SUBMITTED', 'REJECTED'],
  REJECTED: [],
  WATCH: ['READY_FOR_APPROVAL', 'REJECTED'],
  ENTRY_SUBMITTED: ['ENTRY_PARTIALLY_FILLED', 'ENTRY_FILLED', 'ENTRY_CANCELLED', 'ERROR'],
  ENTRY_PARTIALLY_FILLED: ['ENTRY_FILLED', 'ENTRY_CANCELLED', 'ERROR'],
  ENTRY_FILLED: ['POSITION_ACTIVE', 'ERROR'],
  ENTRY_CANCELLED: [],
  POSITION_ACTIVE: ['T1_FILLED', 'STOP_FILLED', 'ERROR', 'MANUAL_INTERVENTION_REQUIRED'],
  T1_FILLED: ['T2_FILLED', 'STOP_FILLED', 'POSITION_CLOSED'],
  T2_FILLED: ['STOP_FILLED', 'POSITION_CLOSED'],
  STOP_FILLED: ['POSITION_CLOSED'],
  POSITION_CLOSED: [],
  ERROR: ['MANUAL_INTERVENTION_REQUIRED'],
  MANUAL_INTERVENTION_REQUIRED: []
};

function isValidTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

async function createProposal({
  signalId, strategyId, symbol, direction,
  executionMode, entryZone, stopPrice, t1Price, t2Price, runnerTarget,
  positionSize, riskAmount, rrRatio,
  marketSnapshot, catalystEvidence, technicalEvidence,
  fundamentalEvidence, warnings, historicalStats, dataSources
}) {
  const mode = resolveMode(executionMode);

  const result = await db.query(
    `INSERT INTO trade_proposals (
       signal_id, strategy_id, symbol, direction, execution_mode, lifecycle_state,
       entry_zone, stop_price, t1_price, t2_price, runner_target,
       position_size, risk_amount, rr_ratio,
       market_snapshot, catalyst_evidence, technical_evidence,
       fundamental_evidence, warnings, historical_stats, data_sources
     ) VALUES (
       $1, $2, $3, $4, $5, 'READY_FOR_APPROVAL',
       $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20
     ) RETURNING *`,
    [
      signalId, strategyId, symbol.toUpperCase(), direction, mode,
      JSON.stringify(entryZone || {}),
      stopPrice || null, t1Price || null, t2Price || null, runnerTarget || null,
      positionSize || null, riskAmount || null, rrRatio || null,
      JSON.stringify(marketSnapshot || {}),
      JSON.stringify(catalystEvidence || []),
      JSON.stringify(technicalEvidence || []),
      JSON.stringify(fundamentalEvidence || []),
      JSON.stringify(warnings || []),
      JSON.stringify(historicalStats || {}),
      JSON.stringify(dataSources || [])
    ]
  );

  const proposal = result.rows[0];
  await audit.recordEvent('proposal_created', 'trade_proposal', proposal.id, {
    symbol: proposal.symbol, direction: proposal.direction,
    strategy_id: strategyId, execution_mode: mode
  });

  return proposal;
}

async function getById(id) {
  const result = await db.query(
    `SELECT * FROM trade_proposals WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function listProposals({ status, symbol, strategyId, limit = 50 } = {}) {
  const params = [];
  const conditions = [];

  if (status) {
    params.push(status);
    conditions.push(`lifecycle_state = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol.toUpperCase());
    conditions.push(`symbol = $${params.length}`);
  }
  if (strategyId) {
    params.push(strategyId);
    conditions.push(`strategy_id = $${params.length}`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);

  const result = await db.query(
    `SELECT * FROM trade_proposals
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function transitionState(proposalId, newState, userId = null) {
  const proposal = await getById(proposalId);
  if (!proposal) {
    throw new Error('Proposal not found');
  }

  if (!isValidTransition(proposal.lifecycle_state, newState)) {
    throw new Error(
      `Invalid transition: ${proposal.lifecycle_state} → ${newState}`
    );
  }

  const result = await db.query(
    `UPDATE trade_proposals
     SET lifecycle_state = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [proposalId, newState]
  );

  const updated = result.rows[0];
  await audit.recordEvent('state_transition', 'trade_proposal', proposalId, {
    from: proposal.lifecycle_state,
    to: newState,
    user_id: userId
  });

  return updated;
}

async function recordApproval(proposalId, userId, decision, note = null) {
  const proposal = await getById(proposalId);
  if (!proposal) {
    throw new Error('Proposal not found');
  }

  const result = await db.query(
    `INSERT INTO trade_approvals (proposal_id, user_id, decision, note)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [proposalId, userId, decision, note]
  );

  const approval = result.rows[0];

  const newState = decision === 'approved' ? 'APPROVED'
    : decision === 'rejected' ? 'REJECTED'
    : 'WATCH';

  await transitionState(proposalId, newState, userId);
  await audit.recordEvent('approval_recorded', 'trade_proposal', proposalId, {
    decision, user_id: userId, approval_id: approval.id
  });

  return approval;
}

async function getApprovals(proposalId) {
  const result = await db.query(
    `SELECT * FROM trade_approvals
     WHERE proposal_id = $1
     ORDER BY decided_at DESC`,
    [proposalId]
  );
  return result.rows;
}

// Edit is allowed only in READY_FOR_APPROVAL or WATCH state.
// Only entry/stop/targets/risk fields are editable — the original
// market_snapshot and evidence snapshots are immutable. Warnings are
// editable so the user can annotate risk notes before approval.
const EDITABLE_FIELDS = [
  'entryZone', 'stopPrice', 't1Price', 't2Price', 'runnerTarget',
  'positionSize', 'riskAmount', 'rrRatio', 'warnings'
];

async function editProposal(proposalId, updates, userId = null) {
  const proposal = await getById(proposalId);
  if (!proposal) {
    throw new Error('Proposal not found');
  }

  if (!['READY_FOR_APPROVAL', 'WATCH'].includes(proposal.lifecycle_state)) {
    throw new Error('Proposal can only be edited in READY_FOR_APPROVAL or WATCH state');
  }

  const setClauses = [];
  const params = [];

  if (updates.entryZone != null) {
    params.push(JSON.stringify(updates.entryZone));
    setClauses.push(`entry_zone = $${params.length}`);
  }
  if (updates.stopPrice != null) {
    params.push(updates.stopPrice);
    setClauses.push(`stop_price = $${params.length}`);
  }
  if (updates.t1Price != null) {
    params.push(updates.t1Price);
    setClauses.push(`t1_price = $${params.length}`);
  }
  if (updates.t2Price != null) {
    params.push(updates.t2Price);
    setClauses.push(`t2_price = $${params.length}`);
  }
  if (updates.runnerTarget != null) {
    params.push(updates.runnerTarget);
    setClauses.push(`runner_target = $${params.length}`);
  }
  if (updates.positionSize != null) {
    params.push(updates.positionSize);
    setClauses.push(`position_size = $${params.length}`);
  }
  if (updates.riskAmount != null) {
    params.push(updates.riskAmount);
    setClauses.push(`risk_amount = $${params.length}`);
  }
  if (updates.rrRatio != null) {
    params.push(updates.rrRatio);
    setClauses.push(`rr_ratio = $${params.length}`);
  }
  if (updates.warnings != null) {
    params.push(JSON.stringify(updates.warnings));
    setClauses.push(`warnings = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return proposal;
  }

  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
  params.push(proposalId);

  const result = await db.query(
    `UPDATE trade_proposals
     SET ${setClauses.join(', ')}
     WHERE id = $${params.length}
     RETURNING *`,
    params
  );

  const updated = result.rows[0];
  await audit.recordEvent('proposal_edited', 'trade_proposal', proposalId, {
    user_id: userId,
    edited_fields: EDITABLE_FIELDS.filter((f) => updates[f] != null)
  });

  return updated;
}

module.exports = {
  createProposal,
  getById,
  listProposals,
  transitionState,
  recordApproval,
  getApprovals,
  editProposal,
  isValidTransition,
  TRANSITIONS
};