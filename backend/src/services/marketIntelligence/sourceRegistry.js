/**
 * Source Registry — registers all MarketEventSource adapters and runs a fetch
 * cycle, isolating each source's failures so a broken X/social source never
 * breaks the scanner or news page.
 *
 * Each adapter implements:
 *   name()             -> string
 *   sourceTier()       -> SOURCE_TIERS value
 *   isEnabled()        -> boolean (graceful disable when credentials absent)
 *   fetchRecent()      -> Promise<{ items: normalized-raw[], fetched: number }>
 *   health()           -> { enabled, lastError, ... }
 *
 * Adapters return *raw* items; the ingestion service normalizes + classifies +
 * dedups + persists. Adapters must NOT touch the database directly.
 */

const logger = require('../../utils/logger');

const finnhubNewsSource = require('./sources/finnhubNewsSource');
const secEventSource = require('./sources/secEventSource');
const nasdaqHaltSource = require('./sources/nasdaqHaltSource');
const xApiSource = require('./sources/xApiSource');
const blueskySource = require('./sources/blueskySource');
const rssSource = require('./sources/rssSource');

const SOURCES = [
  finnhubNewsSource,
  secEventSource,
  nasdaqHaltSource,
  xApiSource,
  blueskySource,
  rssSource
];

function getEnabledSources() {
  return SOURCES.filter((s) => {
    try {
      return s.isEnabled();
    } catch {
      return false;
    }
  });
}

function listSources() {
  return SOURCES.map((s) => {
    try {
      return {
        name: s.name(),
        source_tier: s.sourceTier(),
        enabled: s.isEnabled(),
        health: s.health ? s.health() : null
      };
    } catch {
      return { name: s.name(), source_tier: 'AGGREGATOR', enabled: false, health: null };
    }
  });
}

/**
 * Run a fetch cycle across all enabled sources. Each source is isolated: a
 * throw/rejection is caught and recorded, never propagating to the caller.
 * @returns {Promise<{ results: object[], totalItems: number, errors: object[] }>}
 */
async function fetchAll() {
  const enabled = getEnabledSources();
  const results = [];
  const errors = [];
  let totalItems = 0;

  for (const source of enabled) {
    const started = Date.now();
    try {
      const res = await source.fetchRecent();
      const items = (res && Array.isArray(res.items)) ? res.items : [];
      totalItems += items.length;
      results.push({
        source: source.name(),
        tier: source.sourceTier(),
        fetched: items.length,
        durationMs: Date.now() - started
      });
    } catch (error) {
      errors.push({ source: source.name(), error: error.message });
      logger.warn('[MARKET-INTEL] source ' + source.name() + ' failed: ' + error.message);
      try {
        const { recordSourceError } = require('./eventDeduplicator');
        await recordSourceError(source.name(), error.message, Date.now() - started);
      } catch (e) { /* never propagate health errors */ }
    }
  }

  return { results, totalItems, errors };
}

module.exports = { SOURCES, getEnabledSources, listSources, fetchAll };
