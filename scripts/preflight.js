/* PRE-FLIGHT: would this deploy actually boot, and would every feature be there?
 *
 * Twice in one day a module was required by committed code and never tracked
 * itself. Once it took the whole app down (q-trips, unguarded require). Once it
 * would have failed silently, killing every share link (q-linkmail, guarded).
 * Both were invisible locally, because locally the file is sitting right there.
 *
 * This walks every require() reachable from the entry points and asks git
 * whether the file it resolves to is actually committed.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const tracked = new Set(
    cp.execSync('git ls-files', { maxBuffer: 1e8 }).toString().split(/\r?\n/).filter(Boolean)
);

const ENTRIES = ['routes.js', 'server/index.js', 'config.js', 'cost-tracker.js', 'mailer.js'];
const seen = new Set();
const problems = [];
const queue = ENTRIES.slice();

while (queue.length) {
    const f = queue.shift().split(path.sep).join('/');
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);

    const src = fs.readFileSync(f, 'utf8');
    const dir = path.posix.dirname(f);

    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        const rel = m[1];
        const base = path.posix.normalize(path.posix.join(dir, rel));
        let hit = null;
        for (const cand of [base, base + '.js', base + '.json', base + '/index.js']) {
            if (fs.existsSync(cand)) { hit = cand; break; }
        }
        if (!hit) { problems.push([f, rel, '(resolves to nothing)', 'FILE MISSING']); continue; }
        if (!tracked.has(hit)) problems.push([f, rel, hit, 'NOT TRACKED IN GIT']);
        if (hit.endsWith('.js')) queue.push(hit);
    }
}

console.log('server modules reachable from the entry points: ' + seen.size);

/* Pages the routes hand back with sendFile — same trap, different verb. */
const pages = new Set();
for (const f of seen) {
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/sendFile\(\s*path\.join\(__dirname,\s*'([^']+)'/g)) {
        pages.add(m[1]);
    }
}
for (const p of pages) {
    if (!fs.existsSync(p)) problems.push(['routes', p, '(missing)', 'PAGE MISSING']);
    else if (!tracked.has(p)) problems.push(['routes', p, p, 'PAGE NOT TRACKED IN GIT']);
}
console.log('pages served by sendFile: ' + pages.size);

if (!problems.length) {
    console.log('\nevery module and page they need is committed  ✓');
} else {
    console.log('\n⚠️  THESE WOULD BE ABSENT ON THE DEPLOY:');
    for (const [from, req, resolved, why] of problems) {
        console.log('   ' + from + '  requires  ' + req + '  ->  ' + resolved + '   ' + why);
    }
    process.exitCode = 1;
}
