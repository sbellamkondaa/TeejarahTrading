// Mock the auth middleware to avoid loading its heavy deps (jsonwebtoken,
// User model) in the stripped prod image. Return a real named function so
// Express's router.use(authenticate) binds it as middleware.
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

const marketRoutes = require('../../src/routes/market.routes');
const { authenticate } = require('../../src/middleware/auth');

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
