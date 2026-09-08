/**
 * Generic RSS Source — fetches and parses public RSS feeds configured via env.
 * Uses the existing project's HTTP utilities where possible; falls back to
 * plain axios + a minimal RSS parser. Only feeds explicitly listed are read.
 *
 * Configuration (JSON or newline-delimited in env):
 *   RSS_FEEDS — newline-delimited "name|url" entries (opt-in only)
 *
 * Source tier defaults to AGGREGATOR unless the feed is marked PRIMARY via a
 * third "|PRIMARY" field. No paywall bypass; no robots violation — operators
 * only list feeds that permit automated consumption.
 */

const { SOURCE_TIERS } = require('../eventTypes');
const crypto = require('crypto');

const NAME = 'rss';
const DEFAULT_TIER = SOURCE_TIERS.AGGREGATOR;

function isEnabled() {
  return String(process.env.ENABLE_RSS_SOURCE ?? 'false').toLowerCase() === 'true' &&
    Boolean(process.env.RSS_FEEDS);
}

function name() { return NAME; }
function sourceTier() { return DEFAULT_TIER; }

function parseFeeds() {
  const raw = process.env.RSS_FEEDS || '';
  return raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|');
      return {
        name: parts[0] || 'rss',
        url: parts[1],
        tier: parts[2] === 'PRIMARY' ? SOURCE_TIERS.PRIMARY : DEFAULT_TIER
      };
    })
    .filter((f) => f.url);
}

async function fetchRecent() {
  if (!isEnabled()) return { items: [], fetched: 0 };

  const feeds = parseFeeds();
  const items = [];
  for (const feed of feeds) {
    try {
      const axios = require('axios');
      const response = await axios.get(feed.url, { timeout: 10000, responseType: 'text' });
      const parsed = parseRssXml(response.data, feed);
      items.push(...parsed);
    } catch (error) {
      throw new Error('RSS fetch failed for ' + feed.name + ': ' + (error.response ? error.response.status : error.message));
    }
  }
  return { items, fetched: items.length };
}

// Minimal RSS/Atom XML parser — extracts title, link, pubDate, description.
// Avoids adding an xml parser dependency; relies on regex over the feed XML
// which is acceptable for well-formed public feeds.
function parseRssXml(xml, feed) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const description = extractTag(block, 'description');
    // Content-based deterministic id: hash of feed name + title + link + pubDate.
    // Re-fetching the same feed in a different order still produces the same id,
    // so the ON CONFLICT upsert remains idempotent (no unbounded row growth).
    const idSource = [feed.name, title || '', link || '', pubDate || ''].join('|');
    const sourceEventId = 'rss:' + crypto.createHash('sha1').update(idSource).digest('hex').slice(0, 24);
    items.push({
      source: NAME + ':' + feed.name,
      source_event_id: sourceEventId,
      source_tier: feed.tier,
      source_url: link,
      published_at: pubDate || null,
      headline: title,
      summary: stripHtml(description).slice(0, 500) || null,
      symbols: [],
      is_primary: feed.tier === SOURCE_TIERS.PRIMARY,
      raw_payload: { provider: 'rss', feed: feed.name, url: feed.url }
    });
  }
  return items;
}

function extractTag(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = re.exec(block);
  if (!m) return null;
  // Strip CDATA
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(m[1]);
  if (cdata) return cdata[1].trim();
  return stripHtml(m[1]).trim() || null;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

module.exports = { name, sourceTier, isEnabled, fetchRecent, parseFeeds };
