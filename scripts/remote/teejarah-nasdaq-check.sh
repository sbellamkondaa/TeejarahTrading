#!/bin/sh
set -eu

ACTION="${1:-status}"

case "$ACTION" in
  status)
    echo "=== WORKER FILE ==="
    docker exec teejarah-worker sh -c \
      'test -f /app/backend/src/services/nasdaq/nasdaqClient.js && echo present || echo missing'

    echo
    echo "=== MIGRATION FILE IN APP ==="
    docker exec tradetally-app sh -c \
      'test -f /app/backend/migrations/260_create_market_halts_table.sql && echo present || echo missing'

    echo
    echo "=== DATABASE TABLE ==="
    TABLE="$(
      docker exec tradetally-db \
        psql -U trader -d tradetally -At \
        -c "SELECT COALESCE(to_regclass('public.market_halts')::text, 'missing');"
    )"

    echo "$TABLE"

    echo
    echo "=== DATABASE ROW COUNT ==="

    if [ "$TABLE" = "missing" ] || [ -z "$TABLE" ]; then
      echo "table-missing"
    else
      docker exec tradetally-db \
        psql -U trader -d tradetally -At \
        -c "SELECT count(*) FROM market_halts;"
    fi
    ;;

  parse)
    docker exec -i teejarah-worker node <<'NODE'
const c = require('/app/backend/src/services/nasdaq/nasdaqClient.js');

(async () => {
  try {
    const r = await c.fetchNasdaqHaltsPage();

    console.log(JSON.stringify({
      ok: r.ok,
      status: r.status,
      xmlLength: r.ok && r.xml ? r.xml.length : 0,
      url: r.url
    }, null, 2));

    if (!r.ok) {
      process.exit(1);
    }

    const events = c.parseNasdaqHaltsRss(r.xml);

    console.log(JSON.stringify({
      parsed: events.length,
      sample: events.slice(0, 3).map(e => ({
        symbol: e.symbol,
        halt_type: e.halt_type,
        reason: e.reason,
        exchange: e.exchange,
        halted_at: e.halted_at,
        resume_at: e.resume_at,
        is_resumption: e.is_resumption
      }))
    }, null, 2));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
NODE
    ;;

  db)
    docker exec -i tradetally-db \
      psql -U trader -d tradetally -P pager=off <<'SQL'
SELECT
  count(*) AS rows,
  count(DISTINCT symbol) AS symbols,
  max(halted_at) AS latest_halt
FROM market_halts;

SELECT
  symbol,
  halt_type,
  reason,
  exchange,
  halted_at,
  resume_at,
  is_resumption
FROM market_halts
ORDER BY halted_at DESC
LIMIT 10;

SELECT
  symbol,
  halted_at,
  halt_type,
  count(*)
FROM market_halts
GROUP BY symbol, halted_at, halt_type
HAVING count(*) > 1;
SQL
    ;;

  ingest)
    docker exec -i teejarah-worker node <<'NODE'
const c = require('/app/backend/src/services/nasdaq/nasdaqClient.js');

(async () => {
  try {
    const r = await c.fetchAndIngestNasdaqHalts();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
NODE
    ;;

  *)
    echo "Usage: $0 {status|parse|db|ingest}" >&2
    exit 2
    ;;
esac
