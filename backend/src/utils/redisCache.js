const redisService = require('../services/redisService');

const PREFIX = 'teejarah:';

function makeKey(namespaceOrKey, key) {
  return key === undefined
    ? `${PREFIX}${namespaceOrKey}`
    : `${PREFIX}${namespaceOrKey}:${key}`;
}

async function get(namespaceOrKey, key) {
  const client = await redisService.getClient();

  if (!client) return null;

  const raw = await client.get(makeKey(namespaceOrKey, key));

  if (raw === null) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function set(namespaceOrKey, keyOrValue, valueOrTtl, ttlMs) {
  const client = await redisService.getClient();

  if (!client) return false;

  let key;
  let value;
  let ttl;

  if (ttlMs === undefined) {
    key = makeKey(namespaceOrKey);
    value = keyOrValue;
    ttl = valueOrTtl;
  } else {
    key = makeKey(namespaceOrKey, keyOrValue);
    value = valueOrTtl;
    ttl = ttlMs;
  }

  const serialized = JSON.stringify(value);

  if (Number.isFinite(ttl) && ttl > 0) {
    await client.set(key, serialized, { PX: ttl });
  } else {
    await client.set(key, serialized);
  }

  return true;
}

async function del(namespaceOrKey, key) {
  const client = await redisService.getClient();

  if (!client) return false;

  await client.del(makeKey(namespaceOrKey, key));
  return true;
}

async function exists(namespaceOrKey, key) {
  const client = await redisService.getClient();

  if (!client) return false;

  return (await client.exists(makeKey(namespaceOrKey, key))) === 1;
}

async function getStats() {
  const client = await redisService.getClient();

  if (!client) {
    return {
      enabled: false,
      keyCount: 0
    };
  }

  const keys = await client.keys(`${PREFIX}*`);

  return {
    enabled: true,
    keyCount: keys.length
  };
}

module.exports = {
  get,
  set,
  del,
  exists,
  getStats
};
