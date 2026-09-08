/**
 * Event Deduplicator — persists normalized events idempotently and links
 * secondary/corroboration reports to a canonical primary event.
 *
 * Strategy:
 *  - INSERT ... ON CONFLICT (source, source_event_id) DO UPDATE for idempotency
 *    per source (a re-fetch of the same item updates, not duplicates).
 *  - Dedup by dedup_key across sources: the first event seen for a dedup_key
 *    becomes canonical; later events with the same dedup_key are stored
 *    separately (to preserve source evidence) but reference canonical_event_id.
 *  - Primary-source preference: when a PRIMARY/HIGH_QUALITY_SECONDARY event
 *    arrives for an existing dedup_key whose canonical is a lower tier, the
 *    primary becomes canonical and the older record is repointed.
 *  - Social sources default to UNVERIFIED; a later primary/high-quality event
 *    sharing the dedup_key upgrades the social event to CORROBORATED.
 */

const db = require('../../config/database');

const TIER_RANK = {
  PRIMARY: 5,
  HIGH_QUALITY_SECONDARY: 4,
  AGGREGATOR: 3,
  SOCIAL_VERIFIED: 2,
  SOCIAL_UNVERIFIED: 1,
  OPINION: 0
};

/**
 * Upsert a batch of normalized event records. Returns counts.
 * @param {object[]} records normalized records (from eventNormalizer)
 * @returns {Promise<{inserted:number, updated:number, deduped:number, corroborated:number}>}
 */
async function upsertBatch(records) {
  let inserted = 0;
  let updated = 0;
  let deduped = 0;
  let corroborated = 0;

  if (!Array.isArray(records) || records.length === 0) {
    return { inserted, updated, deduped, corroborated };
  }

  for (const r of records) {
    if (!r || !r.source || !r.source_event_id) continue;
    const result = await upsertOne(r);
    if (result.inserted) inserted++;
    else if (result.updated) updated++;
    if (result.deduped) deduped++;
    if (result.corroborated) corroborated++;
  }

  return { inserted, updated, deduped, corroborated };
}

async function upsertOne(record) {
  const res = await db.query(
    `INSERT INTO market_events
       (source, source_event_id, source_url, source_tier, published_at,
        headline, summary, event_type, materiality, verification_state,
        primary_source, raw_payload, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (source, source_event_id) DO UPDATE
     SET updated_at = CURRENT_TIMESTAMP,
         headline = COALESCE(EXCLUDED.headline, market_events.headline),
         summary = COALESCE(EXCLUDED.summary, market_events.summary)
     RETURNING id, (xmax = 0) AS was_inserted`,
    [
      record.source,
      record.source_event_id,
      record.source_url,
      record.source_tier,
      record.published_at,
      record.headline,
      record.summary,
      record.event_type,
      record.materiality,
      record.verification_state,
      record.primary_source,
      JSON.stringify(record.raw_payload || {}),
      record.dedup_key
    ]
  );

  const row = res.rows[0];
  const eventId = row.id;
  const wasInserted = row.was_inserted;

  // Insert symbol links
  if (Array.isArray(record.symbols) && record.symbols.length) {
    await db.query(
      `INSERT INTO market_event_symbols (market_event_id, symbol)
       VALUES ${record.symbols.map((_, i) => `($1, $${i + 2})`).join(', ')}
       ON CONFLICT (market_event_id, symbol) DO NOTHING`,
      [eventId, ...record.symbols]
    );
  }

  // Dedup linking: find any other event with the same dedup_key
  let deduped = false;
  let corroborated = false;
  if (record.dedup_key) {
    const existing = await db.query(
      `SELECT id, source_tier, verification_state, canonical_event_id
       FROM market_events
       WHERE dedup_key = $1 AND id <> $2
       ORDER BY published_at ASC NULLS LAST
       LIMIT 1`,
      [record.dedup_key, eventId]
    );

    if (existing.rows.length) {
      deduped = true;
      const canonical = existing.rows[0];
      const newRank = TIER_RANK[record.source_tier] ?? 0;
      const canonicalRank = TIER_RANK[canonical.source_tier] ?? 0;

      if (newRank > canonicalRank) {
        // New event is higher-trust; it becomes canonical, old repoints to it.
        await db.query(
          `UPDATE market_events SET canonical_event_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [eventId, canonical.id]
        );
        // Point the new event's canonical_event_id to NULL (it is the canonical)
        await db.query(
          `UPDATE market_events SET canonical_event_id = NULL WHERE id = $1`,
          [eventId]
        );
      } else {
        // Existing remains canonical; new event references it.
        await db.query(
          `UPDATE market_events SET canonical_event_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [canonical.id, eventId]
        );
        // If the new event is a primary/high-quality source and the canonical
        // was social/unverified, upgrade the canonical's verification state.
        if (newRank >= 4 && (canonical.verification_state === 'UNVERIFIED')) {
          corroborated = true;
          await db.query(
            `UPDATE market_events SET verification_state = 'CORROBORATED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [canonical.id]
          );
        }
      }
    }
  }

  return { inserted: wasInserted, updated: !wasInserted, deduped, corroborated };
}

/**
 * Record source health metrics.
 */
async function recordSourceHealth(source, result) {
  await db.query(
    `INSERT INTO market_event_source_health
       (source, last_success_at, fetched_count, inserted_count, dedup_count, updated_at)
     VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (source) DO UPDATE
     SET last_success_at = CURRENT_TIMESTAMP,
         fetched_count = market_event_source_health.fetched_count + EXCLUDED.fetched_count,
         inserted_count = market_event_source_health.inserted_count + EXCLUDED.inserted_count,
         dedup_count = market_event_source_health.dedup_count + EXCLUDED.dedup_count,
         updated_at = CURRENT_TIMESTAMP`,
    [source, result.fetched || 0, result.inserted || 0, result.deduped || 0]
  );
}

async function recordSourceError(source, error, durationMs) {
  await db.query(
    `INSERT INTO market_event_source_health (source, last_error_at, last_error, last_fetch_duration_ms, updated_at)
     VALUES ($1, CURRENT_TIMESTAMP, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (source) DO UPDATE
     SET last_error_at = CURRENT_TIMESTAMP,
         last_error = EXCLUDED.last_error,
         last_fetch_duration_ms = EXCLUDED.last_fetch_duration_ms,
         updated_at = CURRENT_TIMESTAMP`,
    [source, String(error).slice(0, 1000), durationMs ?? null]
  );
}

module.exports = { upsertBatch, recordSourceHealth, recordSourceError, TIER_RANK };
