/**
 * Trading Audit Service
 *
 * Immutable append-only audit log for all trading automation events.
 * Events are never updated or deleted — only inserted.
 */

const db = require('../../config/database');

async function recordEvent(eventType, entityType, entityId, eventData = {}) {
  await db.query(
    `INSERT INTO trading_audit_events (event_type, entity_type, entity_id, event_data)
     VALUES ($1, $2, $3, $4)`,
    [eventType, entityType, entityId, JSON.stringify(eventData)]
  );
}

async function getEventsForEntity(entityType, entityId, limit = 50) {
  const result = await db.query(
    `SELECT id, event_type, event_data, created_at
     FROM trading_audit_events
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [entityType, entityId, limit]
  );
  return result.rows;
}

module.exports = { recordEvent, getEventsForEntity };