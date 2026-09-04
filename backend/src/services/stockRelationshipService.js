/**
 * Stock Relationship Service
 *
 * Builds a relationship graph for a given symbol:
 *   - Company profile (sector, industry, market cap) from Finnhub
 *   - Industry peers / competitors from Finnhub /stock/peers
 *   - 30-day price correlation from Schwab daily candles
 *
 * The graph is cached in Redis for 1 hour (peers + profiles change slowly,
 * correlation recomputed on cache miss). Quotes are always fresh via the
 * existing Schwab batch-quote path.
 */

const finnhub = require('../utils/finnhub');
const schwabMarketData = require('../utils/schwabMarketData');
const redisCache = require('../utils/redisCache');
const logger = require('../utils/logger');

const CACHE_NAMESPACE = 'stock_relationships';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CORRELATION_DAYS = 30;
const MAX_PEERS = 12;
const MIN_OVERLAP = 20; // minimum overlapping daily returns for valid correlation

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Pearson correlation of two return series. Returns null if insufficient
// overlap or zero variance.
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OVERLAP) return null;

  const aSlice = a.slice(a.length - n);
  const bSlice = b.slice(b.length - n);

  const meanA = aSlice.reduce((s, v) => s + v, 0) / n;
  const meanB = bSlice.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let denA = 0;
  let denB = 0;

  for (let i = 0; i < n; i++) {
    const da = aSlice[i] - meanA;
    const db = bSlice[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }

  const denom = Math.sqrt(denA * denB);
  if (denom === 0) return null;

  return num / denom;
}

// Convert daily close prices to daily returns (percentage change).
function closeToReturns(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  const closes = candles.map((c) => numberOrNull(c.close)).filter((v) => v != null && v > 0);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
  }
  return returns;
}

// Describe correlation strength in human-readable bands.
function describeCorrelation(r) {
  if (r == null) return 'insufficient_data';
  const abs = Math.abs(r);
  if (abs >= 0.7) return 'strong';
  if (abs >= 0.4) return 'moderate';
  if (abs >= 0.2) return 'weak';
  return 'negligible';
}

async function getRelationshipGraph(symbol) {
  const symbolUpper = symbol.toUpperCase();

  // Check Redis cache for the structural graph (peers + correlations).
  // Quotes are always fetched fresh so the caller sees current prices.
  const cached = await redisCache.get(CACHE_NAMESPACE, symbolUpper).catch(() => null);
  if (cached && Array.isArray(cached.peers)) {
    // Enrich cached peers with fresh quotes
    const allSymbols = [symbolUpper, ...cached.peers.map((p) => p.symbol)];
    let quotes = {};
    try {
      quotes = await finnhub.getQuotes(allSymbols);
    } catch (err) {
      logger.warn(`[RELATIONSHIPS] Quote enrichment failed for ${symbolUpper}: ${err.message}`);
    }

    const mainQuote = quotes[symbolUpper] || {};
    const peers = cached.peers.map((p) => {
      const q = quotes[p.symbol] || {};
      return {
        ...p,
        last_price: numberOrNull(q.c),
        change_percent: numberOrNull(q.dp),
        change: numberOrNull(q.d),
        previous_close: numberOrNull(q.pc)
      };
    });

    return {
      symbol: symbolUpper,
      name: cached.name || null,
      industry: cached.industry || null,
      market_cap: cached.market_cap || null,
      country: cached.country || null,
      exchange: cached.exchange || null,
      last_price: numberOrNull(mainQuote.c),
      change_percent: numberOrNull(mainQuote.dp),
      change: numberOrNull(mainQuote.d),
      peers,
      fetched_at: cached.fetched_at,
      quote_fetched_at: Date.now()
    };
  }

  // --- Cache miss: build the graph from scratch ---

  // 1. Company profile + peers (parallel, both Finnhub enrichment)
  const [profile, peerSymbols] = await Promise.all([
    finnhub.getCompanyProfile(symbolUpper).catch((err) => {
      logger.warn(`[RELATIONSHIPS] Profile failed for ${symbolUpper}: ${err.message}`);
      return null;
    }),
    finnhub.getPeers(symbolUpper).catch((err) => {
      logger.warn(`[RELATIONSHIPS] Peers failed for ${symbolUpper}: ${err.message}`);
      return [];
    })
  ]);

  const trimmedPeers = (peerSymbols || []).slice(0, MAX_PEERS);

  // 2. 30-day price history for correlation (main symbol + each peer)
  //    Limited concurrency to avoid hammering Schwab.
  const allHistorySymbols = [symbolUpper, ...trimmedPeers];
  const historyMap = {};

  // Batch in groups of 5 to respect rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < allHistorySymbols.length; i += BATCH_SIZE) {
    const batch = allHistorySymbols.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (sym) => {
        try {
          const history = await schwabMarketData.getPriceHistory(sym, CORRELATION_DAYS);
          historyMap[sym] = history;
        } catch (err) {
          logger.warn(`[RELATIONSHIPS] Price history failed for ${sym}: ${err.message}`);
          historyMap[sym] = null;
        }
      })
    );
  }

  const mainReturns = historyMap[symbolUpper] ? closeToReturns(historyMap[symbolUpper]) : [];

  // 3. Batch quotes for the symbol + all peers
  let quotes = {};
  try {
    quotes = await finnhub.getQuotes(allHistorySymbols);
  } catch (err) {
    logger.warn(`[RELATIONSHIPS] Batch quotes failed for ${symbolUpper}: ${err.message}`);
  }

  // 4. Build peer list with correlation, quote data
  const peers = trimmedPeers.map((peerSym) => {
    const peerHistory = historyMap[peerSym];
    const peerReturns = peerHistory ? closeToReturns(peerHistory) : [];
    const correlation = (mainReturns.length >= MIN_OVERLAP && peerReturns.length >= MIN_OVERLAP)
      ? pearsonCorrelation(mainReturns, peerReturns)
      : null;

    const q = quotes[peerSym] || {};
    return {
      symbol: peerSym,
      correlation: numberOrNull(correlation),
      correlation_strength: describeCorrelation(correlation),
      last_price: numberOrNull(q.c),
      change_percent: numberOrNull(q.dp),
      change: numberOrNull(q.d),
      previous_close: numberOrNull(q.pc)
    };
  });

  // Sort peers by absolute correlation (strongest first), nulls last
  peers.sort((a, b) => {
    if (a.correlation == null && b.correlation == null) return 0;
    if (a.correlation == null) return 1;
    if (b.correlation == null) return -1;
    return Math.abs(b.correlation) - Math.abs(a.correlation);
  });

  const mainQuote = quotes[symbolUpper] || {};

  const graph = {
    symbol: symbolUpper,
    name: (profile && profile.name) || null,
    industry: (profile && profile.finnhubIndustry) || null,
    market_cap: numberOrNull(profile && profile.market_cap),
    country: (profile && profile.country) || null,
    exchange: (profile && profile.exchange) || null,
    last_price: numberOrNull(mainQuote.c),
    change_percent: numberOrNull(mainQuote.dp),
    change: numberOrNull(mainQuote.d),
    peers,
    fetched_at: Date.now(),
    quote_fetched_at: Date.now()
  };

  // Cache the structural graph (peers + correlation) for 1 hour.
  // Quotes are not cached here — they're re-fetched on each request.
  const cachePayload = {
    name: graph.name,
    industry: graph.industry,
    market_cap: graph.market_cap,
    country: graph.country,
    exchange: graph.exchange,
    peers: graph.peers.map((p) => ({
      symbol: p.symbol,
      correlation: p.correlation,
      correlation_strength: p.correlation_strength
    })),
    fetched_at: graph.fetched_at
  };

  await redisCache.set(CACHE_NAMESPACE, symbolUpper, cachePayload, CACHE_TTL_MS).catch((err) => {
    logger.warn(`[RELATIONSHIPS] Cache set failed for ${symbolUpper}: ${err.message}`);
  });

  return graph;
}

module.exports = { getRelationshipGraph };
