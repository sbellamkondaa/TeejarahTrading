const db = require('../../config/database');
const logger = require('../../utils/logger');
const redisCache = require('../../utils/redisCache');
const secClient = require('../secClient');

const CACHE_NAMESPACE = 'sec_facts';
const TRACKED_CONCEPTS = new Set([
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'NetIncomeLoss',
  'OperatingIncomeLoss',
  'GrossProfit',
  'Assets',
  'Liabilities',
  'StockholdersEquity',
  'CashAndCashEquivalentsAtCarryingValue',
  'LongTermDebt',
  'LongTermDebtNoncurrent',
  'ShortTermBorrowings',
  'OperatingCashFlow',
  'CapitalExpenditures',
  'PaymentsOfDividends',
  'PaymentsOfDividendsCommonStock',
  'CommonStockSharesOutstanding',
  'WeightedAverageNumberOfSharesOutstandingBasic',
  'WeightedAverageNumberOfDilutedSharesOutstanding',
  'EarningsPerShareBasic',
  'EarningsPerShareDiluted'
]);

async function fetchCompanyFacts(cik) {
  const padded = String(cik).padStart(10, '0');
  const response = await secClient.secFetch(`/api/xbrl/companyfacts/CIK${padded}.json`);

  if (!response.ok) {
    return { ok: false, error: response.error || response.status };
  }

  return { ok: true, data: response.data };
}

function normalizeFacts(factsPayload, cik) {
  if (!factsPayload || !factsPayload.facts) return [];

  const out = [];

  for (const taxonomy of Object.keys(factsPayload.facts)) {
    const taxonomyPayload = factsPayload.facts[taxonomy];
    if (!taxonomyPayload) continue;

    for (const concept of Object.keys(taxonomyPayload)) {
      if (!TRACKED_CONCEPTS.has(concept)) continue;

      const units = taxonomyPayload[concept].units || {};
      for (const unit of Object.keys(units)) {
        const entries = units[unit] || [];
        for (const entry of entries) {
          if (entry && typeof entry.val === 'number') {
            out.push({
              cik,
              taxonomy,
              concept,
              unit,
              fy: entry.fy ?? null,
              fp: entry.fp ?? null,
              form: entry.form ?? null,
              filed: entry.filed ?? null,
              frame: entry.frame ?? null,
              startDate: entry.start ?? null,
              endDate: entry.end ?? null,
              numericValue: entry.val,
              accessionNumber: entry.accn ? String(entry.accn).replace(/-/g, '') : null
            });
          }
        }
      }
    }
  }

  return out;
}

async function upsertFacts(companyId, cik, facts) {
  let inserted = 0;
  let updated = 0;

  for (const fact of facts) {
    const rawPayload = { ...fact };
    const sourceHash = secClient.hashPayload(rawPayload);

    const result = await db.query(`
      INSERT INTO sec_company_facts (
        company_id,
        cik,
        taxonomy,
        concept,
        unit,
        fy,
        fp,
        form,
        filed,
        frame,
        start_date,
        end_date,
        numeric_value,
        accession_number,
        source_hash,
        raw_payload,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
      ON CONFLICT (cik, source_hash) DO UPDATE SET
        numeric_value = EXCLUDED.numeric_value,
        source_hash = EXCLUDED.source_hash,
        raw_payload = EXCLUDED.raw_payload
      RETURNING (xmax = 0) AS inserted
    `, [
      companyId,
      cik,
      fact.taxonomy,
      fact.concept,
      fact.unit,
      fact.fy,
      fact.fp,
      fact.form,
      fact.filed,
      fact.frame,
      fact.startDate,
      fact.endDate,
      fact.numericValue,
      fact.accessionNumber,
      sourceHash,
      JSON.stringify(rawPayload)
    ]);

    if (result.rows[0]?.inserted) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  return { inserted, updated };
}

async function ingestFactsForCik(cik) {
  const companyId = await db.query(
    'SELECT id FROM sec_companies WHERE cik = $1 LIMIT 1',
    [cik]
  );

  if (companyId.rows.length === 0) {
    return { skipped: true, reason: 'company_not_in_map' };
  }

  const facts = await fetchCompanyFacts(cik);
  if (!facts.ok) {
    return { skipped: true, reason: facts.error };
  }

  const normalized = normalizeFacts(facts.data, cik);
  if (normalized.length === 0) {
    return { skipped: true, reason: 'no_tracked_facts' };
  }

  const result = await upsertFacts(companyId.rows[0].id, cik, normalized);
  await redisCache.del(CACHE_NAMESPACE, cik);

  return { ...result, total: normalized.length };
}

module.exports = {
  fetchCompanyFacts,
  normalizeFacts,
  upsertFacts,
  ingestFactsForCik,
  CACHE_NAMESPACE,
  TRACKED_CONCEPTS
};
