/**
 * Paper Reconciliation Scheduler
 *
 * Worker-only scheduler that periodically reconciles all open PAPER positions.
 * On each cycle it:
 *   1. Runs restart recovery (detect/repair safe inconsistencies)
 *   2. Processes fills for all open positions with active sell orders
 *   3. Verifies the sell-quantity invariant
 *
 * Concurrency safeguards:
 *   - IntervalScheduler overlap guard (useRunningGuard) prevents the same
 *     process from running two cycles concurrently.
 *   - A Redis distributed lock (redisService.withLock) prevents multiple
 *     worker processes from reconciling simultaneously.
 *
 * Configuration:
 *   ENABLE_PAPER_RECONCILIATION   default 'false' — opt-in only
 *   PAPER_RECONCILIATION_INTERVAL_SECONDS   default 5, clamped to a 5s minimum
 *
 * Safety:
 *   - PAPER execution mode only
 *   - Never places live broker orders
 *   - Failures are caught and logged; they never crash the worker
 *   - Status recorded to scheduler_status for observability
 */

const IntervalScheduler = require('../schedulers/IntervalScheduler');
const SchedulerStatusService = require('../schedulerStatusService');
const redisService = require('../redisService');
const paperBroker = require('./paperBroker');

const LOG_PREFIX = '[PAPER-RECONCILIATION]';
const SCHEDULER_NAME = 'paper-reconciliation';
const MIN_INTERVAL_SECONDS = 5;
const DEFAULT_INTERVAL_SECONDS = 5;
const LOCK_NAME = 'paper-reconciliation';
const LOCK_TTL_MS = 120000;
const LOCK_WAIT_MS = 5000;

function isSchedulerEnabled() {
  return String(process.env.ENABLE_PAPER_RECONCILIATION || '').toLowerCase() === 'true';
}

function getIntervalSeconds() {
  const raw = parseInt(process.env.PAPER_RECONCILIATION_INTERVAL_SECONDS || '', 10);
  if (!Number.isFinite(raw) || raw < MIN_INTERVAL_SECONDS) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return raw;
}

class PaperReconciliationScheduler extends IntervalScheduler {
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
      // Redis distributed lock prevents multiple workers from reconciling
      // simultaneously. If the lock cannot be acquired (another worker is
      // processing), this cycle is skipped gracefully.
      result = await redisService.withLock(
        LOCK_NAME,
        () => paperBroker.runReconciliationCycle(null),
        { ttlMs: LOCK_TTL_MS, waitMs: LOCK_WAIT_MS }
      );
    } catch (err) {
      if (err.code === 'REDIS_LOCK_TIMEOUT') {
        // Another worker holds the lock — skip this cycle gracefully
        console.log(`${LOG_PREFIX} Skipped (lock held by another worker)`);
        return { skipped: true, reason: 'lock_held' };
      }
      await this.recordFailureSafe(err);
      throw err;
    }

    this.lastRunAt = new Date();
    this.lastResult = result;

    await this.recordSuccessSafe({
      repairs: result.repairs || 0,
      manualInterventions: result.manualInterventions || 0,
      positionsProcessed: result.positionsProcessed || 0,
      fillsApplied: result.fillsApplied || 0,
      errors: (result.errors || []).length
    });

    console.log(
      `${LOG_PREFIX} Cycle ok: repairs=${result.repairs || 0} ` +
      `positions=${result.positionsProcessed || 0} fills=${result.fillsApplied || 0} ` +
      `errors=${(result.errors || []).length}`
    );

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
const paperReconciliationScheduler = new PaperReconciliationScheduler();

module.exports = paperReconciliationScheduler;
module.exports.PaperReconciliationScheduler = PaperReconciliationScheduler;
module.exports.SCHEDULER_NAME = SCHEDULER_NAME;
module.exports.isSchedulerEnabled = isSchedulerEnabled;
module.exports.getIntervalSeconds = getIntervalSeconds;
module.exports.MIN_INTERVAL_SECONDS = MIN_INTERVAL_SECONDS;
module.exports.DEFAULT_INTERVAL_SECONDS = DEFAULT_INTERVAL_SECONDS;
