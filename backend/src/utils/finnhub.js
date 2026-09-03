const finnhubClient = require('./finnhubClient');
const fmpClient = require('./fmpClient');
const schwabMarketData = require('./schwabMarketData');

function getConfiguredProviderName() {
  return String(process.env.MARKET_DATA_PROVIDER || 'schwab')
    .trim()
    .toLowerCase();
}

/**
 * Schwab-primary hybrid provider.
 * Quotes/candles:  Schwab first, Finnhub fallback.
 * News/earnings/profiles/fundamentals: Finnhub (passthrough).
 */
function createSchwabPrimaryProvider(fallbackProvider) {
  const provider = new Proxy(fallbackProvider, {
    get(target, property) {
      const value = target[property];
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    }
  });

  const fallbackQuote =
    typeof fallbackProvider.getQuote === 'function'
      ? fallbackProvider.getQuote.bind(fallbackProvider)
      : null;
  const fallbackQuotes =
    typeof fallbackProvider.getQuotes === 'function'
      ? fallbackProvider.getQuotes.bind(fallbackProvider)
      : null;
  const fallbackCandles =
    typeof fallbackProvider.getCandles === 'function'
      ? fallbackProvider.getCandles.bind(fallbackProvider)
      : null;
  const fallbackHistory =
    typeof fallbackProvider.getPriceHistory === 'function'
      ? fallbackProvider.getPriceHistory.bind(fallbackProvider)
      : null;

  provider.getQuote = async (...args) => {
    const symbol = args[0];
    try {
      const quote = await schwabMarketData.getQuote(symbol);
      if (quote && quote.c !== null && quote.c !== undefined) {
        return quote;
      }
    } catch (error) {
      console.warn(
        `[MARKET-DATA] Schwab quote failed for ${symbol}, using fallback: ${error.message}`
      );
    }
    return fallbackQuote ? fallbackQuote(...args) : null;
  };

  provider.getQuotes = async (...args) => {
    try {
      const quotes = await schwabMarketData.getQuotes(args[0]);
      if (quotes && Object.keys(quotes).length > 0) {
        return quotes;
      }
    } catch (error) {
      console.warn(
        `[MARKET-DATA] Schwab batch quotes failed, using fallback: ${error.message}`
      );
    }
    return fallbackQuotes ? fallbackQuotes(...args) : {};
  };

  provider.getCandles = async (...args) => {
    const symbol = args[0];
    try {
      const candles = await schwabMarketData.getCandles(...args);
      if (candles && candles.length > 0) {
        return candles;
      }
    } catch (error) {
      console.warn(
        `[MARKET-DATA] Schwab candles failed for ${symbol}, using fallback: ${error.message}`
      );
    }
    return fallbackCandles ? fallbackCandles(...args) : null;
  };

  provider.getPriceHistory = async (...args) => {
    const symbol = args[0];
    try {
      const history = await schwabMarketData.getPriceHistory(...args);
      if (history && history.length > 0) {
        return history;
      }
    } catch (error) {
      console.warn(
        `[MARKET-DATA] Schwab price history failed for ${symbol}, using fallback: ${error.message}`
      );
    }
    return fallbackHistory ? fallbackHistory(...args) : null;
  };

  provider.providerName = 'schwab';
  provider.displayName = 'Schwab Market Data + Finnhub Enrichment';
  provider.isSchwab = true;
  provider.isFinnhub = false;
  provider.isFmp = false;
  provider.requestedProviderName = 'schwab';

  return provider;
}

const requestedProviderName = getConfiguredProviderName();

let selectedProvider;

if (requestedProviderName === 'schwab') {
  selectedProvider = createSchwabPrimaryProvider(finnhubClient);
} else if (requestedProviderName === 'fmp') {
  selectedProvider = fmpClient;
  selectedProvider.providerName = 'fmp';
  selectedProvider.displayName = 'Financial Modeling Prep';
  selectedProvider.isSchwab = false;
  selectedProvider.isFinnhub = false;
  selectedProvider.isFmp = true;
  selectedProvider.requestedProviderName = 'fmp';
} else {
  selectedProvider = finnhubClient;
  selectedProvider.providerName = 'finnhub';
  selectedProvider.displayName = 'Finnhub';
  selectedProvider.isSchwab = false;
  selectedProvider.isFinnhub = true;
  selectedProvider.isFmp = false;
  selectedProvider.requestedProviderName = 'finnhub';
}

console.log(
  `[MARKET-DATA] Using ${selectedProvider.displayName} market data provider`
);

module.exports = selectedProvider;
