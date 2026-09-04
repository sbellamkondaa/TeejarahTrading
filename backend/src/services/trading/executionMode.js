/**
 * Execution Mode Service
 *
 * Abstracts the execution mode for trade proposals. In this milestone
 * only PAPER and BACKTEST modes are functional. LIVE mode is gated behind
 * feature flags and must never be auto-enabled.
 *
 * Feature flags (all default false):
 *   ENABLE_LIVE_TRADING
 *   ENABLE_AUTO_EXECUTION
 *   ENABLE_SMALL_CAP_MOMENTUM
 *
 * Approval in this milestone MUST NOT submit a Schwab order, regardless of mode.
 */

const VALID_MODES = ['BACKTEST', 'PAPER', 'LIVE'];

function getDefaultMode() {
  return 'PAPER';
}

function isLiveTradingEnabled() {
  return String(process.env.ENABLE_LIVE_TRADING || 'false').toLowerCase() === 'true';
}

function isAutoExecutionEnabled() {
  return String(process.env.ENABLE_AUTO_EXECUTION || 'false').toLowerCase() === 'true';
}

function isSmallCapMomentumEnabled() {
  return String(process.env.ENABLE_SMALL_CAP_MOMENTUM || 'false').toLowerCase() === 'true';
}

function isValidMode(mode) {
  return VALID_MODES.includes(mode);
}

// Resolve the execution mode for a new proposal. LIVE is rejected unless
// the feature flag is explicitly enabled. This is a hard guard — strategy
// code cannot override it.
function resolveMode(requestedMode) {
  const mode = requestedMode || getDefaultMode();

  if (!isValidMode(mode)) {
    throw new Error(`Invalid execution mode: ${mode}`);
  }

  if (mode === 'LIVE' && !isLiveTradingEnabled()) {
    throw new Error('LIVE execution mode requires ENABLE_LIVE_TRADING=true');
  }

  return mode;
}

function getStatus() {
  return {
    default_mode: getDefaultMode(),
    live_trading_enabled: isLiveTradingEnabled(),
    auto_execution_enabled: isAutoExecutionEnabled(),
    small_cap_momentum_enabled: isSmallCapMomentumEnabled(),
    valid_modes: VALID_MODES
  };
}

module.exports = {
  VALID_MODES,
  getDefaultMode,
  isLiveTradingEnabled,
  isAutoExecutionEnabled,
  isSmallCapMomentumEnabled,
  isValidMode,
  resolveMode,
  getStatus
};