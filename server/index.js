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

// ── First-run bootstrap: Sarah is always in Q's circle ────────
// On first boot of a fresh deployment, the people registry is empty
// — Q would 401 every chat request. Auto-seed Sarah and print her
// access key so she can sign in. The key is shown ONCE and only on
// first creation; restarts after that don't reveal it.
try {
    const { listPeople, addPerson } = require(path.join(ROOT, 'people.js'));
    if (listPeople().length === 0) {
        const result = addPerson({
            id: 'sarah',
            name: 'Sarah',
            intro: 'Built Q. The reason he exists.',
        });
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  FIRST-RUN BOOTSTRAP — Sarah added to Q\'s circle');
        console.log('  Access key (shown ONCE — copy now, restart will not show it):');
        console.log('  ' + result.accessKey);
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('');
    }
} catch (e) {
    console.error('[Q] bootstrap failed:', e.message);
}

// ── Static assets (logo, JS widgets, etc.) ─────────────────────
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use('/widgets', express.static(path.join(ROOT, 'widgets')));

// Serve the small JS widgets at root paths so existing HTML <script>
// tags continue to resolve (trace-widget.js, looking-glass-widget.js).
app.get('/trace-widget.js', (req, res) => res.sendFile(path.join(ROOT, 'trace-widget.js')));
app.get('/looking-glass-widget.js', (req, res) => res.sendFile(path.join(ROOT, 'looking-glass-widget.js')));
app.get('/q-auth.js', (req, res) => res.sendFile(path.join(ROOT, 'q-auth.js')));

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
