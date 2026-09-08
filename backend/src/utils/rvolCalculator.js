/**
 * RVOL (Relative Volume) Calculator
 *
 * Calculates relative volume as:
 *   current_session_volume / historical_average_daily_volume
 *
 * Uses Schwab daily candle history (20 sessions by default) to compute the
 * average. The method is labeled explicitly because intraday cumulative
 * volume through a comparable market time is not available from the Schwab
 * movers endpoint — this is a daily-volume ratio, not an intraday RVOL.
 *
 * Missing data is NEVER converted to 0. When volume or history is unavailable,
 * the result is { rvol: null, rvol_status: 'UNKNOWN', rvol_method: null }.
 */

const schwabMarketData = require('../utils/schwabMarketData');

const DEFAULT_LOOKBACK_SESSIONS = 20;
const MAX_CANDIDATES_TO_FETCH = 30;

/**
 * Calculate RVOL for a single symbol using daily history.
 * @param {string} symbol
 * @param {number} currentSessionVolume - total session volume from Schwab movers
 * @param {number} [lookbackSessions=20]
 * @returns {Promise<{rvol: number|null, rvol_method: string|null, rvol_status: string, rvol_as_of: string|null}>}
 */
async function calculateRvolForSymbol(symbol, currentSessionVolume, lookbackSessions = DEFAULT_LOOKBACK_SESSIONS) {
  if (currentSessionVolume == null || currentSessionVolume <= 0 || !Number.isFinite(Number(currentSessionVolume))) {
    return { rvol: null, rvol_method: null, rvol_status: 'UNKNOWN', rvol_as_of: null };
  }

  const days = Math.max(lookbackSessions + 5, 30); // fetch extra days to account for weekends/holidays
  let candles;
  try {
    candles = await schwabMarketData.getPriceHistory(symbol, days);
  } catch {
    return { rvol: null, rvol_method: null, rvol_status: 'UNKNOWN', rvol_as_of: null };
  }

  if (!candles || !Array.isArray(candles) || candles.length < 5) {
    return { rvol: null, rvol_method: null, rvol_status: 'UNKNOWN', rvol_as_of: null };
  }

  // Use the most recent N complete sessions (exclude today's incomplete session).
  // Candle timestamps are epoch seconds; compare against US/Eastern midnight
  // (market timezone) so the boundary is correct regardless of server TZ.
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etMidnight = new Date(etStr);
  etMidnight.setHours(0, 0, 0, 0);
  const todayStartSec = Math.floor(etMidnight.getTime() / 1000);
  const completeSessions = sorted.filter((c) => c.time < todayStartSec);

  // Use complete sessions when available; if too few (e.g. new listing), fall
  // back to all sessions but still exclude the last candle (likely today's
  // partial data). Never include today's partial session in the average.
  const history = completeSessions.length >= 5
    ? completeSessions.slice(-lookbackSessions)
    : sorted.slice(0, -1).slice(-lookbackSessions); // exclude last candle (today)

  if (history.length < 5) {
    return { rvol: null, rvol_method: null, rvol_status: 'UNKNOWN', rvol_as_of: null };
  }

  const volumes = history.map((c) => Number(c.volume)).filter((v) => Number.isFinite(v) && v > 0);
  if (volumes.length < 5) {
    return { rvol: null, rvol_method: null, rvol_status: 'UNKNOWN', rvol_as_of: null };
  }

  const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
  if (avgVolume <= 0) {
    return { rvol: null, rvol_method: null, rvol_status: 'UNKNOWN', rvol_as_of: null };
  }

  const rvol = Number(currentSessionVolume) / avgVolume;
  return {
    rvol: Math.round(rvol * 100) / 100,
    rvol_method: 'daily_volume_ratio',
    rvol_status: 'CALCULATED',
    rvol_as_of: new Date().toISOString()
  };
}

/**
 * Batch-calculate RVOL for a set of candidates. Fetches daily history for the
 * top N candidates by current session volume. Candidates beyond the batch or
 * without volume data get UNKNOWN status.
 *
 * @param {object[]} candidates - candidates with { symbol, volume, total_volume }
 * @param {number} [maxFetch=30] - max candidates to fetch history for
 * @returns {Promise<Map<string, {rvol, rvol_method, rvol_status, rvol_as_of}>>}
 */
async function batchCalculateRvol(candidates, maxFetch = MAX_CANDIDATES_TO_FETCH) {
  const result = new Map();

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return result;
  }

  // Sort by total_volume descending and take top N
  const sorted = candidates
    .filter((c) => c && c.symbol)
    .sort((a, b) => {
      const av = a.total_volume ?? a.volume ?? 0;
      const bv = b.total_volume ?? b.volume ?? 0;
      return bv - av;
    })
    .slice(0, maxFetch);

  // Fetch history in parallel (Schwab client has rate limiting + caching built in)
  const promises = sorted.map(async (c) => {
    const sessionVol = c.total_volume ?? c.volume ?? null;
    const r = await calculateRvolForSymbol(c.symbol, sessionVol);
    return [c.symbol, r];
  });

  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      result.set(r.value[0], r.value[1]);
    }
  }

  return result;
}

module.exports = {
  calculateRvolForSymbol,
  batchCalculateRvol,
  DEFAULT_LOOKBACK_SESSIONS,
  MAX_CANDIDATES_TO_FETCH
};
