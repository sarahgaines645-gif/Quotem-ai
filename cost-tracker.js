/**
 * Q's cost tracker.
 *
 * Every API call Q makes (Together AI, Hugging Face Spaces, anything
 * that costs money) is logged here with model, tokens, duration, the
 * person Q was talking to, and an estimated cost in GBP.
 *
 * The log feeds the /admin/costs page so Sarah can see daily / weekly
 * spend per skill, per model, per person.
 *
 * Prices are estimates kept inline. Update when providers change rates.
 * Cost is computed at log time so historical entries don't shift if
 * rates change later.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// Per-request attribution. server/index.js wraps every authenticated request
// in runAs(person.id, next); any logCall()/logUsage() deeper in a plugin that
// doesn't know the person picks it up from here. Plugins never have to thread
// `person` through six layers just to bill the right user.
const requestContext = new AsyncLocalStorage();
function runAs(userId, fn) {
    return requestContext.run({ user: userId || null }, fn);
}
function currentUser() {
    const store = requestContext.getStore();
    return store && store.user ? store.user : null;
}

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const Q_DATA_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-memory')
    : path.join(__dirname, 'data');

const COST_LOG_FILE = path.join(Q_DATA_DIR, 'cost-log.json');

try {
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[q/cost] could not create data dir:', e.message);
}

// ── PRICE TABLE ────────────────────────────────────────────────────
// USD per MILLION tokens, straight off each provider's own public pricing
// page. Every row carries the URL and the date it was read. A model that is
// NOT in this table (or has null rates) is logged as `unpriced` — with a
// loud console line — never silently as £0. Sarah's rule: no speculative
// figures. If you cannot verify a price on the provider's page, put null.
//
// Anthropic input tokens are billed in three buckets (base / cache write /
// cache read). We price them separately when the response reports them:
// cache write = 1.25x base (5-minute), cache read = 0.1x base — from
// https://platform.claude.com/docs/en/about-claude/pricing (read 2026-08-15).
const PRICE_USD_PER_MTOK = {
    // ── Together AI ── https://www.together.ai/pricing (read 2026-08-15)
    'deepseek-ai/DeepSeek-V4-Pro':       { in: 1.74, out: 3.48 },   // "Input $1.74 ($0.20 cached) | output $3.48"
    'zai-org/GLM-5.2':                   { in: 1.40, out: 4.40 },   // "Input $1.40 ($0.26 cached) | output $4.40"
    'Qwen/Qwen3.5-9B':                   { in: 0.17, out: 0.25 },   // "Input $0.17 | output $0.25"
    // Kimi K2.5: NOT listed on together.ai/pricing and the model page
    // (together.ai/models/kimi-k2-5) says "not available on Together's
    // Serverless API" as of 2026-08-15. Third-party trackers quote a figure
    // but that is not the provider's page → unpriced until Together lists it.
    'moonshotai/Kimi-K2.5':              { in: null, out: null },
    // Together embeddings — https://docs.together.ai/docs/serverless-models (read 2026-08-15)
    'intfloat/multilingual-e5-large-instruct': { in: 0.02, out: 0 },

    // ── Anthropic ── https://platform.claude.com/docs/en/about-claude/pricing (read 2026-08-15)
    'claude-opus-4-8':                   { in: 5.00, out: 25.00 },  // "$5 / MTok … $25 / MTok"
    'claude-sonnet-5':                   { in: 2.00, out: 10.00 },  // "$2 / MTok … $10 / MTok" — page states the launch intro price is now standard
    'claude-sonnet-4-6':                 { in: 3.00, out: 15.00 },  // "$3 / MTok … $15 / MTok"

    // ── Google Gemini ── https://ai.google.dev/gemini-api/docs/pricing (read 2026-08-15), paid tier, standard
    'gemini-2.5-flash':                  { in: 0.30, out: 2.50 },   // "Input $0.30 (text / image / video)", "Output $2.50" (output incl. thinking tokens)
    'gemini-2.5-flash-preview-tts':      { in: 0.50, out: 10.00 },  // "Input $0.50 (text)", "Output $10.00 (audio)"

    // ── OpenAI ── https://developers.openai.com/api/docs/pricing (read 2026-08-15)
    // gpt-image-1: "Text input $5.00 / Image input $10.00 / Image output $40.00" per 1M tokens.
    // The images API reports usage.input_tokens (text+image) and output_tokens
    // (image). We bill input at the text rate and output at the image-output rate;
    // when input_tokens_details.image_tokens is present it is billed at $10.
    'gpt-image-1':                       { in: 5.00, out: 40.00, imageIn: 10.00 },
};

// Static conversion so the £ column is comparable across providers without
// an FX API call. Every log entry ALSO stores the raw USD figure, so the
// pounds can be recomputed if this rate is ever revised.
const GBP_PER_USD = 0.78;

// Hugging Face Spaces are billed per minute of GPU time, not tokens.
// For Space calls, set durationMs and kind:'hf-space'.
const HF_SPACE_GPU_GBP_PER_HOUR = 0.78;

// Model ids that reach us with a provider prefix / date suffix / casing
// differences still need to hit the table.
function normaliseModel(model) {
    const m = String(model || '').trim();
    if (!m) return '';
    if (PRICE_USD_PER_MTOK[m]) return m;
    // Anthropic date-suffixed ids (claude-sonnet-4-6-20260101 → claude-sonnet-4-6)
    const anth = m.match(/^(claude-[a-z]+-\d(?:-\d)?)/);
    if (anth && PRICE_USD_PER_MTOK[anth[1]]) return anth[1];
    // Gemini "models/gemini-2.5-flash"
    if (m.startsWith('models/') && PRICE_USD_PER_MTOK[m.slice(7)]) return m.slice(7);
    return m;
}

function ratesFor(model) {
    return PRICE_USD_PER_MTOK[normaliseModel(model)] || null;
}

const warnedUnpriced = new Set();

/**
 * Compute estimated cost for a single call.
 * Returns { usd, gbp, priced } — priced=false means the model has no verified
 * rate (usd/gbp are 0 AND the entry is flagged `unpriced` in the log).
 */
function computeCost({ model, tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheWrite = 0, imageTokensIn = 0, durationMs = 0, kind = 'tokens' }) {
    if (kind === 'hf-space') {
        const hours = (durationMs || 0) / 3_600_000;
        const gbp = hours * HF_SPACE_GPU_GBP_PER_HOUR;
        return { usd: gbp / GBP_PER_USD, gbp, priced: true };
    }
    const r = ratesFor(model);
    if (!r || r.in == null || r.out == null) {
        return { usd: 0, gbp: 0, priced: false };
    }
    const M = 1_000_000;
    let usd = 0;
    // Anthropic: usage.input_tokens EXCLUDES cached tokens; they arrive as
    // cache_read_input_tokens / cache_creation_input_tokens. Together/OpenAI/
    // Gemini report a single prompt count and callers leave cache* at 0.
    const plainIn = Math.max(0, tokensIn - imageTokensIn);
    usd += plainIn * r.in / M;
    usd += imageTokensIn * (r.imageIn != null ? r.imageIn : r.in) / M;
    usd += cacheRead * (r.in * 0.1) / M;
    usd += cacheWrite * (r.in * 1.25) / M;
    usd += tokensOut * r.out / M;
    return { usd, gbp: usd * GBP_PER_USD, priced: true };
}

/**
 * Pull token counts out of ANY provider's response JSON so callers don't
 * have to know whose shape they got back:
 *   Together / OpenAI chat  → usage.prompt_tokens / completion_tokens
 *   OpenAI images           → usage.input_tokens / output_tokens (+ input_tokens_details.image_tokens)
 *   Anthropic               → usage.input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 *   Gemini                  → usageMetadata.promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount)
 */
function usageFrom(data) {
    const out = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, imageTokensIn: 0, found: false };
    if (!data || typeof data !== 'object') return out;
    const u = data.usage;
    if (u && typeof u === 'object') {
        out.found = true;
        out.tokensIn  = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
        out.tokensOut = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
        out.cacheRead  = Number(u.cache_read_input_tokens || 0) || 0;
        out.cacheWrite = Number(u.cache_creation_input_tokens || 0) || 0;
        out.imageTokensIn = Number(u.input_tokens_details?.image_tokens || 0) || 0;
        return out;
    }
    const g = data.usageMetadata;
    if (g && typeof g === 'object') {
        out.found = true;
        out.tokensIn  = Number(g.promptTokenCount || 0) || 0;
        // Gemini bills thinking tokens as output; candidatesTokenCount excludes them.
        out.tokensOut = (Number(g.candidatesTokenCount || 0) || 0) + (Number(g.thoughtsTokenCount || 0) || 0);
        return out;
    }
    return out;
}

function loadLog() {
    try {
        if (!fs.existsSync(COST_LOG_FILE)) return [];
        const data = fs.readFileSync(COST_LOG_FILE, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[q/cost] load error:', e.message);
        return [];
    }
}

function appendLog(entry) {
    try {
        const log = loadLog();
        log.push(entry);
        // Cap at 50,000 entries to avoid unbounded growth on the volume.
        const capped = log.length > 50000 ? log.slice(-50000) : log;
        fs.writeFileSync(COST_LOG_FILE, JSON.stringify(capped), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/cost] append error:', e.message);
        return false;
    }
}

/**
 * Log a single API call. Call this from any plugin that hits a paid
 * endpoint, regardless of provider.
 *
 * @param {object} call
 * @param {string} call.skill          - which Q skill made the call (chat/agent/code/image-gen/...)
 * @param {string} call.provider       - 'together' | 'huggingface' | 'anthropic' | ...
 * @param {string} call.model          - model id, or '__hf-space__' for Space calls
 * @param {string} [call.user]         - person id Q was talking to ('q' for Q internal calls)
 * @param {number} [call.tokensIn]
 * @param {number} [call.tokensOut]
 * @param {number} [call.durationMs]
 * @param {'tokens'|'hf-space'} [call.kind]
 * @param {boolean} [call.success]
 * @param {string} [call.error]
 */
function logCall(call) {
    const entry = {
        ts: new Date().toISOString(),
        skill: call.skill || 'unknown',
        provider: call.provider || 'unknown',
        model: call.model || '',
        user: call.user || currentUser(),
        tokensIn: call.tokensIn || 0,
        tokensOut: call.tokensOut || 0,
        cacheRead: call.cacheRead || 0,
        cacheWrite: call.cacheWrite || 0,
        durationMs: call.durationMs || 0,
        success: call.success !== false,
        error: call.error || null,
        usd: 0,
        gbp: 0,
        unpriced: false,
    };
    const cost = computeCost({
        model: entry.model,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
        imageTokensIn: call.imageTokensIn || 0,
        durationMs: entry.durationMs,
        kind: call.kind || 'tokens',
    });
    entry.usd = +cost.usd.toFixed(8);
    entry.gbp = +cost.gbp.toFixed(8);
    entry.unpriced = !cost.priced;
    if (entry.unpriced && entry.model && !warnedUnpriced.has(entry.model)) {
        warnedUnpriced.add(entry.model);
        console.warn(`[q/cost] unpriced model "${entry.model}" (${entry.provider}) — add a VERIFIED rate to PRICE_USD_PER_MTOK in cost-tracker.js; logging tokens with £0 until then`);
    }
    appendLog(entry);
    return entry;
}

/**
 * The one-liner every LLM caller uses. Pass the raw response JSON (any
 * provider) and the start time; token counts and cost are worked out here.
 *
 *   const started = Date.now();
 *   const data = await res.json();
 *   logUsage({ skill: 'writer', provider: 'together', model, data, started });
 *
 * `user` is optional — falls back to the request's signed-in person (runAs).
 * On a failed call pass { success:false, error } and whatever `data` you have.
 */
function logUsage({ skill, provider, model, data, started, user, success = true, error = null, kind = 'tokens', tokensIn, tokensOut }) {
    const u = usageFrom(data);
    return logCall({
        skill,
        provider,
        model,
        user,
        tokensIn: tokensIn != null ? tokensIn : u.tokensIn,
        tokensOut: tokensOut != null ? tokensOut : u.tokensOut,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        imageTokensIn: u.imageTokensIn,
        durationMs: started ? Date.now() - started : 0,
        success,
        error: error || (!u.found && success && kind === 'tokens' ? 'usage-missing-in-response' : null),
        kind,
    });
}

function summarise({ since, until, groupBy = 'skill' } = {}) {
    const log = loadLog();
    const filtered = log.filter(e => {
        if (since && e.ts < since) return false;
        if (until && e.ts > until) return false;
        return true;
    });
    const groups = {};
    for (const e of filtered) {
        const key = e[groupBy] || 'unknown';
        if (!groups[key]) groups[key] = { count: 0, tokensIn: 0, tokensOut: 0, gbp: 0 };
        groups[key].count++;
        groups[key].tokensIn += e.tokensIn;
        groups[key].tokensOut += e.tokensOut;
        groups[key].gbp += e.gbp;
        if (e.unpriced) groups[key].unpriced = (groups[key].unpriced || 0) + 1;
    }
    const total = Object.values(groups).reduce((a, g) => a + g.gbp, 0);
    return { total: +total.toFixed(6), groups };
}

function getLogPath() {
    return COST_LOG_FILE;
}

module.exports = {
    logCall, logUsage, usageFrom, summarise, computeCost, getLogPath,
    runAs, currentUser, ratesFor, PRICE_USD_PER_MTOK, GBP_PER_USD,
};
