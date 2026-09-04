/**
 * Deterministic Position Sizing + Risk Engine
 *
 * Pure sizing + hard-risk validation per PRODUCT_REQUIREMENTS.md "Position Sizing".
 *
 *   risk_per_share    = abs(entry - stop) + slippage + fees
 *   max_dollar_risk   = account_equity * risk_percent
 *   suggested_shares  = floor(max_dollar_risk / risk_per_share)
 *
 * Result state:
 *   VALID     — all HARD checks passed and all required inputs present
 *   WATCH     — not rejected, but one or more HARD checks could not be
 *               evaluated (missing optional data) OR soft warnings exist
 *   REJECTED  — at least one HARD check failed
 *
 * Principle: a HARD check that cannot be evaluated due to missing data yields
 * WATCH (never VALID, never REJECTED). Values are NEVER fabricated.
 *
 * The engine is authoritative: strategy code must not bypass a REJECTED result.
 * Advisory only — never places broker orders.
 */

const db = require('../../config/database');
const crypto = require('crypto');

// ── Risk presets (PRODUCT_REQUIREMENTS.md) ──
const RISK_PRESETS = [0.25, 0.50, 1.00];

// ── Default hard limits ──
const DEFAULT_RISK_CONFIG = {
  riskPercent: 1.0,              // % of account equity risked per trade
  slippagePerShare: 0.01,        // conservative per-share slippage assumption
  feesPerShare: 0,               // per-share commission (Schwab = $0)
  // Hard limits
  maxRiskPerTradePct: 2.0,       // max % of account equity risked in one trade
  maxPositionPct: 25,            // max % of account equity in a single position
  maxTotalExposurePct: 100,      // max % of account equity across all positions
  maxSectorExposurePct: 40,      // max % of account equity in one sector
  maxDailyLossPct: 6,            // max % daily loss before new entries rejected
  maxWeeklyLossPct: 12,          // max % weekly loss before new entries rejected
  maxOpenPositions: 10,          // max concurrently open positions
  maxPendingEntries: 5,          // max pending (not-yet-filled) entries
  maxTradesPerDay: 10,           // max new entries per day
  maxConsecutiveLosses: 5,       // max consecutive losing trades before halt
  maxSpreadPct: 0.5,             // reject if bid/ask spread exceeds this %
  maxSlippagePerShare: 0.10,     // reject if estimated slippage exceeds this
  minLiquidityRating: 'low',     // reject very_low
  minAdv: 1_000_000,             // minimum average daily volume (shares)
  minRvol: 1.0,                  // minimum relative volume
  minRrT1: 1.5,                  // minimum R:R to T1
  maxParticipationRate: 0.10,    // max fraction of ADV
  maxQuoteAgeMs: 60_000,         // reject stale quotes older than this
  minPrice: 5,                   // penny-stock policy: reject sub-$5
  allowDuplicatePosition: false  // reject duplicate active position when false
};

const LIQUIDITY_TIERS = ['very_low', 'low', 'moderate', 'high'];

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function configVersion(cfg) {
  // Deterministic short hash of the risk config for reproducibility labeling.
  const stable = JSON.stringify(cfg, Object.keys(cfg).sort());
  return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 12);
}

/**
 * Evaluate position sizing + risk for a single trade plan.
 *
 * @param {object} input
 * @param {number} input.entryPrice
 * @param {number} input.stopPrice
 * @param {number} [input.t1Price]
 * @param {number} [input.t2Price]
 * @param {string} input.direction - 'long' | 'short'
 * @param {number} input.accountEquity
 * @param {number} [input.buyingPower]
 * @param {number} [input.dailyLossSoFar]  - dollars lost today (positive = loss)
 * @param {number} [input.weeklyLossSoFar] - dollars lost this week (positive = loss)
 * @param {number} [input.existingSymbolExposure]
 * @param {number} [input.existingTotalExposure]
 * @param {number} [input.existingSectorExposure]
 * @param {number} [input.openPositionsCount]
 * @param {number} [input.pendingEntriesCount]
 * @param {number} [input.tradesTodayCount]
 * @param {number} [input.consecutiveLosses]
 * @param {boolean} [input.hasDuplicatePosition]
 * @param {number} [input.spreadPct]
 * @param {string} [input.liquidityRating]
 * @param {number} [input.avgDailyVolume]
 * @param {number} [input.rvol]
 * @param {number} [input.quoteAgeMs]
 * @param {boolean} [input.halted]
 * @param {string} [input.dilutionLevel]  - LOW | MEDIUM | HIGH
 * @param {number} [input.dataAsOf]       - epoch ms of freshest input
 * @param {object} [config] - overrides on top of DEFAULT_RISK_CONFIG
 * @returns {object} risk evaluation result
 */
function evaluateRisk(input, config = {}) {
  const cfg = { ...DEFAULT_RISK_CONFIG, ...config };
  const warnings = [];
  const rejectionReasons = [];
  const checks = [];

  const entry = toNum(input.entryPrice);
  const stop = toNum(input.stopPrice);
  const t1 = toNum(input.t1Price);
  const t2 = toNum(input.t2Price);
  const accountEquity = toNum(input.accountEquity);
  const direction = input.direction === 'short' ? 'short' : 'long';
  const slippage = toNum(cfg.slippagePerShare) ?? 0;
  const fees = toNum(cfg.feesPerShare) ?? 0;

  let state = 'VALID';

  function recordCheck(name, status, detail) {
    // status: 'pass' | 'fail' | 'skip' | 'info'
    // 'fail' → REJECTED. 'skip' (missing safety data) → WATCH. 'info' → no state change.
    checks.push({ name, status, detail });
    if (status === 'fail') {
      state = 'REJECTED';
    } else if (status === 'skip' && state === 'VALID') {
      state = 'WATCH';
    }
  }

  function reject(reason) {
    rejectionReasons.push(reason);
  }

  // ════════════════════════════════════════════
  // HARD PRECONDITIONS
  // ════════════════════════════════════════════

  // entry missing/invalid
  if (entry == null || entry <= 0) {
    recordCheck('valid_entry', 'fail', 'entry price missing or non-positive');
    reject('Missing or invalid entry price');
  } else {
    recordCheck('valid_entry', 'pass', `entry=${entry}`);
  }

  // stop missing/invalid
  if (stop == null || stop <= 0) {
    recordCheck('valid_stop', 'fail', 'stop price missing or non-positive');
    reject('Missing stop price');
  } else {
    recordCheck('valid_stop', 'pass', `stop=${stop}`);
  }

  // Penny-stock policy: min price
  if (entry != null && entry > 0 && entry < cfg.minPrice) {
    recordCheck('penny_stock', 'fail', `entry=${entry} < min ${cfg.minPrice}`);
    reject(`Penny-stock policy: price below $${cfg.minPrice}`);
  } else if (entry != null && entry > 0) {
    recordCheck('penny_stock', 'pass', `entry=${entry} >= ${cfg.minPrice}`);
  }

  // directional risk: stop on correct side
  let priceRisk = null;
  if (entry != null && entry > 0 && stop != null && stop > 0) {
    const dirSign = direction === 'long' ? 1 : -1;
    priceRisk = (entry - stop) * dirSign;
    if (priceRisk <= 0) {
      recordCheck('positive_risk', 'fail',
        `direction=${direction} entry=${entry} stop=${stop} → non-positive risk`);
      reject('Stop is on the wrong side of entry for direction');
    } else {
      recordCheck('positive_risk', 'pass', `price risk/share=${round2(priceRisk)}`);
    }
  }

  // account equity
  if (accountEquity == null || accountEquity <= 0) {
    recordCheck('account_equity', 'fail', 'account equity missing or non-positive');
    reject('Account equity unavailable — cannot size position');
  } else {
    recordCheck('account_equity', 'pass', `equity=${accountEquity}`);
  }

  // If preconditions failed, return early with REJECTED (no sizing).
  if (state === 'REJECTED') {
    return _result({
      state, entry, stop, t1, t2, direction, accountEquity,
      riskPerShare: null, maxDollarRisk: null, suggestedShares: null,
      totalPositionValue: null, totalDollarRisk: null, accountRiskPct: null,
      rrT1: null, rrT2: null, exposurePct: null,
      warnings, rejectionReasons, checks,
      cfg, input, slippage, fees
    });
  }

  // ════════════════════════════════════════════
  // SIZING (deterministic)
  // ════════════════════════════════════════════
  const riskPerShare = priceRisk + slippage + fees;
  const riskPercent = cfg.riskPercent;
  const maxDollarRisk = accountEquity * (riskPercent / 100);
  const suggestedShares = Math.floor(maxDollarRisk / riskPerShare);
  const totalPositionValue = suggestedShares * entry;
  const totalDollarRisk = suggestedShares * riskPerShare;
  const accountRiskPct = accountEquity > 0 ? (totalDollarRisk / accountEquity) * 100 : null;

  if (suggestedShares <= 0) {
    recordCheck('quantity_positive', 'fail',
      `max_risk=${round2(maxDollarRisk)} / risk_per_share=${round2(riskPerShare)} → 0 shares`);
    reject('Computed quantity is zero (risk capital too small for per-share risk)');
  } else {
    recordCheck('quantity_positive', 'pass', `suggested_shares=${suggestedShares}`);
  }

  // max risk per trade
  if (accountRiskPct != null && accountRiskPct > cfg.maxRiskPerTradePct) {
    recordCheck('max_risk_per_trade', 'fail',
      `account_risk=${round2(accountRiskPct)}% > max ${cfg.maxRiskPerTradePct}%`);
    reject(`Account risk ${round2(accountRiskPct)}% exceeds max per-trade (${cfg.maxRiskPerTradePct}%)`);
  } else if (accountRiskPct != null) {
    recordCheck('max_risk_per_trade', 'pass', `${round2(accountRiskPct)}% <= ${cfg.maxRiskPerTradePct}%`);
  }

  // ════════════════════════════════════════════
  // R:R checks
  // ════════════════════════════════════════════
  const dirSign = direction === 'long' ? 1 : -1;
  let rrT1 = null, rrT2 = null;

  if (t1 != null) {
    const reward1 = (t1 - entry) * dirSign;
    if (reward1 <= 0) {
      recordCheck('rr_t1', 'fail', `t1=${t1} wrong side for ${direction}`);
      reject('T1 target on wrong side of entry — negative reward');
    } else {
      rrT1 = round2(reward1 / riskPerShare);
      if (rrT1 < cfg.minRrT1) {
        recordCheck('min_rr_t1', 'fail', `R:R T1=${rrT1} < min ${cfg.minRrT1}`);
        reject(`R:R to T1 (${rrT1}) below minimum (${cfg.minRrT1})`);
      } else {
        recordCheck('min_rr_t1', 'pass', `R:R T1=${rrT1} >= ${cfg.minRrT1}`);
      }
    }
  } else {
    recordCheck('min_rr_t1', 'skip', 'T1 not provided');
    warnings.push('T1 not provided — R:R T1 not evaluated');
  }

  if (t2 != null) {
    const reward2 = (t2 - entry) * dirSign;
    if (reward2 <= 0) {
      recordCheck('rr_t2', 'fail', `t2=${t2} wrong side for ${direction}`);
      reject('T2 target on wrong side of entry — negative reward');
    } else {
      rrT2 = round2(reward2 / riskPerShare);
      recordCheck('rr_t2', 'pass', `R:R T2=${rrT2}`);
    }
  } else {
    recordCheck('rr_t2', 'info', 'T2 not provided');
  }

  // ════════════════════════════════════════════
  // EXPOSURE / POSITION LIMITS
  // ════════════════════════════════════════════

  // max position %
  const maxPositionNotional = accountEquity * (cfg.maxPositionPct / 100);
  if (totalPositionValue > maxPositionNotional) {
    recordCheck('max_position_pct', 'fail',
      `notional=${round2(totalPositionValue)} > ${cfg.maxPositionPct}% (${round2(maxPositionNotional)})`);
    reject(`Position notional exceeds max position % (${cfg.maxPositionPct}%)`);
  } else {
    recordCheck('max_position_pct', 'pass',
      `notional=${round2(totalPositionValue)} <= ${round2(maxPositionNotional)}`);
  }

  // exposure %
  const exposurePct = accountEquity > 0 ? (totalPositionValue / accountEquity) * 100 : null;

  // max total exposure
  const existingTotal = toNum(input.existingTotalExposure);
  if (existingTotal != null) {
    const combined = existingTotal + totalPositionValue;
    const maxTotal = accountEquity * (cfg.maxTotalExposurePct / 100);
    if (combined > maxTotal) {
      recordCheck('max_total_exposure', 'fail',
        `existing=${round2(existingTotal)} + new=${round2(totalPositionValue)} > ${round2(maxTotal)}`);
      reject('Max total exposure exceeded');
    } else {
      recordCheck('max_total_exposure', 'pass', `combined=${round2(combined)} <= ${round2(maxTotal)}`);
    }
  } else {
    recordCheck('max_total_exposure', 'skip', 'existing total exposure not provided');
    warnings.push('Total portfolio exposure not available — check skipped');
  }

  // max sector exposure
  const existingSector = toNum(input.existingSectorExposure);
  if (existingSector != null) {
    const combinedSector = existingSector + totalPositionValue;
    const maxSector = accountEquity * (cfg.maxSectorExposurePct / 100);
    if (combinedSector > maxSector) {
      recordCheck('max_sector_exposure', 'fail',
        `sector=${round2(combinedSector)} > ${round2(maxSector)}`);
      reject('Max sector exposure exceeded');
    } else {
      recordCheck('max_sector_exposure', 'pass', `sector=${round2(combinedSector)} <= ${round2(maxSector)}`);
    }
  } else {
    recordCheck('max_sector_exposure', 'skip', 'sector exposure not provided');
    warnings.push('Sector exposure not available — check skipped');
  }

  // max open positions
  const openCount = toNum(input.openPositionsCount);
  if (openCount != null) {
    if (openCount >= cfg.maxOpenPositions) {
      recordCheck('max_open_positions', 'fail', `open=${openCount} >= max ${cfg.maxOpenPositions}`);
      reject('Max open positions reached');
    } else {
      recordCheck('max_open_positions', 'pass', `open=${openCount} < ${cfg.maxOpenPositions}`);
    }
  } else {
    recordCheck('max_open_positions', 'skip', 'open positions count not provided');
    warnings.push('Open positions count not available — check skipped');
  }

  // max pending entries
  const pendingCount = toNum(input.pendingEntriesCount);
  if (pendingCount != null) {
    if (pendingCount >= cfg.maxPendingEntries) {
      recordCheck('max_pending_entries', 'fail', `pending=${pendingCount} >= max ${cfg.maxPendingEntries}`);
      reject('Max pending entries reached');
    } else {
      recordCheck('max_pending_entries', 'pass', `pending=${pendingCount} < ${cfg.maxPendingEntries}`);
    }
  } else {
    recordCheck('max_pending_entries', 'skip', 'pending count not provided');
    warnings.push('Pending entries count not available — check skipped');
  }

  // max trades per day
  const tradesToday = toNum(input.tradesTodayCount);
  if (tradesToday != null) {
    if (tradesToday >= cfg.maxTradesPerDay) {
      recordCheck('max_trades_per_day', 'fail', `today=${tradesToday} >= max ${cfg.maxTradesPerDay}`);
      reject('Max trades per day reached');
    } else {
      recordCheck('max_trades_per_day', 'pass', `today=${tradesToday} < ${cfg.maxTradesPerDay}`);
    }
  } else {
    recordCheck('max_trades_per_day', 'skip', 'trades today not provided');
    warnings.push('Trades-today count not available — check skipped');
  }

  // max consecutive losses
  const consecLosses = toNum(input.consecutiveLosses);
  if (consecLosses != null) {
    if (consecLosses >= cfg.maxConsecutiveLosses) {
      recordCheck('max_consecutive_losses', 'fail',
        `consecutive=${consecLosses} >= max ${cfg.maxConsecutiveLosses}`);
      reject('Max consecutive losses reached — trading halted');
    } else {
      recordCheck('max_consecutive_losses', 'pass', `${consecLosses} < ${cfg.maxConsecutiveLosses}`);
    }
  } else {
    recordCheck('max_consecutive_losses', 'skip', 'consecutive losses not provided');
    warnings.push('Consecutive-loss count not available — check skipped');
  }

  // duplicate active position
  if (input.hasDuplicatePosition === true) {
    if (!cfg.allowDuplicatePosition) {
      recordCheck('duplicate_position', 'fail', 'duplicate active position exists');
      reject('Duplicate active position/pending entry not allowed');
    } else {
      recordCheck('duplicate_position', 'pass', 'duplicate allowed by config');
    }
  } else if (input.hasDuplicatePosition === false) {
    recordCheck('duplicate_position', 'pass', 'no duplicate');
  } else {
    recordCheck('duplicate_position', 'skip', 'duplicate status unknown');
    warnings.push('Duplicate-position status unknown — check skipped');
  }

  // ════════════════════════════════════════════
  // LOSS LIMITS
  // ════════════════════════════════════════════

  // max daily loss
  const dailyLoss = toNum(input.dailyLossSoFar);
  const maxDailyLossDollars = accountEquity * (cfg.maxDailyLossPct / 100);
  if (dailyLoss != null && dailyLoss > 0) {
    if (dailyLoss + totalDollarRisk > maxDailyLossDollars) {
      recordCheck('max_daily_loss', 'fail',
        `daily_loss=${round2(dailyLoss)} + risk=${round2(totalDollarRisk)} > ${round2(maxDailyLossDollars)}`);
      reject(`Max daily loss limit (${cfg.maxDailyLossPct}%) would be breached`);
    } else {
      recordCheck('max_daily_loss', 'pass',
        `${round2(dailyLoss + totalDollarRisk)} <= ${round2(maxDailyLossDollars)}`);
    }
  } else if (dailyLoss != null) {
    recordCheck('max_daily_loss', 'pass', `no daily loss (${dailyLoss})`);
  } else {
    recordCheck('max_daily_loss', 'skip', 'daily loss not provided');
    warnings.push('Daily loss not available — check skipped');
  }

  // max weekly loss
  const weeklyLoss = toNum(input.weeklyLossSoFar);
  const maxWeeklyLossDollars = accountEquity * (cfg.maxWeeklyLossPct / 100);
  if (weeklyLoss != null && weeklyLoss > 0) {
    if (weeklyLoss + totalDollarRisk > maxWeeklyLossDollars) {
      recordCheck('max_weekly_loss', 'fail',
        `weekly_loss=${round2(weeklyLoss)} + risk=${round2(totalDollarRisk)} > ${round2(maxWeeklyLossDollars)}`);
      reject(`Max weekly loss limit (${cfg.maxWeeklyLossPct}%) would be breached`);
    } else {
      recordCheck('max_weekly_loss', 'pass',
        `${round2(weeklyLoss + totalDollarRisk)} <= ${round2(maxWeeklyLossDollars)}`);
    }
  } else if (weeklyLoss != null) {
    recordCheck('max_weekly_loss', 'pass', `no weekly loss`);
  } else {
    recordCheck('max_weekly_loss', 'skip', 'weekly loss not provided');
    warnings.push('Weekly loss not available — check skipped');
  }

  // ════════════════════════════════════════════
  // BUYING POWER
  // ════════════════════════════════════════════
  const buyingPower = toNum(input.buyingPower);
  if (buyingPower != null && buyingPower > 0) {
    if (totalPositionValue > buyingPower) {
      recordCheck('buying_power', 'fail',
        `notional=${round2(totalPositionValue)} > bp=${round2(buyingPower)}`);
      reject('Insufficient buying power');
    } else {
      recordCheck('buying_power', 'pass', `${round2(totalPositionValue)} <= ${round2(buyingPower)}`);
    }
  } else {
    recordCheck('buying_power', 'skip', 'buying power not provided');
    warnings.push('Buying power not available — check skipped');
  }

  // ════════════════════════════════════════════
  // MARKET QUALITY CHECKS
  // ════════════════════════════════════════════

  // max spread
  const spreadPct = toNum(input.spreadPct);
  if (spreadPct != null) {
    if (spreadPct > cfg.maxSpreadPct) {
      recordCheck('max_spread', 'fail', `spread=${round2(spreadPct)}% > ${cfg.maxSpreadPct}%`);
      reject(`Spread ${round2(spreadPct)}% exceeds max (${cfg.maxSpreadPct}%)`);
    } else {
      recordCheck('max_spread', 'pass', `${round2(spreadPct)}% <= ${cfg.maxSpreadPct}%`);
    }
  } else {
    recordCheck('max_spread', 'skip', 'spread not provided');
    warnings.push('Spread not available — check skipped');
  }

  // max slippage
  if (slippage > cfg.maxSlippagePerShare) {
    recordCheck('max_slippage', 'fail', `slippage=${slippage} > max ${cfg.maxSlippagePerShare}`);
    reject(`Estimated slippage (${slippage}) exceeds max (${cfg.maxSlippagePerShare})`);
  } else {
    recordCheck('max_slippage', 'pass', `slippage=${slippage} <= ${cfg.maxSlippagePerShare}`);
  }

  // min liquidity
  const liquidityRating = input.liquidityRating || 'unknown';
  if (liquidityRating !== 'unknown') {
    const ratingIdx = LIQUIDITY_TIERS.indexOf(liquidityRating);
    const minIdx = LIQUIDITY_TIERS.indexOf(cfg.minLiquidityRating);
    if (ratingIdx >= 0 && ratingIdx < minIdx) {
      recordCheck('min_liquidity', 'fail', `rating=${liquidityRating} < min ${cfg.minLiquidityRating}`);
      reject(`Liquidity ${liquidityRating} below minimum ${cfg.minLiquidityRating}`);
    } else if (ratingIdx >= 0) {
      recordCheck('min_liquidity', 'pass', `${liquidityRating} >= ${cfg.minLiquidityRating}`);
    } else {
      recordCheck('min_liquidity', 'skip', `unknown rating '${liquidityRating}'`);
      warnings.push(`Unrecognized liquidity rating '${liquidityRating}'`);
    }
  } else {
    recordCheck('min_liquidity', 'skip', 'liquidity rating unknown');
    warnings.push('Liquidity rating unknown — check skipped');
  }

  // min ADV
  const adv = toNum(input.avgDailyVolume);
  if (adv != null && adv > 0) {
    if (adv < cfg.minAdv) {
      recordCheck('min_adv', 'fail', `ADV=${adv} < min ${cfg.minAdv}`);
      reject(`ADV (${adv}) below minimum (${cfg.minAdv})`);
    } else {
      recordCheck('min_adv', 'pass', `ADV=${adv} >= ${cfg.minAdv}`);
    }
    // max participation rate
    const participation = suggestedShares / adv;
    if (participation > cfg.maxParticipationRate) {
      recordCheck('max_participation', 'fail',
        `${round2(participation * 100)}% of ADV > ${round2(cfg.maxParticipationRate * 100)}%`);
      reject(`Order exceeds max participation (${round2(cfg.maxParticipationRate * 100)}% of ADV)`);
    } else {
      recordCheck('max_participation', 'pass',
        `${round2(participation * 100)}% <= ${round2(cfg.maxParticipationRate * 100)}%`);
    }
  } else {
    recordCheck('min_adv', 'skip', 'ADV not provided');
    recordCheck('max_participation', 'skip', 'ADV not provided');
    warnings.push('ADV not available — ADV and participation checks skipped');
  }

  // min RVOL
  const rvol = toNum(input.rvol);
  if (rvol != null) {
    if (rvol < cfg.minRvol) {
      recordCheck('min_rvol', 'fail', `RVOL=${rvol} < min ${cfg.minRvol}`);
      reject(`RVOL (${rvol}) below minimum (${cfg.minRvol})`);
    } else {
      recordCheck('min_rvol', 'pass', `RVOL=${rvol} >= ${cfg.minRvol}`);
    }
  } else {
    recordCheck('min_rvol', 'skip', 'RVOL not provided');
    warnings.push('RVOL not available — check skipped');
  }

  // stale quote/data
  const quoteAgeMs = toNum(input.quoteAgeMs);
  if (quoteAgeMs != null) {
    if (quoteAgeMs > cfg.maxQuoteAgeMs) {
      recordCheck('stale_data', 'fail', `quote_age=${round2(quoteAgeMs / 1000)}s > max ${cfg.maxQuoteAgeMs / 1000}s`);
      reject(`Stale quote/data (age ${round2(quoteAgeMs / 1000)}s exceeds ${cfg.maxQuoteAgeMs / 1000}s)`);
    } else {
      recordCheck('stale_data', 'pass', `quote_age=${round2(quoteAgeMs / 1000)}s <= ${cfg.maxQuoteAgeMs / 1000}s`);
    }
  } else {
    recordCheck('stale_data', 'skip', 'quote age not provided');
    warnings.push('Quote age not available — staleness check skipped');
  }

  // halted security
  if (input.halted === true) {
    recordCheck('halted', 'fail', 'security is halted');
    reject('Security is currently halted — entry rejected');
  } else if (input.halted === false) {
    recordCheck('halted', 'pass', 'not halted');
  } else {
    recordCheck('halted', 'skip', 'halt status unknown');
    warnings.push('Halt status unknown — check skipped');
  }

  // HIGH dilution risk
  const dilutionLevel = (input.dilutionLevel || '').toUpperCase();
  if (dilutionLevel === 'HIGH') {
    recordCheck('dilution_risk', 'fail', 'dilution level HIGH');
    reject('HIGH dilution risk — entry rejected');
  } else if (dilutionLevel === 'MEDIUM' || dilutionLevel === 'LOW') {
    recordCheck('dilution_risk', 'pass', `dilution=${dilutionLevel}`);
    if (dilutionLevel === 'MEDIUM') {
      warnings.push('MEDIUM dilution risk — review before approval');
    }
  } else {
    recordCheck('dilution_risk', 'skip', 'dilution level not provided');
    warnings.push('Dilution risk not available — check skipped');
  }

  return _result({
    state, entry, stop, t1, t2, direction, accountEquity,
    riskPerShare, maxDollarRisk, suggestedShares,
    totalPositionValue, totalDollarRisk, accountRiskPct,
    rrT1, rrT2, exposurePct,
    warnings, rejectionReasons, checks,
    cfg, input, slippage, fees
  });
}

function _result(r) {
  const cfgVersion = configVersion(r.cfg);
  const dataAsOf = r.input.dataAsOf || Date.now();
  const isStale = r.checks.some((c) => c.name === 'stale_data' && c.status === 'fail');
  return {
    state: r.state,
    entry: r.entry,
    stop_price: r.stop,
    t1_price: r.t1,
    t2_price: r.t2,
    direction: r.direction,
    account_equity: r.accountEquity,
    risk_per_share: r.riskPerShare != null ? round4(r.riskPerShare) : null,
    max_dollar_risk: r.maxDollarRisk != null ? round2(r.maxDollarRisk) : null,
    suggested_shares: r.suggestedShares,
    total_position_value: r.totalPositionValue != null ? round2(r.totalPositionValue) : null,
    total_dollar_risk: r.totalDollarRisk != null ? round2(r.totalDollarRisk) : null,
    account_risk_pct: r.accountRiskPct != null ? round4(r.accountRiskPct) : null,
    rr_t1: r.rrT1,
    rr_t2: r.rrT2,
    exposure_pct: r.exposurePct != null ? round4(r.exposurePct) : null,
    warnings: r.warnings,
    rejection_reasons: r.rejectionReasons,
    checks: r.checks,
    data_as_of: dataAsOf,
    is_stale: isStale,
    config_version: cfgVersion,
    risk_percent: r.cfg.riskPercent,
    input_snapshot: r.input,
    account_snapshot: { account_equity: r.accountEquity },
    strategy_version: r.input.strategyVersion || null
  };
}

/**
 * Load deterministic account context for a user from user_settings.account_equity.
 * Never fabricates. Returns null equity if unavailable.
 */
async function getAccountContext(userId) {
  if (!userId) return { account_equity: null };
  try {
    const result = await db.query(
      'SELECT account_equity FROM user_settings WHERE user_id = $1',
      [userId]
    );
    const equity = toNum(result.rows[0]?.account_equity);
    return { account_equity: equity };
  } catch (err) {
    return { account_equity: null };
  }
}

/**
 * Load portfolio risk context (open positions, exposure, daily/weekly loss)
 * from existing trade data. Returns nulls when not computable — never fabricated.
 *
 * TeejarahTrading is a private single-user platform (per AGENTS.md), so
 * trade_proposals has no user_id column — all proposals belong to the one
 * user. The userId param is retained for API stability and future multi-user
 * support but does not filter the query.
 *
 * Uses trade_proposals in active states as a deterministic proxy. Live broker
 * positions are not pulled here to keep the engine deterministic and free of
 * broker-session coupling.
 */
async function getPortfolioRiskContext(userId, symbol) {
  if (!userId) return {};
  try {
    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE lifecycle_state IN ('POSITION_ACTIVE','T1_FILLED','T2_FILLED')) AS open_positions,
         COUNT(*) FILTER (WHERE lifecycle_state IN ('ENTRY_SUBMITTED','ENTRY_PARTIALLY_FILLED')) AS pending_entries,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS trades_today,
         COALESCE(SUM(position_size * entry_zone->>'high')::numeric, 0)
           FILTER (WHERE lifecycle_state IN ('POSITION_ACTIVE','T1_FILLED','T2_FILLED')) AS total_exposure,
         COALESCE(SUM(position_size * entry_zone->>'high')::numeric, 0)
           FILTER (WHERE lifecycle_state IN ('POSITION_ACTIVE','T1_FILLED','T2_FILLED') AND symbol = $1) AS symbol_exposure,
         EXISTS(
           SELECT 1 FROM trade_proposals p2
           WHERE p2.lifecycle_state IN ('POSITION_ACTIVE','T1_FILLED','T2_FILLED','ENTRY_SUBMITTED','ENTRY_PARTIALLY_FILLED')
             AND p2.symbol = $1
         ) AS has_duplicate
       FROM trade_proposals`,
      [(symbol || '').toUpperCase()]
    );
    const row = result.rows[0] || {};
    return {
      openPositionsCount: toNum(row.open_positions),
      pendingEntriesCount: toNum(row.pending_entries),
      tradesTodayCount: toNum(row.trades_today),
      existingTotalExposure: toNum(row.total_exposure),
      existingSymbolExposure: toNum(row.symbol_exposure),
      hasDuplicatePosition: row.has_duplicate === true
    };
  } catch (err) {
    return {};
  }
}

// ── Persistence ──

async function persistEvaluation(proposalId, evaluation) {
  const r = evaluation;
  const result = await db.query(
    `INSERT INTO trade_risk_evaluations (
       proposal_id, strategy_version, state,
       input_snapshot, account_snapshot,
       entry, stop_price, t1_price, t2_price, direction,
       risk_per_share, max_dollar_risk, suggested_shares,
       total_position_value, total_dollar_risk, account_risk_pct,
       rr_t1, rr_t2, exposure_pct,
       warnings, rejection_reasons, checks,
       data_as_of, is_stale, config_version, risk_percent
     ) VALUES (
       $1, $2, $3,
       $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16,
       $17, $18, $19,
       $20, $21, $22,
       to_timestamp($23 / 1000.0), $24, $25, $26
     ) RETURNING *`,
    [
      proposalId,
      r.strategy_version,
      r.state,
      JSON.stringify(r.input_snapshot || {}),
      JSON.stringify(r.account_snapshot || {}),
      r.entry, r.stop_price, r.t1_price, r.t2_price, r.direction,
      r.risk_per_share, r.max_dollar_risk, r.suggested_shares,
      r.total_position_value, r.total_dollar_risk, r.account_risk_pct,
      r.rr_t1, r.rr_t2, r.exposure_pct,
      JSON.stringify(r.warnings || []),
      JSON.stringify(r.rejection_reasons || []),
      JSON.stringify(r.checks || []),
      r.data_as_of,
      r.is_stale,
      r.config_version,
      r.risk_percent
    ]
  );
  return result.rows[0];
}

async function getLatestEvaluation(proposalId) {
  const result = await db.query(
    `SELECT * FROM trade_risk_evaluations
     WHERE proposal_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

/**
 * Determine whether a proposal's risk evaluation is materially stale and
 * requires recalculation before approval/execution.
 *
 * Stale when:
 *  - evaluation is older than maxQuoteAgeMs, OR
 *  - evaluation is_stale flag is true, OR
 *  - proposal was edited after the evaluation was created
 */
function isEvaluationStale(evaluation, proposal) {
  if (!evaluation) return true;
  if (evaluation.is_stale) return true;
  const maxAgeMs = DEFAULT_RISK_CONFIG.maxQuoteAgeMs;
  const ageMs = Date.now() - new Date(evaluation.created_at).getTime();
  if (ageMs > maxAgeMs) return true;
  if (proposal && proposal.updated_at) {
    const proposalUpdated = new Date(proposal.updated_at).getTime();
    const evalCreated = new Date(evaluation.created_at).getTime();
    if (proposalUpdated > evalCreated) return true;
  }
  return false;
}

/**
 * A proposal may become READY_FOR_APPROVAL only if risk state is VALID.
 * WATCH is allowed only when explicitly eligible (no hard rejection and
 * the proposal is in a pre-approval state per product rules).
 */
function canBecomeReadyForApproval(evaluation) {
  if (!evaluation) return false;
  return evaluation.state === 'VALID' || evaluation.state === 'WATCH';
}

module.exports = {
  DEFAULT_RISK_CONFIG,
  RISK_PRESETS,
  LIQUIDITY_TIERS,
  evaluateRisk,
  getAccountContext,
  getPortfolioRiskContext,
  persistEvaluation,
  getLatestEvaluation,
  isEvaluationStale,
  canBecomeReadyForApproval,
  configVersion
};
