/**
 * Opportunity Score — deterministic composite score for scanner candidates.
 *
 * Combines available factors into a 0-100 score with a factor breakdown so the
 * score is explainable. Does NOT invent missing values; unknown factors
 * contribute zero rather than a fabricated estimate. Does NOT use market cap
 * or company popularity — by design avoids mega-cap headline-count bias.
 *
 * Factors (weighted):
 *  - gap_pct          (0-20) — magnitude of the gap move
 *  - rvol             (0-20) — relative volume surge (when available)
 *  - volume           (0-10) — absolute session volume
 *  - liquidity/spread (0-10) — tighter spread + higher dollar volume
 *  - catalyst quality (0-20) — strongest catalyst strength
 *  - technical setup   (0-10) — best setup score from the scanner
 *  - relative strength (0-10) — outperformance vs benchmark (when available)
 *
 * Returns { score, factors } so the UI can show the breakdown.
 */

function isNum(v) { return v != null && Number.isFinite(Number(v)); }

function clampPct(n, n_) {
  if (!isNum(n)) return 0;
  return Math.max(0, Math.min(100, Number(n)));
}

function scoreOpportunity(candidate) {
  const factors = {};
  let score = 0;

  // gap_pct (0-20): scaled so |gap|>=10 = full
  const gap = isNum(candidate.gap_pct) ? Math.abs(Number(candidate.gap_pct)) : null;
  factors.gap_pct = gap != null ? Math.min(20, Math.round((gap / 10) * 20)) : 0;
  if (gap == null) factors.gap_pct_unknown = true;
  score += factors.gap_pct;

  // rvol (0-20): RVOL>=4 = full. Missing rvol is NEVER converted to 0 —
  // it stays null and the factor is excluded from the score (unknown flag set).
  const rvol = isNum(candidate.rvol) ? Number(candidate.rvol) : null;
  if (rvol != null) {
    factors.rvol = Math.min(20, Math.round((rvol / 4) * 20));
  } else {
    factors.rvol = null;
    factors.rvol_unknown = true;
  }
  score += factors.rvol || 0;

  // volume (0-10): volume >= 5M = full
  const volume = isNum(candidate.volume) ? Number(candidate.volume) : null;
  factors.volume = volume != null ? Math.min(10, Math.round((volume / 5_000_000) * 10)) : 0;
  if (volume == null) factors.volume_unknown = true;
  score += factors.volume;

  // liquidity (0-10): derived from liquidity_rating if present
  const liq = candidate.liquidity_rating;
  factors.liquidity = liq === 'high' ? 10 : liq === 'moderate' ? 6 : liq === 'low' ? 3 : 0;
  if (!liq) factors.liquidity_unknown = true;
  score += factors.liquidity;

  // catalyst quality (0-20): strongest catalyst strength (0-100) scaled to 0-20
  const cs = isNum(candidate.catalyst_strength) ? Number(candidate.catalyst_strength) : null;
  factors.catalyst_strength = cs != null ? Math.min(20, Math.round((cs / 100) * 20)) : 0;
  if (cs == null) factors.catalyst_strength_unknown = true;
  score += factors.catalyst_strength;

  // technical setup (0-10): best setup score (0-100) scaled to 0-10
  const bs = candidate.best_setup && isNum(candidate.best_setup.score) ? Number(candidate.best_setup.score) : null;
  factors.technical_setup = bs != null ? Math.min(10, Math.round((bs / 100) * 10)) : 0;
  if (bs == null) factors.technical_setup_unknown = true;
  score += factors.technical_setup;

  // relative strength (0-10): when provided
  const rs = isNum(candidate.relative_strength) ? Number(candidate.relative_strength) : null;
  factors.relative_strength = rs != null ? Math.min(10, Math.max(0, Math.round(rs))) : 0;
  if (rs == null) factors.relative_strength_unknown = true;
  score += factors.relative_strength;

  return { score: Math.min(100, score), factors };
}

/**
 * Apply price-range / market-cap / gap / rvol / volume / exchange filters to a
 * candidate list. Returns the filtered list (does not mutate inputs).
 */
function applyDiscoveryFilters(candidates, filters = {}) {
  const minPrice = numOrNull(filters.min_price);
  const maxPrice = numOrNull(filters.max_price);
  const minGap = numOrNull(filters.min_gap);
  const maxGap = numOrNull(filters.max_gap);
  const minRvol = numOrNull(filters.min_rvol);
  const minVolume = numOrNull(filters.min_volume);
  const minDollarVolume = numOrNull(filters.min_dollar_volume);
  const maxSpread = numOrNull(filters.max_spread);
  const excludeOtc = String(filters.exclude_otc ?? 'true').toLowerCase() !== 'false';
  const marketCap = filters.market_cap ? String(filters.market_cap).toLowerCase() : null;
  // When min_rvol is set, candidates with UNKNOWN rvol are included by default
  // (discovery mode) so breaking stocks without historical data are not hidden.
  // Set include_unknown_rvol=false to exclude them (stricter validation mode).
  const includeUnknownRvol = String(filters.include_unknown_rvol ?? 'true').toLowerCase() !== 'false';

  return candidates.filter((c) => {
    const price = c.last_price ?? c.indicators?.last_price;
    if (minPrice != null && (price == null || price < minPrice)) return false;
    if (maxPrice != null && (price == null || price > maxPrice)) return false;

    const gap = c.gap_pct ?? c.indicators?.gap_pct;
    if (minGap != null && (gap == null || Math.abs(gap) < minGap)) return false;
    if (maxGap != null && (gap == null || Math.abs(gap) > maxGap)) return false;

    const rvol = c.rvol ?? c.indicators?.rvol;
    if (minRvol != null) {
      if (rvol == null) {
        // UNKNOWN rvol — include by default in discovery mode, exclude in strict mode
        if (!includeUnknownRvol) return false;
      } else if (rvol < minRvol) {
        return false;
      }
    }

    const volume = c.volume ?? c.indicators?.volume;
    if (minVolume != null && (volume == null || volume < minVolume)) return false;

    if (minDollarVolume != null) {
      const dv = (price != null && volume != null) ? price * volume : null;
      if (dv == null || dv < minDollarVolume) return false;
    }

    if (maxSpread != null) {
      const spread = c.indicators?.liquidity?.spread_rating;
      // spread_rating is categorical; numeric spread not always available.
      // Treat 'unknown' as failing when maxSpread set.
      if (spread === 'unknown' || spread == null) return false;
    }

    if (excludeOtc && c.exchange && String(c.exchange).toUpperCase() === 'OTC') return false;

    if (marketCap) {
      const mc = c.fundamental_summary?.market_cap ?? c.market_cap;
      if (mc == null) return false;
      const bounds = MARKET_CAP_BOUNDS[marketCap];
      if (!bounds) return false;
      if (mc < bounds.min || mc >= bounds.max) return false;
    }

    return true;
  });
}

const MARKET_CAP_BOUNDS = {
  micro: { min: 0, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: Infinity }
};

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Standard price-range presets exposed to the frontend.
const PRICE_PRESETS = [
  { id: 'under_5', label: 'Under $5', min_price: 0, max_price: 5 },
  { id: '5_10', label: '$5 - $10', min_price: 5, max_price: 10 },
  { id: '5_20', label: '$5 - $20', min_price: 5, max_price: 20 },
  { id: '10_20', label: '$10 - $20', min_price: 10, max_price: 20 },
  { id: '20_50', label: '$20 - $50', min_price: 20, max_price: 50 },
  { id: '50_100', label: '$50 - $100', min_price: 50, max_price: 100 },
  { id: '100_plus', label: '$100+', min_price: 100, max_price: null }
];

module.exports = { scoreOpportunity, applyDiscoveryFilters, MARKET_CAP_BOUNDS, PRICE_PRESETS };
