/**
 * Finnhub News Source — reuses the existing finnhub client to fetch recent
 * company news for a bounded watchlist of broad-market symbols + any symbols
 * recently surfaced by the scanner. Returns raw items for the ingestion
 * pipeline.
 *
 * Does NOT duplicate the Finnhub caching layer (already 15-min TTL).
 * Bounded: at most ~12 symbols per fetch to keep API usage low.
 */

const finnhub = require('../../../utils/finnhub');
const { SOURCE_TIERS } = require('../eventTypes');

const NAME = 'finnhub_news';
const TIER = SOURCE_TIERS.AGGREGATOR;

// Broad-market symbols polled for general news. The ingestion pipeline
// dedups across symbols, so duplicates from overlapping coverage are fine.
const WATCH_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL'];

function isEnabled() {
  return String(process.env.ENABLE_FINNHUB_NEWS_SOURCE ?? 'true').toLowerCase() === 'true';
}

function name() { return NAME; }
function sourceTier() { return TIER; }

async function fetchRecent(options = {}) {
  if (!isEnabled()) return { items: [], fetched: 0 };

  const to = new Date().toISOString().split('T')[0];
  // Initial/backfill cycle uses a larger lookback (default 72h); normal cycles
  // use 2 days to keep API usage low.
  let lookbackDays = 2;
  if (options.initial) {
    const raw = parseInt(process.env.MARKET_INTELLIGENCE_INITIAL_LOOKBACK_HOURS || '', 10);
    const hours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 720) : 72;
    lookbackDays = Math.max(2, Math.ceil(hours / 24));
  }
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const items = [];
  for (const symbol of WATCH_SYMBOLS) {
    try {
      const news = await finnhub.getCompanyNews(symbol, from, to);
      if (!Array.isArray(news)) continue;
      for (const n of news) {
        if (!n || n.id == null) continue;
        const related = (typeof n.related === 'string' && n.related.trim())
          ? n.related.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
        items.push({
          source: NAME,
          source_event_id: String(n.id),
          source_tier: TIER,
          source_url: n.url || null,
          published_at: n.datetime || null,
          headline: n.headline || null,
          summary: n.summary || null,
          symbols: [symbol, ...related],
          is_primary: false,
          raw_payload: {
            provider: 'finnhub',
            image: n.image || null,
            source_name: n.source || null
          }
        });
      }
    } catch (error) {
      // Per-symbol isolation: a single symbol failure does not abort the cycle.
      console.warn('[FINNHUB-NEWS-SOURCE] ' + symbol + ' failed: ' + error.message);
    }
  }

  return { items, fetched: items.length };
}

module.exports = { name, sourceTier, isEnabled, fetchRecent };
