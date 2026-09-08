/**
 * X (Twitter) Source — OFFICIAL X API ONLY. Reads recent posts mentioning
 * tracked ticker symbols via the X API v2 recent search endpoint when
 * credentials are configured.
 *
 * DO NOT scrape x.com website HTML. This adapter must fail gracefully and
 * disable itself when no credentials exist, so the news pipeline keeps
 * working without X. Source credentials are NEVER exposed to the frontend.
 *
 * Configuration (read from env, never logged):
 *   X_API_BEARER_TOKEN  — required to enable
 *   X_TRACKED_SYMBOLS   — comma list, default empty
 *
 * All posts are SOCIAL_UNVERIFIED until a primary source corroborates the
 * same dedup_key (handled by the deduplicator).
 */

const { SOURCE_TIERS } = require('../eventTypes');

const NAME = 'x_api';
const TIER = SOURCE_TIERS.SOCIAL_UNVERIFIED;

function isEnabled() {
  return Boolean(process.env.X_API_BEARER_TOKEN) &&
    String(process.env.ENABLE_X_API_SOURCE ?? 'false').toLowerCase() === 'true';
}

function name() { return NAME; }
function sourceTier() { return TIER; }

function health() {
  return {
    enabled: isEnabled(),
    hasCredentials: Boolean(process.env.X_API_BEARER_TOKEN),
    trackedSymbols: (process.env.X_TRACKED_SYMBOLS || '').split(',').filter(Boolean)
  };
}

async function fetchRecent() {
  if (!isEnabled()) return { items: [], fetched: 0 };

  const symbols = (process.env.X_TRACKED_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return { items: [], fetched: 0 };

  // Use the official X API v2 recent search endpoint. Bounded query.
  // The fetch is performed only when enabled + credentialed; otherwise this
  // adapter is a no-op so the rest of the pipeline is unaffected.
  const query = symbols.map((s) => `$${s}`).join(' OR ');
  const url = 'https://api.twitter.com/2/tweets/search/recent?query=' +
    encodeURIComponent(query) + '&max_results=20&tweet.fields=created_at,public_metrics,entities';

  let response;
  try {
    const axios = require('axios');
    response = await axios.get(url, {
      headers: { Authorization: 'Bearer ' + process.env.X_API_BEARER_TOKEN },
      timeout: 10000
    });
  } catch (error) {
    throw new Error('X API fetch failed: ' + (error.response ? error.response.status : error.message));
  }

  const tweets = (response.data && response.data.data) || [];
  const items = [];
  for (const t of tweets) {
    const cashtags = (t.entities && Array.isArray(t.entities.cashtags))
      ? t.entities.cashtags.map((c) => c.tag).filter(Boolean)
      : [];
    if (!cashtags.length) continue;
    items.push({
      source: NAME,
      source_event_id: 'x:' + t.id,
      source_tier: TIER,
      source_url: 'https://x.com/i/web/status/' + t.id,
      published_at: t.created_at || null,
      headline: (t.text || '').slice(0, 280),
      summary: null,
      symbols: cashtags,
      is_primary: false,
      raw_payload: {
        provider: 'x_api',
        author_id: t.author_id || null,
        metrics: t.public_metrics || null
      }
    });
  }

  return { items, fetched: items.length };
}

module.exports = { name, sourceTier, isEnabled, health, fetchRecent };
