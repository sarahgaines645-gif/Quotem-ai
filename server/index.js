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
    } catch (e) {
        console.error('[Q] bootstrap failed:', e.message);
    }
})();

// ── Static assets (logo, JS widgets, etc.) ─────────────────────
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use('/widgets', express.static(path.join(ROOT, 'widgets')));

// Serve the small JS widgets at root paths so existing HTML <script>
// tags continue to resolve (trace-widget.js, looking-glass-widget.js).
app.get('/trace-widget.js', (req, res) => res.sendFile(path.join(ROOT, 'trace-widget.js')));
app.get('/looking-glass-widget.js', (req, res) => res.sendFile(path.join(ROOT, 'looking-glass-widget.js')));
app.get('/q-auth.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(ROOT, 'q-auth.js'));
});

// Favicon — Q with pink dot, served as SVG so it stays sharp at every size
app.get('/favicon.svg', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(ROOT, 'favicon.svg'));
});
app.get('/favicon.ico', (req, res) => {
    // Browsers that don't speak SVG favicons get pointed at the SVG too
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(ROOT, 'favicon.svg'));
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

// ── Mount Q's existing router under root ───────────────────────
// routes.js handles GET / → ui.html, POST /chat, /code, /agent, etc.
// Mounted at root so the URL paths match what Q's HTML pages expect.
try {
    const qRouter = require(path.join(ROOT, 'routes.js'));
    app.use('/', qRouter);
    console.log('[Q] ✅ Routes mounted');
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

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Q] 🟢 Listening on http://localhost:${PORT}`);
    console.log(`[Q]    Volume: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/data') ? '/data' : '(local data folder)')}`);
});
