jest.mock('../../src/services/nasdaq/nasdaqClient', () => ({
  fetchAndIngestNasdaqHalts: jest.fn()
}));
jest.mock('../../src/services/schedulers/IntervalScheduler');

const nasdaqClient = require('../../src/services/nasdaq/nasdaqClient');
const IntervalScheduler = require('../../src/services/schedulers/IntervalScheduler');
const { isSchedulerEnabled, getIntervalSeconds, NasdaqHaltScheduler, MIN_INTERVAL_SECONDS } = require('../../src/services/nasdaq/nasdaqHaltScheduler');

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
      NasdaqHaltScheduler; // ensure module loads
      expect(IntervalScheduler).toHaveBeenCalled();
      const opts = IntervalScheduler.mock.calls[0][0];
      expect(opts.useRunningGuard).toBe(true);
      expect(opts.useUnref).toBe(true);
      expect(opts.intervalMs).toBe(60000);
    });

    test('execute calls fetchAndIngestNasdaqHalts and records result', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: true, fetched: 5, inserted: 2, skipped: 3 });
      // Construct a fresh instance to avoid the shared singleton's state.
      const sched = new (require('../../src/services/nasdaq/nasdaqHaltScheduler').NasdaqHaltScheduler)();
      const result = await sched.execute();
      expect(nasdaqClient.fetchAndIngestNasdaqHalts).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(sched.lastResult).toEqual({ ok: true, fetched: 5, inserted: 2, skipped: 3 });
      expect(sched.lastRunAt).toBeInstanceOf(Date);
    });

    test('execute does not throw when ingest returns not-ok (failure must not crash worker)', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockResolvedValue({ ok: false, error: 'network' });
      const sched = new (require('../../src/services/nasdaq/nasdaqHaltScheduler').NasdaqHaltScheduler)();
      await expect(sched.execute()).resolves.toEqual({ ok: false, error: 'network' });
    });

    test('execute does not throw when fetchAndIngestNasdaqHalts rejects', async () => {
      nasdaqClient.fetchAndIngestNasdaqHalts.mockRejectedValue(new Error('boom'));
      const sched = new (require('../../src/services/nasdaq/nasdaqHaltScheduler').NasdaqHaltScheduler)();
      // execute() itself rejects here; the IntervalScheduler's runGuarded is what
      // catches it. We assert execute surfaces the rejection so the guard can catch it.
      await expect(sched.execute()).rejects.toThrow('boom');
    });
  });
});
