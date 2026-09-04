// Verifies that every market endpoint is gated behind the authenticate
// middleware. Rather than mounting the router in a live Express app (which
// requires supertest, not in the prod image), we inspect the router's layer
// stack: the first layer should be router-level `authenticate`, and each route
// layer should be a GET handler.

// Use the REAL auth middleware so router.use(authenticate) binds correctly.
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
  test('router has a router-level authenticate layer', () => {
    // The first layer in the stack should be the authenticate middleware
    // mounted via router.use(authenticate).
    const useLayers = marketRoutes.stack.filter((l) => l.name === 'authenticate' || l.handle === authenticate);
    expect(useLayers.length).toBeGreaterThanOrEqual(1);
  });

  test('all 5 GET endpoints are registered', () => {
    const routeLayers = marketRoutes.stack.filter((l) => l.route);
    const paths = routeLayers.map((l) => l.route.path);
    expect(paths.sort()).toEqual(['/earnings', '/filings', '/halts', '/indices', '/news']);
    // Every registered route must be GET (read-only).
    for (const layer of routeLayers) {
      const methods = Object.keys(layer.route.methods);
      expect(methods).toEqual(['get']);
    }
  });

  test('authenticate runs before route handlers (it is the first layer)', () => {
    const first = marketRoutes.stack[0];
    expect(first.handle).toBe(authenticate);
    expect(first.route).toBeUndefined();
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
});
