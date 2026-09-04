jest.mock('../../src/middleware/auth', () => ({
  authenticate: jest.fn((req, _res, next) => {
    // Simulate an unauthenticated request: throw the same error the real
    // middleware raises when no access token is present.
    const err = new Error('Please authenticate');
    err.status = 401;
    next(err);
  })
}));
jest.mock('../../src/controllers/market.controller', () => ({
  getIndices: jest.fn((req, res) => res.json({ indices: [] })),
  getHalts: jest.fn((req, res) => res.json({ halts: [] })),
  getNews: jest.fn((req, res) => res.json({ news: [] })),
  getEarnings: jest.fn((req, res) => res.json({ earnings: [] })),
  getFilings: jest.fn((req, res) => res.json({ filings: [] }))
}));

const express = require('express');
const request = require('supertest');
const marketRoutes = require('../../src/routes/market.routes');

describe('market routes authentication', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.set('trust proxy', false);
    app.use(express.json());
    // Standard Express error handler so next(err) becomes a 401 response.
    app.use('/', marketRoutes);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  const endpoints = ['/indices', '/halts', '/news', '/earnings', '/filings'];

  test.each(endpoints)('GET /api/market%s requires authentication (401 without session)', async (ep) => {
    const response = await request(app).get(ep);
    expect(response.status).toBe(401);
  });

  test('no unauthenticated endpoint leaks data — all 5 routes are gated', async () => {
    const responses = await Promise.all(
      endpoints.map((ep) => request(app).get(ep))
    );
    for (const r of responses) {
      expect(r.status).toBe(401);
    }
  });
});
