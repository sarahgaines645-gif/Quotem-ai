#!/usr/bin/env node
'use strict';
/**
 * Proves the emailSlug fix (2026-08-15) and the boot-time directory migration.
 *
 *   node scripts/verify-user-data-slug.js
 *
 * Runs against a SCRATCH data dir (RAILWAY_VOLUME_MOUNT_PATH is pointed at a
 * temp folder before user-data.js is required) — touches nothing real, makes
 * no network calls. Exits non-zero on the first failed check.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'q-userdata-verify-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = scratch;

const ud = require('../plugins/user-data');
const { emailSlug, legacyEmailSlug, migrateLegacyUserDirs, userDataPath, USER_BASE_DIR } = ud;

let passed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('  ✅ ' + name); }
    catch (e) { console.error('  ❌ ' + name + '\n     ' + e.message); process.exit(1); }
}

console.log('user-data verification — scratch dir: ' + USER_BASE_DIR);

// ── 1. The three emails that used to share one folder now don't ──
const trio = ['john.smith@x.com', 'john-smith@x.com', 'john_smith@x.com'];
check('legacy slug collides for john.smith@ / john-smith@ / john_smith@ (the old bug)', () => {
    const legacy = new Set(trio.map(legacyEmailSlug));
    assert.strictEqual(legacy.size, 1, 'expected ONE legacy slug, got ' + [...legacy].join(','));
});
check('new emailSlug gives THREE distinct slugs', () => {
    const slugs = trio.map(emailSlug);
    assert.strictEqual(new Set(slugs).size, 3, 'got ' + slugs.join(','));
    console.log('     ' + trio.map((e, i) => `${e} → ${slugs[i]}`).join('\n     '));
});
check('slug is stable and case/whitespace-insensitive (John.Smith@X.com  → same as john.smith@x.com)', () => {
    assert.strictEqual(emailSlug('  John.Smith@X.com '), emailSlug('john.smith@x.com'));
});
check('slug is filesystem-safe (only [a-z0-9_])', () => {
    for (const e of [...trio, 'sarah+work@gmail.com', 'ÄÖÜ@bücher.de']) assert.ok(/^[a-z0-9_]+$/.test(emailSlug(e)), emailSlug(e));
});
check('userDataPath for the three emails lands in three different directories', () => {
    const dirs = trio.map(e => path.dirname(userDataPath(e, 'finance/transactions.json')));
    assert.strictEqual(new Set(dirs).size, 3);
    // clean up so the migration test starts from a known state
    for (const e of trio) fs.rmSync(path.join(USER_BASE_DIR, emailSlug(e)), { recursive: true, force: true });
});

// ── 2. Migration: single owner → renamed ──
check('migration renames a lone old-slug dir to the new slug (data preserved)', () => {
    const email = 'alice.b@example.org';
    const oldDir = path.join(USER_BASE_DIR, legacyEmailSlug(email));
    fs.mkdirSync(path.join(oldDir, 'finance'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'finance', 'transactions.json'), '[{"id":1}]');
    const r = migrateLegacyUserDirs([{ email }]);
    assert.strictEqual(r.renamed.length, 1, JSON.stringify(r));
    assert.ok(!fs.existsSync(oldDir), 'old dir should be gone');
    const newFile = path.join(USER_BASE_DIR, emailSlug(email), 'finance', 'transactions.json');
    assert.strictEqual(fs.readFileSync(newFile, 'utf8'), '[{"id":1}]');
});
check('migration is idempotent (second run renames nothing, errors nothing)', () => {
    const r = migrateLegacyUserDirs([{ email: 'alice.b@example.org' }]);
    assert.deepStrictEqual(r, { renamed: [], skipped: [], collisions: [] });
});

// ── 3. Migration: collision → REFUSED, logged CRITICAL ──
check('migration REFUSES to guess when two known people share one old slug', () => {
    const a = 'john.smith@x.com', b = 'john-smith@x.com';
    const oldDir = path.join(USER_BASE_DIR, legacyEmailSlug(a));
    fs.mkdirSync(path.join(oldDir, 'threads'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'threads', 't1.json'), '{}');
    const logs = [];
    const orig = console.error;
    console.error = (...args) => { logs.push(args.join(' ')); };
    let r;
    try { r = migrateLegacyUserDirs([{ email: a }, { email: b }]); }
    finally { console.error = orig; }
    assert.strictEqual(r.collisions.length, 1, JSON.stringify(r));
    assert.strictEqual(r.renamed.length, 0);
    assert.ok(fs.existsSync(oldDir), 'fused old dir must be left in place');
    assert.ok(!fs.existsSync(path.join(USER_BASE_DIR, emailSlug(a))));
    assert.ok(!fs.existsSync(path.join(USER_BASE_DIR, emailSlug(b))));
    assert.ok(logs.some(l => l.includes('CRITICAL') && l.includes('john_smith_x_com')), 'expected a CRITICAL log naming the old slug; got: ' + logs.join(' | '));
    assert.ok(!logs.some(l => l.includes('john.smith@x.com')), 'full email must be masked in logs');
    console.log('     log line: ' + logs[0].slice(0, 160) + '…');
});

// ── 4. Migration: both dirs exist → leave both ──
check('migration leaves both dirs when old AND new already exist with content', () => {
    const email = 'carol@example.org';
    const oldDir = path.join(USER_BASE_DIR, legacyEmailSlug(email));
    const newDir = path.join(USER_BASE_DIR, emailSlug(email));
    fs.mkdirSync(oldDir, { recursive: true }); fs.writeFileSync(path.join(oldDir, 'a.json'), '1');
    fs.mkdirSync(newDir, { recursive: true }); fs.writeFileSync(path.join(newDir, 'b.json'), '2');
    const orig = console.warn; console.warn = () => {};
    let r; try { r = migrateLegacyUserDirs([{ email }]); } finally { console.warn = orig; }
    assert.strictEqual(r.skipped.length, 1, JSON.stringify(r));
    assert.ok(fs.existsSync(oldDir) && fs.existsSync(newDir));
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nAll ${passed} checks passed.`);
