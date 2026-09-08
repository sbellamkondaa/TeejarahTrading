/**
 * Market Intelligence admin/ops controller — authenticated, non-secret.
 * Exposes a manual ingestion trigger for ops/backfill. Reuses the existing
 * ingestion service; the Redis lock prevents concurrent duplicate runs.
 */

const asyncHandler = require('../utils/asyncHandler');
const { runIngestionCycle } = require('../services/marketIntelligence/ingestionService');
const { isSchedulerEnabled, SCHEDULER_NAME } = require('../services/marketIntelligence/marketIntelligenceScheduler');
const SchedulerStatusService = require('../services/schedulerStatusService');

// POST /api/market/intelligence/ingest
//   body: { initial?: boolean }
async function triggerIngestion(req, res) {
  const initial = String(req.body && req.body.initial || '').toLowerCase() === 'true';
  const result = await runIngestionCycle({ initial });

  if (result && result.skipped) {
    return res.status(409).json({ skipped: true, reason: result.reason });
  }

  return res.json({
    ok: true,
    initial,
    sources: result.sources,
    items: result.items,
    inserted: result.inserted,
    updated: result.updated,
    deduped: result.deduped,
    corroborated: result.corroborated,
    errors: result.errors,
    sourceReports: result.sourceReports || []
  });
}

// GET /api/market/intelligence/status
async function getStatus(req, res) {
  let schedulerStatus = null;
  try {
    schedulerStatus = await SchedulerStatusService.get(SCHEDULER_NAME);
  } catch { /* non-fatal */ }
  return res.json({
    scheduler_enabled: isSchedulerEnabled(),
    scheduler_status: schedulerStatus
  });
}

module.exports = {
  triggerIngestion: asyncHandler(triggerIngestion),
  getStatus: asyncHandler(getStatus)
};
