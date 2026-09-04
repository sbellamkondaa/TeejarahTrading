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
const SchedulerStatusService = require('../schedulerStatusService');
const nasdaqClient = require('./nasdaqClient');

const LOG_PREFIX = '[NASDAQ-HALT-SCHEDULER]';
const SCHEDULER_NAME = 'nasdaq-halts';
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
    await this.recordStartedSafe();
    let result;
    try {
      result = await nasdaqClient.fetchAndIngestNasdaqHalts();
    } catch (error) {
      await this.recordFailureSafe(error);
      throw error;
    }

    this.lastRunAt = new Date();
    this.lastResult = result;

    if (result && result.ok) {
      await this.recordSuccessSafe({
        fetched: result.fetched,
        inserted: result.inserted,
        skipped: result.skipped
      });
      console.log(
        `${LOG_PREFIX} Ingest ok: fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped}`
      );
    } else {
      await this.recordFailureSafe(new Error('Ingest not ok: ' + JSON.stringify(result)));
      console.warn(
        `${LOG_PREFIX} Ingest not ok: ${JSON.stringify(result)}`
      );
    }

    return result;
  }

  async recordStartedSafe() {
    try {
      await SchedulerStatusService.recordStarted(SCHEDULER_NAME);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to record started status: ${err.message}`);
    }
  }

  async recordSuccessSafe(summary) {
    try {
      await SchedulerStatusService.recordSuccess(SCHEDULER_NAME, summary);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to record success status: ${err.message}`);
    }
  }

  async recordFailureSafe(error) {
    try {
      await SchedulerStatusService.recordFailure(SCHEDULER_NAME, error);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to record failure status: ${err.message}`);
    }
  }

  getStatus() {
    return {
      ...super.getStatus(),
      enabled: isSchedulerEnabled(),
      intervalSeconds: this.intervalSeconds,
      schedulerName: SCHEDULER_NAME,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult
    };
  }
}

// Singleton instance — server.js requires this and calls .start()/.stop().
const nasdaqHaltScheduler = new NasdaqHaltScheduler();

module.exports = nasdaqHaltScheduler;
// Re-attach named exports for tests and the controller (which needs
// isSchedulerEnabled and SCHEDULER_NAME without instantiating the scheduler).
module.exports.NasdaqHaltScheduler = NasdaqHaltScheduler;
module.exports.SCHEDULER_NAME = SCHEDULER_NAME;
module.exports.isSchedulerEnabled = isSchedulerEnabled;
module.exports.getIntervalSeconds = getIntervalSeconds;
module.exports.MIN_INTERVAL_SECONDS = MIN_INTERVAL_SECONDS;
module.exports.DEFAULT_INTERVAL_SECONDS = DEFAULT_INTERVAL_SECONDS;
