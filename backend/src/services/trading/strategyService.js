/**
 * Strategy Service
 *
 * Versioned trading strategies. Versioning is explicit: creating a new version
 * of an existing strategy inserts a new row with an incremented version number.
 * The latest version of a strategy is the one with the highest version for
 * a given name.
 */

const db = require('../../config/database');

async function createStrategy({ name, description, config }) {
  const result = await db.query(
    `INSERT INTO trading_strategies (name, version, description, config, status)
     VALUES ($1, 1, $2, $3, 'draft')
     ON CONFLICT (name, version) DO NOTHING
     RETURNING *`,
    [name, description || null, JSON.stringify(config || {})]
  );

  if (result.rows.length === 0) {
    throw new Error(`Strategy "${name}" version 1 already exists`);
  }

  return result.rows[0];
}

async function createNewVersion(name, { description, config }) {
  const latest = await getLatestVersion(name);
  if (!latest) {
    throw new Error(`Strategy "${name}" not found`);
  }

  const newVersion = latest.version + 1;
  const result = await db.query(
    `INSERT INTO trading_strategies (name, version, description, config, status)
     VALUES ($1, $2, $3, $4, 'draft')
     RETURNING *`,
    [name, newVersion, description || latest.description, JSON.stringify(config || latest.config)]
  );

  return result.rows[0];
}

async function getLatestVersion(name) {
  const result = await db.query(
    `SELECT * FROM trading_strategies
     WHERE name = $1
     ORDER BY version DESC
     LIMIT 1`,
    [name]
  );
  return result.rows[0] || null;
}

async function getById(id) {
  const result = await db.query(
    `SELECT * FROM trading_strategies WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function listStrategies({ status, limit = 50 } = {}) {
  const params = [];
  let where = '';

  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }

  params.push(limit);

  const result = await db.query(
    `SELECT * FROM trading_strategies
     ${where}
     ORDER BY name ASC, version DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function updateStatus(id, status) {
  const result = await db.query(
    `UPDATE trading_strategies
     SET status = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [id, status]
  );
  return result.rows[0] || null;
}

module.exports = {
  createStrategy,
  createNewVersion,
  getLatestVersion,
  getById,
  listStrategies,
  updateStatus
};