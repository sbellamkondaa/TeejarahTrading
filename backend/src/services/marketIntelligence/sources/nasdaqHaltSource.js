/**
 * Nasdaq Halt Source — reads recently-ingested trading halts from the existing
 * market_halts table (populated by nasdaqHaltScheduler) and projects them into
 * the market_events store. Does NOT duplicate the RSS fetch/parse logic.
 */

const db = require('../../../config/database');
const { SOURCE_TIERS } = require('../eventTypes');

const NAME = 'nasdaq_halts';
const TIER = SOURCE_TIERS.PRIMARY;
const DEFAULT_LOOKBACK_HOURS = 24;

function getLookbackHours() {
  const raw = parseInt(process.env.MARKET_INTELLIGENCE_INITIAL_LOOKBACK_HOURS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LOOKBACK_HOURS;
  return Math.min(raw, 720);
}

function isEnabled() {
  return String(process.env.ENABLE_NASDAQ_HALT_SOURCE ?? 'true').toLowerCase() === 'true';
}

function name() { return NAME; }
function sourceTier() { return TIER; }

async function fetchRecent(options = {}) {
  if (!isEnabled()) return { items: [], fetched: 0 };

  const lookback = options.initial ? getLookbackHours() : DEFAULT_LOOKBACK_HOURS;

  const result = await db.query(
    `SELECT symbol, halt_type, reason, exchange, halted_at, resume_at, is_resumption
     FROM market_halts
     WHERE halted_at >= NOW() - make_interval($1::int)
     ORDER BY halted_at DESC
     LIMIT 500`,
    [lookback]
  );

  const items = [];
  for (const row of result.rows) {
    const sourceEventId = `halt:${row.symbol}:${row.halted_at}:${row.is_resumption ? 'r' : 'h'}`;
    items.push({
      source: NAME,
      source_event_id: sourceEventId,
      source_tier: TIER,
      source_url: null,
      published_at: row.halted_at,
      headline: `${row.symbol} ${row.is_resumption ? 'resumed' : 'halted'} (${row.halt_type})`,
      summary: row.reason || null,
      halt_type: row.halt_type,
      is_resumption: Boolean(row.is_resumption),
      symbols: [row.symbol],
      is_primary: true,
      raw_payload: {
        exchange: row.exchange,
        reason: row.reason
      }
    });
  }

  return { items, fetched: items.length };
}

module.exports = { name, sourceTier, isEnabled, fetchRecent };
