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
// ── Security: session signing key + mailbox-token key are MANDATORY in prod ──
// Q_AUTH_PEPPER signs every session cookie (auth.js). Without it auth.js
// used to fall back to a PUBLIC hardcoded string — anyone who read the repo
// could forge a valid session for any email. EMAIL_TOKEN_KEY encrypts the
// connected Gmail/Outlook/SMTP credentials at rest (q-email-accounts.js) and
// used to fall back to the pepper, then to another public string.
//
// Production (NODE_ENV=production, or any RAILWAY_* env present) now REFUSES
// TO BOOT without Q_AUTH_PEPPER. Local dev without those markers gets a
// throwaway pepper and a loud warning — never a silent public constant.
//
// EMAIL_TOKEN_KEY: if the Railway env has NEVER had this var, every existing
// connected mailbox was encrypted with Q_AUTH_PEPPER (the old fallback), so a
// missing EMAIL_TOKEN_KEY in production derives from the pepper — same key
// the data was written with, nothing becomes unreadable — and warns loudly.
// The public-string fallback that used to sit behind that is gone.
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
    || Object.keys(process.env).some(k => k.startsWith('RAILWAY_'));
const pepperOk = !!process.env.Q_AUTH_PEPPER && process.env.Q_AUTH_PEPPER.length >= 16;
const emailKeyOk = !!process.env.EMAIL_TOKEN_KEY && process.env.EMAIL_TOKEN_KEY.length >= 16;
if (!pepperOk) {
    if (IS_PRODUCTION) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════');
        console.error('[Q] 🔴 REFUSING TO BOOT: Q_AUTH_PEPPER not set (must be a random string of 16+ chars).');
        console.error('[Q]    Q_AUTH_PEPPER signs every session cookie. Set it in Railway → Variables, then redeploy. See .env.example.');
        console.error('═══════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    // Dev only: mint an ephemeral pepper for this process so nothing runs on
    // a public constant. Sessions/mailbox tokens will not survive a restart.
    process.env.Q_AUTH_PEPPER = require('crypto').randomBytes(24).toString('hex');
    console.warn('[Q] ⚠️  DEV ONLY: Q_AUTH_PEPPER not set — using a random per-process key. Sessions will NOT survive a restart. Never run production like this.');
}
if (!emailKeyOk) {
    process.env.EMAIL_TOKEN_KEY = process.env.Q_AUTH_PEPPER;
    console.warn('[Q] ⚠️  EMAIL_TOKEN_KEY not set — deriving it from Q_AUTH_PEPPER (the key existing mailbox tokens were written with). Set EMAIL_TOKEN_KEY = the same value as Q_AUTH_PEPPER in Railway → Variables to make this explicit.');
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

// ── MEMORY PERSISTENCE SELF-TEST ──────────────────────────────
// Proves at boot whether Q can actually WRITE his conversation memory to the
// mounted volume and READ it back. This is the answer to "why does Q forget":
// if the write silently fails, every chat turn starts blank. Logged loudly so
// one glance at the startup log says exactly what's wrong — no guessing.
try {
    const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
        || (fs.existsSync('/data') ? '/data' : null);
    const Q_DATA_DIR = VOLUME_DIR ? path.join(VOLUME_DIR, 'q-memory') : path.join(ROOT, 'data');
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
    const probe = path.join(Q_DATA_DIR, '.write-probe');
    const stamp = 'ok-' + process.pid;
    fs.writeFileSync(probe, stamp, 'utf8');
    const readBack = fs.readFileSync(probe, 'utf8');
    const sarahFile = path.join(Q_DATA_DIR, 'q-memory-sarah.json');
    const sarahExists = fs.existsSync(sarahFile);
    const sarahBytes = sarahExists ? fs.statSync(sarahFile).size : 0;
    console.log('═══════════════ Q MEMORY SELF-TEST ═══════════════');
    if (readBack === stamp) {
        console.log(`[Q] ✅ WRITE OK — Q can save memory to ${Q_DATA_DIR}`);
    } else {
        console.log(`[Q] ❌ WRITE/READ MISMATCH at ${Q_DATA_DIR} — memory will NOT persist`);
    }
    console.log(`[Q]    RAILWAY_VOLUME_MOUNT_PATH = ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'UNSET (using /data fallback)'}`);
    console.log(`[Q]    Sarah's memory file: exists=${sarahExists} bytes=${sarahBytes}`);
    console.log('═══════════════════════════════════════════════════');
} catch (e) {
    console.log('═══════════════ Q MEMORY SELF-TEST ═══════════════');
    console.log(`[Q] ❌ CANNOT WRITE Q'S MEMORY — this is why he forgets.`);
    console.log(`[Q]    error: ${e.code || ''} ${e.message}`);
    console.log(`[Q]    RAILWAY_VOLUME_MOUNT_PATH = ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'UNSET (using /data fallback)'}`);
    console.log('═══════════════════════════════════════════════════');
}

// Build banner — proves at a glance WHICH commit is live and WHICH model the case
// threads actually run on. The runtime logs never showed this, so "is my deploy
// live / which model is Q on?" was unanswerable without guessing. Seeing this
// banner at all = the new code booted; the model line confirms GLM vs V4 vs Claude.
// Wrapped so it can never break boot.
try {
    const { Q_CONFIG } = require('../config');
    const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || '').slice(0, 7) || 'unknown';
    const claudeThreads = process.env.QUOTEM_CLAUDE_THREADS === '1';
    console.log('═══════════════ Q BUILD ═══════════════');
    console.log(`[Q]    commit = ${commit}`);
    console.log(`[Q]    case-thread model = ${claudeThreads ? 'claude-sonnet-4-6 (QUOTEM_CLAUDE_THREADS=1)' : Q_CONFIG.threadModel}`);
    console.log(`[Q]    page-chat model  = ${Q_CONFIG.model}`);
    console.log('════════════════════════════════════════');
} catch (e) {
    console.log('[Q] build banner failed: ' + (e && e.message));
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

        // ── Storage-key migration (2026-08-15) ─────────────────────────
        // user directories used to be keyed on a lossy email slug (a.b@x and
        // a-b@x shared one folder → one user could read/wipe another's
        // finance, threads, docs). The key is now collision-proof; rename
        // every known person's OLD folder to the NEW key. Idempotent, runs
        // every boot, never guesses on a collision (logs CRITICAL instead).
        // Runs BEFORE anything else touches user dirs on this boot.
        try {
            const { migrateLegacyUserDirs } = require(path.join(ROOT, 'plugins', 'user-data.js'));
            const r = migrateLegacyUserDirs(peopleMod.listPeople());
            if (r.renamed.length || r.skipped.length || r.collisions.length) {
                console.log(`[migrate] user dirs → hashed keys: renamed=${r.renamed.length} skipped=${r.skipped.length} collisions=${r.collisions.length}`);
            }
        } catch (e) { console.error('[migrate] user-dir migration failed:', e.message); }

        // ── Email-verification grandfathering (2026-08-15) ─────────────
        // Sign-up now requires a verified email. Everyone already in the
        // Circle (Sarah included) is marked verified once so nobody is
        // locked out; only NEW sign-ups have to click the link.
        try {
            const g = peopleMod.grandfatherVerification();
            if (g > 0) console.log(`[migrate] marked ${g} existing account(s) as email-verified`);
        } catch (e) { console.error('[migrate] verification grandfathering failed:', e.message); }

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
// Self-hosted qrcode lib (Kazuhiko Arase qrcode-generator, ~56KB). The
// previous jsdelivr CDN path for node-qrcode was returning 404 — that's why
// the Schedule Call QR modal was rendering a broken-image icon. Hosted from
// this app, no third-party dep.
app.get('/qrcode.min.js', (req, res) => res.sendFile(path.join(ROOT, 'qrcode.min.js')));
// Self-hosted marked (markdown parser, v12). Q's replies on chat / thread /
// email-writer / writer render through window.marked. The file was vendored
// (commit 38c1008) but never given a route — so /marked.min.js 404'd and every
// reply fell back to raw text: literal **asterisks**, no headings, flat black.
// This route is what actually makes Q's formatting render.
app.get('/marked.min.js', (req, res) => res.sendFile(path.join(ROOT, 'marked.min.js')));
// CustomSelect — shared drop-in replacement for native <select> with full
// CSS control. Used by both chat.html (floating tasks card) and life.html
// (modal). Native select's open list can't be styled.
app.get('/cs.js', (req, res) => res.sendFile(path.join(ROOT, 'cs.js')));
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

// Public sign-in / sign-up landing. Every in-app page is behind the auth gate,
// so a logged-out visitor can't load one to trigger the q-auth overlay. This
// page is public ONLY to host that overlay — it has no app content. The gate
// below redirects logged-out page navigations here.
app.get('/welcome', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(ROOT, 'welcome.html'));
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
// DID routes.js ACTUALLY MOUNT? Set by the try/catch at the bottom of this file.
// /health answered ok:true regardless until 21 Aug 2026 — the night one missing
// plugin stopped every route in routes.js from mounting and the whole app 404'd
// for ~40 minutes while Railway's healthcheck stayed green. A health check that
// cannot go red is not a health check.
let routesMounted = false;
let routesMountError = null;

app.get('/health', (req, res) => {
    // The status code stays 200 even when routes are down: railway.toml points
    // healthcheckPath at /health, and a non-2xx here fails the deploy outright.
    // The truth goes in the body, where a person or a monitor can read it.
    res.json({
        ok: routesMounted,
        service: 'quotem-ai',
        version: require('../package.json').version,
        // WHICH COMMIT IS ACTUALLY RUNNING (20 Aug 2026). It was already printed
        // to the boot log, but the log is only readable from the Railway panel —
        // so "is my fix live yet?" could not be answered from outside, and after
        // an outage that is the first question anyone asks. The sister app has
        // reported this on /api/health for months; this is the same field, and
        // /health is public, so a check needs no login.
        commit: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || '').slice(0, 7) || 'unknown',
        togetherKey: !!process.env.TOGETHER_API_KEY,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        routesMounted,
        ...(routesMountError ? { mountError: routesMountError } : {}),
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
    '/client-log',           // failure beacon — must work precisely when auth/session is broken
    '/q-auth.js',
    '/favicon.svg', '/favicon.ico',
    '/favicon-180.png', '/favicon-192.png', '/favicon-512.png',
    '/manifest.webmanifest',
    '/sw.js',                // service worker must be public — browser fetches it pre-auth
    '/trace-widget.js', '/looking-glass-widget.js',
    '/unicorn', '/unicorn3d', '/rig', '/dance', '/disco', '/lab', '/studio',   // the dancing-unicorn test benches. No user data, no
                                // AI calls, no writes — just a page that plays a model.
                                // Public so Sarah can open them without a session and
                                // send the link to a child who has no account.
    '/tags',                 // public NFC tag landing page — recipients aren't signed-in users
    '/welcome',              // public sign-in / sign-up landing (hosts the auth overlay)
    '/login', '/signup', '/logout',
    '/forgot-password', '/reset-password',
    '/verify-email', '/resend-verification',  // sign-up email verification — clicked from the inbox, pre-login
]);
const PUBLIC_PREFIXES = [
    '/assets/',
    '/widgets/',
    '/public-download/',
    // "Scan from phone": the phone is not signed in — the 160-bit session
    // token in the URL is its authority, scoped to one owner's session for
    // 30 minutes (plugins/doc-drop.js). These three were never added when
    // the gate landed, so every phone scan bounced to the sign-in page and
    // Sarah went back to emailing statements to herself.
    '/doc-drop/',
    '/api/doc-drop/by-token/',
    '/api/doc-drop/upload/',
    // LINKMAIL — the recipient has no account and never will; the 128-bit token
    // in the URL is the whole authority, exactly like the doc-drop scan above.
    // ONLY these two prefixes are public. The sender's own endpoints live under
    // /api/linkmail/mine/ precisely so that "list all my links" can never be
    // reached by widening a prefix here.
    '/linkmail/',
    '/api/linkmail/open/',
];
function isPublicPath(p) {
    if (PUBLIC_PATHS.has(p)) return true;
    return PUBLIC_PREFIXES.some(prefix => p.startsWith(prefix));
}

// ── DIAGNOSTIC (31 Jul 2026): the "Q constantly errors" hunt ───
// Every arriving POST /chat is logged BEFORE auth. A user-side error
// with no matching [q-diag] arrive line = the request never reached
// Railway (device/network side). An arrive line followed by a
// 401-reject line = session expiry, not Q. Remove once solved.
app.use((req, res, next) => {
    if (req.method === 'POST' && (req.path === '/chat' || req.path === '/client-log')) {
        console.log('[q-diag] arrive ' + JSON.stringify({
            path: req.path,
            len: req.headers['content-length'] || null,
            qsess: /(?:^|;\s*)qsess=/.test(req.headers.cookie || '') ? 'yes' : 'no',
            ua: String(req.headers['user-agent'] || '').slice(0, 60),
            ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0],
        }));
    }
    next();
});

const { runAs: runAsCostUser } = require(path.join(ROOT, 'cost-tracker'));
app.use((req, res, next) => {
    if (isPublicPath(req.path)) return next();
    const person = verifySessionCookie(req);
    // runAs: every paid AI call made while serving this request is billed to
    // this person in the cost log, however deep in the plugins it happens.
    if (person) { req.person = person; return runAsCostUser(person.id, next); }
    if (req.method === 'POST' && req.path === '/chat') {
        console.warn('[q-diag] 401-reject /chat — qsess cookie '
            + (/(?:^|;\s*)qsess=/.test(req.headers.cookie || '') ? 'PRESENT but invalid/EXPIRED (30-day cliff?)' : 'missing'));
    }
    // Unauthenticated. A top-level browser navigation (Sec-Fetch-Dest: document)
    // gets the public /welcome page, which hosts the sign-in / sign-up overlay —
    // otherwise a logged-out visitor just sees raw "Sign in required" JSON and
    // can never reach a login or sign-up screen. Every other request (fetch,
    // API call, asset) still gets the JSON 401 exactly as before. This redirect
    // only ever sends a logged-out browser to a login screen; it exposes no data.
    if (req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document') {
        return res.redirect(302, '/welcome');
    }
    return res.status(401).json({ error: 'Sign in required.' });
});

// ── DIAGNOSTIC (31 Jul 2026): client failure beacon ────────────
// The chat page reports what the USER'S SCREEN saw when a send failed
// (network error / server error text / how long it waited). No auth on
// purpose — the whole point is hearing from clients whose session or
// connection is broken. Logs only, stores nothing, capped per minute.
let clientLogCount = 0;
setInterval(() => { clientLogCount = 0; }, 60 * 1000).unref();
app.post('/client-log', express.json({ limit: '4kb' }), (req, res) => {
    if (++clientLogCount > 30) return res.status(429).end();
    const b = req.body || {};
    console.warn('[q-diag] client-saw ' + JSON.stringify({
        stage: String(b.stage || '').slice(0, 40),
        err: String(b.err || '').slice(0, 300),
        ms: Number(b.ms) || null,
        status: (typeof b.status === 'number') ? b.status : null,
        online: b.online === false ? false : true,
        surface: String(b.surface || '').slice(0, 20),
        ua: String(req.headers['user-agent'] || '').slice(0, 60),
    }));
    res.status(204).end();
});

// ── Mount Q's existing router under root ───────────────────────
// routes.js handles GET / → ui.html, POST /chat, /code, /agent, etc.
// Mounted at root so the URL paths match what Q's HTML pages expect.
// Routes inside still use requirePerson where they need req.person —
// it's a no-op now (already attached) but kept as defence in depth.
try {
    const qRouter = require(path.join(ROOT, 'routes.js'));
    app.use('/', qRouter);
    routesMounted = true;
    console.log('[Q] ✅ Routes mounted (default-auth gate active)');
} catch (e) {
    routesMountError = e.message;
    console.error('[Q] ❌ Failed to mount routes.js — THE APP IS SERVING NOTHING BUT /health AND /welcome:', e.message);
    console.error(e.stack);
    // Don't crash — let /health still respond so Railway sees us alive
}

// ── 404 fallback ──────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Error handler ──────────────────────────────────────────────
// Typed, not one string for everything (route audit C1): a 413 from
// express.json's body limit used to come out as "Server error" and the UI
// said "Could not read this PDF". Now the client gets the real cause.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.too.large') {
        console.warn(`[Q] 413 ${req.method} ${req.path} — body over the route's limit (${err.limit || '?'} bytes)`);
        return res.status(413).json({ error: 'That upload is too large for this request. Try a smaller file, fewer pages, or a CSV export.', code: 'too_large' });
    }
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.verify.failed')) {
        return res.status(400).json({ error: 'The request body could not be read (invalid JSON).', code: 'bad_body' });
    }
    if (err && err.code === 'UPSTREAM_TIMEOUT') {
        console.warn(`[Q] 504 ${req.method} ${req.path} — ${err.message}`);
        return res.status(504).json({ error: err.message, code: 'upstream_timeout' });
    }
    console.error(`[Q] 🔥 Unhandled error on ${req.method} ${req.path}:`, err && err.message);
    console.error(err && err.stack ? err.stack.slice(0, 600) : '(no stack)');
    const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Server error' : (err.message || 'Request failed'), detail: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// ── Process-level safety net (route audit U1) ─────────────────
// A rejected promise nobody caught used to take the whole process down →
// Railway restart → 502 for everyone mid-request. Log it with the stack
// and KEEP SERVING. A synchronous uncaught exception means state may be
// corrupt: log it and exit(1) so Railway restarts us cleanly instead of
// limping on.
process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    console.error('[Q] 🔥 unhandledRejection (kept serving):', msg.slice(0, 1500));
});
process.on('uncaughtException', (err) => {
    console.error('[Q] 💀 uncaughtException — exiting so Railway restarts cleanly:', err && err.stack ? err.stack.slice(0, 1500) : String(err));
    // Give the log a moment to flush, then exit non-zero.
    setTimeout(() => process.exit(1), 250).unref();
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
