// Verifies that trading.routes.js wires the authenticate middleware and
// registers all expected endpoints.

jest.mock('../../src/middleware/auth', () => {
  const authenticate = function authenticate(req, res, next) {
    const err = new Error('Please authenticate');
    err.status = 401;
    next(err);
  };
  return { authenticate };
});

jest.mock('../../src/controllers/trading.controller', () => ({
  getExecutionStatus: jest.fn(),
  listStrategies: jest.fn(),
  getStrategy: jest.fn(),
  createStrategy: jest.fn(),
  createStrategyVersion: jest.fn(),
  updateStrategyStatus: jest.fn(),
  runStrategyScan: jest.fn(),
  listSignals: jest.fn(),
  getSignal: jest.fn(),
  listProposals: jest.fn(),
  getProposal: jest.fn(),
  createProposal: jest.fn(),
  editProposal: jest.fn(),
  approveProposal: jest.fn(),
  transitionProposal: jest.fn(),
  assessProposalRisk: jest.fn(),
  getProposalRisk: jest.fn(),
  getRiskPresets: jest.fn(),
  paperEntry: jest.fn(),
  paperProcessFills: jest.fn(),
  paperCancelEntry: jest.fn(),
  paperUpdateStop: jest.fn(),
  paperManualClose: jest.fn(),
  paperReconcile: jest.fn(),
  getPaperPosition: jest.fn(),
  listPaperPositions: jest.fn(),
  listPaperOrders: jest.fn(),
  getPaperAccount: jest.fn(),
  getPaperReconciliationStatus: jest.fn(),
  triggerPaperReconciliation: jest.fn(),
  getJournalTrade: jest.fn(),
  syncJournal: jest.fn(),
  getSetupStats: jest.fn(),
  getSetupStatsByType: jest.fn(),
  createBacktestRun: jest.fn(),
  listBacktestRuns: jest.fn(),
  getBacktestRun: jest.fn(),
  getBacktestRunTrades: jest.fn()
}));

const express = require('express');

const useCalls = [];
const getCalls = [];
const postCalls = [];
const patchCalls = [];

jest.spyOn(express, 'Router').mockImplementation(() => ({
  use: (...args) => { useCalls.push(args); },
  get: (...args) => { getCalls.push(args); },
  post: (...args) => { postCalls.push(args); },
  patch: (...args) => { patchCalls.push(args); }
}));

require('../../src/routes/trading.routes');
const { authenticate } = require('../../src/middleware/auth');

describe('trading.routes wiring', () => {
  test('router.use is called with authenticate first (auth gate)', () => {
    expect(useCalls.length).toBeGreaterThanOrEqual(1);
    expect(useCalls[0][0]).toBe(authenticate);
  });

  test('all expected GET endpoints are registered', () => {
    const paths = getCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual([
      '/backtest-runs',
      '/backtest-runs/:id',
      '/backtest-runs/:id/trades',
      '/execution-mode',
      '/paper-account',
      '/paper-orders',
      '/paper-positions',
      '/paper-positions/:id',
      '/paper-reconciliation/status',
      '/proposals',
      '/proposals/:id',
      '/proposals/:id/journal-trade',
      '/proposals/:id/paper-position',
      '/proposals/:id/paper-reconcile',
      '/proposals/:id/risk-evaluation',
      '/risk-presets',
      '/setup-stats',
      '/setup-stats/:setupType',
      '/signals',
      '/signals/:id',
      '/strategies',
      '/strategies/:id'
    ]);
  });

  test('all expected POST endpoints are registered', () => {
    const paths = postCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual([
      '/backtest-runs',
      '/paper-reconciliation/run',
      '/proposals',
      '/proposals/:id/approval',
      '/proposals/:id/journal-sync',
      '/proposals/:id/paper-cancel-entry',
      '/proposals/:id/paper-entry',
      '/proposals/:id/paper-fills',
      '/proposals/:id/paper-manual-close',
      '/proposals/:id/risk-assessment',
      '/proposals/:id/transition',
      '/strategies',
      '/strategies/:id/scan',
      '/strategies/:name/versions'
    ]);
  });

  test('all expected PATCH endpoints are registered', () => {
    const paths = patchCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual(['/proposals/:id', '/proposals/:id/paper-stop', '/strategies/:id/status']);
  });
});
