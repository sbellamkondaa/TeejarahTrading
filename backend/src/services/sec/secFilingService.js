const db = require('../../config/database');
const logger = require('../../utils/logger');
const redisCache = require('../../utils/redisCache');
const secClient = require('../secClient');

const CACHE_NAMESPACE = 'sec_filings';
const FILING_FORMS = new Set([
  '10-K',
  '10-Q',
  '8-K',
  'S-1',
  'S-3',
  '424B5',
  'SC 13D',
  'SC 13G',
  '13F-HR',
  '4',
  '10-K/A',
  '10-Q/A',
  '8-K/A'
]);

async function fetchSubmissions(cik) {
  const padded = String(cik).padStart(10, '0');
  const response = await secClient.secFetch(`/submissions/CIK${padded}.json`);

  if (!response.ok) {
    return { ok: false, error: response.error || response.status };
  }

  return { ok: true, data: response.data };
}

function normalizeFilings(submissionsPayload) {
  const recent = submissionsPayload?.filings?.recent;
  if (!recent) return [];

  const forms = recent.form || [];
  const accessionNumbers = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const acceptedDates = recent.acceptanceDateTime || [];
  const reportDates = recent.reportDate || [];
  const primaryDocuments = recent.primaryDocument || [];
  const isXBRL = recent.isXBRL || [];

  const out = [];

  for (let i = 0; i < accessionNumbers.length; i += 1) {
    const formType = forms[i];
    if (!formType) continue;

    const normalizedForm = String(formType).trim().toUpperCase();
    const isAmendment = normalizedForm.endsWith('/A');
    const baseForm = isAmendment ? normalizedForm.slice(0, -2) : normalizedForm;

    if (!FILING_FORMS.has(normalizedForm) && !FILING_FORMS.has(baseForm)) {
      continue;
    }

    out.push({
      accessionNumber: String(accessionNumbers[i]).replace(/-/g, ''),
      formType,
      filingDate: filingDates[i] || null,
      acceptedAt: acceptedDates[i] || null,
      reportDate: reportDates[i] || null,
      primaryDocument: primaryDocuments[i] || null,
      isXbrl: Boolean(isXBRL.i)
    });
  }

  return out;
}

async function upsertFilings(companyId, cik, filings) {
  let inserted = 0;
  let updated = 0;

  for (const filing of filings) {
    const accessionHyphen = `${filing.accessionNumber.slice(0, 10)}-${filing.accessionNumber.slice(10, 12)}-${filing.accessionNumber.slice(12)}`;
    const accessionUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(filing.formType)}&dateb=&owner=include&count=40`;
    const primaryDocUrl = filing.primaryDocument
      ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accessionHyphen.replace(/-/g, '')}/${filing.primaryDocument}`
      : accessionUrl;
    const rawPayload = { ...filing, accessionHyphen, accessionUrl, primaryDocUrl };
    const sourceHash = secClient.hashPayload(rawPayload);

    const isAmendment = String(filing.formType).toUpperCase().endsWith('/A');

    const result = await db.query(`
      INSERT INTO sec_filings (
        company_id,
        cik,
        accession_number,
        form_type,
        filing_date,
        accepted_at,
        report_date,
        primary_document,
        filing_url,
        is_xbrl,
        is_amendment,
        source_hash,
        raw_payload,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (cik, accession_number, form_type) DO UPDATE SET
        filing_date = EXCLUDED.filing_date,
        accepted_at = EXCLUDED.accepted_at,
        report_date = EXCLUDED.report_date,
        primary_document = EXCLUDED.primary_document,
        filing_url = EXCLUDED.filing_url,
        is_xbrl = EXCLUDED.is_xbrl,
        is_amendment = EXCLUDED.is_amendment,
        source_hash = EXCLUDED.source_hash,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = CURRENT_TIMESTAMP
      RETURNING (xmax = 0) AS inserted
    `, [
      companyId,
      cik,
      filing.accessionNumber,
      filing.formType,
      filing.filingDate,
      filing.acceptedAt,
      filing.reportDate,
      filing.primaryDocument,
      primaryDocUrl,
      filing.isXbrl,
      isAmendment,
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

async function ingestFilingsForCik(cik) {
  const companyId = await db.query(
    'SELECT id FROM sec_companies WHERE cik = $1 LIMIT 1',
    [cik]
  );

  if (companyId.rows.length === 0) {
    return { skipped: true, reason: 'company_not_in_map' };
  }

  const submissions = await fetchSubmissions(cik);
  if (!submissions.ok) {
    return { skipped: true, reason: submissions.error };
  }

  const filings = normalizeFilings(submissions.data);
  if (filings.length === 0) {
    return { skipped: true, reason: 'no_relevant_filings' };
  }

  const result = await upsertFilings(companyId.rows[0].id, cik, filings);
  await redisCache.del(CACHE_NAMESPACE, `${cik}:recent`);

  return { ...result, total: filings.length };
}

module.exports = {
  fetchSubmissions,
  normalizeFilings,
  upsertFilings,
  ingestFilingsForCik,
  CACHE_NAMESPACE,
  FILING_FORMS
};
