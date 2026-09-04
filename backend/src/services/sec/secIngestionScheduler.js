const secClient = require('../secClient');
const tickerMap = require('./secTickerMapService');
const filings = require('./secFilingService');
const facts = require('./secCompanyFactsService');

const DEFAULT_REFRESH_TICKER_MAP_HOURS = 24;
const DEFAULT_INGEST_INTERVAL_MINUTES = 60;
const DEFAULT_MAX_SYMBOLS_PER_RUN = 10;

function getPositiveIntEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class SecIngestionScheduler {
  constructor() {
    this.isRunning = false;
    this.tickerMapRefreshTimer = null;
    this.ingestTimer = null;
    this.refreshHours = getPositiveIntEnv('SEC_TICKER_MAP_REFRESH_HOURS', DEFAULT_REFRESH_TICKER_MAP_HOURS);
    this.ingestMinutes = getPositiveIntEnv('SEC_INGEST_INTERVAL_MINUTES', DEFAULT_INGEST_INTERVAL_MINUTES);
    this.maxSymbolsPerRun = getPositiveIntEnv('SEC_MAX_SYMBOLS_PER_RUN', DEFAULT_MAX_SYMBOLS_PER_RUN);
    this.lastTickerMapRefreshAt = null;
    this.lastIngestAt = null;
  }

  async start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('[SEC] Starting SEC ingestion scheduler');

    await this.refreshTickerMapSafely();
    await this.ingestNextBatchSafely();

    const refreshMs = this.refreshHours * 60 * 60 * 1000;
    this.tickerMapRefreshTimer = setInterval(() => {
      this.refreshTickerMapSafely();
    }, refreshMs);
    if (typeof this.tickerMapRefreshTimer.unref === 'function') {
      this.tickerMapRefreshTimer.unref();
    }

    const ingestMs = this.ingestMinutes * 60 * 1000;
    this.ingestTimer = setInterval(() => {
      this.ingestNextBatchSafely();
    }, ingestMs);
    if (typeof this.ingestTimer.unref === 'function') {
      this.ingestTimer.unref();
    }

    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  stop() {
    if (!this.isRunning) return;
    if (this.tickerMapRefreshTimer) clearInterval(this.tickerMapRefreshTimer);
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    this.tickerMapRefreshTimer = null;
    this.ingestTimer = null;
    this.isRunning = false;
    console.log('[SEC] Stopped SEC ingestion scheduler');
  }

  async refreshTickerMapSafely() {
    try {
      const count = await tickerMap.refreshTickerMap();
      this.lastTickerMapRefreshAt = new Date();
      console.log(`[SEC] Ticker map refreshed: ${count} companies`);
    } catch (error) {
      console.error('[SEC] Ticker map refresh failed:', error.message);
    }
  }

  async ingestNextBatchSafely() {
    try {
      await this.ingestNextBatch();
    } catch (error) {
      console.error('[SEC] Ingest batch failed:', error.message);
    }
  }

  async ingestNextBatch() {
    const tickers = await secClient.getDistinctTickersForSecIngestion();
    if (tickers.length === 0) {
      console.log('[SEC] No symbols to ingest');
      this.lastIngestAt = new Date();
      return;
    }

    const batch = tickers.slice(0, this.maxSymbolsPerRun);
    console.log(`[SEC] Ingesting ${batch.length} symbols`);

    let filingsInserted = 0;
    let factsInserted = 0;

    for (const ticker of batch) {
      const resolved = await tickerMap.resolveTicker(ticker);
      if (!resolved) {
        console.warn(`[SEC] No CIK for ${ticker}`);
        continue;
      }

      const filingsResult = await filings.ingestFilingsForCik(resolved.cik);
      if (filingsResult.inserted) {
        filingsInserted += filingsResult.inserted;
      }

      const factsResult = await facts.ingestFactsForCik(resolved.cik);
      if (factsResult.inserted) {
        factsInserted += factsResult.inserted;
      }
    }

    this.lastIngestAt = new Date();
    console.log(
      `[SEC] Ingest complete: filings=${filingsInserted}, facts=${factsInserted}`
    );
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      refreshHours: this.refreshHours,
      ingestMinutes: this.ingestMinutes,
      maxSymbolsPerRun: this.maxSymbolsPerRun,
      lastTickerMapRefreshAt: this.lastTickerMapRefreshAt,
      lastIngestAt: this.lastIngestAt
    };
  }
}

module.exports = new SecIngestionScheduler();
