/**
 * Market Intelligence Ingestion Scheduler
 *
 * Worker-only. Periodically runs runIngestionCycle() to keep the
 * market_events table current across all enabled sources. Reuses the
 * IntervalScheduler overlap guard and SchedulerStatusService freshness
 * tracking, matching the Nasdaq halt scheduler pattern.
 *
 * Configuration:
 *   ENABLE_MARKET_INTELLIGENCE_SCHEDULER  default 'false' — opt-in only
 *   MARKET_INTELLIGENCE_INTERVAL_SECONDS  default 300, clamped to 120s min
 *
 * Safety:
 *   - never polls more frequently than every 120s
 *   - source failures are isolated (see sourceRegistry)
 *   - no live broker calls; no AI calls
 */

const IntervalScheduler = require('../schedulers/IntervalScheduler');
const SchedulerStatusService = require('../schedulerStatusService');
const { runIngestionCycle } = require('../marketIntelligence/ingestionService');

const LOG_PREFIX = '[MARKET-INTEL-SCHEDULER]';
const SCHEDULER_NAME = 'market-intelligence';
const MIN_INTERVAL_SECONDS = 120;
const DEFAULT_INTERVAL_SECONDS = 300;

function isSchedulerEnabled() {
  return String(process.env.ENABLE_MARKET_INTELLIGENCE_SCHEDULER || '').toLowerCase() === 'true';
}

function getIntervalSeconds() {
  const raw = parseInt(process.env.MARKET_INTELLIGENCE_INTERVAL_SECONDS || '', 10);
  if (!Number.isFinite(raw) || raw < MIN_INTERVAL_SECONDS) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return raw;
}

class MarketIntelligenceScheduler extends IntervalScheduler {
  constructor() {
    const intervalSeconds = getIntervalSeconds();
    super({
      intervalMs: intervalSeconds * 1000,
      useUnref: true,
      useRunningGuard: true,
      messages: {
        startLogs: [`${LOG_PREFIX} Starting (interval=${intervalSeconds}s)`],
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
      // The first scheduled/initial run uses a larger lookback (backfill).
      // Subsequent runs use the default short lookback.
      const initial = !this._initialRunDone;
      result = await runIngestionCycle({ initial });
      this._initialRunDone = true;
    } catch (error) {
      await this.recordFailureSafe(error);
      throw error;
    }

    this.lastRunAt = new Date();
    this.lastResult = result;

    await this.recordSuccessSafe({
      sources: result.sources,
      items: result.items,
      inserted: result.inserted,
      deduped: result.deduped,
      errors: result.errors
    });
    console.log(
      `${LOG_PREFIX} Ingest ok: sources=${result.sources} items=${result.items} inserted=${result.inserted} deduped=${result.deduped} errors=${result.errors}`
    );
    return result;
  }

  async recordStartedSafe() {
    try { await SchedulerStatusService.recordStarted(SCHEDULER_NAME); }
    catch (err) { console.warn(`${LOG_PREFIX} Failed to record started: ${err.message}`); }
  }
  async recordSuccessSafe(summary) {
    try { await SchedulerStatusService.recordSuccess(SCHEDULER_NAME, summary); }
    catch (err) { console.warn(`${LOG_PREFIX} Failed to record success: ${err.message}`); }
  }
  async recordFailureSafe(error) {
    try { await SchedulerStatusService.recordFailure(SCHEDULER_NAME, error); }
    catch (err) { console.warn(`${LOG_PREFIX} Failed to record failure: ${err.message}`); }
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

  /**
   * Run one ingestion cycle immediately on worker startup so events populate
   * without waiting for the first interval tick. Uses the initial (larger)
   * lookback. Failures are logged but never crash the worker. The scheduler's
   * running guard + Redis lock prevent overlap with a concurrent scheduled run.
   */
  async runStartupIngestion() {
    try {
      console.log(`${LOG_PREFIX} Running startup ingestion (initial lookback)...`);
      const result = await runIngestionCycle({ initial: true });
      this._initialRunDone = true;
      this.lastRunAt = new Date();
      this.lastResult = result;
      console.log(
        `${LOG_PREFIX} Startup ingestion ok: sources=${result.sources} items=${result.items} inserted=${result.inserted} deduped=${result.deduped} errors=${result.errors}`
      );
      return result;
    } catch (error) {
      console.warn(`${LOG_PREFIX} Startup ingestion failed (non-fatal): ${error.message}`);
      return { ok: false, error: error.message };
    }
  }
}

const marketIntelligenceScheduler = new MarketIntelligenceScheduler();

module.exports = marketIntelligenceScheduler;
module.exports.MarketIntelligenceScheduler = MarketIntelligenceScheduler;
module.exports.SCHEDULER_NAME = SCHEDULER_NAME;
module.exports.isSchedulerEnabled = isSchedulerEnabled;
module.exports.getIntervalSeconds = getIntervalSeconds;
module.exports.MIN_INTERVAL_SECONDS = MIN_INTERVAL_SECONDS;
module.exports.DEFAULT_INTERVAL_SECONDS = DEFAULT_INTERVAL_SECONDS;
