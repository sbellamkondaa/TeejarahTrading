// Tests for source registry isolation and X/Bluesky graceful disable behavior.

const sourceRegistry = require('../../src/services/marketIntelligence/sourceRegistry');

describe('source registry isolation', () => {
  test('all sources expose name/sourceTier/isEnabled', () => {
    for (const s of sourceRegistry.SOURCES) {
      expect(typeof s.name()).toBe('string');
      expect(typeof s.sourceTier()).toBe('string');
      expect(typeof s.isEnabled()).toBe('boolean');
    }
  });

  test('X API source is disabled when no credentials (graceful)', () => {
    const x = sourceRegistry.SOURCES.find((s) => s.name() === 'x_api');
    expect(x).toBeDefined();
    // Without X_API_BEARER_TOKEN + ENABLE_X_API_SOURCE=true, it must be disabled.
    const hadToken = process.env.X_API_BEARER_TOKEN;
    const hadEnable = process.env.ENABLE_X_API_SOURCE;
    delete process.env.X_API_BEARER_TOKEN;
    process.env.ENABLE_X_API_SOURCE = 'false';
    expect(x.isEnabled()).toBe(false);
    if (hadToken) process.env.X_API_BEARER_TOKEN = hadToken; else delete process.env.X_API_BEARER_TOKEN;
    if (hadEnable) process.env.ENABLE_X_API_SOURCE = hadEnable; else delete process.env.ENABLE_X_API_SOURCE;
  });

  test('X API fetchRecent is a no-op returning empty when disabled', async () => {
    const x = sourceRegistry.SOURCES.find((s) => s.name() === 'x_api');
    const hadToken = process.env.X_API_BEARER_TOKEN;
    delete process.env.X_API_BEARER_TOKEN;
    process.env.ENABLE_X_API_SOURCE = 'false';
    const res = await x.fetchRecent();
    expect(res.items).toEqual([]);
    expect(res.fetched).toBe(0);
    if (hadToken) process.env.X_API_BEARER_TOKEN = hadToken; else delete process.env.X_API_BEARER_TOKEN;
  });

  test('Bluesky source is disabled by default', () => {
    const b = sourceRegistry.SOURCES.find((s) => s.name() === 'bluesky');
    expect(b).toBeDefined();
    delete process.env.ENABLE_BLUESKY_SOURCE;
    expect(b.isEnabled()).toBe(false);
  });

  test('RSS source is disabled without RSS_FEEDS', () => {
    const r = sourceRegistry.SOURCES.find((s) => s.name() === 'rss');
    expect(r).toBeDefined();
    delete process.env.RSS_FEEDS;
    delete process.env.ENABLE_RSS_SOURCE;
    expect(r.isEnabled()).toBe(false);
  });

  test('a broken source does not abort fetchAll (isolation)', async () => {
    // Inject a throwing source into a fresh registry call by stubbing one source.
    const x = sourceRegistry.SOURCES.find((s) => s.name() === 'x_api');
    const orig = x.fetchRecent;
    x.fetchRecent = async () => { throw new Error('simulated outage'); };
    // Enable only X so fetchAll exercises the failing path.
    const hadToken = process.env.X_API_BEARER_TOKEN;
    process.env.X_API_BEARER_TOKEN = 'test';
    process.env.ENABLE_X_API_SOURCE = 'true';
    // Disable every other source so only the failing one is invoked.
    const origState = {};
    for (const s of sourceRegistry.SOURCES) {
      if (s !== x) {
        origState[s.name()] = { isEnabled: s.isEnabled, fetchRecent: s.fetchRecent };
        s.isEnabled = () => false;
      }
    }
    const res = await sourceRegistry.fetchAll();
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].source).toBe('x_api');
    expect(res.totalItems).toBe(0);
    // Restore
    x.fetchRecent = orig;
    for (const s of sourceRegistry.SOURCES) {
      if (s !== x) {
        s.isEnabled = origState[s.name()].isEnabled;
        s.fetchRecent = origState[s.name()].fetchRecent;
      }
    }
    if (hadToken) process.env.X_API_BEARER_TOKEN = hadToken; else delete process.env.X_API_BEARER_TOKEN;
    delete process.env.ENABLE_X_API_SOURCE;
  });
});
