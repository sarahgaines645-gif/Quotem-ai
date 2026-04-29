// q-lab/scripts/run-stress.js
// One-shot CLI runner for q-lab/stress-test.js
// Runs the 23-item reader stress test against Qwen 3 235B (legacy Q),
// DeepSeek V4 Pro (current Q) and Claude (live), prints a scorecard.

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

const { runStressTest } = require('../stress-test');

(async () => {
    const start = Date.now();
    console.log('Running 23-item reader stress test...');
    console.log('  Qwen 3 235B (legacy Q engine)');
    console.log('  DeepSeek V4 Pro (current Q engine)');
    console.log('  Claude (live)');
    console.log('');

    const { results, summary } = await runStressTest({
        includeClaude: true,
        includeDeepSeek: true,
        batchSize: 4,
    });

    const dur = ((Date.now() - start) / 1000).toFixed(1);

    // Per-test table
    console.log('Per-test results:');
    console.log('id  cat            input'.padEnd(70) + 'qwen   deep   claude');
    console.log('─'.repeat(95));
    for (const r of results) {
        const id = String(r.id).padEnd(3);
        const cat = (r.cat || '').padEnd(14);
        const input = (r.input || '').slice(0, 50).padEnd(52);
        const q = (r.verdict.q || '?').padEnd(7);
        const d = (r.verdict.deepseek || '?').padEnd(7);
        const c = (r.verdict.claude || '?').padEnd(7);
        console.log(`${id} ${cat} ${input}${q}${d}${c}`);
    }

    console.log('');
    console.log('Summary:');
    console.log(`  Qwen 3 235B   : ${summary.qPassed} / ${summary.total} pass`);
    console.log(`  DeepSeek V4 P : ${summary.deepseekPassed} / ${summary.total} pass`);
    console.log(`  Claude        : ${summary.claudePassed} / ${summary.total} pass`);
    console.log('');
    console.log(`Total runtime: ${dur}s`);

    // Output failures with detail so Sarah can see what went wrong
    const interestingFails = results.filter(r =>
        r.verdict.deepseek === 'fail' || r.verdict.q === 'fail' || r.verdict.claude === 'fail'
    );
    if (interestingFails.length) {
        console.log('');
        console.log('Failure detail:');
        for (const r of interestingFails) {
            console.log(`  [${r.id}] ${r.input}`);
            console.log(`    expected qty: ${r.expectedQty ?? r.expectedQtys ?? r.expectedItems ?? '(any)'}`);
            console.log(`    qwen     : ${JSON.stringify(r.q?.items?.map(i => ({ work: i.work, qty: i.qty })) || r.q?._meta?.error || 'no items')}`);
            console.log(`    deepseek : ${JSON.stringify(r.deepseek?.items?.map(i => ({ work: i.work, qty: i.qty })) || r.deepseek?._meta?.error || 'no items')}`);
            console.log(`    claude   : ${JSON.stringify(r.claude?.items?.map(i => ({ work: i.work, qty: i.qty })) || r.claude?.error || 'no items')}`);
        }
    }
})().catch(err => {
    console.error('Stress run failed:', err.message);
    process.exit(1);
});
