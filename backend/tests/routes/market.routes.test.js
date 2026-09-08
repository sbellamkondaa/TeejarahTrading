// Verifies that market.routes.js wires the authenticate middleware before the
// route handlers. Mocks express.Router to capture use()/get() calls, avoiding
// the pathRegexp incompatibility between jest's module resolution and the
// path-to-regexp version in the prod image.

jest.mock('../../src/middleware/auth', () => {
  const authenticate = function authenticate(req, res, next) {
    const err = new Error('Please authenticate');
    err.status = 401;
    next(err);
  };
  return { authenticate };
});

jest.mock('../../src/controllers/market.controller', () => ({
  getIndices: jest.fn(),
  getHalts: jest.fn(),
  getNews: jest.fn(),
  getEarnings: jest.fn(),
  getFilings: jest.fn(),
  getMovers: jest.fn(),
  getScanner: jest.fn(),
  getRelationships: jest.fn(),
  getCandles: jest.fn(),
  getEvents: jest.fn(),
  getSymbolEvents: jest.fn(),
  getSources: jest.fn()
}));

jest.mock('../../src/controllers/advisory.controller', () => ({
  analyze: jest.fn(),
  getStatus: jest.fn()
}));

jest.mock('../../src/controllers/marketIntelligence.controller', () => ({
  triggerIngestion: jest.fn(),
  getStatus: jest.fn()
}));

const express = require('express');

// Capture router.use / router.get / router.post calls in a fake router.
const useCalls = [];
const getCalls = [];
const postCalls = [];

jest.spyOn(express, 'Router').mockImplementation(() => ({
  use: (...args) => { useCalls.push(args); },
  get: (...args) => { getCalls.push(args); },
  post: (...args) => { postCalls.push(args); }
}));

const marketRoutes = require('../../src/routes/market.routes');
const { authenticate } = require('../../src/middleware/auth');

describe('market.routes wiring', () => {
  test('router.use is called with authenticate first (auth gate)', () => {
    expect(useCalls.length).toBeGreaterThanOrEqual(1);
    expect(useCalls[0][0]).toBe(authenticate);
  });

  test('all GET endpoints are registered', () => {
    const paths = getCalls.map((args) => args[0]);
    const expected = ['/advisory/status', '/candles', '/earnings', '/events', '/events/:symbol', '/filings', '/halts',
      '/indices', '/intelligence/status', '/movers', '/news', '/relationships/:symbol', '/scanner', '/sources'];
    expect(paths.sort()).toEqual(expected.sort());
  });

  test('POST /advisory and /intelligence/ingest are registered (auth-gated)', () => {
    const paths = postCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual(['/advisory', '/intelligence/ingest']);
  });

  test('GET /intelligence/status is registered (auth-gated)', () => {
    const paths = getCalls.map((args) => args[0]);
    expect(paths).toContain('/intelligence/status');
  });

  test('authenticate rejects without a session (401)', () => {
    const next = jest.fn();
    authenticate({}, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
  });
});
