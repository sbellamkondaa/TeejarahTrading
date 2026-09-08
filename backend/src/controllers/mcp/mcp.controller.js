/**
 * MCP Controller — exposes the Teejarah MCP sandbox server over HTTP.
 * Auth-gated (reuses the existing authenticate middleware). Bound internally
 * by default; not exposed publicly. PAPER-only; no live order tools.
 */

const asyncHandler = require('../../utils/asyncHandler');
const mcp = require('../../services/mcp/teejarahMcpServer');

// GET /api/mcp/tools — list registered tools + schemas
async function listTools(req, res) {
  return res.json({
    tools: mcp.listTools(),
    live_order_tool_registered: mcp.isLiveOrderToolRegistered(),
    paper_only: true
  });
}

// POST /api/mcp/invoke — invoke a tool by name
//   body: { name: string, args: object }
async function invoke(req, res) {
  const name = req.body && req.body.name;
  const args = (req.body && req.body.args) || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Tool name required' });
  }
  // Hard deny any live-order tool name, even if somehow invoked.
  if (/^(place_live_order|cancel_live_order|approve_live_order)$/i.test(name)) {
    return res.status(403).json({ error: 'Live order tools are disabled in Teejarah MCP', code: 'LIVE_TOOL_DISABLED' });
  }
  try {
    const result = await mcp.invokeTool(name, args);
    return res.json({ result });
  } catch (error) {
    const status = error.code === 'UNKNOWN_TOOL' ? 404 : 500;
    return res.status(status).json({ error: error.message, code: error.code || 'TOOL_ERROR' });
  }
}

module.exports = {
  listTools: asyncHandler(listTools),
  invoke: asyncHandler(invoke)
};
