jest.mock('../../src/middleware/auth', () => ({
  authenticate: jest.fn((req, _res, next) => {
    const err = new Error('Please authenticate');
    err.status = 401;
    next(err);
  })
}));
jest.mock('../../src/controllers/market.controller', () => ({
  getIndices: jest.fn(),
  getHalts: jest.fn(),
  getNews: jest.fn(),
  getEarnings: jest.fn(),
  getFilings: jest.fn()
}));

const express = require('express');
const http = require('http');
const marketRoutes = require('../../src/routes/market.routes');

// Drives an Express app with Node's http module directly, avoiding supertest
// (a devDependency not present in the prod image used for remote test runs).
function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe('market routes authentication', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.set('trust proxy', false);
    app.use(express.json());
    app.use('/', marketRoutes);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  const endpoints = ['/indices', '/halts', '/news', '/earnings', '/filings'];

  test.each(endpoints)('GET %s returns 401 without a session (route exists behind auth)', async (ep) => {
    const response = await get(app, ep);
    expect(response.status).toBe(401);
  });

  test('no unauthenticated endpoint leaks data — all 5 routes are gated', async () => {
    const statuses = await Promise.all(endpoints.map((ep) => get(app, ep).then((r) => r.status)));
    for (const s of statuses) {
      expect(s).toBe(401);
    }
  });
});
