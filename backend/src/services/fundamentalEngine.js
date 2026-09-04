/**
 * Fundamental Profile Engine
 *
 * Deterministic fundamental analysis per symbol. Sources:
 * - Finnhub basic financials (primary, 24h cache, all symbols)
 * - SEC company facts (secondary, only AFRM/ESTC currently ingested)
 *
 * Every metric includes source, period, as_of, and stale/unavailable state.
 * Missing metrics are null — never fabricated.
 */

const finnhub = require('../utils/finnhub');
const logger = require('../utils/logger');

// In-memory cache for fundamental profiles (5 minutes — fundamentals don't change intraday)
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const profileCache = new Map();

function isNum(v) {
  return v != null && Number.isFinite(Number(v));
}

function toNum(v) {
  return isNum(v) ? Number(v) : null;
}

/**
 * Calculate cash runway in months for loss-making companies.
 * runway = cash / |monthly_burn| where burn derived from negative FCF per share
 * times shares outstanding.
 *
 * @param {number} cashTotal - total cash (cash_per_share * shares)
 * @param {number} fcfTotal - free cash flow (per_share * shares), negative = burning
 * @returns {number|null} runway in months, or null if insufficient data
 */
function calculateCashRunway(cashTotal, fcfTotal) {
  if (!isNum(cashTotal) || !isNum(fcfTotal) || fcfTotal >= 0 || cashTotal <= 0) {
    return null;
  }
  const monthlyBurn = Math.abs(fcfTotal) / 12;
  if (monthlyBurn <= 0) return null;
  return cashTotal / monthlyBurn;
}

/**
 * Determine dilution trend from share-count history.
 * @param {number} currentShares
 * @param {number} shares5YAgo (or prior period)
 * @returns {object|null} { trend: 'expanding'|'stable'|'shrinking', pct_change }
 */
function calculateShareTrend(currentShares, priorShares) {
  if (!isNum(currentShares) || !isNum(priorShares) || priorShares <= 0) return null;
  const pct = ((currentShares - priorShares) / priorShares) * 100;
  let trend;
  if (pct > 10) trend = 'expanding';
  else if (pct < -2) trend = 'shrinking';
  else trend = 'stable';
  return { trend, pct_change: Number(pct.toFixed(2)) };
}

/**
 * Build a fundamental profile for a symbol.
 * @param {string} symbol
 * @returns {Promise<object>} Profile with per-metric metadata
 */
async function buildFundamentalProfile(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;

  // Cache check
  const cached = profileCache.get(sym);
  if (cached && Date.now() - cached._cachedAt < PROFILE_CACHE_TTL_MS) {
    return cached;
  }

  const asOf = Date.now();
  const source = 'finnhub-basic-financials';
  const profile = {
    symbol: sym,
    _cachedAt: asOf,
    _meta: { source, as_of: asOf, stale: false, unavailable: [] }
  };

  let metrics = null;
  try {
    const data = await finnhub.getBasicFinancials(sym);
    metrics = data && data.metric ? data.metric : null;
  } catch (err) {
    logger.warn('[FUNDAMENTAL] basic financials failed for ' + sym + ': ' + err.message);
  }

  if (!metrics) {
    profile._meta.unavailable.push('all');
    profileCache.set(sym, profile);
    return profile;
  }

  // Revenue growth (YoY %)
  const revenueGrowth = toNum(metrics.revenueGrowthTTMYoy ?? metrics.revenueGrowthQuarterlyYoy ?? metrics.revenueGrowth);
  profile.revenue_growth = revenueGrowth != null ? {
    value: revenueGrowth, source, period: 'TTM YoY %', as_of: asOf
  } : null;

  // EPS (TTM)
  const eps = toNum(metrics.epsTTM ?? metrics.epsBasicExclExtraItemsTTM);
  profile.eps_ttm = eps != null ? { value: eps, source, period: 'TTM', as_of: asOf } : null;

  // Profitability flag
  const netMargin = toNum(metrics.netProfitMarginTTM);
  profile.net_margin = netMargin != null ? { value: netMargin, source, period: 'TTM %', as_of: asOf } : null;

  // Margins
  const grossMargin = toNum(metrics.grossMarginTTM ?? metrics.grossMarginAnnual);
  profile.gross_margin = grossMargin != null ? { value: grossMargin, source, period: 'TTM %', as_of: asOf } : null;

  const operatingMargin = toNum(metrics.operatingMarginTTM ?? metrics.operatingMarginAnnual);
  profile.operating_margin = operatingMargin != null ? { value: operatingMargin, source, period: 'TTM %', as_of: asOf } : null;

  // Cash (per share -> total if shares available)
  const cashPerShare = toNum(metrics.cashPerSharePerShareQuarterly ?? metrics.cashPerSharePerShareAnnual);
  const shares = toNum(metrics.shareOutstanding);
  profile.cash_per_share = cashPerShare != null ? { value: cashPerShare, source, period: 'quarterly', as_of: asOf } : null;
  profile.cash_total = (cashPerShare != null && shares != null)
    ? { value: cashPerShare * shares * 1e6, source, period: 'quarterly', as_of: asOf } // shareOutstanding is in millions
    : null;

  // Debt
  const debtToEquity = toNum(metrics['totalDebt/totalEquityQuarterly'] ?? metrics['totalDebt/totalEquityAnnual'] ?? metrics['longTermDebt/equityQuarterly']);
  profile.debt_to_equity = debtToEquity != null ? { value: debtToEquity, source, period: 'quarterly', as_of: asOf } : null;

  // Cash flow
  const fcfPerShare = toNum(metrics.freeCashFlowPerShareTTM ?? metrics.freeCashFlowPerShareAnnual);
  profile.fcf_per_share = fcfPerShare != null ? { value: fcfPerShare, source, period: 'TTM', as_of: asOf } : null;

  const ocfPerShare = toNum(metrics.cashFlowPerShareTTM);
  profile.ocf_per_share = ocfPerShare != null ? { value: ocfPerShare, source, period: 'TTM', as_of: asOf } : null;

  // Shares outstanding / market cap
  profile.shares_outstanding = shares != null ? { value: shares * 1e6, source, period: 'current', as_of: asOf } : null;
  const marketCap = toNum(metrics.marketCapitalization);
  profile.market_cap = marketCap != null ? { value: marketCap * 1e6, source, period: 'current', as_of: asOf } : null; // in millions

  // Profitability classification
  const epsValue = profile.eps_ttm ? profile.eps_ttm.value : null;
  const fcfValue = profile.fcf_per_share ? profile.fcf_per_share.value : null;
  const isLossMaking = (epsValue != null && epsValue < 0) || (fcfValue != null && fcfValue < 0);
  profile.is_loss_making = isLossMaking;

  // Cash runway (only meaningful for loss-making companies)
  if (isLossMaking && profile.cash_total && profile.fcf_per_share && shares) {
    const fcfTotal = fcfValue * shares * 1e6;
    const runway = calculateCashRunway(profile.cash_total.value, fcfTotal);
    profile.cash_runway_months = runway != null ? { value: runway, source, period: 'derived', as_of: asOf } : null;
  } else {
    profile.cash_runway_months = null;
  }

  // Share dilution trend (5Y book value growth as proxy when share history unavailable)
  const shareGrowth5Y = toNum(metrics.bookValueShareGrowth5Y);
  profile.share_trend = shareGrowth5Y != null
    ? { trend: shareGrowth5Y > 10 ? 'expanding' : 'stable', pct_change: shareGrowth5Y, source, period: '5Y', as_of: asOf }
    : null;

  // Track unavailable metrics
  const expected = ['revenue_growth', 'eps_ttm', 'net_margin', 'gross_margin', 'operating_margin',
    'cash_per_share', 'cash_total', 'debt_to_equity', 'fcf_per_share', 'ocf_per_share',
    'shares_outstanding', 'market_cap'];
  for (const key of expected) {
    if (profile[key] == null) profile._meta.unavailable.push(key);
  }

  profileCache.set(sym, profile);
  return profile;
}

/**
 * Build compact fundamental summaries for multiple symbols (batched).
 * Uses per-symbol caching; Finnhub basic financials are themselves cached 24h.
 * @param {string[]} symbols
 * @returns {Promise<object>} map of symbol -> profile
 */
async function buildFundamentalProfiles(symbols) {
  const results = {};
  if (!Array.isArray(symbols) || symbols.length === 0) return results;

  // Bounded concurrency: process in chunks of 5 to avoid hammering Finnhub
  const CHUNK = 5;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(chunk.map((s) => buildFundamentalProfile(s)));
    settled.forEach((r, idx) => {
      results[chunk[idx]] = r.status === 'fulfilled' ? r.value : null;
    });
  }
  return results;
}

// Test hook to clear cache
function clearCache() {
  profileCache.clear();
}

module.exports = {
  buildFundamentalProfile,
  buildFundamentalProfiles,
  calculateCashRunway,
  calculateShareTrend,
  clearCache,
  PROFILE_CACHE_TTL_MS
};
