/**
 * Setup Stats Service — Empirical Win Rates from Observed Trade Data
 *
 * Computes empirical win rates per setup type from the user's completed
 * journal trades.  Per PRODUCT_REQUIREMENTS.md:
 *
 *   - "empirical win rate for comparable setups"
 *   - "sample size, time period, filter conditions"
 *   - "Historical probability must come from observed/backtested data only."
 *   - "Never fabricate probability."
 *   - "If samples are insufficient, display: Insufficient comparable trades"
 *
 * Data source: the `trades` table (user journal).  Only completed trades
 * (exit_price IS NOT NULL AND pnl IS NOT NULL) are counted.  The `setup`
 * column is free-text — normalised to snake_case for matching against the
 * scanner's canonical SETUP_TYPES.
 *
 * No fabrication: if no comparable trades exist, or the sample is below
 * MIN_SAMPLE_SIZE, the result is marked insufficient.  Win rate is never
 * rounded to imply false precision — it carries one decimal place.
 */

const db = require('../../config/database');

const MIN_SAMPLE_SIZE = 5;

/**
 * Normalise a free-text setup label to a canonical snake_case key.
 * "VWAP Reclaim"      → "vwap_reclaim"
 * "Gap & Catalyst"    → "gap_catalyst"
 * "VWAP-Reclaim"      → "vwap_reclaim"
 */
function normalizeSetup(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Aggregate raw trade rows (grouped by setup) into a stats map keyed by
 * normalised setup name.  Pure — no I/O.
 */
function aggregateStats(rows) {
  const map = {};
  for (const row of rows) {
    const key = normalizeSetup(row.setup);
    if (!key) continue;
    const sampleSize = parseInt(row.sample_size, 10);
    const wins = parseInt(row.wins, 10);
    const losses = parseInt(row.losses, 10);
    const avgPnl = parseFloat(row.avg_pnl) || 0;
    const avgPnlPct = parseFloat(row.avg_pnl_pct) || 0;
    const avgWin = parseFloat(row.avg_win) || 0;
    const avgLoss = parseFloat(row.avg_loss) || 0;

    const existing = map[key];
    if (existing) {
      // Merge: accumulate counts, weighted-average pnl fields, widen date range
      const totalSize = existing.sample_size + sampleSize;
      existing.wins += wins;
      existing.losses += losses;
      existing.sample_size = totalSize;
      existing.win_rate = totalSize > 0 ? Math.round((existing.wins / totalSize) * 1000) / 10 : 0;
      existing.avg_pnl = (existing.avg_pnl * (existing.sample_size - sampleSize) + avgPnl * sampleSize) / totalSize;
      existing.avg_pnl_pct = (existing.avg_pnl_pct * (existing.sample_size - sampleSize) + avgPnlPct * sampleSize) / totalSize;
      existing.avg_win = (existing.avg_win * (existing.sample_size - sampleSize) + avgWin * sampleSize) / totalSize;
      existing.avg_loss = (existing.avg_loss * (existing.sample_size - sampleSize) + avgLoss * sampleSize) / totalSize;
      if (row.date_from && (!existing.date_from || row.date_from < existing.date_from)) {
        existing.date_from = row.date_from;
      }
      if (row.date_to && (!existing.date_to || row.date_to > existing.date_to)) {
        existing.date_to = row.date_to;
      }
      existing.sufficient = totalSize >= MIN_SAMPLE_SIZE;
    } else {
      map[key] = {
        setup_label: row.setup,
        normalized: key,
        sample_size: sampleSize,
        wins,
        losses,
        win_rate: sampleSize > 0 ? Math.round((wins / sampleSize) * 1000) / 10 : 0,
        avg_pnl: avgPnl,
        avg_pnl_pct: avgPnlPct,
        avg_win: avgWin,
        avg_loss: avgLoss,
        date_from: row.date_from,
        date_to: row.date_to,
        sufficient: sampleSize >= MIN_SAMPLE_SIZE
      };
    }
  }
  return map;
}

/**
 * Look up stats for a canonical setup_type from the scanner/strategy.
 *
 * Matching order (deterministic, never fabricated):
 *   1. Exact normalised match — stats[normalize(setupType)]
 *   2. Prefix match — any stats key where setupType starts with key + "_"
 *      (e.g. "vwap_reclaim_with_catalyst" matches "vwap_reclaim")
 *   3. No match → insufficient with sample_size 0
 */
function lookupBySetupType(statsMap, setupType) {
  const normalized = normalizeSetup(setupType);
  if (!normalized) return null;

  // 1. Exact
  if (statsMap[normalized]) {
    return { ...statsMap[normalized], setup_type: setupType };
  }

  // 2. Prefix: find the longest key that is a prefix of the normalised setupType
  let bestKey = null;
  for (const key of Object.keys(statsMap)) {
    if (normalized.startsWith(key + '_') || normalized === key) {
      if (!bestKey || key.length > bestKey.length) {
        bestKey = key;
      }
    }
  }
  if (bestKey) {
    return { ...statsMap[bestKey], setup_type: setupType };
  }

  // 3. No comparable data
  return {
    setup_type: setupType,
    setup_label: null,
    normalized,
    sample_size: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    avg_pnl: 0,
    avg_pnl_pct: 0,
    avg_win: 0,
    avg_loss: 0,
    date_from: null,
    date_to: null,
    sufficient: false,
    insufficient_reason: 'No comparable trades found'
  };
}

/**
 * Fetch empirical stats for all setups from the user's completed trades.
 * Returns a map keyed by normalised setup name.
 */
async function getSetupStats(userId) {
  const result = await db.query(
    `SELECT
        setup,
        COUNT(*)::int AS sample_size,
        COUNT(*) FILTER (WHERE pnl > 0)::int  AS wins,
        COUNT(*) FILTER (WHERE pnl <= 0)::int AS losses,
        COALESCE(AVG(pnl), 0)::float                          AS avg_pnl,
        COALESCE(AVG(pnl_percent), 0)::float                  AS avg_pnl_pct,
        COALESCE(AVG(pnl) FILTER (WHERE pnl > 0), 0)::float     AS avg_win,
        COALESCE(AVG(ABS(pnl)) FILTER (WHERE pnl <= 0), 0)::float AS avg_loss,
        MIN(trade_date)::text AS date_from,
        MAX(trade_date)::text AS date_to
     FROM trades
     WHERE user_id = $1
       AND setup IS NOT NULL
       AND setup != ''
       AND exit_price IS NOT NULL
       AND pnl IS NOT NULL
     GROUP BY setup`,
    [userId]
  );
  return aggregateStats(result.rows);
}

/**
 * Fetch empirical stats for a specific setup type, with prefix-matching
 * fallback.  Never fabricates — returns insufficient when no data.
 */
async function getStatsForSetupType(userId, setupType) {
  const stats = await getSetupStats(userId);
  return lookupBySetupType(stats, setupType);
}

module.exports = {
  MIN_SAMPLE_SIZE,
  normalizeSetup,
  aggregateStats,
  lookupBySetupType,
  getSetupStats,
  getStatsForSetupType
};
