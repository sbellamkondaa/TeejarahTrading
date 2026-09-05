// Tests for calibrationEngine — confidence intervals, evidence quality,
// source separation, strategy version isolation, segmentation, proposal matching.
//
// Pure functions: no I/O, deterministic, no fabrication.

const {
  wilsonInterval,
  evidenceQuality,
  EVIDENCE_THRESHOLDS,
  normalizeObservation,
  computeCalibration,
  calibrateBySource,
  segmentCalibration,
  segmentAll,
  filterByVersion,
  calibrateByVersion,
  calibrateForProposal,
  gapBucket,
  rvolBucket,
  priceBucket,
  timeOfDayBucket,
  emptyCalibration
} = require('../../src/services/trading/calibrationEngine');

// ─── Wilson Confidence Interval ──────────────────────────────────────────

describe('wilsonInterval', () => {
  test('0 wins, 0 samples → null', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  test('0 wins, 10 samples → lower=0, upper > 0', () => {
    const ci = wilsonInterval(0, 10);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(50);
  });

  test('10 wins, 10 samples → lower < 100, upper=100', () => {
    const ci = wilsonInterval(10, 10);
    expect(ci.upper).toBe(100);
    expect(ci.lower).toBeLessThan(100);
    expect(ci.lower).toBeGreaterThan(50);
  });

  test('5 wins, 10 samples → center near 50%', () => {
    const ci = wilsonInterval(5, 10);
    expect(ci.center).toBeCloseTo(50, 0);
    expect(ci.lower).toBeLessThan(ci.center);
    expect(ci.upper).toBeGreaterThan(ci.center);
  });

  test('larger sample → narrower interval', () => {
    const ci10 = wilsonInterval(5, 10);
    const ci100 = wilsonInterval(50, 100);
    const width10 = ci10.upper - ci10.lower;
    const width100 = ci100.upper - ci100.lower;
    expect(width100).toBeLessThan(width10);
  });

  test('never exceeds [0, 100]', () => {
    const ci = wilsonInterval(1, 2);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(100);
  });
});

// ─── Evidence Quality ────────────────────────────────────────────────────

describe('evidenceQuality', () => {
  test('0 → INSUFFICIENT', () => expect(evidenceQuality(0)).toBe('INSUFFICIENT'));
  test('9 → INSUFFICIENT', () => expect(evidenceQuality(9)).toBe('INSUFFICIENT'));
  test('10 → LOW', () => expect(evidenceQuality(10)).toBe('LOW'));
  test('29 → LOW', () => expect(evidenceQuality(29)).toBe('LOW'));
  test('30 → MODERATE', () => expect(evidenceQuality(30)).toBe('MODERATE'));
  test('99 → MODERATE', () => expect(evidenceQuality(99)).toBe('MODERATE'));
  test('100 → STRONG', () => expect(evidenceQuality(100)).toBe('STRONG'));
  test('500 → STRONG', () => expect(evidenceQuality(500)).toBe('STRONG'));
});

// ─── Normalize Observation ───────────────────────────────────────────────

describe('normalizeObservation', () => {
  test('normalizes BACKTEST observation', () => {
    const obs = normalizeObservation({
      r_multiple: 2.0,
      t1_hit: true,
      t2_hit: false,
      stop_hit: false,
      hold_bars: 5,
      hold_seconds: 1500,
      gap_pct: 4.5,
      rvol: 3.2,
      catalyst_strength: 50,
      catalyst_type: 'earnings',
      market_regime: 'uptrend',
      strategy_version: 'v1'
    }, 'BACKTEST');
    expect(obs.source).toBe('BACKTEST');
    expect(obs.rMultiple).toBe(2.0);
    expect(obs.isWin).toBe(true);
    expect(obs.t1Hit).toBe(true);
    expect(obs.strategyVersion).toBe('v1');
  });

  test('normalizes PAPER observation with camelCase', () => {
    const obs = normalizeObservation({
      rMultiple: -1.0,
      t1Hit: false,
      t2Hit: false,
      stopHit: true,
      holdBars: 3,
      holdSeconds: 900,
      strategyVersion: 'v2'
    }, 'PAPER');
    expect(obs.source).toBe('PAPER');
    expect(obs.rMultiple).toBe(-1.0);
    expect(obs.isWin).toBe(false);
    expect(obs.stopHit).toBe(true);
    expect(obs.strategyVersion).toBe('v2');
  });

  test('null r_multiple → isWin from is_win field', () => {
    const obs = normalizeObservation({ is_win: true }, 'BACKTEST');
    expect(obs.rMultiple).toBeNull();
    expect(obs.isWin).toBe(true);
  });
});

// ─── Compute Calibration ─────────────────────────────────────────────────

describe('computeCalibration', () => {
  function makeObs(r, source = 'BACKTEST', version = 'v1', extra = {}) {
    return { rMultiple: r, isWin: r > 0, t1Hit: false, t2Hit: false, stopHit: r < 0, holdBars: 5, holdSeconds: 1500, source, strategyVersion: version, ...extra };
  }

  test('empty observations → empty calibration', () => {
    const c = computeCalibration([]);
    expect(c.sampleSize).toBe(0);
    expect(c.evidenceQuality).toBe('INSUFFICIENT');
    expect(c.confidenceInterval).toBeNull();
    expect(c.winRate).toBe(0);
  });

  test('correct win rate and counts', () => {
    const obs = [
      makeObs(2.0), makeObs(-1.0), makeObs(3.0), makeObs(-1.0)
    ];
    const c = computeCalibration(obs);
    expect(c.sampleSize).toBe(4);
    expect(c.wins).toBe(2);
    expect(c.losses).toBe(2);
    expect(c.winRate).toBe(50);
  });

  test('correct T1/T2/stop hit rates', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: true, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: 4.0, isWin: true, t1Hit: true, t2Hit: true, stopHit: false, holdBars: 10, holdSeconds: 3000, source: 'BACKTEST', strategyVersion: 'v1' }
    ];
    const c = computeCalibration(obs);
    expect(c.t1HitRate).toBeCloseTo(66.7, 0);
    expect(c.t2HitRate).toBeCloseTo(33.3, 0);
    expect(c.stopHitRate).toBeCloseTo(33.3, 0);
  });

  test('correct avg R and median R', () => {
    const obs = [
      makeObs(2.0), makeObs(4.0), makeObs(-1.0), makeObs(-1.0)
    ];
    const c = computeCalibration(obs);
    // avg R = (2+4-1-1)/4 = 1.0
    expect(c.avgR).toBe(1.0);
    // median R: sorted [-1, -1, 2, 4] → (-1+2)/2 = 0.5
    expect(c.medianR).toBe(0.5);
  });

  test('correct expectancy', () => {
    const obs = [makeObs(2.0), makeObs(-1.0)];
    const c = computeCalibration(obs);
    expect(c.expectancyR).toBe(0.5);
    expect(c.cumulativeR).toBe(1.0);
  });

  test('correct profit factor', () => {
    const obs = [makeObs(3.0), makeObs(-1.0), makeObs(-1.0)];
    const c = computeCalibration(obs);
    // PF = 3 / 2 = 1.5
    expect(c.profitFactor).toBe(1.5);
  });

  test('profit factor null when no losses', () => {
    const obs = [makeObs(2.0)];
    const c = computeCalibration(obs);
    expect(c.profitFactor).toBeNull();
  });

  test('correct max drawdown', () => {
    // R sequence: 2, -1, 2, -3, 2
    // Cumulative: 2, 1, 3, 0, 2
    // Peak:       2, 2, 3, 3, 3
    // DD:         0, 1, 0, 3, 1
    const obs = [
      makeObs(2.0), makeObs(-1.0), makeObs(2.0), makeObs(-3.0), makeObs(2.0)
    ];
    const c = computeCalibration(obs);
    expect(c.maxDrawdownR).toBe(3.0);
  });

  test('correct max consecutive losses', () => {
    const obs = [
      makeObs(-1.0), makeObs(-1.0), makeObs(2.0), makeObs(-1.0), makeObs(-1.0), makeObs(-1.0)
    ];
    const c = computeCalibration(obs);
    expect(c.maxConsecutiveLosses).toBe(3);
  });

  test('confidence interval present for n > 0', () => {
    const obs = [makeObs(2.0), makeObs(-1.0)];
    const c = computeCalibration(obs);
    expect(c.confidenceInterval).not.toBeNull();
    expect(c.confidenceInterval.lower).toBeLessThan(c.confidenceInterval.upper);
  });

  test('source counts visible', () => {
    const obs = [
      makeObs(2.0, 'BACKTEST'), makeObs(-1.0, 'BACKTEST'),
      makeObs(1.0, 'PAPER'), makeObs(-1.0, 'PAPER')
    ];
    const c = computeCalibration(obs);
    expect(c.backtestCount).toBe(2);
    expect(c.paperCount).toBe(2);
    expect(c.sources.backtest).toBe(2);
    expect(c.sources.paper).toBe(2);
  });

  test('zero wins → winRate 0, CI lower 0', () => {
    const obs = [makeObs(-1.0), makeObs(-1.0), makeObs(-1.0)];
    const c = computeCalibration(obs);
    expect(c.winRate).toBe(0);
    expect(c.confidenceInterval.lower).toBe(0);
  });

  test('all wins → winRate 100, CI upper 100', () => {
    const obs = [makeObs(2.0), makeObs(2.0), makeObs(2.0)];
    const c = computeCalibration(obs);
    expect(c.winRate).toBe(100);
    expect(c.confidenceInterval.upper).toBe(100);
  });

  test('breakeven trades counted', () => {
    const obs = [makeObs(0), makeObs(2.0)];
    const c = computeCalibration(obs);
    expect(c.breakeven).toBe(1);
    expect(c.wins).toBe(1);
    expect(c.losses).toBe(0);
  });
});

// ─── Source Separation ───────────────────────────────────────────────────

describe('calibrateBySource', () => {
  test('separates BACKTEST and PAPER', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: 1.0, isWin: true, t1Hit: true, t2Hit: false, stopHit: false, holdBars: 7, holdSeconds: 2100, source: 'PAPER', strategyVersion: 'v1' }
    ];
    const result = calibrateBySource(obs);
    expect(result.backtest.sampleSize).toBe(2);
    expect(result.paper.sampleSize).toBe(1);
    expect(result.combined.sampleSize).toBe(3);
    expect(result.backtest.backtestCount).toBe(2);
    expect(result.backtest.paperCount).toBe(0);
    expect(result.paper.paperCount).toBe(1);
    expect(result.paper.backtestCount).toBe(0);
  });
});

// ─── Strategy Version Isolation ──────────────────────────────────────────

describe('filterByVersion', () => {
  test('filters to specific version', () => {
    const obs = [
      { strategyVersion: 'v1', source: 'BACKTEST', rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500 },
      { strategyVersion: 'v2', source: 'BACKTEST', rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900 }
    ];
    const filtered = filterByVersion(obs, 'v1');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].strategyVersion).toBe('v1');
  });

  test('no version filter → all observations', () => {
    const obs = [
      { strategyVersion: 'v1', source: 'BACKTEST', rMultiple: 2.0 },
      { strategyVersion: 'v2', source: 'BACKTEST', rMultiple: -1.0 }
    ];
    expect(filterByVersion(obs, null)).toHaveLength(2);
  });
});

describe('calibrateByVersion', () => {
  test('groups by version, never combines', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: 3.0, isWin: true, t1Hit: true, t2Hit: true, stopHit: false, holdBars: 10, holdSeconds: 3000, source: 'BACKTEST', strategyVersion: 'v2' }
    ];
    const result = calibrateByVersion(obs);
    expect(result['v1'].sampleSize).toBe(2);
    expect(result['v2'].sampleSize).toBe(1);
    expect(Object.keys(result).sort()).toEqual(['v1', 'v2']);
  });
});

// ─── Segmentation ─────────────────────────────────────────────────────────

describe('segmentCalibration', () => {
  test('segments by gapBucket', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1', gapPct: 4 },
      { rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900, source: 'BACKTEST', strategyVersion: 'v1', gapPct: 4 },
      { rMultiple: 4.0, isWin: true, t1Hit: true, t2Hit: true, stopHit: false, holdBars: 10, holdSeconds: 3000, source: 'BACKTEST', strategyVersion: 'v1', gapPct: 12 }
    ];
    const seg = segmentCalibration(obs, 'gapBucket');
    expect(seg['<5%'].sampleSize).toBe(2);
    expect(seg['10%+'].sampleSize).toBe(1);
  });

  test('empty observations → empty object', () => {
    expect(segmentCalibration([], 'gapBucket')).toEqual({});
  });
});

describe('segmentAll', () => {
  test('produces all dimensions', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: true, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1', gapPct: 4, rvol: 3, entryPrice: 50 }
    ];
    const seg = segmentAll(obs);
    expect(seg.gapBucket).toBeDefined();
    expect(seg.rvolBucket).toBeDefined();
    expect(seg.catalystStrengthBucket).toBeDefined();
    expect(seg.priceBucket).toBeDefined();
    expect(seg.timeOfDayBucket).toBeDefined();
    expect(seg.strategyVersion).toBeDefined();
  });
});

// ─── Proposal Feature Matching ────────────────────────────────────────────

describe('calibrateForProposal', () => {
  function makeObs(r, version, setupType, gapPct, rvol, source = 'BACKTEST') {
    return {
      rMultiple: r, isWin: r > 0, t1Hit: false, t2Hit: false, stopHit: r < 0,
      holdBars: 5, holdSeconds: 1500, source, strategyVersion: version,
      setupType, gapPct, rvol, entryPrice: 50
    };
  }

  test('filters by strategy version (strict isolation)', () => {
    const obs = [
      makeObs(2.0, 'v1', 'vwap_reclaim'),
      makeObs(-1.0, 'v2', 'vwap_reclaim')
    ];
    const result = calibrateForProposal(obs, { strategyVersion: 'v1', setupType: 'vwap_reclaim' });
    expect(result.sampleSize).toBe(1);
    expect(result.matchedSampleSize).toBe(1);
  });

  test('returns empty when no matching version', () => {
    const obs = [makeObs(2.0, 'v1', 'vwap_reclaim')];
    const result = calibrateForProposal(obs, { strategyVersion: 'v999', setupType: 'vwap_reclaim' });
    expect(result.sampleSize).toBe(0);
    expect(result.evidenceQuality).toBe('INSUFFICIENT');
  });

  test('prefix match for setup type', () => {
    const obs = [
      makeObs(2.0, 'v1', 'vwap_reclaim_with_catalyst'),
      makeObs(-1.0, 'v1', 'vwap_reclaim_with_catalyst')
    ];
    const result = calibrateForProposal(obs, { strategyVersion: 'v1', setupType: 'vwap_reclaim' });
    expect(result.sampleSize).toBe(2);
  });

  test('advisory only flag', () => {
    const obs = [makeObs(2.0, 'v1', 'vwap_reclaim')];
    const result = calibrateForProposal(obs, { strategyVersion: 'v1', setupType: 'vwap_reclaim' });
    expect(result.advisoryOnly).toBe(true);
  });

  test('narrow by gap bucket when sufficient sample', () => {
    const obs = [];
    for (let i = 0; i < 15; i++) {
      obs.push(makeObs(i % 2 === 0 ? 2.0 : -1.0, 'v1', 'vwap_reclaim', 4, 3));
    }
    for (let i = 0; i < 15; i++) {
      obs.push(makeObs(i % 2 === 0 ? 2.0 : -1.0, 'v1', 'vwap_reclaim', 7, 3));
    }
    const result = calibrateForProposal(obs, { strategyVersion: 'v1', setupType: 'vwap_reclaim', gapPct: 4 });
    // Should narrow to the '<5%' gap bucket (15 obs)
    expect(result.sampleSize).toBeLessThanOrEqual(15);
    expect(result.matchedSampleSize).toBeLessThanOrEqual(15);
  });

  test('does not narrow when sample insufficient', () => {
    const obs = [
      makeObs(2.0, 'v1', 'vwap_reclaim', 4, 3),
      makeObs(-1.0, 'v1', 'vwap_reclaim', 7, 3)
    ];
    const result = calibrateForProposal(obs, { strategyVersion: 'v1', setupType: 'vwap_reclaim', gapPct: 4 });
    // Should NOT narrow (only 2 obs, below LOW threshold)
    expect(result.sampleSize).toBe(2);
  });

  test('source counts visible in proposal calibration', () => {
    const obs = [
      makeObs(2.0, 'v1', 'vwap_reclaim', 4, 3, 'BACKTEST'),
      makeObs(-1.0, 'v1', 'vwap_reclaim', 4, 3, 'PAPER')
    ];
    const result = calibrateForProposal(obs, { strategyVersion: 'v1', setupType: 'vwap_reclaim' });
    expect(result.backtest.sampleSize).toBe(1);
    expect(result.paper.sampleSize).toBe(1);
  });
});

// ─── Deterministic Repeatability ─────────────────────────────────────────

describe('deterministic repeatability', () => {
  test('same observations → same calibration', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: true, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1', gapPct: 4 },
      { rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900, source: 'BACKTEST', strategyVersion: 'v1', gapPct: 4 }
    ];
    const c1 = computeCalibration(obs);
    const c2 = computeCalibration(obs);
    expect(c1).toEqual(c2);
  });
});

// ─── Bucketing ───────────────────────────────────────────────────────────

describe('gapBucket', () => {
  test('<5%', () => expect(gapBucket(4)).toBe('<5%'));
  test('5-10%', () => expect(gapBucket(7)).toBe('5-10%'));
  test('10%+', () => expect(gapBucket(15)).toBe('10%+'));
  test('unknown', () => expect(gapBucket(null)).toBe('unknown'));
});

describe('rvolBucket', () => {
  test('2-5', () => expect(rvolBucket(3)).toBe('2-5'));
  test('5-10', () => expect(rvolBucket(7)).toBe('5-10'));
  test('10+', () => expect(rvolBucket(15)).toBe('10+'));
});

describe('priceBucket', () => {
  test('sub-$5', () => expect(priceBucket(3)).toBe('sub-$5'));
  test('$5-$20', () => expect(priceBucket(10)).toBe('$5-$20'));
  test('$20-$50', () => expect(priceBucket(30)).toBe('$20-$50'));
  test('$50+', () => expect(priceBucket(100)).toBe('$50+'));
});

// ─── No Duplicate Observations ────────────────────────────────────────────

describe('no duplicate observations', () => {
  test('calibration counts each observation once', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1' }
    ];
    const c = computeCalibration(obs);
    expect(c.sampleSize).toBe(2);
    // Even if R values are identical, both are counted
  });

  test('source separation does not double-count', () => {
    const obs = [
      { rMultiple: 2.0, isWin: true, t1Hit: false, t2Hit: false, stopHit: false, holdBars: 5, holdSeconds: 1500, source: 'BACKTEST', strategyVersion: 'v1' },
      { rMultiple: -1.0, isWin: false, t1Hit: false, t2Hit: false, stopHit: true, holdBars: 3, holdSeconds: 900, source: 'PAPER', strategyVersion: 'v1' }
    ];
    const result = calibrateBySource(obs);
    expect(result.backtest.sampleSize + result.paper.sampleSize).toBe(result.combined.sampleSize);
  });
});
