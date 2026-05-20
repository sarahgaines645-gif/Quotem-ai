/**
 * Q — server entry.
 *
 * Express app that mounts Q's routes, serves his static pages, and
 * keeps him alive on his own Railway service at quotem-ai.co.uk.
 *
 * Q is independent: no shared database with Quotem, no shared auth,
 * no shared deploy. The only thing tying him to Quotem is the parent
 * brand. He persists state via a Railway volume mounted at /data.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');

// ── Sanity check: Q can't think without his brain key ──────────
if (!process.env.TOGETHER_API_KEY) {
    console.warn('[Q] ⚠️  TOGETHER_API_KEY is not set. Q will fail every request that needs to reason.');
}

// ── First-run bootstrap: seed Q's memory from the bundled seed file ────
// Q's "first day" history (the conversations including Alex's first
// presence) lives at q-memory-seed.json in the repo. On a fresh volume
// (no q-memory.json yet), copy the seed across so Q remembers his
// origin from the moment he comes alive on the new domain. Subsequent
// boots see the existing file and skip — Q's accumulated memory wins.
try {
    const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
        || (fs.existsSync('/data') ? '/data' : null);
    const Q_DATA_DIR = VOLUME_DIR ? path.join(VOLUME_DIR, 'q-memory') : path.join(ROOT, 'data');
    const memFile = path.join(Q_DATA_DIR, 'q-memory.json');
    const seedFile = path.join(ROOT, 'q-memory-seed.json');
    if (!fs.existsSync(memFile) && fs.existsSync(seedFile)) {
        fs.mkdirSync(Q_DATA_DIR, { recursive: true });
        fs.copyFileSync(seedFile, memFile);
        const stat = fs.statSync(memFile);
        console.log(`[Q] 🌱 Memory seeded from q-memory-seed.json → ${memFile} (${stat.size} bytes)`);
    }
} catch (e) {
    console.error('[Q] memory seed failed:', e.message);
}

// ── First-run bootstrap: Sarah is always in Q's circle ────────
// Migrate any legacy access-key entries away (their hashes are tied
// to a previous pepper and won't validate). Then if no people exist,
// seed Sarah with email + a random initial password — printed ONCE
// so she can copy it. Subsequent boots see Sarah and skip.
(async () => {
    try {
        const peopleMod = require(path.join(ROOT, 'people.js'));
        peopleMod.migrateIfLegacy();
        if (peopleMod.listPeople().length === 0) {
            const sarahEmail = process.env.SARAH_EMAIL || 'sarahgaines645@gmail.com';
            const result = await peopleMod.addPerson({
                id: 'sarah',
                name: 'Sarah',
                email: sarahEmail,
                intro: 'Built Q. The reason he exists.',
            });
            console.log('');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('  FIRST-RUN BOOTSTRAP — Sarah added to Q\'s circle');
            console.log('  Email:    ' + result.person.email);
            console.log('  Password (shown ONCE — copy now, restart will not show it):');
            console.log('  ' + result.password);
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('');
        }

        // ── Legacy-data migration: anything on the volume that pre-dates
        // the per-user scoping rewrite gets claimed for Sarah (the admin).
        // Idempotent — only moves things that aren't already owned. Runs
        // every boot but is a no-op once everything's been migrated.
        await migrateLegacyDataToAdmin(peopleMod);
    } catch (e) {
        console.error('[Q] bootstrap failed:', e.message);
    }
})();

async function migrateLegacyDataToAdmin(peopleMod) {
    const sarah = peopleMod.listPeople().find(p => p.id === 'sarah');
    if (!sarah || !sarah.email) return;
    const adminEmail = sarah.email;
    const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
        || (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'data'));

    let { userDataPath } = (() => {
        try { return require(path.join(ROOT, 'plugins', 'user-data.js')); }
        catch { return {}; }
    })();
    if (!userDataPath) return;

    // 1. Threads — claim '__legacy__'
    try {
        const qThreads = require(path.join(ROOT, 'plugins', 'q-threads.js'));
        const r = qThreads.claimLegacyThreads(adminEmail);
        if (r.claimed > 0) console.log(`[migrate] ${r.claimed} legacy Thread(s) → ${adminEmail}`);
    } catch (e) { console.warn('[migrate] threads:', e.message); }

    // 2. Old shared voice override → user dir
    try {
        const oldVoice = path.join(VOLUME_DIR, 'q-voice', 'q-voice-override.wav');
        if (fs.existsSync(oldVoice)) {
            const newVoice = userDataPath(adminEmail, 'q-voice/override.wav');
            if (!fs.existsSync(newVoice)) {
                fs.copyFileSync(oldVoice, newVoice);
                fs.unlinkSync(oldVoice);
                console.log(`[migrate] voice override → ${adminEmail}`);
            }
        }
    } catch (e) { console.warn('[migrate] voice:', e.message); }

    // 3. Old shared scheduler jobs → tag with ownerEmail
    try {
        const oldJobs = path.join(VOLUME_DIR, 'q-memory', 'q-jobs.json');
        if (fs.existsSync(oldJobs)) {
            const jobs = JSON.parse(fs.readFileSync(oldJobs, 'utf8'));
            let claimed = 0;
            for (const j of jobs) {
                if (!j.ownerEmail) {
                    j.ownerEmail = adminEmail.toLowerCase();
                    claimed++;
                }
            }
            if (claimed > 0) {
                fs.writeFileSync(oldJobs, JSON.stringify(jobs, null, 2));
                console.log(`[migrate] ${claimed} unowned job(s) → ${adminEmail}`);
            }
        }
    } catch (e) { console.warn('[migrate] jobs:', e.message); }

    // 4. Old shared generated files → user dir
    try {
        const oldGen = path.join(VOLUME_DIR, 'q-generated');
        if (fs.existsSync(oldGen)) {
            const newGen = userDataPath(adminEmail, 'q-generated');
            let moved = 0;
            for (const f of fs.readdirSync(oldGen)) {
                const src = path.join(oldGen, f);
                const dst = path.join(newGen, f);
                if (!fs.existsSync(dst)) {
                    try { fs.renameSync(src, dst); moved++; }
                    catch { /* skip */ }
                }
            }
            if (moved > 0) console.log(`[migrate] ${moved} generated file(s) → ${adminEmail}`);
            try { fs.rmdirSync(oldGen); } catch { /* dir may still hold files for other users in future */ }
        }
    } catch (e) { console.warn('[migrate] generated:', e.message); }
}

// ── Static assets (logo, JS widgets, etc.) ─────────────────────
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use('/widgets', express.static(path.join(ROOT, 'widgets')));

// Serve the small JS widgets at root paths so existing HTML <script>
// tags continue to resolve (trace-widget.js, looking-glass-widget.js).
app.get('/trace-widget.js', (req, res) => res.sendFile(path.join(ROOT, 'trace-widget.js')));
app.get('/looking-glass-widget.js', (req, res) => res.sendFile(path.join(ROOT, 'looking-glass-widget.js')));
app.get('/sw.js', (req, res) => {
    // Service worker must not be cached — browser needs the latest version every load.
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(ROOT, 'sw.js'));
});
app.get('/q-auth.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(ROOT, 'q-auth.js'));
});

// Public NFC tag landing page — standalone, NO auth (people who tap the
// tag aren't signed-in users). Reusable; today it shows a birthday.
// Registered before the auth gate so tapping the tag just opens it.
app.get('/tags', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(ROOT, 'tags.html'));
});

// Favicon — Q with pink dot. Multiple sizes for desktop + mobile + home-screen.
//   /favicon.svg          → modern browsers (scalable)
//   /favicon.ico          → fallback for older browsers (just the SVG)
//   /favicon-180.png      → iOS apple-touch-icon (home-screen widget)
//   /favicon-192.png      → Android home-screen (via manifest)
//   /favicon-512.png      → Android splash / large home-screen
//   /manifest.webmanifest → tells Android how to render the home-screen icon
const ONE_DAY = 'public, max-age=86400';
app.get('/favicon.svg',     (req, res) => { res.setHeader('Cache-Control', ONE_DAY); res.sendFile(path.join(ROOT, 'favicon.svg')); });
app.get('/favicon.ico',     (req, res) => { res.setHeader('Cache-Control', ONE_DAY); res.sendFile(path.join(ROOT, 'favicon.svg')); });
app.get('/favicon-180.png', (req, res) => { res.setHeader('Cache-Control', ONE_DAY); res.sendFile(path.join(ROOT, 'favicon-180.png')); });
app.get('/favicon-192.png', (req, res) => { res.setHeader('Cache-Control', ONE_DAY); res.sendFile(path.join(ROOT, 'favicon-192.png')); });
app.get('/favicon-512.png', (req, res) => { res.setHeader('Cache-Control', ONE_DAY); res.sendFile(path.join(ROOT, 'favicon-512.png')); });
app.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', ONE_DAY);
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(ROOT, 'manifest.webmanifest'));
});

// ── Health check ───────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'quotem-ai',
        version: require('../package.json').version,
        togetherKey: !!process.env.TOGETHER_API_KEY,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
    });
});

// ── Default-auth gate ──────────────────────────────────────────
// EVERY route past this line requires a signed-in user, with one
// explicit allowlist of public paths. Adding a new route is auto-
// authenticated by default — there is no way to forget the auth
// check on a new feature. This is the architectural fix for the
// privacy leak: auth is no longer per-route, it's per-app.
const { requirePerson, verifySessionCookie } = require(path.join(ROOT, 'auth'));

const PUBLIC_PATHS = new Set([
    '/health',
    '/q-auth.js',
    '/favicon.svg', '/favicon.ico',
    '/favicon-180.png', '/favicon-192.png', '/favicon-512.png',
    '/manifest.webmanifest',
    '/sw.js',                // service worker must be public — browser fetches it pre-auth
    '/trace-widget.js', '/looking-glass-widget.js',
    '/tags',                 // public NFC tag landing page — recipients aren't signed-in users
    '/login', '/signup', '/logout',
    '/forgot-password', '/reset-password',
]);
const PUBLIC_PREFIXES = [
    '/assets/',
    '/widgets/',
    '/public-download/',
];
function isPublicPath(p) {
    if (PUBLIC_PATHS.has(p)) return true;
    return PUBLIC_PREFIXES.some(prefix => p.startsWith(prefix));
}

app.use((req, res, next) => {
    if (isPublicPath(req.path)) return next();
    return requirePerson(req, res, next);
});

// ── Mount Q's existing router under root ───────────────────────
// routes.js handles GET / → ui.html, POST /chat, /code, /agent, etc.
// Mounted at root so the URL paths match what Q's HTML pages expect.
// Routes inside still use requirePerson where they need req.person —
// it's a no-op now (already attached) but kept as defence in depth.
try {
    const qRouter = require(path.join(ROOT, 'routes.js'));
    app.use('/', qRouter);
    console.log('[Q] ✅ Routes mounted (default-auth gate active)');
} catch (e) {
    console.error('[Q] ❌ Failed to mount routes.js:', e.message);
    console.error(e.stack);
    // Don't crash — let /health still respond so Railway sees us alive
}

// ── 404 fallback ──────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[Q] 🔥 Unhandled error:', err.message);
    console.error(err.stack?.slice(0, 600));
    res.status(500).json({ error: 'Server error', detail: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// ── Background workers ────────────────────────────────────────
// Alert scheduler — fires push notifications for tasks whose alertAt
// has arrived. Uses q-push's VAPID-backed send path. Per-user, tick
// every 60s. Editing a task's alertAt re-arms the alert (q-life.js
// clears alertedAt on time change).
try {
    require(path.join(ROOT, 'plugins', 'alert-scheduler.js')).start();
} catch (e) {
    console.warn('[Q] alert-scheduler failed to start:', e.message);
}

// ── Start ──────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
    console.log(`[Q] 🟢 Listening on http://localhost:${PORT}`);
    console.log(`[Q]    Volume: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/data') ? '/data' : '(local data folder)')}`);
});
// Allow tool chains + report generation up to 5 minutes.
// Node's default is 120s — long AI calls were dying mid-response.
httpServer.setTimeout(300000);
httpServer.keepAliveTimeout = 310000;
