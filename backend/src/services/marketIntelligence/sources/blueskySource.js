/**
 * Bluesky Source — reads recent posts from the Bluesky public API (app.bsky)
 * mentioning tracked ticker symbols via the public search endpoint.
 *
 * Uses public read endpoints only; no Jetstream stream required. When the
 * public API is unavailable or disabled by config, this adapter is a no-op so
 * the news pipeline keeps working without it.
 *
 * Configuration:
 *   ENABLE_BLUESKY_SOURCE  — default false (opt-in)
 *   BLUESKY_TRACKED_SYMBOLS — comma list, default empty
 */

const { SOURCE_TIERS } = require('../eventTypes');

const NAME = 'bluesky';
const TIER = SOURCE_TIERS.SOCIAL_UNVERIFIED;

function isEnabled() {
  return String(process.env.ENABLE_BLUESKY_SOURCE ?? 'false').toLowerCase() === 'true';
}

function name() { return NAME; }
function sourceTier() { return TIER; }

function health() {
  return {
    enabled: isEnabled(),
    trackedSymbols: (process.env.BLUESKY_TRACKED_SYMBOLS || '').split(',').filter(Boolean)
  };
}

async function fetchRecent() {
  if (!isEnabled()) return { items: [], fetched: 0 };

  const symbols = (process.env.BLUESKY_TRACKED_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return { items: [], fetched: 0 };

  const items = [];
  for (const symbol of symbols) {
    try {
      const axios = require('axios');
      const url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=' +
        encodeURIComponent('$' + symbol) + '&limit=20';
      const response = await axios.get(url, { timeout: 10000 });
      const posts = (response.data && response.data.posts) || [];
      for (const p of posts) {
        if (!p.uri || !p.record) continue;
        const text = p.record.text || '';
        // Extract $CASHTAGs from text
        const tags = (text.match(/\$([A-Z][A-Z0-9.\-]{0,15})/g) || [])
          .map((m) => m.slice(1));
        items.push({
          source: NAME,
          source_event_id: 'bsky:' + p.uri,
          source_tier: TIER,
          source_url: p.uri,
          published_at: p.record.createdAt || null,
          headline: text.slice(0, 280),
          summary: null,
          symbols: tags.length ? tags : [symbol],
          is_primary: false,
          raw_payload: {
            provider: 'bluesky',
            author: (p.author && p.author.handle) || null,
            likeCount: (p.likeCount) || null
          }
        });
      }
    } catch (error) {
      throw new Error('Bluesky fetch failed for ' + symbol + ': ' + (error.response ? error.response.status : error.message));
    }
  }

  return { items, fetched: items.length };
}

module.exports = { name, sourceTier, isEnabled, health, fetchRecent };
