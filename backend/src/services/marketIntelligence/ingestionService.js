/**
 * Market Intelligence Ingestion Service
 *
 * Runs a full fetch-normalize-classify-persist cycle across all enabled
 * sources. Reuses sourceRegistry (fetch), eventNormalizer (normalize),
 * eventClassifier (classify), and eventDeduplicator (persist + dedup).
 *
 * Idempotent: re-fetching the same items updates, never duplicates.
 * Source-isolated: a single source failure is recorded, not propagated.
 */

const logger = require('../../utils/logger');
const { normalize } = require('./eventNormalizer');
const { classify } = require('./eventClassifier');
const { upsertBatch, recordSourceHealth } = require('./eventDeduplicator');

/**
 * Run one ingestion cycle. Returns aggregate counts.
 * @returns {Promise<object>}
 */
async function runIngestionCycle() {
  return ingestAll();
}

async function ingestAll() {
  const { getEnabledSources } = require('./sourceRegistry');
  const enabled = getEnabledSources();

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalDeduped = 0;
  let totalCorroborated = 0;
  let totalItems = 0;
  let errorCount = 0;
  const sourceReports = [];

  for (const source of enabled) {
    const started = Date.now();
    let items = [];
    try {
      const res = await source.fetchRecent();
      items = (res && Array.isArray(res.items)) ? res.items : [];
    } catch (error) {
      errorCount++;
      logger.warn('[MARKET-INTEL] source ' + source.name() + ' fetch failed: ' + error.message);
      try {
        await recordSourceErrorSafe(source.name(), error.message, Date.now() - started);
      } catch { /* never propagate */ }
      sourceReports.push({ source: source.name(), fetched: 0, error: error.message });
      continue;
    }

    totalItems += items.length;

    // Normalize + classify
    const records = [];
    for (const raw of items) {
      const rec = normalize(raw);
      if (!rec) continue;
      const cls = classify(rec);
      rec.event_type = cls.event_type;
      rec.materiality = cls.materiality;
      // Verification state: social tiers start UNVERIFIED; primary/high-quality VERIFIED.
      const tier = rec.source_tier;
      if (tier === 'PRIMARY' || tier === 'HIGH_QUALITY_SECONDARY') {
        rec.verification_state = 'VERIFIED';
      } else if (tier === 'SOCIAL_UNVERIFIED' || tier === 'SOCIAL_VERIFIED') {
        rec.verification_state = 'UNVERIFIED';
      } else {
        rec.verification_state = 'UNVERIFIED';
      }
      records.push(rec);
    }

    // Persist + dedup
    let res = { inserted: 0, updated: 0, deduped: 0, corroborated: 0 };
    try {
      res = await upsertBatch(records);
      totalInserted += res.inserted;
      totalUpdated += res.updated;
      totalDeduped += res.deduped;
      totalCorroborated += res.corroborated;
    } catch (error) {
      errorCount++;
      logger.warn('[MARKET-INTEL] persist failed for ' + source.name() + ': ' + error.message);
    }

    try {
      await recordSourceHealth(source.name(), {
        fetched: items.length,
        inserted: res.inserted,
        deduped: res.deduped
      });
    } catch (e) { /* never propagate health errors */ }

    sourceReports.push({
      source: source.name(),
      fetched: items.length,
      inserted: res.inserted,
      deduped: res.deduped,
      durationMs: Date.now() - started
    });
  }

  return {
    sources: enabled.length,
    items: totalItems,
    inserted: totalInserted,
    updated: totalUpdated,
    deduped: totalDeduped,
    corroborated: totalCorroborated,
    errors: errorCount,
    sourceReports
  };
}

async function recordSourceErrorSafe(source, message, durationMs) {
  const { recordSourceError } = require('./eventDeduplicator');
  await recordSourceError(source, message, durationMs);
}

module.exports = { runIngestionCycle, ingestAll };
