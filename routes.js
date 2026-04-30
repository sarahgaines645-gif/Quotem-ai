/**
 * Q LAB ROUTES — isolated test endpoints for Q
 *
 * Mounted at /api/q-lab by server/index.js. Only accessible via explicit URL path.
 * Live Quotem features never route through here.
 */
'use strict';

const path = require('path');
const express = require('express');
const router = express.Router();
const { readText } = require('./plugins/qwen-text-reader');
const { translateToSOR } = require('./plugins/qwen-translator');
const { checkResults } = require('./plugins/qwen-checker');
const { expandItem } = require('./plugins/qwen-expander');
const { priceItem, priceItems } = require('./plugins/qwen-pricer');
const { chat } = require('./plugins/qwen-chat');
const { stats: ragStats } = require('./plugins/qwen-rag');
const { speakAsVoice } = require('./plugins/qwen-voice-clone');
const { runAgent } = require('./plugins/qwen-agent');
const { analyzeDocument } = require('./plugins/qwen-tools');
const { generateImage } = require('./plugins/qwen-image-gen');
const { vectoriseImage } = require('./plugins/qwen-graphics');
const { generateMusic } = require('./plugins/qwen-music');
const { generateVideo } = require('./plugins/qwen-video');
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
const { loadMemory, clearMemory, appendMessage, getRecentMessages, getCircleSummary, getMemoryPath } = require('./memory');
const { requirePerson, tryAttachPerson, setSessionCookie, clearSessionCookie } = require('./auth');
const { listPeople, addPerson, signupPerson, getPerson, getPersonByEmail, removePerson, verifyLogin, changePassword, rotatePassword, createResetToken, consumeResetToken } = require('./people');
const { sendMail, isConfigured: mailerConfigured } = require('./mailer');
const { resolveToken: resolveGeneratedDoc } = require('./plugins/doc-creator');
const { summarise: summariseCosts, getLogPath: costLogPath } = require('./cost-tracker');

// ── Auth: login + logout ────────────────────────────────────────────────────

router.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
    const { email, password } = req.body || {};
    const person = await verifyLogin(email, password);
    if (!person) {
        // Constant-time-ish: still wait roughly as long as a real bcrypt compare
        return res.status(401).json({ error: 'Email or password incorrect.' });
    }
    setSessionCookie(res, person.email);
    res.json({ ok: true, person });
});

// Public self-signup. No invite code, no approval — anyone can create an
// account by giving a name, email, and 8+ char password. Auto-logs in on
// success by setting the session cookie. Tighten this if the URL gets
// shared in places it shouldn't.
router.post('/signup', express.json({ limit: '4kb' }), async (req, res) => {
    const { name, email, password } = req.body || {};
    try {
        const person = await signupPerson({ name, email, password });
        setSessionCookie(res, person.email);
        return res.json({ ok: true, person });
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
    res.json({ person: req.person || null });
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
    const found = resolveGeneratedDoc(req.params.token);
    if (!found) return res.status(404).send('That download has expired or never existed.');
    res.download(found.fullPath, found.filename);
});

// Admin: add someone to the Circle (Sarah only)
router.post('/circle/add', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    if (req.person.id !== 'sarah') return res.status(403).json({ error: 'Forbidden' });
    try {
        const { id, name, email, intro, password } = req.body || {};
        const result = await addPerson({ id, name, email, intro, password });
        res.json(result); // returns { person, password } — copy the raw password ONCE
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/circle/people/:id/rotate', requirePerson, async (req, res) => {
    if (req.person.id !== 'sarah') return res.status(403).json({ error: 'Forbidden' });
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

// Q's chat API — uses server-side memory by default
// Body: { message: "..." } (preferred — uses server memory)
//   OR: { messages: [...] } (legacy — full history sent each time)
router.post('/chat', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    const person = req.person; // attached by requirePerson — { id, name, intro, addedAt }
    const newMessage = req.body?.message;
    const messagesArray = req.body?.messages;
    const rawEffort = req.body?.reasoningEffort;
    const reasoningEffort = (rawEffort === 'high' || rawEffort === 'max') ? rawEffort : undefined;
    const rawImages = req.body?.images;
    const images = Array.isArray(rawImages)
        ? rawImages.filter(i => i && typeof i.dataUrl === 'string' && i.dataUrl.startsWith('data:'))
        : [];
    const useTools = req.body?.useTools !== false;
    const verify = req.body?.verify === true;
    // Optional persona overlay: 'aps' for A-Problem-Shared mode. Anything else
    // (including undefined) leaves Q in default mode.
    const mode = (req.body?.mode === 'aps') ? 'aps' : undefined;
    const circle = getCircleSummary();
    const chatOptions = { reasoningEffort, images, useTools, verify, mode, person, circle };

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
        // Per-person memory: load only THIS person's history. Friends'
        // conversations never bleed into Q's context for this turn.
        const rawHistory = loadMemory(person.id).slice(-50);
        const history = rawHistory.map(m => {
            const ts = m.timestamp ? m.timestamp.slice(0, 16).replace('T', ' ') : '?';
            // Each file only contains turns between this person and Q, so
            // the role alone is unambiguous; just keep timestamps so Q can
            // sense gaps between sessions.
            return {
                role: m.role,
                content: `[${ts}] ${m.content}`,
            };
        });
        // Tell Q the current moment so he can locate himself in time
        const now = new Date();
        const nowStr = now.toISOString().slice(0, 16).replace('T', ' ');
        history.unshift({
            role: 'system',
            content: `It is now ${nowStr} (UTC). You're talking to ${person.name}. The history below shows previous turns between you two with their timestamps — note any gaps between sessions and respond as someone who has had time pass, not as if every turn just happened.`,
        });
        const userMemoryContent = images.length > 0
            ? newMessage + `\n[${person.name} attached ${images.length} image${images.length > 1 ? 's' : ''}]`
            : newMessage;
        const messagesForQ = [
            ...history,
            { role: 'user', content: userMemoryContent },
        ];
        appendMessage(person.id, 'user', userMemoryContent);
        const result = await chat(messagesForQ, chatOptions);
        if (result.reply) appendMessage(person.id, 'assistant', result.reply);
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
});

// GET Q's memory for the calling person. Each person has their own file —
// no filtering or cross-person bleed. Sarah's wipe doesn't touch anyone
// else; nobody else's wipe touches Sarah.
router.get('/chat-history', requirePerson, (req, res) => {
    const messages = loadMemory(req.person.id);
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

    try {
        // PDF
        if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            return res.json({
                text: (data.text || '').trim(),
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
            return res.json({
                text: (result.value || '').trim(),
                name,
                kind: 'docx',
            });
        }
        return res.status(400).json({ error: 'Unsupported file type for extraction.' });
    } catch (e) {
        console.warn('[extract-text] failed for ' + name + ': ' + e.message);
        return res.status(500).json({
            error: 'Could not read that file. It might be encrypted, scanned (image-only), or corrupted.',
        });
    }
});

// ── Q's circle — admin endpoints (Sarah only) ──────────────────────────────
router.get('/circle/people', requirePerson, (req, res) => {
    if (req.person.id !== 'sarah') return res.status(403).json({ error: 'Forbidden' });
    res.json({ people: listPeople() });
});

router.delete('/circle/people/:id', requirePerson, (req, res) => {
    if (req.person.id !== 'sarah') return res.status(403).json({ error: 'Forbidden' });
    if (req.params.id === 'sarah') return res.status(400).json({ error: 'Cannot remove Sarah from her own circle.' });
    const ok = removePerson(req.params.id);
    res.json({ ok });
});

// ── Cost tracking — Sarah only ─────────────────────────────────────────────
router.get('/admin/costs', requirePerson, (req, res) => {
    if (req.person.id !== 'sarah') return res.status(403).json({ error: 'Forbidden' });
    const groupBy = req.query.groupBy || 'skill';
    const since = req.query.since;
    const until = req.query.until;
    res.json({
        ...summariseCosts({ since, until, groupBy }),
        groupBy,
        logPath: costLogPath(),
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

// List all jobs.
router.get('/scheduler/jobs', (req, res) => {
    const jobs = listJobs();
    res.json({ count: jobs.length, jobs, storedAt: getJobsPath() });
});

// Get one job (full history).
router.get('/scheduler/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Create a job.
router.post('/scheduler/jobs', express.json({ limit: '64kb' }), (req, res) => {
    const result = createJob(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// Patch a job (enable/disable, edit name/goal/trigger).
router.patch('/scheduler/jobs/:id', express.json({ limit: '64kb' }), (req, res) => {
    const result = patchJob(req.params.id, req.body || {});
    if (result.error) return res.status(404).json(result);
    res.json(result);
});

// Delete a job.
router.delete('/scheduler/jobs/:id', (req, res) => {
    const result = deleteJob(req.params.id);
    if (result.error) return res.status(404).json(result);
    res.json(result);
});

// Manual run-now button — fires the job immediately, returns result inline.
router.post('/scheduler/jobs/:id/run', async (req, res) => {
    const job = getJob(req.params.id);
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
router.get('/facts', (req, res) => {
    const q = req.query.q;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
    const facts = (q && q.trim()) ? searchFacts(q, { limit }) : listFacts({ limit });
    res.json({ count: facts.length, facts, storedAt: getFactsPath() });
});

router.delete('/facts', (req, res) => {
    const ok = clearFacts();
    res.json({ ok });
});

router.delete('/facts/:id', (req, res) => {
    const result = deleteFact(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
});

// Q's agent page — point-and-click goal runner
router.get('/agent', (req, res) => {
    res.sendFile(path.join(__dirname, 'agent.html'));
});

// Q's agent runner — give him a goal, he pursues it autonomously.
// Body: { goal, maxSteps?, verify?, reasoningEffort? }
// Returns: { summary, transcript, steps, durationMs, tokensIn, tokensOut, verifier?, error? }
router.post('/agent/run', express.json({ limit: '256kb' }), async (req, res) => {
    const goal = req.body?.goal;
    if (!goal || typeof goal !== 'string' || !goal.trim()) {
        return res.status(400).json({ error: 'Body must include goal:string' });
    }
    const maxSteps = parseInt(req.body?.maxSteps);
    const verify = req.body?.verify === true;
    const rawEffort = req.body?.reasoningEffort;
    const reasoningEffort = (rawEffort === 'high' || rawEffort === 'max') ? rawEffort : undefined;
    const result = await runAgent(goal, {
        maxSteps: Number.isFinite(maxSteps) ? maxSteps : undefined,
        verify,
        reasoningEffort,
    });
    res.json(result);
});

// Voice cloning — POST text + reference audio (base64), get back WAV audio
// of Q speaking that text in the reference voice. Calls the Chatterbox HF
// Space (Q_CONFIG.chatterboxSpaceUrl). See q-lab/plugins/qwen-voice-clone.js.
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

    const result = await speakAsVoice(text, refBuf, refMime, { exaggeration, cfgWeight });

    if (result.error || !result.audio) {
        return res.status(500).json({ error: result.error || 'No audio returned', durationMs: result.durationMs });
    }

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.audio.length);
    res.setHeader('X-Generation-Ms', String(result.durationMs));
    return res.end(result.audio);
});

module.exports = router;
