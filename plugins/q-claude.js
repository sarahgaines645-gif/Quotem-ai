/**
 * Q CLAUDE — the accuracy brain.
 *
 * One shared caller for the places where being RIGHT matters more than being
 * fast or cheap: reading an assignment brief, marking a student's answer,
 * suggesting real references, teaching a concept. Runs on Claude Opus 4.8
 * (adaptive thinking on) via the same ANTHROPIC_API_KEY the Check button
 * already uses. Everything voice-flavoured (word swaps, reframes) stays on Q.
 *
 * accurateJSON(system, user, { maxTokens, fallback }) — ask Claude for a JSON
 * answer; if Claude is unavailable/unconfigured/fails, run `fallback` (the
 * caller's Q path) so the feature degrades instead of dying.
 */
'use strict';

const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');

// Two tiers, used deliberately (Sarah's design — 19 Jul):
//   OPUS   — the heavy lifting: exam-room marking, brief reading, references.
//   SONNET — the checker: verifies Q-generated quiz batches for pennies.
const MODEL = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-5';

function hasClaude() {
    return !!process.env.ANTHROPIC_API_KEY;
}

// Ask Claude, expect JSON back. Throws on any failure so callers can fall back.
// `effort` matters on Railway: requests must land inside the ~60s proxy
// window (see docs/HANDOVER_2026-05-17 — slow writer calls 502 at the edge).
// Small structured calls should pass effort:'medium' or use SONNET.
// `skill` names the caller in the cost log (writer / revision / …).
async function claudeJSON(systemPrompt, userPrompt, { maxTokens = 4096, model = MODEL, effort = null, schema = null, skill = 'claude', timeoutMs = 120_000 } = {}) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');

    // Budgets passed in were tuned for Q (no thinking). On Claude, adaptive
    // thinking shares max_tokens with the answer — give it real headroom so a
    // 400-token budget doesn't come back as truncated thinking and no JSON.
    const budget = Math.max(maxTokens, 4096);
    const started = Date.now();

    // schema (JSON Schema) → structured outputs: the API guarantees the
    // response parses. Use it on anything big enough to be truncation-prone.
    const outputConfig = {};
    if (effort) outputConfig.effort = effort;
    if (schema) outputConfig.format = { type: 'json_schema', schema };

    const res = await timedFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: budget,
            thinking: { type: 'adaptive' },
            ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: userPrompt }],
        }),
    }, { label: skill, timeoutMs });   // 120s by default; a background JOB (the mark) passes more — a whole essay marked against every criterion is one long answer (Sarah, 18 Aug: 'timed out after 120s')
    console.log(`[q-claude] ${model}${effort ? ' effort=' + effort : ''} → ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (!res.ok) {
        const errText = await res.text();
        logUsage({ skill, provider: 'anthropic', model, started, success: false, error: `HTTP ${res.status}` });
        throw new Error(`Claude upstream ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    // Diagnostics: WRITER_DUMP_DIR=<dir> keeps every raw answer (stop reason,
    // thinking, text) as a file — the only way to see WHY a mark came back thin.
    if (process.env.WRITER_DUMP_DIR) { try { const fs = require('fs'), path = require('path'); fs.mkdirSync(process.env.WRITER_DUMP_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.WRITER_DUMP_DIR, `${skill}-${Date.now()}.json`), JSON.stringify({ model, effort, stop_reason: data.stop_reason, usage: data.usage, content: data.content }, null, 1)); } catch (_) {} }
    logUsage({ skill, provider: 'anthropic', model, data, started });
    if (data.stop_reason === 'refusal') throw new Error('Claude refused the request');
    if (data.stop_reason === 'max_tokens') throw new Error(`Claude response truncated at ${budget} tokens — raise maxTokens`);

    const text = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    if (!text.trim()) throw new Error('Claude returned no text');

    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Claude sometimes wraps JSON in a sentence — cut to the outermost braces/brackets.
    const first = cleaned.search(/[[{]/);
    const last = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    const jsonSlice = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
    return JSON.parse(jsonSlice);
}

// Claude first; if anything goes wrong and a fallback was given, use it.
async function accurateJSON(systemPrompt, userPrompt, { maxTokens = 4096, model = MODEL, effort = null, schema = null, fallback = null, skill = 'claude', timeoutMs } = {}) {
    if (hasClaude()) {
        try {
            return await claudeJSON(systemPrompt, userPrompt, { maxTokens, model, effort, schema, skill, ...(timeoutMs ? { timeoutMs } : {}) });
        } catch (e) {
            console.warn('[q-claude] falling back: ' + e.message);
            if (!fallback) throw e;
            // The fallback ran because Claude failed. If the fallback ALSO
            // fails, keep Claude's cause on the error so the route can show
            // the student both halves ("accuracy service refused the key;
            // the backup timed out") instead of only the last one.
            // The schema goes with it: without it the fallback answers in
            // prose, JSON.parse throws, and every Claude 429/5xx became a 502.
            try {
                return await fallback(systemPrompt, userPrompt, { maxTokens, schema, ...(timeoutMs ? { timeoutMs } : {}) });
            } catch (e2) {
                e2.primaryCause = e.message;
                throw e2;
            }
        }
    } else if (!fallback) {
        throw new Error('ANTHROPIC_API_KEY not set and no fallback given');
    }
    return await fallback(systemPrompt, userPrompt, { maxTokens, schema, ...(timeoutMs ? { timeoutMs } : {}) });
}

module.exports = { hasClaude, claudeJSON, accurateJSON, MODEL, SONNET };
