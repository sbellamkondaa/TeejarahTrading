jest.mock('../../src/utils/finnhub', () => ({
  getBasicFinancials: jest.fn()
}));
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), logDebug: jest.fn()
}));

const finnhub = require('../../src/utils/finnhub');
const { buildFundamentalProfile, buildFundamentalProfiles, calculateCashRunway, calculateShareTrend, clearCache } = require('../../src/services/fundamentalEngine');

describe('fundamentalEngine', () => {
  beforeEach(() => {
    finnhub.getBasicFinancials.mockReset();
    clearCache();
  });

  describe('calculateCashRunway', () => {
    test('calculates runway for burning company', () => {
      // cash $100M, annual burn $50M -> 24 months
      expect(calculateCashRunway(100e6, -50e6)).toBeCloseTo(24, 0);
    });

    test('returns null for profitable company (positive FCF)', () => {
      expect(calculateCashRunway(100e6, 10e6)).toBeNull();
    });

    test('returns null for insufficient data', () => {
      expect(calculateCashRunway(null, -50e6)).toBeNull();
      expect(calculateCashRunway(100e6, null)).toBeNull();
    });

    test('returns null when cash is zero', () => {
      expect(calculateCashRunway(0, -50e6)).toBeNull();
    });

    test('handles zero burn gracefully', () => {
      expect(calculateCashRunway(100e6, -0)).toBeNull();
    });
  });

  describe('calculateShareTrend', () => {
    test('detects expanding shares', () => {
      const result = calculateShareTrend(120, 100);
      expect(result.trend).toBe('expanding');
      expect(result.pct_change).toBe(20);
    });

    test('detects stable shares', () => {
      expect(calculateShareTrend(105, 100).trend).toBe('stable');
    });

    test('detects shrinking shares', () => {
      expect(calculateShareTrend(95, 100).trend).toBe('shrinking');
    });

    test('returns null for missing data', () => {
      expect(calculateShareTrend(null, 100)).toBeNull();
      expect(calculateShareTrend(100, null)).toBeNull();
      expect(calculateShareTrend(100, 0)).toBeNull();
    });
  });

  describe('buildFundamentalProfile', () => {
    test('builds a full profile from Finnhub metrics', async () => {
      finnhub.getBasicFinancials.mockResolvedValue({
        metric: {
          revenueGrowthTTMYoy: 25.5,
          epsTTM: 2.5,
          netProfitMarginTTM: 15.2,
          grossMarginTTM: 60.1,
          operatingMarginTTM: 30.5,
          cashPerSharePerShareQuarterly: 5.0,
          'totalDebt/totalEquityQuarterly': 1.2,
          freeCashFlowPerShareTTM: 1.5,
          cashFlowPerShareTTM: 2.0,
          shareOutstanding: 100, // millions
          marketCapitalization: 5000 // millions
        }
      });

      const profile = await buildFundamentalProfile('nvda');
      expect(profile.symbol).toBe('NVDA');
      expect(profile.revenue_growth.value).toBe(25.5);
      expect(profile.revenue_growth.source).toBe('finnhub-basic-financials');
      expect(profile.revenue_growth.period).toBe('TTM YoY %');
      expect(profile.eps_ttm.value).toBe(2.5);
      expect(profile.gross_margin.value).toBe(60.1);
      expect(profile.cash_per_share.value).toBe(5.0);
      expect(profile.cash_total.value).toBeCloseTo(500e6, -6);
      expect(profile.debt_to_equity.value).toBe(1.2);
      expect(profile.fcf_per_share.value).toBe(1.5);
      expect(profile.shares_outstanding.value).toBe(100e6);
      expect(profile.market_cap.value).toBe(5000e6);
      expect(profile.is_loss_making).toBe(false);
      expect(profile.cash_runway_months).toBeNull();
      expect(profile._meta.unavailable).toHaveLength(0);
    });

    test('calculates cash runway for loss-making company', async () => {
      finnhub.getBasicFinancials.mockResolvedValue({
        metric: {
          epsTTM: -2.0,
          netProfitMarginTTM: -20,
          cashPerSharePerShareQuarterly: 4.0,
          freeCashFlowPerShareTTM: -1.0,
          shareOutstanding: 50, // millions
          revenueGrowthTTMYoy: 10
        }
      });

      const profile = await buildFundamentalProfile('LOSS');
      expect(profile.is_loss_making).toBe(true);
      // cash = 4.0 * 50M = 200M; burn = 1.0 * 50M = 50M/yr
      expect(profile.cash_runway_months.value).toBeCloseTo(48, 0);
    });

    test('missing metrics are null, not fabricated', async () => {
      finnhub.getBasicFinancials.mockResolvedValue({
        metric: { revenueGrowthTTMYoy: 5 }
      });

      const profile = await buildFundamentalProfile('SPARSE');
      expect(profile.revenue_growth.value).toBe(5);
      expect(profile.eps_ttm).toBeNull();
      expect(profile.market_cap).toBeNull();
      expect(profile._meta.unavailable).toContain('eps_ttm');
      expect(profile._meta.unavailable).toContain('market_cap');
    });

    test('provider failure returns unavailable profile', async () => {
      finnhub.getBasicFinancials.mockRejectedValue(new Error('boom'));

      const profile = await buildFundamentalProfile('FAIL');
      expect(profile._meta.unavailable).toContain('all');
      expect(profile.revenue_growth).toBeUndefined();
    });

    test('null provider response returns unavailable profile', async () => {
      finnhub.getBasicFinancials.mockResolvedValue(null);

      const profile = await buildFundamentalProfile('NULL');
      expect(profile._meta.unavailable).toContain('all');
    });

    test('profiles are cached (no repeat provider calls)', async () => {
      finnhub.getBasicFinancials.mockResolvedValue({ metric: { epsTTM: 1 } });

      await buildFundamentalProfile('CACHE');
      await buildFundamentalProfile('CACHE');
      expect(finnhub.getBasicFinancials).toHaveBeenCalledTimes(1);
    });

    test('empty symbol returns null', async () => {
      expect(await buildFundamentalProfile('')).toBeNull();
      expect(await buildFundamentalProfile(null)).toBeNull();
    });
  });

  describe('buildFundamentalProfiles (batch)', () => {
    test('builds profiles for multiple symbols', async () => {
      finnhub.getBasicFinancials.mockResolvedValue({ metric: { epsTTM: 1 } });

      const results = await buildFundamentalProfiles(['AAA', 'BBB', 'CCC']);
      expect(Object.keys(results)).toHaveLength(3);
      expect(results.AAA.eps_ttm.value).toBe(1);
      expect(results.BBB.eps_ttm.value).toBe(1);
    });

    test('individual failure does not break batch', async () => {
      finnhub.getBasicFinancials.mockImplementation((sym) => {
        if (sym === 'BAD') return Promise.reject(new Error('no data'));
        return Promise.resolve({ metric: { epsTTM: 1 } });
      });

      const results = await buildFundamentalProfiles(['GOOD', 'BAD']);
      expect(results.GOOD).not.toBeNull();
      expect(results.BAD).toBeNull();
    });

    test('empty input returns empty map', async () => {
      expect(await buildFundamentalProfiles([])).toEqual({});
    });
  });
});
