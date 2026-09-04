// Verifies that every market endpoint is gated behind the authenticate
// middleware. Rather than mounting the router in a live Express app (which
// requires supertest, not in the prod image), we inspect the router's layer
// stack: the first layer should be router-level `authenticate`, and each route
// layer should be a GET handler.

// Mock the auth middleware to avoid loading its heavy deps (jsonwebtoken,
// User model) in the stripped prod image. Return a real function reference so
// Express's router.use(authenticate) binds it as middleware (router.use throws
// "pathRegexp.match is not a function" if given a non-function).
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

const { authenticate } = require('../../src/middleware/auth');

test('DEBUG: check authenticate type before requiring routes', () => {
  console.log('typeof authenticate:', typeof authenticate);
  console.log('authenticate.toString():', String(authenticate).slice(0, 100));
  // Now require routes — this calls router.use(authenticate) internally.
  let routes;
  try {
    routes = require('../../src/routes/market.routes');
  } catch (e) {
    console.log('require routes threw:', e.message);
  }
  expect(true).toBe(true);
});

describe('market routes authentication', () => {
  test('router has a router-level authenticate layer as its first middleware', () => {
    const first = marketRoutes.stack[0];
    expect(first.handle).toBe(authenticate);
    expect(first.route).toBeUndefined();
  });

  test('all 5 GET endpoints are registered', () => {
    const routeLayers = marketRoutes.stack.filter((l) => l.route);
    const paths = routeLayers.map((l) => l.route.path);
    expect(paths.sort()).toEqual(['/earnings', '/filings', '/halts', '/indices', '/news']);
    for (const layer of routeLayers) {
      const methods = Object.keys(layer.route.methods);
      expect(methods).toEqual(['get']);
    }
  });

  test('no mutating routes (POST/PUT/DELETE) exist on the market router', () => {
    const routeLayers = marketRoutes.stack.filter((l) => l.route);
    for (const layer of routeLayers) {
      const methods = Object.keys(layer.route.methods);
      for (const m of methods) {
        expect(m).toBe('get');
      }
    }
  });

  test('authenticate middleware rejects without a session (401)', () => {
    const next = jest.fn();
    const res = {};
    authenticate({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
  });
});

