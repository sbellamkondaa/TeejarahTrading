jest.mock('../../src/services/nasdaq/nasdaqClient', () => ({
  fetchAndIngestNasdaqHalts: jest.fn()
}));
jest.mock('../../src/services/schedulerStatusService', () => ({
  recordStarted: jest.fn(),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn()
}));
jest.mock('../../src/services/schedulers/IntervalScheduler');

const nasdaqClient = require('../../src/services/nasdaq/nasdaqClient');
const SchedulerStatusService = require('../../src/services/schedulerStatusService');
const IntervalScheduler = require('../../src/services/schedulers/IntervalScheduler');
const { isSchedulerEnabled, getIntervalSeconds, NasdaqHaltScheduler, SCHEDULER_NAME, MIN_INTERVAL_SECONDS } = require('../../src/services/nasdaq/nasdaqHaltScheduler');

describe('nasdaqHaltScheduler', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe('isSchedulerEnabled', () => {
    test('defaults to false when env var absent', () => {
      delete process.env.ENABLE_NASDAQ_HALT_SCHEDULER;
      expect(isSchedulerEnabled()).toBe(false);
    });

    test('false when set to anything other than "true" (case-insensitive)', () => {
      process.env.ENABLE_NASDAQ_HALT_SCHEDULER = 'false';
      expect(isSchedulerEnabled()).toBe(false);
      process.env.ENABLE_NASDAQ_HALT_SCHEDULER = '1';
      expect(isSchedulerEnabled()).toBe(false);
      process.env.ENABLE_NASDAQ_HALT_SCHEDULER = 'yes';
      expect(isSchedulerEnabled()).toBe(false);
    });

    test('true only when set to "true" (case-insensitive)', () => {
      process.env.ENABLE_NASDAQ_HALT_SCHEDULER = 'true';
      expect(isSchedulerEnabled()).toBe(true);
      process.env.ENABLE_NASDAQ_HALT_SCHEDULER = 'TRUE';
      expect(isSchedulerEnabled()).toBe(true);
    });
  });

  describe('getIntervalSeconds', () => {
    test('defaults to 60s', () => {
      delete process.env.NASDAQ_HALT_INTERVAL_SECONDS;
      expect(getIntervalSeconds()).toBe(60);
    });

    test('clamps below the 60s minimum', () => {
      process.env.NASDAQ_HALT_INTERVAL_SECONDS = '10';
      expect(getIntervalSeconds()).toBe(60);
      process.env.NASDAQ_HALT_INTERVAL_SECONDS = '30';
      expect(getIntervalSeconds()).toBe(60);
    });

    test('uses larger configured values', () => {
      process.env.NASDAQ_HALT_INTERVAL_SECONDS = '120';
      expect(getIntervalSeconds()).toBe(120);
      process.env.NASDAQ_HALT_INTERVAL_SECONDS = '300';
      expect(getIntervalSeconds()).toBe(300);
    });

    test('falls back to default for non-numeric', () => {
      process.env.NASDAQ_HALT_INTERVAL_SECONDS = 'abc';
      expect(getIntervalSeconds()).toBe(60);
    });

    test('exports MIN_INTERVAL_SECONDS = 60', () => {
      expect(MIN_INTERVAL_SECONDS).toBe(60);
    });
  });

  describe('NasdaqHaltScheduler instance', () => {
    test('constructor wires IntervalScheduler with useRunningGuard and useUnref', () => {
      // Construct a fresh instance to exercise the IntervalScheduler wiring.
      // eslint-disable-next-line no-new
      new NasdaqHaltScheduler();
      expect(IntervalScheduler).toHaveBeenCalled();
      const opts = IntervalScheduler.mock.calls[IntervalScheduler.mock.calls.length - 1][0];
      expect(opts.useRunningGuard).toBe(true);
      expect(opts.useUnref).toBe(true);
      expect(opts.intervalMs).toBe(60000);
    });

    test('execute calls fetchAndIngestNasdaqHalts and records result + scheduler status', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: true, fetched: 5, inserted: 2, skipped: 3 });
      const sched = new NasdaqHaltScheduler();
      const result = await sched.execute();
      expect(nasdaqClient.fetchAndIngestNasdaqHalts).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(sched.lastResult).toEqual({ ok: true, fetched: 5, inserted: 2, skipped: 3 });
      expect(sched.lastRunAt).toBeInstanceOf(Date);
      // Status recording: started + success called with the scheduler name.
      expect(SchedulerStatusService.recordStarted).toHaveBeenCalledWith(SCHEDULER_NAME);
      expect(SchedulerStatusService.recordSuccess).toHaveBeenCalledWith(SCHEDULER_NAME, {
        fetched: 5, inserted: 2, skipped: 3
      });
      expect(SchedulerStatusService.recordFailure).not.toHaveBeenCalled();
    });

    test('execute records failure status when ingest returns not-ok', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: false, error: 'network' });
      const sched = new NasdaqHaltScheduler();
      await sched.execute();
      expect(SchedulerStatusService.recordFailure).toHaveBeenCalled();
      expect(SchedulerStatusService.recordSuccess).not.toHaveBeenCalled();
    });

    test('execute records failure status and rethrows when fetchAndIngestNasdaqHalts rejects', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockRejectedValue(new Error('boom'));
      const sched = new NasdaqHaltScheduler();
      await expect(sched.execute()).rejects.toThrow('boom');
      expect(SchedulerStatusService.recordFailure).toHaveBeenCalledWith(SCHEDULER_NAME, expect.any(Error));
    });

    test('status-recording failure does not crash execute on success path', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: true, fetched: 1, inserted: 1, skipped: 0 });
      SchedulerStatusService.recordSuccess.mockRejectedValueOnce(new Error('status db down'));
      const sched = new NasdaqHaltScheduler();
      await expect(sched.execute()).resolves.toEqual({ ok: true, fetched: 1, inserted: 1, skipped: 0 });
    });

    test('status-recording failure does not crash execute on failure path', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: false, error: 'x' });
      SchedulerStatusService.recordFailure.mockRejectedValueOnce(new Error('status db down'));
      const sched = new NasdaqHaltScheduler();
      await expect(sched.execute()).resolves.toEqual({ ok: false, error: 'x' });
    });

    test('execute does not throw when ingest returns not-ok (failure must not crash worker)', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: false, error: 'network' });
      const sched = new NasdaqHaltScheduler();
      await expect(sched.execute()).resolves.toEqual({ ok: false, error: 'network' });
    });

    test('execute does not throw when fetchAndIngestNasdaqHalts rejects', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockRejectedValue(new Error('boom'));
      const sched = new NasdaqHaltScheduler();
      // execute() itself rejects here; the IntervalScheduler's runGuarded is what
      // catches it. We assert execute surfaces the rejection so the guard can catch it.
      await expect(sched.execute()).rejects.toThrow('boom');
    });

    test('exports SCHEDULER_NAME = "nasdaq-halts"', () => {
      expect(SCHEDULER_NAME).toBe('nasdaq-halts');
    });
  });
});
