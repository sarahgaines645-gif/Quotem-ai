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

// Send a plain-text email through the user's connected Gmail.
// Returns the from address. Throws Error with .code='not_connected' if none.
async function sendEmail(email, { to, subject, text }) {
    const acct = getAccount(email);
    if (!acct || acct.provider !== 'gmail') {
        const e = new Error('not_connected');
        e.code = 'not_connected';
        throw e;
    }
    const access = await gmailAccessToken(decrypt(acct.refresh_token));
    const from = acct.email || '';
    const message = [
        from ? `From: ${from}` : null,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        text || '',
    ].filter(v => v !== null).join('\r\n');
    const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
    });
    if (!gr.ok) throw new Error('gmail_send_failed: ' + (await gr.text()).slice(0, 200));
    return from;
}

module.exports = { gmailConfigured, status, getAccount, disconnect, consentUrl, handleCallback, sendEmail };
