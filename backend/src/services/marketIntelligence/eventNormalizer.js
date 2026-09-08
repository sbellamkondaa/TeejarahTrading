/**
 * Event Normalizer — converts raw source payloads into a canonical event record
 * shape suitable for persistence and classification.
 *
 * Each source adapter produces an array of raw items; the normalizer ensures a
 * consistent schema, derives the dedup_key, and resolves symbols.
 */

const crypto = require('crypto');

/**
 * Normalize a raw source item into a canonical record.
 * Expected raw fields vary by source; the normalizer is tolerant of missing
 * optional fields but requires a source + source_event_id.
 *
 * @param {object} raw
 * @param {string} raw.source            adapter name (e.g. 'finnhub_news')
 * @param {string} raw.source_event_id   stable id from the source
 * @param {string} [raw.source_tier]     SOURCE_TIERS value
 * @param {string} [raw.source_url]
 * @param {Date|string|number} [raw.published_at]
 * @param {string} [raw.headline]
 * @param {string} [raw.summary]
 * @param {string} [raw.sec_form_type]
 * @param {string} [raw.halt_type]
 * @param {boolean} [raw.is_resumption]
 * @param {boolean} [raw.is_primary]
 * @param {string[]} [raw.symbols]
 * @param {string[]} [raw.related]       Finnhub "related" tickers
 * @param {object} [raw.raw_payload]
 * @returns {object} normalized record (without dedup_key if symbols missing)
 */
function normalize(raw) {
  if (!raw || !raw.source || !raw.source_event_id) return null;

  const publishedAt = toIsoOrNull(raw.published_at);
  const symbols = collectSymbols(raw);

  return {
    source: raw.source,
    source_event_id: String(raw.source_event_id),
    source_url: raw.source_url || null,
    source_tier: raw.source_tier || 'AGGREGATOR',
    published_at: publishedAt,
    headline: raw.headline || null,
    summary: raw.summary || null,
    sec_form_type: raw.sec_form_type || null,
    halt_type: raw.halt_type || null,
    is_resumption: Boolean(raw.is_resumption),
    primary_source: Boolean(raw.is_primary),
    symbols,
    raw_payload: raw.raw_payload || {},
    dedup_key: buildDedupKey(raw, symbols)
  };
}

function collectSymbols(raw) {
  const out = new Set();
  if (Array.isArray(raw.symbols)) {
    for (const s of raw.symbols) {
      const t = toTicker(s);
      if (t) out.add(t);
    }
  }
  if (Array.isArray(raw.related)) {
    for (const s of raw.related) {
      const t = toTicker(s);
      if (t) out.add(t);
    }
  }
  return Array.from(out);
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,15}$/;

// Pure index/macro tokens that are NOT tradeable equities (excluded from events).
const NON_TRADEABLE_TOKENS = new Set(['VIX', 'COMPX', 'DJI', 'SPX', 'TNX', 'VXN']);

function toTicker(value) {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase().replace(/^\$/, '');
  if (!s) return null;
  if (!TICKER_RE.test(s)) return null;
  // Skip pure index/macro tokens; keep tradeable ETFs.
  if (NON_TRADEABLE_TOKENS.has(s)) return null;
  return s;
}

/**
 * Build a deduplication key. Prefer: lowercase headline + sorted first symbol.
 * Falls back to source + source_event_id when headline/symbols are absent.
 */
function buildDedupKey(raw, symbols) {
  const headline = (raw.headline || '').trim().toLowerCase();
  if (headline && symbols.length) {
    const sym = symbols.slice().sort().slice(0, 3).join(',');
    return crypto.createHash('sha1').update(`${headline}|${sym}`).digest('hex').slice(0, 24);
  }
  if (headline) {
    return crypto.createHash('sha1').update(headline).digest('hex').slice(0, 24);
  }
  return crypto.createHash('sha1').update(`${raw.source}|${raw.source_event_id}`).digest('hex').slice(0, 24);
}

function toIsoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'number') {
    // Finnhub returns unix seconds; detect seconds vs ms heuristically
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

module.exports = { normalize, collectSymbols, toTicker, buildDedupKey };
