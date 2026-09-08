/**
 * AI Advisory Service — PAPER / sandbox only.
 *
 * Provides advisory analysis of a BOUNDED set of scanner candidates and their
 * relevant market events. AI is NOT execution authority: it cannot bypass the
 * deterministic risk engine, place orders, alter approved proposals, or treat
 * social rumors as verified facts.
 *
 * Cost control (critical):
 *  - Never sends the whole universe. The deterministic scanner reduces first.
 *  - AI receives at most MAX_CANDIDATES (default 5) per invocation.
 *  - Compact structured JSON: null/unneeded fields stripped.
 *  - Results cached keyed by symbol/data snapshot/event set (advisoryCache).
 *  - No re-run when underlying data is materially unchanged.
 *  - Uses a cheap OpenRouter model by default (env-configured).
 *  - No premium model automatically; no agent fan-out.
 *
 * Output distinguishes FACTS / DETERMINISTIC_METRICS / EMPIRICAL_STATS /
 * AI_INTERPRETATION / UNVERIFIED_INFORMATION so the UI can label them.
 */

const axios = require('axios');
const logger = require('../../utils/logger');
const advisoryCache = require('./advisoryCache');
const { getEventsForSymbol } = require('../marketIntelligence/eventQueryService');

const MAX_CANDIDATES = parseInt(process.env.AI_ADVISORY_MAX_CANDIDATES || '5', 10) || 5;
const MAX_EVENTS_PER_SYMBOL = 5;
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_ADVISORY_TIMEOUT_MS || '30000', 10) || 30000;
const CACHE_TTL_MS = parseInt(process.env.AI_ADVISORY_CACHE_TTL_MS || '600000', 10) || 600000;

function isEnabled() {
  return Boolean(process.env.OPENROUTER_API_KEY) &&
    String(process.env.ENABLE_AI_ADVISORY ?? 'false').toLowerCase() === 'true';
}

function getModel() {
  return process.env.AI_ADVISORY_MODEL || 'openai/gpt-4o-mini';
}

function getApiUrl() {
  return process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
}

/**
 * Build a compact candidate payload for the LLM. Strips null/unneeded fields.
 */
function buildCandidatePayload(candidate) {
  return {
    symbol: candidate.symbol || null,
    price: candidate.last_price ?? null,
    change_pct: candidate.change_percent ?? null,
    gap_pct: candidate.gap_pct ?? null,
    rvol: candidate.rvol ?? null,
    volume: candidate.volume ?? null,
    classification: candidate.classification || null,
    opportunity_score: candidate.opportunity_score ?? null,
    opportunity_factors: candidate.opportunity_factors || null,
    best_setup: candidate.best_setup
      ? { type: candidate.best_setup.type, score: candidate.best_setup.score, reason: candidate.best_setup.reason }
      : null,
    catalyst_strength: candidate.catalyst_strength ?? null,
    dilution_risk_level: candidate.dilution_risk_level || null,
    liquidity_rating: candidate.liquidity_rating || null
  };
}

/**
 * Fetch relevant events for a symbol (bounded) and build a compact payload.
 */
async function buildEventPayload(symbol) {
  const events = await getEventsForSymbol(symbol, MAX_EVENTS_PER_SYMBOL);
  return events.map((e) => ({
    type: e.event_type,
    source_tier: e.source_tier,
    published_at: e.published_at,
    headline: e.headline,
    materiality: e.materiality,
    verification_state: e.verification_state,
    primary_source: e.primary_source
  }));
}

/**
 * Analyze a shortlist of candidates. Returns advisory analysis with clearly
 * labeled sections. Cached by the compact payload hash.
 *
 * @param {object[]} candidates - scanner results (already ranked)
 * @param {object} [options] - { mode: 'summary'|'compare'|'critique' }
 * @returns {Promise<object>} { analysis, sources, cached, model, mode }
 */
async function analyze(candidates, options = {}) {
  if (!isEnabled()) {
    return {
      enabled: false,
      analysis: null,
      reason: 'AI advisory disabled (ENABLE_AI_ADVISORY not true or OPENROUTER_API_KEY missing)'
    };
  }

  const mode = ['summary', 'compare', 'critique'].includes(options.mode) ? options.mode : 'summary';
  const bounded = (candidates || []).slice(0, MAX_CANDIDATES);
  if (bounded.length === 0) {
    return { enabled: true, analysis: null, reason: 'No candidates provided' };
  }

  // Build compact payloads + events
  const enriched = [];
  for (const c of bounded) {
    let events = [];
    try {
      events = await buildEventPayload(c.symbol);
    } catch (e) { /* never block analysis on event fetch failure */ }
    enriched.push({
      candidate: buildCandidatePayload(c),
      events
    });
  }

  const cachePayload = { mode, enriched };
  let cached = await advisoryCache.get(cachePayload).catch(() => null);
  if (cached) {
    return { enabled: true, analysis: cached.analysis, sources: cached.sources, cached: true, model: getModel(), mode };
  }

  const prompt = buildPrompt(enriched, mode);

  let aiText;
  try {
    aiText = await callLlm(prompt);
  } catch (error) {
    logger.warn('[AI-ADVISORY] LLM call failed: ' + error.message);
    return { enabled: true, analysis: null, error: 'AI call failed: ' + error.message, cached: false, mode };
  }

  const analysis = parseAnalysis(aiText, mode);
  const sources = {
    providers: ['openrouter'],
    model: getModel(),
    candidates_analyzed: bounded.length,
    events_fetched: enriched.reduce((n, e) => n + e.events.length, 0)
  };

  await advisoryCache.set(cachePayload, { analysis, sources }, CACHE_TTL_MS).catch(() => {});

  return { enabled: true, analysis, sources, cached: false, model: getModel(), mode };
}

function buildPrompt(enriched, mode) {
  const system = 'You are Teejarah, an advisory market-intelligence assistant. ' +
    'You analyze deterministic scanner output and verified market events. ' +
    'You are ADVISORY ONLY. You cannot place orders, approve trades, or bypass risk. ' +
    'Never fabricate win probability. Never treat social/unverified reports as confirmed facts. ' +
    'Distinguish FACTS, DETERMINISTIC_METRICS, EMPIRICAL_STATS, AI_INTERPRETATION, and UNVERIFIED_INFORMATION explicitly. ' +
    'Respond as compact JSON with fields: summary (string), per_symbol (array of {symbol, interpretation, key_risks, unverified_notes}), and overall_interpretation (string).';

  const modeInstruction = ({
    summary: 'Summarize each candidate concisely.',
    compare: 'Compare the candidates relative to each other.',
    critique: 'Critique the deterministic trade proposals; identify conflicting evidence and risks.'
  })[mode];

  return JSON.stringify({
    system,
    mode,
    instruction: modeInstruction,
    candidates: enriched
  });
}

async function callLlm(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const response = await axios.post(getApiUrl(), {
    model: getModel(),
    messages: [
      { role: 'system', content: 'Respond only with compact JSON.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 800,
    temperature: 0.2
  }, {
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://journal.teejarah.com',
      'X-Title': 'Teejarah Advisory'
    },
    timeout: REQUEST_TIMEOUT_MS
  });
  return (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content) || '';
}

function parseAnalysis(text, mode) {
  // Try to extract JSON from the response; fall back to raw text.
  if (!text) return { summary: null, raw: null };
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const json = JSON.parse(text.slice(start, end + 1));
      return { ...json, _mode: mode, _format: 'json' };
    }
  } catch { /* fall through */ }
  return { summary: text, _mode: mode, _format: 'text' };
}

module.exports = { analyze, isEnabled, MAX_CANDIDATES, getModel };
