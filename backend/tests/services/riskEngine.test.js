// Deterministic unit tests for riskEngine.evaluateRisk.
// Pure: same inputs → same outputs. No I/O, no fabrication.

const {
  evaluateRisk,
  DEFAULT_RISK_CONFIG,
  RISK_PRESETS,
  LIQUIDITY_TIERS,
  canBecomeReadyForApproval,
  isEvaluationStale
} = require('../../src/services/trading/riskEngine');

// Base input: entry 50, stop 47, t1 55 → price risk 3 + 0.01 slip = 3.01
// 1% of 100k = 1000 → qty = floor(1000/3.01) = 332
// notional = 332*50 = 16600 = 16.6% (under 25% max), R:R T1 = 5/3.01 = 1.66 (>= 1.5)
const base = {
  entryPrice: 50,
  stopPrice: 47,
  t1Price: 55,
  direction: 'long',
  accountEquity: 100000
};

describe('riskEngine — sizing formula', () => {
  test('computes suggested shares from risk % formula', () => {
    const r = evaluateRisk(base);
    expect(r.state).not.toBe('REJECTED');
    expect(r.suggested_shares).toBe(332);
    expect(r.risk_per_share).toBe(3.01);
    expect(r.max_dollar_risk).toBe(1000);
    expect(r.total_dollar_risk).toBe(Math.round(332 * 3.01 * 100) / 100);
    expect(r.total_position_value).toBe(16600);
    expect(r.account_risk_pct).toBeCloseTo(1.0, 1);
    expect(r.rr_t1).toBeCloseTo(1.66, 1); // (55-50)/3.01
  });

  test('includes slippage + fees in per-share risk', () => {
    const r = evaluateRisk(base, { slippagePerShare: 0.05, feesPerShare: 0.02 });
    expect(r.risk_per_share).toBe(3.07);
    expect(r.suggested_shares).toBe(325);
  });

  test('respects custom riskPercent preset', () => {
    // 0.5% of 100k = 500 → qty = floor(500/3.01) = 166
    const r = evaluateRisk(base, { riskPercent: 0.5 });
    expect(r.suggested_shares).toBe(166);
  });

  test('never increases shares above deterministic result', () => {
    // Even with a preset that would allow more, max position % caps it.
    const r = evaluateRisk(base, { riskPercent: 1.0, maxPositionPct: 10 });
    // notional 16600 > 10% (10000) → REJECTED
    expect(r.state).toBe('REJECTED');
  });
});

describe('riskEngine — VALID / WATCH / REJECTED states', () => {
  test('WATCH when only required inputs provided (optional checks skip)', () => {
    const r = evaluateRisk(base);
    expect(r.state).toBe('WATCH');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('VALID when all hard-check data is provided and passes', () => {
    const r = evaluateRisk({
      ...base,
      spreadPct: 0.05,
      liquidityRating: 'moderate',
      avgDailyVolume: 5_000_000,
      rvol: 2,
      halted: false,
      dilutionLevel: 'LOW',
      buyingPower: 50000,
      dailyLossSoFar: 0,
      weeklyLossSoFar: 0,
      openPositionsCount: 1,
      pendingEntriesCount: 0,
      tradesTodayCount: 1,
      consecutiveLosses: 0,
      hasDuplicatePosition: false,
      existingTotalExposure: 0,
      existingSectorExposure: 0,
      quoteAgeMs: 5000
    });
    expect(r.state).toBe('VALID');
    expect(r.warnings.length).toBe(0);
  });
});

describe('riskEngine — hard rejections', () => {
  test('rejects missing entry', () => {
    const r = evaluateRisk({ ...base, entryPrice: null });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/entry/i);
  });

  test('rejects missing stop', () => {
    const r = evaluateRisk({ ...base, stopPrice: null });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/stop/i);
  });

  test('rejects stop on wrong side for long', () => {
    const r = evaluateRisk({ ...base, stopPrice: 51 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/wrong side/i);
  });

  test('rejects negative reward to T1', () => {
    const r = evaluateRisk({ ...base, t1Price: 49 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/wrong side|negative reward/i);
  });

  test('rejects min R:R T1 not satisfied', () => {
    const r = evaluateRisk({ ...base, t1Price: 51, stopPrice: 49 });
    // risk = 1.01, reward = 1 → rr 0.99 < 1.5 → reject
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/minimum/i);
  });

  test('rejects penny stock (price < min)', () => {
    const r = evaluateRisk({ ...base, entryPrice: 4, stopPrice: 3.5 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/penny/i);
  });

  test('rejects max position % exceeded', () => {
    const r = evaluateRisk({ ...base, stopPrice: 49.9, t1Price: 51 });
    // risk = 0.1+0.01=0.11 → qty = floor(1000/0.11)=9090 → notional 454500 >> 25%
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/position %/i);
  });

  test('rejects excessive spread', () => {
    const r = evaluateRisk({ ...base, spreadPct: 0.6 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/spread/i);
  });

  test('rejects halted security', () => {
    const r = evaluateRisk({ ...base, halted: true });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/halt/i);
  });

  test('rejects HIGH dilution risk', () => {
    const r = evaluateRisk({ ...base, dilutionLevel: 'HIGH' });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/dilution/i);
  });

  test('rejects stale data', () => {
    const r = evaluateRisk({ ...base, quoteAgeMs: 120000 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/stale/i);
    expect(r.is_stale).toBe(true);
  });

  test('rejects insufficient buying power when provided', () => {
    const r = evaluateRisk({ ...base, buyingPower: 1000 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/buying power/i);
  });

  test('rejects max daily loss exceeded', () => {
    const r = evaluateRisk({ ...base, dailyLossSoFar: 5500 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/daily loss/i);
  });

  test('rejects max weekly loss exceeded', () => {
    // max weekly = 12% of 100k = 12000. 11500 + 999 > 12000 → reject
    const r = evaluateRisk({ ...base, weeklyLossSoFar: 11500 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/weekly loss/i);
  });

  test('rejects max open positions reached', () => {
    const r = evaluateRisk({ ...base, openPositionsCount: 10 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/open position/i);
  });

  test('rejects max pending entries reached', () => {
    const r = evaluateRisk({ ...base, pendingEntriesCount: 5 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/pending/i);
  });

  test('rejects max trades per day', () => {
    const r = evaluateRisk({ ...base, tradesTodayCount: 10 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/trades per day/i);
  });

  test('rejects max consecutive losses', () => {
    const r = evaluateRisk({ ...base, consecutiveLosses: 5 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/consecutive/i);
  });

  test('rejects duplicate position when not allowed', () => {
    const r = evaluateRisk({ ...base, hasDuplicatePosition: true });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/duplicate/i);
  });

  test('rejects liquidity below minimum', () => {
    const r = evaluateRisk({ ...base, liquidityRating: 'very_low' });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/liquidity/i);
  });

  test('rejects ADV below minimum', () => {
    const r = evaluateRisk({ ...base, avgDailyVolume: 500000 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/ADV/i);
  });

  test('rejects RVOL below minimum', () => {
    const r = evaluateRisk({ ...base, rvol: 0.5 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/RVOL/i);
  });

  test('rejects participation rate over max', () => {
    // Lower minAdv so ADV passes but participation still exceeds 10%.
    // qty=332, adv=1000 → 33.2% > 10%
    const r = evaluateRisk({ ...base, avgDailyVolume: 1000 }, { minAdv: 100 });
    expect(r.state).toBe('REJECTED');
    expect(r.rejection_reasons.join(' ')).toMatch(/participation/i);
  });
});

describe('riskEngine — short direction', () => {
  test('sizes short correctly with stop above entry', () => {
    const r = evaluateRisk({ ...base, direction: 'short', stopPrice: 53, t1Price: 41 });
    expect(r.state).not.toBe('REJECTED');
    expect(r.suggested_shares).toBe(332);
  });
});

describe('riskEngine — determinism + reproducibility', () => {
  test('same inputs produce identical outputs', () => {
    const a = evaluateRisk(base);
    const b = evaluateRisk(base);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('config_version is deterministic for same config', () => {
    const a = evaluateRisk(base);
    const b = evaluateRisk(base);
    expect(a.config_version).toBe(b.config_version);
  });

  test('input_snapshot preserved for reproducibility', () => {
    const r = evaluateRisk(base);
    expect(r.input_snapshot.entryPrice).toBe(50);
    expect(r.input_snapshot.accountEquity).toBe(100000);
  });
});

describe('riskEngine — presets + config', () => {
  test('RISK_PRESETS contains 0.25, 0.50, 1.00', () => {
    expect(RISK_PRESETS).toEqual([0.25, 0.50, 1.00]);
  });

  test('LIQUIDITY_TIERS ordered low to high', () => {
    expect(LIQUIDITY_TIERS).toEqual(['very_low', 'low', 'moderate', 'high']);
  });

  test('DEFAULT_RISK_CONFIG has conservative defaults', () => {
    expect(DEFAULT_RISK_CONFIG.riskPercent).toBe(1.0);
    expect(DEFAULT_RISK_CONFIG.maxPositionPct).toBe(25);
    expect(DEFAULT_RISK_CONFIG.maxParticipationRate).toBe(0.10);
    expect(DEFAULT_RISK_CONFIG.minRrT1).toBe(1.5);
    expect(DEFAULT_RISK_CONFIG.minPrice).toBe(5);
  });
});

describe('riskEngine — approval gate helpers', () => {
  test('canBecomeReadyForApproval true for VALID', () => {
    expect(canBecomeReadyForApproval({ state: 'VALID' })).toBe(true);
  });

  test('canBecomeReadyForApproval true for WATCH', () => {
    expect(canBecomeReadyForApproval({ state: 'WATCH' })).toBe(true);
  });

  test('canBecomeReadyForApproval false for REJECTED', () => {
    expect(canBecomeReadyForApproval({ state: 'REJECTED' })).toBe(false);
  });

  test('canBecomeReadyForApproval false for missing', () => {
    expect(canBecomeReadyForApproval(null)).toBe(false);
  });

  test('isEvaluationStale true when no evaluation', () => {
    expect(isEvaluationStale(null, null)).toBe(true);
  });

  test('isEvaluationStale true when is_stale flag set', () => {
    expect(isEvaluationStale({ is_stale: true, created_at: new Date() }, null)).toBe(true);
  });

  test('isEvaluationStale true when proposal updated after eval', () => {
    const evalTime = new Date(Date.now() - 5000);
    const propUpdate = new Date();
    expect(isEvaluationStale({ created_at: evalTime, is_stale: false }, { updated_at: propUpdate })).toBe(true);
  });
});
