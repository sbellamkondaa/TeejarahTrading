/**
 * Event Classifier — maps raw source payloads to a canonical EVENT_TYPE and
 * materiality using deterministic rules only (no LLM).
 *
 * Inputs are already-normalized source records (see eventNormalizer). The
 * classifier inspects structured fields (sec_form_type, halt_type, headline
 * keywords) to pick a precise event type.
 */

const { EVENT_TYPES, FORM_MATERIALITY, OFFERING_FORMS, MATERIAL_FORMS } = require('./eventTypes');

// Keyword -> event type. Matched case-insensitively against the headline.
// Order matters: more specific patterns are checked first.
const KEYWORD_RULES = [
  { re: /\bFDA\b|phase\s+[1-3]|clinical\s+trial|pivotal\s+data|endpoint\s+met/i, type: EVENT_TYPES.FDA },
  { re: /\bmerger|acquisition|acquire|buyout|takeover|combine/i, type: EVENT_TYPES.MERGER_ACQUISITION },
  { re: /\bcontract|awarded|order|dept\s+of\s+defense|\bDOD\b/i, type: EVENT_TYPES.CONTRACT },
  { re: /\bpartnership|collaboration|joint\s+venture|pact\b/i, type: EVENT_TYPES.PARTNERSHIP },
  { re: /analyst\s+(upgrade|initiates|reiterates|raises)|upgrade[sd]\s+to\s+buy|overweight/i, type: EVENT_TYPES.ANALYST_UPGRADE },
  { re: /analyst\s+(downgrade|cut[s]?\s+to)|underweight|sell\s+rating/i, type: EVENT_TYPES.ANALYST_DOWNGRADE },
  { re: /price\s+target|target\s+raised|target\s+cut/i, type: EVENT_TYPES.PRICE_TARGET },
  { re: /guidance|raises?\s+outlook|lowers?\s+outlook|preliminary\s+(?:revenue|results)/i, type: EVENT_TYPES.GUIDANCE },
  { re: /earnings\s+(?:beat|miss|report|release|results)|Q[1-4]\s+(?:results|earnings)/i, type: EVENT_TYPES.EARNINGS },
  { re: /\bat-the-market|ATM\s+offering|sales\s+agreement/i, type: EVENT_TYPES.ATM },
  { re: /shelf\s+offering|follow-on\s+offering|public\s+offering|secondary\s+offering/i, type: EVENT_TYPES.OFFERING },
  { re: /dilution|share\s+dilution|stock\s+offering/i, type: EVENT_TYPES.DILUTION },
  { re: /\binsider|form\s+4|section\s+16|director\s+(?:purchase|sale)/i, type: EVENT_TYPES.INSIDER },
  { re: /CEO\s+(?:resigns|steps|named|appointed)|CFO\s+(?:resigns|named)|executive\s+(?:change|departure)/i, type: EVENT_TYPES.EXECUTIVE_CHANGE },
  { re: /\bSEC\b|subpoena|investigation|enforcement|compliance/i, type: EVENT_TYPES.REGULATORY },
  { re: /lawsuit|litigation|class\s+action|settled|verdict/i, type: EVENT_TYPES.LITIGATION },
  { re: /\bfed\b|fomc|interest\s+rate|federal\s+reserve|powell|rate\s+(?:cut|hike|decision)/i, type: EVENT_TYPES.MACRO_FED },
  { re: /cpi|inflation|pce|price\s+index/i, type: EVENT_TYPES.MACRO_INFLATION },
  { re: /jobs\s+report|nonfarm|unemployment|payrolls|employment\s+situation/i, type: EVENT_TYPES.MACRO_JOBS },
  { re: /sector|industry\s+(?:outlook|trend)|semiconductors?|energy\s+(?:stocks|sector)/i, type: EVENT_TYPES.SECTOR },
  { re: /opinion|editorial|commentary|guest\s+post/i, type: EVENT_TYPES.OPINION }
];

/**
 * Classify a normalized event record.
 * @param {object} record - { source, sec_form_type?, halt_type?, headline?, is_resumption? }
 * @returns {{ event_type: string, materiality: number }}
 */
function classify(record) {
  const form = String(record.sec_form_type || '').toUpperCase();
  const headline = record.headline || '';

  // SEC form-driven classification (most precise)
  if (form) {
    if (OFFERING_FORMS.has(form)) {
      // Distinguish ATM/dilution where the headline indicates it
      if (/\bat-the-market|ATM\b/i.test(headline)) {
        return { event_type: EVENT_TYPES.ATM, materiality: FORM_MATERIALITY[form] ?? 7 };
      }
      if (form === 'S-3') return { event_type: EVENT_TYPES.S3, materiality: 7 };
      if (form === '424B5' || form === '424B4' || form === '424B3') {
        return { event_type: EVENT_TYPES.F424B5, materiality: FORM_MATERIALITY[form] ?? 8 };
      }
      return { event_type: EVENT_TYPES.OFFERING, materiality: FORM_MATERIALITY[form] ?? 7 };
    }
    if (form === '4' || form === '4/A') {
      return { event_type: EVENT_TYPES.INSIDER, materiality: FORM_MATERIALITY['4'] };
    }
    if (MATERIAL_FORMS.has(form)) {
      return { event_type: EVENT_TYPES.SEC_MATERIAL, materiality: FORM_MATERIALITY[form] ?? 5 };
    }
  }

  // Halt-driven classification
  if (record.halt_type != null) {
    return {
      event_type: record.is_resumption ? EVENT_TYPES.RESUMPTION : EVENT_TYPES.HALT,
      materiality: 7
    };
  }

  // Keyword-driven classification from headline
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(headline)) {
      return { event_type: rule.type, materiality: defaultMaterialityForType(rule.type) };
    }
  }

  return { event_type: EVENT_TYPES.GENERAL_NEWS, materiality: 5 };
}

function defaultMaterialityForType(type) {
  switch (type) {
    case EVENT_TYPES.FDA:
    case EVENT_TYPES.MERGER_ACQUISITION:
    case EVENT_TYPES.OFFERING:
    case EVENT_TYPES.ATM:
    case EVENT_TYPES.S3:
    case EVENT_TYPES.F424B5:
    case EVENT_TYPES.DILUTION:
      return 8;
    case EVENT_TYPES.EARNINGS:
    case EVENT_TYPES.GUIDANCE:
    case EVENT_TYPES.HALT:
    case EVENT_TYPES.RESUMPTION:
    case EVENT_TYPES.CONTRACT:
    case EVENT_TYPES.PARTNERSHIP:
    case EVENT_TYPES.ANALYST_UPGRADE:
    case EVENT_TYPES.ANALYST_DOWNGRADE:
    case EVENT_TYPES.MACRO_FED:
      return 7;
    case EVENT_TYPES.PRICE_TARGET:
    case EVENT_TYPES.INSIDER:
    case EVENT_TYPES.EXECUTIVE_CHANGE:
    case EVENT_TYPES.REGULATORY:
    case EVENT_TYPES.LITIGATION:
    case EVENT_TYPES.MACRO_INFLATION:
    case EVENT_TYPES.MACRO_JOBS:
      return 6;
    case EVENT_TYPES.SECTOR:
      return 4;
    case EVENT_TYPES.OPINION:
      return 2;
    case EVENT_TYPES.SOCIAL_BREAKING:
      return 4;
    default:
      return 5;
  }
}

module.exports = { classify, defaultMaterialityForType };
