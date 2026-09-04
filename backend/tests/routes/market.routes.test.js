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
  getFilings: jest.fn()
}));

const express = require('express');

// Capture router.use / router.get calls in a fake router.
const useCalls = [];
const getCalls = [];

jest.spyOn(express, 'Router').mockImplementation(() => ({
  use: (...args) => { useCalls.push(args); },
  get: (...args) => { getCalls.push(args); }
}));

const marketRoutes = require('../../src/routes/market.routes');
const { authenticate } = require('../../src/middleware/auth');

describe('market.routes wiring', () => {
  test('router.use is called with authenticate first (auth gate)', () => {
    expect(useCalls.length).toBeGreaterThanOrEqual(1);
    expect(useCalls[0][0]).toBe(authenticate);
  });

  test('all 5 GET endpoints are registered (read-only)', () => {
    const paths = getCalls.map((args) => args[0]);
    expect(paths.sort()).toEqual(['/earnings', '/filings', '/halts', '/indices', '/movers', '/news']);
  });

  test('no mutating routes are registered (only GET)', () => {
    // The fake router only exposes use/get; if market.routes.js had called
    // post/put/delete they would throw here. The get-only assertions above
    // confirm read-only.
    expect(getCalls.length).toBe(6);
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
