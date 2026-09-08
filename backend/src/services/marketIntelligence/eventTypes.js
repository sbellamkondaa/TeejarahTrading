/**
 * Event Type taxonomy and Source Tier definitions for Market Intelligence V2.
 *
 * Deterministic classification — no LLM. Source tiers are fixed per source
 * adapter; event types are derived from structured fields (SEC form type,
 * halt type, news keywords) using a deterministic classifier.
 */

const EVENT_TYPES = Object.freeze({
  EARNINGS: 'EARNINGS',
  GUIDANCE: 'GUIDANCE',
  FDA: 'FDA',
  CLINICAL_TRIAL: 'CLINICAL_TRIAL',
  SEC_MATERIAL: 'SEC_MATERIAL',
  OFFERING: 'OFFERING',
  ATM: 'ATM',
  S3: 'S3',
  F424B5: '424B5',
  DILUTION: 'DILUTION',
  MERGER_ACQUISITION: 'MERGER_ACQUISITION',
  CONTRACT: 'CONTRACT',
  PARTNERSHIP: 'PARTNERSHIP',
  ANALYST_UPGRADE: 'ANALYST_UPGRADE',
  ANALYST_DOWNGRADE: 'ANALYST_DOWNGRADE',
  PRICE_TARGET: 'PRICE_TARGET',
  INSIDER: 'INSIDER',
  EXECUTIVE_CHANGE: 'EXECUTIVE_CHANGE',
  REGULATORY: 'REGULATORY',
  LITIGATION: 'LITIGATION',
  HALT: 'HALT',
  RESUMPTION: 'RESUMPTION',
  MACRO_FED: 'MACRO_FED',
  MACRO_INFLATION: 'MACRO_INFLATION',
  MACRO_JOBS: 'MACRO_JOBS',
  SECTOR: 'SECTOR',
  SOCIAL_BREAKING: 'SOCIAL_BREAKING',
  GENERAL_NEWS: 'GENERAL_NEWS',
  OPINION: 'OPINION'
});

// Source quality tiers — ordered by trust. Social sources start UNVERIFIED
// and may only be upgraded by corroboration logic, never by default.
const SOURCE_TIERS = Object.freeze({
  PRIMARY: 'PRIMARY',
  HIGH_QUALITY_SECONDARY: 'HIGH_QUALITY_SECONDARY',
  AGGREGATOR: 'AGGREGATOR',
  SOCIAL_VERIFIED: 'SOCIAL_VERIFIED',
  SOCIAL_UNVERIFIED: 'SOCIAL_UNVERIFIED',
  OPINION: 'OPINION'
});

// Verification states. Social/secondary sources default to UNVERIFIED until a
// primary source confirms the same dedup_key.
const VERIFICATION_STATES = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  CORROBORATED: 'CORROBORATED'
});

// Materiality per SEC form type (0-10). Higher = more material to price.
const FORM_MATERIALITY = Object.freeze({
  '8-K': 8, '10-K': 7, '10-Q': 6, 'S-1': 7, 'S-3': 7, '424B5': 8, '424B4': 8,
  'SC 13D': 7, 'SC 13G': 5, '4': 4, '13F-HR': 3,
  '8-K/A': 7, '10-K/A': 6, '10-Q/A': 6, 'S-1/A': 6, 'S-3/A': 6, '424B3': 7
});

const OFFERING_FORMS = new Set(['S-1', 'S-3', 'S-1/A', 'S-3/A', '424B5', '424B4', '424B3']);
const MATERIAL_FORMS = new Set(['8-K', '10-K', '10-Q', '8-K/A', '10-K/A', '10-Q/A', 'SC 13D', 'SC 13G']);

module.exports = {
  EVENT_TYPES,
  SOURCE_TIERS,
  VERIFICATION_STATES,
  FORM_MATERIALITY,
  OFFERING_FORMS,
  MATERIAL_FORMS
};
