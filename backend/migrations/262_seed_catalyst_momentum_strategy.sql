-- Seed the Catalyst Momentum + VWAP Reclaim strategy definition.
-- Additive — only inserts if it doesn't already exist.

INSERT INTO trading_strategies (name, version, description, config, status)
SELECT 'catalyst_momentum_vwap_reclaim', 1,
  'Catalyst Momentum + VWAP Reclaim: long entries on VWAP reclaim with verified catalyst. 5-min primary timeframe, daily context. Entry modes: reclaim breakout or VWAP retest/hold.',
  '{
    "minPrice": 5,
    "minAvgDailyVolume": 1000000,
    "minGapPct": 3.0,
    "minRvol": 2.0,
    "maxSpreadPct": 0.5,
    "minRrToT1": 2.0,
    "minCatalystStrength": 30,
    "maxVwapDistancePct": 5,
    "minVwapDistancePct": 0.1,
    "stopAtrMultiplier": 1.5,
    "t1RrTarget": 2.0,
    "t2RrTarget": 4.0,
    "runnerRrTarget": 8.0,
    "maxProposals": 5,
    "excludeOtc": true,
    "timeframe": "5min",
    "supportingTimeframes": ["1min", "15min", "daily"]
  }'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM trading_strategies WHERE name = 'catalyst_momentum_vwap_reclaim' AND version = 1
);