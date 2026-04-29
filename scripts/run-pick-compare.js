// q-lab/scripts/run-pick-compare.js
// One-shot CLI runner for q-lab/sor-pick-compare.js
// Runs the 15-item picker compare: same waterfall candidates → Gemini (live)
// vs Q (DeepSeek V4 Pro) → which sorCode each chose.

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

const { runPickerCompareBatch } = require('../sor-pick-compare');

(async () => {
    const start = Date.now();
    console.log('Running 15-item picker compare...');
    console.log('  Same 15 waterfall candidates → both pickers');
    console.log('  Gemini 2.0 Flash (live sor-engine.js) vs Q (DeepSeek V4 Pro)');
    console.log('');

    const { results, summary } = await runPickerCompareBatch();
    const dur = ((Date.now() - start) / 1000).toFixed(1);

    // Per-test table
    console.log('Per-test picks:');
    console.log('');
    for (const r of results) {
        console.log(`  Input: "${r.input}"  (${r.candidateCount} candidates)`);
        const gemini = r.gemini.sorCode
            ? `${r.gemini.sorCode}  £${r.gemini.price}  ${r.gemini.description}`
            : '(no pick)';
        const q = r.q.sorCode
            ? `${r.q.sorCode}  £${r.q.price}  ${r.q.description}`
            : '(no pick)';
        const agreeMark = r.agree ? '✓ agree' : '✗ disagree';
        console.log(`    Gemini: ${gemini}`);
        console.log(`    Q     : ${q}`);
        console.log(`    ${agreeMark}`);
        console.log('');
    }

    console.log('─'.repeat(80));
    console.log('Summary:');
    console.log(`  Total tests: ${summary.total}`);
    console.log(`  Agreements: ${summary.agreements}`);
    console.log(`  Disagreements: ${summary.disagreements}`);
    console.log('');
    console.log(`Total runtime: ${dur}s`);
    console.log('');
    console.log('Note: agreement does NOT mean correct. Both could pick wrong.');
    console.log('Disagreement does NOT mean Q wrong. Q may pick the standard while Gemini picks the QS_PERSONA bias.');
    console.log('Compare each pick against sor-facts.json keyAnswers to grade for correctness.');
})().catch(err => {
    console.error('Picker compare failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
