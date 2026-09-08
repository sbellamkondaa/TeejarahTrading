/**
 * SEC Event Source — reads recently-ingested SEC filings from the existing
 * sec_filings table (populated by secIngestionScheduler) and projects them
 * into the market_events store. Does NOT duplicate SEC fetching logic.
 *
 * Only surfaces forms material enough to act as catalysts (8-K, 10-K, 10-Q,
 * S-1, S-3, 424B5, SC 13D/G, Form 4). Looks back 24 hours to keep the event
 * stream fresh without re-importing history on every cycle.
 */

const db = require('../../../config/database');
const { SOURCE_TIERS, MATERIAL_FORMS, OFFERING_FORMS } = require('../eventTypes');

const NAME = 'sec_filings';
const TIER = SOURCE_TIERS.PRIMARY;
const LOOKBACK_HOURS = 24;

function isEnabled() {
  return String(process.env.ENABLE_SEC_EVENT_SOURCE ?? 'true').toLowerCase() === 'true';
}

function name() { return NAME; }
function sourceTier() { return TIER; }

async function fetchRecent() {
  if (!isEnabled()) return { items: [], fetched: 0 };

  const result = await db.query(
    `SELECT sc.ticker, sf.form_type, sf.filing_date, sf.accepted_at, sf.filing_url, sc.company_name
     FROM sec_filings sf
     JOIN sec_companies sc ON sc.id = sf.company_id
     WHERE sf.accepted_at >= NOW() - make_interval($1::int)
     ORDER BY sf.accepted_at DESC NULLS LAST
     LIMIT 200`,
    [LOOKBACK_HOURS]
  );

  const items = [];
  for (const row of result.rows) {
    const form = String(row.form_type || '').toUpperCase();
    // Only material/offering/insider forms are events; other filings are not
    // surfaced as market events to avoid noise.
    if (!MATERIAL_FORMS.has(form) && !OFFERING_FORMS.has(form) && form !== '4' && form !== '4/A') {
      continue;
    }
    const sourceEventId = `sec:${row.ticker}:${form}:${row.accepted_at || row.filing_date}`;
    items.push({
      source: NAME,
      source_event_id: sourceEventId,
      source_tier: TIER,
      source_url: row.filing_url || null,
      published_at: row.accepted_at || row.filing_date || null,
      headline: `${row.ticker} ${form} filing`,
      summary: row.company_name ? `${row.company_name} (${row.ticker}) filed ${form}` : null,
      sec_form_type: form,
      symbols: [row.ticker],
      is_primary: true,
      raw_payload: {
        form_type: form,
        filing_date: row.filing_date,
        accepted_at: row.accepted_at,
        company_name: row.company_name
      }
    });
  }

  return { items, fetched: items.length };
}

module.exports = { name, sourceTier, isEnabled, fetchRecent };
