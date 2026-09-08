/**
 * Scanner Universe Snapshot Service
 *
 * Persists the latest mover/scanner universe per session so the scanner can
 * serve a fallback candidate set when Schwab movers returns empty (closed,
 * after-hours, overnight, weekends). Current prices are ALWAYS re-fetched
 * live — the persisted snapshot is for candidate DISCOVERY only, never for
 * serving stale prices.
 *
 * Snapshot sources (in priority order for fallback):
 *  1. latest persisted scanner/movers snapshot
 *  2. symbols with fresh HIGH/MEDIUM market events/catalysts (today + 24h)
 *  3. symbols from today's persisted market events
 *
 * The fallback universe is deduplicated and bounded. The caller refreshes
 * current quotes/candles for those symbols before scanning; if no current
 * quote is available, the candidate is marked STALE/UNKNOWN rather than
 * given a fabricated score.
 */

const db = require('../../config/database');

const MAX_FALLBACK_SYMBOLS = 100;

/**
 * Persist a snapshot of the current mover universe.
 * @param {string} session - premarket|regular|after_hours|closed
 * @param {string[]} symbols - mover symbols
 * @param {object} [metadata] - source metadata (e.g. { source: 'schwab', indices: [...] })
 */
async function captureSnapshot(session, symbols, metadata = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const cleanSymbols = symbols
    .map((s) => String(s || '').toUpperCase().trim())
    .filter(Boolean)
    .slice(0, MAX_FALLBACK_SYMBOLS);
  if (cleanSymbols.length === 0) return;

  await db.query(
    `INSERT INTO scanner_universe_snapshots (session, source, symbols, metadata)
     VALUES ($1, $2, $3, $4)`,
    [session || 'regular', metadata.source || 'schwab', cleanSymbols, JSON.stringify(metadata)]
  ).catch(() => { /* non-fatal: snapshot capture never blocks the scan */ });
}

/**
 * Get the latest persisted snapshot for a session (or any session).
 * @param {string} [session] - optional session filter
 * @returns {Promise<{symbols: string[], captured_at: string, session: string, source: string}|null>}
 */
async function getLatestSnapshot(session = null) {
  try {
    const result = session
      ? await db.query(
          `SELECT symbols, captured_at, session, source FROM scanner_universe_snapshots
           WHERE session = $1 ORDER BY captured_at DESC LIMIT 1`,
          [session]
        )
      : await db.query(
          `SELECT symbols, captured_at, session, source FROM scanner_universe_snapshots
           ORDER BY captured_at DESC LIMIT 1`
        );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      symbols: row.symbols || [],
      captured_at: row.captured_at,
      session: row.session,
      source: row.source
    };
  } catch {
    return null;
  }
}

/**
 * Get symbols with fresh HIGH/MEDIUM materiality market events (last 24h).
 * Used to augment the fallback universe with catalyst-driven candidates.
 * @returns {Promise<string[]>}
 */
async function getRecentEventSymbols() {
  try {
    const result = await db.query(
      `SELECT DISTINCT mes.symbol
       FROM market_event_symbols mes
       JOIN market_events me ON me.id = mes.market_event_id
       WHERE me.published_at >= NOW() - INTERVAL '24 hours'
         AND me.materiality >= 6
       LIMIT 50`
    );
    return result.rows.map((r) => r.symbol).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build a fallback universe when Schwab movers returns empty.
 * Combines latest snapshot + recent event symbols. Deduplicates + bounds.
 * @param {string} [session] - preferred session for the snapshot
 * @returns {Promise<{symbols: string[], universe_source: string, universe_as_of: string|null}>}
 */
async function buildFallbackUniverse(session = null) {
  const sources = [];

  // 1. Latest persisted snapshot (prefer the requested session, else any)
  let snapshot = await getLatestSnapshot(session);
  if (!snapshot || !snapshot.symbols.length) {
    snapshot = await getLatestSnapshot(null);
  }
  if (snapshot && snapshot.symbols.length) {
    sources.push(...snapshot.symbols);
  }

  // 2. Symbols with fresh HIGH/MEDIUM events
  const eventSymbols = await getRecentEventSymbols();
  sources.push(...eventSymbols);

  // Deduplicate + bound
  const seen = new Set();
  const symbols = [];
  for (const s of sources) {
    const t = String(s || '').toUpperCase().trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    symbols.push(t);
    if (symbols.length >= MAX_FALLBACK_SYMBOLS) break;
  }

  let universeSource = 'none';
  if (snapshot && snapshot.symbols.length && eventSymbols.length) {
    universeSource = 'mixed_fallback';
  } else if (snapshot && snapshot.symbols.length) {
    universeSource = 'persisted_snapshot';
  } else if (eventSymbols.length) {
    universeSource = 'recent_events';
  }

  return {
    symbols,
    universe_source: universeSource,
    universe_as_of: snapshot ? snapshot.captured_at : null
  };
}

module.exports = {
  captureSnapshot,
  getLatestSnapshot,
  getRecentEventSymbols,
  buildFallbackUniverse,
  MAX_FALLBACK_SYMBOLS
};
