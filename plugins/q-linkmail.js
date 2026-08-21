'use strict';

/**
 * Q LINKMAIL — the public, token-gated share link.
 *
 * "Quotem linkmail" is Sarah's name for it (coined 20 May 2026) and it is a
 * proper noun: never rename it to "share link" or "magic link". This is the
 * quotem-ai engine for the same feature QB2 has in the Quotem app
 * (server/routes/linkmail.js there) — same payload shape, same question model,
 * so a link made by Q reads like a link made by QB2.
 *
 * WHAT IT IS
 *   Q (or a page) mints a link. The recipient opens it with NO account and NO
 *   sign-in — the token in the URL is the whole authority. They read what was
 *   shared, answer the questions on the card, and can talk to a scoped,
 *   tool-less Q that knows ONLY the snapshot on that link. The sender reads the
 *   answers back on their own page.
 *
 * THE THREE FEEDERS
 *   kind 'note'   — Q sharing anything he has in front of him
 *   kind 'trip'   — destination postcards; the family ticks dates and places
 *   kind 'thread' — a case: what happened, and what you need back
 *
 * STORAGE — the payload lives in the SENDER'S user directory, exactly like
 * threads, so no feature can read across users. The only global file is a tiny
 * index (token -> owner) because a public request arrives knowing nothing but
 * the token. The index holds no content: whoever has the token can already read
 * the link, which is the entire point of a share link.
 *
 *   ${VOLUME}/linkmail-index/{token}.json          { owner, createdAt }
 *   userDataPath(owner, 'linkmail/{token}.json')   the whole record
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataPath } = require('./user-data');

const INDEX_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'linkmail-index')
    : path.join(__dirname, '..', 'data', 'linkmail-index');

const MAX_HOURS = 24 * 90;          // 90 days, same ceiling as the Quotem app
const DEFAULT_HOURS = 24 * 14;      // a fortnight — long enough for family to reply

// ─────────────────────────────────────────────────────────────
//  QUESTION MODEL — ported from the Quotem app's
//  server/services/linkmail-questions.js so both apps speak the same shape.
//  Runs on create AND on read, so it must stay idempotent.
// ─────────────────────────────────────────────────────────────

const S = (v, n) => String(v == null ? '' : v).slice(0, n);
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
// An expr is arithmetic over numbers + identifiers ONLY (x = the slider value,
// m = a marker's value, plus named constants/inputs). Anything else is rejected,
// which is what lets the page compute it live without eval.
const EXPR_OK = /^[\sxX0-9_a-zA-Z()+\-*/.%]+$/;

const normOutput = (o) => ({
    label: S(o && o.label, 80) || 'Result',
    expr: S(o && o.expr, 240),
    unit: S(o && o.unit, 8),
    prefix: S(o && o.prefix, 8),
});

function normSlider(s) {
    if (!s || typeof s !== 'object') return null;
    const min = numOr(s.min, 0);
    const max = numOr(s.max, 100);
    const lo = Math.min(min, max), hi = Math.max(min, max);
    const step = Math.max(0.0001, numOr(s.step, Math.max(1, Math.round((hi - lo) / 100)) || 1));
    const spec = {
        min, max, step,
        default: Math.min(Math.max(numOr(s.default, lo), lo), hi),
        label: S(s.label, 120),
        unit: S(s.unit, 8),
        prefix: S(s.prefix, 8),
        constants: {},
        outputs: [],
        inputs: [],
        markers: [],
    };
    if (s.constants && typeof s.constants === 'object') {
        for (const k of Object.keys(s.constants).slice(0, 24)) {
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
                const n = Number(s.constants[k]);
                if (Number.isFinite(n)) spec.constants[k] = n;
            }
        }
    }
    if (Array.isArray(s.outputs)) {
        spec.outputs = s.outputs.slice(0, 8).map(normOutput).filter(o => o.expr && EXPR_OK.test(o.expr));
    }
    // Inputs — figures the RECIPIENT types straight onto the card. Each becomes
    // a named variable in every expr, overriding a same-named constant.
    if (Array.isArray(s.inputs)) {
        spec.inputs = s.inputs.slice(0, 6).map(i => ({
            name: /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String((i && i.name) || '')) ? String(i.name) : '',
            label: S(i && i.label, 80),
            prefix: S(i && i.prefix, 8),
            unit: S(i && i.unit, 8),
            default: numOr(i && i.default, 0),
        })).filter(i => i.name && i.label);
    }
    // Markers — pins on the track. A marker's own outputs may also use m.
    if (Array.isArray(s.markers)) {
        spec.markers = s.markers.slice(0, 8).map(m => ({
            value: numOr(m && m.value, null),
            label: S(m && m.label, 40),
            color: /^#[0-9a-fA-F]{3,8}$/.test(String((m && m.color) || '')) ? String(m.color) : '',
            outputs: Array.isArray(m && m.outputs)
                ? m.outputs.slice(0, 4).map(normOutput).filter(o => o.expr && EXPR_OK.test(o.expr))
                : [],
        })).filter(m => m.value != null && Number.isFinite(m.value) && m.label);
    }
    if (s.points && typeof s.points === 'object') {
        const expr = S(s.points.expr, 240);
        if (expr && EXPR_OK.test(expr)) {
            const rawMax = s.points.max;
            spec.points = {
                label: S(s.points.label, 80) || 'Points',
                expr,
                min: numOr(s.points.min, 0),
                // max is OPTIONAL and must be the real weighting — a defaulted
                // 100 prints "/ 100" on the card and reads as a lie.
                max: (rawMax == null || !Number.isFinite(Number(rawMax))) ? null : Number(rawMax),
                unit: S(s.points.unit, 8),
                color: /^#[0-9a-fA-F]{3,8}$/.test(String(s.points.color || '')) ? String(s.points.color) : '',
            };
        }
    }
    return spec;
}

const QUESTION_TYPES = ['buttons', 'checklist', 'text', 'slider', 'dates'];

function normalizeQuestions(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const raw of arr.slice(0, 100)) {
        // Lazy input: a plain string becomes a simple buttons question.
        if (typeof raw === 'string') {
            const text = S(raw, 500).trim();
            if (text) out.push({ text, type: 'buttons', options: [] });
            continue;
        }
        if (!raw || typeof raw !== 'object') continue;
        const text = S(raw.text, 500).trim();
        if (!text) continue;
        const type = QUESTION_TYPES.includes(raw.type) ? raw.type : 'buttons';
        const options = Array.isArray(raw.options)
            ? raw.options.map(o => S(o, 120).trim()).filter(Boolean).slice(0, 40)
            : [];
        const q = { text, type, options };
        if (type === 'slider') {
            const sp = normSlider(raw.slider);
            if (sp) q.slider = sp; else q.type = 'text';
        }
        // 'dates' is a tick-list of date windows plus a free "other dates" box.
        // With nothing to tick it is just a text box.
        if (q.type === 'dates' && !options.length) q.type = 'text';
        out.push(q);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────
//  CARDS — the picture-and-figures blocks above the questions.
//  A trip destination is the first user: photo, temperature, price, why.
// ─────────────────────────────────────────────────────────────

function normalizeCards(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 40).map(c => {
        if (!c || typeof c !== 'object') return null;
        const title = S(c.title, 120).trim();
        if (!title) return null;
        return {
            title,
            subtitle: S(c.subtitle, 160),
            // http(s) only — a data: or javascript: URL has no business here.
            image: /^https?:\/\//i.test(String(c.image || '')) ? S(c.image, 600) : '',
            body: S(c.body, 2000),
            // The bold bits: [{ label: 'Sea', value: '26°C' }]
            facts: Array.isArray(c.facts)
                ? c.facts.slice(0, 8).map(f => ({
                    label: S(f && f.label, 40),
                    value: S(f && f.value, 60),
                })).filter(f => f.label && f.value)
                : [],
            link: /^https?:\/\//i.test(String(c.link || '')) ? S(c.link, 600) : '',
        };
    }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────────────────────────

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function ownerDir(owner) { return userDataPath(owner, 'linkmail'); }
function pathFor(owner, token) { return path.join(ownerDir(owner), token + '.json'); }
function indexPathFor(token) { return path.join(INDEX_DIR, token + '.json'); }

const TOKEN_RE = /^[a-f0-9]{32}$/;
const newToken = () => crypto.randomBytes(16).toString('hex');

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

function writeJson(file, data) {
    ensureDir(path.dirname(file));
    // Write-then-rename: a half-written record reads as corrupt, and the
    // recipient would be told the link had expired when it is perfectly fine.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

function ownerOf(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const idx = readJson(indexPathFor(token));
    return idx && idx.owner ? idx.owner : null;
}

function loadRaw(owner, token) {
    if (!owner || !TOKEN_RE.test(String(token || ''))) return null;
    return readJson(pathFor(owner, token));
}

function isExpired(rec) {
    if (!rec || !rec.expiresAt) return false;
    return new Date(rec.expiresAt).getTime() < Date.now();
}

// ─────────────────────────────────────────────────────────────
//  CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Mint a link. `owner` is the sender's email — everything is stored under them.
 * Returns { token, url, record }.
 */
function createLink(owner, opts = {}) {
    const email = String(owner || '').trim().toLowerCase();
    if (!email) throw new Error('linkmail needs an owner email');

    const kind = ['note', 'trip', 'thread'].includes(opts.kind) ? opts.kind : 'note';
    const title = S(opts.title, 200).trim() || 'Shared with you';
    const body = S(opts.body, 60000);
    const cards = normalizeCards(opts.cards);
    const questions = normalizeQuestions(opts.questions);

    // A link with nothing on it is a bug, not a link.
    if (!body.trim() && !cards.length && !questions.length) {
        throw new Error('Nothing to share — a linkmail needs a body, some cards, or some questions.');
    }

    const hours = Math.min(Math.max(parseInt(opts.expiresHours, 10) || DEFAULT_HOURS, 1), MAX_HOURS);
    const token = newToken();
    const now = new Date().toISOString();
    const senderName = S(opts.senderName, 100) || 'Your contact';
    const recipientName = S(opts.recipientName, 100);

    const rec = {
        token,
        kind,
        owner: email,
        senderName,
        recipientName,
        refId: S(opts.refId, 120),
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
        revoked: false,
        greeting: S(opts.greeting, 800) ||
            (recipientName
                ? `Hello ${recipientName} — ${senderName} has shared this with you.`
                : `Hi — ${senderName} has shared this with you.`),
        display: { title, body },
        cards,
        questions,
        // The ONLY thing the public, scoped Q is allowed to know. Defaults to
        // what is on the card, so Q can never answer from data the recipient
        // cannot see for themselves.
        context: {
            scope: kind,
            snapshot: S(opts.snapshot, 60000) || [
                body,
                cards.map(c => `${c.title}${c.subtitle ? ' — ' + c.subtitle : ''}\n` +
                    c.facts.map(f => `  ${f.label}: ${f.value}`).join('\n') +
                    (c.body ? `\n  ${c.body}` : '')).join('\n\n'),
            ].filter(s => s && s.trim()).join('\n\n'),
        },
        // Whether the recipient may talk to Q on this link at all.
        chatEnabled: opts.chatEnabled !== false,
        answers: [],
        chat: [],
        views: 0,
        lastViewedAt: null,
    };

    writeJson(pathFor(email, token), rec);
    writeJson(indexPathFor(token), { owner: email, createdAt: now });
    return { token, url: `/linkmail/${token}`, record: rec };
}

// ─────────────────────────────────────────────────────────────
//  PUBLIC SIDE — the recipient. The token is the whole authority.
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a token for the public page. Returns the recipient-safe view, or
 * { error } — never the owner's email, never their other links.
 */
function resolvePublic(token, { countView = false } = {}) {
    const owner = ownerOf(token);
    if (!owner) return { error: 'not_found' };
    const rec = loadRaw(owner, token);
    if (!rec) return { error: 'not_found' };
    if (rec.revoked) return { error: 'revoked' };
    if (isExpired(rec)) return { error: 'expired' };

    if (countView) {
        rec.views = (rec.views || 0) + 1;
        rec.lastViewedAt = new Date().toISOString();
        writeJson(pathFor(owner, token), rec);
    }

    return {
        token: rec.token,
        kind: rec.kind,
        senderName: rec.senderName,
        recipientName: rec.recipientName,
        greeting: rec.greeting,
        display: rec.display,
        cards: rec.cards || [],
        // Re-normalised on read so a link made before a shape change still renders.
        questions: normalizeQuestions(rec.questions),
        chatEnabled: rec.chatEnabled !== false,
        // What they have already said, so re-opening shows their answers back.
        answers: (rec.answers || []).map(a => ({
            at: a.at, questionIndex: a.questionIndex, summary: a.summary, name: a.name,
        })),
        chat: (rec.chat || []).map(m => ({ role: m.role, content: m.content, at: m.at })),
        expiresAt: rec.expiresAt,
    };
}

/** Record one recipient answer. Public — the token is the authority. */
function recordAnswer(token, { questionIndex, summary, value, name } = {}) {
    const owner = ownerOf(token);
    if (!owner) return { error: 'not_found' };
    const rec = loadRaw(owner, token);
    if (!rec) return { error: 'not_found' };
    if (rec.revoked) return { error: 'revoked' };
    if (isExpired(rec)) return { error: 'expired' };

    const qi = parseInt(questionIndex, 10);
    const q = Array.isArray(rec.questions) ? rec.questions[qi] : null;
    if (!q) return { error: 'no_such_question' };

    const entry = {
        at: new Date().toISOString(),
        questionIndex: qi,
        question: q.text,
        // The summary is what the SENDER reads — one line, already built from
        // the recipient's ticks, inputs and outputs, so nothing has to be
        // recomputed for the reply to make sense.
        summary: S(summary, 2000),
        value: value === undefined ? null : value,
        // ⚠️ THE LINK'S OWN NAME WINS.
        //
        // Sarah, 21 Aug: "they all have different links that will connect to
        // their names". When a link was minted FOR somebody, that is who
        // answered it — not whatever arrives in the request body. A shared
        // link where everyone types their own name falls over the moment two
        // people are called Sam, somebody leaves the box empty, or a name is
        // spelled three ways across a fortnight, and then the sender is
        // guessing who can actually do which week.
        //
        // A typed name is still accepted on links that were NOT addressed to
        // anyone — the one-link-for-everyone case still works.
        name: S(rec.recipientName, 100) || S(name, 100),
        // Kept separate so the two can never be confused later: whether this
        // answer's name came from the link or from a box someone filled in.
        namedBy: rec.recipientName ? 'link' : 'typed',
    };
    // One answer per question: answering again replaces, it does not stack up.
    rec.answers = (rec.answers || []).filter(a => a.questionIndex !== qi);
    rec.answers.push(entry);
    rec.updatedAt = entry.at;
    writeJson(pathFor(owner, token), rec);
    return { ok: true, answer: entry };
}

/** Append one turn of the public, scoped conversation. */
function appendPublicChat(token, role, content) {
    const owner = ownerOf(token);
    if (!owner) return { error: 'not_found' };
    const rec = loadRaw(owner, token);
    if (!rec) return { error: 'not_found' };
    if (rec.revoked || isExpired(rec)) return { error: 'expired' };
    rec.chat = rec.chat || [];
    rec.chat.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: S(content, 8000),
        at: new Date().toISOString(),
    });
    // Keep the tail — a public link is not an archive.
    if (rec.chat.length > 200) rec.chat = rec.chat.slice(-200);
    rec.updatedAt = new Date().toISOString();
    writeJson(pathFor(owner, token), rec);
    return { ok: true };
}

/** The snapshot + greeting a scoped public Q is allowed to see. */
function publicContext(token) {
    const owner = ownerOf(token);
    if (!owner) return null;
    const rec = loadRaw(owner, token);
    if (!rec || rec.revoked || isExpired(rec)) return null;
    return {
        senderName: rec.senderName,
        recipientName: rec.recipientName,
        kind: rec.kind,
        title: (rec.display && rec.display.title) || '',
        snapshot: (rec.context && rec.context.snapshot) || '',
        questions: (rec.questions || []).map(q => q.text),
        chat: rec.chat || [],
        chatEnabled: rec.chatEnabled !== false,
    };
}

// ─────────────────────────────────────────────────────────────
//  SENDER SIDE
// ─────────────────────────────────────────────────────────────

function listLinks(owner) {
    const dir = ownerDir(owner);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => readJson(path.join(dir, f)))
        .filter(Boolean)
        .map(r => ({
            token: r.token,
            kind: r.kind,
            title: (r.display && r.display.title) || '',
            recipientName: r.recipientName,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            revoked: !!r.revoked,
            expired: isExpired(r),
            views: r.views || 0,
            lastViewedAt: r.lastViewedAt,
            answerCount: (r.answers || []).length,
            questionCount: (r.questions || []).length,
            replyCount: (r.chat || []).filter(m => m.role === 'user').length,
            url: `/linkmail/${r.token}`,
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** The whole record, for the sender only. */
function readLink(owner, token) {
    const rec = loadRaw(owner, token);
    if (!rec) return null;
    return Object.assign({}, rec, { expired: isExpired(rec) });
}

function revokeLink(owner, token) {
    const rec = loadRaw(owner, token);
    if (!rec) return { error: 'not_found' };
    rec.revoked = true;
    rec.updatedAt = new Date().toISOString();
    writeJson(pathFor(owner, token), rec);
    return { ok: true };
}

/**
 * What came back, in plain words — this is what Q reads out when she asks
 * "has anyone answered?". Deliberately a STRING: it goes straight into a tool
 * result and must not need a renderer to be understood.
 */
function repliesSummary(owner, token) {
    const rec = loadRaw(owner, token);
    if (!rec) return null;
    const lines = [];
    const when = new Date(rec.createdAt).toLocaleDateString('en-GB');
    lines.push(`${(rec.display && rec.display.title) || 'Linkmail'} — sent ${when}${rec.recipientName ? ' to ' + rec.recipientName : ''}`);
    lines.push(`Opened ${rec.views || 0} time${(rec.views || 0) === 1 ? '' : 's'}${rec.lastViewedAt ? ', last ' + new Date(rec.lastViewedAt).toLocaleString('en-GB') : ''}.`);
    const answers = (rec.answers || []).slice().sort((x, y) => x.questionIndex - y.questionIndex);
    if (!answers.length) {
        lines.push('No answers yet.');
    } else {
        lines.push('');
        lines.push('Answers:');
        for (const a of answers) {
            lines.push(`  ${a.question}`);
            lines.push(`    -> ${a.summary || '(no answer text)'}${a.name ? '  — ' + a.name : ''}`);
        }
    }
    const said = (rec.chat || []).filter(m => m.role === 'user');
    if (said.length) {
        lines.push('');
        lines.push(`They also said (${said.length} message${said.length === 1 ? '' : 's'}):`);
        for (const m of said.slice(-8)) lines.push(`  "${m.content}"`);
    }
    return lines.join('\n');
}

module.exports = {
    createLink,
    resolvePublic,
    recordAnswer,
    appendPublicChat,
    publicContext,
    listLinks,
    readLink,
    revokeLink,
    repliesSummary,
    normalizeQuestions,
    normalizeCards,
    ownerOf,
    TOKEN_RE,
};
