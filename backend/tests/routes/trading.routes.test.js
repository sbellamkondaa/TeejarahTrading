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
  listSignals: jest.fn(),
  getSignal: jest.fn(),
  listProposals: jest.fn(),
  getProposal: jest.fn(),
  createProposal: jest.fn(),
  editProposal: jest.fn(),
  approveProposal: jest.fn(),
  transitionProposal: jest.fn()
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
      '/execution-mode',
      '/proposals',
      '/proposals/:id',
      '/signals',
      '/signals/:id',
      '/strategies',
      '/strategies/:id'
    ]);
  });

  test('all expected POST endpoints are registered', () => {
    const paths = postCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual([
      '/proposals',
      '/proposals/:id/approval',
      '/proposals/:id/transition',
      '/strategies',
      '/strategies/:name/versions'
    ]);
  });

  test('all expected PATCH endpoints are registered', () => {
    const paths = patchCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual(['/proposals/:id', '/strategies/:id/status']);
  });
});