/**
 * Q's auth — email + password login with HMAC-signed session cookie.
 *
 * Login flow:
 *   1. POST /login { email, password }
 *   2. Server verifies via people.verifyLogin
 *   3. On success: set cookie qsess=<email>:<ts>:<hmac(email+ts, pepper)>
 *      The cookie is the proof — no server-side session storage.
 *   4. Middleware on each request: parse cookie, verify HMAC + freshness,
 *      look up the person by email, attach req.person.
 *
 * Cookie lifetime: 30 days. After that, sign in again.
 */
'use strict';

const crypto = require('crypto');
const { getPersonByEmail } = require('./people.js');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getPepper() {
    const p = process.env.Q_AUTH_PEPPER;
    if (!p || p.length < 16) {
        return 'unset-pepper-quotem-ai-do-not-use-in-prod';
    }
    return p;
}

function sign(email, ts) {
    return crypto
        .createHmac('sha256', getPepper())
        .update(`${email}:${ts}`)
        .digest('base64url');
}

/**
 * Build the cookie value. Returns "email:ts:sig".
 */
function buildSessionCookie(email) {
    const ts = String(Date.now());
    const sig = sign(email, ts);
    return `${encodeURIComponent(email)}:${ts}:${sig}`;
}

/**
 * Set the qsess cookie on the response.
 */
function setSessionCookie(res, email) {
    const value = buildSessionCookie(email);
    const maxAge = Math.round(SESSION_TTL_MS / 1000);
    res.setHeader('Set-Cookie',
        `qsess=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', 'qsess=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}

function readCookie(req, name) {
    const header = req.get('Cookie') || '';
    const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? m[1] : null;
}

/**
 * Verify the qsess cookie and return the person on success, null on
 * failure (missing, malformed, bad sig, expired).
 */
function verifySessionCookie(req) {
    const raw = readCookie(req, 'qsess');
    if (!raw) return null;
    const parts = raw.split(':');
    if (parts.length !== 3) return null;
    const [emailEnc, ts, sig] = parts;
    const email = decodeURIComponent(emailEnc);
    const expected = sign(email, ts);
    if (sig !== expected) return null;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return null;
    if (Date.now() - tsNum > SESSION_TTL_MS) return null;
    const person = getPersonByEmail(email);
    if (!person) return null;
    return person;
}

/**
 * Express middleware. 401s the request unless the qsess cookie is
 * valid and the person it points to is in Q's circle.
 */
function requirePerson(req, res, next) {
    const person = verifySessionCookie(req);
    if (!person) {
        return res.status(401).json({ error: 'Sign in required.' });
    }
    req.person = person;
    next();
}

/** Soft variant — attaches req.person if present, doesn't 401. */
function tryAttachPerson(req, res, next) {
    const person = verifySessionCookie(req);
    if (person) req.person = person;
    next();
}

module.exports = {
    requirePerson,
    tryAttachPerson,
    setSessionCookie,
    clearSessionCookie,
    verifySessionCookie,
};
