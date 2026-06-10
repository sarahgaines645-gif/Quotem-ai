/**
 * Q LAB ROUTES — isolated test endpoints for Q
 *
 * Mounted at /api/q-lab by server/index.js. Only accessible via explicit URL path.
 * Live Quotem features never route through here.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const express = require('express');
const router = express.Router();
const { readText } = require('./plugins/q-text-reader');
const { translateToSOR } = require('./plugins/q-translator');
const { checkResults } = require('./plugins/q-checker');
const { expandItem } = require('./plugins/q-expander');
const { priceItem, priceItems } = require('./plugins/q-pricer');
const { chat, claudeReadImage, claudeThreadChat } = require('./plugins/q-chat');
const { stats: ragStats } = require('./plugins/q-rag');
const { speakAsVoice } = require('./plugins/q-voice-clone');
const { runAgent } = require('./plugins/q-agent');
const { analyzeDocument, webSearch } = require('./plugins/q-tools');
const qThreads = require('./plugins/q-threads');
const { generateImage } = require('./plugins/q-image-gen');
const { vectoriseImage } = require('./plugins/q-graphics');
const { generateMusic } = require('./plugins/q-music');
const { generateVideo } = require('./plugins/q-video');
const { listFacts, searchFacts, deleteFact, clearFacts, getFactsPath } = require('./facts');
const {
    createJob,
    listJobs,
    getJob,
    patchJob,
    deleteJob,
    runJobNow,
    findJobByWebhookToken,
    startScheduler,
    getJobsPath,
} = require('./scheduler');

// Boot the scheduler worker as soon as the routes module loads.
// Idempotent — calling more than once is safe.
startScheduler();
const { loadMemory, clearMemory, appendMessage, getRecentMessages, getCircleSummary, getMemoryPath, getVoicePath, getDocPath, getTutorPath } = require('./memory');
const { requirePerson, tryAttachPerson, setSessionCookie, clearSessionCookie } = require('./auth');
const { listPeople, addPerson, signupPerson, isApproved, approvePerson, isAdmin, getPerson, getPersonByEmail, removePerson, verifyLogin, changePassword, rotatePassword, createResetToken, consumeResetToken } = require('./people');
const { sendMail, isConfigured: mailerConfigured } = require('./mailer');
const { resolveToken: resolveGeneratedDoc, resolveTokenAcrossUsers } = require('./plugins/doc-creator');
const { summarise: summariseCosts, getLogPath: costLogPath } = require('./cost-tracker');
const qPush = require('./plugins/q-push');

// ── Auth: login + logout ────────────────────────────────────────────────────

router.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
    const { email, password } = req.body || {};
    const person = await verifyLogin(email, password);
    if (!person) {
        // Constant-time-ish: still wait roughly as long as a real bcrypt compare
        return res.status(401).json({ error: 'Email or password incorrect.' });
    }
    // Account must be approved before it can sign in. Credentials are correct
    // here (we don't leak approval state to wrong passwords) — the account is
    // simply still waiting for Sarah to approve it.
    if (!isApproved(person)) {
        return res.status(403).json({ error: "Your account is waiting to be approved. You'll be able to sign in once it's been let in." });
    }
    setSessionCookie(res, person.email);
    res.json({ ok: true, person });
});

// Self-signup. Anyone can request an account, but it's created PENDING —
// Sarah approves it from the admin members page before the person can sign
// in. We deliberately do NOT set a session cookie here: a pending account
// gets no access until approved. The client shows an "awaiting approval"
// message on { pending: true }.
router.post('/signup', express.json({ limit: '4kb' }), async (req, res) => {
    const { name, email, password } = req.body || {};
    try {
        const person = await signupPerson({ name, email, password });
        return res.json({ ok: true, pending: true, person });
    } catch (e) {
        return res.status(400).json({ error: e.message || 'Sign-up failed.' });
    }
});

router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/whoami', (req, res) => {
    if (!req.person) {
        const { verifySessionCookie } = require('./auth');
        const p = verifySessionCookie(req);
        if (p) req.person = p;
    }
    res.json({ person: req.person || null, isAdmin: isAdmin(req.person) });
});

router.post('/change-password', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    try {
        await changePassword(req.person.id, newPassword);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ── Forgot / reset password ────────────────────────────────────────────────
// Two endpoints + one page:
//   POST /forgot-password { email }    → emails a reset link (always says ok)
//   GET  /reset?token=...              → serves reset.html
//   POST /reset-password { token, newPassword } → sets the new password

router.post('/forgot-password', express.json({ limit: '4kb' }), async (req, res) => {
    const email = String(req.body?.email || '').trim();
    // Always respond ok — never leak which emails are registered.
    const respond = () => res.json({ ok: true });
    if (!email) return respond();
    const token = createResetToken(email);
    if (!token) return respond(); // unknown email — silent
    const person = getPersonByEmail(email);
    if (!person) return respond();
    if (!mailerConfigured()) {
        console.warn('[forgot-password] mailer not configured — token created but no email sent');
        return respond();
    }
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https');
    const host = req.headers.host || 'www.quotem-ai.co.uk';
    const link = `${proto}://${host}/reset?token=${encodeURIComponent(token)}`;
    const text = `Hi ${person.name || ''},\n\nSomeone (hopefully you) asked to reset the password on your Q account.\n\nClick this link within the next hour to set a new one:\n${link}\n\nIf it wasn't you, ignore this email — your password stays the same.\n\n— Q`;
    const html = `<p>Hi ${person.name || ''},</p><p>Someone (hopefully you) asked to reset the password on your Q account.</p><p><a href="${link}">Click here to set a new password</a> — link is valid for one hour.</p><p>If it wasn't you, ignore this email — your password stays the same.</p><p>— Q</p>`;
    try {
        await sendMail({ to: email, subject: 'Reset your Q password', text, html });
    } catch (e) {
        console.warn('[forgot-password] sendMail failed:', e.message);
    }
    respond();
});

router.get('/reset', (req, res) => {
    res.sendFile(path.join(__dirname, 'reset.html'));
});

router.post('/reset-password', express.json({ limit: '4kb' }), async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    try {
        const person = await consumeResetToken(token, newPassword);
        if (!person) return res.status(400).json({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
        setSessionCookie(res, person.email);
        res.json({ ok: true, person });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ── Document downloads (Q's create_document tool) ──────────────────────────
// Files generated by Q live in data/generated/ keyed by a 16-hex token.
// Authentication required so generated docs can't be enumerated by strangers.
router.get('/download/:token', requirePerson, (req, res) => {
    // Per-user resolve — only finds files belonging to the calling user.
    const found = resolveGeneratedDoc(req.params.token, req.person.email);
    if (!found) return res.status(404).send('That download has expired or never existed.');
    res.download(found.fullPath, found.filename);
});

// Public download — same files, no auth. Used when an external service
// (Google Drive viewer, Save-to-Drive) needs to fetch the file. The 16-hex
// token is the auth: 64 bits of entropy, 24h TTL, not enumerable. Searches
// across user dirs because the caller is anonymous.
router.get('/public-download/:token', (req, res) => {
    const found = resolveTokenAcrossUsers(req.params.token);
    if (!found) return res.status(404).send('That file has expired or never existed.');
    res.setHeader('Content-Disposition', `inline; filename="${found.filename}"`);
    res.sendFile(found.fullPath);
});

// Admin: add someone to the Circle (Sarah only)
router.post('/circle/add', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { id, name, email, intro, password } = req.body || {};
        const result = await addPerson({ id, name, email, intro, password });
        res.json(result); // returns { person, password } — copy the raw password ONCE
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/circle/people/:id/rotate', requirePerson, async (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const newPassword = await rotatePassword(req.params.id);
        res.json({ id: req.params.id, password: newPassword });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Q's front door — his customer-facing chat page.
// (The old lab tester at ui.html lives inside Quotem admin only.)
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});

// Health check — is Q wired up at all?
// TEMP — GLM-5 tool-call test. Remove after confirming.
router.get('/test-glm-tools', async (req, res) => {
    const key = process.env.TOGETHER_API_KEY;
    if (!key) return res.json({ error: 'No Together key' });
    const body = {
        model: 'zai-org/GLM-5',
        max_tokens: 256,
        temperature: 0,
        tools: [{ type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'What is the weather in London today? Use web_search.' }]
    };
    try {
        const r = await fetch('https://api.together.xyz/v1/chat/completions', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await r.json();
        const msg = data.choices?.[0]?.message;
        res.json({
            finish_reason: data.choices?.[0]?.finish_reason,
            tool_calls: msg?.tool_calls || null,
            content: msg?.content || null,
            error: data.error || null
        });
    } catch(e) { res.json({ error: e.message }); }
});

router.get('/ping', (req, res) => {
    res.json({
        ok: true,
        message: 'Q is alive',
        model: 'Qwen 3 235B via Together AI',
        hasKey: !!process.env.TOGETHER_API_KEY,
        timestamp: new Date().toISOString(),
    });
});

// Text-reader test — POST body.text, get structured work items
router.post('/text-reader', async (req, res) => {
    const text = req.body?.text;
    if (!text) return res.status(400).json({ error: 'Missing "text" in request body' });

    const result = await readText(text);
    res.json(result);
});

// GET variant for easy browser testing: /api/q-lab/text-reader?text=fix+the+bog
router.get('/text-reader', async (req, res) => {
    const text = req.query.text;
    if (!text) {
        return res.status(400).json({
            error: 'Missing ?text=... query param',
            example: '/api/q-lab/text-reader?text=fix+the+leaky+bog',
        });
    }

    const result = await readText(text);
    res.json(result);
});

// Shared trace widget — drop-in floating panel that any lab page can include
// via <script src="/api/q-lab/trace-widget.js"></script>. Lab pages publish
// pipeline traces via window.qLabTrace.show(...) and the widget renders them.
router.get('/trace-widget.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'trace-widget.js'));
});

// Lab Quote Builder — same shape as live Quote Builder but runs Q's pipeline
// with a stage-by-stage trace panel. Lab-only: never wired to live routes,
// never receives customer data. Test inputs only.
router.get('/quote-builder', (req, res) => {
    res.sendFile(path.join(__dirname, 'quote-builder.html'));
});

router.post('/quote-builder/run', express.json({ limit: '4mb' }), async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Missing "text" in body' });
    }
    try {
        const { runQuoteBuilderPipeline } = require('./quote-builder-pipeline');
        const result = await runQuoteBuilderPipeline(text);
        res.json(result);
    } catch (err) {
        console.error('[q-lab/quote-builder] pipeline error:', err);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// Q's chat page — high-end white aesthetic with the Q. logo
router.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});

// Q's tools / "what can Q do" overview page
router.get('/tools', (req, res) => {
    res.sendFile(path.join(__dirname, 'tools.html'));
});

// Q's adaptive writing coach. The user writes the document — Q asks
// questions and assembles. See plugins/q-writer.js.
router.get('/writer', (req, res) => {
    res.sendFile(path.join(__dirname, 'writer.html'));
});

// Q's personal finance page.
router.get('/finance', (req, res) => {
    res.sendFile(path.join(__dirname, 'finance.html'));
});

// Q's plotter — PDF AcroForm field parser. Reads the real field structure from
// a PDF (no vision needed). Client-side PDF.js does the parsing and rendering;
// this route just serves the page.
router.get('/plotter', (req, res) => {
    res.sendFile(path.join(__dirname, 'plotter.html'));
});

const qPlotter = require('./plugins/q-dot-plotter');

router.post('/plotter/analyze', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { imageDataUrl, dimensions } = req.body || {};
        if (!imageDataUrl) return res.status(400).json({ error: 'imageDataUrl required' });
        if (!dimensions || !dimensions.w || !dimensions.h) {
            return res.status(400).json({ error: 'dimensions { w, h } required' });
        }
        const result = await qPlotter.plotDots(imageDataUrl, dimensions);
        res.json({ ok: true, segments: result.segments });
    } catch (e) {
        console.error('[plotter/analyze]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Email: connect the user's Gmail + send "as yourself" (mirrors Quotem) ──
const qEmail = require('./plugins/q-email-accounts');

router.get('/email/status', requirePerson, (req, res) => {
    res.json(qEmail.status(req.person.email));
});

router.get('/email/gmail/start', requirePerson, (req, res) => {
    if (!qEmail.gmailConfigured()) {
        return res.status(503).json({ error: 'Gmail isn\'t set up on the server yet (missing Google OAuth credentials).' });
    }
    res.json({ url: qEmail.consentUrl(req.person.email) });
});

// Google redirects here — NO requirePerson (the cookie won't ride the redirect;
// identity is in the signed state instead).
router.get('/email/gmail/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/email-writer?email=denied');
    if (!code || !state) return res.redirect('/email-writer?email=error');
    try {
        await qEmail.handleCallback(code, state);
        return res.redirect('/email-writer?email=connected');
    } catch (e) {
        console.error('[email] gmail callback:', e.message);
        const q = e.message === 'no_refresh_token' ? 'noaccess' : (e.message === 'bad_state' ? 'badstate' : 'error');
        return res.redirect('/email-writer?email=' + q);
    }
});

// TTS — read email text aloud in a clear formal voice (Gemini TTS, "Charon" voice).
// Returns audio/wav. Falls back to 503 so the client can use the browser's Speech API instead.
router.post('/api/tts-email', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 5000);
    if (!text) return res.status(400).json({ error: 'No text provided.' });
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(503).json({ error: 'tts_unavailable' });
    try {
        const gr = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text }] }],
                    generationConfig: {
                        response_modalities: ['AUDIO'],
                        speech_config: {
                            voice_config: { prebuilt_voice_config: { voice_name: 'Charon' } },
                        },
                    },
                }),
            }
        );
        if (!gr.ok) {
            console.error('[tts-email] Gemini error:', (await gr.text()).slice(0, 300));
            return res.status(502).json({ error: 'tts_failed' });
        }
        const data = await gr.json();
        const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;
        if (!b64) return res.status(502).json({ error: 'no_audio' });
        // Gemini returns raw 16-bit LE PCM at 24 kHz mono. Wrap in a minimal WAV header.
        const pcm = Buffer.from(b64, 'base64');
        const sr = 24000, ch = 1, bps = 16;
        const wav = Buffer.alloc(44 + pcm.length);
        wav.write('RIFF', 0);  wav.writeUInt32LE(36 + pcm.length, 4);  wav.write('WAVE', 8);
        wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);               wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(ch, 22);  wav.writeUInt32LE(sr, 24);
        wav.writeUInt32LE(sr * ch * (bps / 8), 28); wav.writeUInt16LE(ch * (bps / 8), 32);
        wav.writeUInt16LE(bps, 34);
        wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
        pcm.copy(wav, 44);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', wav.length);
        res.end(wav);
    } catch (e) {
        console.error('[tts-email]', e.message);
        res.status(500).json({ error: 'tts_error' });
    }
});

// Resolve any thread-file references ({threadRef:true, threadId, filename}) into
// real {filename, base64, mimeType} objects. Plain base64 attachments pass through.
// Synchronous — qThreads.readFile is fs-backed (no network call).
function resolveThreadAttachments(attachments, ownerEmail) {
    if (!Array.isArray(attachments)) return [];
    return attachments.map(a => {
        if (a.threadRef && a.threadId && a.filename) {
            try {
                const file = qThreads.readFile(a.threadId, a.filename, ownerEmail);
                if (file && file.buffer) {
                    return { filename: file.filename || a.filename, base64: file.buffer.toString('base64'), mimeType: file.mimeType || 'application/octet-stream' };
                }
            } catch (e) { console.warn('[email] thread-file resolve failed:', a.filename, e.message); }
            return null;
        }
        return a;
    }).filter(Boolean);
}

router.post('/email/send', requirePerson, express.json({ limit: '10mb' }), async (req, res) => {
    const { to, subject, text, attachments, threadId } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
    try {
        const resolved = resolveThreadAttachments(attachments, req.person.email);
        const from = await qEmail.sendEmail(req.person.email, { to, subject, text: text || '', attachments: resolved });
        // Record on the case thread so it appears in correspondence.
        if (threadId) {
            try {
                const recorded = qThreads.addEmail(threadId, {
                    type: 'out', from: from || req.person.email,
                    to, subject, body: text || '',
                    date: new Date().toISOString().slice(0, 10),
                }, req.person.email);
                if (!recorded) console.error('[email] addEmail returned null — thread not found or wrong owner? threadId=%s email=%s', threadId, req.person.email);
            } catch (e2) { console.error('[email] addEmail failed:', e2.message); }
        }
        res.json({ ok: true, sentFrom: from });
    } catch (e) {
        if (e.code === 'not_connected') return res.status(409).json({ error: 'No email connected — connect Gmail first.' });
        console.error('[email] send:', e.message);
        res.status(502).json({ error: 'Could not send — your Gmail connection may need reconnecting.' });
    }
});

// Connect any other provider via SMTP + app password (the "add other providers"
// path — same store, provider:'smtp'; send route already handles it).
router.post('/email/smtp', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { host, port, user, pass, email } = req.body || {};
    if (!host || !user || !pass) return res.status(400).json({ error: 'host, user and pass are required' });
    try {
        const addr = await qEmail.connectSmtp(req.person.email, { address: email, host, port, user, pass });
        res.json({ ok: true, provider: 'smtp', email: addr });
    } catch (e) {
        res.status(400).json({ error: 'Could not sign in to that mail server — check the host, port and app password.' });
    }
});

// Outbox — emails saved to send later (used by email-writer + threads).
router.get('/email/outbox', requirePerson, (req, res) => {
    let outbox = qEmail.getOutbox(req.person.email);
    if (req.query.threadId) outbox = outbox.filter(x => x.threadId === req.query.threadId);
    res.json({ outbox });
});
router.post('/email/outbox', requirePerson, express.json({ limit: '10mb' }), (req, res) => {
    const { to, subject, body, threadId, attachments } = req.body || {};
    if (!subject && !body) return res.status(400).json({ error: 'Nothing to save.' });
    res.json({ ok: true, item: qEmail.addToOutbox(req.person.email, { to, subject, body, threadId, attachments }) });
});
router.post('/email/outbox/:id/send', requirePerson, async (req, res) => {
    try {
        const item = qEmail.getOutbox(req.person.email).find(x => x.id === req.params.id);
        if (!item) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
        // Resolve any thread-file references before sending, then call sendEmail directly.
        const resolvedAtts = resolveThreadAttachments(item.attachments, req.person.email);
        const from = await qEmail.sendEmail(req.person.email, { to: item.to, subject: item.subject, text: item.body, attachments: resolvedAtts });
        qEmail.removeFromOutbox(req.person.email, req.params.id);
        // Record on the case thread so it appears in correspondence.
        if (item.threadId) {
            try {
                const recorded = qThreads.addEmail(item.threadId, {
                    type: 'out', from: from || req.person.email,
                    to: item.to, subject: item.subject || '', body: item.body || '',
                    date: new Date().toISOString().slice(0, 10),
                }, req.person.email);
                if (!recorded) console.error('[email] addEmail returned null for outbox send — threadId=%s email=%s', item.threadId, req.person.email);
            } catch (e2) { console.error('[email] addEmail to thread failed:', e2.message); }
        }
        res.json({ ok: true, sentFrom: from });
    } catch (e) {
        if (e.code === 'not_found') return res.status(404).json({ error: 'That email is no longer in your outbox.' });
        if (e.code === 'not_connected') return res.status(409).json({ error: 'No email connected — connect Gmail first.' });
        console.error('[email] outbox send:', e.message);
        res.status(502).json({ error: 'Could not send — your email connection may need reconnecting.' });
    }
});
router.delete('/email/outbox/:id', requirePerson, (req, res) => {
    qEmail.removeFromOutbox(req.person.email, req.params.id);
    res.json({ ok: true });
});
router.patch('/email/outbox/:id/to', requirePerson, express.json({ limit: '1mb' }), (req, res) => {
    const ok = qEmail.patchOutboxItem(req.person.email, req.params.id, { to: String(req.body.to || '').trim() });
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});
// General patch — update body, subject, attachments
router.patch('/email/outbox/:id', requirePerson, express.json({ limit: '20mb' }), (req, res) => {
    const patch = {};
    if (req.body.body !== undefined) patch.body = String(req.body.body || '');
    if (req.body.subject !== undefined) patch.subject = String(req.body.subject || '');
    if (Array.isArray(req.body.attachments)) patch.attachments = req.body.attachments;
    const ok = qEmail.patchOutboxItem(req.person.email, req.params.id, patch);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

const qFormFiller = require('./plugins/q-form-filler');
const { fillPdfForWord } = qFormFiller;
const docEditor = require('./plugins/q-doc-editor');

// POST /forms/label
// Body: { pageImages: [dataUrl, ...], totalTags: number }
// Returns: { labels: { tagNumberAsString: humanLabel } }
// Vision model looks at the rendered form pages with numbered tags drawn on
// each field, labels every tag based on what it sees on the page.
router.post('/forms/label', requirePerson, express.json({ limit: '32mb' }), async (req, res) => {
    try {
        const { pageImages, totalTags, documentText } = req.body || {};
        if (!Array.isArray(pageImages) || !pageImages.length) {
            return res.status(400).json({ error: 'pageImages required' });
        }
        const labels = await qFormFiller.labelFields(pageImages, totalTags || 0, documentText || '');
        res.json({ ok: true, labels });
    } catch (e) {
        console.error('[forms/label]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /forms/extract
// Body: { fields: [{name, type}], infoText, imageDataUrl? }
// Returns: { values: { fieldName: value }, ask: [{ field, question }] }
//   values = confident fills; ask = fields Q couldn't fill → the UI asks the user.
router.post('/forms/extract', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { fields, infoText, imageDataUrl } = req.body || {};
        if (!fields || !fields.length) return res.status(400).json({ error: 'fields required' });
        if (!infoText && !imageDataUrl) return res.status(400).json({ error: 'infoText or imageDataUrl required' });
        const { values, ask } = await qFormFiller.extractFieldValues(fields, infoText || '', imageDataUrl || null);
        res.json({ ok: true, values, ask });
    } catch (e) {
        console.error('[forms/extract]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /forms/fill
// Body: { pdfBase64, fields: [{name, type}], infoText, imageDataUrl? }
// Returns: filled PDF as application/pdf download
router.post('/forms/fill', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { pdfBase64, fields, infoText, imageDataUrl, values: directValues } = req.body || {};
        if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' });

        const pdfBytes = Buffer.from(pdfBase64, 'base64');
        let filledBytes, results;

        if (directValues && typeof directValues === 'object' && Object.keys(directValues).length) {
            // Field-by-field mode: values already extracted by the UI, skip Q
            ({ filledBytes, results } = await qFormFiller.fillPdf(pdfBytes, directValues));
        } else {
            // Paste/voice mode: Q extracts values from infoText or image
            if (!fields || !fields.length) return res.status(400).json({ error: 'fields required' });
            if (!infoText && !imageDataUrl) return res.status(400).json({ error: 'infoText or imageDataUrl required' });
            ({ filledBytes, results } = await qFormFiller.intakeAndFill({
                pdfBytes, fields, infoText: infoText || '', imageDataUrl: imageDataUrl || null,
            }));
        }

        console.log(`[forms/fill] filled ${results.filled.length}, skipped ${results.skipped.length}, not found ${results.notFound.length}`);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="filled-form.pdf"',
            'X-Fields-Filled': String(results.filled.length),
            'X-Fields-Skipped': String(results.skipped.length),
        });
        res.send(Buffer.from(filledBytes));
    } catch (e) {
        console.error('[forms/fill]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /forms/fill-editable
// Body: { pdfBase64, values: { fieldName: value } }
// Returns an EDITABLE PDF — values are set into the real form fields and the PDF
// is NOT flattened, so it opens fillable in any PDF reader and the user can fix
// anything that isn't perfect.
router.post('/forms/fill-editable', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { pdfBase64, values } = req.body || {};
        if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' });
        if (!values || typeof values !== 'object' || !Object.keys(values).length) {
            return res.status(400).json({ error: 'values required' });
        }
        const { filledBytes, results } = await qFormFiller.fillPdfEditable(Buffer.from(pdfBase64, 'base64'), values);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="editable-form.pdf"',
            'X-Fields-Filled': String(results.filled.length),
        });
        res.send(Buffer.from(filledBytes));
    } catch (e) {
        console.error('[forms/fill-editable]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /forms/fill-public-link
// Same input as /forms/fill but stashes the filled PDF and returns a JSON
// { url, filename } pointing at /public-download/:token — used by the
// "Open in Google Docs" button to feed Google's viewer a public URL.
// Token is unguessable (64 bits) and expires in 24h.
router.post('/forms/fill-public-link', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { pdfBase64, values: directValues, fields, infoText, imageDataUrl } = req.body || {};
        if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' });

        const pdfBytes = Buffer.from(pdfBase64, 'base64');
        let filledBytes;
        if (directValues && typeof directValues === 'object' && Object.keys(directValues).length) {
            ({ filledBytes } = await qFormFiller.fillPdf(pdfBytes, directValues));
        } else {
            if (!fields || !fields.length) return res.status(400).json({ error: 'fields required' });
            if (!infoText && !imageDataUrl) return res.status(400).json({ error: 'infoText or imageDataUrl required' });
            ({ filledBytes } = await qFormFiller.intakeAndFill({
                pdfBytes, fields, infoText: infoText || '', imageDataUrl: imageDataUrl || null,
            }));
        }

        const { stashFile } = require('./plugins/doc-creator');
        const stashed = stashFile(Buffer.from(filledBytes), 'pdf', 'filled-form', req.person.email);
        // Build the absolute public URL Google's servers can fetch
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const url = `${proto}://${host}/public-download/${stashed.token}`;
        res.json({ ok: true, url, filename: stashed.filename, expiresInHours: 24 });
    } catch (e) {
        console.error('[forms/fill-public-link]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /forms/fill-docx
// Same as /forms/fill but converts the filled PDF to .docx via LibreOffice
// and returns a Word document. Works for any PDF form.
router.post('/forms/fill-docx', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    const tmpId = randomUUID();
    const tmpPdf  = path.join(os.tmpdir(), `q-form-${tmpId}.pdf`);
    const tmpDocx = path.join(os.tmpdir(), `q-form-${tmpId}.docx`);
    const loProfile = path.join(os.tmpdir(), `lo-${tmpId}`);
    try {
        const { pdfBase64, fields, infoText, imageDataUrl, values: directValues } = req.body || {};
        if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' });

        const pdfBytes = Buffer.from(pdfBase64, 'base64');
        let filledBytes, results;

        if (directValues && typeof directValues === 'object' && Object.keys(directValues).length) {
            ({ filledBytes, results } = await fillPdfForWord(pdfBytes, directValues));
        } else {
            if (!fields || !fields.length) return res.status(400).json({ error: 'fields required' });
            if (!infoText && !imageDataUrl) return res.status(400).json({ error: 'infoText or imageDataUrl required' });
            const extracted = await qFormFiller.extractFieldValues(fields, infoText || '', imageDataUrl || null);
            ({ filledBytes, results } = await fillPdfForWord(pdfBytes, extracted));
        }

        fs.writeFileSync(tmpPdf, Buffer.from(filledBytes));

        await new Promise((resolve, reject) => {
            execFile('soffice', [
                '--headless',
                `--env:UserInstallation=file://${loProfile}`,
                '--convert-to', 'docx',
                '--outdir', os.tmpdir(),
                tmpPdf,
            ], { timeout: 60000 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(`LibreOffice failed: ${stderr || err.message}`));
                resolve();
            });
        });

        const docxBytes = fs.readFileSync(tmpDocx);
        console.log(`[forms/fill-docx] filled ${results.filled.length}, docx ${docxBytes.length} bytes`);
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': 'attachment; filename="filled-form.docx"',
            'X-Fields-Filled': String(results.filled.length),
        });
        res.send(docxBytes);
    } catch (e) {
        console.error('[forms/fill-docx]', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        for (const f of [tmpPdf, tmpDocx]) try { fs.unlinkSync(f); } catch {}
        try { fs.rmSync(loProfile, { recursive: true, force: true }); } catch {}
    }
});

// ─── DOC EDITOR ROUTES ────────────────────────────────────────
// Browser uploads a .docx, the server stores it in the per-user session,
// Q's tools read and modify it, browser fetches the latest state to render.

// POST /doc-editor/upload  — Body: { dataUrl, filename, fieldValues? }
// fieldValues is the optional "receipt" from the form-filler so Q knows
// what was originally filled where.
router.post('/doc-editor/upload', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { dataUrl, filename, fieldValues } = req.body || {};
        if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });
        const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (!m) return res.status(400).json({ error: 'dataUrl must be base64-encoded' });
        const bytes = Buffer.from(m[1], 'base64');
        // Sanity check: try to read it
        const paragraphs = docEditor.readDoc(bytes);
        docEditor.setSession(req.person.id, {
            bytes,
            filename: filename || 'document.docx',
            fieldValues: fieldValues || null,
        });
        res.json({ ok: true, paragraphs, filename: filename || 'document.docx' });
    } catch (e) {
        console.error('[doc-editor/upload]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /doc-editor/state  — current paragraphs + filename, used by the UI
// to refresh the preview after each tool call.
router.get('/doc-editor/state', requirePerson, (req, res) => {
    const session = docEditor.getSession(req.person.id);
    if (!session || !session.bytes) return res.json({ open: false });
    try {
        const paragraphs = docEditor.readDoc(session.bytes);
        res.json({
            open: true,
            filename: session.filename,
            paragraphs,
            fieldValues: session.fieldValues || null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /doc-editor/download  — return the current .docx
router.get('/doc-editor/download', requirePerson, (req, res) => {
    const session = docEditor.getSession(req.person.id);
    if (!session || !session.bytes) return res.status(404).json({ error: 'No document open' });
    res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${session.filename || 'document.docx'}"`,
    });
    res.send(session.bytes);
});

// POST /doc-editor/close  — clear the session (user finished editing)
router.post('/doc-editor/close', requirePerson, (req, res) => {
    docEditor.clearSession(req.person.id);
    res.json({ ok: true });
});

const qWriter = require('./plugins/q-writer');

router.post('/writer/analyse', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    try {
        const taskText = (req.body?.taskText || '').toString().trim();
        if (!taskText) return res.status(400).json({ error: 'taskText required' });
        const analysis = await qWriter.analyseTask(taskText);
        res.json({ ok: true, analysis });
    } catch (e) {
        console.error('[writer/analyse]', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.post('/writer/next-question', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    try {
        const analysis = req.body?.analysis;
        const history = Array.isArray(req.body?.history) ? req.body.history : [];
        if (!analysis) return res.status(400).json({ error: 'analysis required' });
        const next = await qWriter.nextQuestion(analysis, history);
        res.json({ ok: true, ...next });
    } catch (e) {
        console.error('[writer/next-question]', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.post('/writer/assemble', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    try {
        const analysis = req.body?.analysis;
        const history = Array.isArray(req.body?.history) ? req.body.history : [];
        if (!analysis || history.length === 0) {
            return res.status(400).json({ error: 'analysis and history required' });
        }
        const result = await qWriter.assembleDocument(analysis, history);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/assemble]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Writer Slice 1 routes ──────────────────────────────────────────────────

// GET /writer/voice — load stored voice signature for this person
router.get('/writer/voice', requirePerson, async (req, res) => {
    try {
        const p = getVoicePath(req.person.id);
        if (!fs.existsSync(p)) return res.json({ ok: true, signature: null });
        const sig = JSON.parse(fs.readFileSync(p, 'utf8'));
        res.json({ ok: true, signature: sig });
    } catch (e) {
        res.json({ ok: true, signature: null });
    }
});

// POST /writer/voice — analyse voice sample and store it for this person
router.post('/writer/voice', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const sampleText = (req.body?.sampleText || '').toString().trim();
    if (sampleText.length < 30) return res.status(400).json({ error: 'sampleText too short (30 chars min)' });
    try {
        const sig = await qWriter.analyseVoice(sampleText);
        fs.writeFileSync(getVoicePath(req.person.id), JSON.stringify(sig, null, 2), 'utf8');
        res.json({ ok: true, signature: sig });
    } catch (e) {
        console.error('[writer/voice]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/doc — store the full extracted document text for this person
router.post('/writer/doc', requirePerson, express.json({ limit: '4mb' }), async (req, res) => {
    const { text, name } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    try {
        const docPath = getDocPath(req.person.id);
        fs.writeFileSync(docPath, JSON.stringify({ text, name: name || 'document', savedAt: Date.now() }));
        res.json({ ok: true });
    } catch (e) {
        console.error('[writer/doc store]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /writer/doc — load stored document for this person
router.get('/writer/doc', requirePerson, async (req, res) => {
    try {
        const docPath = getDocPath(req.person.id);
        if (!fs.existsSync(docPath)) return res.json({ ok: true, text: null });
        const { text, name, savedAt } = JSON.parse(fs.readFileSync(docPath, 'utf8'));
        res.json({ ok: true, text, name, savedAt });
    } catch (e) {
        res.json({ ok: true, text: null });
    }
});

// POST /writer/tutor — Q's tutor notebook for this person. The writer page
// writes here as Q coaches: the brief he built, which section they're on, the
// last thing they were stuck on. Merge-write so partial updates (just the
// current section, just "stuck on") don't clobber the rest. Read back by the
// recall_tutor tool from any surface — "what was that question I was stuck on?"
router.post('/writer/tutor', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    try {
        const tutorPath = getTutorPath(req.person.id);
        let existing = {};
        try {
            if (fs.existsSync(tutorPath)) existing = JSON.parse(fs.readFileSync(tutorPath, 'utf8')) || {};
        } catch (_) { existing = {}; }
        // Only overwrite keys the client actually sent.
        const patch = {};
        for (const k of ['task', 'whatItWants', 'teachersBrief', 'markedSections', 'gradeBands', 'currentSection', 'lastQuestion', 'lastStuckOn']) {
            if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
        }
        const merged = { ...existing, ...patch, updatedAt: Date.now() };
        fs.writeFileSync(tutorPath, JSON.stringify(merged));
        res.json({ ok: true });
    } catch (e) {
        console.error('[writer/tutor store]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /writer/tutor — load the tutor notebook for this person
router.get('/writer/tutor', requirePerson, async (req, res) => {
    try {
        const tutorPath = getTutorPath(req.person.id);
        if (!fs.existsSync(tutorPath)) return res.json({ ok: true, tutor: null });
        res.json({ ok: true, tutor: JSON.parse(fs.readFileSync(tutorPath, 'utf8')) });
    } catch (e) {
        res.json({ ok: true, tutor: null });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// DORMANT — replaced 2026-05-17. The brief + leading questions now run through
// the one /chat brain (surface:'writer', SURFACE_PROMPTS.writer) so Q reads
// the doc himself like he does everywhere else, instead of a separate
// JSON-extraction pipeline that silently {}'d on long briefs. Kept in place
// (not deleted) as a reversible fallback. analyseTask/tutorBrief/
// askLeadingQuestion in plugins/q-writer.js are no longer on the live path.
// ─────────────────────────────────────────────────────────────────────────

// POST /writer/brief — analyse the task and build the tutor's brief (two-step in one call)
router.post('/writer/brief', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    const taskText = (req.body?.taskText || '').toString().trim();
    if (!taskText) return res.status(400).json({ error: 'taskText required' });
    try {
        const analysis = await qWriter.analyseTask(taskText);
        const brief = await qWriter.tutorBrief(analysis);
        res.json({ ok: true, analysis, brief });
    } catch (e) {
        console.error('[writer/brief]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/lead — ask the next leading question for the current section
router.post('/writer/lead', requirePerson, express.json({ limit: '128kb' }), async (req, res) => {
    const { analysis, brief, history, voiceSignature, relateAnchor, yearGroup } = req.body || {};
    if (!analysis || !brief) return res.status(400).json({ error: 'analysis and brief required' });
    try {
        // Load the full document from the server-side store
        let docContext = null;
        try {
            const docPath = getDocPath(req.person.id);
            if (fs.existsSync(docPath)) {
                const stored = JSON.parse(fs.readFileSync(docPath, 'utf8'));
                docContext = stored.text || null;
            }
        } catch (_) {}
        const result = await qWriter.askLeadingQuestion(
            analysis, brief, history || [], voiceSignature, relateAnchor, yearGroup, docContext
        );
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/lead]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/reframe — reframe the student's raw answer in their own voice
router.post('/writer/reframe', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { rawAnswer, question, context, voiceSignature, relateAnchor, yearGroup } = req.body || {};
    if (!rawAnswer) return res.status(400).json({ error: 'rawAnswer required' });
    try {
        const result = await qWriter.reframeInVoice(
            rawAnswer, question, context, voiceSignature, relateAnchor, yearGroup
        );
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/reframe]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/words — suggest word swaps for a clicked word
router.post('/writer/words', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const { word, context, voiceSignature } = req.body || {};
    if (!word) return res.status(400).json({ error: 'word required' });
    try {
        const result = await qWriter.suggestWordSwaps(word, context, voiceSignature);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/words]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/harvard — format a source into a Harvard reference
router.post('/writer/harvard', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const sourceDescription = (req.body?.sourceDescription || '').toString().trim();
    if (!sourceDescription) return res.status(400).json({ error: 'sourceDescription required' });
    try {
        const result = await qWriter.formatHarvardRef(sourceDescription);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/harvard]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/refs — suggest references for the current document
router.post('/writer/refs', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { docText, subject, keyConcepts } = req.body || {};
    try {
        const result = await qWriter.suggestReferences(docText, subject, keyConcepts);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/refs]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/explain — plain-English explanation of a concept + search terms
router.post('/writer/explain', requirePerson, express.json({ limit: '16kb' }), async (req, res) => {
    const { concept, subject, yearGroup } = req.body || {};
    if (!concept) return res.status(400).json({ error: 'concept required' });
    try {
        const result = await qWriter.explainConcept(concept, subject, yearGroup);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/explain]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/mark-section — grade a completed section (red/amber/green)
router.post('/writer/mark-section', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { sectionText, sectionName, analysis, gradeScheme } = req.body || {};
    if (!sectionText) return res.status(400).json({ error: 'sectionText required' });
    try {
        const result = await qWriter.markSection(sectionText, sectionName, analysis, gradeScheme);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/mark-section]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/improve — coaching suggestions to reach the next grade
router.post('/writer/improve', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { sectionText, sectionName, currentGrade, voiceSignature, analysis, relateAnchor, yearGroup } = req.body || {};
    if (!sectionText) return res.status(400).json({ error: 'sectionText required' });
    try {
        const result = await qWriter.improveSectionStep(
            sectionText, sectionName, currentGrade, voiceSignature, analysis, relateAnchor, yearGroup
        );
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/improve]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/ref-para — suggest references for a highlighted paragraph
router.post('/writer/ref-para', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const { paragraphText, subject, keyConcepts } = req.body || {};
    if (!paragraphText) return res.status(400).json({ error: 'paragraphText required' });
    try {
        const result = await qWriter.referenceParagraph(paragraphText, subject, keyConcepts);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/ref-para]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /writer/starter — Q writes a basic starter sentence when asked; respects word budget
router.post('/writer/starter', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const { question, context, voiceSignature, relateAnchor, yearGroup, qWordsWritten } = req.body || {};
    try {
        const result = await qWriter.writeStarter(
            question || '', context, voiceSignature, relateAnchor, yearGroup, qWordsWritten || 0
        );
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[writer/starter]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Push notification routes ────────────────────────────────────────────────

// GET /push/vapid-public-key — return the public VAPID key so the client can
// subscribe. Auth required: only signed-in users should set up push.
router.get('/push/vapid-public-key', requirePerson, (req, res) => {
    try {
        res.json({ key: qPush.getPublicKey() });
    } catch (e) {
        console.error('[push/vapid]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /push/subscribe — save a push subscription for the current user
router.post('/push/subscribe', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    try {
        qPush.saveSubscription(req.person.email, req.body);
        res.json({ ok: true });
    } catch (e) {
        console.error('[push/subscribe]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /push/subscribe — remove a subscription (e.g. when user revokes permission)
router.delete('/push/subscribe', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const endpoint = (req.body || {}).endpoint;
    if (endpoint) qPush.removeSubscription(req.person.email, endpoint);
    res.json({ ok: true });
});

// Q's chat API — uses server-side memory by default
// Body: { message: "..." } (preferred — uses server memory)
//   OR: { messages: [...] } (legacy — full history sent each time)
router.post('/chat', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
  try {
    const person = req.person; // attached by requirePerson — { id, name, intro, addedAt }
    const newMessage = req.body?.message;
    const messagesArray = req.body?.messages;
    // Which UI surface this message came from. Used for visual filtering on
    // the front-end so the chat box only shows messages from /chat and the
    // writer card only shows messages from /writer. Q's prompt sees the
    // FULL thread regardless of surface so he has continuous memory.
    const surface = (req.body?.surface || 'chat').toString().toLowerCase();
    // Reasoning effort. V4 Pro values: 'high' / 'max' / undefined.
    //
    // Quick is Think-by-default. Reason: Sarah found Q on pure non-think too
    // shallow — having to send three messages where one should do. People
    // won't repeat themselves on a product, so smart-default beats
    // fastest-default. Quick drops to genuine non-think (undefined) ONLY for
    // trivially short, non-question messages (greetings, acknowledgements),
    // so "hi" and "thanks" stay fast.
    //
    // Think/Deep manual selections are untouched ('high' / 'max').
    const rawEffort = req.body?.reasoningEffort;
    let reasoningEffort;
    if (rawEffort === 'high' || rawEffort === 'max') {
        reasoningEffort = rawEffort;
    } else if (rawEffort === 'off') {
        reasoningEffort = undefined; // explicit off — no reasoning
    } else {
        // Default: high reasoning, but skip for trivially short messages
        reasoningEffort = 'high';
        if (typeof req.body?.message === 'string') {
            const m = req.body.message.trim();
            const trivial = m.length < 25
                && !m.includes('?')
                && !m.includes('```')
                && !/\d/.test(m);
            if (trivial) reasoningEffort = undefined;
        }
    }
    const rawImages = req.body?.images;
    const images = Array.isArray(rawImages)
        ? rawImages.filter(i => i && typeof i.dataUrl === 'string' && i.dataUrl.startsWith('data:'))
        : [];
    const useTools = req.body?.useTools !== false;
    const verify = req.body?.verify === true;
    // Optional persona overlay: 'aps' for A-Problem-Shared mode. Anything else
    // (including undefined) leaves Q in default mode.
    const mode = (req.body?.mode === 'aps') ? 'aps' : undefined;
    const testModel = req.body?.testModel || undefined;
    const chatOptions = { reasoningEffort, images, useTools, verify, mode, person, surface, ...(testModel && { model: testModel }) };

    // Image-only sends arrive with message === "" but a non-empty images array
    // (paste of a screenshot, OCR fallback for scanned PDFs, etc.). Treat them
    // as a valid turn and prompt Q implicitly so the vision model has a question
    // to answer. Without this fallback the server rejected with "Body must
    // include either { message: ... } or { messages: [...] }".
    let effectiveMessage = (typeof newMessage === 'string') ? newMessage : '';
    if (!effectiveMessage.trim() && images.length > 0) {
        effectiveMessage = 'What can you tell me about this?';
    }

    if (typeof effectiveMessage === 'string' && effectiveMessage.trim()) {
        // Q sees ONE chat thread per surface — chat thread for /chat,
        // writer thread for /writer. So when Sarah comes back to the
        // writer in two days the conversation context is intact.
        // The bridge between surfaces is Q's FACTS, not the chat history.
        // Facts are one shared store per person (q-facts-{personId}.json)
        // and Q reads them on every turn regardless of surface.
        const allMessages = loadMemory(person.id);
        const surfaceMessages = allMessages.filter(m => (m.surface || 'chat') === surface);
        const rawHistory = surfaceMessages.slice(-50);
        const history = rawHistory.map(m => {
            const ts = m.timestamp ? m.timestamp.slice(0, 16).replace('T', ' ') : '?';
            return {
                role: m.role,
                content: `[${ts}] ${m.content}`,
            };
        });
        // Tell Q the current moment so he can locate himself in time
        const now = new Date();
        const nowStr = now.toISOString().slice(0, 16).replace('T', ' ');
        // Build a read-only digest of other page threads so Q has cross-page
        // visibility without bleeding them into the active conversation.
        // Max 5 messages per other surface, truncated to 300 chars each.
        const otherSurfaceMap = {};
        for (const m of allMessages) {
            const s = m.surface || 'chat';
            if (s === surface) continue;
            if (!otherSurfaceMap[s]) otherSurfaceMap[s] = [];
            otherSurfaceMap[s].push(m);
        }
        const otherEntries = Object.entries(otherSurfaceMap);
        let crossRef = '';
        if (otherEntries.length > 0) {
            const lines = otherEntries.map(([s, msgs]) => {
                const recent = msgs.slice(-5).map(m => {
                    const ts = m.timestamp ? m.timestamp.slice(0, 16).replace('T', ' ') : '?';
                    const who = m.role === 'user' ? person.name : 'Q';
                    const text = (m.content || '').slice(0, 300).replace(/\n/g, ' ');
                    return `  [${ts}] ${who}: ${text}${m.content.length > 300 ? '…' : ''}`;
                }).join('\n');
                return `[${s.toUpperCase()} PAGE]\n${recent}`;
            }).join('\n\n');
            crossRef = `\n\n--- YOUR OTHER CONVERSATIONS (read-only reference — don't continue these threads here, but you can mention them if relevant) ---\n${lines}\n--- END REFERENCE ---`;
        }
        history.unshift({
            role: 'system',
            content: `It is now ${nowStr} (UTC). You're talking to ${person.name}. The history below shows previous turns between you two with their timestamps — note any gaps between sessions and respond as someone who has had time pass, not as if every turn just happened.${crossRef}`,
        });
        const userMemoryContent = images.length > 0
            ? newMessage + `\n[${person.name} attached ${images.length} image${images.length > 1 ? 's' : ''}]`
            : newMessage;
        const messagesForQ = [
            ...history,
            { role: 'user', content: userMemoryContent },
        ];
        appendMessage(person.id, 'user', userMemoryContent, surface);
        if (surface === 'writer') {
            console.log('[/chat writer] IN msg=' + effectiveMessage.length + ' chars, images=' + images.length + ', reasoning=' + (reasoningEffort || 'off') + ', history=' + history.length);
        }
        const result = await chat(messagesForQ, chatOptions);
        if (result.reply) appendMessage(person.id, 'assistant', result.reply, surface);
        if (surface === 'writer') {
            const r = result.reply || '';
            console.log('[/chat writer] OUT reply=' + r.length + ' chars, hasBriefBlock=' + /```writer-brief/.test(r) + ', upstreamStatus=' + (result.upstreamStatus || 'ok') + ', first 200: ' + r.slice(0, 200).replace(/\n/g, ' '));
        }
        return res.json(result);
    }

    if (Array.isArray(messagesArray) && messagesArray.length > 0) {
        // Stateless one-shot — still scoped to the authenticated person
        const result = await chat(messagesArray, chatOptions);
        return res.json(result);
    }

    return res.status(400).json({
        error: 'Body must include either { message: "..." } or { messages: [...] }',
    });
  } catch (err) {
    console.error('[/chat] unhandled error:', err.message, err.stack?.slice(0, 400));
    if (!res.headersSent) res.status(500).json({ error: 'internal error', reply: null });
  }
});

// GET Q's memory for the calling person. Each person has their own file —
// no filtering or cross-person bleed. Sarah's wipe doesn't touch anyone
// else; nobody else's wipe touches Sarah.
router.get('/chat-history', requirePerson, (req, res) => {
    const surface = (req.query.surface || '').toString().toLowerCase();
    let messages = loadMemory(req.person.id);
    // Filter by surface if requested. Messages without a surface tag are
    // legacy from before the split — treat them as 'chat' so the main
    // chat keeps showing the full history.
    if (surface) {
        messages = messages.filter(m => (m.surface || 'chat') === surface);
    }
    return res.json({ messages, storedAt: getMemoryPath(req.person.id) });
});

// Wipe THIS person's memory only. Sarah's clear doesn't touch anyone else's;
// a friend's clear doesn't touch Sarah's. Each person owns their own thread.
router.delete('/chat-history', requirePerson, (req, res) => {
    const ok = clearMemory(req.person.id);
    res.json({ ok });
});

// ── Extract text from an uploaded document ────────────────────────────────
// Receives a base64 data URL, decodes it, runs the appropriate parser, and
// returns the extracted plain text. The chat front-end calls this when the
// user drops a PDF or Word doc, then prepends the text into Q's message.
//
// Body: { dataUrl: 'data:application/pdf;base64,...', name?: 'whatever.pdf' }
// Returns: { text, pages?, name }
router.post('/extract-text', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    const dataUrl = req.body?.dataUrl;
    const name = req.body?.name || 'document';
    if (!dataUrl || typeof dataUrl !== 'string') {
        return res.status(400).json({ error: 'dataUrl required' });
    }
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
        return res.status(400).json({ error: 'Expected base64 data URL' });
    }
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const lowerName = String(name).toLowerCase();
    console.log('[extract-text] received name="' + name + '" mime=' + mimeType + ' bytes=' + buffer.length);

    try {
        // PDF
        if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            const pdfText = (data.text || '').trim();
            console.log('[extract-text] pdf "' + name + '" → ' + pdfText.length + ' chars, ' + (data.numpages || 0) + ' pages, first 300: ' + pdfText.slice(0, 300).replace(/\n/g, ' '));
            return res.json({
                text: pdfText,
                pages: data.numpages || 0,
                name,
                kind: 'pdf',
            });
        }
        // Word .docx (modern Office Open XML)
        if (
            mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            || lowerName.endsWith('.docx')
        ) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            const docxText = (result.value || '').trim();
            console.log('[extract-text] docx "' + name + '" → ' + docxText.length + ' chars, first 300: ' + docxText.slice(0, 300).replace(/\n/g, ' '));
            return res.json({
                text: docxText,
                name,
                kind: 'docx',
            });
        }
        return res.status(400).json({ error: 'Unsupported file type for extraction.' });
    } catch (e) {
        console.warn('[extract-text] failed for ' + name + ': ' + e.message);
        return res.status(500).json({
            error: `Could not read that file: ${e.message}`,
        });
    }
});

// ── Q's circle — admin endpoints (Sarah only) ──────────────────────────────
router.get('/circle/people', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    res.json({ people: listPeople() });
});

router.delete('/circle/people/:id', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    if (isAdmin(getPerson(req.params.id))) return res.status(400).json({ error: 'Cannot remove the admin account.' });
    const ok = removePerson(req.params.id);
    res.json({ ok });
});

// How many accounts are waiting for approval (drives the admin badge).
router.get('/circle/pending-count', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    const pending = listPeople().filter(p => p.approved === false).length;
    res.json({ pending });
});

// Approve a pending account so the person can sign in.
router.post('/circle/people/:id/approve', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    const person = approvePerson(req.params.id);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    res.json({ ok: true, person });
});

// Reject a pending account — removes it entirely (same as Quotem's reject).
router.post('/circle/people/:id/reject', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    if (isAdmin(getPerson(req.params.id))) return res.status(400).json({ error: 'Cannot reject the admin account.' });
    const ok = removePerson(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Person not found' });
    res.json({ ok: true });
});

// ── Cost tracking — Sarah only ─────────────────────────────────────────────
router.get('/admin/costs', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    const groupBy = req.query.groupBy || 'skill';
    const since = req.query.since;
    const until = req.query.until;
    res.json({
        ...summariseCosts({ since, until, groupBy }),
        groupBy,
        logPath: costLogPath(),
    });
});

// Admin landing — tile grid linking to each admin sub-page. Sarah-only
// check is enforced client-side via /whoami; the static HTML is open.
router.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin · tools page (HTML). Data comes from /admin/tools-data below.
router.get('/admin/tools', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-tools.html'));
});

// Admin · members page (HTML). Approve / reject sign-ups. Data via /circle/people.
router.get('/admin/members', (req, res) => {
    res.sendFile(path.join(__dirname, 'members.html'));
});

// Admin · tools metadata. Sarah-only. Lists every tool Q can call, its
// provider, and what it costs per call. Pricing pulled from cost-tracker
// where available; static descriptions kept inline so the admin page
// stays self-contained.
router.get('/admin/tools-data', requirePerson, (req, res) => {
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    res.json({
        tools: [
            {
                name: 'web_search', label: 'Web search', icon: '🔎',
                desc: 'Live web results via Brave Search. Q calls this only when you ask him to look something up.',
                cost: '~£0.0002 / call', provider: 'Brave Search API', gated: true,
            },
            {
                name: 'calculator', label: 'Calculator', icon: '🧮',
                desc: 'Accurate maths — Q is bad at arithmetic without it.',
                cost: 'free', provider: 'local', gated: false,
            },
            {
                name: 'current_datetime', label: 'Current date/time', icon: '🕒',
                desc: 'Timezone-aware time lookup. Q already knows the date from his system prompt; this tool covers timezone-specific cases.',
                cost: 'free', provider: 'local', gated: false,
            },
            {
                name: 'analyze_document', label: 'Read a document', icon: '📄',
                desc: "Q's eyes for a document — vision model reads PDF / image / scan and pulls out the text.",
                cost: '~£0.0008 / call', provider: 'Qwen3.6-Plus on Together AI', gated: false,
            },
            {
                name: 'create_document', label: 'Make a document', icon: '📝',
                desc: 'Generates a downloadable .docx file from text Q has produced. The brain call to write the contents is billed as normal chat.',
                cost: 'free (local) + chat tokens', provider: 'local docx + Together AI', gated: false,
            },
            {
                name: 'remember', label: 'Remember', icon: '🧠',
                desc: 'Stores a fact in long-term memory. Q uses this proactively whenever something matters across sessions.',
                cost: 'free', provider: 'local file', gated: false,
            },
            {
                name: 'recall', label: 'Recall', icon: '🔁',
                desc: 'Searches stored facts. Free, local, no API hit.',
                cost: 'free', provider: 'local file', gated: false,
            },
            {
                name: '__main_brain__', label: "Q's main brain (chat)", icon: '🤖',
                desc: 'DeepSeek V4 Pro on Together AI. The model that powers every reply. Not a tool — listed here so you can see the cost.',
                cost: '£0.78 / M in · £2.34 / M out', provider: 'Together AI', gated: false,
            },
            {
                name: '__vision__', label: "Q's eyes (vision)", icon: '👁️',
                desc: "Qwen3.6-Plus on Together AI — used when Q sees an image. Streaming-only, costlier than the main brain per token.",
                cost: '£0.39 / M in · £1.83 / M out', provider: 'Together AI', gated: false,
            },
        ],
    });
});

// Q's translator — converts work items to SOR search terms
// POST body: { items: [{ work, intent, detail }] }
router.post('/translator', express.json({ limit: '256kb' }), async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Body must include items array' });
    }
    try {
        const terms = await translateToSOR(items);
        res.json({ terms, count: terms.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET variant for quick browser test: ?work=Service+and+align+door&intent=repair
router.get('/translator', async (req, res) => {
    const work = req.query.work;
    const intent = req.query.intent || 'inspect';
    const detail = req.query.detail || '';
    if (!work) {
        return res.status(400).json({
            error: 'Missing ?work=... query param',
            example: '/api/q-lab/translator?work=Service+and+align+door&intent=repair',
        });
    }
    try {
        const terms = await translateToSOR([{ work, intent, detail }]);
        res.json({ term: terms[0], allTerms: terms });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Q's checker — verifies SOR results against original intent
// POST body: { originalText, workItems: [...], sorResults: [...] }
router.post('/checker', express.json({ limit: '512kb' }), async (req, res) => {
    const originalText = req.body?.originalText || '';
    const workItems = req.body?.workItems;
    const sorResults = req.body?.sorResults;
    if (!Array.isArray(workItems) || !Array.isArray(sorResults)) {
        return res.status(400).json({
            error: 'Body must include workItems[] and sorResults[]',
            example: { originalText: '...', workItems: [{ work: '...', intent: '...', detail: '...' }], sorResults: [{ sorCode: '...', description: '...', price: 0 }] },
        });
    }
    try {
        const result = await checkResults(originalText, workItems, sorResults);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Q's expander — breaks multi-trade jobs into individual SOR-priceable items
// POST body: { description, breakdownNote? }
router.post('/expander', express.json({ limit: '128kb' }), async (req, res) => {
    const description = req.body?.description;
    const breakdownNote = req.body?.breakdownNote || '';
    if (!description) {
        return res.status(400).json({ error: 'Body must include description' });
    }
    try {
        const items = await expandItem(description, breakdownNote);
        res.json({ items, count: items.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET variant for quick browser test
router.get('/expander', async (req, res) => {
    const description = req.query.description || req.query.q;
    if (!description) {
        return res.status(400).json({
            error: 'Missing ?description=... query param',
            example: '/api/q-lab/expander?description=Full+Habinteg+kitchen',
        });
    }
    try {
        const items = await expandItem(description, req.query.note || '');
        res.json({ items, count: items.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Q's pricer — prices off-catalogue items (those SOR doesn't have)
// READ-ONLY in q-lab — does not write to Quotem's pricing database.
// POST body: { work, intent?, detail? }    OR    { items: [{ work, intent, detail }] } for batch
router.post('/pricer', express.json({ limit: '128kb' }), async (req, res) => {
    if (Array.isArray(req.body?.items)) {
        try {
            const results = await priceItems(req.body.items);
            return res.json({ results, count: results.length });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    const work = req.body?.work;
    if (!work) {
        return res.status(400).json({ error: 'Body must include work string OR items array' });
    }
    try {
        const result = await priceItem(work, req.body.intent || 'replace', req.body.detail || '');
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET variant for quick browser test
router.get('/pricer', async (req, res) => {
    const work = req.query.work;
    if (!work) {
        return res.status(400).json({
            error: 'Missing ?work=... query param',
            example: '/api/q-lab/pricer?work=Build+timber+planter+from+sleepers&intent=replace&detail=3m+x+1.2m',
        });
    }
    try {
        const result = await priceItem(work, req.query.intent || 'replace', req.query.detail || '');
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Graphics — image-to-SVG via StarVector HF Space ──────────────────────
router.get('/graphics', (req, res) => {
    res.sendFile(path.join(__dirname, 'graphics.html'));
});
router.post('/graphics/vectorise', express.json({ limit: '24mb' }), async (req, res) => {
    const imageDataUrl = req.body?.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
        return res.status(400).json({ error: 'Body must include imageDataUrl (data URL)' });
    }
    const result = await vectoriseImage(imageDataUrl);
    if (result.error || !result.svg) {
        return res.status(500).json({ error: result.error || 'No SVG returned', durationMs: result.durationMs });
    }
    res.json({ svg: result.svg, durationMs: result.durationMs });
});

// ── Music — text-to-music via ACE-Step HF Space ──────────────────────────
router.get('/music', (req, res) => {
    res.sendFile(path.join(__dirname, 'music.html'));
});
router.post('/music/generate', express.json({ limit: '64kb' }), async (req, res) => {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Body must include prompt:string' });
    }
    const result = await generateMusic(prompt, {
        lyrics: req.body?.lyrics,
        duration: req.body?.duration,
        seed: req.body?.seed,
    });
    if (result.error || !result.audio) {
        return res.status(500).json({ error: result.error || 'No audio returned', durationMs: result.durationMs });
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.audio.length);
    res.setHeader('X-Generation-Ms', String(result.durationMs));
    return res.end(result.audio);
});

// ── Video — text-to-video via Wan 2.2 HF Space ───────────────────────────
router.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});
router.post('/video/generate', express.json({ limit: '64kb' }), async (req, res) => {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Body must include prompt:string' });
    }
    const result = await generateVideo(prompt, {
        negativePrompt: req.body?.negativePrompt,
        numFrames: req.body?.numFrames,
        fps: req.body?.fps,
        steps: req.body?.steps,
        seed: req.body?.seed,
    });
    if (result.error || !result.video) {
        return res.status(500).json({ error: result.error || 'No video returned', durationMs: result.durationMs });
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.video.length);
    res.setHeader('X-Generation-Ms', String(result.durationMs));
    return res.end(result.video);
});

// ── Email writer — paste email or thread, get clickable response options + reply ──
const emailWriter = require('./plugins/q-email-writer');

router.get('/email-writer', (req, res) => {
    res.sendFile(path.join(__dirname, 'email-writer.html'));
});

router.post('/email-writer/analyse', express.json({ limit: '256kb' }), async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Body must include text:string' });
    }
    try {
        const analysis = await emailWriter.analyseEmail(text);
        res.json({ analysis });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Analyse failed' });
    }
});

router.post('/email-writer/reply', express.json({ limit: '256kb' }), async (req, res) => {
    const { text, options, extraNotes, tone } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Body must include text:string' });
    try {
        const reply = await emailWriter.generateReply(text, options, extraNotes, tone);
        res.json(reply);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Reply failed' });
    }
});

// ── DOC DROP — QR-code document upload ────────────────────────────────
// Shared plugin. Desktop creates a session → QR → phone uploads → desktop polls.
const docDrop = require('./plugins/doc-drop');

// Mobile upload page (public — no auth, token = auth)
router.get('/doc-drop/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'doc-drop-mobile.html'));
});

// Session info by token (public — mobile page calls this on load)
router.get('/api/doc-drop/by-token/:token', (req, res) => {
    const session = docDrop.getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: 'Invalid or expired link' });
    res.json({ session });
});

// Upload by token — base64 JSON body, no multipart dep
router.post('/api/doc-drop/upload/:token', express.json({ limit: '25mb' }), (req, res) => {
    docDrop.handleBase64Upload(req.params.token, req.body || {}, res);
});

// Create a session (authenticated)
router.post('/api/doc-drop/sessions', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const { label, meta } = req.body || {};
    const session = docDrop.createSession(label || 'Upload', req.person.email, { meta: meta || {} });
    res.json({ session });
});

// Poll for uploaded files (authenticated)
router.get('/api/doc-drop/sessions/:id', requirePerson, (req, res) => {
    const session = docDrop.getSession(req.params.id, req.person.email);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
});

// Read a file from a session as base64 (authenticated — for processing)
router.get('/api/doc-drop/sessions/:id/files/:fileId', requirePerson, (req, res) => {
    const file = docDrop.readFileAsBase64(req.params.id, req.params.fileId, req.person.email);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
});

// Delete a session + its files (authenticated)
router.delete('/api/doc-drop/sessions/:id', requirePerson, (req, res) => {
    const result = docDrop.deleteSession(req.params.id, req.person.email);
    res.json(result);
});

// ── FINANCE — personal finance engine ─────────────────────────────────
// All routes require sign-in. Data is scoped to req.person.email — no
// cross-user bleed is possible. Bank statement data is GDPR-sensitive.
const qFinance = require('./plugins/q-finance');

// Extracted text of a thread's PDF/doc, keyed `${threadId}:${filename}`.
// Reading a PDF via Gemini is slow; doing it on EVERY case turn (kickoff +
// every message) made the synchronous thread-chat request run minutes long
// and the browser gave up ("Failed to fetch"). Extract once, reuse. Empty
// result is cached too, so an unreadable file isn't re-read every turn.
const _threadDocCache = new Map();

// RTF is markup, not text. A naive regex strip drowns in font tables and
// megabytes of embedded-object hex (the 2.6M-char "extracted" garbage that
// was being fed to Q every case turn — the real cause of his confabulating).
// This is a proper depth-aware parser: it skips ignorable (\*) destinations
// and binary/table groups entirely (incl. nested), decodes \'hh and \uN,
// honours \bin, turns \par into newlines. Proven on the real council .rtf
// files (2.6M chars of markup -> ~5k chars of the actual letter). If it
// still can't get clean prose it returns '' so Q gets an honest "couldn't
// read it" — he is NEVER handed raw markup again.
const _RTF_SKIP = new Set(['fonttbl','colortbl','stylesheet','info','pict','object','objdata','data','themedata','colorschememapping','latentstyles','datastore','rsidtbl','generator','listtable','listoverridetable','revtbl','xmlnstbl','mmathPr','wgrffmtfilter','filetbl','fldinst','shppict','nonshppict','blipuid','pgptbl','xe','tc','bkmkstart','bkmkend','template','operator','company','hlinkbase','panose','falt','do','shp','sp','sn','sv','svb','header','footer','headerl','headerr','footerl','footerr','headerf','footerf','ftnsep','aftnsep','ftnsepc']);
function rtfToText(rtf) {
    if (!rtf || !/\{\\rtf/i.test(rtf)) return rtf;        // not RTF — leave alone
    const s = String(rtf);
    const n = s.length;
    const stack = [];
    let i = 0, out = '', curSkip = false, ucskip = 1, pendingUc = 0;
    const emit = (ch) => { if (curSkip) return; if (pendingUc > 0) { pendingUc--; return; } out += ch; };
    while (i < n) {
        const c = s[i];
        if (c === '{') { stack.push({ skip: curSkip, ucskip }); i++; continue; }
        if (c === '}') { const st = stack.pop(); if (st) { curSkip = st.skip; ucskip = st.ucskip; } pendingUc = 0; i++; continue; }
        if (c === '\\') {
            const nx = s[i + 1];
            if (nx === "'") { const code = parseInt(s.substr(i + 2, 2), 16); if (!isNaN(code)) emit(code >= 32 || code === 9 || code === 10 || code === 13 ? String.fromCharCode(code) : ''); i += 4; continue; }
            if (nx === '\\' || nx === '{' || nx === '}') { emit(nx); i += 2; continue; }
            if (nx === '*') { curSkip = true; i += 2; continue; }
            if (nx === '\n' || nx === '\r') { emit('\n'); i += 2; continue; }
            if (nx === '~') { emit(' '); i += 2; continue; }
            if (nx === '-' || nx === '_') { i += 2; continue; }
            let j = i + 1, word = '';
            while (j < n && /[a-zA-Z]/.test(s[j])) { word += s[j]; j++; }
            let num = '';
            if (s[j] === '-') { num += '-'; j++; }
            while (j < n && /[0-9]/.test(s[j])) { num += s[j]; j++; }
            if (s[j] === ' ') j++;
            const N = num === '' ? null : parseInt(num, 10);
            if (_RTF_SKIP.has(word)) { curSkip = true; i = j; continue; }
            switch (word) {
                case 'par': case 'line': case 'sect': case 'page': case 'cell': case 'row': emit('\n'); break;
                case 'tab': emit('\t'); break;
                case 'uc': ucskip = (N == null ? 1 : N); break;
                case 'u': if (N != null) { const code = N < 0 ? N + 65536 : N; if (code >= 32) emit(String.fromCharCode(code)); pendingUc = ucskip; } break;
                case 'bin': if (N && N > 0) j += N; break;
                default: break;
            }
            i = j; continue;
        }
        if (c === '\r' || c === '\n') { i++; continue; }
        emit(c); i++;
    }
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    // If it STILL smells of markup or is implausibly huge for a letter, the
    // parse failed — return '' so the honest "couldn't read it" path fires.
    if (out.length > 300000 || /\\rtf|\\fonttbl|\\colortbl|metroBlob|\{\\\*/.test(out)) return '';
    return out;
}

// True if a string is mostly non-printable — i.e. it's binary (a .doc/.docx
// zip, an image) decoded as text. Q must NEVER be handed this; garbage in =
// hallucinations out. Better an honest "couldn't read it" than nonsense.
function looksBinary(s) {
    if (!s) return false;
    const sample = s.slice(0, 4000);
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13) continue;
        if (c < 32 || c === 0xFFFD) bad++;
    }
    return sample.length > 0 && bad / sample.length > 0.15;
}

// GET transactions + graph data
router.get('/api/finance/transactions', requirePerson, (req, res) => {
    res.json(qFinance.getTransactions(req.person.email));
});

router.get('/api/finance/graph', requirePerson, (req, res) => {
    res.json(qFinance.getSpendingGraphData(req.person.email));
});

router.get('/api/finance/subscriptions', requirePerson, (req, res) => {
    res.json(qFinance.detectSubscriptions(req.person.email));
});

// Import statement text (paste or extracted from PDF)
router.post('/api/finance/statement', requirePerson, express.json({ limit: '2mb' }), async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    console.log(`[finance] statement text import — ${req.person.email} — ${text.length} chars`);
    try {
        const result = await qFinance.importStatement(req.person.email, text);
        console.log(`[finance] statement done — added:${result.added} total:${result.total}`);
        res.json(result);
    } catch (e) {
        console.error('[finance] import error', e);
        res.status(500).json({ error: e.message });
    }
});

// Import statement from a file. Whole PDF → Gemini (reads multi-page PDFs
// natively); images → vision. Limit is generous: a scanned multi-month
// statement PDF is large, and this is the user's OWN data behind
// requirePerson. The 413 handler turns "too big" into a clear, honest
// message instead of a mystery failure (CSV export stays the exact path
// for very large statements).
router.post('/api/finance/statement/pdf', requirePerson, express.json({ limit: '50mb' }),
    (err, req, res, next) => {
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ error: 'That PDF is too large to read directly. Export your statement as CSV from your banking app and upload that — it imports exactly and instantly.' });
        }
        if (err) return next(err);
        next();
    },
    async (req, res) => {
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    console.log(`[finance] statement file import — ${req.person.email} — mimeType:${mimeType}`);
    try {
        // Multi-page PDFs take minutes — run in the background so the upload
        // request can't time out and falsely report failure. The page polls
        // /api/finance/statement/job for progress and the result.
        const job = qFinance.startImportJob(req.person.email, imageBase64, mimeType || 'application/pdf');
        res.status(202).json(job);
    } catch (e) {
        console.error('[finance] statement/pdf start error', e);
        res.status(500).json({ error: e.message });
    }
});

// Poll the background import job. Returns { status:'running'|'done'|'error',
// phase, pagesDone, pagesTotal, added, total, hint, error } or {status:'idle'}.
router.get('/api/finance/statement/job', requirePerson, (req, res) => {
    res.json(qFinance.getImportJob(req.person.email) || { status: 'idle' });
});

// Extract data from a bill/letter image (base64)
router.post('/api/finance/document', requirePerson, express.json({ limit: '10mb' }), async (req, res) => {
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    console.log(`[finance] document extract — ${req.person.email} — mimeType:${mimeType}`);
    try {
        const extracted = await qFinance.extractDocument(imageBase64, mimeType || 'image/jpeg');
        console.log(`[finance] document done — type:${extracted.type} urgency:${extracted.urgency}`);
        res.json(extracted);
    } catch (e) {
        console.error('[finance] extract error', e);
        res.status(500).json({ error: e.message });
    }
});

// Update a single transaction (category, bucket, flagged, merchant)
router.patch('/api/finance/transactions/:id', requirePerson, express.json({ limit: '64kb' }), (req, res) => {
    const updated = qFinance.updateTransaction(req.person.email, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Transaction not found' });
    res.json(updated);
});

// Delete all transactions (start fresh)
router.delete('/api/finance/transactions', requirePerson, (req, res) => {
    qFinance.deleteTransactions(req.person.email);
    res.json({ ok: true });
});

// Merchant assignment
router.post('/api/finance/assign', requirePerson, express.json({ limit: '64kb' }), (req, res) => {
    const { merchant, label } = req.body || {};
    if (!merchant) return res.status(400).json({ error: 'merchant required' });
    const result = qFinance.assignMerchant(req.person.email, merchant, label || null);
    res.json(result);
});

router.get('/api/finance/assignments', requirePerson, (req, res) => {
    res.json(qFinance.getAssignments(req.person.email));
});

// Problem queue
router.get('/api/finance/problems', requirePerson, (req, res) => {
    res.json(qFinance.getProblemQueue(req.person.email));
});

router.post('/api/finance/problems', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    const problem = qFinance.addProblem(req.person.email, req.body || {});
    res.json(problem);
});

router.patch('/api/finance/problems/:id', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    const updated = qFinance.updateProblem(req.person.email, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Problem not found' });
    res.json(updated);
});

// Resolved problems — the standard GET filters them out (active queue only),
// but the data persists; this lets the page show them and un-resolve any
// that got hidden by a misclick.
router.get('/api/finance/problems/resolved', requirePerson, (req, res) => {
    res.json(qFinance.getResolvedProblems(req.person.email));
});

router.post('/api/finance/problems/:id/documents', requirePerson, express.json({ limit: '10mb' }), async (req, res) => {
    const { imageBase64, mimeType, filename } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    try {
        const extracted = await qFinance.extractDocument(imageBase64, mimeType || 'image/jpeg');
        const updated = qFinance.addDocumentToProblem(req.person.email, req.params.id, {
            filename:      filename || 'document',
            extracted,
        });
        if (!updated) return res.status(404).json({ error: 'Problem not found' });
        res.json(updated);
    } catch (e) {
        console.error('[finance] doc attach error', e);
        res.status(500).json({ error: e.message });
    }
});

// Q advice (APS mode — full picture review)
router.post('/api/finance/advice', requirePerson, async (req, res) => {
    try {
        const advice = await qFinance.getAdvice(req.person.email);
        res.json({ advice });
    } catch (e) {
        console.error('[finance] advice error', e);
        res.status(500).json({ error: e.message });
    }
});

// ── THREADS — saved situations (folders) ───────────────────────────────
// Every Thread is owned by ONE user (by email). All routes here require
// sign-in via requirePerson and only operate on Threads owned by req.person.
// (qThreads is required at the top of this file so email-send routes can use it)
const { polishUK } = require('./plugins/polish-uk');
// requirePerson already imported at the top of this file from ./auth

// Helper: ownership-checked read. Returns the thread only if the current
// person owns it; otherwise sends 404 (deliberately not 403 — we don't want
// to leak the existence of other users' threads).
function readOwnedThread(req, res) {
    const t = qThreads.readThread(req.params.id, req.person.email);
    if (!t) {
        res.status(404).json({ error: 'Not found' });
        return null;
    }
    return t;
}

router.get('/threads', (req, res) => {
    res.sendFile(path.join(__dirname, 'threads.html'));
});

router.get('/thread/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'thread.html'));
});

router.get('/api/threads', requirePerson, (req, res) => {
    res.json(qThreads.listThreads(req.person.email));
});

router.get('/api/threads/:id', requirePerson, (req, res) => {
    const t = readOwnedThread(req, res);
    if (t) res.json(t);
});

router.post('/api/threads', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    const { title, summary, content } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
        const thread = qThreads.createThread({ title, summary, content, ownerEmail: req.person.email });
        res.json(thread);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/threads/:id/emails', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.addEmail(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

router.delete('/api/threads/:id/emails/:emailId', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeEmail(req.params.id, req.params.emailId, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

router.patch('/api/threads/:id', requirePerson, express.json({ limit: '32kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.updateThread(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

router.delete('/api/threads/:id', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const ok = qThreads.deleteThread(req.params.id, req.person.email);
    res.json({ ok });
});

// Clear just the Q chat history on a thread — keeps emails, files, notes intact.
router.delete('/api/threads/:id/chat', requirePerson, (req, res) => {
    const t = readOwnedThread(req, res);
    if (!t) return;
    t.chatHistory = [];
    qThreads.writeThread(t);
    res.json({ ok: true });
});

// One-time legacy claim — Sarah's existing Threads were created without
// owner-scoping and got locked to '__legacy__' on next read. This endpoint
// claims every '__legacy__' Thread for the calling user. Run once.
router.post('/api/threads/claim-legacy', requirePerson, (req, res) => {
    // Admin-only — only Sarah can sweep legacy unowned Threads. (In practice the
    // boot migration already empties the legacy dir into Sarah, so this returns
    // { claimed: 0 } for everyone; the guard stops any future legacy data being
    // grabbed by a non-admin account.)
    if (!isAdmin(req.person)) return res.status(403).json({ error: 'Forbidden' });
    const result = qThreads.claimLegacyThreads(req.person.email);
    res.json(result);
});

// Extract email fields from a file (PDF, RTF, EML) — used by the add-email form
// to auto-fill From/To/Subject/Date/body without the user typing them manually.
router.post('/api/threads/:id/extract-email', requirePerson, express.json({ limit: '50mb' }), async (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const { filename = '', mimeType = '', base64 } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 required' });

    let text = '';
    try {
        const buf = Buffer.from(base64, 'base64');
        const isPdf = /pdf/i.test(mimeType) || /\.pdf$/i.test(filename);
        const isRtf = /\.rtf$/i.test(filename) || /rtf/i.test(mimeType);
        if (isPdf) {
            const ex = await qFinance.extractDocument(base64, 'application/pdf');
            text = (ex && (ex.full_text || ex.raw)) || '';
        } else if (isRtf) {
            text = rtfToText(buf.toString('utf8'));
        } else {
            text = buf.toString('utf8');
        }
    } catch (e) {
        return res.status(500).json({ error: 'Could not extract text: ' + e.message });
    }

    // Parse email-style headers from extracted text.
    const get = (name) => {
        const m = text.match(new RegExp(name + '[:\\s]+([^\\n\\r]+)', 'i'));
        return m ? m[1].replace(/\r/g, '').trim() : '';
    };
    const from    = get('from');
    const to      = get('to');
    const subject = get('subject');
    const date    = get('date');
    // Body = everything after the last recognisable header, or the full text if no headers found.
    const lastHeaderRe = /(?:^|\n)(?:from|to|subject|date|cc|bcc|message-id)[^\n]*\n/gi;
    let lastIdx = 0;
    let m;
    while ((m = lastHeaderRe.exec(text)) !== null) lastIdx = m.index + m[0].length;
    const body = lastIdx > 0 ? text.slice(lastIdx).trim() : text.trim();

    res.json({ from, to, subject, date, body, direction: 'in' });
});

// File attachments — base64 in JSON body for simplicity (no multipart parser dep).
// Detects email-format uploads (.eml or text with From:/To:/Subject: headers) and
// routes them to addEmail so they land on the Correspondence timeline instead of
// the Files section.
router.post('/api/threads/:id/files', requirePerson, express.json({ limit: '50mb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const { filename = '', mimeType = '', base64 } = req.body || {};

    const looksLikeEmailFile = /\.(eml|msg)$/i.test(filename)
        || mimeType.includes('rfc822')
        || mimeType.includes('message/');

    const isTextFile = mimeType.startsWith('text/')
        || /\.(txt|text|md)$/i.test(filename)
        || mimeType === '';

    if ((looksLikeEmailFile || isTextFile) && base64) {
        try {
            const text = Buffer.from(base64, 'base64').toString('utf-8');
            const parsed = qThreads.parseEmailContent(text);
            if (parsed) {
                const updated = qThreads.addEmail(req.params.id, {
                    type: 'in',  // default to received; user can flip on the card later
                    from: parsed.from,
                    to: parsed.to,
                    date: parsed.date,
                    subject: parsed.subject,
                    body: parsed.body,
                }, req.person.email);
                if (updated) return res.json({ ...updated, savedAs: 'email' });
            }
        } catch (e) {
            // Fall through to file save
            console.warn('[threads] email parse failed for ' + filename + ': ' + e.message);
        }
    }

    const updated = qThreads.addFile(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(400).json({ error: 'Could not save file (thread not found or filename/base64 missing)' });
    res.json({ ...updated, savedAs: 'file' });
});

// Notes — paste / type anything onto a case: phone-call notes, a thought,
// scrappy lines, a quote. Lands on the case timeline beside emails and
// files and Q reads it as part of the case material on the next turn.
router.post('/api/threads/:id/notes', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content required' });
    const kind = (typeof req.body?.kind === 'string' && req.body.kind.trim())
        ? req.body.kind.trim().slice(0, 24)
        : 'note';
    const updated = qThreads.addNote(req.params.id, { content, kind }, req.person.email);
    if (!updated) return res.status(400).json({ error: 'Could not save note (thread not found)' });
    res.json(updated);
});

// Contacts on a case — the people involved (council officer, landlord, the
// other side's rep). The thread side panel shows these with a "Call now" QR
// (tel:) and an email shortcut so the user can act straight from the case.
router.get('/api/threads/:id/contacts', requirePerson, (req, res) => {
    const t = readOwnedThread(req, res);
    if (t) res.json(Array.isArray(t.contacts) ? t.contacts : []);
});

router.post('/api/threads/:id/contacts', requirePerson, express.json({ limit: '32kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.addContact(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(400).json({ error: 'A contact needs at least a name, phone or email' });
    res.json(updated);
});

router.patch('/api/threads/:id/contacts/:contactId', requirePerson, express.json({ limit: '32kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.updateContact(req.params.id, req.params.contactId, req.body || {}, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Contact not found' });
    res.json(updated);
});

router.delete('/api/threads/:id/contacts/:contactId', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeContact(req.params.id, req.params.contactId, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Thread not found' });
    res.json(updated);
});

// Key details / reference numbers on a case — glanceable label:value facts
// (PCN ref, account no, claim ref) the user quotes on a call. Distinct from
// the prose Case Notes section.
router.post('/api/threads/:id/refs', requirePerson, express.json({ limit: '8kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.addRef(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(400).json({ error: 'A key detail needs a label or value' });
    res.json(updated);
});

router.delete('/api/threads/:id/refs/:refId', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeRef(req.params.id, req.params.refId, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Thread not found' });
    res.json(updated);
});

router.get('/api/threads/:id/files/:filename', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const file = qThreads.readFile(req.params.id, req.params.filename, req.person.email);
    if (!file) return res.status(404).json({ error: 'File not found' });
    let ct = file.mimeType || '';
    const ext = String(file.filename || '').split('.').pop().toLowerCase();
    // RTF files are often stored with application/msword — always remap so browsers handle them consistently.
    if (ext === 'rtf') ct = 'text/rtf';
    else if (!ct || ct === 'application/octet-stream') {
        ct = ({ pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
                 gif:'image/gif', webp:'image/webp', txt:'text/plain',
                 mp4:'video/mp4', mp3:'audio/mpeg', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })[ext] || 'application/octet-stream';
    }
    res.setHeader('Content-Type', ct);
    const safeName = String(file.filename).replace(/"/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.end(file.buffer);
});

// Returns extracted plain text for any document file (RTF, Word, text).
// Used by the client's inline text viewer so non-viewable files can be read in-page.
router.get('/api/threads/:id/files/:filename/text', requirePerson, async (req, res) => {
    const t = readOwnedThread(req, res);
    if (!t) return;
    const filename = req.params.filename;
    const cacheKey = `${t.id}:${filename}`;
    if (_threadDocCache.has(cacheKey)) {
        return res.json({ text: _threadDocCache.get(cacheKey), filename });
    }
    const file = qThreads.readFile(t.id, filename, req.person.email);
    if (!file || !file.buffer) return res.status(404).json({ error: 'File not found' });
    const isRtf = /\.rtf$/i.test(filename) || /rtf/i.test(file.mimeType || '');
    let text;
    if (isRtf) {
        text = rtfToText(file.buffer.toString('utf8'));
    } else {
        text = file.buffer.toString('utf8');
    }
    text = String(text || '').trim();
    if (text && !looksBinary(text)) _threadDocCache.set(cacheKey, text);
    res.json({ text: looksBinary(text || '') ? '' : text, filename });
});

router.delete('/api/threads/:id/files/:filename', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeFile(req.params.id, req.params.filename, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Thread not found' });
    res.json(updated);
});

router.patch('/api/threads/:id/files/:filename/rename', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const { newName } = req.body || {};
    if (!newName || typeof newName !== 'string' || !newName.trim()) {
        return res.status(400).json({ error: 'newName required' });
    }
    const updated = qThreads.renameFile(req.params.id, req.params.filename, newName.trim(), req.person.email);
    if (!updated) return res.status(404).json({ error: 'File not found or name already taken' });
    res.json(updated);
});

// Fetch a remote file (PDF or doc from GOV.UK etc.) into the thread's files.
// Body: { url, filename? }
router.post('/api/threads/:id/fetch-file', requirePerson, express.json({ limit: '16kb' }), async (req, res) => {
    const { url, filename } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url required' });
    const t = qThreads.readThread(req.params.id, req.person.email);
    if (!t) return res.status(404).json({ error: 'Thread not found' });
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timeout);
        if (!resp.ok) return res.status(502).json({ error: `Remote returned ${resp.status}` });
        const ct = resp.headers.get('content-type') || 'application/octet-stream';
        const buf = Buffer.from(await resp.arrayBuffer());
        // Derive filename from URL or header if not provided
        let name = filename || '';
        if (!name) {
            const cd = resp.headers.get('content-disposition') || '';
            const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
            name = m ? decodeURIComponent(m[1].trim()) : (url.split('?')[0].split('/').filter(Boolean).pop() || 'download');
            if (!name.includes('.')) {
                if (ct.includes('pdf')) name += '.pdf';
                else if (ct.includes('word') || ct.includes('docx')) name += '.docx';
            }
        }
        const base64 = buf.toString('base64');
        const updated = qThreads.addFile(req.params.id, { filename: name, mimeType: ct.split(';')[0].trim(), base64 }, req.person.email);
        if (!updated) return res.status(500).json({ error: 'Could not save file' });
        const saved = updated.files[updated.files.length - 1];
        res.json({ ok: true, filename: saved.filename, mimeType: saved.mimeType, sizeKb: Math.round(buf.length / 1024) });
    } catch (e) {
        res.status(502).json({ error: e.name === 'AbortError' ? 'Timed out fetching the file' : e.message });
    }
});

// Draft action — when Q produces a draft email reply in chat, the UI shows
// three buttons under it: I'll send this / I won't / Save until reminder.
// Body: { action: 'sent'|'discarded'|'save-until', subject, body, remindIn? }
router.post('/api/threads/:id/draft-action', requirePerson, express.json({ limit: '256kb' }), async (req, res) => {
    const { action, subject = '', body = '', remindIn } = req.body || {};
    if (!action || !['sent', 'discarded', 'save-until'].includes(action)) {
        return res.status(400).json({ error: 'action must be sent | discarded | save-until' });
    }
    const t = qThreads.readThread(req.params.id, req.person.email);
    if (!t) return res.status(404).json({ error: 'Thread not found' });

    if (action === 'discarded') {
        return res.json({ ok: true, action });
    }

    // Both 'sent' and 'save-until' add an outgoing email card.
    const status = action === 'sent' ? 'sent' : 'draft';
    const updated = qThreads.addEmail(req.params.id, {
        type: 'out',
        from: '', to: '',
        date: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        subject,
        body: status === 'draft' ? `[DRAFT] ${body}` : body,
    }, req.person.email);

    let reminderInfo = null;
    if (action === 'save-until' && remindIn) {
        // Try to schedule a chase reminder via Q's scheduler tool. Soft-fail if
        // the scheduler isn't reachable — the draft is saved either way.
        try {
            const { executeTool } = require('./plugins/q-tools');
            const result = await executeTool('schedule_reminder', {
                when: remindIn,
                what: `Chase the draft on Thread "${t.title}" — ${subject || '(no subject)'}`,
            });
            reminderInfo = result;
        } catch (e) {
            console.warn('[draft-action] schedule_reminder failed:', e.message);
        }
    }

    res.json({ ok: true, action, thread: updated, reminder: reminderInfo });
});

// Chat with Q scoped to a Thread — full thread context (all emails + history) on every turn.
// Q stays the same person here as on the main chat — Q_PERSONA + memory + facts —
// with the APS overlay added by passing mode:'aps' to qChat.
router.post('/api/threads/:id/chat', requirePerson, express.json({ limit: '256kb' }), async (req, res) => {
    const t = qThreads.readThread(req.params.id, req.person.email);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const { message, silentUser } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

    const messages = [];
    const noteList = Array.isArray(t.notes) ? t.notes.filter(n => n && String(n.content || '').trim()) : [];
    const hasRealData = t.emails.length > 0 || (t.files && t.files.length > 0) || noteList.length > 0;
    if (hasRealData) {
        const parts = [];
        // Notes / saved case summary FIRST — this is the user's own account of the
        // situation (createThread stores the case summary as a note). It was never
        // being injected, so a thread that held only a typed summary looked EMPTY
        // to Q and he confabulated a case from the prompt's examples instead.
        if (noteList.length > 0) {
            parts.push('--- CASE NOTES / SUMMARY (the user\'s own account of this situation) ---\n' +
                noteList.map(n => String(n.content || '').trim()).join('\n\n'));
        }
        if (t.emails.length > 0) {
            parts.push(t.emails.map((e, i) => {
                const dir = e.type === 'in' ? 'RECEIVED' : 'SENT';
                const meta = [e.from && `from: ${e.from}`, e.to && `to: ${e.to}`, e.date && `date: ${e.date}`, e.subject && `subject: ${e.subject}`].filter(Boolean).join(' · ');
                const body = (e.body || '').slice(0, 1500);
                return `--- ${dir} #${i + 1}${meta ? ' (' + meta + ')' : ''} ---\n${body}`;
            }).join('\n\n'));
        }
        if (t.files && t.files.length > 0) {
            parts.push('--- FILES ATTACHED TO THIS THREAD ---\n' +
                t.files.map(f => `• ${f.filename} (${f.mimeType}, ${(f.size / 1024).toFixed(0)} KB) — uploaded ${f.uploadedAt}`).join('\n'));
        }
        messages.push({ role: 'user', content: `This is the saved situation "${t.title}". Here's everything so far:\n\n${parts.join('\n\n')}` });
        messages.push({ role: 'assistant', content: 'Got it — fully up to speed on this case.' });
    } else {
        // EMPTY-THREAD GUARD. With no emails, files or notes, Q has NOTHING real to
        // work from. On high reasoning, when the kickoff demands a diagnosis, he
        // confabulates a whole case out of the PARKING-TICKET EXAMPLES baked into
        // the APS prompt (a fake PCN, a council, bailiffs, TE7/TE9) and presents it
        // as the user's life. This injected turn makes the emptiness explicit and
        // forbids inventing, so he ASKS what the situation is instead.
        messages.push({ role: 'user', content: `IMPORTANT — READ THIS FIRST: the case "${t.title}" is EMPTY. There are no emails, no files and no notes saved to it. You have NO information whatsoever about this situation. Do NOT invent, assume, or guess any details. Do NOT treat ANY example from your instructions (parking tickets, PCNs, councils, bailiffs, court forms, reference numbers, place names) as if it were real or mine — those are illustrations, never facts about me. Your ONLY job on this turn: greet me in one short line and ask me what the situation is that I want help with. Nothing else — no diagnosis, no research, no draft.` });
        messages.push({ role: 'assistant', content: 'Understood — this case is empty, so I will simply ask what it is rather than assume anything.' });
    }
    // Cap history to the last 30 messages — full history bloats V4's context to
    // 80k+ tokens on an active case (emails + docs + history all added up), which
    // causes it to hallucinate tool availability and ignore instructions. 30 msgs
    // is ~3–5 back-and-forth exchanges, enough to keep conversation coherent.
    const fullHistory = (t.chatHistory || []).filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
    const recentHistory = fullHistory.slice(-15);
    for (const h of recentHistory) {
        messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: 'user', content: message });

    // Photos attached to a thread are first-class — no different to a doc or
    // email. When she's just added an image (the silent add-ping fires) or her
    // message refers to one, hand Q the actual pixels so he SEES it, not just
    // the filename line. Reuses the vision path q-chat.js already has
    // (options.images → vision model). Non-image turns stay text+tools so the
    // case-research tooling (web_search, list_threads) keeps working — that's
    // why this is scoped to add-ping / referential turns, not every turn.
    const allFiles  = t.files || [];
    const imageFiles = allFiles.filter(f => (f.mimeType || '').startsWith('image/'));
    const docFiles   = allFiles.filter(f =>
        /pdf|text\/|rfc822|word|officedocument|msword/i.test(f.mimeType || '')
        || /\.(pdf|txt|eml|md|csv|docx?)$/i.test(f.filename || ''));
    const isAddPing = /I've just added .+ to the case/i.test(message);
    // Load content when message references visual/binary content, or on the
    // kickoff turn (Q hasn't spoken yet — this is the first sweep of the case).
    const refersToFile = /\b(image|images|photo|photos|picture|pic|pics|screenshot|scan|scanned|video|videos|footage|recording|clip|watch|frame|frames|pdf|rtf|doc|cctv|file|files|document|documents)\b/i.test(message);
    const isKickoff = !(t.chatHistory || []).some(m => m.role === 'assistant');
    // Test models (e.g. GLM-5) don't reliably call tools, so always inject file
    // content directly — they won't call read_file_content to fetch it themselves.
    const isTestModel = !!(req.body?.testModel);
    // wantExtract: whether to run Gemini extraction on uncached files (costs time/money).
    // wantInject: whether to inject already-cached content — always true so Q never
    // loses context he already has.
    const wantExtract = isAddPing || refersToFile || isKickoff || isTestModel;
    const wantContent = wantExtract; // kept for backward compat with image/video blocks below

    // Photos on a case: read each one to TEXT once (cached), then hand Q that text
    // as context so he reasons over it with the FULL thread history and his tools
    // — exactly like a PDF. Reading the picture fresh on every turn (the old
    // isolated "vision turn") is what made him re-describe the notice and lose the
    // conversation, so he looped. Gemini reads it first (cheap, the model Sarah
    // wants); if Gemini's down (e.g. a retired model) Claude reads it. Cached, so
    // it's read at most once per photo no matter how many times she refers to it.
    if (imageFiles.length) {
        for (const f of imageFiles) {
            try {
                const cacheKey = `${t.id}:${f.filename}`;
                let text;
                if (_threadDocCache.has(cacheKey)) {
                    text = _threadDocCache.get(cacheKey);   // hot path
                } else {
                    // Cold-start: check persistent disk bucket before calling vision model.
                    const persisted = qThreads.getTextCache(t.id, f.filename, req.person.email);
                    if (persisted !== null) {
                        text = persisted;
                        _threadDocCache.set(cacheKey, text);
                        console.log(`[threads] photo "${f.filename}" loaded from disk cache`);
                    } else if (wantContent) {
                        // Vision model call — only on triggered turns (expensive).
                        const file = qThreads.readFile(t.id, f.filename, req.person.email);
                        if (!file || !file.buffer) continue;
                        const b64 = file.buffer.toString('base64');
                        const mime = file.mimeType || 'image/jpeg';
                        let extracted = '';
                        try {
                            const ex = await qFinance.extractDocument(b64, mime);
                            extracted = (ex && (ex.full_text || ex.raw)) || '';
                        } catch (e) {
                            console.warn('[threads] Gemini photo read failed: ' + f.filename + ' — ' + e.message);
                        }
                        if (!extracted || !extracted.trim()) {
                            extracted = await claudeReadImage(b64, mime);
                        }
                        text = String(extracted || '').trim();
                        _threadDocCache.set(cacheKey, text);
                        qThreads.setTextCache(t.id, f.filename, text, req.person.email);
                        console.log(`[threads] read photo "${f.filename}" (${text.length} chars) — cached to disk`);
                    } else {
                        continue; // not on disk, not triggered — skip
                    }   // end wantContent
                }   // end cold-start outer else
                if (!text) continue;
                const MAXC = 14000;
                const block = `CONTENT OF ATTACHED PHOTO "${f.filename}" (I've read it for you):\n${text.length > MAXC ? text.slice(0, MAXC) + '\n…[truncated]' : text}`;
                messages.splice(messages.length - 1, 0, { role: 'user', content: block });
            } catch (e) {
                console.warn('[threads] photo read failed: ' + f.filename + ' — ' + e.message);
            }
        }
    }

    // Video files (CCTV, dashcam, enforcement footage) — Gemini watches and
    // describes every detail (timestamps, plates, signs, actions) as plain
    // text so Q can reason over it with the full thread context.
    const videoFiles = allFiles.filter(f => (f.mimeType || '').startsWith('video/'));
    if (videoFiles.length && wantContent) {
        for (const f of videoFiles) {
            try {
                const cacheKey = `${t.id}:${f.filename}:video`;
                let text;
                if (_threadDocCache.has(cacheKey)) {
                    text = _threadDocCache.get(cacheKey);
                } else {
                    const file = qThreads.readFile(t.id, f.filename, req.person.email);
                    if (!file || !file.buffer) continue;
                    const b64 = file.buffer.toString('base64');
                    const mime = file.mimeType || 'video/mp4';
                    text = await qFinance.extractVideo(b64, mime);
                    _threadDocCache.set(cacheKey, text);
                    console.log(`[threads] read video "${f.filename}" (${text.length} chars)`);
                }
                const block = text
                    ? `CONTENT OF ATTACHED VIDEO "${f.filename}" (I've watched it for you):\n${text}`
                    : `(The attached video "${f.filename}" could not be processed automatically.)`;
                messages.splice(messages.length - 1, 0, { role: 'user', content: block });
            } catch (e) {
                console.warn('[threads] video read failed: ' + f.filename + ' — ' + e.message);
            }
        }
    }

    // Q is a text model — a PDF/doc attached to the case is invisible to him
    // unless its content is extracted and handed over. Without this he
    // correctly but uselessly says "I can't read PDFs". Reuses the proven
    // finance Gemini document reader (reads PDFs natively).
    // PDFs are handed to Claude NATIVELY on triggered turns (expensive — adds
    // base64 bytes on every turn). Text extraction is always attempted so that
    // after a Railway restart (which wipes _threadDocCache) Q immediately
    // regains file context on the next turn without needing an explicit
    // "file"/"document" trigger word.
    const pdfDocuments = [];
    if (docFiles.length) {
        for (const f of docFiles) {
            const isPdf = /pdf/i.test(f.mimeType || '') || /\.pdf$/i.test(f.filename || '');
            const isRtf = /\.rtf$/i.test(f.filename || '') || /rtf/i.test(f.mimeType || '');
            try {
                if (isPdf && wantExtract) {
                    // Hand raw PDF to Claude when triggered (8MB cap).
                    try {
                        const pf = qThreads.readFile(t.id, f.filename, req.person.email);
                        if (pf && pf.buffer && pf.buffer.length < 8 * 1024 * 1024) {
                            pdfDocuments.push({ filename: f.filename, base64: pf.buffer.toString('base64'), mediaType: 'application/pdf' });
                        } else if (pf && pf.buffer) {
                            console.warn(`[threads] PDF "${f.filename}" is ${(pf.buffer.length/1024/1024).toFixed(1)}MB — too big for Claude directly`);
                        }
                    } catch (e) {
                        console.warn('[threads] PDF read for Claude failed: ' + f.filename + ' — ' + e.message);
                    }
                }
                const cacheKey = `${t.id}:${f.filename}`;
                let text;
                if (_threadDocCache.has(cacheKey)) {
                    text = _threadDocCache.get(cacheKey);   // hot path — in-memory
                } else {
                    // Cold-start: check the persistent per-thread bucket on disk first.
                    // This survives Railway restarts so Gemini is never called twice for
                    // the same file. Falls through to extraction only on the first-ever read.
                    const persisted = qThreads.getTextCache(t.id, f.filename, req.person.email);
                    if (persisted !== null) {
                        text = persisted;
                        _threadDocCache.set(cacheKey, text);   // warm the in-memory cache
                        console.log(`[threads] "${f.filename}" loaded from disk cache (${text.length} chars)`);
                    } else {
                        const file = qThreads.readFile(t.id, f.filename, req.person.email);
                        if (!file || !file.buffer) continue;
                        if (isPdf) {
                            const ex = await qFinance.extractDocument(file.buffer.toString('base64'), 'application/pdf');
                            text = (ex && (ex.full_text || ex.raw)) || '';
                        } else if (isRtf) {
                            text = rtfToText(file.buffer.toString('utf8'));
                        } else {
                            text = file.buffer.toString('utf8');
                        }
                        text = String(text || '').trim();
                        if (looksBinary(text)) {
                            console.warn(`[threads] "${f.filename}" decoded as binary — skipping`);
                            text = '';
                        }
                        _threadDocCache.set(cacheKey, text);
                        qThreads.setTextCache(t.id, f.filename, text, req.person.email);
                        console.log(`[threads] extracted "${f.filename}" (${text.length} chars)${isPdf ? ' + handed PDF to Claude' : ''} — cached to disk`);
                    }   // end inner else (extract)
                }   // end outer else (cold-start)
                // Inject the text into the conversation context.
                const MAXC = 14000;
                let block = null;
                if (text) {
                    block = `CONTENT OF ATTACHED FILE "${f.filename}":\n${text.length > MAXC ? text.slice(0, MAXC) + '\n…[truncated]' : text}`;
                } else if (!isPdf) {
                    block = `(The attached file "${f.filename}" could not be read automatically.)`;
                }
                if (block) messages.splice(messages.length - 1, 0, { role: 'user', content: block });
            } catch (e) {
                console.warn('[threads] doc extract failed: ' + f.filename + ' — ' + e.message);
            }
        }
    }

    try {
        // Reasoning: 'high' by default — the same the main chat runs on (Q
        // on no-think is too shallow, and a case is the LAST place he should
        // think less). The page can request 'max' for a big case (the Deep
        // toggle) — deepest reasoning when it's worth the extra time.
        // Context now trimmed (15 msgs, 1500c emails, narrow file triggers) so
        // 'high' reasoning is safe again. 'low' was causing flat/passive replies.
        // Deep toggle sends 'max' from client — keeps the extra depth + 8k tokens.
        const tEffort = (req.body?.reasoningEffort === 'max') ? 'max' : 'high';
        const tTestModel = req.body?.testModel || undefined;
        const qOpts = { useTools: true, mode: 'aps', surface: 'thread', advocate: true, person: req.person, reasoningEffort: tEffort, threadId: req.params.id, firstTurn: isKickoff, ...(tTestModel && { model: tTestModel }) };
        // Photos are now read to text above and spliced into `messages`, so the
        // turn stays a normal history-aware Claude turn (no isolated vision call,
        // no looping). PDFs are still handed to Claude natively to read directly.
        if (pdfDocuments.length) qOpts.documents = pdfDocuments;
        const result = await qChat(messages, qOpts);
        if (result.error || !result.reply) {
            return res.status(500).json({ error: result.error || 'No reply from Q' });
        }
        const polished = polishUK(result.reply);
        if (!silentUser) {
            qThreads.appendChat(t.id, 'user', message, req.person.email);
        }
        qThreads.appendChat(t.id, 'assistant', polished, req.person.email);

        // Auto-file any document Q generated this turn to the thread's permanent storage.
        // Also write to q-docs/ (no TTL, on volume) so /download/:token links survive deploys.
        const { resolveToken: resolveGeneratedDoc } = require('./plugins/doc-creator');
        const { userDataPath: _udp } = require('./plugins/user-data');
        const _fs = require('fs'), _path = require('path');
        for (const tc of (result.toolCalls || [])) {
            if (tc.name === 'create_document' && tc.result?.ok && tc.result?.token && tc.result?.filename) {
                try {
                    const resolved = resolveGeneratedDoc(tc.result.token, req.person.email);
                    if (resolved) {
                        const buf = _fs.readFileSync(resolved.fullPath);
                        qThreads.addFile(t.id, {
                            filename: tc.result.filename,
                            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                            base64: buf.toString('base64'),
                        }, req.person.email);
                        // Permanent copy keyed by token — survives Railway redeploys
                        const docsDir = _udp(req.person.email, 'q-docs');
                        _fs.mkdirSync(docsDir, { recursive: true });
                        _fs.writeFileSync(_path.join(docsDir, tc.result.token + '__' + tc.result.filename), buf);
                        console.log(`[threads] auto-filed + persisted doc "${tc.result.filename}" to thread ${t.id}`);
                    }
                } catch (e) {
                    console.warn('[threads] auto-file doc failed:', e.message);
                }
            }
        }

        // Gemini cite-check retired for threads: case replies now run on real
        // Claude Sonnet 4.6, so the independent second-opinion pass is no longer
        // needed — and it was an extra Gemini call + latency on every reply.
        const checks = [];

        res.json({ reply: polished, checks });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Chat failed' });
    }
});

// "Check this" — single focused Claude Sonnet review of a draft document.
// No tool loop, no credit burn. Body: { document: '...text...' }
// Claude reads the full case context + the document and gives a legal/quality check.
router.post('/api/threads/:id/check', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    const t = readOwnedThread(req, res);
    if (!t) return;

    // Supports two modes:
    // 1. Single-shot: { document: string } — check a specific document
    // 2. Conversational: { question: string, history: [{role,content}] } — follow-up in the verify popup
    const doc      = (req.body?.document || '').trim();
    const question = (req.body?.question  || '').trim();
    const history  = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
    if (!doc && !question) return res.status(400).json({ error: 'document or question required' });

    // Pull outbox drafts for this thread (emails Q has drafted but not yet sent)
    const qEmailAccounts = require('./plugins/q-email-accounts');
    const outboxDrafts = qEmailAccounts.getOutbox(req.person.email)
        .filter(item => item.threadId === t.id)
        .map(item => `[OUTBOX DRAFT — To: ${item.to || '(no recipient)'} — Subject: ${item.subject || ''}]\n${item.body || ''}`)
        .join('\n\n');

    const caseContext = [
        t.title ? `Case: ${t.title}` : '',
        (t.emails || []).map(e => `[${e.type === 'in' ? 'Received' : e.type === 'draft' ? 'Draft' : 'Sent'} — ${e.subject || ''}]\n${e.body || ''}`).join('\n\n'),
        outboxDrafts,
        (t.notes || []).map(n => n.text || '').join('\n'),
        (t.chatHistory || []).slice(-10).filter(m => m.role === 'assistant').map(m => `[Q said]\n${(m.content || '').slice(0, 600)}`).join('\n\n'),
    ].filter(Boolean).join('\n\n');

    const system = `You are a hard-nosed legal and correspondence reviewer. You have the full case context. Your job is to tell the user what is legally solid and what is not — no softening, no hedging.

Rules:
- If a claim is backed by law, say so and name the law or regulation.
- If a claim is NOT backed by law, say "WRONG — remove this" and say exactly why it doesn't hold.
- Do not say "may be", "could be", "slightly", "perhaps", "might come across as". Either it's legally defensible or it isn't.
- Do not worry about tone or politeness in the correspondence — that is not your job. Your job is legal accuracy only.
- Check the recipient: if the To field is blank or missing, flag it — "NO RECIPIENT — fill in the email address before sending." If it looks wrong for the case (e.g. sending a council complaint to a private address), flag it.
- If a draft or message is clean, say "Looks good — send it." No padding.
- Short, direct, specific. One line per issue. No waffle.`;

    const messages = [
        ...(caseContext ? [{ role: 'user', content: `CASE CONTEXT:\n${caseContext}` }, { role: 'assistant', content: 'Understood — I have the full case context.' }] : []),
        ...history,
        { role: 'user', content: doc ? `Please check this before I send it:\n\n${doc}` : question },
    ];

    try {
        const result = await claudeThreadChat({ system, messages, tools: [], person: req.person, maxTokens: 2048, startTime: Date.now(), documents: [] });
        if (!result || !result.reply) return res.status(500).json({ error: 'Claude did not respond' });
        res.json({ review: result.reply });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Check failed' });
    }
});

// Thread forms panel — step 1: Gemini reads the PDF and returns the field list.
// Body: { pdfBase64: string }
router.post('/api/threads/:id/form-scan', requirePerson, express.json({ limit: '20mb' }), async (req, res) => {
    const t = readOwnedThread(req, res);
    if (!t) return;
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' });
    try {
        const result = await qFinance.scanFormFields(pdfBase64);
        if (result.error === 'vision_unavailable') return res.status(503).json({ error: 'Form reading is temporarily unavailable — GEMINI_API_KEY not set.' });
        if (!result.fields.length) return res.status(422).json({ error: 'No fillable fields found — try a government or insurance form with blank spaces.' });
        res.json({ fields: result.fields });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Scan failed' });
    }
});

// Build the case context (applicant identity + emails/notes/files/chat) that
// the form tools use to fill or draft answers. One source of truth for both
// /form-fill and /form-draft. MUST be called inside try/catch — listFacts and
// the thread arrays can throw, and an uncaught throw here crashes the process.
async function threadFormInfoText(t, person) {
    const fileParts = [];
    for (const f of (t.files || [])) {
        const cacheKey = `${t.id}:${f.filename}`;
        let text = _threadDocCache.get(cacheKey);
        if (!text) {
            // Not yet cached — read it now so form-fill sees the actual document
            // content (e.g. the PCN PDF). Mirror the chat path; 8s cap per file
            // so a slow Gemini call doesn't stall the whole form-fill.
            try {
                const file = qThreads.readFile(t.id, f.filename, person.email);
                if (file && file.buffer) {
                    const isPdf = /pdf/i.test(f.mimeType || '') || /\.pdf$/i.test(f.filename || '');
                    const isRtf = /\.rtf$/i.test(f.filename || '') || /rtf/i.test(f.mimeType || '');
                    if (isPdf) {
                        const ex = await Promise.race([
                            qFinance.extractDocument(file.buffer.toString('base64'), 'application/pdf'),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
                        ]);
                        text = (ex && (ex.full_text || ex.raw)) || '';
                    } else if (isRtf) {
                        text = rtfToText(file.buffer.toString('utf8'));
                    } else {
                        text = file.buffer.toString('utf8');
                    }
                    text = String(text || '').trim();
                    if (text && !looksBinary(text)) _threadDocCache.set(cacheKey, text);
                }
            } catch (e) {
                console.warn('[threadFormInfoText] read failed:', f.filename, e.message);
            }
        }
        if (text) fileParts.push(`[File: ${f.filename}]\n${text.slice(0, 2000)}`);
    }
    const chatParts = (t.chatHistory || [])
        .filter(m => m.role === 'assistant' || m.role === 'user')
        .slice(-20)
        .map(m => `[${m.role === 'user' ? 'User' : 'Q'}]: ${String(m.content || '').slice(0, 600)}`)
        .join('\n');
    const factLines = (listFacts({ limit: 50 }, person.id) || [])
        .map(f => `- ${f.content}`)
        .join('\n');
    // Pull VRM from the case title so Q can fill vehicle reg fields without asking.
    const vrmMatch = (t.title || '').match(/\b([A-Z]{2}\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\b/i);
    const vrmNote = vrmMatch ? `Vehicle registration: ${vrmMatch[0].replace(/\s/g, '').toUpperCase()}` : '';
    const applicant = [
        'THE PERSON FILLING IN THIS FORM (the applicant). Any field asking for the',
        "applicant's / claimant's / your name, title, signature, email, address or",
        'contact details is about THIS person — fill it from here, do not ask:',
        person.name ? `Name: ${person.name}` : '',
        person.email ? `Email: ${person.email}` : '',
        factLines ? `Known about this person:\n${factLines}` : '',
    ].filter(Boolean).join('\n');
    return [
        applicant,
        t.title ? `Case: ${t.title}` : '',
        vrmNote,
        (t.emails || []).map(e => {
            const dir = e.type === 'in' ? 'Received' : e.type === 'draft' ? 'Draft' : 'Sent';
            return `[${dir} — ${e.subject || ''}]\n${(e.body || '').slice(0, 1200)}`;
        }).join('\n\n'),
        (t.notes || []).map(n => n.text || '').join('\n'),
        ...fileParts,
        chatParts ? `[Chat history]\n${chatParts}` : '',
    ].filter(Boolean).join('\n\n');
}

// Thread forms panel — step 2: Q fills the fields from thread context.
// Body: { fields: [{name, label, context, type}] }
router.post('/api/threads/:id/form-fill', requirePerson, express.json({ limit: '128kb' }), async (req, res) => {
    const t = readOwnedThread(req, res);
    if (!t) return;
    const fields = req.body?.fields;
    if (!Array.isArray(fields) || !fields.length) return res.status(400).json({ error: 'fields array required' });

    // Everything below MUST stay inside try/catch. Building infoText touches
    // listFacts + several thread arrays; a throw out here would reject the async
    // handler, which Express 4 does NOT catch → unhandledRejection → the process
    // crashes and Railway returns 502 (the symptom Sarah hit). Keep it contained.
    try {
        const infoText = await threadFormInfoText(t, req.person);
        const { values, ask } = await qFormFiller.extractFieldValues(fields, infoText, null);
        // Auto-fill signature fields Q left blank — browser PDF viewers can't
        // edit signature field types, so they must be pre-filled server-side.
        const filled = values || {};
        if (req.person.name) {
            for (const f of fields) {
                const isSignature = f.type === 'signature' ||
                    /sign/i.test(f.name || '') ||
                    /sign/i.test(f.label || '');
                if (isSignature && !filled[f.name]) filled[f.name] = req.person.name;
            }
        }
        res.json({ values: filled, ask: ask || [] });
    } catch (e) {
        console.error('[form-fill]', e && e.message, e && e.stack);
        res.status(500).json({ error: (e && e.message) || 'Fill failed' });
    }
});

// Chat with Q about a pasted email — Q's persona + memory + APS overlay (mode:'aps').
// Body: { emailText, history: [{role, content}], message }
router.post('/email-writer/chat', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    const { emailText, history, message } = req.body || {};
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message required' });
    }
    const messages = [];
    if (emailText && typeof emailText === 'string') {
        messages.push({
            role: 'user',
            content: `--- THE SITUATION (pasted email or thread) ---\n${emailText.trim()}\n--- END ---`,
        });
        messages.push({
            role: 'assistant',
            content: 'Got it — fully read.',
        });
    }
    if (Array.isArray(history)) {
        for (const m of history) {
            if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
                messages.push({ role: m.role, content: m.content });
            }
        }
    }
    messages.push({ role: 'user', content: message });

    try {
        const result = await qChat(messages, { useTools: true, mode: 'aps', surface: 'email-writer', person: req.person });
        if (result.error || !result.reply) {
            return res.status(500).json({ error: result.error || 'No reply from Q' });
        }
        res.json({ reply: polishUK(result.reply), toolCalls: result.toolCalls || [] });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Chat failed' });
    }
});

router.post('/email-writer/adjust-tone', express.json({ limit: '64kb' }), async (req, res) => {
    const { body, tone } = req.body || {};
    if (!body) return res.status(400).json({ error: 'Body must include body:string' });
    if (!tone) return res.status(400).json({ error: 'Body must include tone:string' });
    try {
        const rewritten = await emailWriter.adjustTone(body, tone);
        res.json({ body: rewritten });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Tone adjust failed' });
    }
});

// "I don't know what to do" — runs Q in APS mode (A Problem Shared) on the
// pasted email. Q reads it as a friend who's good with the small print,
// finds the angle the user missed, gives the plan + odds.
const { chat: qChat } = require('./plugins/q-chat');
router.post('/email-writer/advice', express.json({ limit: '256kb' }), async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Body must include text:string' });
    }
    const userMsg = `I've been sent this email and I don't know how to deal with it. Can you read it, work out what's actually going on, and tell me what to do? Find the angle if there is one — what they're not telling me, what I might have missed, deadlines I should know about, anything in their small print that helps me. Then give me a step-by-step plan.\n\n--- THE EMAIL ---\n${text.trim()}\n--- END ---`;
    try {
        const result = await qChat([{ role: 'user', content: userMsg }], { mode: 'aps', useTools: false });
        if (result.error || !result.reply) {
            return res.status(500).json({ error: result.error || 'No reply from Q' });
        }
        res.json({ advice: result.reply });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Advice failed' });
    }
});

// ── LIFE — personal calendar + tasks (school dates, appointments, errands) ──
const qLife = require('./plugins/q-life');
const { extractLifeAdmin, extractFromImage: extractLifeFromImage } = require('./plugins/q-event-extractor');

router.get('/life', (req, res) => {
    res.sendFile(path.join(__dirname, 'life.html'));
});
router.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'about.html'));
});

router.get('/life/events', requirePerson, (req, res) => {
    const { from, to } = req.query;
    res.json(qLife.listEvents(req.person.email, { from, to }));
});
router.post('/life/events', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    try { res.json(qLife.addEvent(req.body || {}, req.person.email)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/life/events/:id', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    const updated = qLife.updateEvent(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});
router.delete('/life/events/:id', requirePerson, (req, res) => {
    const ok = qLife.deleteEvent(req.params.id, req.person.email);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

router.get('/life/context', requirePerson, (req, res) => {
    res.json({ context: qLife.getContext(req.person.email) });
});
router.put('/life/context', requirePerson, express.json({ limit: '8kb' }), (req, res) => {
    const saved = qLife.setContext(req.body?.context || '', req.person.email);
    res.json({ context: saved });
});

router.get('/life/tasks', requirePerson, (req, res) => {
    res.json(qLife.listTasks(req.person.email, { status: req.query.status }));
});
router.post('/life/tasks', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    try { res.json(qLife.addTask(req.body || {}, req.person.email)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/life/tasks/:id', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    const updated = qLife.updateTask(req.params.id, req.body || {}, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});
router.delete('/life/tasks/:id', requirePerson, (req, res) => {
    const ok = qLife.deleteTask(req.params.id, req.person.email);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// Search the web for a contact's phone + email by name. Used by the
// "Schedule Call" form on the chat tasks drawer — Sarah types "B&Q" and the
// bar tries to fill phone/email for her. Best-effort: a regex sweep over the
// Brave snippet text; the user can still type or paste manually.
router.post('/life/contact-search', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.length > 100) return res.status(400).json({ error: 'name too long' });
    try {
        const search = await webSearch({ query: `${name} contact phone number UK`, count: 5 });
        if (search.error) return res.json({ phone: null, email: null, results: [], error: search.error });
        const text = (search.results || []).map(r => `${r.title || ''} ${r.snippet || ''}`).join(' ');
        // UK phone regex: optional +44 or 0, then 9-10 digits with optional spaces/dashes.
        // Match common formats: 0800 123 4567, 020 1234 5678, +44 20 1234 5678, 0345-1234567.
        const phoneRe = /(\+44\s?\d(?:[\s-]?\d){9}|0\d(?:[\s-]?\d){9,10})/g;
        const phoneMatches = text.match(phoneRe) || [];
        const phone = phoneMatches.length ? phoneMatches[0].replace(/\s+/g, ' ').trim() : null;
        // Email regex — strip obvious junk like example@example.com / noreply@.
        const emailRe = /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
        const emailMatches = (text.match(emailRe) || []).filter(e =>
            !/^(noreply|no-reply|donotreply|example|test|admin)@/i.test(e) &&
            !/example\.(com|org|co\.uk)$/i.test(e)
        );
        const email = emailMatches.length ? emailMatches[0] : null;
        res.json({ phone, email, results: (search.results || []).slice(0, 3) });
    } catch (err) {
        res.json({ phone: null, email: null, results: [], error: err.message });
    }
});

router.get('/life/categories', requirePerson, (req, res) => {
    res.json(qLife.listCategories(req.person.email));
});
router.post('/life/categories', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    try { res.json(qLife.addCategory(req.body || {}, req.person.email)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/life/categories/:slug', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const cat = qLife.updateCategory(req.params.slug, req.body || {}, req.person.email);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    res.json(cat);
});
router.delete('/life/categories/:slug', requirePerson, (req, res) => {
    const ok = qLife.deleteCategory(req.params.slug, req.person.email);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// Extract events + tasks from a paste of text. Returns preview shape — nothing
// is saved until POST /life/batch confirms it. Pulls the user's saved
// "About me" context so the extractor can filter to what's relevant to them.
router.post('/life/extract', requirePerson, express.json({ limit: '256kb' }), async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text (string) required' });
    }
    let context = qLife.getContext(req.person.email);
    const note = req.body?.note ? String(req.body.note).trim() : '';
    if (note) context = context ? `${context}\n\nINSTRUCTION: ${note}` : `INSTRUCTION: ${note}`;
    // Enrich with everything Q knows — facts Q collected in chat are used here too
    const userFacts = listFacts({ limit: 100 }, req.person.id);
    if (userFacts.length > 0) {
        const factsBlock = userFacts.map(f => f.content).join('\n');
        context = context ? `${context}\n\nQ ALSO KNOWS ABOUT THIS PERSON:\n${factsBlock}` : `Q KNOWS ABOUT THIS PERSON:\n${factsBlock}`;
    }
    // Pass upcoming calendar so the extractor can spot busy days and shift prep tasks
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const upcoming = qLife.listEvents(req.person.email, { from: today, to: in30 });
    if (upcoming.length > 0) {
        const calBlock = upcoming.map(e => `${e.date}: ${e.title}`).join('\n');
        context = context ? `${context}\n\nCALENDAR (next 30 days):\n${calBlock}` : `CALENDAR (next 30 days):\n${calBlock}`;
    }
    const categories = qLife.listCategories(req.person.email);
    const result = await extractLifeAdmin(text, { source: req.body?.source || 'paste', context, categories });
    res.json(result);
});

// Same shape but from a photo (image dataUrl). Vision call.
router.post('/life/extract-photo', requirePerson, express.json({ limit: '32mb' }), async (req, res) => {
    const dataUrl = req.body?.dataUrl;
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return res.status(400).json({ error: 'dataUrl (image) required' });
    }
    let context = qLife.getContext(req.person.email);
    const note = req.body?.note ? String(req.body.note).trim() : '';
    if (note) context = context ? `${context}\n\nINSTRUCTION: ${note}` : `INSTRUCTION: ${note}`;
    // Enrich with everything Q knows — facts Q collected in chat are used here too
    const userFacts = listFacts({ limit: 100 }, req.person.id);
    if (userFacts.length > 0) {
        const factsBlock = userFacts.map(f => f.content).join('\n');
        context = context ? `${context}\n\nQ ALSO KNOWS ABOUT THIS PERSON:\n${factsBlock}` : `Q KNOWS ABOUT THIS PERSON:\n${factsBlock}`;
    }
    // Pass upcoming calendar so the extractor can spot busy days and shift prep tasks
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const upcoming = qLife.listEvents(req.person.email, { from: today, to: in30 });
    if (upcoming.length > 0) {
        const calBlock = upcoming.map(e => `${e.date}: ${e.title}`).join('\n');
        context = context ? `${context}\n\nCALENDAR (next 30 days):\n${calBlock}` : `CALENDAR (next 30 days):\n${calBlock}`;
    }
    const categories = qLife.listCategories(req.person.email);
    const result = await extractLifeFromImage(dataUrl, { source: req.body?.source || 'photo', context, categories });
    res.json(result);
});

// Confirm + save a batch (used after extract preview).
router.post('/life/batch', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    const { events, tasks } = req.body || {};
    res.json(qLife.addBatch({ events, tasks }, req.person.email));
});

// ── Image generation — text prompt → PNG via Z-Image-Turbo HF Space ──────
router.get('/image-gen', (req, res) => {
    res.sendFile(path.join(__dirname, 'image-gen.html'));
});

// Body: { prompt, negativePrompt?, steps?, guidanceScale?, seed?, width?, height? }
// Returns: PNG binary (or JSON error)
router.post('/image-gen/generate', express.json({ limit: '64kb' }), async (req, res) => {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Body must include prompt:string' });
    }
    const result = await generateImage(prompt, {
        negativePrompt: req.body?.negativePrompt,
        steps: req.body?.steps,
        guidanceScale: req.body?.guidanceScale,
        seed: req.body?.seed,
        width: req.body?.width,
        height: req.body?.height,
    });
    if (result.error || !result.image) {
        return res.status(500).json({ error: result.error || 'No image returned', durationMs: result.durationMs });
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.image.length);
    res.setHeader('X-Generation-Ms', String(result.durationMs));
    return res.end(result.image);
});

// ── Browser image utilities — bg removal + upscale, all client-side ───────
router.get('/image-tools', (req, res) => {
    res.sendFile(path.join(__dirname, 'image-tools.html'));
});

// ── Code execution — Python in the browser via Pyodide ────────────────────
router.get('/code', (req, res) => {
    res.sendFile(path.join(__dirname, 'code.html'));
});

// ── Doc reader — upload a document, get its content extracted as text ────
router.get('/doc-reader', (req, res) => {
    res.sendFile(path.join(__dirname, 'doc-reader.html'));
});

// ── Doc editor — upload a .docx, talk Q through editing it in place ──────
router.get('/doc-editor', (req, res) => {
    res.sendFile(path.join(__dirname, 'doc-editor.html'));
});

// Body: { imageDataUrl, question? }
// Returns: { question, answer } — full extracted content as plain text/markdown.
router.post('/doc-reader/extract', express.json({ limit: '24mb' }), async (req, res) => {
    const imageDataUrl = req.body?.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
        return res.status(400).json({ error: 'Body must include imageDataUrl (data URL)' });
    }
    const userQuestion = req.body?.question;
    const question = (userQuestion && typeof userQuestion === 'string' && userQuestion.trim())
        ? userQuestion.trim()
        : 'Extract all the text content from this document. Preserve structure: keep headings as headings, lists as lists, tables as tables (use Markdown table syntax). Include every visible word, number, date, and signature line. Note where there are images or diagrams. Be thorough — do not summarise.';
    const result = await analyzeDocument({ image_url: imageDataUrl, question });
    res.json(result);
});

// ── Form box finder — upload a form, get bounding boxes for fillable fields ──
router.get('/form-finder', (req, res) => {
    res.sendFile(path.join(__dirname, 'form-finder.html'));
});

// Body: { imageDataUrl, question? }
// Returns analyze_document JSON: { summary, fields: [{label, type, x, y, width, height}] }
// (coordinates are normalised 0-1000 — divide by 1000 and multiply by image
// dimensions to map back to pixel space)
router.post('/form-finder/detect', express.json({ limit: '24mb' }), async (req, res) => {
    const imageDataUrl = req.body?.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
        return res.status(400).json({ error: 'Body must include imageDataUrl (data URL)' });
    }
    const question = req.body?.question
        || 'Find every fillable form field on this page. Return the label, the field type (text_field/checkbox/signature/date/number), and a bounding box for each. Include text fields, checkboxes, signature lines, date fields, and any other input area.';
    const result = await analyzeDocument({ image_url: imageDataUrl, question });
    res.json(result);
});

// ── Q's scheduler — recurring + webhook jobs that fire the agent ──────────
// Management UI:
router.get('/scheduler', (req, res) => {
    res.sendFile(path.join(__dirname, 'scheduler.html'));
});

// List the calling user's jobs.
router.get('/scheduler/jobs', requirePerson, (req, res) => {
    const jobs = listJobs(req.person.email);
    res.json({ count: jobs.length, jobs, storedAt: getJobsPath() });
});

// Get one job (only if it belongs to the caller).
router.get('/scheduler/jobs/:id', requirePerson, (req, res) => {
    const job = getJob(req.params.id, req.person.email);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Create a job — owned by the caller.
router.post('/scheduler/jobs', requirePerson, express.json({ limit: '64kb' }), (req, res) => {
    const result = createJob({ ...(req.body || {}), ownerEmail: req.person.email });
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// Patch a job — only if it belongs to the caller.
router.patch('/scheduler/jobs/:id', requirePerson, express.json({ limit: '64kb' }), (req, res) => {
    if (!getJob(req.params.id, req.person.email)) return res.status(404).json({ error: 'Job not found' });
    const result = patchJob(req.params.id, req.body || {});
    if (result.error) return res.status(404).json(result);
    res.json(result);
});

// Delete a job — only if it belongs to the caller.
router.delete('/scheduler/jobs/:id', requirePerson, (req, res) => {
    if (!getJob(req.params.id, req.person.email)) return res.status(404).json({ error: 'Job not found' });
    const result = deleteJob(req.params.id);
    if (result.error) return res.status(404).json(result);
    res.json(result);
});

// Manual run-now button — only if the job belongs to the caller.
router.post('/scheduler/jobs/:id/run', requirePerson, async (req, res) => {
    const job = getJob(req.params.id, req.person.email);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const result = await runJobNow(job, { source: 'manual' });
    res.json(result);
});

// Public webhook trigger — POST with the job's secret token.
// Returns 202 immediately and runs the agent in the background so external
// callers (Zapier, IFTTT, GitHub Actions) don't wait on a long agent run.
router.post('/scheduler/trigger/:token', (req, res) => {
    const job = findJobByWebhookToken(req.params.token);
    if (!job) return res.status(404).json({ error: 'No job for that token' });
    if (!job.enabled) return res.status(409).json({ error: 'Job is disabled' });
    runJobNow(job, { source: 'webhook' }).catch(err => {
        console.error('[q/scheduler] webhook job', job.id, 'crashed:', err.message);
    });
    res.status(202).json({ ok: true, jobId: job.id, message: 'Triggered' });
});

// Q's persistent facts — what he's remembered across sessions.
// GET  /facts            → list (?q=substring search, ?limit=N)
// DELETE /facts          → wipe all (CAUTION)
// DELETE /facts/:id      → remove one
router.get('/facts', requirePerson, (req, res) => {
    const personId = req.person.id;
    const q = req.query.q;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
    const facts = (q && q.trim()) ? searchFacts(q, { limit }, personId) : listFacts({ limit }, personId);
    res.json({ count: facts.length, facts, storedAt: getFactsPath(personId) });
});

router.delete('/facts', requirePerson, (req, res) => {
    const ok = clearFacts(req.person.id);
    res.json({ ok });
});

router.delete('/facts/:id', requirePerson, (req, res) => {
    const result = deleteFact(req.params.id, req.person.id);
    res.status(result.ok ? 200 : 404).json(result);
});

// Q's agent page — point-and-click goal runner
router.get('/agent', (req, res) => {
    res.sendFile(path.join(__dirname, 'agent.html'));
});

// Q's agent runner — give him a goal, he pursues it autonomously.
// Body: { goal, maxSteps?, verify?, reasoningEffort? }
// Returns: { summary, transcript, steps, durationMs, tokensIn, tokensOut, verifier?, error? }
router.post('/agent/run', requirePerson, express.json({ limit: '256kb' }), async (req, res) => {
    const goal = req.body?.goal;
    if (!goal || typeof goal !== 'string' || !goal.trim()) {
        return res.status(400).json({ error: 'Body must include goal:string' });
    }
    const maxSteps = parseInt(req.body?.maxSteps);
    const verify = req.body?.verify === true;
    // Reasoning effort. V4 Pro recognises 'high' / 'max' / undefined. 'low'
    // wasn't a valid value and caused token blow-out. Agent runs are
    // typically complex so 'high' is the sane default when Quick is picked.
    const rawEffort = req.body?.reasoningEffort;
    const reasoningEffort = (rawEffort === 'high' || rawEffort === 'max') ? rawEffort : 'high';
    const result = await runAgent(goal, {
        maxSteps: Number.isFinite(maxSteps) ? maxSteps : undefined,
        verify,
        reasoningEffort,
    });
    res.json(result);
});

router.get('/voice-clone', (req, res) => {
    res.sendFile(path.join(__dirname, 'voice-clone.html'));
});

router.get('/voices', (req, res) => {
    res.sendFile(path.join(__dirname, 'voices.html'));
});

// ── Q's permanent voice — saved override on the Railway volume ────────────
const { setQVoiceFromBuffer, clearQVoice, getQVoiceStatus } = require('./plugins/q-tools');

router.get('/q-voice/status', requirePerson, (req, res) => {
    res.json(getQVoiceStatus(req.person.email));
});

// Save Q's voice from a file upload (base64 in body).
router.post('/q-voice/save-from-upload', requirePerson, express.json({ limit: '8mb' }), (req, res) => {
    const b64 = req.body?.audioBase64;
    if (!b64 || typeof b64 !== 'string') {
        return res.status(400).json({ error: 'audioBase64 (string) is required' });
    }
    try {
        const buf = Buffer.from(b64, 'base64');
        const result = setQVoiceFromBuffer(buf, req.person.email);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to save voice' });
    }
});

// Save Q's voice from a URL — uses the audio-fetch plugin to grab a clean slice.
router.post('/q-voice/save-from-url', requirePerson, express.json({ limit: '8kb' }), async (req, res) => {
    const { url, startTime } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    try {
        const buf = await fetchAudioClip(url, { startTime });
        const result = setQVoiceFromBuffer(buf, req.person.email);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to fetch and save voice' });
    }
});

// Reset Q's voice back to the bundled default.
router.post('/q-voice/reset', requirePerson, (req, res) => {
    res.json(clearQVoice(req.person.email));
});

// Voice cloning from a URL — server-side downloads ~15s of audio from the URL,
// then forwards to the cloning space. One-shot endpoint: returns audio binary.
const { fetchAudioClip } = require('./plugins/q-audio-fetch');
router.post('/voice-clone/from-url', express.json({ limit: '8kb' }), async (req, res) => {
    const { url, text, exaggeration, cfgWeight, startTime } = req.body || {};
    console.log(`[voice-clone/from-url] IN  url="${(url || '').slice(0,80)}" startTime=${startTime} textLen=${text?.length}`);
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    try {
        console.log(`[voice-clone/from-url] fetching audio clip...`);
        const refBuf = await fetchAudioClip(url, { startTime });
        console.log(`[voice-clone/from-url] OK clip fetched, ${refBuf?.length || 0} bytes`);

        console.log(`[voice-clone/from-url] calling speakAsVoice (SPACE_URL=${process.env.CHATTERBOX_SPACE_URL ? 'set' : 'UNSET'})...`);
        const result = await speakAsVoice(text, refBuf, 'audio/wav', {
            exaggeration: typeof exaggeration === 'number' ? exaggeration : undefined,
            cfgWeight:    typeof cfgWeight    === 'number' ? cfgWeight    : undefined,
        });
        console.log(`[voice-clone/from-url] speakAsVoice returned: hasAudio=${!!result.audio} (${result.audio?.length || 0}b), error=${JSON.stringify(result.error)}, durationMs=${result.durationMs}`);

        if (result.error || !result.audio) {
            console.warn(`[voice-clone/from-url] FAIL → 500: ${result.error || 'No audio returned'}`);
            return res.status(500).json({ error: result.error || 'No audio returned', durationMs: result.durationMs });
        }
        res.setHeader('Content-Type', result.mimeType);
        res.setHeader('Content-Length', result.audio.length);
        res.setHeader('X-Generation-Ms', String(result.durationMs));
        return res.end(result.audio);
    } catch (e) {
        console.error(`[voice-clone/from-url] THREW: ${e.message}\n${e.stack}`);
        res.status(500).json({ error: e.message || 'Audio fetch failed' });
    }
});

// Voice cloning — POST text + reference audio (base64), get back WAV audio
// of Q speaking that text in the reference voice. Calls the Chatterbox HF
// Space (Q_CONFIG.chatterboxSpaceUrl). See q-lab/plugins/q-voice-clone.js.
//
// Body: { text, referenceAudioBase64, referenceMimeType, exaggeration?, cfgWeight? }
// Returns: audio/wav binary stream (or JSON error)
router.post('/speak-as-voice', express.json({ limit: '8mb' }), async (req, res) => {
    const text = req.body?.text;
    const refB64 = req.body?.referenceAudioBase64;
    const refMime = req.body?.referenceMimeType || 'audio/webm';
    const exaggeration = typeof req.body?.exaggeration === 'number' ? req.body.exaggeration : undefined;
    const cfgWeight = typeof req.body?.cfgWeight === 'number' ? req.body.cfgWeight : undefined;

    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Body must include text:string' });
    }
    if (!refB64 || typeof refB64 !== 'string') {
        return res.status(400).json({ error: 'Body must include referenceAudioBase64:string' });
    }

    let refBuf;
    try {
        refBuf = Buffer.from(refB64, 'base64');
    } catch (e) {
        return res.status(400).json({ error: 'referenceAudioBase64 is not valid base64' });
    }

    console.log(`[speak-as-voice] IN  textLen=${text.length}, refMime=${refMime}, refBytes=${refBuf.length}, SPACE_URL=${process.env.CHATTERBOX_SPACE_URL ? 'set' : 'UNSET'}`);
    const result = await speakAsVoice(text, refBuf, refMime, { exaggeration, cfgWeight });
    console.log(`[speak-as-voice] speakAsVoice returned: hasAudio=${!!result.audio} (${result.audio?.length || 0}b), error=${JSON.stringify(result.error)}, durationMs=${result.durationMs}`);

    if (result.error || !result.audio) {
        return res.status(500).json({ error: result.error || 'No audio returned', durationMs: result.durationMs });
    }

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.audio.length);
    res.setHeader('X-Generation-Ms', String(result.durationMs));
    return res.end(result.audio);
});

module.exports = router;
