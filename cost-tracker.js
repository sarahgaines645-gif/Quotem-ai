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

// GBP per token. Sourced from public Together AI / Anthropic pricing
// pages (April 2026). Keep updated. Per-call cost = (in × inRate) +
// (out × outRate).
//
// Together's rates are quoted in $/million tokens; we convert to
// GBP/token at a static £0.78/$1 (round figure) so the column is
// directly comparable across providers without an exchange API call.
const PRICE_PER_TOKEN = {
    'deepseek-ai/DeepSeek-V4-Pro':       { inGbp: 0.78 / 1_000_000, outGbp: 2.34 / 1_000_000 },
    'Qwen/Qwen3.5-9B':                   { inGbp: 0.16 / 1_000_000, outGbp: 0.55 / 1_000_000 },
    'moonshotai/Kimi-K2.6':              { inGbp: 0.62 / 1_000_000, outGbp: 2.34 / 1_000_000 },
    // Hugging Face Spaces are billed per minute of GPU time, not tokens.
    // For Space calls, set durationMs and use HF_SPACE_GPU_GBP_PER_HOUR.
    '__hf-space__':                      { gpuGbpPerHour: 0.78 },
};

function ratesFor(model) {
    return PRICE_PER_TOKEN[model] || { inGbp: 0, outGbp: 0 };
}

/**
 * Compute estimated GBP cost for a single call.
 */
function computeCost({ model, tokensIn = 0, tokensOut = 0, durationMs = 0, kind = 'tokens' }) {
    if (kind === 'hf-space') {
        const hours = (durationMs || 0) / 3_600_000;
        return hours * (PRICE_PER_TOKEN['__hf-space__'].gpuGbpPerHour || 0);
    }
    const r = ratesFor(model);
    return (tokensIn * (r.inGbp || 0)) + (tokensOut * (r.outGbp || 0));
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
        user: call.user || null,
        tokensIn: call.tokensIn || 0,
        tokensOut: call.tokensOut || 0,
        durationMs: call.durationMs || 0,
        success: call.success !== false,
        error: call.error || null,
        gbp: 0,
    };
    entry.gbp = +computeCost({
        model: entry.model,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        durationMs: entry.durationMs,
        kind: call.kind || 'tokens',
    }).toFixed(8);
    appendLog(entry);
    return entry;
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
    }
    const total = Object.values(groups).reduce((a, g) => a + g.gbp, 0);
    return { total: +total.toFixed(6), groups };
}

function getLogPath() {
    return COST_LOG_FILE;
}

module.exports = { logCall, summarise, computeCost, getLogPath };
