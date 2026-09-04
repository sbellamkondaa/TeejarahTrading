CREATE TABLE IF NOT EXISTS sec_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cik VARCHAR(10) NOT NULL,
  ticker VARCHAR(20),
  company_name TEXT NOT NULL,
  exchange VARCHAR(32),
  sic VARCHAR(16),
  sic_description TEXT,
  fiscal_year_end VARCHAR(8),
  tickers_last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sec_companies_cik_unique UNIQUE (cik)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_companies_ticker_unique
  ON sec_companies (UPPER(ticker))
  WHERE ticker IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sec_companies_ticker
  ON sec_companies (ticker);

CREATE TABLE IF NOT EXISTS sec_filings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES sec_companies(id) ON DELETE CASCADE,
  cik VARCHAR(10) NOT NULL,
  accession_number VARCHAR(32) NOT NULL,
  form_type VARCHAR(32) NOT NULL,
  filing_date DATE,
  accepted_at TIMESTAMPTZ,
  report_date DATE,
  period_start DATE,
  period_end DATE,
  primary_document TEXT,
  filing_url TEXT NOT NULL,
  is_xbrl BOOLEAN NOT NULL DEFAULT FALSE,
  is_amendment BOOLEAN NOT NULL DEFAULT FALSE,
  source_hash CHAR(64) NOT NULL,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sec_filings_accession_unique
    UNIQUE (cik, accession_number, form_type)
);

CREATE INDEX IF NOT EXISTS idx_sec_filings_company_date
  ON sec_filings (company_id, filing_date DESC);

CREATE INDEX IF NOT EXISTS idx_sec_filings_form_date
  ON sec_filings (form_type, filing_date DESC);

CREATE INDEX IF NOT EXISTS idx_sec_filings_cik
  ON sec_filings (cik);

CREATE TABLE IF NOT EXISTS sec_company_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES sec_companies(id) ON DELETE CASCADE,
  cik VARCHAR(10) NOT NULL,
  taxonomy VARCHAR(64) NOT NULL,
  concept VARCHAR(255) NOT NULL,
  unit VARCHAR(64) NOT NULL,
  fy INTEGER,
  fp VARCHAR(16),
  form VARCHAR(32),
  filed DATE,
  frame VARCHAR(32),
  start_date DATE,
  end_date DATE,
  numeric_value NUMERIC,
  accession_number VARCHAR(32),
  source_hash CHAR(64) NOT NULL,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sec_company_facts_unique
    UNIQUE (
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
      accession_number
    )
);

CREATE INDEX IF NOT EXISTS idx_sec_facts_company_concept
  ON sec_company_facts (company_id, concept);

CREATE INDEX IF NOT EXISTS idx_sec_facts_filed
  ON sec_company_facts (filed DESC);

CREATE INDEX IF NOT EXISTS idx_sec_facts_cik
  ON sec_company_facts (cik);
