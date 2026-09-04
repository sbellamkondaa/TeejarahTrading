/**
 * Nasdaq Trading-Halt Scheduler
 *
 * Periodically calls fetchAndIngestNasdaqHalts() to keep the market_halts table
 * current. Worker process only — the API process role never starts this
 * scheduler (gated in server.js by PROCESS_ROLE).
 *
 * Configuration:
 *   ENABLE_NASDAQ_HALT_SCHEDULER   default 'false' — opt-in only
 *   NASDAQ_HALT_INTERVAL_SECONDS   default 60, clamped to a 60s minimum
 *
 * Safety:
 *   - never polls more frequently than every 60s
 *   - reuses the IntervalScheduler overlap guard (useRunningGuard)
 *   - failures are caught and logged; they never crash the worker
 *   - existing rate limiting in nasdaqClient is preserved
 */

const IntervalScheduler = require('../schedulers/IntervalScheduler');
const nasdaqClient = require('./nasdaqClient');

const LOG_PREFIX = '[NASDAQ-HALT-SCHEDULER]';
const MIN_INTERVAL_SECONDS = 60;
const DEFAULT_INTERVAL_SECONDS = 60;

function isSchedulerEnabled() {
  return String(process.env.ENABLE_NASDAQ_HALT_SCHEDULER || '').toLowerCase() === 'true';
}

function getIntervalSeconds() {
  const raw = parseInt(process.env.NASDAQ_HALT_INTERVAL_SECONDS || '', 10);
  if (!Number.isFinite(raw) || raw < MIN_INTERVAL_SECONDS) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return raw;
}

class NasdaqHaltScheduler extends IntervalScheduler {
  constructor() {
    const intervalSeconds = getIntervalSeconds();
    super({
      intervalMs: intervalSeconds * 1000,
      useUnref: true,
      useRunningGuard: true,
      messages: {
        startLogs: [
          `${LOG_PREFIX} Starting (interval=${intervalSeconds}s)`
        ],
        started: `${LOG_PREFIX} Started`,
        stopping: `${LOG_PREFIX} Stopping...`,
        stopped: `${LOG_PREFIX} Stopped`,
        skip: `${LOG_PREFIX} Previous run still in progress, skipping`,
        runError: `${LOG_PREFIX} Run failed:`,
        initialError: `${LOG_PREFIX} Initial run failed:`,
        scheduledError: `${LOG_PREFIX} Scheduled run failed:`
      }
    });
    this.intervalSeconds = intervalSeconds;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  async execute() {
    const result = await nasdaqClient.fetchAndIngestNasdaqHalts();
    this.lastRunAt = new Date();
    this.lastResult = result;

    if (result && result.ok) {
      console.log(
        `${LOG_PREFIX} Ingest ok: fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped}`
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Ingest not ok: ${JSON.stringify(result)}`
      );
    }

    return result;
  }

  getStatus() {
    return {
      ...super.getStatus(),
      enabled: isSchedulerEnabled(),
      intervalSeconds: this.intervalSeconds,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult
    };
  }
}

module.exports = {
  NasdaqHaltScheduler,
  // Exported separately for tests that need to control env without instantiating
  isSchedulerEnabled,
  getIntervalSeconds,
  MIN_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_SECONDS
};
