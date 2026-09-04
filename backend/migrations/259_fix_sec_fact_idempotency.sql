CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_company_facts_cik_hash_unique
  ON sec_company_facts (cik, source_hash);
