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
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email';

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
                `Subject: ${subject}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                parts.join('\r\n'),
            ].filter(v => v !== null).join('\r\n');
        } else {
            message = [
                from ? `From: ${from}` : null,
                `To: ${to}`,
                `Subject: ${subject}`,
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
    Object.assign(arr[idx], patch);
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

module.exports = {
    gmailConfigured, status, getAccount, disconnect, consentUrl, handleCallback,
    sendEmail, connectSmtp,
    getOutbox, addToOutbox, removeFromOutbox, patchOutboxItem, sendFromOutbox,
};
