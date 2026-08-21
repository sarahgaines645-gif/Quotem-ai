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
// Voice cloning (q-voice-clone / q-audio-fetch) RETIRED 2026-08-15 — see retired/2026-08-15-voice-clone-and-music/RETIRED.md
const { runAgent } = require('./plugins/q-agent');
const { analyzeDocument, webSearch } = require('./plugins/q-tools');
const qThreads = require('./plugins/q-threads');
const { generateImage } = require('./plugins/q-image-gen');
const { vectoriseImage } = require('./plugins/q-graphics');
// Music generation (q-music) RETIRED 2026-08-15 — see retired/2026-08-15-voice-clone-and-music/RETIRED.md
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
const { loadMemory, clearMemory, appendMessage, getRecentMessages, getCircleSummary, getMemoryPath, getVoicePath, getDocPath, getTutorPath, getRevisionPath, getParkPath, tutorScope, readTutorIndex, writeTutorIndex, resolveWriterProject, PROJECT_ID_RE } = require('./memory');
const { requirePerson, tryAttachPerson, setSessionCookie, clearSessionCookie } = require('./auth');
const { listPeople, addPerson, signupPerson, isApproved, approvePerson, isAdmin, getPerson, getPersonByEmail, removePerson, verifyLogin, changePassword, updateName, rotatePassword, createResetToken, consumeResetToken, createVerificationToken, consumeVerificationToken, isEmailVerified } = require('./people');
const { sendMail, isConfigured: mailerConfigured } = require('./mailer');
const { resolveToken: resolveGeneratedDoc, resolveTokenAcrossUsers } = require('./plugins/doc-creator');
const { summarise: summariseCosts, getLogPath: costLogPath, logUsage, computeCost } = require('./cost-tracker');
const { timedFetch } = require('./plugins/timed-fetch');
const qPush = require('./plugins/q-push');

// ── Auth: login + logout ────────────────────────────────────────────────────

router.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
    const { email, password } = req.body || {};
    const person = await verifyLogin(email, password);
    if (!person) {
        // Constant-time-ish: still wait roughly as long as a real bcrypt compare
        return res.status(401).json({ error: 'Email or password incorrect.' });
    }
    // Two gates, both must pass. Credentials are correct here (we don't leak
    // either state to wrong passwords).
    // 1. The person must have proved they own the email (clicked the link).
    if (!isEmailVerified(person)) {
        return res.status(403).json({
            error: 'Please verify your email first — we sent you a link when you signed up. Check your inbox (and spam), or ask for a new link.',
            code: 'email_unverified',
        });
    }
    // 2. Sarah must have let them into the Circle.
    if (!isApproved(person)) {
        return res.status(403).json({ error: "Your account is waiting to be approved. You'll be able to sign in once it's been let in.", code: 'pending_approval' });
    }
    setSessionCookie(res, person.email);
    res.json({ ok: true, person });
});

// ── Sign-up + email verification ─────────────────────────────────────────
// Self-signup creates the person UNVERIFIED and PENDING, then emails a
// verification link. Sign-in refuses until (a) the link is clicked and
// (b) Sarah approves from the members page. No session cookie is set here.
// The client shows the "check your inbox / awaiting approval" card on
// { pending: true }.
function absoluteLink(req, pathAndQuery) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https');
    const host = req.headers.host || 'www.quotem-ai.co.uk';
    return `${proto}://${host}${pathAndQuery}`;
}

async function sendVerificationEmail(req, person) {
    const token = createVerificationToken(person.email);
    if (!token) return false;                                   // already verified / unknown
    if (!mailerConfigured()) {
        console.warn('[signup] mailer not configured — verification token minted but NO email sent to ' + person.email + '. Sarah can still approve from the members page (approval also marks the email verified).');
        return false;
    }
    const link = absoluteLink(req, `/verify-email?token=${encodeURIComponent(token)}`);
    const first = (person.name || '').split(' ')[0];
    const text = `Hi ${first},\n\nThanks for signing up to Q. Click this link within 24 hours to confirm this is your email address:\n${link}\n\nOnce it's confirmed, your account waits for a quick approval and then you're in.\n\nIf you didn't sign up, ignore this email — nothing will happen.\n\n— Q`;
    const html = `<p>Hi ${first},</p><p>Thanks for signing up to Q. <a href="${link}">Click here to confirm this is your email address</a> — the link is valid for 24 hours.</p><p>Once it's confirmed, your account waits for a quick approval and then you're in.</p><p>If you didn't sign up, ignore this email — nothing will happen.</p><p>— Q</p>`;
    try {
        await sendMail({ to: person.email, subject: 'Confirm your email for Q', text, html });
        return true;
    } catch (e) {
        console.warn('[signup] verification sendMail failed:', e.message);
        return false;
    }
}

router.post('/signup', express.json({ limit: '4kb' }), async (req, res) => {
    const { name, email, password } = req.body || {};
    try {
        const person = await signupPerson({ name, email, password });
        const verifyEmailSent = await sendVerificationEmail(req, person);
        return res.json({ ok: true, pending: true, verifyEmailSent, person });
    } catch (e) {
        return res.status(400).json({ error: e.message || 'Sign-up failed.' });
    }
});

// The link in the email. Public (the person is not signed in yet). Lands
// them back on /welcome with a flag so the sign-in card can say what happened.
router.get('/verify-email', (req, res) => {
    const token = String(req.query?.token || '');
    const person = consumeVerificationToken(token);
    res.setHeader('Cache-Control', 'no-store');
    if (!person) return res.redirect(302, '/welcome?verify=invalid');
    console.log(`[signup] email verified for ${person.id}`);
    return res.redirect(302, '/welcome?verify=ok');
});

// "Send me a new link." Always answers ok so it never reveals which emails
// exist. Throttled per email to one send a minute per process.
const resendLast = new Map();
router.post('/resend-verification', express.json({ limit: '4kb' }), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const respond = () => res.json({ ok: true });
    if (!email) return respond();
    const last = resendLast.get(email) || 0;
    if (Date.now() - last < 60_000) return respond();
    resendLast.set(email, Date.now());
    const person = getPersonByEmail(email);
    if (!person || isEmailVerified(person)) return respond();
    await sendVerificationEmail(req, person);
    respond();
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

// Set/change the name Q greets you by. Used by the chat onboarding ("what's
// your name?") and any "actually, call me X" correction.
router.post('/set-name', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        const person = updateName(req.person.id, name);
        res.json({ ok: true, name: person.name });
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
        model: 'zai-org/GLM-5.2',
        max_tokens: 256,
        temperature: 0,
        tools: [{ type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'What is the weather in London today? Use web_search.' }]
    };
    try {
        const started = Date.now();
        const r = await timedFetch('https://api.together.xyz/v1/chat/completions', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }, { label: 'glm test' });
        const data = await r.json();
        logUsage({ skill: 'test-glm-tools', provider: 'together', model: body.model, data, started });
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

// Revision — one exam-style question at a time, marked strictly, U→A ladder.
// Claude-backed (q-revision via q-claude) with Q as fallback.
router.get('/revise', (req, res) => {
    res.sendFile(path.join(__dirname, 'revise.html'));
});

// The dancing-unicorn bench. Sarah's page for LOOKING at the celebration on
// its own — the real thing lives on /revise, fired by a right answer in Teen
// mode. Signed-in only: to send this link to somebody without an account,
// '/unicorn' has to go in PUBLIC_PATHS in server/index.js.
router.get('/unicorn', (req, res) => {
    res.sendFile(path.join(__dirname, 'unicorn.html'));
});

// The 3D test bench — six rigged unicorns doing the generated dance. This is
// Sarah's page for LOOKING at it before any of it goes near the quiz.
router.get('/unicorn3d', (req, res) => {
    res.sendFile(path.join(__dirname, 'unicorn3d.html'));
});

// The rig bench — the skeleton on its own, with any dance dropped onto it and
// the real record playing through YouTube's player. This is the page to open
// when the question is "does this rig work", rather than "does the show look
// right": it shows the 52 bones, and it says in numbers how many of them the
// chosen dance actually moves.
router.get('/rig', (req, res) => {
    res.sendFile(path.join(__dirname, 'rig.html'));
});

// The control test. A character and a dance authored by the same artist on the
// same skeleton, played straight. Nothing generated, nothing retargeted. It
// exists to answer one question honestly: is the page wrong, or was the asset?
router.get('/dance', (req, res) => {
    res.sendFile(path.join(__dirname, 'dance.html'));
});
// The disco. The dancing unicorn is a GENERATED CLIP, not a rig — shot against
// green and keyed in the browser, so she composites into the scene with the
// disco ball and the beams. She dances alone, then the others jump in on the
// beat. No bones anywhere.
router.get('/disco', (req, res) => {
    res.sendFile(path.join(__dirname, 'disco.html'));
});

// The lab. A properly rigged character (three.js Michelle, MIT) in a lab coat
// built from primitives PARENTED TO HER BONES, picking up a test tube and
// pouring water into it. The action is a function of TIME written against bone
// NAMES (assets/unicorn-actions.js), so it drives any Mixamo-spec character and
// can be fired whenever a lesson needs it — which is the one thing a generated
// video cannot do.
router.get('/lab', (req, res) => {
    res.sendFile(path.join(__dirname, 'lab.html'));
});

// The studio. Drag her hands where you want them and the arm solves to it;
// place the props; set keyframes; scrub. The point is CONTROL — posing a
// character by typing joint angles is guessing, and this is the tool that
// replaces it. Export gives the keys as numbers to bake into an action.
router.get('/studio', (req, res) => {
    res.sendFile(path.join(__dirname, 'studio.html'));
});


// Q's personal finance page.
router.get('/finance', (req, res) => {
    res.sendFile(path.join(__dirname, 'finance.html'));
});

// Q's plotter — PDF AcroForm field parser. Reads the real field structure from
// a PDF (no vision needed). Client-side PDF.js does the parsing and rendering;
// this route just serves the page.
// The glass cuboid — the one dark surface in Q. Static page, no engine behind
// it, so nothing here can fail to load and take the router with it.
router.get('/cuboid', (req, res) => {
    res.sendFile(path.join(__dirname, 'cuboid.html'), (err) => {
        if (err && !res.headersSent) res.status(503).send('That page is not available on this deployment.');
    });
});

router.get('/plotter', (req, res) => {
    res.sendFile(path.join(__dirname, 'plotter.html'));
});

// ─────────────────────────────────────────────────────────────
//  TRIPS — where can we actually go, and when
// ─────────────────────────────────────────────────────────────
// The page is a 3D globe plus a shortlist. The engine (plugins/q-trips.js)
// answers from RECORDED weather for the same week in past years rather than
// monthly averages, and returns null for anything it could not find out.
// Live prices and reviews are deliberately NOT part of this search — they cost
// supplier quota, so they are a separate, opt-in call per destination.
router.get('/trips', (req, res) => {
    res.sendFile(path.join(__dirname, 'trips.html'), (err) => {
        if (err && !res.headersSent) res.status(503).send('The trips page is not available on this deployment.');
    });
});

// ⚠️ 21 Aug 2026 — this require took the ENTIRE APP down for ~40 minutes.
// `plugins/q-trips.js` was still untracked when routes.js was committed, so the
// deploy had the routes but not the module. A top-level require that throws is
// swallowed by the try/catch in server/index.js — which means NOT ONE route in
// this file mounts. Every page and every API 404s while /health still says fine.
// A missing optional plugin must cost you that plugin's routes and nothing else.
let qTrips = null;
try {
    qTrips = require('./plugins/q-trips');
} catch (err) {
    console.error('[trips] engine not loaded — /trips and /api/trips/* will answer 503:', err.message);
}
const tripsUnavailable = (res) => res.status(503).json({
    ok: false,
    error: 'trips_engine_missing',
    message: 'Trip search is not available on this deployment.',
});

// The airport list the page's "flying from" box is built out of.
router.get('/api/trips/airports', (req, res) => {
    if (!qTrips) return tripsUnavailable(res);
    res.json({
        origins: qTrips.origins(),
        regions: [...new Set(qTrips.destinations().map(d => d.region))],
    });
});

router.post('/api/trips/search', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    if (!qTrips) return tripsUnavailable(res);
    try {
        const out = await qTrips.searchTrips(req.body || {});
        res.json(out);
    } catch (err) {
        console.error('[trips] search failed:', err);
        res.status(500).json({
            ok: false, error: 'search_failed',
            message: 'The trip search did not finish. Nothing was filled in from memory — please try again.',
        });
    }
});


// ─────────────────────────────────────────────────────────────
//  THE HOLIDAY BOARD — the holidays she actually found, kept
// ─────────────────────────────────────────────────────────────
// The climate search answers "where is warm". This is the other half: she
// screenshots a real listing on somebody's website and it becomes a card with
// the price, the company, the link and what is good and bad about it — and
// when the family answer the linkmail, their answers land back on that card.
//
// Same lesson as the require above: an optional plugin that fails to load
// costs you its own routes and nothing else.
let qTripBoard = null;
try {
    qTripBoard = require('./plugins/q-trip-board');
} catch (err) {
    console.error('[trips] board not loaded — /api/trips/board/* will answer 503:', err.message);
}
const qPeople = require('./plugins/q-people');
const boardUnavailable = (res) => res.status(503).json({
    ok: false, error: 'trip_board_missing',
    message: 'The holiday board is not available on this deployment.',
});

router.get('/api/trips/board', requirePerson, (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    res.json({ ok: true, holidays: qTripBoard.list(req.person.email) });
});

// Read a screenshot. This does NOT save anything — she sees what it found and
// decides. A vision model reading a picture wrong is a normal Tuesday, so the
// answer is always shown before it becomes a card.
router.post('/api/trips/board/read', requirePerson, express.json({ limit: '8mb' }), async (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    try {
        const out = await qTripBoard.readShot((req.body || {}).image, req.person.email);
        if (out.error) return res.status(422).json({ ok: false, ...out });

        // What the printed dates probably mean. A SUGGESTION for the two date
        // boxes on the card and nothing more — suggestDates() returns null the
        // moment it is not certain, and nothing reaches her calendar off it.
        if (!out.notAListing) {
            const guess = qTripBoard.suggestDates(out.dates, out.nights);
            out.startDate = guess ? guess.start : null;
            out.endDate = guess ? guess.end : null;
        }

        // The company's logo, fetched by Q's server so the logo host never
        // learns who is looking at which holiday (plugins/q-logos.js).
        if (!out.notAListing && out.company) {
            try {
                const logo = await qLogos.getLogo({ name: out.companyDomain || out.company });
                if (logo && logo.url) out.logo = logo.url;
            } catch (e) { /* a missing logo is not a failed read */ }
        }
        res.json({ ok: true, ...out });
    } catch (err) {
        console.error('[trips] screenshot read failed:', err.message);
        res.status(500).json({ ok: false, error: 'read_failed', message: 'That screenshot could not be read.' });
    }
});

router.post('/api/trips/board', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    try {
        res.json({ ok: true, holiday: qTripBoard.save(req.body || {}, req.person.email) });
    } catch (e) {
        res.status(400).json({ ok: false, error: 'save_failed', message: e.message });
    }
});

router.patch('/api/trips/board/:id', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    const out = qTripBoard.update(req.params.id, req.body || {}, req.person.email);
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, holiday: out });
});

router.delete('/api/trips/board/:id', requirePerson, (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    if (!qTripBoard.remove(req.params.id, req.person.email)) {
        return res.status(404).json({ ok: false, error: 'not_found' });
    }
    res.json({ ok: true });
});

// Send the board out. ONE LINK PER PERSON, each addressed to them by name.
//
// Sarah, 21 Aug: "they all have different links that will connect to their
// names". A single link everyone shares works right up until two people are
// called Sam, somebody leaves the name box empty, or a name gets spelled three
// ways over a fortnight — and then she is guessing who can actually do which
// week. A link that was minted FOR someone cannot be got wrong: q-linkmail's
// recordAnswer takes the name off the link and ignores anything typed.
//
// Nobody needs an account. The token in the URL is the whole authority.
router.post('/api/trips/board/share', requirePerson, express.json({ limit: '64kb' }), (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    try {
        const owner = req.person.email;
        const b = req.body || {};
        const wanted = Array.isArray(b.ids) && b.ids.length ? new Set(b.ids) : null;
        const chosen = qTripBoard.list(owner).filter(h => !wanted || wanted.has(h.id));
        if (!chosen.length) {
            return res.status(400).json({ ok: false, error: 'nothing_chosen', message: 'Pick at least one holiday to send.' });
        }

        // Who it goes to. Either people already on her list, or names typed in
        // this once. A person with no name is not a person to send to.
        let people = [];
        if (Array.isArray(b.people) && b.people.length) {
            people = b.people
                .map(p => ({ name: String((p && p.name) || '').trim(), email: String((p && p.email) || '').trim() }))
                .filter(p => p.name);
        } else if (Array.isArray(b.personIds) && b.personIds.length) {
            people = b.personIds.map(id => qPeople.get(id, owner)).filter(Boolean)
                .map(p => ({ id: p.id, name: p.name, email: p.email }));
        }

        const money = (h) => (h.price == null ? '' :
            (h.currency === 'GBP' || !h.currency ? '£' : h.currency + ' ')
            + h.price.toLocaleString('en-GB')
            + (h.priceBasis ? ' ' + h.priceBasis : ''));

        const cards = chosen.map(h => ({
            title: h.title,
            subtitle: [h.place, h.country].filter(Boolean).join(', '),
            image: h.image,
            link: h.link,
            body: [
                h.pros.length ? 'Good: ' + h.pros.join('; ') : '',
                h.cons.length ? 'Not so good: ' + h.cons.join('; ') : '',
            ].filter(Boolean).join('\n'),
            facts: [
                money(h) ? { label: 'Price', value: money(h) } : null,
                h.dates ? { label: 'Dates', value: h.dates } : null,
                h.nights ? { label: 'Nights', value: String(h.nights) } : null,
                h.boardBasis ? { label: 'Board', value: h.boardBasis } : null,
                h.company ? { label: 'With', value: h.company } : null,
                h.rating != null ? { label: 'Rating', value: String(h.rating) } : null,
            ].filter(Boolean),
        }));

        // The two questions that actually decide a holiday, plus room to say
        // anything else. Dates first: it is the one that rules holidays out.
        const dateWindows = [...new Set(chosen.map(h => h.dates).filter(Boolean))];
        const questions = [
            dateWindows.length
                ? { text: 'Which of these dates could you do?', type: 'dates', options: dateWindows }
                : { text: 'Which dates could you do?', type: 'text', options: [] },
            { text: 'Which of these would you go on?', type: 'checklist', options: chosen.map(h => h.title) },
            { text: 'Anything else we should know?', type: 'text', options: [] },
        ];

        const base = {
            kind: 'trip',
            title: b.title || 'Where shall we go?',
            body: b.body || '',
            greeting: b.greeting || '',
            expiresHours: b.expiresHours,
            chatEnabled: b.chatEnabled !== false,
            cards,
            questions,
            senderName: req.person.name || req.person.email,
            refId: 'trip-board',
        };

        // No people named: one open link, as before. Whoever opens it types
        // their own name, and that still works — it is just less certain.
        const targets = people.length ? people : [{ name: '', email: '' }];
        const links = targets.map(p => {
            const made = qLinkmail.createLink(owner, { ...base, recipientName: p.name });
            return {
                personId: p.id || null,
                name: p.name,
                email: p.email || '',
                token: made.token,
                fullUrl: linkmailUrl(req, made.token),
            };
        });

        // Every holiday remembers ALL the links it went out on, so an answer
        // from any of them can be read back onto the card.
        for (const h of chosen) {
            const tokens = [...new Set([...(h.linkmailTokens || []), ...links.map(l => l.token)])];
            qTripBoard.update(h.id, { linkmailTokens: tokens, linkmailToken: tokens[tokens.length - 1] }, owner);
        }

        res.json({ ok: true, links, sent: chosen.length, people: links.length });
    } catch (e) {
        res.status(400).json({ ok: false, error: 'share_failed', message: e.message });
    }
});

// Who she sends things to, and who lives with her. The same list feeds the
// per-person checklists.
router.get('/api/people', requirePerson, (req, res) => {
    res.json({ ok: true, people: qPeople.list(req.person.email) });
});

router.post('/api/people', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    try { res.json({ ok: true, person: qPeople.add(req.body || {}, req.person.email) }); }
    catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.patch('/api/people/:id', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    const out = qPeople.update(req.params.id, req.body || {}, req.person.email);
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, person: out });
});

router.delete('/api/people/:id', requirePerson, (req, res) => {
    if (!qPeople.remove(req.params.id, req.person.email)) {
        return res.status(404).json({ ok: false, error: 'not_found' });
    }
    res.json({ ok: true });
});

// What everyone has said back. Each person has their OWN link, so an answer
// arrives already attached to a name — nothing is attributed by guesswork.
//
// The silence matters as much as the answers: a person who has not opened
// their link yet is the reason a decision is still waiting, and that is
// invisible unless it is said out loud. So everyone who was sent a link
// appears here, answered or not.
router.get('/api/trips/board/replies', requirePerson, (req, res) => {
    if (!qTripBoard) return boardUnavailable(res);
    const owner = req.person.email;
    const out = {};
    const tokens = new Set();
    for (const h of qTripBoard.list(owner)) {
        for (const t of (h.linkmailTokens || [])) tokens.add(t);
        if (h.linkmailToken) tokens.add(h.linkmailToken);
    }
    for (const token of tokens) {
        const rec = qLinkmail.readLink(owner, token);
        if (!rec) continue;
        out[token] = {
            who: rec.recipientName || '',
            // Answering is proof of opening. Counting only page views showed
            // "not opened yet" directly above that person's own answer.
            opened: (rec.views || 0) > 0 || !!(rec.answers && rec.answers.length),
            views: rec.views || 0,
            lastViewedAt: rec.lastViewedAt || null,
            revoked: !!rec.revoked,
            answers: (rec.answers || []).map(a => ({
                who: a.name || rec.recipientName || '',
                question: a.question,
                said: a.summary || '',
                at: a.at || null,
            })),
            // Anything they typed at Q on the link, which is where "I don't
            // like the location" actually tends to get said.
            said: (rec.chat || []).filter(m => m.role === 'user').slice(-12).map(m => m.content),
        };
    }
    res.json({ ok: true, replies: out });
});

// ─────────────────────────────────────────────────────────────
//  LINKMAIL — the public, token-gated share link
// ─────────────────────────────────────────────────────────────
// "Quotem linkmail" is a proper noun (Sarah, 20 May 2026). Never rename it to
// "share link" or "magic link". Same engine as QB2 has in the Quotem app: Q
// mints a link, the recipient opens it with NO account, reads the cards,
// answers the questions, and may talk to a Q that knows ONLY what is on that
// card. The sender reads the answers back on their own page.
//
// THE PATH SPLIT IS THE SECURITY. Everything the recipient touches lives under
// /api/linkmail/open/, and only that prefix is in the public allowlist in
// server/index.js. The sender's endpoints are under /api/linkmail/mine/ and
// need a session. Sharing one prefix would have put "list all my links" one
// typo away from being public.
// Guarded for the same reason the trips engine above is: while a plugin file
// is still untracked, ANY chat that commits routes.js ships a require of a
// module the deploy does not have — and an unguarded one takes down every route
// in this file, not just its own. That happened tonight (4436b60). It does not
// get to happen twice.
let qLinkmail = null;
try {
    qLinkmail = require('./plugins/q-linkmail');
} catch (err) {
    console.error('[linkmail] engine not loaded — /linkmail/* will answer 503:', err.message);
}
const linkmailUnavailable = (res) => res.status(503).json({
    ok: false, error: 'linkmail_engine_missing',
    message: 'Linkmail is not available on this deployment.',
});

// The full link, built from the request host the same way the QR routes at the
// top of this file do it — so it is right whichever address the app is open at.
function linkmailUrl(req, token) {
    const host = req.headers.host || 'www.quotem-ai.co.uk';
    const proto = /^localhost|^127\.|^\[?::1/.test(host) ? 'http' : 'https';
    return `${proto}://${host}/linkmail/${token}`;
}

function linkmailEscapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

router.get('/linkmail/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'linkmail.html'), (err) => {
        if (err && !res.headersSent) res.status(503).send('This page is not available on this deployment.');
    });
});

// ── RECIPIENT SIDE — the token is the whole authority ──────────
router.get('/api/linkmail/open/:token', (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    const out = qLinkmail.resolvePublic(req.params.token, { countView: true });
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 410).json(out);
    res.json(out);
});

router.post('/api/linkmail/open/:token/answer', express.json({ limit: '32kb' }), (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    const out = qLinkmail.recordAnswer(req.params.token, req.body || {});
    if (out.error) {
        const code = out.error === 'not_found' ? 404 : (out.error === 'no_such_question' ? 400 : 410);
        return res.status(code).json(out);
    }
    res.json(out);
});

// A public endpoint that calls the model is the obvious way to run up a bill on
// someone else's account, so a link answers twelve questions a minute and no
// more. Per token, in memory — a restart forgives, which is the right trade for
// a limiter whose job is stopping a runaway, not policing people.
const linkmailChatHits = new Map();
function linkmailChatAllowed(token) {
    const now = Date.now();
    const hits = (linkmailChatHits.get(token) || []).filter(t => now - t < 60000);
    if (hits.length >= 12) { linkmailChatHits.set(token, hits); return false; }
    hits.push(now);
    linkmailChatHits.set(token, hits);
    if (linkmailChatHits.size > 500) {
        for (const [k, v] of linkmailChatHits) {
            if (!v.some(t => now - t < 60000)) linkmailChatHits.delete(k);
        }
    }
    return true;
}

router.post('/api/linkmail/open/:token/chat', express.json({ limit: '32kb' }), async (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    try {
        const ctx = qLinkmail.publicContext(req.params.token);
        if (!ctx) return res.status(404).json({ reply: null, error: 'not_found' });
        if (!ctx.chatEnabled) {
            return res.status(403).json({ reply: null, error: 'chat_disabled', message: 'This link is read-only.' });
        }
        const message = String((req.body && req.body.message) || '').slice(0, 2000).trim();
        if (!message) return res.status(400).json({ reply: null, error: 'empty' });
        if (!linkmailChatAllowed(req.params.token)) {
            return res.status(429).json({ reply: null, error: 'too_fast', message: 'One moment — that is a lot of questions at once.' });
        }

        const who = ctx.recipientName ? ctx.recipientName : 'the person reading this';
        // systemOverride (q-chat.js) — a public reader must never be given Q's
        // persona block, his surface prompts, or the account holder's remembered
        // facts. He knows the snapshot and nothing else.
        const system = [
            `You are Q, answering on behalf of ${ctx.senderName}, who has shared this page with ${who}.`,
            '',
            'THE ONLY THING YOU KNOW is what is written between the markers below. It is',
            'exactly what the reader can see on their own screen.',
            '',
            '--- WHAT WAS SHARED ---',
            ctx.title ? ('# ' + ctx.title) : '',
            ctx.snapshot || '(nothing)',
            '--- END ---',
            '',
            ctx.questions.length
                ? ('You are also collecting answers to these: ' + ctx.questions.map((q, i) => (i + 1) + '. ' + q).join('   '))
                : '',
            '',
            'RULES, and they are absolute:',
            `- If the answer is not above, say plainly that you do not know and that ${ctx.senderName} would have to say. NEVER guess a price, a date, a temperature or any other fact.`,
            `- You know nothing about ${ctx.senderName} beyond what is above — no other work, no other people, no other links.`,
            '- Do not invent, estimate or round anything that looks like data.',
            '- Short, warm, plain English. Two or three sentences unless they ask for more.',
            '- You cannot change this page or send anything anywhere. If they want something changed, tell them to put it in an answer or say it here, and it will be passed on.',
        ].join('\n');

        const history = (ctx.chat || []).slice(-12).map(m => ({ role: m.role, content: m.content }));
        const result = await chat([...history, { role: 'user', content: message }], {
            systemOverride: system,
            useTools: false,
        });

        qLinkmail.appendPublicChat(req.params.token, 'user', message);
        if (result.reply) qLinkmail.appendPublicChat(req.params.token, 'assistant', result.reply);
        res.json({ reply: result.reply || null, error: result.error || null });
    } catch (err) {
        console.error('[linkmail] public chat failed:', err.message);
        res.status(500).json({ reply: null, error: 'chat_failed' });
    }
});

// ── SENDER SIDE — session required ─────────────────────────────
router.post('/api/linkmail/mine', requirePerson, express.json({ limit: '256kb' }), (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    try {
        const b = req.body || {};
        const made = qLinkmail.createLink(req.person.email, {
            kind: b.kind,
            title: b.title,
            body: b.body,
            cards: b.cards,
            questions: b.questions,
            greeting: b.greeting,
            recipientName: b.recipientName,
            expiresHours: b.expiresHours,
            chatEnabled: b.chatEnabled,
            snapshot: b.snapshot,
            refId: b.refId,
            senderName: req.person.name || req.person.email,
        });
        res.json({ token: made.token, url: made.url, fullUrl: linkmailUrl(req, made.token) });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/api/linkmail/mine', requirePerson, (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    const links = qLinkmail.listLinks(req.person.email)
        .map(l => Object.assign({}, l, { fullUrl: linkmailUrl(req, l.token) }));
    res.json({ links });
});

router.get('/api/linkmail/mine/:token', requirePerson, (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    const rec = qLinkmail.readLink(req.person.email, req.params.token);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json(Object.assign({}, rec, { fullUrl: linkmailUrl(req, rec.token) }));
});

router.post('/api/linkmail/mine/:token/revoke', requirePerson, (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    const out = qLinkmail.revokeLink(req.person.email, req.params.token);
    if (out.error) return res.status(404).json(out);
    res.json(out);
});

// Email the link out. The link IS the payload — none of the shared content is
// repeated in the mail body, so a forwarded email leaks nothing the link did
// not already carry.
router.post('/api/linkmail/mine/:token/send', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    if (!qLinkmail) return linkmailUnavailable(res);
    try {
        const rec = qLinkmail.readLink(req.person.email, req.params.token);
        if (!rec) return res.status(404).json({ error: 'not_found' });
        // ONE LINK, EVERYONE ON IT. This used to validate only the FIRST
        // address and hand the whole raw string to the mailer — so "mum@x.com,
        // deana@y,com" reported success and the second person never heard
        // about the holiday. Every address is checked, and a bad one is named
        // rather than swallowed.
        const raw = String((req.body && req.body.to) || '').trim();
        const addresses = raw.split(/[,;]/).map(a => a.trim()).filter(Boolean);
        const RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        const bad = addresses.filter(a => !RE.test(a));
        if (!addresses.length) {
            return res.status(400).json({ error: 'bad_address', message: 'Who should it go to?' });
        }
        if (bad.length) {
            return res.status(400).json({
                error: 'bad_address',
                message: bad.length === 1
                    ? `"${bad[0]}" does not look like an email address — nothing was sent.`
                    : `These do not look like email addresses — nothing was sent: ${bad.join(', ')}`,
            });
        }
        if (addresses.length > 20) {
            return res.status(400).json({ error: 'too_many', message: 'That is more than 20 people. Send it in two goes.' });
        }
        if (!mailerConfigured()) {
            return res.status(503).json({ error: 'mailer_off', message: 'Email is not set up on this deployment — copy the link and send it yourself.' });
        }
        const url = linkmailUrl(req, rec.token);
        const subject = String((req.body && req.body.subject) || '').trim()
            || `${rec.senderName} shared "${rec.display.title}" with you`;
        const note = String((req.body && req.body.note) || '').trim() || rec.greeting;
        // ONE MAIL EACH, not one mail addressed to everybody. Handing the
        // array straight to the mailer puts every address in the same To:
        // header, so one relative would get another's email address along
        // with the holiday. This is family, not a mailing list.
        const mail = {
            subject,
            text: `${note}\n\n${url}\n\nNo sign-in needed — the link is the key.`,
            html: `<p>${linkmailEscapeHtml(note)}</p>`
                + `<p><a href="${url}">${linkmailEscapeHtml(rec.display.title || 'Open it here')}</a></p>`
                + `<p style="color:#666;font-size:13px">No sign-in needed &mdash; the link is the key.</p>`,
        };
        const sent = [], failed = [];
        for (const address of addresses) {
            try { await sendMail({ to: address, ...mail }); sent.push(address); }
            catch (err) {
                console.error('[linkmail] send to ' + address + ' failed:', err.message);
                failed.push(address);
            }
        }
        // Say what actually happened. Reporting "sent" when two of three
        // bounced is the kind of small lie that loses somebody their place.
        if (!sent.length) {
            return res.status(502).json({
                error: 'send_failed', to: [], failed,
                message: 'None of those sent. Copy the link and send it yourself.',
            });
        }
        res.json({
            ok: true, to: sent, failed, url,
            message: failed.length ? ('Could not send to ' + failed.join(', ') + '.') : '',
        });
    } catch (e) {
        console.error('[linkmail] send failed:', e.message);
        res.status(500).json({ error: 'send_failed', message: e.message });
    }
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

router.get('/email/outlook/start', requirePerson, (req, res) => {
    if (!qEmail.outlookConfigured()) {
        return res.status(503).json({ error: 'Outlook isn\'t set up on the server yet (missing Microsoft OAuth credentials).' });
    }
    res.json({ url: qEmail.outlookConsentUrl(req.person.email) });
});

// Microsoft redirects here — NO requirePerson (identity rides the signed state).
router.get('/email/outlook/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/email-writer?email=denied');
    if (!code || !state) return res.redirect('/email-writer?email=error');
    try {
        await qEmail.handleOutlookCallback(code, state);
        return res.redirect('/email-writer?email=connected');
    } catch (e) {
        console.error('[email] outlook callback:', e.message);
        const q = e.message === 'no_refresh_token' ? 'noaccess' : (e.message === 'bad_state' ? 'badstate' : 'error');
        return res.redirect('/email-writer?email=' + q);
    }
});

// Disconnect the send account (Gmail or SMTP). For Gmail this also revokes
// the token at Google, so this server can no longer act as that address.
router.post('/email/disconnect', requirePerson, async (req, res) => {
    try { await qEmail.disconnect(req.person.email); }
    catch (e) { console.warn('[email] disconnect:', e.message); }
    res.json({ ok: true });
});

// TTS — read email text aloud in a clear formal voice (Gemini TTS, "Charon" voice).
// Returns audio/wav. Falls back to 503 so the client can use the browser's Speech API instead.
router.post('/api/tts-email', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 5000);
    if (!text) return res.status(400).json({ error: 'No text provided.' });
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(503).json({ error: 'tts_unavailable' });
    const ttsStarted = Date.now();
    try {
        const gr = await timedFetch(
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
            },
            { label: 'text-to-speech', timeoutMs: 90_000 }
        );
        if (!gr.ok) {
            logUsage({ skill: 'tts-email', provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', started: ttsStarted, user: req.person?.id, success: false, error: `HTTP ${gr.status}` });
            console.error('[tts-email] Gemini error:', (await gr.text()).slice(0, 300));
            return res.status(502).json({ error: 'tts_failed' });
        }
        const data = await gr.json();
        logUsage({ skill: 'tts-email', provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', data, started: ttsStarted, user: req.person?.id });
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
    if (req.body.to !== undefined) patch.to = String(req.body.to || '').trim();
    if (req.body.body !== undefined) patch.body = String(req.body.body || '');
    if (req.body.subject !== undefined) patch.subject = String(req.body.subject || '');
    if (Array.isArray(req.body.attachments)) patch.attachments = req.body.attachments;
    const ok = qEmail.patchOutboxItem(req.person.email, req.params.id, patch);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// ── Inbox (read-only, fetched LIVE on demand — no background poller) ───────
// Gmail via the Gmail API, Outlook via Microsoft Graph (both reuse the send
// token), anything else via IMAP. All three return identical shapes.
// Friendly provider name for inbox error messages.
function inboxProviderName(send) { return (send && send.provider === 'outlook') ? 'Outlook' : 'Gmail'; }
router.get('/email/inbox/status', requirePerson, (req, res) => {
    res.json(qEmail.inboxStatus(req.person.email));
});
// Connect an inbox for READING via IMAP + app password (independent of the
// send connection). Verifies sign-in before storing anything.
router.post('/email/imap', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { host, port, user, pass, email } = req.body || {};
    if (!host || !user || !pass) return res.status(400).json({ error: 'Mail server, address and app password are all required.' });
    try {
        const addr = await qEmail.connectInbox(req.person.email, { address: email, host, port, user, pass });
        res.json({ ok: true, email: addr });
    } catch (e) {
        console.warn('[inbox] connect verify failed:', e.message);
        res.status(400).json({ error: 'Could not sign in to that inbox — check the address, server and app password (and that IMAP is switched on for the account).' });
    }
});
router.post('/email/imap/disconnect', requirePerson, (req, res) => {
    qEmail.disconnectInbox(req.person.email);
    res.json({ ok: true });
});
// Live list of recent inbox messages. Reads the connected Gmail (Gmail API)
// or Outlook (Microsoft Graph) reusing the send token; otherwise reads a
// standalone IMAP inbox. Any failure surfaces here — nothing fails silently.
router.get('/email/inbox', requirePerson, async (req, res) => {
    const send = qEmail.getAccount(req.person.email);
    const label = String(req.query.label || 'INBOX');
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const messages = (send && send.provider === 'gmail')
            ? await qEmail.listGmailInbox(req.person.email, { limit, label })
            : (send && send.provider === 'outlook')
                ? await qEmail.listOutlookInbox(req.person.email, { limit, label })
                : await qEmail.listInbox(req.person.email, { limit });
        res.json({ messages });
    } catch (e) {
        if (e.code === 'inbox_scope_missing') return res.status(403).json({ code: 'scope', error: `Reconnect ${inboxProviderName(send)} to allow reading your inbox — the current connection can only send.` });
        if (e.code === 'inbox_not_connected') return res.status(409).json({ error: 'No inbox connected — connect Gmail (or an inbox) first.' });
        console.error('[inbox] list:', e.message);
        res.status(502).json({ error: 'Could not read your inbox — the connection may need reconnecting.' });
    }
});
// The user's folders/labels for the folder switcher (Gmail's live label list;
// Outlook's fixed well-known folder set; empty for IMAP).
router.get('/email/inbox/labels', requirePerson, async (req, res) => {
    const send = qEmail.getAccount(req.person.email);
    if (send && send.provider === 'outlook') return res.json({ labels: qEmail.listOutlookFolders(req.person.email) });
    if (!send || send.provider !== 'gmail') return res.json({ labels: [] });
    try {
        res.json({ labels: await qEmail.listGmailLabels(req.person.email) });
    } catch (e) {
        if (e.code === 'inbox_scope_missing') return res.status(403).json({ code: 'scope', error: 'Reconnect Gmail to allow reading.' });
        console.error('[inbox] labels:', e.message);
        res.json({ labels: [] });
    }
});
// Full body of one message by id (Gmail/Outlook message id, or IMAP uid).
router.get('/email/inbox/:id', requirePerson, async (req, res) => {
    const send = qEmail.getAccount(req.person.email);
    try {
        const message = (send && send.provider === 'gmail')
            ? await qEmail.readGmailMessage(req.person.email, req.params.id)
            : (send && send.provider === 'outlook')
                ? await qEmail.readOutlookMessage(req.person.email, req.params.id)
                : await qEmail.readInboxMessage(req.person.email, req.params.id);
        res.json({ message });
    } catch (e) {
        if (e.code === 'inbox_scope_missing') return res.status(403).json({ code: 'scope', error: `Reconnect ${inboxProviderName(send)} to allow reading.` });
        if (e.code === 'inbox_not_connected') return res.status(409).json({ error: 'No inbox connected.' });
        if (e.code === 'inbox_message_not_found') return res.status(404).json({ error: 'That message could not be found.' });
        console.error('[inbox] read:', e.message);
        res.status(502).json({ error: 'Could not open that message.' });
    }
});
// Change a message's labels (mark read/unread, star, archive) — Gmail or
// Outlook (Outlook translates the Gmail-style label ids to Graph operations).
router.post('/email/inbox/:id/modify', requirePerson, express.json({ limit: '16kb' }), async (req, res) => {
    const send = qEmail.getAccount(req.person.email);
    if (!send || (send.provider !== 'gmail' && send.provider !== 'outlook')) return res.status(400).json({ error: 'Inbox actions need a connected Gmail or Outlook account.' });
    try {
        const changes = { add: req.body.add || [], remove: req.body.remove || [] };
        if (send.provider === 'outlook') await qEmail.modifyOutlookMessage(req.person.email, req.params.id, changes);
        else await qEmail.modifyGmailMessage(req.person.email, req.params.id, changes);
        res.json({ ok: true });
    } catch (e) {
        if (e.code === 'inbox_scope_missing') return res.status(403).json({ code: 'scope', error: `Reconnect ${inboxProviderName(send)} to manage your inbox (grant the newer permission).` });
        console.error('[inbox] modify:', e.message);
        res.status(502).json({ error: 'Could not update that message.' });
    }
});
// Move a message to Bin — Gmail or Outlook.
router.post('/email/inbox/:id/trash', requirePerson, async (req, res) => {
    const send = qEmail.getAccount(req.person.email);
    if (!send || (send.provider !== 'gmail' && send.provider !== 'outlook')) return res.status(400).json({ error: 'Inbox actions need a connected Gmail or Outlook account.' });
    try {
        if (send.provider === 'outlook') await qEmail.trashOutlookMessage(req.person.email, req.params.id);
        else await qEmail.trashGmailMessage(req.person.email, req.params.id);
        res.json({ ok: true });
    } catch (e) {
        if (e.code === 'inbox_scope_missing') return res.status(403).json({ code: 'scope', error: `Reconnect ${inboxProviderName(send)} to manage your inbox (grant the newer permission).` });
        console.error('[inbox] trash:', e.message);
        res.status(502).json({ error: 'Could not delete that message.' });
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
// Every user-facing string Q writes leaves the writer routes in UK English
// (Sarah, 15 Aug 2026 — "paycheck", "vacation" on a UK CIPD essay). The
// wrapper polishes ONLY Q's own strings (question, hint, explanations,
// criteria text/labels, marking evidence, tool help…) — never the student's
// words / docText / references / ids / urls. See ukPolishResponse.
function ukJson(res, obj) { return res.json(qWriter.ukPolishResponse(obj)); }
// The visible match score for a notebook: how much of the hidden essay is
// voiced (full) / close (half), per criterion + overall.
function matchFor(t) {
    return qWriter.matchScore(t.modelEssay || null, Array.isArray(t.voicedBricks) ? t.voicedBricks : [], Array.isArray(t.closeBricks) ? t.closeBricks : [], t.coverage || {}, t.brief || null);
}

router.post('/writer/analyse', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    try {
        const taskText = (req.body?.taskText || '').toString().trim();
        if (!taskText) return res.status(400).json({ error: 'taskText required' });
        const analysis = await qWriter.analyseTask(taskText);
        ukJson(res, { ok: true, analysis });
    } catch (e) {
        writerFail(res, e, '[writer/analyse]', 'task read');
    }
});

router.post('/writer/next-question', requirePerson, express.json({ limit: '512kb' }), async (req, res) => {
    try {
        const analysis = req.body?.analysis;
        const history = Array.isArray(req.body?.history) ? req.body.history : [];
        if (!analysis) return res.status(400).json({ error: 'analysis required' });
        const next = await qWriter.nextQuestion(analysis, history);
        ukJson(res, { ok: true, ...next });
    } catch (e) {
        writerFail(res, e, '[writer/next-question]', 'next question');
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// WRITER — PHASE 3 (15 Aug 2026): the coach with the answer in his head.
// Shared plumbing for the writer routes below: the tutor notebook (one per
// person, holds the whole session so nothing is lost on refresh / phone lock
// / restart), background jobs (the brief / mark / assemble calls can outlive
// Railway's ~60s edge, so they run server-side and the page polls), and a
// typed 413 so an oversize body never becomes a bare "Server error".
// ═══════════════════════════════════════════════════════════════════════════

// A body over the route's express.json limit throws entity.too.large BEFORE
// the handler runs and skips its try/catch. This turns it into the plain
// sentence the student should read. Mount it right after express.json().
function writerTooLarge(message) {
    return (err, req, res, next) => {
        if (err && err.type === 'entity.too.large') {
            console.warn(`[writer] 413 ${req.method} ${req.path} — body over ${err.limit || '?'} bytes`);
            return res.status(413).json({ error: message, code: 'too_large' });
        }
        if (err) return next(err);
        next();
    };
}

// One failure shape for every writer route: log the raw cause server-side,
// send the student the plain-English one (no vendor names, real status).
function writerFail(res, e, tag, step) {
    const cause = qWriter.userFacingCause(e, step);
    console.error(tag, e && e.message, e && e.primaryCause ? '(first: ' + e.primaryCause + ')' : '');
    res.status(cause.status).json({ ok: false, error: cause.message, code: cause.code, retryable: cause.retryable });
}

// ── Writer PROJECTS (16 Aug 2026): which assignment is this request about? ──
// The page sends `X-Writer-Project` on every /writer call (its open project);
// with no header the person's active project is used; a brand-new person
// lands on 'main' (the legacy per-person files — nothing moved). The scope
// string stands in for personId in every notebook/doc helper below, so one
// person can hold several assignments without them eating each other.
// Voice (/writer/voice) and revision stay per PERSON — they use req.person.id.
function writerProjectId(req) {
    if (req._writerProject) return req._writerProject;
    const want = req.get ? req.get('x-writer-project') : null;
    req._writerProject = resolveWriterProject(req.person.id, want);
    // A write to 'main' registers it, so it shows in the project list.
    if (req.method === 'POST' && req._writerProject === 'main') registerProject(req.person.id, 'main');
    return req._writerProject;
}
function writerScope(req) {
    if (req._writerScope) return req._writerScope;
    req._writerScope = tutorScope(req.person.id, writerProjectId(req));
    return req._writerScope;
}
function registerProject(personId, id, extra) {
    const idx = readTutorIndex(personId);
    if (!idx.projects.some(pr => pr.id === id)) {
        idx.projects.push({ id, createdAt: Date.now(), ...(extra || {}) });
        if (!idx.active) idx.active = id;
        writeTutorIndex(personId, idx);
    }
    return idx;
}
function newProjectId() {
    return 'p' + randomUUID().replace(/-/g, '').slice(0, 10);
}
// What the switcher shows for each project — read from the project's own
// notebook so the name is always the real one (brief title, then the file
// name), never a stale copy.
function projectCard(personId, pr) {
    const t = readTutor(tutorScope(personId, pr.id));
    const brief = t && t.brief;
    const briefTitle = brief && (brief.title || brief.assignmentTitle);
    const name = (pr.name && String(pr.name).trim())
        || (briefTitle && String(briefTitle).trim())
        || (t && t.docTitle && String(t.docTitle).trim())
        || (t && t.sourceName && String(t.sourceName).trim())
        || 'New assignment';
    return {
        id: pr.id, name: name.slice(0, 120), createdAt: pr.createdAt || null, updatedAt: (t && t.updatedAt) || null,
        hasBrief: !!brief, parts: brief && Array.isArray(brief.criteria) ? brief.criteria.length : 0,
        words: t && typeof t.docText === 'string' ? t.docText.trim().split(/\s+/).filter(Boolean).length : 0,
        sourceName: (t && t.sourceName) || null,
    };
}
function projectsView(personId) {
    const idx = readTutorIndex(personId);
    const live = idx.projects.filter(pr => !pr.archived);
    return { active: resolveWriterProject(personId, null), projects: live.map(pr => projectCard(personId, pr)) };
}
function projectsErr(res, e, what) {
    res.status(500).json({ ok: false, error: what + ': ' + String((e && e.message) || '').slice(0, 160) });
}

// GET /writer/projects — the person's assignments and which one is open.
router.get('/writer/projects', requirePerson, (req, res) => {
    try { res.json({ ok: true, ...projectsView(req.person.id) }); }
    catch (e) { projectsErr(res, e, 'Could not list your assignments'); }
});
// POST /writer/projects — start a new, empty assignment and open it.
router.post('/writer/projects', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    try {
        const id = newProjectId();
        const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
        registerProject(req.person.id, id, name ? { name } : undefined);
        const idx = readTutorIndex(req.person.id); idx.active = id; writeTutorIndex(req.person.id, idx);
        res.json({ ok: true, id, ...projectsView(req.person.id) });
    } catch (e) { projectsErr(res, e, 'Could not start a new assignment'); }
});
// POST /writer/projects/demo — "Introduction to the Writer": the pre-saved
// demo project Q walks a new person round (Sarah, 19 Aug). One per person —
// opened if it exists, written from plugins/writer-demo.js if not. No model
// call: the page, the reference and (when the template has one) the mark are
// all stored. Returns { id, fresh } + the projects view; the page opens it and
// starts the tour there.
router.post('/writer/projects/demo', requirePerson, express.json({ limit: '2kb' }), (req, res) => {
    try {
        const demo = require('./plugins/writer-demo');
        const idx = readTutorIndex(req.person.id);
        let pr = idx.projects.find(p => p && p.demo && !p.archived);
        let fresh = false;
        if (!pr) {
            const id = newProjectId();
            registerProject(req.person.id, id, { name: demo.DEMO_NAME, demo: true });
            const scope = tutorScope(req.person.id, id);
            writeTutor(scope, demo.buildDemoTutor());
            try { fs.writeFileSync(getDocPath(scope), JSON.stringify({ text: demo.DEMO_TASK, name: 'Introduction to the Writer.md', savedAt: Date.now() })); } catch (e) { console.warn('[writer/demo] doc store failed:', e.message); }
            pr = { id }; fresh = true;
        }
        const idx2 = readTutorIndex(req.person.id); idx2.active = pr.id; writeTutorIndex(req.person.id, idx2);
        res.json({ ok: true, id: pr.id, fresh, ...projectsView(req.person.id) });
    } catch (e) { projectsErr(res, e, 'Could not open the introduction'); }
});
// POST /writer/projects/open {id} — make it the active one (what the page shows).
router.post('/writer/projects/open', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    try {
        const id = String((req.body && req.body.id) || '').trim();
        if (!PROJECT_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Which assignment? That id is not one of yours.' });
        const idx = readTutorIndex(req.person.id);
        if (id !== 'main' && !idx.projects.some(pr => pr.id === id && !pr.archived)) return res.status(404).json({ ok: false, error: 'That assignment is not in your list.' });
        if (id === 'main') registerProject(req.person.id, 'main');
        const idx2 = readTutorIndex(req.person.id); idx2.active = id; writeTutorIndex(req.person.id, idx2);
        res.json({ ok: true, ...projectsView(req.person.id) });
    } catch (e) { projectsErr(res, e, 'Could not open that assignment'); }
});
// POST /writer/projects/rename {id, name}
router.post('/writer/projects/rename', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    try {
        const id = String((req.body && req.body.id) || '').trim();
        const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
        if (!PROJECT_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Which assignment? That id is not one of yours.' });
        const idx = readTutorIndex(req.person.id);
        const pr = idx.projects.find(x => x.id === id && !x.archived);
        if (!pr) return res.status(404).json({ ok: false, error: 'That assignment is not in your list.' });
        if (name) pr.name = name; else delete pr.name;
        writeTutorIndex(req.person.id, idx);
        res.json({ ok: true, ...projectsView(req.person.id) });
    } catch (e) { projectsErr(res, e, 'Could not rename that assignment'); }
});
// POST /writer/projects/remove {id} — takes it off the list. The files stay
// on disk (nothing of theirs is ever deleted by a click); it just stops
// showing. If it was open, the most recent other one opens.
router.post('/writer/projects/remove', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    try {
        const id = String((req.body && req.body.id) || '').trim();
        if (!PROJECT_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Which assignment? That id is not one of yours.' });
        const idx = readTutorIndex(req.person.id);
        const pr = idx.projects.find(x => x.id === id && !x.archived);
        if (!pr) return res.status(404).json({ ok: false, error: 'That assignment is not in your list.' });
        pr.archived = Date.now();
        if (idx.active === id) {
            const rest = idx.projects.filter(x => !x.archived);
            rest.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            idx.active = rest[0] ? rest[0].id : null;
        }
        writeTutorIndex(req.person.id, idx);
        // Nothing may keep serving the removed one by accident.
        for (const kind of ['brief', 'essay', 'plan', 'assemble', 'mark']) writerJobs.delete(writerJobKey(tutorScope(req.person.id, id), kind));
        for (const k of [...writerJobs.keys()]) if (k.startsWith(tutorScope(req.person.id, id) + ':mark-part:')) writerJobs.delete(k);
        res.json({ ok: true, ...projectsView(req.person.id) });
    } catch (e) { projectsErr(res, e, 'Could not remove that assignment'); }
});

// The tutor notebook. Merge-write: only the keys sent are changed.
function readTutor(personId) {
    try {
        const p = getTutorPath(personId);
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch (_) { return {}; }
}
function writeTutor(personId, patch) {
    const merged = { ...readTutor(personId), ...patch, updatedAt: Date.now() };
    fs.writeFileSync(getTutorPath(personId), JSON.stringify(merged));
    return merged;
}
// The skeleton is the answer in Q's head — it lives server-side only. The
// page gets everything else.
function publicBrief(brief) {
    if (!brief || typeof brief !== 'object') return null;
    const { idealAnswerSkeleton, ...rest } = brief;
    // Word budgets per question are arithmetic on the brief; a brief stored
    // before they existed gets them filled in on the way out, so Sarah's live
    // session shows them without a re-upload.
    if (Array.isArray(rest.criteria) && rest.criteria.length && !rest.criteria.some(c => c && c.wordBudget)) {
        try {
            const re = qWriter.normaliseBrief({ ...rest, idealAnswerSkeleton: [] });
            const byId = Object.fromEntries((re.criteria || []).map(c => [c.id, c.wordBudget]));
            rest.criteria = rest.criteria.map(c => byId[c.id] ? { ...c, wordBudget: byId[c.id] } : c);
        } catch (_) { /* leave it as it was */ }
    }
    return rest;
}
function sourcesMeta(sources) {
    // The digest rides along: the plain-words version she reads INSTEAD of
    // the document (Sarah, 16 Aug: "I need to be able to do this without
    // reading it"). null until the digest job lands.
    return (Array.isArray(sources) ? sources : []).map(s => ({ name: s.name, chars: (s.text || '').length, addedAt: s.addedAt || null, digest: s.digest || null }));
}
// One small call per source, in the background, stored ON the source so a
// refresh keeps it. Never blocks the upload; a failure leaves digest null and
// the page offers a retry.
async function digestSourceInBackground(personId, name) {
    try {
        const t = readTutor(personId);
        const src = (t.sources || []).find(s => s.name === name);
        if (!src || src.digest) return;
        const digest = await qWriter.digestSource({ name, text: src.text, brief: t.brief || null });
        // A blank digest is not a digest: leave it null so the retry works.
        if (emptyDigest(digest)) { console.warn('[writer/source digest] ' + name + ': came back empty, not stored'); return; }
        const t2 = readTutor(personId);
        const next = (t2.sources || []).map(s => s.name === name ? { ...s, digest } : s);
        writeTutor(personId, { sources: next });
    } catch (e) {
        console.warn('[writer/source digest] ' + name + ': ' + (e && e.message));
    }
}
// A digest with no story and no "what it is" has nothing she can read.
function emptyDigest(d) { return !d || !(String(d.theStory || '').trim() || String(d.whatItIs || '').trim()); }
function readStoredDocText(personId) {
    try {
        const docPath = getDocPath(personId);
        if (!fs.existsSync(docPath)) return null;
        const stored = JSON.parse(fs.readFileSync(docPath, 'utf8'));
        return stored && stored.text ? { text: stored.text, name: stored.name || 'document' } : null;
    } catch (_) { return null; }
}

// Background jobs — one per person per kind. `result` is also persisted to
// the notebook by the caller, so a Railway restart mid-poll loses the
// in-flight job but never a finished one.
const writerJobs = new Map();
const WRITER_JOB_STEP = { brief: 'brief step', essay: 'model answer', mark: 'marking', 'mark-part': 'marking this question', assemble: 'assembly', edit: 'editing pass', plan: 'part plan' };
const SOURCE_MAX = 6, SOURCE_CHARS = 80000, SOURCE_TOTAL = 300000;

// The hidden model essay is written server-side after the brief lands (and
// again when a supporting document is added). Never returned to the page —
// only brick COUNTS per criterion, so the strip can say "2 of 5 voiced".
function startEssayJob(personId) {
    return startWriterJob(personId, 'essay', async () => {
        const t = readTutor(personId);
        if (!t.brief) throw new Error('No brief yet — upload the task first.');
        const essay = await qWriter.writeModelEssay({ brief: t.brief, sources: t.sources || [] });
        // Stamped so a plan can say which essay it was built from.
        if (!essay.writtenAt) essay.writtenAt = Date.now();
        const t2 = readTutor(personId);
        // Keep bricks already voiced that still exist in the rewritten essay.
        const ids = new Set(qWriter.allBrickIds(essay).map(b => b.brickId));
        const voiced = (Array.isArray(t2.voicedBricks) ? t2.voicedBricks : []).filter(id => ids.has(id));
        const { coverage, brickCounts } = qWriter.coverageFromBricks(essay, voiced, t2.coverage || {});
        const t3 = writeTutor(personId, { modelEssay: essay, voicedBricks: voiced, coverage, brickCounts });
        // The first part's plan follows straight away (one call, cached) so
        // the page finds it ready — or running — when it asks.
        const firstId = t3.brief && t3.brief.criteria && t3.brief.criteria[0] ? t3.brief.criteria[0].id : null;
        if (firstId && !(t3.plans && t3.plans[firstId])) startPlanJob(personId, firstId);
        return { essayReady: true, brickCounts, coverage, bricks: ids.size, notes: essay.notes, match: matchFor(t3) };
    });
}
// The essay job can vanish (restart mid-write) leaving a brief with no
// answer behind it and nothing running — the page then waits for ever. If
// there is nothing running (and no failure in the last minute, so a broken
// key cannot be re-tried on every poll) start it again.
function ensureEssayJob(personId, t) {
    if (!t || !t.brief || t.modelEssay) return null;
    const ej = writerJobs.get(writerJobKey(personId, 'essay'));
    if (ej && ej.status === 'running') return ej;
    if (ej && ej.status === 'failed' && Date.now() - (ej.finishedAt || 0) < 60 * 1000) return ej;
    return startEssayJob(personId);
}
// The PART PLAN (Sarah, 15 Aug late — scaffolded coaching): one plan per
// criterion, from the hidden essay's bricks, cached in the notebook under
// plans[criterionId]. Only ever made once per part unless force'd.
function startPlanJob(personId, criterionId, { wordsTried } = {}) {
    const t0 = readTutor(personId);
    writeTutor(personId, { planWanted: criterionId });
    return startWriterJob(personId, 'plan', async () => {
        const t = readTutor(personId);
        if (!t.brief) throw new Error('No brief yet — upload the task first.');
        if (!t.modelEssay) throw new Error('The model answer for this part is not written yet — a moment.');
        const plan = await qWriter.planPart({ brief: t.brief, essay: t.modelEssay, criterionId, yearGroup: t.yearGroup || '', relateAnchor: t.relateAnchor || '' });
        // Which essay this plan was built from — a newer essay makes it stale.
        plan.essayAt = t.modelEssay.writtenAt || null;
        // A wordless plan gets ONE rebuild for its word board, not one per load.
        if (wordsTried) plan.wordsTried = true;
        const t2 = readTutor(personId);
        const plans = { ...(t2.plans || {}), [criterionId]: plan };
        writeTutor(personId, { plans });
        return plan;
    }, { criterionId });
}
function stepOf(t, criterionId, stepId) {
    const plan = t.plans && t.plans[criterionId];
    const step = plan && Array.isArray(plan.steps) ? plan.steps.find(s => s.id === stepId) : null;
    return { plan: plan || null, step: step || null };
}
// Expectations met → the notebook (termsFit / reqMet per part). `replace`
// = the marker's honest read (the mark); otherwise union (a check).
function noteExpectations(personId, criterionId, termsUsed, requirementsMet, { replace } = {}) {
    if (!criterionId) return null;
    const t = readTutor(personId);
    const tf = { ...(t.termsFit || {}) }, rm = { ...(t.reqMet || {}) };
    tf[criterionId] = Array.from(new Set([...(replace ? [] : (tf[criterionId] || [])), ...(termsUsed || [])]));
    rm[criterionId] = Array.from(new Set([...(replace ? [] : (rm[criterionId] || [])), ...(requirementsMet || [])]));
    writeTutor(personId, { termsFit: tf, reqMet: rm });
    return { termsFit: tf, reqMet: rm };
}
// Bricks voiced → coverage / counts / match, written to the notebook.
function voiceBricks(personId, brickIds) {
    const t = readTutor(personId);
    const voiced = Array.from(new Set([...(Array.isArray(t.voicedBricks) ? t.voicedBricks : []), ...(brickIds || [])]));
    let coverage = { ...(t.coverage || {}) }, brickCounts = t.brickCounts || {};
    if (t.modelEssay) ({ coverage, brickCounts } = qWriter.coverageFromBricks(t.modelEssay, voiced, coverage));
    const t2 = writeTutor(personId, { voicedBricks: voiced, coverage, brickCounts });
    return { coverage, brickCounts, match: matchFor(t2), voicedBricks: voiced };
}
function writerJobKey(personId, kind) { return `${personId}:${kind}`; }
function startWriterJob(personId, kind, run, meta) {
    // meta.keySuffix: one job per ITEM of a kind (mark-part is per question).
    const key = writerJobKey(personId, kind + (meta && meta.keySuffix ? ':' + meta.keySuffix : ''));
    const existing = writerJobs.get(key);
    if (existing && existing.status === 'running') return existing;
    const job = { kind, status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null, meta: meta || null };
    writerJobs.set(key, job);
    Promise.resolve().then(run).then((result) => {
        job.status = 'done'; job.result = result; job.finishedAt = Date.now();
        console.log(`[writer/${kind}] done in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`);
    }).catch((e) => {
        job.status = 'failed'; job.finishedAt = Date.now();
        job.error = qWriter.userFacingCause(e, WRITER_JOB_STEP[kind] || kind);
        console.error(`[writer/${kind}] failed after ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s: ${e && e.message}${e && e.primaryCause ? ' (first: ' + e.primaryCause + ')' : ''}`);
    });
    // Forget finished jobs after half an hour — the notebook holds the result.
    setTimeout(() => { if (writerJobs.get(key) === job && job.status !== 'running') writerJobs.delete(key); }, 30 * 60 * 1000).unref();
    return job;
}
function jobView(job) {
    if (!job) return null;
    return {
        kind: job.kind, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, meta: job.meta || null,
        elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
        error: job.error || null,
        result: job.status === 'done' ? job.result : null,
    };
}

// GET /writer/job/:kind — poll a brief / mark / assemble job. If there is no
// live job (restart, or the page came back later) the notebook's saved
// result is returned as done, so a refresh mid-brief still lands the brief.
router.get('/writer/job/:kind', requirePerson, (req, res) => {
    const kind = String(req.params.kind || '');
    if (!WRITER_JOB_STEP[kind]) return res.status(404).json({ error: 'Unknown job kind.' });
    // mark-part jobs are keyed per question (mark-part:<criterionId>); with
    // ?criterionId= that one, without it the most recent live one for this scope.
    const partQ = String(req.query.criterionId || '').replace(/\s+/g, '');
    const job = kind === 'mark-part'
        ? (partQ ? writerJobs.get(writerJobKey(writerScope(req), 'mark-part:' + partQ))
            : [...writerJobs.entries()].filter(([k]) => k.startsWith(writerScope(req) + ':mark-part:')).map(([, j]) => j).sort((a, b) => b.startedAt - a.startedAt)[0])
        : writerJobs.get(writerJobKey(writerScope(req), kind));
    if (job) {
        const view = jobView(job);
        if (kind === 'brief' && view.result) view.result = publicBrief(view.result);
        return ukJson(res, { ok: true, ...view });
    }
    const t = readTutor(writerScope(req));
    // mark-part: the notebook keeps one per question (partMarks[criterionId]);
    // the page says which with ?criterionId= — without it there is nothing to
    // hand back (which question?), so null.
    const saved = kind === 'brief' ? (t.brief ? publicBrief(t.brief) : null)
        : kind === 'mark' ? (t.lastMark || null)
        : kind === 'mark-part' ? (partQ && t.partMarks && t.partMarks[partQ] ? t.partMarks[partQ] : null)
        : kind === 'essay' ? (t.modelEssay ? { essayReady: true, brickCounts: t.brickCounts || {}, coverage: t.coverage || {}, bricks: qWriter.allBrickIds(t.modelEssay).length, notes: t.modelEssay.notes, match: matchFor(t) } : null)
        : kind === 'edit' ? (t.lastEdit || null)
        : kind === 'plan' ? (t.plans && t.planWanted && t.plans[t.planWanted] ? t.plans[t.planWanted] : null)
        : (t.lastAssembly || null);
    if (saved) return ukJson(res, { ok: true, kind, status: 'done', fromNotebook: true, result: saved, error: null });
    return res.json({ ok: true, kind, status: 'none', result: null, error: null });
});

// POST /writer/assemble — THEIR words, HIS structure. Arranges the student's
// draft (+ coach-box answers) under the criteria. Job: poll GET /writer/job/assemble.
router.post('/writer/assemble', requirePerson, express.json({ limit: '2mb' }), writerTooLarge('That draft is too long to assemble in one go (over 2 MB of text). Trim it, or assemble a section at a time.'), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const docText = String(req.body?.docText || t.docText || '');
    const history = Array.isArray(req.body?.history) ? req.body.history : (Array.isArray(t.coachHistory) ? t.coachHistory : []);
    const title = String(req.body?.title || t.docTitle || t.brief.title || '');
    const personId = writerScope(req);
    const job = startWriterJob(personId, 'assemble', async () => {
        const r = await qWriter.assembleFromDraft({ brief: t.brief, docText, history, title });
        writeTutor(personId, { lastAssembly: { ...r, at: Date.now() } });
        return r;
    });
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...jobView(job) }));
    }
    ukJson(res, { ok: true, ...jobView(job) });
});

// POST /writer/mark — mark like the marker: per-criterion band + what the top
// band still needs. Job: poll GET /writer/job/mark.
router.post('/writer/mark', requirePerson, express.json({ limit: '2mb' }), writerTooLarge('That draft is too long to mark in one go (over 2 MB of text).'), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const docText = String(req.body?.docText || t.docText || '');
    if (!docText.trim()) return res.status(400).json({ error: 'There is nothing on the page to mark yet.', code: 'empty' });
    const gradeScheme = String(req.body?.gradeScheme || t.gradeScheme || '');
    const personId = writerScope(req);
    const job = startWriterJob(personId, 'mark', async () => {
        const r = await qWriter.markLikeMarker({ brief: t.brief, essay: t.modelEssay || null, docText, gradeScheme, plans: t.plans || null, taskText: String(t.task || '') });
        // The marker's honest read of terms used / requirements met, per part.
        for (const p of r.perCriterion) noteExpectations(personId, p.criterionId, p.termsUsed, p.requirementsMet, { replace: true });
        let coverage = { ...(t.coverage || {}) };
        for (const p of r.perCriterion) coverage[p.criterionId] = p.band === 'top' || p.band === 'mid' ? 'covered' : p.band === 'low' ? 'partial' : 'none';
        // The mark is the honest read of the page: the voiced-brick tally (and
        // so the visible score) is rebuilt from it — a filled scaffold counted
        // as voiced while coaching; the marker says what the draft really says.
        let brickCounts = t.brickCounts || {};
        let patch = { lastMark: { ...r, at: Date.now() }, coverage };
        if (t.modelEssay) {
            const voiced = Array.from(new Set(r.perCriterion.flatMap(p => p.voicedBrickIds || [])));
            ({ coverage, brickCounts } = qWriter.coverageFromBricks(t.modelEssay, voiced, coverage));
            for (const p of r.perCriterion) coverage[p.criterionId] = p.band === 'top' || p.band === 'mid' ? 'covered' : p.band === 'low' ? 'partial' : 'none';
            patch = { ...patch, voicedBricks: voiced, closeBricks: [], coverage, brickCounts };
        }
        const t2 = writeTutor(personId, patch);
        return { ...r, coverage, brickCounts, match: matchFor(t2), termsFit: t2.termsFit || {}, reqMet: t2.reqMet || {} };
    });
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...jobView(job) }));
    }
    ukJson(res, { ok: true, ...jobView(job) });
});

// POST /writer/chat — a real conversation with Q (17 Aug): { text, history[], docText, criterionId, stepId, ask }.
// Full context server-side (brief, plan, model essay for his own understanding, the stored case text, sources).
// The student's context for Q-as-coach: the brief, the part, the question we
// are on, the page, the case, the sources, the expected words. Compact — Q
// reads it, he does not recite it.
function writerCoachContext({ t, cid, plan, stepId, docText, stored, ask, partWords, stepItems, furniture, board }) {
    const nl2 = String.fromCharCode(10);
    const L = [];
    const brief = t.brief || {};
    const crit = Array.isArray(brief.criteria) ? brief.criteria : [];
    const cur = crit.find(c => c.id === cid) || null;
    L.push('CONTEXT FOR THIS TUTORING CONVERSATION (read, do not recite):');
    if (brief.title) L.push('Assignment: ' + brief.title);
    if (brief.whatItWants) L.push('What it wants: ' + brief.whatItWants);
    if (brief.wordCount) L.push('Word count: ' + brief.wordCount);
    if (t.gradeScheme) L.push('Grade scheme: ' + t.gradeScheme);
    if (crit.length) L.push('The questions (parts):' + nl2 + crit.map((c, i) => '  Q' + (i + 1) + (c.id === cid ? ' (WE ARE ON THIS ONE)' : '') + ': ' + String(c.text || c.label || '').slice(0, 400)).join(nl2));
    const sc = brief.scenario;
    if (sc && (sc.name || sc.theStory)) {
        L.push('The case study: ' + [sc.name, sc.kind].filter(Boolean).join(' — ') + (sc.theStory ? nl2 + '  ' + String(sc.theStory).slice(0, 1200) : ''));
        if (Array.isArray(sc.facts) && sc.facts.length) L.push('  Facts: ' + sc.facts.map(f => f.label + ': ' + f.value).join(' · ').slice(0, 1200));
        if (Array.isArray(sc.sections) && sc.sections.length) L.push(sc.sections.map(x => '  ' + x.heading + ': ' + (x.bullets || []).join('; ')).join(nl2).slice(0, 2400));
    }
    if (Array.isArray(t.sources) && t.sources.length) L.push('Supporting documents: ' + t.sources.map(s => s.name + (s.digest && s.digest.whatItIs ? ' — ' + s.digest.whatItIs : '')).join(' | ').slice(0, 800));
    if (plan && Array.isArray(plan.steps) && plan.steps.length) {
        const st = stepId ? plan.steps.find(s => s.id === stepId) : null;
        L.push('The ladder of questions for this part:' + nl2 + plan.steps.map((s, i) => '  ' + (i + 1) + '. ' + (st && s.id === st.id ? '[NOW] ' : '') + String(s.prompt || '').slice(0, 220)).join(nl2));
        if (Array.isArray(plan.terms) && plan.terms.length) L.push('Words / ideas the marker expects in this part: ' + plan.terms.join(', '));
        if (Array.isArray(plan.requirements) && plan.requirements.length) L.push('Must be in this part: ' + plan.requirements.map(q => q.label || q.kind || '').filter(Boolean).join(', '));
    }
    if (ask) L.push('The question on the card right now: ' + ask);
    if (Array.isArray(stepItems) && stepItems.length) L.push('Their list so far on the whiteboard for the question we are on: ' + stepItems.map(String).join(' · ').slice(0, 1500));
    if (partWords && typeof partWords === 'object' && Object.keys(partWords).length) L.push('Words written per question so far: ' + crit.map((c, i) => 'Q' + (i + 1) + ' ' + (Number(partWords[c.id]) || 0) + (c.wordBudget ? '/' + c.wordBudget : '')).join(' · '));
    const page = String(docText || '').trim();
    // Paragraph numbers, so he can say "paragraph 4, sentence 2" (Q's own ask,
    // 18 Aug). Numbered on his copy only — nothing changes on her page.
    if (page) {
        // Numbering that means what a person means (Sarah, 18 Aug: "its
        // referencing so would that class as a paragraph?"): P# = essay
        // paragraphs only; a heading is named as a heading; after the
        // References heading each entry is R#. The page numbers the same way.
        const blocks = page.split(/\n{2,}|\r?\n/).map(x => x.trim()).filter(Boolean);
        let inRefs = false, pn = 0, rn = 0; const outL = [];
        for (const b of blocks) {
            if (!inRefs && /^(harvard )?(references|reference list|bibliography)\s*:?$/i.test(b)) { inRefs = true; outL.push('[References]'); continue; }
            if (inRefs) {
                if (!/\(\d{4}[a-z]?\)|(19|20)\d{2}|available at|https?:|doi/i.test(b)) { outL.push('[heading — inside the references] ' + b); continue; }
                rn++; outL.push('[R' + rn + '] ' + b); continue;
            }
            const words = b.split(/\s+/).length;
            if (words <= 10 && !/[.!?]$/.test(b)) { outL.push('[heading] ' + b); continue; }
            pn++; outL.push('[P' + pn + '] ' + b);
        }
        const numbered = outL.join(nl2);
        L.push('What is on their page (' + page.split(/\s+/).filter(Boolean).length + ' words; ' + pn + ' essay paragraph' + (pn === 1 ? '' : 's') + ' numbered [P1]…' + (rn ? ', ' + rn + ' references numbered [R1]…' : '') + '; headings are marked; refer to paragraphs by P number and references by R number):' + nl2 + (numbered.length > 9000 ? '…' + numbered.slice(-9000) : numbered));
    }
    else L.push('Their page is empty so far.');
    // WHAT IS ALREADY ON THE PAGE AND THE BOARD — his tabs, highlights and
    // stickies (and hers), so he recognises them as tabs and can change or
    // refer to them (Q's own gap, 18 Aug: 'Q needs to recognise tabs as tabs').
    try {
        const f = furniture && typeof furniture === 'object' ? furniture : null;
        const tabs = f && Array.isArray(f.tabs) ? f.tabs.slice(0, 40) : [];
        const notes = f && Array.isArray(f.notes) ? f.notes.slice(0, 40) : [];
        const stickies = f && Array.isArray(f.stickies) ? f.stickies.slice(0, 20) : [];
        if (tabs.length || notes.length || stickies.length) {
            const FL = ['ALREADY PLACED (yours unless marked "hers"; to change one, call the same tool again for the same place — it replaces):'];
            if (tabs.length) FL.push('Tabs: ' + tabs.map(x => '"' + String(x.label || '') + '" (' + String(x.colour || 'grey') + (x.text ? ', on the line "' + String(x.text).slice(0, 60) + '"' : ', ' + (x.side || 'right') + ' of [P' + x.paragraph + ']') + (x.by === 'me' ? ', hers' : '') + ')').join('; '));
            if (notes.length) FL.push('Highlights: ' + notes.map(x => String(x.colour || 'pink') + ' "' + String(x.text || '').slice(0, 60) + '"' + (x.note ? ' — ' + String(x.note).slice(0, 80) : '')).join('; '));
            if (stickies.length) FL.push('Stickies on the whiteboard: ' + stickies.map(x => '"' + String(x.text || '').slice(0, 80) + '" (' + String(x.colour || 'yellow') + ')').join('; '));
            L.push(FL.join(nl2));
        }
    } catch (_) {}
    // THE TEACHING BOARD (Sarah, 19 Aug: "why cant Q see the teaching board?
    // he should know whats on it he should be the one controling it"). The page
    // builds it in boardForQ() and sends it; capped again here because it rides
    // every paid turn.
    if (board) L.push('THE TEACHING BOARD BESIDE THEIR PAGE (they are looking at this; it is yours to keep \u2014 board_note puts a line on it, board_clear takes YOUR notes back off):' + nl2 + String(board).slice(0, 1200));
    L.push('Reply to their next message as their tutor.');
    return L.join(nl2 + nl2);
}
router.post('/writer/chat', requirePerson, express.json({ limit: '1mb' }), writerTooLarge('That is too much text for one message (over 1 MB).'), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Ask Q something first — the box is empty.', code: 'empty_question', retryable: false });
    try {
        const cid = String(b.criterionId || t.currentCriterionId || '').replace(/\s+/g, '');
        const stored = readStoredDocText(personId);
        // THE COACH IS Q (Sarah, 17 Aug: "I need an ai like the Q I have on the
        // general chat. I trust him"). Same persona, same model, a real
        // conversation — the writer's context goes in as the first message.
        // A ```display block in his reply is lifted out for the whiteboard.
        // The old structured chatAnswer stays as the fallback if Q is down.
        const plan = (t.plans && t.plans[cid]) || null;
        const ctx = writerCoachContext({ t, cid, plan, stepId: b.stepId ? String(b.stepId) : null, docText: String(b.docText || ''), stored, ask: b.ask ? String(b.ask) : '', partWords: b.partWords && typeof b.partWords === 'object' ? b.partWords : null, stepItems: Array.isArray(b.stepItems) ? b.stepItems : [], furniture: b.furniture && typeof b.furniture === 'object' ? b.furniture : null, board: b.board ? String(b.board).slice(0, 4000) : '' });
        // HIS MEMORY, not the page's. The same store the general chat uses
        // (one per person, tagged by surface): the coach's own turns are the
        // history, his other conversations come as the read-only digest /chat
        // gives him, and every turn here is written back — so what she says to
        // him in general he knows here, and vice versa (Sarah, 17 Aug).
        // ONE THREAD PER ASSIGNMENT (Sarah, 19 Aug: "he thinks we are working on a
        // different course"). QSURF was the same string for every project, so
        // loadMemory's last 50 turns for this person came from whichever
        // assignments she happened to use last - her CIPD reward turns were
        // Q's history while she sat on the Law paper. Worse, memHist WINS over
        // the page's own history below, so the real conversation for the
        // assignment in front of her was the thing being thrown away.
        // The surface now carries the writer project (writerScope: 'main' or
        // 'sarah--proj-<id>'). Turns from her other assignments still reach him
        // through the read-only digest built below - he can mention them, he is
        // just no longer confused about which course he is teaching.
        const QSURF = 'writer-coach:' + writerScope(req);
        const qpid = req.person && req.person.id;
        const allMem = qpid ? loadMemory(qpid) : [];
        const memHist = allMem.filter(m => (m.surface || 'chat') === QSURF).slice(-50).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 2500) }));
        const pageHist = (Array.isArray(b.history) ? b.history.slice(-10) : []).map(m => ({ role: m.role === 'me' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 2000) })).filter(m => m.content);
        const hist = memHist.length ? memHist : pageHist;
        const others = {};
        for (const m of allMem) { const sf = m.surface || 'chat'; if (sf === QSURF) continue; (others[sf] = others[sf] || []).push(m); }
        const digest = Object.entries(others).map(([sf, ms]) => '[' + (/^writer-coach:/.test(sf) ? 'ANOTHER ASSIGNMENT' : sf.toUpperCase() + ' PAGE') + ']' + String.fromCharCode(10) + ms.slice(-5).map(m => '  ' + (m.role === 'user' ? (req.person && req.person.name) || 'They' : 'Q') + ': ' + String(m.content || '').slice(0, 300).replace(/\s+/g, ' ')).join(String.fromCharCode(10))).join(String.fromCharCode(10) + String.fromCharCode(10));
        const ctxFull = ctx + (digest ? String.fromCharCode(10) + String.fromCharCode(10) + '--- YOUR OTHER CONVERSATIONS WITH THEM (read-only reference — you may mention them if relevant) ---' + String.fromCharCode(10) + digest + String.fromCharCode(10) + '--- END REFERENCE ---' : '');
        const messages = [{ role: 'user', content: ctxFull }, { role: 'assistant', content: 'Got it — I have the context. Go on.' }].concat(hist, [{ role: 'user', content: text }]);
        let out = null;
        try {
            // Which brain: 'q' = the general-chat Q (V4 Pro, default); 'qb2' = the
            // model QB2 talks with in Quoteapp (GLM-5.2 — q-chat's thread model).
            // Sarah, 17 Aug: "QB2 on the case… may be the best one for this" / "or QB2".
            const brain = String(b.brain || (t.settings && t.settings.coachBrain) || 'q');   // default = the general-chat model (V4 Pro): GLM kept talking instead of calling tools (Sarah, 18 Aug, tests #2 and #5). 'qb2' = GLM-5.2. 'claude' = Q's persona + memory + tools on a Claude brain (18 Aug pm, her comparison).
            const qOpts = { surface: 'writer-coach', person: req.person, useTools: true };   // HIS tools too — emails, the lot (Sarah, 17 Aug: 'he has access to my emails. it makes sense')
            if (brain === 'qb2' && Q_CONFIG_THREAD_MODEL) qOpts.model = Q_CONFIG_THREAD_MODEL;
            if (brain === 'claude') qOpts.brain = 'claude';
            const turnStart = Date.now();
            const q = await qChat(messages, qOpts);
            const toolNames = (Array.isArray(q && q.toolCalls) ? q.toolCalls : []).map(c => c.name + (c.result && c.result.error ? '(ERR)' : ''));
            try { if (toolNames.length) console.log('[writer/chat] Q tools: ' + toolNames.join(', ')); } catch (_) {}
            // THE LOG (Sarah, 18 Aug: "if we make a log … we can check the price at
            // the same time"): every coach turn — brain, model, tokens, £, tools,
            // time — one line in the server log and one row in her coach log
            // (GET /writer/coachlog). Priced from cost-tracker's verified table.
            let turnCost = null;
            try {
                const model = String((q && q.model) || '');
                const c = model ? computeCost({ model, tokensIn: q.tokensIn || 0, tokensOut: q.tokensOut || 0 }) : { gbp: 0, usd: 0, priced: false };
                turnCost = { ts: new Date().toISOString(), brain, model, tokensIn: q.tokensIn || 0, tokensOut: q.tokensOut || 0, gbp: +(c.gbp || 0).toFixed(6), priced: !!c.priced, tools: toolNames, ms: Date.now() - turnStart, ok: !!(q && q.reply && !q.error), chars: String((q && q.reply) || '').length };
                console.log('[writer/chat] turn brain=' + brain + ' model=' + (model || '?') + ' in=' + turnCost.tokensIn + ' out=' + turnCost.tokensOut + ' £' + turnCost.gbp.toFixed(4) + (c.priced ? '' : ' (unpriced)') + ' ' + turnCost.ms + 'ms' + (toolNames.length ? ' tools=' + toolNames.join(',') : ''));
                appendCoachLog(personId, turnCost);
            } catch (e) { console.warn('[writer/chat] coach log: ' + e.message); }
            if (q && q.reply && !q.error) {
                let display = null, reply = String(q.reply).replace(/^\s*(Response|Reply|Answer)\s*:?\s*(?=[A-Z\[\*#-])/, '');   // a stray 'Response' label some models prefix
                const m = reply.match(/```display[ \t]*\r?\n([\s\S]*?)```/);
                if (m) {
                    reply = reply.replace(m[0], '').trim();
                    const src = m[1].trim();
                    const tm = src.match(/^#{1,3}[ \t]+(.+)$/m);
                    display = { title: tm ? tm[1].trim() : 'Whiteboard', src };
                }
                // A whiteboard fence he left in his PROSE (diagram / build / flow /
                // mindmap) still belongs on the whiteboard, not as code in the chat
                // (Sarah, 18 Aug: "11, 12 nothing happened" — they were sitting in
                // the chat as code).
                const stray = [];
                reply = reply.replace(/```(diagram|flow|build|buildup|mindmap|brainstorm|map)[ \t]*\r?\n[\s\S]*?```/g, (blk) => { stray.push(blk); return ''; }).replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10)).trim();
                if (stray.length) {
                    const extra = stray.join(String.fromCharCode(10) + String.fromCharCode(10));
                    display = display ? { title: display.title, src: display.src + String.fromCharCode(10) + String.fromCharCode(10) + extra } : { title: 'Whiteboard', src: extra };
                    if (!reply) reply = 'On the whiteboard.';
                }
                // HONESTY GUARD: if he says he placed a note / highlight / tab / sticky and
                // no such tool call happened this turn, say so — she must never be told
                // something is on her page when it is not (Sarah, 18 Aug).
                {
                    const called = new Set((Array.isArray(q.toolCalls) ? q.toolCalls : []).map(c => c && c.name));
                    const claims = [
                        // A CLAIM of having done it — never a mention. "sticky notes are
                        // whiteboard-only" / "want me to highlight it?" used to trip this
                        // and he was told off for describing when he was being honest
                        // (Sarah's screenshot, 18 Aug pm).
                        [/\b(I(?:'ve| have)?(?: just)? stuck|stuck (?:a|the|one|it|that|another)|sticky(?: note)?s? (?:is|are) (?:on|up|placed|there|done|stuck)|(?:placed|added|put up|dropped) (?:a|the|another|two|three) stick(?:y|ies))\b/i, 'stick_note', 'that sticky note did not actually get placed'], 
                        [/\b(I(?:'ve| have)?(?: just)? (?:highlighted|painted)|highlighted (?:it|that|the|your|them|those|two|three|\d)|highlights? (?:are|is) (?:on|there|placed|done|painted)|(?:placed|added|put) (?:a|the|another|two|three) highlights?)\b/i, 'highlight_passage', 'those highlights did not actually get placed'], 
                        [/\b(I(?:'ve| have)?(?: just)? tabbed|tabbed (?:it|that|the|your|them|those|P\d|paragraph)|tabs? (?:are|is) (?:on|there|placed|done|in))\b/i, 'tab_paragraph', 'those tabs did not actually get placed'],
                    ];
                    for (const [rx, tool, msg] of claims) if (rx.test(reply) && !called.has(tool)) { reply += String.fromCharCode(10) + String.fromCharCode(10) + '(' + msg + ' — I described it instead of doing it. Ask me again and I will do it properly.)'; break; }
                }
                // THE CITE GUARD (Sarah, 19 Aug: "my sister said Q's making docs up
                // that don't exist"). Every citation-shaped mention in his reply or
                // on his whiteboard — Guest (1998), (Rousseau et al., 1995), a DOI —
                // that she did not bring herself (her page, her message, her uploads,
                // the brief) is looked up on OpenAlex / CrossRef. One he named that
                // is not there is SAID to be not there, in his reply, every time.
                // Mentions he got from check_reference this turn count as checked.
                try {
                    const toolText = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && c.name === 'check_reference' && c.result).map(c => JSON.stringify(c.result)).join(String.fromCharCode(10));
                    const exemptText = [text, String(b.docText || ''), stored && stored.text ? stored.text : '', ...((t.sources || []).map(s => (s && (s.text || '')) || '')), toolText].join(String.fromCharCode(10));
                    const toCheck = reply + (display && display.src ? String.fromCharCode(10) + display.src : '');
                    if (qCite.findMentions(toCheck).length) {
                        const v = await qCite.verifyMentions(toCheck, { exemptText, max: 6, timeoutMs: 9000, subject: String((t.brief && (t.brief.subject || t.brief.title)) || '') })   // the assignment is the yardstick for whether a work is on-subject;
                        console.log('[writer/chat] cite guard: checked ' + v.checked.length + ' exempt ' + v.exempt.length + (v.timedOut ? ' TIMED OUT' : '') + (v.skipped ? ' skipped ' + v.skipped : '') + (v.unverified.length ? ' — NOT FOUND: ' + v.unverified.map(u => u.mention).join(' | ') : '') + (v.checked.filter(c => c.found).length ? ' — found: ' + v.checked.filter(c => c.found).map(c => c.mention + ' → ' + (c.title || '').slice(0, 50)).join(' | ') : ''));
                        const NL = String.fromCharCode(10);
                        // SHE MUST BE ABLE TO CHECK IT HERSELF (Sarah, 20 Aug: "my
                        // sister doesnt trust it and cant check it"). A source that
                        // WAS confirmed now says which work it matched and gives the
                        // link, so trust is something she verifies in one press
                        // rather than something she is asked to extend.
                        const strong = (v.checked || []).filter(c => c && c.found === true && c.strength === 'strong');
                        if (strong.length) {
                            reply += NL + NL + '✅ Checked: ' + strong.map(c => '**' + c.mention + '** — ' + String(c.title || '').slice(0, 90) + (c.url ? ' (' + c.url + ')' : '')).join(NL + '✅ Checked: ');
                        }
                        if (v.unverified.length) {
                            const list = v.unverified.map(u => '**' + u.mention + '**').join(', ');
                            // NOT "it does not exist" — OpenAlex and CrossRef index
                            // journals well and books patchily, so a real textbook can
                            // come back missing (Barrow and Mosley 2005 did, measured
                            // 20 Aug). Say what was actually established: not confirmed.
                            reply += NL + NL + '⚠️ I could not confirm ' + list + ' on OpenAlex or CrossRef. That does not always mean ' + (v.unverified.length === 1 ? 'it is not real' : 'they are not real') + ' — books and reports are indexed patchily — but I cannot stand behind ' + (v.unverified.length === 1 ? 'it' : 'them') + '. Check ' + (v.unverified.length === 1 ? 'it' : 'them') + ' yourself before ' + (v.unverified.length === 1 ? 'it goes' : 'they go') + ' on your page, or press Auto cite and pick one I can show you.';
                            // The near miss is named as a near miss, never as the
                            // source: "there IS a paper by that name and year, and
                            // here is why it is not this one."
                            for (const u of v.unverified) {
                                if (!u.nearMiss || !u.nearMiss.title) continue;
                                reply += NL + '· The only ' + u.year + ' work by ' + u.surname + ' I can see is "' + String(u.nearMiss.title).slice(0, 80) + '"' + (u.nearMiss.about ? ' (' + u.nearMiss.about + ')' : '') + ' — a different subject, so it is not the one you mean.';
                            }
                        }
                        if (v.weak && v.weak.length) {
                            reply += NL + NL + '⚠️ ' + v.weak.map(w => '**' + w.mention + '**').join(', ') + ' — there is work by that name and year, but not on this topic that I can see. Check the actual title before you use it.';
                        }
                    }
                } catch (e) { console.warn('[writer/chat] cite guard: ' + e.message); }
                // His tap-to-answer [OPTIONS] block → buttons on the card (same
                // convention as the general chat; parser mirrors chat.html).
                let options = [];
                { const up = reply.toUpperCase(); const o = up.lastIndexOf('[OPTIONS]');
                  if (o !== -1) { const after = reply.slice(o + 9); if (/^[^\S\n]*(\r?\n|$)/.test(after)) {
                    const cr = after.toUpperCase().indexOf('[/OPTIONS]'); const raw = cr === -1 ? after : after.slice(0, cr);
                    options = raw.split(String.fromCharCode(10)).map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean).slice(0, 4);
                    if (options.length) { const before = reply.slice(0, o).trim(); const trailing = cr === -1 ? '' : after.slice(cr + 10).trim(); reply = (before + (trailing ? String.fromCharCode(10) + String.fromCharCode(10) + trailing : '')).trim(); }
                  } } }
                // His highlight_passage calls reach the page as they are — it paints them.
                const paints = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && (c.name === 'highlight_passage' || (c.tool === 'highlight_passage')) && c.result && c.result.painted).map(c => ({ text: c.result.text, note: c.result.note, kind: c.result.kind, colour: c.result.colour || '' }));
                const tabs = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && c.name === 'tab_paragraph' && c.result && c.result.tabbed).map(c => ({ paragraph: c.result.paragraph || null, text: c.result.text || '', label: c.result.label, colour: c.result.colour, side: c.result.side || 'right' }));
                const stickies = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && c.name === 'stick_note' && c.result && c.result.stuck).map(c => ({ text: c.result.text, colour: c.result.colour }));
                // His notes ON THE TEACHING BOARD, and his own clutter coming back off it.
                const boardNotes = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && c.name === 'board_note' && c.result && c.result.onBoard).map(c => ({ text: c.result.text, label: c.result.label, kind: c.result.kind }));
                const boardClears = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && c.name === 'board_clear' && c.result && c.result.cleared).map(c => ({ label: c.result.label || '' }));
                // Lines he has written into THEIR notes (21 Aug).
                const writtenNotes = (Array.isArray(q.toolCalls) ? q.toolCalls : []).filter(c => c && c.name === 'write_note' && c.result && c.result.noted).map(c => ({ text: c.result.text, part: c.result.part || '' }));
                out = { reply, display, options, paints, tabs, stickies, writtenNotes, boardNotes, boardClears, board: null, next: '', highlights: [], answersStep: false, via: 'q', brain, cost: turnCost };
                if (qpid) { try { appendMessage(qpid, 'user', text, QSURF); appendMessage(qpid, 'assistant', String(q.reply), QSURF); } catch (_) {} }   // a '[page] …' turn is the page speaking for her (a pause / Continue) — kept, so he remembers what she wrote
            }
        } catch (e) { console.warn('[writer/chat] Q unavailable, falling back: ' + e.message); }
        if (out) return ukJson(res, { ok: true, ...out });
        const r = await qWriter.chatAnswer({
            brief: t.brief, essay: t.modelEssay || null,
            plan: (t.plans && t.plans[cid]) || null, stepId: b.stepId ? String(b.stepId) : null,
            caseText: stored && stored.text ? stored.text : '', sources: t.sources || [],
            docText: String(b.docText || ''), history: Array.isArray(b.history) ? b.history.slice(-10) : [],
            question: text, yearGroup: b.yearGroup || t.yearGroup || '', ask: b.ask ? String(b.ask) : '',
        });
        ukJson(res, { ok: true, ...r });
    } catch (e) {
        writerFail(res, e, '[writer/chat]', 'chat');
    }
});

// The coach log: one row per /writer/chat turn (brain, model, tokens, £, tools).
// Lives beside the tutor notebook; capped. GET /writer/coachlog?since=ISO
// returns the rows and the totals per brain — how Q vs Claude compare on the
// same assignment (Sarah, 18 Aug).
function coachLogPath(personId) { return String(getTutorPath(personId)).replace(/\.json$/i, '') + '-coachlog.json'; }
function readCoachLog(personId) { try { const p = coachLogPath(personId); return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) || []) : []; } catch (_) { return []; } }
function appendCoachLog(personId, row) { const rows = readCoachLog(personId); rows.push(row); fs.writeFileSync(coachLogPath(personId), JSON.stringify(rows.slice(-2000))); }
router.get('/writer/coachlog', requirePerson, (req, res) => {
    try {
        const since = req.query.since ? String(req.query.since) : '';
        const rows = readCoachLog(writerScope(req)).filter(r => !since || r.ts >= since);
        const byBrain = {};
        for (const r of rows) { const k = r.brain || 'q'; const g = byBrain[k] = byBrain[k] || { turns: 0, tokensIn: 0, tokensOut: 0, gbp: 0, unpriced: 0, models: {} }; g.turns++; g.tokensIn += r.tokensIn || 0; g.tokensOut += r.tokensOut || 0; g.gbp += r.gbp || 0; if (r.priced === false) g.unpriced++; g.models[r.model || '?'] = (g.models[r.model || '?'] || 0) + 1; }
        for (const g of Object.values(byBrain)) g.gbp = +g.gbp.toFixed(4);
        res.json({ ok: true, since: since || null, turns: rows.length, byBrain, rows });
    } catch (e) { res.status(500).json({ ok: false, error: 'Could not read the coach log: ' + String(e.message || '').slice(0, 160) }); }
});

// POST /writer/probe — ONE probing question toward the ideal answer, from the
// student's live document. The brief + skeleton come from the notebook (never
// re-sent by the page); the page sends the doc text (bounded server-side),
// what changed since the last probe, compact history and the coverage tally.
router.post('/writer/probe', requirePerson, express.json({ limit: '1mb' }), writerTooLarge('That is too much text for one coaching turn (over 1 MB).'), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    if (String(b.trigger || '') === 'question' && !String(b.studentQuestion || '').trim()) return res.status(400).json({ ok: false, error: 'Ask Q something first — the box is empty.', code: 'empty_question', retryable: false });
    try {
        const r = await qWriter.probe({
            brief: t.brief,
            essay: t.modelEssay || null,
            voiced: Array.isArray(t.voicedBricks) ? t.voicedBricks : [],
            docText: String(b.docText || ''),
            delta: String(b.delta || ''),
            history: Array.isArray(b.history) ? b.history.slice(-8) : (Array.isArray(t.coachHistory) ? t.coachHistory.slice(-8) : []),
            coverage: b.coverage && typeof b.coverage === 'object' ? b.coverage : (t.coverage || {}),
            trigger: String(b.trigger || 'answer'),
            focusCriterionId: b.focusCriterionId ? String(b.focusCriterionId) : null,
            lastQuestion: b.lastQuestion ? String(b.lastQuestion) : (t.currentQuestion || null),
            voiceSignature: b.voiceSignature || null,
            relateAnchor: b.relateAnchor || t.relateAnchor || '',
            yearGroup: b.yearGroup || t.yearGroup || '',
            plan: (t.plans && t.plans[String(b.criterionId || b.focusCriterionId || t.currentCriterionId || '')]) || null,
            stepId: b.stepId ? String(b.stepId) : null,
            studentQuestion: b.studentQuestion ? String(b.studentQuestion) : null,
        });
        // A question to Q is not a coaching turn: nothing recorded as the
        // current question, nothing voiced.
        if (String(b.trigger || '') === 'question') return ukJson(res, { ok: true, ...r, coverage: t.coverage || {}, brickCounts: t.brickCounts || {}, essayReady: !!t.modelEssay, match: matchFor(t) });
        // Fold the coach's read into the notebook: bricks voiced (when the
        // essay exists) drive criterion coverage; otherwise the tally does.
        const voiced = Array.from(new Set([...(Array.isArray(t.voicedBricks) ? t.voicedBricks : []), ...r.voicedBrickIds]));
        let coverage = { ...(t.coverage || {}) };
        for (const id of r.coveredSoFar) coverage[id] = 'covered';
        if (r.criterionId && !coverage[r.criterionId]) coverage[r.criterionId] = 'partial';
        let brickCounts = t.brickCounts || {};
        if (t.modelEssay) ({ coverage, brickCounts } = qWriter.coverageFromBricks(t.modelEssay, voiced, coverage));
        const t2 = writeTutor(writerScope(req), { coverage, brickCounts, voicedBricks: voiced, currentQuestion: r.question, currentCriterionId: r.criterionId, lastQuestion: r.question, currentSection: r.criterionId });
        // The pause read judged her words: the ones used properly go green on
        // the board; a misused one comes OFF the green if a button-press had
        // put it there. Honest, both directions.
        let ex = null;
        const cidForTerms = String(b.criterionId || r.criterionId || '');
        if (cidForTerms && (r.termsUsed.length || r.termsMisused.length)) {
            const cur = new Set(((t2.termsFit || {})[cidForTerms] || []).map(String));
            for (const w of r.termsUsed) cur.add(w);
            for (const m of r.termsMisused) cur.delete(m.term);
            const tf = { ...(t2.termsFit || {}), [cidForTerms]: Array.from(cur) };
            writeTutor(writerScope(req), { termsFit: tf });
            ex = { termsFit: tf, reqMet: t2.reqMet || {} };
        }
        ukJson(res, { ok: true, ...r, coverage, brickCounts, essayReady: !!t.modelEssay, match: matchFor(t2), ...(ex || {}) });
    } catch (e) {
        const cause = qWriter.userFacingCause(e, 'coaching turn');
        console.error('[writer/probe]', e.message, e.primaryCause ? '(first: ' + e.primaryCause + ')' : '');
        res.status(cause.status).json({ ok: false, error: cause.message, code: cause.code, retryable: cause.retryable });
    }
});

// ── SCAFFOLDED COACHING (Sarah, 15 Aug late) ──────────────────────────────
// POST /writer/plan {criterionId, force?} — the ONE plan for a part. Cached
// in the notebook (plans[criterionId]); made once from the hidden essay's
// bricks. Reply: {status:'done', result: plan, cached:true} when it exists,
// else the job view (poll GET /writer/job/plan). 409 essay_pending while the
// model answer is still being written (the page waits on the essay job).
router.post('/writer/plan', requirePerson, express.json({ limit: '16kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const criterionId = String(req.body?.criterionId || t.currentCriterionId || (t.brief.criteria[0] && t.brief.criteria[0].id) || '').replace(/\s+/g, '');
    if (!t.brief.criteria.some(c => c.id === criterionId)) return res.status(400).json({ error: 'That part is not in the brief.', code: 'bad_part' });
    // Sarah, 16 Aug, live: "it says word board but there should be buttons on
    // it and terminology that needs to be used in the answers." Her plans were
    // built before the word board existed, so they have steps but no expected
    // terms — and a cached plan was served forever, which meant that session
    // could never grow buttons. A plan with no words in it is not a finished
    // plan: rebuild it. (Her draft is untouched; only the scaffold is remade.)
    // ONE rebuild for words, then live with it — the page's own wordsTried
    // was never saved server-side, so every load paid for the same re-plan.
    const cachedPlan = t.plans && t.plans[criterionId];
    const wordless = cachedPlan && !(Array.isArray(cachedPlan.expectedTerms) && cachedPlan.expectedTerms.length) && !cachedPlan.wordsTried;
    // A plan built from an older essay (re-brief, a source added) points its
    // steps at paragraphs that no longer exist: stale, rebuild.
    // (A plan from before essayAt existed is judged by its own madeAt.)
    const essayAt = t.modelEssay && t.modelEssay.writtenAt;
    const stale = !!(cachedPlan && essayAt && (cachedPlan.essayAt ? cachedPlan.essayAt !== essayAt : (cachedPlan.madeAt || 0) < essayAt));
    if (!req.body?.force && cachedPlan && !wordless && !stale) return ukJson(res, { ok: true, kind: 'plan', status: 'done', cached: true, result: cachedPlan, meta: { criterionId } });
    if (!t.modelEssay) {
        const ej = ensureEssayJob(personId, t);
        return res.status(409).json({ ok: false, error: 'Q is still writing the answer in his head for this part — a moment.', code: 'essay_pending', retryable: true, essayJob: ej ? { status: ej.status, startedAt: ej.startedAt } : null });
    }
    const running = writerJobs.get(writerJobKey(personId, 'plan'));
    if (running && running.status === 'running' && running.meta && running.meta.criterionId !== criterionId) {
        return res.status(409).json({ ok: false, error: 'Q is finishing the plan for another part — a moment.', code: 'plan_busy', retryable: true });
    }
    const job = startPlanJob(personId, criterionId, { wordsTried: !!wordless });
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...jobView(job) }));
    }
    ukJson(res, { ok: true, ...jobView(job) });
});

// POST /writer/tag {criterionId, stepId, items[]} — Q sorts the student's own
// list into the step's tags (one small call; the result is cached per items
// so a refresh never pays twice).
router.post('/writer/tag', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    const criterionId = String(b.criterionId || '').replace(/\s+/g, ''), stepId = String(b.stepId || '').replace(/\s+/g, '');
    const { plan, step } = stepOf(t, criterionId, stepId);
    if (!step) return res.status(400).json({ error: 'That step is not in the plan for this part.', code: 'bad_step' });
    const items = (Array.isArray(b.items) ? b.items : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 40);
    const key = criterionId + ':' + stepId;
    const itemsKey = items.map(x => x.toLowerCase()).join('');
    const cached = t.stepTags && t.stepTags[key];
    if (cached && cached.itemsKey === itemsKey) return ukJson(res, { ok: true, cached: true, ...cached.result });
    try {
        const r = await qWriter.tagItems({ brief: t.brief, plan, step, items });
        const t2 = readTutor(personId);
        writeTutor(personId, { stepTags: { ...(t2.stepTags || {}), [key]: { itemsKey, result: r, at: Date.now() } } });
        ukJson(res, { ok: true, ...r });
    } catch (e) {
        writerFail(res, e, '[writer/tag]', 'sorting');
    }
});

// POST /writer/step {criterionId, stepId, done:true} — a scaffold step was
// filled on the page: its target bricks count as voiced (no model call), the
// coverage / counts / match come back. With {answer, check:true} (argue /
// switch / recommend / ask): ONE small call judges the answer against the
// step's bricks → {voicedBrickIds, filled, ack, followUp}; filled ⇒ every
// target brick voiced.
router.post('/writer/step', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    const criterionId = String(b.criterionId || '').replace(/\s+/g, ''), stepId = String(b.stepId || '').replace(/\s+/g, '');
    const { plan, step } = stepOf(t, criterionId, stepId);
    if (!step) return res.status(400).json({ error: 'That step is not in the plan for this part.', code: 'bad_step' });
    try {
        if (b.check) {
            const r = await qWriter.checkStep({ brief: t.brief, essay: t.modelEssay || null, plan, step, answer: String(b.answer || ''), earlierAnswers: b.earlierAnswers ? String(b.earlierAnswers) : '' });
            const toVoice = r.filled ? step.targetBrickIds : r.voicedBrickIds;
            const v = voiceBricks(personId, toVoice);
            const ex = noteExpectations(personId, criterionId, r.termsUsed, r.requirementsMet);
            return ukJson(res, { ok: true, checked: true, ...r, coverage: v.coverage, brickCounts: v.brickCounts, match: v.match, termsFit: ex ? ex.termsFit : undefined, reqMet: ex ? ex.reqMet : undefined });
        }
        if (b.done) {
            const v = voiceBricks(personId, step.targetBrickIds);
            const t2 = readTutor(personId);
            const cov = { ...(t2.coverage || {}) };
            if (!t2.modelEssay && (cov[criterionId] || 'none') === 'none') { cov[criterionId] = 'partial'; writeTutor(personId, { coverage: cov }); v.coverage = cov; }
            return ukJson(res, { ok: true, coverage: v.coverage, brickCounts: v.brickCounts, match: v.match });
        }
        res.status(400).json({ error: 'Nothing to do — send done:true or check:true.', code: 'bad_body' });
    } catch (e) {
        writerFail(res, e, '[writer/step]', 'step check');
    }
});

// POST /writer/teach {criterionId?, stepId?, question?} — "I don't understand"
// / "I'm stuck": a mini-lesson for the concept the ask needs + the ask re-put
// as an apply question. Cached per step (a refresh never pays twice).
router.post('/writer/teach', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    const criterionId = String(b.criterionId || t.currentCriterionId || '').replace(/\s+/g, ''), stepId = String(b.stepId || '').replace(/\s+/g, '');
    const { plan, step } = stepOf(t, criterionId, stepId);
    const question = String(b.question || (step && step.prompt) || t.currentQuestion || '');
    const key = stepId ? criterionId + ':' + stepId : 'q:' + question.slice(0, 80);
    const cached = t.teachCache && t.teachCache[key];
    if (cached && cached.question === question) return ukJson(res, { ok: true, cached: true, ...cached.result });
    try {
        const out = await qWriter.teachFor({ brief: t.brief, essay: t.modelEssay || null, plan, step, question, yearGroup: b.yearGroup || t.yearGroup || '', relateAnchor: t.relateAnchor || '' });
        const t2 = readTutor(personId);
        const cache = { ...(t2.teachCache || {}) };
        const keys = Object.keys(cache); if (keys.length > 40) delete cache[keys[0]];
        cache[key] = { question, result: out, at: Date.now() };
        writeTutor(personId, { teachCache: cache });
        ukJson(res, { ok: true, ...out });
    } catch (e) {
        writerFail(res, e, '[writer/teach]', 'lesson');
    }
});

// POST /writer/place-dots {criterionId, sentences[]} — the dots IN the essay:
// where each still-needed requirement of the part belongs (sentence index),
// with one plain line of why. One small call per part when it is finished
// (and after the mark); cached by (part, sentences, unmet kinds) so a
// refresh or a re-mark never pays twice for the same text.
router.post('/writer/place-dots', requirePerson, express.json({ limit: '128kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    const criterionId = String(b.criterionId || '').replace(/\s+/g, '');
    const plan = t.plans && t.plans[criterionId];
    if (!plan) return ukJson(res, { ok: true, placements: [], reason: 'no_plan' });
    const met = new Set((t.reqMet && t.reqMet[criterionId]) || []);
    const unmet = (plan.requirements || []).map(x => x.kind).filter(k => !met.has(k));
    const sentences = (Array.isArray(b.sentences) ? b.sentences : []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 120);
    if (!unmet.length || !sentences.length) return ukJson(res, { ok: true, placements: [], unmet });
    const key = require('crypto').createHash('sha1').update(unmet.join('|') + '\n' + sentences.join('\n')).digest('hex');
    const cached = t.dotCache && t.dotCache[criterionId];
    if (cached && cached.key === key) return ukJson(res, { ok: true, cached: true, placements: cached.placements, unmet });
    try {
        const out = await qWriter.placeDots({ brief: t.brief, essay: t.modelEssay || null, plan, criterionId, sentences, unmetKinds: unmet });
        const t2 = readTutor(personId);
        writeTutor(personId, { dotCache: { ...(t2.dotCache || {}), [criterionId]: { key, placements: out.placements, at: Date.now() } } });
        ukJson(res, { ok: true, placements: out.placements, unmet });
    } catch (e) {
        writerFail(res, e, '[writer/place-dots]', 'dot placing');
    }
});

// POST /writer/cite {sentence, criterionId?} — AUTO CITE (Sarah, 15 Aug 23:40:
// "press AUTO CITE: it finds a list of citations you can use; press one and
// it puts it in as a Harvard ref. This has to be ACCURATE"). plugins/q-cite:
// the student's uploaded sources first (matched by content, details from
// their front matter), then real published work from OpenAlex (CrossRef
// fallback) — verified metadata only, Harvard formatted in code, never a
// model-written reference. The one model call here (a source's front matter
// read, only when the heuristics cannot find author + year) is cached per
// source in the notebook. Nothing on this route invents a source.
const qCite = require('./plugins/q-cite');
router.post('/writer/cite', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const sentence = String(req.body?.sentence || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (sentence.length < 12) return res.status(400).json({ error: 'Put the cursor at the end of the sentence you want to back up, then press Auto cite.', code: 'no_sentence' });
    const extractMeta = async (src) => {
        const t2 = readTutor(personId);
        const cached = t2.sourceMetaCache && t2.sourceMetaCache[src.name];
        if (cached && cached.at) return cached.meta;
        let meta = null;
        try {
            const { accurateJSON, SONNET, hasClaude } = require('./plugins/q-claude');
            if (!hasClaude()) return null;
            meta = await accurateJSON(qWriter.withHouseStyle(qCite.SOURCE_META_PROMPT), 'DOCUMENT NAME: ' + src.name + '\n\nFIRST PAGE(S):\n' + String(src.text || '').slice(0, 3500), { model: SONNET, effort: 'low', maxTokens: 500, schema: qCite.SOURCE_META_SCHEMA, skill: 'writer' });
        } catch (e) { meta = null; }
        const t3 = readTutor(personId);
        writeTutor(personId, { sourceMetaCache: { ...(t3.sourceMetaCache || {}), [src.name]: { meta, at: Date.now() } } });
        return meta;
    };
    try {
        // THE IDEA THIS PART IS MEANT TO NAME, as the search anchor. A sentence
        // of everyday words ("there is already a shortage… this gap will grow")
        // has nothing in it for an index to hold on to; the plan already knows
        // the concept the marker expects here (Sarah, 17 Aug: "why do I only
        // have the choice for weak citations"). Her own typed term wins over
        // both.
        const critId = String(req.body?.criterionId || t.currentCriterionId || '').trim();
        const plan = critId && t.plans ? t.plans[critId] : null;
        const expected = (plan && Array.isArray(plan.expectedTerms) ? plan.expectedTerms : []).map(String).filter(Boolean);
        // The expected term this sentence is closest to — a term that shares a
        // word with what she wrote, else the part's first. It is only ever a
        // SEARCH anchor; nothing is written onto her page from it.
        const sentWords = new Set(sentence.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 4));
        const planTerm = expected.find(term => term.toLowerCase().split(/\s+/).some(w => w.length > 4 && sentWords.has(w))) || expected[0] || '';
        const hint = String(req.body?.hint || '').trim() || planTerm;
        const out = await qCite.findSources({ claimSentence: sentence, subject: (t.brief && t.brief.subject) || '', level: t.yearGroup || '', uploadedSources: t.sources || [], max: 8, webMax: 6, extractMeta, hint,
            // The case study's own name (and the brief's) never go into an
            // academic search — they are fiction to the index.
            exclude: [t.brief && t.brief.scenario && t.brief.scenario.name, ...(t.sources || []).map(x => x && x.digest && x.digest.name)].filter(Boolean) });
        // What each would back, and how strongly — so she can choose (17 Aug). A failed judgement leaves the list as it was.
        let candidates = out.candidates || [];
        let note = out.note || '';
        let pickWhy = '';
        if (candidates.length) {
            try {
                const judged = await qWriter.judgeCiteCandidates({ sentence, candidates, brief: t.brief });
                candidates = candidates.map((c, i) => judged[i] ? { ...c, backs: judged[i].backs, strength: judged[i].strength, strengthWhy: judged[i].why } : c);
                // Q's own choice travels with the list, by identity rather than
                // by index, because the order changes below.
                if (judged.pick >= 0 && candidates[judged.pick]) { candidates[judged.pick] = { ...candidates[judged.pick], picked: true }; }
                pickWhy = judged.pickWhy || '';
                // A SOURCE THAT DOES NOT BACK THE SENTENCE IS NOT AN OPTION.
                // Sarah, 17 Aug: "I used auto cite for that… why has it provided
                // me with one citation that is too weak to use?" The judge had
                // already said it was about the wrong topic, and the page
                // offered it anyway with "press one — it goes in". Offering a
                // citation the marker will pull apart is worse than offering
                // nothing, so `none` is dropped here and never reaches her.
                // SHE SEES WHAT HE SAW (Sarah, 20 Aug). Dropping the off-topic
                // ones silently left her staring at "none of these work" with
                // nothing to look at — and, on 20 Aug, with Q naming the right
                // paper in the chat a moment later. They stay, marked unusable,
                // sorted last, each carrying his reason. Offering is not the
                // same as recommending: his pick is named, and an unusable one
                // says in plain words why he would not put his name to it.
                const unusable = candidates.filter(c => c.strength === 'none');
                if (unusable.length) console.log('[writer/cite] ' + unusable.length + ' off-topic candidate(s) kept but marked unusable: ' + unusable.map(c => (c.title || '').slice(0, 60)).join(' | '));
                candidates = candidates.map(c => c.strength === 'none' ? { ...c, unusable: true, picked: false } : c);
                if (!candidates.some(c => !c.unusable)) {
                    note = 'None of these actually back that sentence — I would not put my name to any of them, and a marker would pull them apart. They are here so you can see what I found. Try naming the idea in the sentence more plainly, or use the References tool to add the source you have in mind.';
                }
            } catch (e) { console.warn('[writer/cite] judge failed:', e.message); }
        }
        // Titles / names / references are never "polished" — they are the source's own words.
        res.json({ ok: true, sentence, candidates, searched: out.searched, pickWhy: pickWhy ? qWriter.ukText(pickWhy) : '', note: note ? qWriter.ukText(note) : '' });
    } catch (e) {
        writerFail(res, e, '[writer/cite]', 'source search');
    }
});

// POST /writer/cite/used {criterionId, kinds[]} — a citation went in at the
// student's request: the part's citation / reference requirement counts as
// met (union into the notebook's honest read), so its dot clears.
router.post('/writer/cite/used', requirePerson, express.json({ limit: '8kb' }), (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet.', code: 'no_brief' });
    const criterionId = String(req.body?.criterionId || t.currentCriterionId || '').replace(/\s+/g, '');
    const kinds = (Array.isArray(req.body?.kinds) ? req.body.kinds : ['citation', 'reference']).map(String).filter(k => qWriter.REQ_KINDS.includes(k));
    const ex = noteExpectations(writerScope(req), criterionId, [], kinds);
    res.json({ ok: true, criterionId, termsFit: ex ? ex.termsFit : (t.termsFit || {}), reqMet: ex ? ex.reqMet : (t.reqMet || {}) });
});

// POST /writer/labels — plain nicknames for a brief saved before labels
// existed. ONE tiny call for every criterion; saved to the notebook once.
router.post('/writer/labels', requirePerson, express.json({ limit: '8kb' }), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    if (!t.brief) return res.status(400).json({ error: 'No brief yet.', code: 'no_brief' });
    const needs = t.brief.criteria.some(c => qWriter.labelLooksGenerated(c));
    if (!needs && !req.body?.force) return ukJson(res, { ok: true, cached: true, labels: t.brief.criteria.map(c => ({ id: c.id, label: c.label })) });
    if (t.labelsFixedAt && !req.body?.force) return ukJson(res, { ok: true, cached: true, labels: t.brief.criteria.map(c => ({ id: c.id, label: c.label })) });
    try {
        const labels = await qWriter.relabelCriteria({ brief: t.brief });
        const t2 = readTutor(personId);
        const byId = new Map(labels.map(x => [x.id, x.label]));
        const brief = { ...t2.brief, criteria: t2.brief.criteria.map(c => ({ ...c, label: byId.get(c.id) || c.label })) };
        writeTutor(personId, { brief, labelsFixedAt: Date.now() });
        ukJson(res, { ok: true, labels });
    } catch (e) {
        writerFail(res, e, '[writer/labels]', 'labels');
    }
});

// ── Teaching videos (Sarah, 15 Aug: "videos open in the teaching suite… on
// its own raised movable card"). ONE explainer for a concept, from
// plugins/q-youtube.js (YouTube Data API, key in Railway only). No key / no
// result / API failure → video:null and the page falls back to a plain
// search link. Never an error to the student. Same plugin serves the
// revision suite (twin route below).
const qYouTube = require('./plugins/q-youtube');
async function videoHandler(req, res, fromTutor) {
    const query = String(req.body?.query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!query) return res.status(400).json({ ok: false, error: 'query required', code: 'bad_body' });
    let level = String(req.body?.level || ''), subject = String(req.body?.subject || '');
    if (fromTutor) { const t = readTutor(writerScope(req)); level = level || String(t.yearGroup || t.gradeScheme || ''); subject = subject || String((t.brief && t.brief.subject) || ''); }
    let video = null;
    try { video = await qYouTube.searchTeachingVideo({ query, level, subject }); } catch (_) { video = null; }
    res.json({ ok: true, video, hasKey: qYouTube.hasKey(), searchUrl: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) });
}
router.post('/writer/video', requirePerson, express.json({ limit: '8kb' }), (req, res) => videoHandler(req, res, true));
router.post('/revision/video', requirePerson, express.json({ limit: '8kb' }), (req, res) => videoHandler(req, res, false));

// POST /writer/source — a supporting document (case study, module notes,
// data) for THIS session. Stored server-side, bounded; the model essay is
// rewritten to cite it. Body: { name, text } to add, { remove: name } to drop.
router.post('/writer/source', requirePerson, express.json({ limit: '4mb' }), writerTooLarge('That supporting document is too big (over 4 MB of text). Upload the part that matters — a chapter, the case study pages.'), async (req, res) => {
    const personId = writerScope(req);
    const t = readTutor(personId);
    const sources = Array.isArray(t.sources) ? t.sources.slice() : [];
    const b = req.body || {};
    if (b.remove) {
        const next = sources.filter(s => s.name !== String(b.remove));
        writeTutor(personId, { sources: next });
        if (t.brief && next.length !== sources.length) startEssayJob(personId);
        return res.json({ ok: true, sources: sourcesMeta(next), essayJob: t.brief ? 'restarted' : null });
    }
    const name = String(b.name || '').trim().slice(0, 120);
    let text = String(b.text || '').trim();
    if (!name || !text) return res.status(400).json({ error: 'name and text required', code: 'bad_body' });
    if (text.length < 200) return res.status(400).json({ error: 'That document came back nearly empty (' + text.length + ' characters) — probably scanned images. Try a file with real text.', code: 'empty' });
    if (sources.length >= SOURCE_MAX) return res.status(400).json({ error: `You already have ${SOURCE_MAX} supporting documents — remove one first.`, code: 'too_many' });
    let truncated = false;
    if (text.length > SOURCE_CHARS) { text = text.slice(0, SOURCE_CHARS); truncated = true; }
    const used = sources.reduce((n, s) => n + (s.text || '').length, 0);
    if (used + text.length > SOURCE_TOTAL) return res.status(400).json({ error: 'That would take the supporting documents past the 300,000-character limit for one session — remove one, or upload only the pages that matter.', code: 'too_much' });
    const idx = sources.findIndex(s => s.name === name);
    const entry = { name, text, addedAt: Date.now() };
    if (idx >= 0) sources[idx] = entry; else sources.push(entry);
    writeTutor(personId, { sources });
    if (t.brief) startEssayJob(personId);
    setTimeout(() => { digestSourceInBackground(personId, name); }, 0);
    res.json({ ok: true, sources: sourcesMeta(sources), truncated, essayJob: t.brief ? 'started' : null, digesting: true });
});

// POST /writer/brief/scenario — the story inside a brief that was read before
// `scenario` existed (Sarah, 16 Aug: "there's still no simplified case study or
// brief. the story that you're basing the questions on."). One small call over
// the stored brief text; stored on the brief so it is done once.
router.post('/writer/brief/scenario', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first.', code: 'no_brief' });
    // `force` re-reads a scenario that was stored before the fact card's fields
    // (name / kind / strengths) existed. It costs a model call, so it only ever
    // happens because she pressed "Re-read" — never on its own (Sarah, 17 Aug).
    if (!req.body?.force && t.brief.scenario && t.brief.scenario.theStory) return ukJson(res, { ok: true, scenario: t.brief.scenario, cached: true });
    const stored = readStoredDocText(writerScope(req));
    if (!stored || !stored.text) return res.status(400).json({ error: 'The brief text is not stored on the server any more — drop the task in again and I read it fresh.', code: 'no_doc' });
    try {
        const scenario = await qWriter.extractScenario({ taskText: stored.text, brief: t.brief });
        // scenarioChecked only once the model has answered (a story, or a
        // genuine null); a throw lands in the catch and leaves it unchecked.
        const t2 = readTutor(writerScope(req));
        writeTutor(writerScope(req), { brief: { ...(t2.brief || t.brief), scenario, scenarioChecked: true } });
        ukJson(res, { ok: true, scenario });
    } catch (e) {
        writerFail(res, e, '[writer/brief/scenario]', 'pulling the story out of the brief');
    }
});

// POST /writer/source/digest { name } — (re)make the plain-words digest of one
// supporting document; GET the digests any time. The page polls the tutor for
// them, so this is only the retry path and the "digest the ones from before"
// path for sources uploaded before digests existed.
router.post('/writer/source/digest', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    const t = readTutor(writerScope(req));
    const name = String(req.body?.name || '').trim();
    const src = (t.sources || []).find(s => s.name === name);
    if (!src) return res.status(400).json({ error: 'That document is not in this session.', code: 'no_source' });
    try {
        const digest = await qWriter.digestSource({ name, text: src.text, brief: t.brief || null });
        if (emptyDigest(digest)) return res.status(502).json({ ok: false, error: 'The digest came back empty — retry?', code: 'empty_digest', retryable: true });
        const t2 = readTutor(writerScope(req));
        writeTutor(writerScope(req), { sources: (t2.sources || []).map(s => s.name === name ? { ...s, digest } : s) });
        ukJson(res, { ok: true, name, digest });
    } catch (e) {
        writerFail(res, e, '[writer/source/digest]', 'reading that document for you');
    }
});

// POST /writer/source/original { name } — the ORIGINAL words of a source, so the
// fact card's "Open the original" can show what Q read (Sarah, 17 Aug: "then a
// button to open the original"). `__brief` gives the stored task document. Read
// only, this person's own scope only, and bounded — the text is already capped
// at SOURCE_CHARS on the way in.
router.post('/writer/source/original', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const t = readTutor(writerScope(req));
    const name = String(req.body?.name || '').trim();
    if (name === '__brief') {
        const stored = readStoredDocText(writerScope(req));
        if (!stored || !stored.text) return res.status(400).json({ error: 'The task document is not stored on the server any more — drop it in again to read it here.', code: 'no_doc' });
        return ukJson(res, { ok: true, name: stored.name || 'The task', text: stored.text });
    }
    const src = (t.sources || []).find(s => s.name === name);
    if (!src || !src.text) return res.status(400).json({ error: 'That document is not in this session.', code: 'no_source' });
    ukJson(res, { ok: true, name, text: src.text });
});

// POST /writer/essay — (re)write the hidden model answer. Job: GET /writer/job/essay.
router.post('/writer/essay', requirePerson, express.json({ limit: '16kb' }), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const job = startEssayJob(writerScope(req));
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...jobView(job) }));
    }
    ukJson(res, { ok: true, ...jobView(job) });
});

// POST /writer/edit-pass — the editing stage: per sentence, a stronger word
// and a real reference (uploaded sources first). Job: GET /writer/job/edit.
router.post('/writer/edit-pass', requirePerson, express.json({ limit: '2mb' }), writerTooLarge('That draft is too long to edit in one pass (over 2 MB of text).'), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const docText = String(req.body?.docText || t.docText || '');
    if (!docText.trim()) return res.status(400).json({ error: 'There is nothing on the page to edit yet.', code: 'empty' });
    const voiceSignature = req.body?.voiceSignature || null;
    const personId = writerScope(req);
    const job = startWriterJob(personId, 'edit', async () => {
        const r = await qWriter.editPass({ brief: t.brief, essay: t.modelEssay || null, docText, sources: t.sources || [], voiceSignature });
        writeTutor(personId, { lastEdit: { ...r, at: Date.now() } });
        return r;
    });
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...jobView(job) }));
    }
    ukJson(res, { ok: true, ...jobView(job) });
});

// POST /writer/tool — an edit-stage tool button: terminology / synonyms /
// dictionary / strategies / cases / references / weak. One small structured
// call that LEADS the student to write it themselves. Body: { tool, sentence,
// word?, brickId? }. Never a rewritten sentence.
router.post('/writer/tool', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    try {
        const help = await qWriter.toolHelp({
            tool: String(b.tool || ''), sentence: String(b.sentence || ''), word: b.word ? String(b.word) : '',
            brickId: b.brickId ? String(b.brickId) : null,
            brief: t.brief, essay: t.modelEssay || null, sources: t.sources || [], yearGroup: b.yearGroup || t.yearGroup || '',
            caseText: String(b.tool || '') === 'facts' ? ((readStoredDocText(writerScope(req)) || {}).text || '') : '',
            want: b.want ? String(b.want).slice(0, 20) : '',
            focus: b.focus ? String(b.focus).slice(0, 300) : '',
        });
        ukJson(res, { ok: true, ...help });
    } catch (e) {
        writerFail(res, e, '[writer/tool]', 'tool');
    }
});

// POST /writer/proofread { kind: 'spelling' | 'grammar', text } — one pass
// over the page; verbatim spans + minimal corrections. The Editing panel
// marks every one on the page and offers Fix / Fix all. (17 Aug)
router.post('/writer/proofread', requirePerson, express.json({ limit: '512kb' }), writerTooLarge('That is too much text to check in one go — check a section at a time.'), async (req, res) => {
    const kind = String(req.body?.kind || 'spelling');
    const text = String(req.body?.text || '');
    if (!qWriter.PROOF_KINDS.includes(kind)) return res.status(400).json({ error: 'Which check? Spelling, grammar or trim.', code: 'bad_kind' });
    if (!text.trim()) return res.status(400).json({ error: 'There is nothing on the page to check yet.', code: 'empty' });
    const context = String(req.body?.context || '').slice(0, 4000);
    try {
        const r = await qWriter.proofread({ text, kind, context });
        ukJson(res, { ok: true, ...r });
    } catch (e) {
        writerFail(res, e, '[writer/proofread]', kind + ' check');
    }
});

// POST /writer/check-sentence — the student rewrote the highlighted sentence;
// Q compares it to the brick and answers with a closeness cue (never the
// target). match ⇒ the brick counts as voiced; closer ⇒ half credit. The
// visible match score follows. Body: { sentence, brickId? }.
router.post('/writer/check-sentence', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first so I know what the marker wants.', code: 'no_brief' });
    const b = req.body || {};
    try {
        const brickId = b.brickId ? String(b.brickId).replace(/\s+/g, '') : null;
        const cidOf = brickId ? brickId.split('-')[0] : (b.criterionId ? String(b.criterionId) : '');
        const r = await qWriter.checkSentence({ sentence: String(b.sentence || ''), brickId, brief: t.brief, essay: t.modelEssay || null, plan: (t.plans && t.plans[cidOf]) || null });
        const ex = noteExpectations(writerScope(req), cidOf, r.termsUsed, r.requirementsMet);
        const voiced = new Set(Array.isArray(t.voicedBricks) ? t.voicedBricks : []);
        const close = new Set(Array.isArray(t.closeBricks) ? t.closeBricks : []);
        if (brickId) {
            if (r.closeness === 'match') { voiced.add(brickId); close.delete(brickId); }
            else if (r.closeness === 'closer') close.add(brickId);
        }
        let coverage = { ...(t.coverage || {}) }, brickCounts = t.brickCounts || {};
        if (t.modelEssay) ({ coverage, brickCounts } = qWriter.coverageFromBricks(t.modelEssay, Array.from(voiced), coverage));
        const t2 = writeTutor(writerScope(req), { voicedBricks: Array.from(voiced), closeBricks: Array.from(close), coverage, brickCounts });
        ukJson(res, { ok: true, ...r, brickId, criterionId: cidOf, coverage, brickCounts, match: matchFor(t2), termsFit: ex ? ex.termsFit : undefined, reqMet: ex ? ex.reqMet : undefined });
    } catch (e) {
        writerFail(res, e, '[writer/check-sentence]', 'sentence check');
    }
});

// POST /writer/download — the student's text as a .docx they can hand in.
// Uses doc-creator (the same generator Q's create_document tool uses); the
// link resolves only for this person. Body: { title, content }.
router.post('/writer/download', requirePerson, express.json({ limit: '2mb' }), writerTooLarge('That document is too big to export in one file (over 2 MB of text).'), async (req, res) => {
    const title = String(req.body?.title || '').trim() || 'My assignment';
    const content = String(req.body?.content || '');
    if (!content.trim()) return res.status(400).json({ error: 'There is nothing to download yet — the page is blank.', code: 'empty' });
    // `blocks` (optional) is the page as Word objects — headings, runs, lists,
    // tables, diagrams, mind maps (writer.html docBlocksForExport). With them the
    // page reaches Word formatted; without them it is the old text path exactly.
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : null;
    try {
        if (blocks && blocks.length) {
            const { createWriterDocx } = require('./plugins/writer-docx');
            const out = await createWriterDocx({ title, blocks }, req.person.email);
            return res.json({ ok: true, url: '/download/' + out.token, filename: out.filename, sizeBytes: out.sizeBytes });
        }
        const { createDocx } = require('./plugins/doc-creator');
        const out = await createDocx({ title, content }, req.person.email);
        res.json({ ok: true, url: '/download/' + out.token, filename: out.filename, sizeBytes: out.sizeBytes });
    } catch (e) {
        console.error('[writer/download]', e.message);
        res.status(500).json({ error: 'Could not build the Word file: ' + String(e.message || '').replace(/[\r\n]+/g, ' ').slice(0, 160) + ' — try Download as text instead.', code: 'docx_failed' });
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
        writerFail(res, e, '[writer/voice]', 'voice read');
    }
});

// POST /writer/doc — store the full extracted document text for this person
router.post('/writer/doc', requirePerson, express.json({ limit: '8mb' }), writerTooLarge('That document text is over 8 MB — the coach can hold about 2,000 pages of text. Split the brief, or upload only the part with the tasks and criteria.'), async (req, res) => {
    const { text, name } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    try {
        const docPath = getDocPath(writerScope(req));
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
        const docPath = getDocPath(writerScope(req));
        if (!fs.existsSync(docPath)) return res.json({ ok: true, text: null });
        const { text, name, savedAt } = JSON.parse(fs.readFileSync(docPath, 'utf8'));
        res.json({ ok: true, text, name, savedAt });
    } catch (e) {
        res.json({ ok: true, text: null });
    }
});

// ── Fetch a pasted link and turn the page into task text ───────────────────
// The writer (and revision) source slot accepts a URL — e.g. the course page
// an assignment lives on. We fetch it server-side, strip it to readable text,
// and feed it into the same brief pipeline as an uploaded file.

function htmlToText(html) {
    let s = String(html);
    // Drop the parts that are never content
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
    // Structure → line breaks so the text keeps its shape
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|table)>/gi, '\n');
    s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');
    // Strip remaining tags, decode the common entities
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
         .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } });
    // Tidy whitespace
    s = s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

router.post('/writer/fetch-url', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    let url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'That doesn\'t look like a valid link.' }); }
    // Never let this be used to poke at internal services
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '0.0.0.0' || host === '[::1]'
        || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
        || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
        return res.status(400).json({ error: 'That address can\'t be fetched.' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const r = await fetch(parsed.href, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
            },
        });
        clearTimeout(timer);
        if (!r.ok) return res.status(502).json({ error: `The site answered with ${r.status}. If the page needs a login, copy the text and paste it in instead.` });

        const contentType = (r.headers.get('content-type') || '').toLowerCase();

        // A link straight to a PDF (course briefs often are)
        if (contentType.includes('application/pdf') || parsed.pathname.toLowerCase().endsWith('.pdf')) {
            const buffer = Buffer.from(await r.arrayBuffer());
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            const pdfText = (data.text || '').trim();
            console.log('[writer/fetch-url] pdf ' + host + ' → ' + pdfText.length + ' chars');
            if (pdfText.length < 200) return res.json({ ok: false, error: 'That PDF came back nearly empty — it may be scanned images. Try uploading it as a file instead.' });
            return res.json({ ok: true, text: pdfText.slice(0, 200000), title: parsed.pathname.split('/').pop() || host, kind: 'pdf' });
        }

        const html = await r.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
        const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 120) : '';
        const text = htmlToText(html);
        console.log('[writer/fetch-url] ' + host + ' → ' + text.length + ' chars');
        if (text.length < 200) {
            return res.json({ ok: false, error: 'That page didn\'t give me much to read — it probably needs a login. Open it, copy the text, and paste it in instead.' });
        }
        return res.json({ ok: true, text: text.slice(0, 200000), title, kind: 'html' });
    } catch (e) {
        clearTimeout(timer);
        const msg = e.name === 'AbortError' ? 'That site took too long to answer.' : ('Couldn\'t reach that link: ' + e.message);
        console.warn('[writer/fetch-url] ' + msg);
        return res.status(502).json({ error: msg + ' If the page needs a login, copy the text and paste it in instead.' });
    }
});

// ── Revision routes ────────────────────────────────────────────────────────
// Active-recall subject revision: one exam-style question at a time, marked
// strictly against a mark scheme. Engine: plugins/q-revision.js (Claude first
// via q-claude, Q fallback). Progress lives per-person in q-revision-{id}.json.
//
// Every error on this surface goes out through revisionError(): the real
// cause is kept (so the page can show it), vendor names are stripped
// (Sarah's rule), and a body-parser 413 is an honest 413 JSON — never the
// generic "Server error" (STUDY_SUITE_PHASE1_FINDINGS §1.1, §2.2 #1/#6).
function revisionError(res, tag, e, status) {
    const qRevision = require('./plugins/q-revision');
    console.error(`[${tag}]`, e && e.message);
    const msg = (e && (e.publicMessage || qRevision.publicError(e.message))) || 'Something went wrong.';
    const upstream = /\b(upstream|service|timed out|timeout|ECONN|fetch failed|401|429|5\d\d)\b/i.test(String(e && e.message));
    res.status(status || (upstream ? 502 : 500)).json({ error: msg, cause: msg, retryable: upstream });
}
// Body-parser errors (too large / bad JSON) skip a route's try/catch and land
// in the global handler as a 500. This route-level error middleware turns
// them into an honest, machine-readable answer instead.
function revisionBodyError(err, req, res, next) {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'That save was too big to store — the page will compact your history and try again.', code: 'too_large', limit: err.limit });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'That request wasn\'t valid JSON.', code: 'bad_json' });
    }
    return next(err);
}

// POST /revision/question — write the next exam-style question
router.post('/revision/question', requirePerson, express.json({ limit: '256kb' }), revisionBodyError, async (req, res) => {
    try {
        const qRevision = require('./plugins/q-revision');
        const { subject, board, level, topic, askedSoFar, weakAreas } = req.body || {};
        if (!subject) return res.status(400).json({ error: 'subject required' });
        const result = await qRevision.generateQuestion({
            subject, board, level, topic,
            askedSoFar: Array.isArray(askedSoFar) ? askedSoFar : [],
            weakAreas: Array.isArray(weakAreas) ? weakAreas : [],
        });
        res.json({ ok: true, ...result });
    } catch (e) {
        revisionError(res, 'revision/question', e);
    }
});

// POST /revision/quiz — a checked batch of clickable questions.
// Q writes them (cheap), Sonnet verifies every answer key (pennies).
// Every batch is BANKED (write-through) — we never throw away a question
// we've already paid Sonnet to check.
router.post('/revision/quiz', requirePerson, express.json({ limit: '256kb' }), revisionBodyError, async (req, res) => {
    try {
        const qRevision = require('./plugins/q-revision');
        const qBank = require('./plugins/q-bank');
        const { subject, board, level, topic, count, avoid } = req.body || {};
        if (!subject) return res.status(400).json({ error: 'subject required' });
        const result = await qRevision.generateQuiz({
            subject, board, level, topic, count,
            avoid: Array.isArray(avoid) ? avoid : [],
        });
        // Snap topicTags onto the teacher's list wording (the page appends a
        // "(Focus especially on: …)" line — that isn't a topic, strip it), then
        // bank them (with stable ids) and return the ids to the client.
        const teacherList = qBank.splitTopics(String(topic || '').split('\n(Focus especially on:')[0]);
        result.questions = qBank.snapQuestions(result.questions, teacherList);
        const key = qBank.bankKey(subject, board, level);
        qBank.addQuestions(key, result.questions);
        result.questions = result.questions.map((q) => ({ id: qBank.questionId(q.question), ...q }));
        res.json({ ok: true, ...result });
    } catch (e) {
        revisionError(res, 'revision/quiz', e);
    }
});

// ── The question bank — build once, play free ──────────────────────────────

// GET /revision/bank?subject&board&level — the whole library for this
// subject. Play is served from this client-side: zero AI calls per answer.
router.get('/revision/bank', requirePerson, (req, res) => {
    try {
        const qBank = require('./plugins/q-bank');
        const key = qBank.bankKey(req.query.subject, req.query.board, req.query.level);
        const bank = qBank.loadBank(key);
        res.json({ ok: true, key, count: bank.questions.length, questions: bank.questions });
    } catch (e) {
        revisionError(res, 'revision/bank', e);
    }
});

// POST /revision/bank/build — stock (or TOP UP) the bank in the background:
// perTopic checked questions for every topic in the list (or 50 core
// questions if no list). Safe to call on every visit — running builds are
// not duplicated, stocked topics are skipped (normalised tag match), a full
// no-list bank makes zero AI calls.
router.post('/revision/bank/build', requirePerson, express.json({ limit: '64kb' }), revisionBodyError, (req, res) => {
    try {
        const qBank = require('./plugins/q-bank');
        const qRevision = require('./plugins/q-revision');
        const { subject, board, level, topics, perTopic } = req.body || {};
        if (!subject) return res.status(400).json({ error: 'subject required' });
        const result = qBank.startBuild(
            { subject, board, level, topics, perTopic: Math.min(parseInt(perTopic, 10) || 10, 20) },
            qRevision.generateQuiz
        );
        res.json({ ok: true, ...result });
    } catch (e) {
        revisionError(res, 'revision/bank/build', e);
    }
});

// GET /revision/bank/status?subject&board&level — build progress + stock
// levels + failed count + lastError (vendor-free) so the page can show why a
// build stalled and offer a retry.
router.get('/revision/bank/status', requirePerson, (req, res) => {
    try {
        const qBank = require('./plugins/q-bank');
        const key = qBank.bankKey(req.query.subject, req.query.board, req.query.level);
        res.json({ ok: true, ...qBank.buildStatus(key) });
    } catch (e) {
        revisionError(res, 'revision/bank/status', e);
    }
});

// POST /revision/mark — mark the student's answer against the mark scheme
router.post('/revision/mark', requirePerson, express.json({ limit: '256kb' }), revisionBodyError, async (req, res) => {
    try {
        const qRevision = require('./plugins/q-revision');
        const { question, markScheme, modelAnswer, marks, answer, level } = req.body || {};
        if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
        const result = await qRevision.markAnswer({ question, markScheme, modelAnswer, marks, answer, level });
        res.json({ ok: true, ...result });
    } catch (e) {
        revisionError(res, 'revision/mark', e);
    }
});

// GET /revision/progress — this person's revision book (includes the
// per-user `ui` block: teen/sensible mode, motion, effect picks)
router.get('/revision/progress', requirePerson, (req, res) => {
    try {
        const p = getRevisionPath(req.person.id);
        if (!fs.existsSync(p)) return res.json({});
        res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) {
        res.json({});
    }
});

// POST /revision/progress — save the whole revision book. Over the limit →
// honest 413 (revisionBodyError) so the page compacts and retries instead of
// silently losing every save from then on.
router.post('/revision/progress', requirePerson, express.json({ limit: '512kb' }), revisionBodyError, (req, res) => {
    try {
        fs.writeFileSync(getRevisionPath(req.person.id), JSON.stringify(req.body || {}, null, 2), 'utf8');
        res.json({ ok: true, bytes: Buffer.byteLength(JSON.stringify(req.body || {})) });
    } catch (e) {
        revisionError(res, 'revision/progress', e);
    }
});

// ── THE PET PARK — pets that play together ────────────────────────────────
// A park is a small shared room keyed by a short code a child can read out
// to a brother or a friend ("sunny-otter-27"). Each person's pet posts a
// snapshot (name, kind, stage, what it's wearing, mood) and gets back the
// other pets, which the page draws in the scene beside their own. Nothing
// personal crosses: pet names only, and an opaque per-member id.
const PARK_WORDS_A = ['sunny', 'fluffy', 'happy', 'bouncy', 'sleepy', 'jolly', 'tiny', 'giant', 'speedy', 'cosy', 'muddy', 'snowy', 'stripy', 'spotty', 'shiny', 'wiggly'];
const PARK_WORDS_B = ['otter', 'puffin', 'badger', 'rabbit', 'fox', 'hedgehog', 'panda', 'koala', 'penguin', 'llama', 'sloth', 'squirrel', 'owl', 'duck', 'seal', 'moose'];
const PARK_MAX_MEMBERS = 12;
const PARK_STALE_MS = 30 * 24 * 3600 * 1000;   // a pet not seen for a month drops out of the scene
function parkCodeOk(code) { return /^[a-z]+-[a-z]+-\d{2}$/.test(String(code || '')); }
function newParkCode() {
    const crypto = require('crypto');
    const r = crypto.randomBytes(3);
    return PARK_WORDS_A[r[0] % PARK_WORDS_A.length] + '-' + PARK_WORDS_B[r[1] % PARK_WORDS_B.length] + '-' + String(10 + (r[2] % 90));
}
function readPark(code) {
    const p = getParkPath(code);
    if (!fs.existsSync(p)) return null;
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return (j && j.members && typeof j.members === 'object') ? j : null; } catch (e) { return null; }
}
function writePark(park) { fs.writeFileSync(getParkPath(park.code), JSON.stringify(park), 'utf8'); }
function memberKey(personId) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update('park:' + String(personId)).digest('hex').slice(0, 12);
}
function cleanPetSnapshot(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    const kind = ['puppy', 'hamster', 'capybara'].includes(s.kind) ? s.kind : null;
    if (!kind) return null;
    const stage = ['baby', 'young', 'grown'].includes(s.stage) ? s.stage : 'baby';
    const wearing = Array.isArray(s.wearing) ? s.wearing.filter((w) => ['bow', 'hat', 'scarf'].includes(w)).slice(0, 3) : [];
    const mood = ['happy', 'okay', 'hungry', 'poorly', 'asleep'].includes(s.mood) ? s.mood : 'okay';
    const name = String(s.name || '').replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, 18);
    return { name, kind, stage, wearing, mood };
}
function parkFriends(park, me) {
    const now = Date.now();
    return Object.entries(park.members)
        .filter(([k, m]) => k !== me && m && m.pet && (now - (m.at || 0)) < PARK_STALE_MS)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .map(([k, m]) => ({ id: k, at: m.at, ...m.pet }));
}
// POST /revision/park — { action: 'create' | 'join' | 'ping' | 'leave', code?, pet? }
router.post('/revision/park', requirePerson, express.json({ limit: '8kb' }), revisionBodyError, (req, res) => {
    try {
        const { action } = req.body || {};
        const me = memberKey(req.person.id);
        const pet = cleanPetSnapshot(req.body && req.body.pet);
        const code = String((req.body && req.body.code) || '').trim().toLowerCase().replace(/\s+/g, '-');
        if (action === 'create') {
            let c = newParkCode(), tries = 0;
            while (readPark(c) && tries++ < 20) c = newParkCode();
            const park = { code: c, created: Date.now(), members: {} };
            park.members[me] = { pet, at: Date.now(), since: Date.now() };
            writePark(park);
            return res.json({ ok: true, code: c, friends: [] });
        }
        if (!parkCodeOk(code)) return res.status(400).json({ error: 'That doesn\'t look like a park code — it\'s two words and a number, like sunny-otter-27.' });
        const park = readPark(code);
        if (!park) return res.status(404).json({ error: 'No park with that code. Check the letters with whoever gave it to you.' });
        if (action === 'leave') {
            delete park.members[me];
            if (Object.keys(park.members).length) writePark(park); else { try { fs.unlinkSync(getParkPath(code)); } catch (e) { /* gone */ } }
            return res.json({ ok: true });
        }
        if (action === 'join' || action === 'ping') {
            if (!park.members[me] && Object.keys(park.members).length >= PARK_MAX_MEMBERS) return res.status(409).json({ error: 'That park is full (12 pets).' });
            park.members[me] = { pet: pet || (park.members[me] && park.members[me].pet) || null, at: Date.now(), since: (park.members[me] && park.members[me].since) || Date.now() };
            writePark(park);
            return res.json({ ok: true, code, friends: parkFriends(park, me) });
        }
        return res.status(400).json({ error: 'Unknown park action.' });
    } catch (e) {
        revisionError(res, 'revision/park', e);
    }
});

// POST /writer/tutor — Q's tutor notebook for this person. The writer page
// writes here as Q coaches: the brief he built, which section they're on, the
// last thing they were stuck on. Merge-write so partial updates (just the
// current section, just "stuck on") don't clobber the rest. Read back by the
// recall_tutor tool from any surface — "what was that question I was stuck on?"
// POST /writer/tutor — Q's tutor notebook for this person. Since Phase 3 this
// is the whole coaching session: the brief (server-only skeleton included),
// the student's document (HTML + text), title, coverage per criterion, the
// coach Q&A history, the current question and the per-user settings. The
// page autosaves here on a debounce; GET restores it on load. Merge-write so
// partial updates never clobber the rest. Read back by the recall_tutor tool
// from any surface — "what was that question I was stuck on?"
const TUTOR_KEYS = [
    // legacy (recall_tutor reads these)
    'task', 'whatItWants', 'teachersBrief', 'markedSections', 'gradeBands', 'currentSection', 'lastQuestion', 'lastStuckOn',
    // Phase 3
    'docHtml', 'docText', 'docTitle', 'sourceName', 'sourceUrl', 'coverage', 'coachHistory', 'currentQuestion', 'currentCriterionId',
    'probeSnapshot', 'settings', 'gradeScheme', 'yearGroup', 'relateAnchor', 'setupDone', 'lastMark', 'lastAssembly', 'qWordsWritten',
    // scaffolded coaching (15 Aug late): where they are in the part plan, the
    // filled scaffolds, the page's model-call tally per part. plans[] itself is
    // written by the plan job only.
    'stepState', 'currentStep', 'calls', 'openerDone', 'askFresh', 'gradeSchemeChosen', 'wbNotes', 'chatLog',
    // the marking stage (15 Aug 23:40): the Harvard list the page keeps in
    // sync with the essay, and the dots Q placed inside the student's text.
    'references', 'inlineDots',
    // marks on ONE POINT of a question (16 Aug): keyed criterionId:stepId
    'stepMarks',
    // where she is in a Mark & fix walk (17 Aug: "when I refresh it goes back
    // to Q1") — { kind: 'mark' | 'part' | 'step', key, index, at }
    'editPos',
    // the per-part marks the page keeps (16 Aug) — dropped on refresh before.
    'partMarks',
    // the display (what Q has put on the whiteboard) and HER WORK AREA on it
    // (17 Aug). The page already restored `wbDoc`; it was never in this list,
    // so the board came back empty every refresh. `wbWork` is her own writing
    // on the board, keyed by part — it must never be lost.
    'wbDoc', 'wbWork', 'wbStickies',
    // HER POST-ITS ON THE PAGE (20 Aug) — the note, its colour and the spot on
    // the paper she left it at. Not part of the document: never marked, never
    // exported. Without this key they vanished on every refresh.
    'pageNotes',
    // Q's furniture on her PAGE — his highlights + notes and his paragraph tabs.
    // They lived in page state only, so every refresh wiped them (Q's own bug
    // report, 18 Aug: "tabs disappear on page refresh" — highlights did too).
    'qNotes', 'qTabs',
    // WHOSE WORDS (21 Aug): every passage Q composed that she put on her page,
    // so the mark can say which of it is still word for word his. Kept as the
    // text itself — nothing is written into her document.
    'qInk',
    // Which notes HE wrote (21 Aug) — so a note she typed herself is never
    // mistaken for his when the mark sweeps for AI words.
    'qWroteNotes',
    // Q's own notes on the TEACHING board (19 Aug) — boardItems itself is rebuilt
    // from the history on restore, so his notes had nowhere to come back from.
    'qBoardNotes',
    // what Q's reading of the page found (cuts, weak lines, spelling, grammar) —
    // the marking panel's counts come from this, so it must survive a refresh.
    'tidy',
];
router.post('/writer/tutor', requirePerson, express.json({ limit: '4mb' }), writerTooLarge('The session is too big to save in one go (over 4 MB). Trim very long pasted text out of the page and it will save again.'), async (req, res) => {
    try {
        const body = req.body || {};
        // A new assignment: wipe the notebook (the page asks for this when the
        // source is removed or replaced). Voice signature lives elsewhere.
        if (body.reset === true) {
            fs.writeFileSync(getTutorPath(writerScope(req)), JSON.stringify({ updatedAt: Date.now() }));
            return res.json({ ok: true, savedAt: Date.now(), reset: true });
        }
        const existing = readTutor(writerScope(req));
        const patch = {};
        for (const k of TUTOR_KEYS) if (body[k] !== undefined) patch[k] = body[k];
        // The brief is written by the brief job. A page may re-send it (the
        // chat fallback path builds one client-side) but never the skeleton —
        // keep the server's skeleton if the incoming brief lacks one.
        if (body.brief && typeof body.brief === 'object') {
            const incoming = { ...body.brief };
            if (!Array.isArray(incoming.idealAnswerSkeleton) && existing.brief && Array.isArray(existing.brief.idealAnswerSkeleton)) {
                incoming.idealAnswerSkeleton = existing.brief.idealAnswerSkeleton;
            }
            try { patch.brief = qWriter.normaliseBrief(incoming); } catch (_) { /* unusable brief — ignore, keep server's */ }
        }
        // A brief arriving from the page (quick-read fallback) still gets the
        // hidden model answer written behind it.
        const kickEssay = !!(patch.brief && !existing.brief);
        if (typeof patch.docText === 'string' && patch.docText.length > 400000) patch.docText = patch.docText.slice(0, 400000);
        const merged = writeTutor(writerScope(req), patch);
        if (kickEssay) startEssayJob(writerScope(req));
        res.json({ ok: true, savedAt: merged.updatedAt });
    } catch (e) {
        console.error('[writer/tutor store]', e.message);
        res.status(500).json({ error: 'Could not save the session: ' + String(e.message || '').slice(0, 160), code: 'save_failed' });
    }
});

// GET /writer/tutor — load the tutor notebook for this person (skeleton stripped).
router.get('/writer/tutor', requirePerson, async (req, res) => {
    try {
        const t = readTutor(writerScope(req));
        if (!t || !Object.keys(t).length) return res.json({ ok: true, tutor: null });
        const out = { ...t };
        if (out.brief) out.brief = publicBrief(out.brief);
        delete out.modelEssay;                       // the answer in Q's head stays in Q's head
        out.essayReady = !!t.modelEssay;
        out.sources = sourcesMeta(t.sources);
        out.match = matchFor(t);
        delete out.closeBricks;
        const job = writerJobs.get(writerJobKey(writerScope(req), 'brief'));
        // A brief with no answer behind it and no job running (restart
        // mid-write): start it again so the page's poll can land.
        const ej = ensureEssayJob(writerScope(req), t) || writerJobs.get(writerJobKey(writerScope(req), 'essay'));
        ukJson(res, { ok: true, tutor: out, briefJob: job ? { status: job.status, startedAt: job.startedAt } : null, essayJob: ej ? { status: ej.status, startedAt: ej.startedAt } : null });
    } catch (e) {
        res.json({ ok: true, tutor: null });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// (History: 2026-05-17 this route was made DORMANT in favour of the general
// /chat brain + a regex hunt for a fenced ```writer-brief block. Phase 1
// (15 Aug 2026) proved that path could never see the tasks in a real CIPD
// brief — the page sent only the first 12,000 chars. Phase 3 puts the brief
// back on this dedicated, structured route with the WHOLE document.)
// ─────────────────────────────────────────────────────────────────────────

// POST /writer/brief — Q reads the WHOLE brief and builds the structured
// tutor's brief (criteria, bands, ideal-answer skeleton, opener). Runs as a
// job so a long document cannot die at Railway's ~60s edge; the page polls
// GET /writer/job/brief. Body: { taskText, name } (stores the doc too) or
// {} to brief the doc already stored by /writer/doc. { sync:true } waits.
router.post('/writer/brief', requirePerson, express.json({ limit: '8mb' }), writerTooLarge('That document text is over 8 MB — the coach can hold about 2,000 pages of text. Upload only the part with the tasks and criteria.'), async (req, res) => {
    const personId = writerScope(req);
    let taskText = String(req.body?.taskText || '').trim();
    let name = String(req.body?.name || '').trim();
    // Sarah, 16 Aug: the brief can arrive as two files. {append:true} joins the
    // new text to the brief already stored here — server-side, so it works
    // after a refresh, when the page no longer holds the first file's text.
    if (taskText && req.body?.append) {
        const stored = readStoredDocText(personId);
        if (stored && stored.text && !stored.text.includes(taskText.slice(0, 200))) {
            const n = (stored.text.match(/^=== DOCUMENT \d+ of \d+/gm) || []).length;
            const first = n ? stored.text : '=== DOCUMENT 1: ' + (stored.name || 'document') + ' ===\n' + stored.text;
            taskText = first + '\n\n=== DOCUMENT ' + ((n || 1) + 1) + ': ' + (name || 'document') + ' ===\n' + taskText;
            name = (stored.name || 'document') + ' + ' + (name || 'document');
        }
    }
    if (taskText) {
        // Store the full text so every later step reads it server-side —
        // the page never re-sends the source (Phase 1 finding #5).
        try { fs.writeFileSync(getDocPath(personId), JSON.stringify({ text: taskText, name: name || 'document', savedAt: Date.now() })); } catch (e) { console.warn('[writer/brief] doc store failed:', e.message); }
    } else {
        const stored = readStoredDocText(personId);
        if (!stored) return res.status(400).json({ error: 'There is no task to read yet — drop the brief in first.', code: 'no_doc' });
        taskText = stored.text; name = name || stored.name;
    }
    if (taskText.length < 40) return res.status(400).json({ error: 'That is too short to be an assignment brief — paste the whole task, or upload the file with the questions in it.', code: 'too_short' });

    const job = startWriterJob(personId, 'brief', async () => {
        const brief = await qWriter.analyseAndBrief(taskText);
        const criteria = brief.criteria || [];
        // The brief read asks for the scenario as part of the brief — so the
        // story has been LOOKED FOR, story or none. Without this flag a brief
        // with no case study (CIPD 7HR02 questions, Sarah, 18 Aug) left the page
        // on "Q is pulling the scenario out of the brief for you…" for good.
        brief.scenarioChecked = true;
        writeTutor(personId, {
            brief,
            sourceName: name || 'document',
            coverage: Object.fromEntries(criteria.map(c => [c.id, 'none'])),
            currentQuestion: brief.opener,
            currentCriterionId: criteria[0] ? criteria[0].id : null,
            // legacy keys so recall_tutor still answers from any surface
            task: taskText.slice(0, 4000),
            whatItWants: brief.whatItWants,
            teachersBrief: brief.gradeBands ? brief.gradeBands.top : '',
            markedSections: criteria.map(c => ({ name: c.id, description: c.text })),
            gradeBands: brief.gradeBands || null,
            lastQuestion: brief.opener,
            currentSection: criteria[0] ? criteria[0].id : null,
            voicedBricks: [], brickCounts: {}, modelEssay: null,
            // Everything built from the OLD brief/essay goes too — a re-brief
            // with the same part ids was serving old plans whose steps pointed
            // at paragraphs that no longer existed.
            plans: {}, stepTags: {}, dotCache: {}, teachCache: {}, termsFit: {}, reqMet: {}, closeBricks: [], lastMark: null, partMarks: {},
        });
        // The model essay follows in the back room; the student starts on the
        // opener now and the probes pick the essay up when it lands.
        startEssayJob(personId);
        return brief;
    });
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        const view = jobView(job); if (view.result) view.result = publicBrief(view.result);
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...view }));
    }
    res.json({ ok: true, ...jobView(job), result: null, chars: taskText.length });
});

// POST /writer/lead — ask the next leading question for the current section
router.post('/writer/lead', requirePerson, express.json({ limit: '128kb' }), async (req, res) => {
    const { analysis, brief, history, voiceSignature, relateAnchor, yearGroup } = req.body || {};
    if (!analysis || !brief) return res.status(400).json({ error: 'analysis and brief required' });
    try {
        // Load the full document from the server-side store
        let docContext = null;
        try {
            const docPath = getDocPath(writerScope(req));
            if (fs.existsSync(docPath)) {
                const stored = JSON.parse(fs.readFileSync(docPath, 'utf8'));
                docContext = stored.text || null;
            }
        } catch (_) {}
        const result = await qWriter.askLeadingQuestion(
            analysis, brief, history || [], voiceSignature, relateAnchor, yearGroup, docContext
        );
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/lead]', 'leading question');
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
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/reframe]', 'reframe');
    }
});

// POST /writer/words — suggest word swaps for a clicked word
router.post('/writer/words', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const { word, context, voiceSignature } = req.body || {};
    if (!word) return res.status(400).json({ error: 'word required' });
    try {
        const result = await qWriter.suggestWordSwaps(word, context, voiceSignature);
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/words]', 'word swap');
    }
});

// POST /writer/harvard — format a source into a Harvard reference
router.post('/writer/harvard', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const sourceDescription = (req.body?.sourceDescription || '').toString().trim();
    if (!sourceDescription) return res.status(400).json({ error: 'sourceDescription required' });
    try {
        const result = await qWriter.formatHarvardRef(sourceDescription);
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/harvard]', 'reference formatting');
    }
});

// POST /writer/refs — suggest references for the current document
router.post('/writer/refs', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { docText, subject, keyConcepts } = req.body || {};
    try {
        const result = await qWriter.suggestReferences(docText, subject, keyConcepts);
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/refs]', 'reference suggestions');
    }
});

// POST /writer/explain — plain-English explanation of a concept + search terms
router.post('/writer/explain', requirePerson, express.json({ limit: '16kb' }), async (req, res) => {
    const { concept, subject, yearGroup } = req.body || {};
    if (!concept) return res.status(400).json({ error: 'concept required' });
    try {
        const result = await qWriter.explainConcept(concept, subject, yearGroup);
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/explain]', 'explanation');
    }
});

// POST /writer/mark-section — grade a completed section (red/amber/green)
// POST /writer/mark-part { criterionId, partText } — mark ONE question the
// moment she finishes it (Sarah, 16 Aug: "we need to have Q doing the mark and
// fix as you answer each question so you actually get direction"). Later the
// same night: "we need the full treatment of the mark and fix at every section
// we write." So it is the full Mark & fix for ONE part (q-writer.js markPart)
// — medium effort, up to ten fixes — and, like /writer/mark, it is a JOB:
// Railway's ~60s edge cannot kill it mid-call.
// Poll GET /writer/job/mark-part?criterionId=X; { sync:true } waits inline.
// The result lands in the notebook as partMarks[criterionId] and the terms /
// requirements it reports go into termsFit / reqMet like the sentence check.
router.post('/writer/mark-part', requirePerson, express.json({ limit: '256kb' }), writerTooLarge('That part is too long to mark in one go.'), async (req, res) => {
    const t = readTutor(writerScope(req));
    if (!t.brief) return res.status(400).json({ error: 'No brief yet — upload the task first.', code: 'no_brief' });
    const criterionId = String(req.body?.criterionId || '').replace(/\s+/g, '');
    if (!t.brief.criteria.some(c => c.id === criterionId)) return res.status(400).json({ error: 'That part is not in the brief.', code: 'bad_part' });
    const partText = String(req.body?.partText || '');
    const gradeScheme = String(req.body?.gradeScheme || t.gradeScheme || '');
    const scope = writerScope(req);
    // ONE POINT of the question (a finished step): { stepId, focus,
    // targetBrickIds } — the marks land on that bit of the page as soon as
    // she has written it, not at the end of the question. Its job is keyed
    // per step and it does NOT overwrite the question's own mark.
    const stepId = String(req.body?.stepId || '').replace(/\s+/g, '').slice(0, 40);
    const focus = stepId ? String(req.body?.focus || '') : '';
    const targetBrickIds = stepId && Array.isArray(req.body?.targetBrickIds) ? req.body.targetBrickIds.slice(0, 12) : [];
    // One job PER QUESTION (key mark-part:<criterionId>) — or per point
    // (mark-part:<criterionId>:<stepId>) — so nothing hands back another's result.
    const job = startWriterJob(scope, 'mark-part', async () => {
        const r = await qWriter.markPart({
            brief: t.brief,
            essay: t.modelEssay || null,
            plan: (t.plans || {})[criterionId] || null,
            criterionId,
            partText,
            gradeScheme,
            focus, targetBrickIds, stepId: stepId || null,
        });
        const ex = noteExpectations(scope, criterionId, r.termsUsed || [], r.requirementsMet || []);
        const saved = { ...r, at: Date.now() };
        // Merge: one entry per question, the others stay as they were. A
        // point's mark rides along under stepMarks so a refresh keeps the dots.
        const cur = readTutor(scope);
        const patch = stepId
            ? { stepMarks: { ...(cur.stepMarks || {}), [criterionId + ':' + stepId]: saved } }
            : { partMarks: { ...(cur.partMarks || {}), [criterionId]: saved } };
        const t2 = writeTutor(scope, patch);
        return { ...saved, termsFit: t2.termsFit || (ex && ex.termsFit) || {}, reqMet: t2.reqMet || (ex && ex.reqMet) || {} };
    }, { criterionId, stepId: stepId || null, keySuffix: stepId ? criterionId + ':' + stepId : criterionId });
    if (req.body?.sync) {
        while (job.status === 'running') await new Promise(r => setTimeout(r, 250));
        return res.status(job.status === 'done' ? 200 : (job.error?.status || 502)).json(qWriter.ukPolishResponse({ ok: job.status === 'done', ...jobView(job) }));
    }
    ukJson(res, { ok: true, ...jobView(job) });
});

router.post('/writer/mark-section', requirePerson, express.json({ limit: '64kb' }), async (req, res) => {
    const { sectionText, sectionName, analysis, gradeScheme } = req.body || {};
    if (!sectionText) return res.status(400).json({ error: 'sectionText required' });
    try {
        const result = await qWriter.markSection(sectionText, sectionName, analysis, gradeScheme);
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/mark-section]', 'section marking');
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
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/improve]', 'improvement tips');
    }
});

// POST /writer/ref-para — suggest references for a highlighted paragraph
router.post('/writer/ref-para', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const { paragraphText, subject, keyConcepts } = req.body || {};
    if (!paragraphText) return res.status(400).json({ error: 'paragraphText required' });
    try {
        const result = await qWriter.referenceParagraph(paragraphText, subject, keyConcepts);
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/ref-para]', 'paragraph references');
    }
});

// POST /writer/starter — Q writes a basic starter sentence when asked; respects word budget
router.post('/writer/starter', requirePerson, express.json({ limit: '32kb' }), async (req, res) => {
    const { question, context, voiceSignature, relateAnchor, yearGroup, qWordsWritten } = req.body || {};
    try {
        const result = await qWriter.writeStarter(
            question || '', context, voiceSignature, relateAnchor, yearGroup, qWordsWritten || 0
        );
        ukJson(res, { ok: true, ...result });
    } catch (e) {
        writerFail(res, e, '[writer/starter]', 'starter sentence');
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
router.post('/chat', requirePerson, express.json({ limit: '24mb' }),
    // Oversized payloads (a batch of full-res photos) used to surface as an
    // unhandled 500 "Server error". Same honest-413 pattern as the finance
    // statement route — tell the user what's wrong and what to do.
    (err, req, res, next) => {
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ error: "That message was too big to send — usually a very large photo. Try again with fewer photos at once, and they'll be shrunk on the way in." });
        }
        if (err) return next(err);
        next();
    },
    async (req, res) => {
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
        // DIAGNOSTIC (remove once the "loses context after 2 messages" cause is
        // confirmed): one line that answers everything. `total` = messages in the
        // file; `sending` = turns handed to the model this request. If `total`
        // stays ~0 while you keep chatting, the file isn't persisting/loading
        // (path/volume) — that's the bug, not the chat logic. If `total` grows
        // but Q still forgets, history reaches the model and it's prompt/model.
        try {
            const _mp = getMemoryPath(person.id);
            const _exists = fs.existsSync(_mp);
            const _size = _exists ? fs.statSync(_mp).size : 0;
            console.log(`[chat-mem] person=${person.id} surface=${surface} total=${allMessages.length} thisSurface=${surfaceMessages.length} sending=${rawHistory.length} file=${_mp} exists=${_exists} bytes=${_size}`);
        } catch (e) {
            console.log(`[chat-mem] person=${person.id} surface=${surface} total=${allMessages.length} sending=${rawHistory.length} (path probe failed: ${e.message})`);
        }
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
            // AN INDEX, NOT THE CONTENTS (20 Aug 2026 — Sarah: "I dont want
            // hundreds of messages sat in his brain so they need to be in a place
            // where hed have to search").
            //
            // This used to paste the last FIVE messages of EVERY other page into
            // every single turn, at 300 characters each — a few thousand tokens
            // of other people's conversations riding along on "what's for tea",
            // paid for on every message, forever. It existed because it was the
            // only way Q could know those conversations were there.
            //
            // read_page_history replaced that: he can now search the whole record
            // and get the actual exchange back, on demand. So all he needs riding
            // along is a contents page — what exists, how big, how recent — and
            // the knowledge that he can go and read it. Long-term memory belongs
            // in a drawer he opens, not stapled to his forehead.
            const lines = otherEntries.map(([s, msgs]) => {
                const last = msgs[msgs.length - 1];
                const when = last && last.timestamp ? last.timestamp.slice(0, 16).replace('T', ' ') : 'unknown';
                return `  · ${s.toUpperCase()} page — ${msgs.length} message${msgs.length === 1 ? '' : 's'}, last ${when}`;
            }).join('\n');
            crossRef = `\n\n--- YOUR OTHER CONVERSATIONS WITH THEM (an index, not the contents) ---\n${lines}\n`
                + `You have ALSO talked to them on the pages above, and everything ever said is kept.\n`
                + `You are only shown the recent part of THIS page, so something you genuinely said may not be in front of you.\n`
                + `If they refer to anything you cannot see — "you told me…", "do you remember…", "we talked about…" — use read_page_history\n`
                + `with a search term and GO AND LOOK before you say you don't remember it. Telling them a conversation never happened,\n`
                + `when the record says otherwise, is the one mistake here that actually costs their trust.\n--- END ---`;
        }
        // FOLLOW-THROUGH (20 Aug 2026). Anything whose chase-time has passed
        // gets put in front of Q here, so he raises it himself at the top of his
        // reply instead of waiting to be asked. Reading them counts as raising
        // them — see q-followup.js — which is what stops the same unsent email
        // being brought up forever. Never let this break a chat: if the chase
        // store is unreadable, Q simply carries on without it.
        let chaseBlock = '';
        try {
            chaseBlock = require('./plugins/q-followup').chaseContextBlock(person.email);
        } catch (e) {
            console.warn('[chat] chase block unavailable: ' + e.message);
        }

        history.unshift({
            role: 'system',
            content: `It is now ${nowStr} (UTC). You're talking to ${person.name}. The history below shows previous turns between you two with their timestamps — note any gaps between sessions and respond as someone who has had time pass, not as if every turn just happened.${crossRef}${chaseBlock}`,
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
    // Only return the most recent slice for DISPLAY. Rendering the whole history
    // (which can be thousands of messages / several MB) synchronously on page load
    // froze the chat ~10s — worst on phones. The model still gets its own
    // 50-message window on each /chat turn and facts persist, so capping what the
    // page draws costs nothing but the freeze. `total` lets the UI add a "load
    // older" control later without another round-trip guess.
    const total = messages.length;
    return res.json({ messages: messages.slice(-80), total, storedAt: getMemoryPath(req.person.id) });
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
router.post('/extract-text', requirePerson, express.json({ limit: '50mb' }), writerTooLarge('That file is over 36 MB — too big to read here. Export the brief as a PDF without images, or upload only the pages with the tasks and criteria.'), async (req, res) => {
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
                // A scanned PDF parses to (almost) nothing — say so, so the
                // page can refuse politely instead of briefing an empty doc.
                warning: pdfText.length < 200 ? 'That PDF came back nearly empty — it is probably scanned images, not text. Try a PDF with real text, or paste the task as text.' : undefined,
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
                warning: docxText.length < 200 ? 'That Word file came back nearly empty — it may be images only. Try a PDF with real text, or paste the task as text.' : undefined,
            });
        }
        if (mimeType === 'application/msword' || lowerName.endsWith('.doc')) {
            return res.status(400).json({ error: 'Old Word .doc files can\'t be read here — open it in Word and save as .docx (or PDF), then try again.', code: 'unsupported' });
        }
        return res.status(400).json({ error: 'That file type isn\'t supported — try PDF, Word (.docx), an image, or plain text.', code: 'unsupported' });
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

// ── Music — RETIRED 2026-08-15 (GET /music, POST /music/generate). No licensing /
// commercial-use statement for the generated audio. Page, plugin and HF Space moved
// to retired/2026-08-15-voice-clone-and-music/ — see RETIRED.md there.

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

// Brand marks for the finance page — banks and merchants. Served from
// Q's own cache so the browser never tells a logo host what's on the
// statement (see plugins/q-logos.js). 404 = "use the monogram".
const qLogos = require('./plugins/q-logos');
router.get('/api/logo', requirePerson, async (req, res) => {
    const name = String(req.query.name || '').slice(0, 120);
    const bank = String(req.query.bank || '').slice(0, 40);
    try {
        const hit = await qLogos.getLogo({ name, bank });
        if (!hit) {
            res.setHeader('Cache-Control', 'private, max-age=86400');
            return res.status(404).end();
        }
        res.setHeader('Content-Type', hit.mime);
        res.setHeader('Cache-Control', 'private, max-age=604800');
        res.end(hit.buf);
    } catch (e) {
        console.warn('[q-logos]', e.message);
        res.status(404).end();
    }
});

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

// Income sources — credits grouped by payer, self-transfers excluded.
router.get('/api/finance/income', requirePerson, (req, res) => {
    res.json(qFinance.detectIncome(req.person.email));
});

// The money rhythm — weekly / monthly / bills, in and out.
router.get('/api/finance/rhythm', requirePerson, (req, res) => {
    res.json(qFinance.detectRegulars(req.person.email));
});

// What's coming in and when — a forward projection from the observed pattern.
router.get('/api/finance/forecast', requirePerson, (req, res) => {
    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks, 10) || 12));
    res.json(qFinance.forecastIncome(req.person.email, weeks));
});

// What the charges cost — penalties (avoidable) kept apart from account fees.
router.get('/api/finance/charges', requirePerson, (req, res) => {
    res.json(qFinance.detectCharges(req.person.email));
});

// The accounts the app has recognised from the statements themselves —
// bank, product, last 4, and each one's live totals.
router.get('/api/finance/accounts', requirePerson, (req, res) => {
    res.json(qFinance.getAccountsWithTotals(req.person.email));
});

// The balance the user can see in their banking app. Statements carry only
// movements, so this is the number that turns them into "what have I got" —
// and lets the app check whether it read the whole statement.
router.post('/api/finance/accounts/:id/balance', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    const updated = qFinance.setAccountBalance(req.person.email, req.params.id, req.body && req.body.balance, req.body && req.body.asAt);
    if (!updated) return res.status(400).json({ error: 'Unknown account, or that balance was not a number.' });
    res.json(updated);
});

// Balances from a screenshot of a banking app — reads every account visible
// on the screen in one go, so someone with a dozen accounts doesn't type a
// dozen numbers.
router.post('/api/finance/accounts/screenshot', requirePerson, express.json({ limit: '12mb' }), async (req, res) => {
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    console.log(`[finance] balance screenshot — ${req.person.email} — mimeType:${mimeType}`);
    try {
        const result = await qFinance.importBalancesFromScreenshot(req.person.email, imageBase64, mimeType);
        res.json(result);
    } catch (e) {
        console.error('[finance] balance screenshot error', e);
        res.status(500).json({ error: 'Could not read that screenshot — try a clearer one.' });
    }
});

// Import statement text (paste or extracted from PDF)
router.post('/api/finance/statement', requirePerson, express.json({ limit: '2mb' }), async (req, res) => {
    const { text, filename } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    console.log(`[finance] statement text import — ${req.person.email} — ${text.length} chars — ${filename || '(no filename)'}`);
    try {
        const result = await qFinance.importStatement(req.person.email, text, { filename, ownerName: req.person.name });
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
    const { imageBase64, mimeType, filename } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    console.log(`[finance] statement file import — ${req.person.email} — mimeType:${mimeType}`);
    try {
        // Multi-page PDFs take minutes — run in the background so the upload
        // request can't time out and falsely report failure. The page polls
        // /api/finance/statement/job for progress and the result.
        const job = qFinance.startImportJob(req.person.email, imageBase64, mimeType || 'application/pdf', filename, req.person.name);
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

// Re-run the category labeller over rows still sitting in 'other' — the
// "Sort categories" button. Only 'other' rows are touched, so nothing a
// user has hand-set can be overwritten. Synchronous: the server finishes
// and saves even if the phone stops waiting for the response.
router.post('/api/finance/recategorise', requirePerson, express.json({ limit: '4kb' }), async (req, res) => {
    try {
        const result = await qFinance.recategoriseOther(req.person.email);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[finance] recategorise error', e);
        res.status(500).json({ error: e.message });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// DOC DROP PARITY (21 Aug 2026) — folders + the notes board.
// Ported from Quoteapp's Doc Drop (routes/doc-drop.js folder routes and
// routes/doc-cases.js tab routes). Nothing here replaces an existing route:
// the flat `notes` list, `refs`, `contacts` and `emails` all keep their own
// endpoints and keep working exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

// ── Folders: organise a case's files (personalisable, no AI cost) ────────────
router.get('/api/threads/:id/folders', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    res.json({ folders: qThreads.listFolders(req.params.id, req.person.email), icons: qThreads.FOLDER_ICON_SLUGS });
});

router.post('/api/threads/:id/folders', requirePerson, express.json({ limit: '8kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const folder = qThreads.addFolder(req.params.id, req.body || {}, req.person.email);
    if (!folder) return res.status(400).json({ error: 'A folder needs a name' });
    res.json({ folder, folders: qThreads.listFolders(req.params.id, req.person.email) });
});

router.patch('/api/threads/:id/folders/:folderId', requirePerson, express.json({ limit: '8kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const folder = qThreads.updateFolder(req.params.id, req.params.folderId, req.body || {}, req.person.email);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    res.json({ folder, folders: qThreads.listFolders(req.params.id, req.person.email) });
});

// Deleting a folder UNFILES its documents — it never deletes them.
router.delete('/api/threads/:id/folders/:folderId', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeFolder(req.params.id, req.params.folderId, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Folder not found' });
    res.json({ ok: true, folders: qThreads.listFolders(req.params.id, req.person.email), thread: updated });
});

// Move a file into a folder (or out of one with folderId: null / '').
router.patch('/api/threads/:id/files/:filename/folder', requirePerson, express.json({ limit: '4kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const file = qThreads.setFileFolder(req.params.id, req.params.filename, req.body?.folderId || null, req.person.email);
    if (!file) return res.status(404).json({ error: 'File not found on this case' });
    res.json({ file, thread: qThreads.readThread(req.params.id, req.person.email) });
});

// ── The notes board: tabs, each tab ONE markdown note ────────────────────────
router.get('/api/threads/:id/tabs', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    res.json({ tabs: qThreads.listTabs(req.params.id, req.person.email) });
});

router.post('/api/threads/:id/tabs', requirePerson, express.json({ limit: '128kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const tab = qThreads.addTab(req.params.id, req.body || {}, req.person.email);
    if (!tab) return res.status(400).json({ error: 'A tab needs a name' });
    res.json({ tab, tabs: qThreads.listTabs(req.params.id, req.person.email) });
});

router.patch('/api/threads/:id/tabs/:tabId', requirePerson, express.json({ limit: '128kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const tab = qThreads.updateTab(req.params.id, req.params.tabId, req.body || {}, req.person.email);
    if (!tab) return res.status(404).json({ error: 'Tab not found' });
    res.json({ tab, tabs: qThreads.listTabs(req.params.id, req.person.email) });
});

router.delete('/api/threads/:id/tabs/:tabId', requirePerson, (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const updated = qThreads.removeTab(req.params.id, req.params.tabId, req.person.email);
    if (!updated) return res.status(404).json({ error: 'Tab not found' });
    res.json({ ok: true, tabs: qThreads.listTabs(req.params.id, req.person.email) });
});

// Tuck tabs under a collapsible header (group:'' clears it).
router.patch('/api/threads/:id/tab-group', requirePerson, express.json({ limit: '8kb' }), (req, res) => {
    if (!readOwnedThread(req, res)) return;
    const r = qThreads.groupTabs(req.params.id, req.body?.group || '', req.body?.tabs || [], req.person.email);
    res.json({ ...r, tabs: qThreads.listTabs(req.params.id, req.person.email) });
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
    // A case BRIEF (an app-maintained fact-summary note) is what lets the raw docs
    // stay out of a normal turn safely. Until that brief exists, do NOT gate the
    // documents — inject them every turn as before, so Q is never blind to the case.
    // Once the brief exists, the gate below ("wantContent") takes over and the raw
    // docs only load when actually needed.
    const hasBrief = noteList.some(n => n && n.kind === 'brief' && String(n.content || '').trim().length > 200);
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

    // Show Q the drafts already sitting in THIS case's Outbox. Without this he is
    // blind to his own outbox: he can't see what he saved, can't reuse a draft's
    // id (so every rewrite becomes a NEW draft instead of updating the old one),
    // and can't reconcile "there should be two, why are there four". Injecting the
    // id + subject + recipient + timestamps lets him revise in place via draft_id
    // and answer "what's in my outbox" accurately.
    try {
        const threadDrafts = (qEmail.getOutbox(req.person.email) || []).filter(d => d && d.threadId === t.id);
        if (threadDrafts.length) {
            const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return 'unknown time'; } };
            const lines = threadDrafts.map(d => {
                const made = d.createdAt ? fmt(d.createdAt) : 'unknown time';
                const upd = d.updatedAt ? `, last edited ${fmt(d.updatedAt)}` : '';
                const snippet = String(d.body || '').replace(/\s+/g, ' ').slice(0, 200);
                return `• draft_id: ${d.id} — "${d.subject || '(no subject)'}" -> to: ${d.to || '(no recipient yet)'} (saved ${made}${upd})\n  ${snippet}`;
            }).join('\n\n');
            messages.push({ role: 'user', content: `These email drafts are ALREADY in this case's Outbox right now:\n\n${lines}\n\nWhen you revise one of these, call save_email_draft WITH its draft_id so it UPDATES that same draft in place — do NOT create a new one. There should be ONE draft per email you're working on, not a new copy each rewrite. If I ask what's in my outbox, THIS list is the truth — don't guess.` });
            messages.push({ role: 'assistant', content: 'I can see the current outbox drafts and their ids — I will update them in place, not duplicate them.' });
        }
    } catch (e) { console.warn('[threads] could not inject outbox drafts: ' + e.message); }

    // Case history window. Clipped to 15 originally because the WHOLE-CASE dump
    // (read_thread pulling other cases verbatim) ballooned the prompt to 80k+
    // tokens and the model started hallucinating tools. That balloon is now capped
    // independently (capToolResult), so the active-case history can be generous
    // again. 15 was pointlessly tight: across sessions Q lost what he and the user
    // had already settled, so he'd contradict "the last Q" and re-ask the same
    // questions on a long-running case (Sarah's council-tax case did exactly this).
    // 40 messages of THIS case ≈ a few thousand tokens — fine for GLM-5.2 (the
    // case chat model, a reasoning model with ample context) and restores
    // cross-session continuity.
    const fullHistory = (t.chatHistory || []).filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
    const recentHistory = fullHistory.slice(-40);
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
    // Sarah's design: work from the case notes/summary on a normal turn, but RE-READ
    // all the documents at the two moments accuracy actually matters, so the summary
    // can never drift unchecked:
    //   • before drafting/redrafting a sendable document (a mistake in a sent letter
    //     is the worst place for one), and
    //   • periodically (~every 10 replies / 20 messages) as a drift catch.
    // On every other turn the raw docs stay out of the prompt (the file list + notes
    // carry the case), which is what keeps a doc-heavy case cheap.
    const isDrafting = /\b(draft|redraft|rewrite|compose|finali[sz]e|write (it|the|a|an|me|up|out)|put (it|this) together)\b/i.test(message);
    const qReplies = (t.chatHistory || []).filter(m => m && m.role === 'assistant').length;
    const dueForReVerify = qReplies > 0 && qReplies % 10 === 0;
    // wantExtract: whether to run Gemini extraction on uncached files (costs time/money).
    // wantInject: whether to inject already-cached content — always true so Q never
    // loses context he already has.
    const wantExtract = isAddPing || refersToFile || isKickoff || isTestModel || isDrafting || dueForReVerify;
    // lean turn (e.g. the "Ask Q to fix" hand-off after a fact-check): the fact-
    // check already verified the draft against the documents, so Q just applies the
    // listed fixes to the draft — it does NOT need all the raw docs re-loaded. The
    // outbox draft + notes are still injected, so keep this fast and avoid the
    // timeout that left the user staring at "Q's not doing anything".
    const lean = req.body?.lean === true;
    const wantContent = !lean && wantExtract; // kept for backward compat with image/video blocks below

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
            const isDocx = /\.docx$/i.test(f.filename || '') || /officedocument\.wordprocessingml/i.test(f.mimeType || '');
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
                let text = _threadDocCache.has(cacheKey) ? _threadDocCache.get(cacheKey) : null;
                // Treat an EMPTY cached value as a miss, not a fact. An empty
                // extraction is a failure (e.g. Gemini was down during the model
                // retirement) — caching it permanently blinded Q to a real document.
                // Re-read whenever the cached text is blank.
                if (!text || !String(text).trim()) {
                    // Cold-start: check the persistent per-thread bucket on disk first.
                    // This survives Railway restarts so Gemini is never called twice for
                    // the same file. Falls through to extraction only on the first-ever read.
                    const persisted = qThreads.getTextCache(t.id, f.filename, req.person.email);
                    if (persisted !== null && String(persisted).trim()) {
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
                        } else if (isDocx) {
                            // .docx is zipped XML — reading the raw bytes gives binary
                            // (the "decoded as binary — skipping" case that blinded Q to
                            // Word docs on a case). mammoth pulls the real text out.
                            try {
                                const mammoth = require('mammoth');
                                text = (await mammoth.extractRawText({ buffer: file.buffer })).value || '';
                            } catch (e) {
                                console.warn(`[threads] mammoth failed on "${f.filename}": ${e.message}`);
                                text = '';
                            }
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
                // Inject the FULL raw document text ONLY when this turn needs it:
                // the first sweep of the case (kickoff), a just-added file, or when
                // the user refers to a document/file. On a normal follow-up turn we
                // do NOT re-send the raw documents — the file LIST is always shown
                // (above) and the case notes + recent chat carry what was read. This
                // is what stops a doc-heavy case re-sending 60k tokens of raw files on
                // EVERY message (GLM is not cached on Together, so each re-send is paid
                // in full — that was the credit burn). Mention a file and it loads
                // again that turn; otherwise he works from the notes/brief.
                if (block && (wantContent || !hasBrief)) messages.splice(messages.length - 1, 0, { role: 'user', content: block });
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

    // Uploaded document text — pull from the persistent per-thread cache (cheap
    // disk read; already-extracted text). Without this the verifier never saw the
    // case's files and kept demanding documents that were actually uploaded. If a
    // file hasn't been read to text yet, at least name it so Claude knows it exists.
    const fileContext = (t.files || []).map(f => {
        let txt = '';
        try { txt = qThreads.getTextCache(t.id, f.filename, req.person.email) || ''; } catch (e) { /* not cached */ }
        return txt
            ? `[DOCUMENT: ${f.filename}]\n${String(txt).slice(0, 8000)}`
            : `[DOCUMENT: ${f.filename} (${f.mimeType || 'file'}) — uploaded but not yet read into text]`;
    }).join('\n\n');

    const caseContext = [
        t.title ? `Case: ${t.title}` : '',
        // Notes are stored as n.content (not n.text) — the old n.text read nothing,
        // so the verifier never saw the case summary. Include kind for context.
        (t.notes || []).map(n => `[NOTE${n.kind ? ' — ' + n.kind : ''}]\n${(n.content || '').trim()}`).filter(s => s.length > 8).join('\n\n'),
        (t.emails || []).map(e => `[${e.type === 'in' ? 'Received' : e.type === 'draft' ? 'Draft' : 'Sent'} — ${e.subject || ''}]\n${e.body || ''}`).join('\n\n'),
        fileContext,
        outboxDrafts,
        (t.chatHistory || []).slice(-10).filter(m => m.role === 'assistant').map(m => `[Q said]\n${(m.content || '').slice(0, 600)}`).join('\n\n'),
    ].filter(Boolean).join('\n\n');

    const system = `You are a sharp draft reviewer working FOR the user — on their side. You have the full case context. Your job is to tell them AT A GLANCE what is solid and what to fix before they send. Direct and honest, but never rude and never preachy — you are their ally, not their opponent.

FORMAT YOUR ANSWER EXACTLY LIKE THIS, in markdown, so it can be scanned in seconds:

**VERDICT: ✅ SEND IT** — or — **VERDICT: ⚠️ FIX THESE FIRST** — or — **VERDICT: ❌ DO NOT SEND**

Then a list, ONE line per point, and EVERY line must start with ✅, ❌ or ⚠️:
- ✅ what is solid — and, where it's a legal point, name the law/regulation that backs it
- ❌ what is genuinely wrong — say "remove this" / "fix this" and exactly why
- ⚠️ what is risky or you can't confirm — say what to double-check

THE FACTS THE USER STATES ARE THEIRS TO STATE — this matters most:
- Figures, dates and events the user asserts about their OWN situation — what their account made or lost, their own dates, what happened to them — are legitimate inputs. Take them as given. You do NOT have their bank feed or their records, and NOT seeing a number in the case files does NOT make it false.
- If a figure genuinely matters and you can't confirm it, the MOST you may do is ONE calm ⚠️ line: "Couldn't confirm [X] from the files — just make sure it's right before sending." That is the ceiling.
- NEVER call the user's own stated facts "fabricated" or "unverifiable" as grounds to refuse. NEVER refuse to review or help. NEVER moralize, lecture, or draw "a line". You flag and advise; the user decides what to send. Reserve ❌ for things that are actually WRONG — a law that doesn't exist, a claim that contradicts the case files, or a figure the DRAFT invented that the user never gave — never for the user's own account of what happened.

Other rules:
- No hedging or vagueness: no "may be / could be / perhaps / might come across as". Each point is a clear ✅, ⚠️ or ❌.
- Don't critique the draft's politeness or writing style — judge substance and accuracy only.
- Recipient: if the To field is blank/missing → a ❌ line "NO RECIPIENT — add the email address before sending." If it looks wrong for the case → ❌ and why.
- If it's clean: "**VERDICT: ✅ SEND IT**", then a couple of ✅ lines on why. No padding.
- One line per point. No paragraphs, no waffle. The user scans the ticks and crosses.`;

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
        `ACCOUNT HOLDER (the person logged in): ${person.name || '(name unknown)'}${person.email ? ' <' + person.email + '>' : ''}.`,
        'CRITICAL — WORK OUT WHO THIS FORM IS FOR before filling any personal details.',
        '• If the case shows the account holder is doing this for THEMSELVES, the applicant/claimant/"you" fields (name, title, signature, email, address, contact) are theirs — fill them from the account holder above.',
        '• But if the case is being handled ON BEHALF OF someone else — a friend, client or family member (e.g. the notes say "a friend asked me to help" or name a different applicant) — then the APPLICANT IS THAT OTHER PERSON, NOT the account holder. Fill the applicant fields from THAT person\'s details found in the case. If a required applicant detail (their email, address, phone, etc.) is NOT in the case, put it in "ask" — do NOT fall back to the account holder\'s email or address. Never put the account holder\'s email/address on a form that is for someone else.',
        factLines ? `Known about the account holder:\n${factLines}` : '',
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
        // Only pre-fill signature fields with the account holder's name if the
        // extract actually treated THEM as the applicant (their name landed in a
        // filled value). On a form handled for someone else, signing as the
        // account holder is wrong — leave it blank so the real applicant's name
        // (or a hand signature) goes there instead.
        if (req.person.name) {
            const me = req.person.name.trim().toLowerCase();
            const accountHolderIsApplicant = Object.values(filled).some(v =>
                typeof v === 'string' && v.trim().toLowerCase() === me);
            if (accountHolderIsApplicant) {
                for (const f of fields) {
                    const isSignature = f.type === 'signature' ||
                        /sign/i.test(f.name || '') ||
                        /sign/i.test(f.label || '');
                    if (isSignature && !filled[f.name]) filled[f.name] = req.person.name;
                }
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
const Q_CONFIG_THREAD_MODEL = (() => { try { return require('./config').Q_CONFIG.threadModel || null; } catch (_) { return null; } })();
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
// Repeating series — materialises the next months of dated entries in one go.
router.post('/life/events/repeat', requirePerson, express.json({ limit: '16kb' }), (req, res) => {
    try { res.json(qLife.addRepeatingEvent(req.body || {}, req.person.email)); }
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

// ── Voice cloning — RETIRED 2026-08-15 ─────────────────────────────────────
// Removed routes: GET /voice-clone, GET /q-voice/status, POST /q-voice/save-from-upload,
// POST /q-voice/save-from-url, POST /q-voice/reset, POST /voice-clone/from-url,
// POST /speak-as-voice. Reason: no consent gating; could clone a voice off any URL
// via yt-dlp (GDPR Art. 9 biometric + passing-off exposure). Everything moved to
// retired/2026-08-15-voice-clone-and-music/ — see RETIRED.md there.
// /voices (client-side Kokoro voice PICKER, no cloning) stays.

router.get('/voices', (req, res) => {
    res.sendFile(path.join(__dirname, 'voices.html'));
});

module.exports = router;
