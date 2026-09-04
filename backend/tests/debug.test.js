jest.mock('../../src/middleware/auth', () => {
  const authenticate = function authenticate(req, res, next) { next(); };
  return { authenticate };
});

const auth = require('../../src/middleware/auth');
const express = require('express');

test('debug: authenticate is a function and binds to router.use', () => {
  console.log('typeof authenticate:', typeof auth.authenticate);
  const r = express.Router();
  r.use(auth.authenticate);
  console.log('stack len:', r.stack.length);
  expect(typeof auth.authenticate).toBe('function');
  expect(r.stack.length).toBe(1);
});
