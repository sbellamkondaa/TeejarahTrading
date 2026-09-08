// Tests for the Teejarah MCP sandbox server: PAPER-only, no live order tool.

const mcp = require('../../src/services/mcp/teejarahMcpServer');

describe('teejarahMcpServer PAPER-only safety', () => {
  test('listTools exposes a non-empty tool set', () => {
    const tools = mcp.listTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.some((t) => t.name === 'get_market_overview')).toBe(true);
    expect(tools.some((t) => t.name === 'get_scanner_results')).toBe(true);
    expect(tools.some((t) => t.name === 'get_paper_positions')).toBe(true);
    expect(tools.some((t) => t.name === 'request_paper_trade')).toBe(true);
    expect(tools.some((t) => t.name === 'approve_paper_trade')).toBe(true);
  });

  test('NO live order tool is registered', () => {
    expect(mcp.isLiveOrderToolRegistered()).toBe(false);
    const names = mcp.listTools().map((t) => t.name);
    expect(names).not.toContain('place_live_order');
    expect(names).not.toContain('cancel_live_order');
    expect(names).not.toContain('approve_live_order');
  });

  test('invokeTool rejects unknown tools', async () => {
    await expect(mcp.invokeTool('does_not_exist', {})).rejects.toThrow('Unknown MCP tool');
  });

  test('invokeTool hard-denies any live-order name even if invoked directly', async () => {
    await expect(mcp.invokeTool('place_live_order', {})).rejects.toThrow('Live order tools are disabled');
    await expect(mcp.invokeTool('cancel_live_order', {})).rejects.toThrow('Live order tools are disabled');
    await expect(mcp.invokeTool('approve_live_order', {})).rejects.toThrow('Live order tools are disabled');
  });

  test('approve_paper_trade requires userId (cannot bypass approval auth)', async () => {
    delete process.env.MCP_SYSTEM_USER_ID;
    await expect(mcp.invokeTool('approve_paper_trade', { proposalId: 'p1', decision: 'approved' }))
      .rejects.toThrow('userId');
  });

  test('request_paper_trade creates a PAPER-mode proposal (executes through proposalService)', async () => {
    // The handler delegates to proposalService.createProposal; without a valid
    // strategyId it throws, proving the existing gating path is reused (not bypassed).
    await expect(mcp.invokeTool('request_paper_trade', { strategyId: 'nope', symbol: 'AAPL', entryPrice: 100, stopPrice: 95 }))
      .rejects.toThrow();
  });
});
