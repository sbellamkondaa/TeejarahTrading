// Tests for the AI advisory service: bounded candidates, caching, PAPER-only.

const advisoryCache = require('../../src/services/ai/advisoryCache');
const advisoryService = require('../../src/services/ai/advisoryService');

describe('advisoryCache', () => {
  test('buildCacheKey is deterministic for same payload', () => {
    const payload = { mode: 'summary', enriched: [{ symbol: 'AAPL' }] };
    const k1 = advisoryCache.buildCacheKey(payload);
    const k2 = advisoryCache.buildCacheKey({ enriched: [{ symbol: 'AAPL' }], mode: 'summary' });
    expect(k1).toBe(k2);
  });

  test('buildCacheKey differs for different payloads', () => {
    const a = advisoryCache.buildCacheKey({ mode: 'summary', enriched: [{ symbol: 'AAPL' }] });
    const b = advisoryCache.buildCacheKey({ mode: 'compare', enriched: [{ symbol: 'AAPL' }] });
    expect(a).not.toBe(b);
  });
});

describe('advisoryService', () => {
  test('is disabled when ENABLE_AI_ADVISORY not true', () => {
    delete process.env.ENABLE_AI_ADVISORY;
    delete process.env.OPENROUTER_API_KEY;
    expect(advisoryService.isEnabled()).toBe(false);
  });

  test('analyze returns disabled reason when not enabled', async () => {
    delete process.env.ENABLE_AI_ADVISORY;
    delete process.env.OPENROUTER_API_KEY;
    const result = await advisoryService.analyze([{ symbol: 'AAPL' }], { mode: 'summary' });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
  });

  test('MAX_CANDIDATES bounds the candidate set (cost control)', () => {
    const max = advisoryService.MAX_CANDIDATES;
    expect(max).toBeLessThanOrEqual(20);
    expect(max).toBeGreaterThanOrEqual(1);
  });

  test('analyze returns empty reason when no candidates provided', async () => {
    process.env.ENABLE_AI_ADVISORY = 'true';
    process.env.OPENROUTER_API_KEY = 'test';
    const result = await advisoryService.analyze([], { mode: 'summary' });
    expect(result.enabled).toBe(true);
    expect(result.reason).toMatch(/No candidates/);
    delete process.env.ENABLE_AI_ADVISORY;
    delete process.env.OPENROUTER_API_KEY;
  });

  test('analyze never bypasses risk — it is advisory-only (returns analysis, not orders)', async () => {
    // Even with candidates, the service returns an analysis object, never an order.
    process.env.ENABLE_AI_ADVISORY = 'true';
    process.env.OPENROUTER_API_KEY = 'test';
    // Stub the LLM call via axios mock to avoid network
    jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { choices: [{ message: { content: '{"summary":"test"}' } }] } }) }));
    const result = await advisoryService.analyze([{ symbol: 'AAPL', last_price: 100 }], { mode: 'summary' });
    expect(result).toHaveProperty('enabled');
    // The result never contains an order/execution field
    expect(result).not.toHaveProperty('order');
    expect(result).not.toHaveProperty('execution');
    delete process.env.ENABLE_AI_ADVISORY;
    delete process.env.OPENROUTER_API_KEY;
    jest.dontMock('axios');
  });
});
