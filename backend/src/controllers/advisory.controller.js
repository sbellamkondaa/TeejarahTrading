/**
 * AI Advisory Controller — exposes the PAPER-only advisory analysis.
 * AI is never execution authority; this controller only reads deterministic
 * scanner output and market events, then returns labeled advisory output.
 */

const asyncHandler = require('../utils/asyncHandler');
const advisoryService = require('../services/ai/advisoryService');

// POST /api/market/advisory
//   body: { candidates: object[], mode?: 'summary'|'compare'|'critique' }
// Bounded server-side to MAX_CANDIDATES regardless of client input size.
async function analyze(req, res) {
  const candidates = Array.isArray(req.body.candidates) ? req.body.candidates : [];
  const mode = req.body.mode || 'summary';

  const result = await advisoryService.analyze(candidates, { mode });
  return res.json(result);
}

// GET /api/market/advisory/status
async function getStatus(req, res) {
  return res.json({
    enabled: advisoryService.isEnabled(),
    model: advisoryService.isEnabled() ? advisoryService.getModel() : null,
    max_candidates: advisoryService.MAX_CANDIDATES
  });
}

module.exports = {
  analyze: asyncHandler(analyze),
  getStatus: asyncHandler(getStatus)
};
