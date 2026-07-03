'use strict';
/**
 * Per-user Gmail "send as yourself" — mirrors Quoteapp's email-connect.js,
 * adapted to quotem-ai's stack: no SQL (per-user JSON via userDataPath), and
 * HMAC-signed OAuth state (quotem-ai has no jsonwebtoken).
 *
 * The Gmail refresh token is AES-256-GCM encrypted at rest
 * (EMAIL_TOKEN_KEY, falls back to Q_AUTH_PEPPER).
 *
 * Google one-time setup: create an OAuth 2.0 "Web application" client with the
 * Gmail API enabled, add GMAIL_REDIRECT_URI as an authorized redirect URI,
 * request the gmail.send + userinfo.email scopes, and set GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET / GMAIL_REDIRECT_URI in the server env. For your own
 * use, add yourself as a Test User on the OAuth consent screen (no Google app
 * verification needed for test users).
 */
const crypto = require('crypto');
const fs = require('fs');
const { userDataPath } = require('./user-data');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || '';
// gmail.modify supersets read + lets us mark read/unread, star, archive and
// move to Bin (it can't PERMANENTLY delete — "delete" is a move to Bin, like Gmail).
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email';

function gmailConfigured() {
    return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

// ── encryption (AES-256-GCM) ──────────────────────────────────────────────
const KEY = crypto.createHash('sha256')
    .update(process.env.EMAIL_TOKEN_KEY || process.env.Q_AUTH_PEPPER || 'quotem-ai-email-fallback-key')
    .digest(); // 32 bytes
function encrypt(plain) {
    if (plain == null) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
    if (!blob) return null;
    try {
        const buf = Buffer.from(blob, 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
}

// ── per-user token store (JSON on the user's volume dir) ───────────────────
function accountFile(email) {
    return userDataPath(email, 'email/account.json');
}
function getAccount(email) {
    try {
        const f = accountFile(email);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}
function saveGmail(email, { address, refreshToken }) {
    fs.writeFileSync(accountFile(email), JSON.stringify({
        provider: 'gmail',
        email: address || '',
        refresh_token: encrypt(refreshToken),
        updated_at: new Date().toISOString(),
    }, null, 2), 'utf8');
}
// SMTP provider (any host with an app password) — same store, provider:'smtp'.
function saveSmtp(email, { address, host, port, user, pass }) {
    fs.writeFileSync(accountFile(email), JSON.stringify({
        provider: 'smtp',
        email: address || user || '',
        smtp_host: host,
        smtp_port: parseInt(port, 10) || 587,
        smtp_user: user,
        smtp_pass: encrypt(pass),
        updated_at: new Date().toISOString(),
    }, null, 2), 'utf8');
}
// Verify the SMTP credentials, then store them. Throws if sign-in fails.
async function connectSmtp(email, { address, host, port, user, pass }) {
    const nodemailer = require('nodemailer');
    const p = parseInt(port, 10) || 587;
    const t = nodemailer.createTransport({ host, port: p, secure: p === 465, requireTLS: p === 587, auth: { user, pass } });
    await t.verify();
    saveSmtp(email, { address, host, port: p, user, pass });
    return address || user;
}
function disconnect(email) {
    try { fs.rmSync(accountFile(email), { force: true }); } catch { /* nothing to remove */ }
}
function status(email) {
    const a = getAccount(email);
    return { connected: !!a, provider: a?.provider || null, email: a?.email || null, gmailAvailable: gmailConfigured() };
}

// ── OAuth state (HMAC-signed; mirrors auth.js, no jsonwebtoken) ────────────
function pepper() {
    const p = process.env.Q_AUTH_PEPPER;
    return (p && p.length >= 16) ? p : 'unset-pepper-quotem-ai-do-not-use-in-prod';
}
function signState(email) {
    const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 15 * 60 * 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', pepper()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}
function verifyState(state) {
    if (!state || typeof state !== 'string' || !state.includes('.')) return null;
    const [payload, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', pepper()).update(payload).digest('base64url');
    if (sig !== expected) return null;
    try {
        const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!obj.email || !obj.exp || Date.now() > obj.exp) return null;
        return obj.email;
    } catch { return null; }
}

// ── Gmail OAuth ────────────────────────────────────────────────────────────
function consentUrl(email) {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: signState(email),
    });
}

// Exchange the authorization code → store the encrypted refresh token.
// Returns the connected address, or throws ('bad_state' | 'no_refresh_token').
async function handleCallback(code, state) {
    const email = verifyState(state);
    if (!email) throw new Error('bad_state');
    const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }),
    });
    const tok = await tr.json();
    if (!tok.refresh_token) throw new Error('no_refresh_token');
    let address = '';
    try {
        const ur = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
        address = (await ur.json()).email || '';
    } catch { /* address is nice-to-have */ }
    saveGmail(email, { address, refreshToken: tok.refresh_token });
    return address;
}

async function gmailAccessToken(refreshToken) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error('gmail_token_refresh_failed');
    return data.access_token;
}

// Send an email through the user's connected account (Gmail or SMTP).
// attachments: [{ filename, base64, mimeType }] — optional file attachments.
// Returns the from address. Throws Error with .code='not_connected' if none.
// RFC 2047 encode a header value so non-ASCII (e.g. em dashes) survives transit.
function encodeHeader(str) {
    if (/^[\x00-\x7F]*$/.test(str)) return str;
    return '=?UTF-8?B?' + Buffer.from(String(str), 'utf8').toString('base64') + '?=';
}
async function sendEmail(email, { to, subject, text, attachments = [] }) {
    const acct = getAccount(email);
    if (!acct) {
        const e = new Error('not_connected');
        e.code = 'not_connected';
        throw e;
    }
    if (acct.provider === 'gmail') {
        const access = await gmailAccessToken(decrypt(acct.refresh_token));
        const from = acct.email || '';
        let message;
        if (attachments && attachments.length) {
            const boundary = 'qm-' + crypto.randomBytes(10).toString('hex');
            const parts = [
                `--${boundary}`,
                'Content-Type: text/plain; charset=UTF-8',
                '',
                text || '',
            ];
            for (const att of attachments) {
                const safe = String(att.filename || 'attachment').replace(/"/g, '');
                parts.push(
                    `--${boundary}`,
                    `Content-Type: ${att.mimeType || 'application/octet-stream'}`,
                    'Content-Transfer-Encoding: base64',
                    `Content-Disposition: attachment; filename="${safe}"`,
                    '',
                    String(att.base64 || '').replace(/\s/g, ''),
                );
            }
            parts.push(`--${boundary}--`);
            message = [
                from ? `From: ${from}` : null,
                `To: ${to}`,
                `Subject: ${encodeHeader(subject)}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                parts.join('\r\n'),
            ].filter(v => v !== null).join('\r\n');
        } else {
            message = [
                from ? `From: ${from}` : null,
                `To: ${to}`,
                `Subject: ${encodeHeader(subject)}`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=UTF-8',
                '',
                text || '',
            ].filter(v => v !== null).join('\r\n');
        }
        const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw }),
        });
        if (!gr.ok) throw new Error('gmail_send_failed: ' + (await gr.text()).slice(0, 200));
        return from;
    }
    if (acct.provider === 'smtp') {
        const nodemailer = require('nodemailer');
        const from = acct.email || acct.smtp_user || '';
        const t = nodemailer.createTransport({
            host: acct.smtp_host,
            port: acct.smtp_port,
            secure: acct.smtp_port === 465,
            requireTLS: acct.smtp_port === 587,
            auth: { user: acct.smtp_user, pass: decrypt(acct.smtp_pass) },
        });
        const mailOpts = { from, to, subject, text: text || '' };
        if (attachments && attachments.length) {
            mailOpts.attachments = attachments.map(a => ({
                filename: a.filename || 'attachment',
                content: Buffer.from(a.base64 || '', 'base64'),
                contentType: a.mimeType || 'application/octet-stream',
            }));
        }
        await t.sendMail(mailOpts);
        return from;
    }
    const e = new Error('not_connected');
    e.code = 'not_connected';
    throw e;
}

// ── Outbox: emails saved to send later (email-writer + threads) ───────────
function outboxFile(email) {
    return userDataPath(email, 'email/outbox.json');
}
function getOutbox(email) {
    try {
        const f = outboxFile(email);
        if (!fs.existsSync(f)) return [];
        const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function saveOutbox(email, arr) {
    fs.writeFileSync(outboxFile(email), JSON.stringify(arr, null, 2), 'utf8');
}
function addToOutbox(email, { to, subject, body, threadId, attachments }) {
    const arr = getOutbox(email);
    const item = {
        id: crypto.randomBytes(8).toString('hex'),
        to: String(to || '').trim(),
        subject: String(subject || '').trim(),
        body: body || '',
        threadId: threadId || null,
        attachments: Array.isArray(attachments) ? attachments : [],
        createdAt: new Date().toISOString(),
    };
    arr.push(item);
    saveOutbox(email, arr);
    return item;
}
function removeFromOutbox(email, id) {
    saveOutbox(email, getOutbox(email).filter(x => x.id !== id));
}
function patchOutboxItem(email, id, patch) {
    const arr = getOutbox(email);
    const idx = arr.findIndex(x => x.id === id);
    if (idx === -1) return false;
    Object.assign(arr[idx], patch, { updatedAt: new Date().toISOString() });
    saveOutbox(email, arr);
    return true;
}
// Send a queued email, then drop it from the outbox. Returns the from address.
async function sendFromOutbox(email, id) {
    const item = getOutbox(email).find(x => x.id === id);
    if (!item) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
    const from = await sendEmail(email, { to: item.to, subject: item.subject, text: item.body, attachments: item.attachments || [] });
    removeFromOutbox(email, id);
    return from;
}

// ── Inbox (IMAP, read-only, fetched LIVE on demand) ───────────────────────
// Kept in a SEPARATE file from the send account so connecting an inbox never
// touches the Gmail/SMTP send connection — the two are independent (a user may
// send via Gmail OAuth but read via an IMAP app password, or only do one).
// Deliberately NO background poller: we open IMAP when the user opens the inbox
// and fetch live, so any failure surfaces on screen instead of dying silently
// in a log (that silent-poller death is exactly how the old inbox went dark).
function inboxFile(email) {
    return userDataPath(email, 'email/inbox.json');
}
function getInboxAccount(email) {
    try {
        const f = inboxFile(email);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}
function saveInboxAccount(email, { address, host, port, user, pass }) {
    fs.writeFileSync(inboxFile(email), JSON.stringify({
        email: address || user || '',
        imap_host: host,
        imap_port: parseInt(port, 10) || 993,
        imap_user: user,
        imap_pass: encrypt(pass),
        updated_at: new Date().toISOString(),
    }, null, 2), 'utf8');
}
function inboxStatus(email) {
    // The inbox reads from the connected Gmail (via the Gmail API) when the
    // send account is Gmail — no separate connection, just the read scope
    // (granted by reconnecting once). Falls back to a standalone IMAP inbox
    // for non-Gmail providers.
    const send = getAccount(email);
    if (send && send.provider === 'gmail') return { connected: true, provider: 'gmail', email: send.email || null };
    const imap = getInboxAccount(email);
    if (imap) return { connected: true, provider: 'imap', email: imap.email || null };
    return { connected: false, provider: null, email: null };
}
function disconnectInbox(email) {
    try { fs.rmSync(inboxFile(email), { force: true }); } catch { /* nothing to remove */ }
}
// Build (but do NOT connect) an ImapFlow client from the user's stored creds.
// Throws a coded Error if not connected or the stored password won't decrypt.
function inboxClient(email) {
    const acct = getInboxAccount(email);
    if (!acct) { const e = new Error('inbox_not_connected'); e.code = 'inbox_not_connected'; throw e; }
    const pass = decrypt(acct.imap_pass);
    if (!pass) { const e = new Error('inbox_decrypt_failed'); e.code = 'inbox_decrypt_failed'; throw e; }
    const { ImapFlow } = require('imapflow');
    const port = acct.imap_port || 993;
    const client = new ImapFlow({
        host: acct.imap_host, port,
        secure: port !== 143,              // 993 = implicit TLS; 143 = STARTTLS
        auth: { user: acct.imap_user, pass },
        logger: false, socketTimeout: 30000,
    });
    client.on('error', () => { /* absorb late socket-emitted errors */ });
    return client;
}
// Verify IMAP sign-in (open INBOX, release, logout) THEN store the creds.
// Throws if sign-in fails — the route turns that into a friendly message.
async function connectInbox(email, { address, host, port, user, pass }) {
    const { ImapFlow } = require('imapflow');
    const p = parseInt(port, 10) || 993;
    const client = new ImapFlow({ host, port: p, secure: p !== 143, auth: { user, pass }, logger: false, socketTimeout: 30000 });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
    await client.logout();
    saveInboxAccount(email, { address, host, port: p, user, pass });
    return address || user;
}
// List the most recent inbox messages (envelope only — fast, no bodies).
// Newest first. Throws coded Errors that the route maps to status codes.
async function listInbox(email, { limit = 25 } = {}) {
    const client = inboxClient(email);   // throws before connect if not set up
    const out = [];
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const box = client.mailbox || {};
            const exists = box.exists || 0;
            if (exists > 0) {
                const next = box.uidNext || (exists + 1);
                const start = Math.max(1, next - limit);
                for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true })) {
                    const env = msg.envelope || {};
                    const from = (env.from && env.from[0]) || {};
                    out.push({
                        uid: msg.uid,
                        from: from.address || '',
                        fromName: from.name || from.address || '',
                        subject: env.subject || '(no subject)',
                        date: env.date ? new Date(env.date).toISOString() : null,
                        seen: msg.flags ? msg.flags.has('\\Seen') : false,
                    });
                }
            }
        } finally { try { lock.release(); } catch { /* connection may be dead */ } }
        await client.logout();
    } catch (err) {
        try { await client.logout(); } catch { /* already broken */ }
        const e = new Error('inbox_fetch_failed: ' + err.message); e.code = 'inbox_fetch_failed'; throw e;
    }
    out.sort((a, b) => (b.uid || 0) - (a.uid || 0));
    return out.slice(0, limit);
}
// Read one message's full body by UID.
async function readInboxMessage(email, uid) {
    const { simpleParser } = require('mailparser');
    const client = inboxClient(email);
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        let parsed = null;
        try {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (msg && msg.source) parsed = await simpleParser(msg.source);
        } finally { try { lock.release(); } catch { /* connection may be dead */ } }
        await client.logout();
        if (!parsed) { const e = new Error('inbox_message_not_found'); e.code = 'inbox_message_not_found'; throw e; }
        return {
            uid: Number(uid),
            from: parsed.from?.value?.[0]?.address || '',
            fromName: parsed.from?.value?.[0]?.name || '',
            to: parsed.to?.text || '',
            subject: parsed.subject || '(no subject)',
            date: parsed.date ? new Date(parsed.date).toISOString() : null,
            text: parsed.text || '',
            html: parsed.html || '',
        };
    } catch (err) {
        try { await client.logout(); } catch { /* already broken */ }
        if (err.code) throw err;
        const e = new Error('inbox_read_failed: ' + err.message); e.code = 'inbox_read_failed'; throw e;
    }
}

// ── Inbox via the connected Gmail (Gmail API + gmail.readonly scope) ───────
// Reading Gmail over IMAP with an app password no longer works — Google
// disabled basic-auth IMAP/POP/SMTP in 2025. So when the user's SEND account
// is Gmail, we read their inbox through the Gmail API using the SAME OAuth
// token that already sends — they just reconnect once to grant the read scope.
function b64urlToUtf8(data) {
    return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function parseFromHeader(v) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(v || '');
    if (m) { const addr = m[2].trim(); return { from: addr, fromName: (m[1] || '').trim() || addr }; }
    const addr = (v || '').trim();
    return { from: addr, fromName: addr };
}
function gmailBody(payload) {
    let text = '', html = '';
    (function walk(part) {
        if (!part) return;
        const mime = part.mimeType || '';
        if (mime === 'text/plain' && part.body?.data && !text) text = b64urlToUtf8(part.body.data);
        else if (mime === 'text/html' && part.body?.data && !html) html = b64urlToUtf8(part.body.data);
        if (Array.isArray(part.parts)) part.parts.forEach(walk);
    })(payload);
    return { text, html };
}
// Walk a Gmail payload for real file attachments (parts with a filename AND an
// attachmentId). Returns light metadata; the bytes are fetched on demand via
// getGmailAttachment so listing an email stays cheap.
function gmailAttachments(payload) {
    const out = [];
    (function walk(part) {
        if (!part) return;
        if (part.filename && part.body && part.body.attachmentId) {
            out.push({
                filename:     part.filename,
                attachmentId: part.body.attachmentId,
                mimeType:     part.mimeType || '',
                size:         part.body.size || 0,
            });
        }
        if (Array.isArray(part.parts)) part.parts.forEach(walk);
    })(payload);
    return out;
}
// Gmail API GET → JSON. Maps 403 (missing read scope) and 404 to coded errors
// the routes turn into a "reconnect to allow reading" / not-found message.
async function gmailApiGet(access, path) {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: `Bearer ${access}` } });
    if (r.status === 403) { const e = new Error('inbox_scope_missing'); e.code = 'inbox_scope_missing'; throw e; }
    if (r.status === 404) { const e = new Error('inbox_message_not_found'); e.code = 'inbox_message_not_found'; throw e; }
    if (!r.ok) { const e = new Error('gmail_api_' + r.status + ': ' + (await r.text()).slice(0, 200)); e.code = 'inbox_fetch_failed'; throw e; }
    return r.json();
}
async function gmailAccessFor(email) {
    const acct = getAccount(email);
    if (!acct || acct.provider !== 'gmail') { const e = new Error('inbox_not_connected'); e.code = 'inbox_not_connected'; throw e; }
    try { return await gmailAccessToken(decrypt(acct.refresh_token)); }
    catch { const e = new Error('inbox_auth_failed'); e.code = 'inbox_auth_failed'; throw e; }
}
// Newest-first list of the user's Gmail inbox (metadata only — fast).
async function listGmailInbox(email, { limit = 25, label = 'INBOX' } = {}) {
    const access = await gmailAccessFor(email);
    const q = (label && label !== 'ALL')
        ? `messages?labelIds=${encodeURIComponent(label)}&maxResults=${limit}`
        : `messages?maxResults=${limit}`;
    const list = await gmailApiGet(access, q);
    const ids = (list.messages || []).map(m => m.id);
    const metas = await Promise.all(ids.map(async (id) => {
        try {
            const d = await gmailApiGet(access, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
            const headers = d.payload?.headers || [];
            const hv = (n) => (headers.find(x => (x.name || '').toLowerCase() === n)?.value) || '';
            const { from, fromName } = parseFromHeader(hv('from'));
            return {
                id: d.id,
                from, fromName,
                subject: hv('subject') || '(no subject)',
                date: d.internalDate ? new Date(Number(d.internalDate)).toISOString() : null,
                seen: !(d.labelIds || []).includes('UNREAD'),
            };
        } catch { return null; }
    }));
    return metas.filter(Boolean);
}
// The user's Gmail folders (system + custom labels), for the folder switcher.
async function listGmailLabels(email) {
    const access = await gmailAccessFor(email);
    const d = await gmailApiGet(access, 'labels');
    const labels = d.labels || [];
    const present = new Set(labels.map(l => l.id));
    const SYS = [
        { id: 'INBOX', name: 'Inbox' }, { id: 'STARRED', name: 'Starred' },
        { id: 'SENT', name: 'Sent' }, { id: 'DRAFT', name: 'Drafts' },
        { id: 'SPAM', name: 'Spam' }, { id: 'TRASH', name: 'Bin' },
    ];
    const sys = SYS.filter(s => present.has(s.id));
    const user = labels.filter(l => l.type === 'user')
        .map(l => ({ id: l.id, name: l.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return [...sys, ...user, { id: 'ALL', name: 'All mail' }];
}
// Full body of one Gmail message by id.
async function readGmailMessage(email, id) {
    const access = await gmailAccessFor(email);
    const d = await gmailApiGet(access, `messages/${encodeURIComponent(id)}?format=full`);
    const headers = d.payload?.headers || [];
    const hv = (n) => (headers.find(x => (x.name || '').toLowerCase() === n)?.value) || '';
    const { from, fromName } = parseFromHeader(hv('from'));
    const { text, html } = gmailBody(d.payload);
    return {
        id: d.id,
        from, fromName,
        to: hv('to'),
        subject: hv('subject') || '(no subject)',
        date: d.internalDate ? new Date(Number(d.internalDate)).toISOString() : null,
        starred: (d.labelIds || []).includes('STARRED'),
        seen: !(d.labelIds || []).includes('UNREAD'),
        text: text || d.snippet || '',
        html,
        attachments: gmailAttachments(d.payload),
    };
}
// Fetch one attachment's bytes by id. Gmail returns base64URL — normalise to
// standard base64 so callers can Buffer.from() it or hand it to a vision reader.
async function getGmailAttachment(email, messageId, attachmentId) {
    const access = await gmailAccessFor(email);
    const d = await gmailApiGet(access, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (!d || !d.data) { const e = new Error('inbox_message_not_found'); e.code = 'inbox_message_not_found'; throw e; }
    const base64 = String(d.data).replace(/-/g, '+').replace(/_/g, '/');
    return { base64, size: d.size || 0 };
}
// Change a message's labels (mark read/unread, star, archive). Gmail only.
async function modifyGmailMessage(email, id, { add = [], remove = [] } = {}) {
    const access = await gmailAccessFor(email);
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    });
    if (r.status === 403) { const e = new Error('inbox_scope_missing'); e.code = 'inbox_scope_missing'; throw e; }
    if (!r.ok) { const e = new Error('gmail_modify_' + r.status); e.code = 'inbox_action_failed'; throw e; }
    return true;
}
// Move a message to Bin. Gmail only.
async function trashGmailMessage(email, id) {
    const access = await gmailAccessFor(email);
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`, {
        method: 'POST', headers: { Authorization: `Bearer ${access}` },
    });
    if (r.status === 403) { const e = new Error('inbox_scope_missing'); e.code = 'inbox_scope_missing'; throw e; }
    if (!r.ok) { const e = new Error('gmail_trash_' + r.status); e.code = 'inbox_action_failed'; throw e; }
    return true;
}

module.exports = {
    gmailConfigured, status, getAccount, disconnect, consentUrl, handleCallback,
    sendEmail, connectSmtp,
    getOutbox, addToOutbox, removeFromOutbox, patchOutboxItem, sendFromOutbox,
    // Inbox — Gmail API (read scope) for connected Gmail; IMAP for other providers
    inboxStatus, getInboxAccount, connectInbox, disconnectInbox, listInbox, readInboxMessage,
    listGmailInbox, readGmailMessage, listGmailLabels, getGmailAttachment,
    modifyGmailMessage, trashGmailMessage,
};
