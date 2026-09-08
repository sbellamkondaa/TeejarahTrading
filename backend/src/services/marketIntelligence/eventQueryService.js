/**
 * Market Event Query Service
 *
 * Reads persisted market_events with cursor pagination and filters:
 *  - date range (preset: today, 1h, 4h, 24h, 7d, custom from/to)
 *  - symbol
 *  - free-text headline search (ILIKE, bounded)
 *  - source
 *  - event_type
 *  - min_materiality
 *  - source_tier
 *  - catalyst_only (only CATALYST_EVENT_TYPES)
 *  - scanner_symbols_only (only events linked to a provided symbol set)
 *  - verification_state
 *
 * Never loads entire history. Returns a cursor (published_at, id) for the next
 * page. Stable ordering: published_at DESC, id DESC.
 */

const db = require('../../config/database');

const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 25;

const PRESETS = {
  today: '1d',
  '1h': '1h',
  '4h': '4h',
  '24h': '24h',
  '7d': '7d'
};

const CATALYST_EVENT_TYPES = new Set([
  'EARNINGS', 'GUIDANCE', 'FDA', 'CLINICAL_TRIAL', 'SEC_MATERIAL', 'OFFERING',
  'ATM', 'S3', '424B5', 'DILUTION', 'MERGER_ACQUISITION', 'CONTRACT',
  'PARTNERSHIP', 'ANALYST_UPGRADE', 'ANALYST_DOWNGRADE', 'PRICE_TARGET',
  'INSIDER', 'HALT', 'RESUMPTION'
]);

function parsePageSize(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(n, PAGE_SIZE_MAX);
}

function parseDateRange(query) {
  // Explicit from/to take precedence; preset overrides default window.
  const from = query.from ? parseDate(query.from) : null;
  const to = query.to ? parseDate(query.to, true) : null;

  if (from || to) return { from, to };

  const preset = String(query.preset || '24h').toLowerCase();
  const now = new Date();
  switch (preset) {
    case '1h': return { from: new Date(now.getTime() - 3600000), to: null };
    case '4h': return { from: new Date(now.getTime() - 4 * 3600000), to: null };
    case 'today': return { from: startOfToday(), to: null };
    case '7d': return { from: new Date(now.getTime() - 7 * 24 * 3600000), to: null };
    case '24h':
    default: return { from: new Date(now.getTime() - 24 * 3600000), to: null };
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'));
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Query events with filters and cursor pagination.
 * @param {object} opts
 * @returns {Promise<{ events: object[], next_cursor: string|null, count: number }>}
 */
async function queryEvents(opts = {}) {
  const pageSize = parsePageSize(opts.page_size);
  const { from, to } = parseDateRange(opts);

  const conditions = [];
  const params = [];
  let pi = 0;

  if (from) {
    params.push(from.toISOString());
    conditions.push(`published_at >= $${++pi}`);
  }
  if (to) {
    params.push(to.toISOString());
    conditions.push(`published_at <= $${++pi}`);
  }

  const symbol = (opts.symbol || '').trim().toUpperCase();
  if (symbol) {
    params.push(symbol);
    conditions.push(`id IN (SELECT market_event_id FROM market_event_symbols WHERE symbol = $${++pi})`);
  }

  const source = (opts.source || '').trim();
  if (source) {
    params.push(source);
    conditions.push(`source = $${++pi}`);
  }

  const eventType = (opts.event_type || '').trim().toUpperCase();
  if (eventType) {
    params.push(eventType);
    conditions.push(`event_type = $${++pi}`);
  }

  const sourceTier = (opts.source_tier || '').trim().toUpperCase();
  if (sourceTier) {
    params.push(sourceTier);
    conditions.push(`source_tier = $${++pi}`);
  }

  const verificationState = (opts.verification_state || '').trim().toUpperCase();
  if (verificationState) {
    params.push(verificationState);
    conditions.push(`verification_state = $${++pi}`);
  }

  const minMateriality = parseInt(opts.min_materiality, 10);
  if (Number.isFinite(minMateriality) && minMateriality > 0) {
    params.push(minMateriality);
    conditions.push(`materiality >= $${++pi}`);
  }

  if (String(opts.catalyst_only || '').toLowerCase() === 'true') {
    const list = Array.from(CATALYST_EVENT_TYPES).map((_, i) => `$${++pi}`).join(',');
    params.push(...CATALYST_EVENT_TYPES);
    conditions.push(`event_type IN (${list})`);
  }

  const scannerSymbols = Array.isArray(opts.scanner_symbols)
    ? opts.scanner_symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : null;
  if (scannerSymbols && scannerSymbols.length) {
    params.push(scannerSymbols);
    conditions.push(`id IN (SELECT market_event_id FROM market_event_symbols WHERE symbol = ANY($${++pi}::text[]))`);
  }

  const headlineQuery = (opts.q || '').trim();
  if (headlineQuery) {
    params.push('%' + headlineQuery.replace(/[%_]/g, '\\$&') + '%');
    conditions.push(`headline ILIKE $${++pi}`);
  }

  // Cursor pagination: cursor = "published_at_iso|id"
  const cursor = opts.cursor || null;
  if (cursor) {
    const [curTs, curId] = cursor.split('|');
    const ts = curTs ? new Date(curTs) : null;
    if (ts && Number.isFinite(ts.getTime()) && curId) {
      params.push(ts.toISOString());
      params.push(curId);
      conditions.push(`(published_at, id) < ($${++pi}, $${++pi})`);
    }
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Fetch one extra to determine next_cursor existence
  params.push(pageSize + 1);
  const limitIdx = ++pi;

  const result = await db.query(
    `SELECT
       id, source, source_event_id, source_url, source_tier, published_at,
       headline, summary, event_type, materiality, verification_state,
       primary_source, dedup_key, canonical_event_id, created_at
     FROM market_events
     ${where}
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT $${limitIdx}`,
    params
  );

  const rows = result.rows;
  let nextCursor = null;
  if (rows.length > pageSize) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) {
      nextCursor = (last.published_at ? new Date(last.published_at).toISOString() : '') + '|' + last.id;
    }
  }

  // Attach symbols per event (batched)
  const ids = rows.map((r) => r.id);
  let symbolsByEvent = {};
  if (ids.length) {
    const symRes = await db.query(
      `SELECT market_event_id, symbol FROM market_event_symbols WHERE market_event_id = ANY($1::text[])`,
      [ids]
    );
    for (const row of symRes.rows) {
      if (!symbolsByEvent[row.market_event_id]) symbolsByEvent[row.market_event_id] = [];
      symbolsByEvent[row.market_event_id].push(row.symbol);
    }
  }

  const events = rows.map((r) => ({
    id: r.id,
    source: r.source,
    source_tier: r.source_tier,
    source_url: r.source_url,
    published_at: r.published_at,
    headline: r.headline,
    summary: r.summary,
    event_type: r.event_type,
    materiality: r.materiality,
    verification_state: r.verification_state,
    primary_source: r.primary_source,
    canonical_event_id: r.canonical_event_id,
    symbols: symbolsByEvent[r.id] || []
  }));

  return { events, next_cursor: nextCursor, count: events.length };
}

/**
 * Fetch recent events for a single symbol (for the workstation panel).
 */
async function getEventsForSymbol(symbol, limit = 20) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return [];
  const n = Math.min(parseInt(limit, 10) || 20, PAGE_SIZE_MAX);
  const result = await db.query(
    `SELECT
       me.id, me.source, me.source_tier, me.source_url, me.published_at,
       me.headline, me.summary, me.event_type, me.materiality,
       me.verification_state, me.primary_source
     FROM market_events me
     JOIN market_event_symbols mes ON mes.market_event_id = me.id
     WHERE mes.symbol = $1
       AND me.published_at >= NOW() - INTERVAL '7 days'
     ORDER BY me.published_at DESC NULLS LAST
     LIMIT $2`,
    [sym, n]
  );
  return result.rows.map((r) => ({
    id: r.id,
    source: r.source,
    source_tier: r.source_tier,
    source_url: r.source_url,
    published_at: r.published_at,
    headline: r.headline,
    summary: r.summary,
    event_type: r.event_type,
    materiality: r.materiality,
    verification_state: r.verification_state,
    primary_source: r.primary_source
  }));
}

module.exports = { queryEvents, getEventsForSymbol, CATALYST_EVENT_TYPES, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX };
