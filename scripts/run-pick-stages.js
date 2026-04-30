// q-lab/scripts/run-pick-stages.js
// Show input→output at every stage of the picker pipeline for each test.
// Stages: Reader → Translator → Waterfall → Picker (both Gemini and Q).
// Outputs per-test sections with stage-by-stage data, plus a summary table at the end.

// Manually parse server/.env (q-lab has no node_modules/dotenv).
{
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '..', '..', 'server', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
            if (m) {
                let val = m[2].trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (!process.env[m[1]]) process.env[m[1]] = val;
            }
        }
    }
}

const { lookupPricing } = require('../../server/templates/pricing-lookup.js');
const { lookupSOR } = require('../../server/templates/sor-engine.js');
const { pickSOR: pickWithQ } = require('../plugins/q-sor-picker.js');
const { readText: readWithClaude } = require('../../server/templates/claude-text-reader.js');
const { translateToSOR } = require('../../server/templates/claude-translator.js');

const TESTS = [
    { input: 'new front door',       expected: 'hardwood panelled' },
    { input: 'replace toilet',       expected: 'close coupled' },
    { input: 'window',               expected: 'PVCu casement' },
    { input: 'kitchen sink',         expected: 'stainless 1.5-bowl' },
    { input: 'bathroom basin',       expected: 'ceramic wall-hung/pedestal' },
    { input: 'leaky tap',            expected: 'OVERHAUL (repair intent)' },
    { input: 'paint external walls', expected: 'masonry paint' },
    { input: 'service the door',     expected: 'OVERHAUL (service = repair)' },
    { input: 'fix the loo',          expected: 'OVERHAUL/REFIX' },
    { input: 'repoint brickwork',    expected: 'rake out + repoint' },
    { input: 'render repair',        expected: 'crack repair' },
    { input: 'gutter clean',         expected: 'clean (not renew)' },
    { input: 'standard radiator',    expected: 'single panel convector' },
    { input: 'mixer tap',            expected: 'mixer (sink or bath)' },
    { input: 'fence panel',          expected: '1.8m close-board' },
];

const trim = (s, n) => (s || '').length > n ? s.slice(0, n - 1) + '…' : (s || '');

(async () => {
    const start = Date.now();
    const summary = [];

    for (const test of TESTS) {
        console.log('');
        console.log('━'.repeat(110));
        console.log(`INPUT: "${test.input}"     [expected: ${test.expected}]`);
        console.log('━'.repeat(110));

        // STAGE 1 — Reader
        let readerOut = null;
        try {
            const r = await readWithClaude(test.input);
            readerOut = r.items?.[0] || null;
        } catch (e) { readerOut = { error: e.message }; }

        const readerSummary = readerOut?.work
            ? `work="${readerOut.work}", intent="${readerOut.intent || '?'}", qty=${readerOut.qty ?? '?'}, unit=${readerOut.unit || '?'}`
            : (readerOut?.error ? `ERROR: ${readerOut.error}` : '(empty)');
        console.log(`STAGE 1 — Reader (Claude):   ${readerSummary}`);

        // STAGE 2 — Translator
        let tradeTerm = null;
        try {
            if (readerOut?.work) {
                const t = await translateToSOR([{
                    work: readerOut.work,
                    intent: readerOut.intent || 'replace',
                    detail: readerOut.detail || '',
                }]);
                tradeTerm = Array.isArray(t) ? t[0] : (t?.[0] || JSON.stringify(t).slice(0, 80));
            }
        } catch (e) { tradeTerm = `ERROR: ${e.message}`; }
        console.log(`STAGE 2 — Translator (Claude): ${tradeTerm || '(skipped)'}`);

        // STAGE 3 — Waterfall (uses raw input as the picker pipeline does)
        const queryForWaterfall = tradeTerm || test.input;
        const candidates = await lookupPricing(queryForWaterfall, 15);
        console.log(`STAGE 3 — Waterfall (${candidates.length} candidates from query="${queryForWaterfall}"):`);
        candidates.forEach((c, i) => {
            console.log(`  ${String(i + 1).padStart(2)}. ${c.sorCode.padEnd(7)} £${String(c.price).padEnd(7)} ${trim(c.description, 70)}`);
        });

        // STAGE 4 — both pickers (note: lookupSOR re-runs its own waterfall internally;
        // pickWithQ takes the candidate array we just built)
        const [geminiResult, qResult] = await Promise.all([
            lookupSOR(test.input).catch(err => ({ error: err.message, sorCode: null })),
            pickWithQ(test.input, candidates).catch(err => ({ error: err.message, sorCode: null })),
        ]);

        const geminiPos = candidates.findIndex(c => c.sorCode === geminiResult.sorCode);
        const qPos = candidates.findIndex(c => c.sorCode === qResult.sorCode);
        const qMeta = qResult._meta || {};
        const qFallback = qMeta.fallback || qMeta.error ? ` [meta: ${qMeta.error || qMeta.skipped || 'fallback'}]` : '';

        console.log('');
        console.log(`STAGE 4 — Gemini pick: ${geminiResult.sorCode || 'ERROR'}  £${geminiResult.price ?? '?'}  ${trim(geminiResult.description || geminiResult.error || '', 60)}  [pos ${geminiPos + 1 || '–'}/${candidates.length}]`);
        console.log(`STAGE 4 — Q pick     : ${qResult.sorCode || 'ERROR'}  £${qResult.price ?? '?'}  ${trim(qResult.description || qResult.error || '', 60)}  [pos ${qPos + 1 || '–'}/${candidates.length}]${qFallback}`);

        summary.push({
            input: test.input,
            expected: test.expected,
            readerWork: readerOut?.work || '—',
            readerIntent: readerOut?.intent || '—',
            tradeTerm: tradeTerm || '—',
            top3: candidates.slice(0, 3).map(c => c.sorCode).join(', '),
            geminiCode: geminiResult.sorCode || '–',
            geminiDesc: trim(geminiResult.description || '', 35),
            geminiPos: geminiPos >= 0 ? geminiPos + 1 : '–',
            qCode: qResult.sorCode || '–',
            qDesc: trim(qResult.description || '', 35),
            qPos: qPos >= 0 ? qPos + 1 : '–',
            qFallback: !!(qMeta.fallback || qMeta.error),
            agree: geminiResult.sorCode === qResult.sorCode,
        });
    }

    // Summary table at the end
    console.log('');
    console.log('═'.repeat(110));
    console.log('SUMMARY TABLE');
    console.log('═'.repeat(110));
    console.log('');

    const header = ['Input', 'ReaderWork→Intent', 'TradeTerm', 'Top3', 'GeminiPick', 'Pos', 'QPick', 'Pos', 'Agree'];
    const widths = [22, 28, 22, 24, 14, 4, 14, 4, 6];
    console.log(header.map((h, i) => h.padEnd(widths[i])).join(' '));
    console.log(widths.map(w => '─'.repeat(w)).join(' '));
    for (const s of summary) {
        const row = [
            trim(s.input, widths[0]),
            trim(`${s.readerWork} → ${s.readerIntent}`, widths[1]),
            trim(s.tradeTerm, widths[2]),
            trim(s.top3, widths[3]),
            s.geminiCode,
            String(s.geminiPos),
            s.qCode + (s.qFallback ? '*' : ''),
            String(s.qPos),
            s.agree ? '✓' : '✗',
        ];
        console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join(' '));
    }
    console.log('');
    console.log('* = Q fell back to first-candidate (no real model decision)');
    console.log('');
    console.log(`Runtime: ${((Date.now() - start) / 1000).toFixed(1)}s`);
})().catch(err => {
    console.error('Stages run failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
