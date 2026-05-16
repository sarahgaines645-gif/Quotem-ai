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
const { chat } = require('./plugins/q-chat');
const { stats: ragStats } = require('./plugins/q-rag');
const { speakAsVoice } = require('./plugins/q-voice-clone');
const { runAgent } = require('./plugins/q-agent');
const { analyzeDocument } = require('./plugins/q-tools');
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
const { loadMemory, clearMemory, appendMessage, getRecentMessages, getCircleSummary, getMemoryPath, getVoicePath } = require('./memory');
const { requirePerson, tryAttachPerson, setSessionCookie, clearSessionCookie } = require('./auth');
const { listPeople, addPerson, signupPerson, getPerson, getPersonByEmail, removePerson, verifyLogin, changePassword, rotatePassword, createResetToken, consumeResetToken } = require('./people');
const { sendMail, isConfigured: mailerConfigured } = require('./mailer');
const { resolveToken: resolveGeneratedDoc, resolveTokenAcrossUsers } = require('./plugins/doc-creator');
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

// Q's adaptive writing coach. The user writes the document — Q asks
// questions and assembles. See plugins/q-writer.js.
router.get('/writer', (req, res) => {
    res.sendFile(path.join(__dirname, 'writer.html'));
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
// Returns: { values: { fieldName: value } }  — for the UI to populate the review form
router.post('/forms/extract', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
    try {
        const { fields, infoText, imageDataUrl } = req.body || {};
        if (!fields || !fields.length) return res.status(400).json({ error: 'fields required' });
        if (!infoText && !imageDataUrl) return res.status(400).json({ error: 'infoText or imageDataUrl required' });
        const values = await qFormFiller.extractFieldValues(fields, infoText || '', imageDataUrl || null);
        res.json({ ok: true, values });
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
        const result = await qWriter.askLeadingQuestion(
            analysis, brief, history || [], voiceSignature, relateAnchor, yearGroup
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

// Q's chat API — uses server-side memory by default
// Body: { message: "..." } (preferred — uses server memory)
//   OR: { messages: [...] } (legacy — full history sent each time)
router.post('/chat', requirePerson, express.json({ limit: '24mb' }), async (req, res) => {
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
    let reasoningEffort = (rawEffort === 'high' || rawEffort === 'max') ? rawEffort : 'high';
    if (rawEffort === 'off' && typeof req.body?.message === 'string') {
        const m = req.body.message.trim();
        const trivial = m.length < 25
            && !m.includes('?')
            && !m.includes('```')
            && !/\d/.test(m);
        if (trivial) reasoningEffort = undefined;
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
    const circle = getCircleSummary();
    const chatOptions = { reasoningEffort, images, useTools, verify, mode, person, circle, surface };

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
        appendMessage(person.id, 'user', userMemoryContent, surface);
        const result = await chat(messagesForQ, chatOptions);
        if (result.reply) appendMessage(person.id, 'assistant', result.reply, surface);
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
            error: `Could not read that file: ${e.message}`,
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

// Admin landing — tile grid linking to each admin sub-page. Sarah-only
// check is enforced client-side via /whoami; the static HTML is open.
router.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin · tools page (HTML). Data comes from /admin/tools-data below.
router.get('/admin/tools', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-tools.html'));
});

// Admin · tools metadata. Sarah-only. Lists every tool Q can call, its
// provider, and what it costs per call. Pricing pulled from cost-tracker
// where available; static descriptions kept inline so the admin page
// stays self-contained.
router.get('/admin/tools-data', requirePerson, (req, res) => {
    if (req.person.id !== 'sarah') return res.status(403).json({ error: 'Forbidden' });
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

// ── THREADS — saved situations (folders) ───────────────────────────────
// Every Thread is owned by ONE user (by email). All routes here require
// sign-in via requirePerson and only operate on Threads owned by req.person.
const qThreads = require('./plugins/q-threads');
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

// One-time legacy claim — Sarah's existing Threads were created without
// owner-scoping and got locked to '__legacy__' on next read. This endpoint
// claims every '__legacy__' Thread for the calling user. Run once.
router.post('/api/threads/claim-legacy', requirePerson, (req, res) => {
    const result = qThreads.claimLegacyThreads(req.person.email);
    res.json(result);
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

router.get('/api/threads/:id/files/:filename', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const file = qThreads.readFile(req.params.id, req.params.filename, req.person.email);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.end(file.buffer);
});

router.delete('/api/threads/:id/files/:filename', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeFile(req.params.id, req.params.filename, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Thread not found' });
    res.json(updated);
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
    if (t.emails.length > 0 || (t.files && t.files.length > 0)) {
        const parts = [];
        if (t.emails.length > 0) {
            parts.push(t.emails.map((e, i) => {
                const dir = e.type === 'in' ? 'RECEIVED' : 'SENT';
                const meta = [e.from && `from: ${e.from}`, e.to && `to: ${e.to}`, e.date && `date: ${e.date}`, e.subject && `subject: ${e.subject}`].filter(Boolean).join(' · ');
                return `--- ${dir} #${i + 1}${meta ? ' (' + meta + ')' : ''} ---\n${e.body}`;
            }).join('\n\n'));
        }
        if (t.files && t.files.length > 0) {
            parts.push('--- FILES ATTACHED TO THIS THREAD ---\n' +
                t.files.map(f => `• ${f.filename} (${f.mimeType}, ${(f.size / 1024).toFixed(0)} KB) — uploaded ${f.uploadedAt}`).join('\n'));
        }
        messages.push({ role: 'user', content: `This is the saved situation "${t.title}". Here's everything so far:\n\n${parts.join('\n\n')}` });
        messages.push({ role: 'assistant', content: 'Got it — fully up to speed on this case.' });
    }
    for (const h of (t.chatHistory || [])) {
        if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
            messages.push({ role: h.role, content: h.content });
        }
    }
    messages.push({ role: 'user', content: message });

    // Photos attached to a thread are first-class — no different to a doc or
    // email. When she's just added an image (the silent add-ping fires) or her
    // message refers to one, hand Q the actual pixels so he SEES it, not just
    // the filename line. Reuses the vision path q-chat.js already has
    // (options.images → vision model). Non-image turns stay text+tools so the
    // case-research tooling (web_search, list_threads) keeps working — that's
    // why this is scoped to add-ping / referential turns, not every turn.
    const imageFiles = (t.files || []).filter(f => (f.mimeType || '').startsWith('image/'));
    const isAddPing = /I've just added .+ to the case/i.test(message);
    const refersToImage = /\b(image|images|photo|photos|picture|pictured|pic|pics|screenshot|scan|scanned|see|look|shows?|attached)\b/i.test(message);
    const visionImages = [];
    if (imageFiles.length && (isAddPing || refersToImage)) {
        for (const f of imageFiles) {
            try {
                const file = qThreads.readFile(t.id, f.filename, req.person.email);
                if (file && file.buffer) {
                    visionImages.push({
                        dataUrl: `data:${file.mimeType || 'image/jpeg'};base64,${file.buffer.toString('base64')}`,
                    });
                }
            } catch (e) {
                console.warn('[threads] could not read image for vision: ' + f.filename + ' — ' + e.message);
            }
        }
    }

    try {
        const qOpts = { useTools: true, mode: 'aps', surface: 'thread', person: req.person };
        if (visionImages.length) qOpts.images = visionImages;
        const result = await qChat(messages, qOpts);
        if (result.error || !result.reply) {
            return res.status(500).json({ error: result.error || 'No reply from Q' });
        }
        const polished = polishUK(result.reply);
        if (!silentUser) {
            qThreads.appendChat(t.id, 'user', message, req.person.email);
        }
        qThreads.appendChat(t.id, 'assistant', polished, req.person.email);
        res.json({ reply: polished });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Chat failed' });
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
