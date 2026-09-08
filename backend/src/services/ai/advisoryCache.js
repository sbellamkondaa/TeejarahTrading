/**
 * Advisory Cache — Redis-backed cache for AI advisory analysis keyed by a
 * content hash of the bounded candidate snapshot + event set + prompt mode.
 *
 * Prevents re-running the LLM when the underlying data has not materially
 * changed. TTL is bounded (default 10 minutes) so stale analysis is never
 * served long.
 */

const cache = require('../../utils/redisCache');

const NAMESPACE = 'ai-advisory';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const crypto = require('crypto');

function buildCacheKey(payload) {
  // Deterministic hash of the compact JSON payload (keys sorted)
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 24);
}

async function get(payload) {
  const key = buildCacheKey(payload);
  return cache.get(NAMESPACE, key);
}

async function set(payload, analysis, ttlMs = DEFAULT_TTL_MS) {
  const key = buildCacheKey(payload);
  return cache.set(NAMESPACE, key, analysis, ttlMs);
}

module.exports = { get, set, buildCacheKey, NAMESPACE, DEFAULT_TTL_MS };
