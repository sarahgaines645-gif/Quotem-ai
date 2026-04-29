/**
 * q-lab/quote-builder-pipeline.js
 *
 * Lab Quote Builder pipeline with stage-by-stage tracing.
 * Runs Q's mirror plugins (text-reader → translator → waterfall → picker → checker)
 * and captures input/output of every stage so the UI can show exactly what each
 * stage was given and what it returned.
 *
 * Lab-only: never wired into live routes. Tests run against test inputs only —
 * no customer data ever enters this pipeline.
 *
 * Returned shape:
 * {
 *   input: <original text>,
 *   stages: [
 *     { name, engine, input, output, durationMs, error? },
 *     ...
 *   ],
 *   final: <final priced quote items>,
 *   totalMs: <total time>
 * }
 */
'use strict';

const { readText } = require('./plugins/qwen-text-reader');
const { translateToSOR } = require('./plugins/qwen-translator');
const { pickSOR } = require('./plugins/qwen-sor-picker');
const { checkResults } = require('./plugins/qwen-checker');
// pricing-lookup is data, not engine — q-lab is allowed to call it
const { lookupPricing } = require('../server/templates/pricing-lookup');

const Q_ENGINE = 'Q (DeepSeek V4 Pro via Together AI)';
const WATERFALL_ENGINE = 'lookupPricing (no AI — keyword + vector search on catalogue)';

/**
 * Run the lab Quote Builder pipeline on a single text input.
 * @param {string} input - raw text the user pasted (or a stress-test brief)
 * @returns {Promise<{input, stages, final, totalMs}>}
 */
async function runQuoteBuilderPipeline(input) {
    const t0 = Date.now();
    const stages = [];

    // ── STAGE 1: READER ──────────────────────────────────────────────
    const s1Start = Date.now();
    let items;
    try {
        const readerOut = await readText(input);
        items = Array.isArray(readerOut?.items) ? readerOut.items : [];
        stages.push({
            name: 'Reader',
            engine: Q_ENGINE,
            input: { text: input },
            output: {
                items,
                address: readerOut?.address || null,
                _meta: readerOut?._meta || null,
            },
            durationMs: Date.now() - s1Start,
        });
    } catch (err) {
        stages.push({
            name: 'Reader',
            engine: Q_ENGINE,
            input: { text: input },
            output: null,
            error: err.message,
            durationMs: Date.now() - s1Start,
        });
        return { input, stages, final: [], totalMs: Date.now() - t0, fatal: 'Reader failed' };
    }

    if (items.length === 0) {
        return {
            input,
            stages,
            final: [],
            totalMs: Date.now() - t0,
            note: 'Reader returned 0 items — input was unparseable, vague, or off-catalogue.',
        };
    }

    // ── STAGE 2: TRANSLATOR ──────────────────────────────────────────
    const s2Start = Date.now();
    let tradeTerms;
    try {
        tradeTerms = await translateToSOR(items);
        stages.push({
            name: 'Translator',
            engine: Q_ENGINE,
            input: { items },
            output: { tradeTerms },
            durationMs: Date.now() - s2Start,
        });
    } catch (err) {
        stages.push({
            name: 'Translator',
            engine: Q_ENGINE,
            input: { items },
            output: null,
            error: err.message,
            durationMs: Date.now() - s2Start,
        });
        return { input, stages, final: [], totalMs: Date.now() - t0, fatal: 'Translator failed' };
    }

    // ── STAGES 3+4: WATERFALL + PICKER (per item) ────────────────────
    const finalQuoteItems = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const term = tradeTerms[i] || item.work;

        // Waterfall
        const sWStart = Date.now();
        let candidates = [];
        try {
            candidates = await lookupPricing(term, 15);
        } catch (err) {
            stages.push({
                name: `Waterfall #${i + 1}`,
                engine: WATERFALL_ENGINE,
                input: { query: term, count: 15 },
                output: null,
                error: err.message,
                durationMs: Date.now() - sWStart,
            });
            continue;
        }
        stages.push({
            name: `Waterfall #${i + 1}`,
            engine: WATERFALL_ENGINE,
            input: { query: term, count: 15 },
            output: {
                candidatesCount: candidates.length,
                candidates: candidates.map(c => ({
                    sorCode: c.sorCode,
                    description: c.description,
                    price: c.price,
                    unit: c.unit,
                })),
            },
            durationMs: Date.now() - sWStart,
        });

        // Picker
        const sPStart = Date.now();
        let pick = null;
        try {
            pick = await pickSOR(term, candidates);
            const positionInWaterfall = pick?.sorCode
                ? candidates.findIndex(c => c.sorCode === pick.sorCode) + 1
                : null;
            stages.push({
                name: `Picker #${i + 1}`,
                engine: Q_ENGINE,
                input: {
                    workDescription: term,
                    candidatesCount: candidates.length,
                },
                output: {
                    sorCode: pick?.sorCode,
                    description: pick?.description,
                    price: pick?.price,
                    unit: pick?.unit,
                    positionInWaterfall: positionInWaterfall || 'NOT IN CANDIDATES',
                    _meta: pick?._meta || null,
                },
                durationMs: Date.now() - sPStart,
            });
        } catch (err) {
            stages.push({
                name: `Picker #${i + 1}`,
                engine: Q_ENGINE,
                input: { workDescription: term, candidatesCount: candidates.length },
                output: null,
                error: err.message,
                durationMs: Date.now() - sPStart,
            });
            continue;
        }

        if (pick?.sorCode) {
            finalQuoteItems.push({
                work: item.work,
                intent: item.intent,
                qty: item.qty || 1,
                sorCode: pick.sorCode,
                description: pick.description,
                price: pick.price,
                unit: pick.unit,
            });
        }
    }

    // ── STAGE 5: CHECKER ─────────────────────────────────────────────
    if (finalQuoteItems.length > 0) {
        const sCStart = Date.now();
        try {
            const checkerOut = await checkResults(input, items, finalQuoteItems);
            stages.push({
                name: 'Checker',
                engine: Q_ENGINE,
                input: {
                    originalText: input,
                    workItems: items,
                    sorResults: finalQuoteItems,
                },
                output: checkerOut,
                durationMs: Date.now() - sCStart,
            });
        } catch (err) {
            stages.push({
                name: 'Checker',
                engine: Q_ENGINE,
                input: {
                    originalText: input,
                    workItems: items,
                    sorResults: finalQuoteItems,
                },
                output: null,
                error: err.message,
                durationMs: Date.now() - sCStart,
            });
        }
    }

    return {
        input,
        stages,
        final: finalQuoteItems,
        totalMs: Date.now() - t0,
    };
}

module.exports = { runQuoteBuilderPipeline };
