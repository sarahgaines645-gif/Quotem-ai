/**
 * Q's circle — the registry of people Q knows.
 *
 * Each person has an email + password (bcrypt-hashed). Sarah signs up
 * new people via the admin endpoint with a starting password; they can
 * change it later from the chat UI.
 *
 * On-disk shape (people.json):
 *   [
 *     {
 *       id: "sarah",
 *       name: "Sarah",
 *       email: "sarah@example.com",
 *       intro: "Built Q. The reason he exists.",
 *       passwordHash: "<bcrypt hash>",
 *       addedAt: "2026-04-29T..."
 *     },
 *     ...
 *   ]
 *
 * Raw passwords are NEVER stored. bcrypt hash only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
// emailSlug is the per-user storage key. Registration MUST be unique on the
// slug, not the raw email, or two different emails (a.b@x / a-b@x) collide
// into one user directory and one user reads/wipes another's data.
const { emailSlug } = require('./plugins/user-data');

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const Q_DATA_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-memory')
    : path.join(__dirname, 'data');

const PEOPLE_FILE = path.join(Q_DATA_DIR, 'people.json');

try {
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[q/people] could not create data dir:', e.message);
}

const BCRYPT_ROUNDS = 12;

function loadPeople() {
    try {
        if (!fs.existsSync(PEOPLE_FILE)) return [];
        const data = fs.readFileSync(PEOPLE_FILE, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[q/people] load error:', e.message);
        return [];
    }
}

function savePeople(people) {
    try {
        fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/people] save error:', e.message);
        return false;
    }
}

function normaliseEmail(e) {
    return String(e || '').trim().toLowerCase();
}

/**
 * Add a person to Q's circle.
 * Returns { person, password } where `password` is the raw initial
 * password — show Sarah ONCE, send to recipient via secure channel.
 *
 * @param {object} args
 * @param {string} args.id            - stable id like 'sarah', 'alex'
 * @param {string} args.name          - display name
 * @param {string} args.email         - login identity
 * @param {string} [args.intro]       - one-line intro Q sees in his system context
 * @param {string} [args.password]    - if omitted, a strong random one is generated
 */
async function addPerson({ id, name, email, intro, password }) {
    if (!id || !name || !email) throw new Error('id, name, email required');
    const people = loadPeople();
    const cleanEmail = normaliseEmail(email);
    if (people.find(p => p.id === id)) throw new Error(`person id "${id}" already exists`);
    const newSlug = emailSlug(cleanEmail);
    if (people.find(p => emailSlug(p.email) === newSlug)) throw new Error(`email "${cleanEmail}" collides with an existing account's storage key`);

    const rawPassword = password && password.length >= 8
        ? password
        : crypto.randomBytes(12).toString('base64url'); // 16-char URL-safe random

    const passwordHash = await bcrypt.hash(rawPassword, BCRYPT_ROUNDS);

    const person = {
        id,
        name,
        email: cleanEmail,
        intro: intro || '',
        passwordHash,
        addedAt: new Date().toISOString(),
    };
    people.push(person);
    savePeople(people);
    const { passwordHash: _ph, ...safe } = person;
    return { person: safe, password: rawPassword };
}

/**
 * Verify email + password. Returns the safe (no passwordHash) person on
 * success, null on any failure.
 */
async function verifyLogin(email, password) {
    if (!email || !password) return null;
    const cleanEmail = normaliseEmail(email);
    const people = loadPeople();
    const found = people.find(p => normaliseEmail(p.email) === cleanEmail);
    if (!found || !found.passwordHash) return null;
    const ok = await bcrypt.compare(password, found.passwordHash);
    if (!ok) return null;
    const { passwordHash, ...safe } = found;
    return safe;
}

function getPerson(id) {
    const found = loadPeople().find(p => p.id === id);
    if (!found) return null;
    const { passwordHash, ...safe } = found;
    return safe;
}

function getPersonByEmail(email) {
    const cleanEmail = normaliseEmail(email);
    const found = loadPeople().find(p => normaliseEmail(p.email) === cleanEmail);
    if (!found) return null;
    const { passwordHash, ...safe } = found;
    return safe;
}

function listPeople() {
    return loadPeople().map(({ passwordHash, ...safe }) => safe);
}

async function changePassword(id, newPassword) {
    if (!newPassword || newPassword.length < 8) throw new Error('password must be at least 8 characters');
    const people = loadPeople();
    const person = people.find(p => p.id === id);
    if (!person) throw new Error(`person "${id}" not found`);
    person.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    person.passwordChangedAt = new Date().toISOString();
    savePeople(people);
    return true;
}

async function rotatePassword(id) {
    const newPassword = crypto.randomBytes(12).toString('base64url');
    await changePassword(id, newPassword);
    return newPassword;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Create a one-hour password reset token for the person with this email.
 * Returns the raw token (to embed in the reset link) on success, or null
 * if no account matches. The token's SHA-256 hash is stored on disk —
 * the raw token only exists in the email link.
 */
function createResetToken(email) {
    const cleanEmail = normaliseEmail(email);
    const people = loadPeople();
    const person = people.find(p => normaliseEmail(p.email) === cleanEmail);
    if (!person) return null;
    const raw = crypto.randomBytes(32).toString('hex');
    person.resetTokenHash = hashResetToken(raw);
    person.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    savePeople(people);
    return raw;
}

/**
 * Validate a reset token and set the new password. On success the token
 * is cleared and the person is returned (safe — no passwordHash). Returns
 * null on any failure (unknown token, expired token, weak password).
 */
async function consumeResetToken(token, newPassword) {
    if (!token || typeof token !== 'string') return null;
    if (!newPassword || newPassword.length < 8) {
        throw new Error('Password must be at least 8 characters.');
    }
    const tokenHash = hashResetToken(token);
    const people = loadPeople();
    const person = people.find(p => p.resetTokenHash === tokenHash);
    if (!person) return null;
    if (!person.resetTokenExpires || new Date(person.resetTokenExpires).getTime() < Date.now()) {
        // Expired — clear the dead token so future replays do nothing
        delete person.resetTokenHash;
        delete person.resetTokenExpires;
        savePeople(people);
        return null;
    }
    person.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    person.passwordChangedAt = new Date().toISOString();
    delete person.resetTokenHash;
    delete person.resetTokenExpires;
    savePeople(people);
    const { passwordHash, resetTokenHash, resetTokenExpires, ...safe } = person;
    return safe;
}

function removePerson(id) {
    const people = loadPeople();
    const filtered = people.filter(p => p.id !== id);
    if (filtered.length === people.length) return false;
    savePeople(filtered);
    return true;
}

/**
 * Pick a unique, filename-safe id for a new person. Derived from the local
 * part of their email; if that's already taken, append -2, -3, etc. The id
 * is what we use for memory file names so it MUST stay stable for that
 * person's lifetime.
 */
function generateUniqueId(email) {
    const local = normaliseEmail(email).split('@')[0] || 'user';
    const baseId = local.replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '') || 'user';
    const people = loadPeople();
    if (!people.find(p => p.id === baseId)) return baseId;
    let n = 2;
    while (people.find(p => p.id === baseId + '-' + n)) n++;
    return baseId + '-' + n;
}

/**
 * Public-facing self-signup. Validates input, generates a stable id from
 * the email, and creates the person. Returns the safe person record on
 * success. Throws on validation failure or duplicate email.
 *
 * No invite code, no admin approval — Sarah set this up for friends to
 * try Q without her in the loop. Tighten later if the URL gets shared
 * around in places it shouldn't.
 */
async function signupPerson({ name, email, password }) {
    const cleanName = String(name || '').trim();
    const cleanEmail = normaliseEmail(email);
    if (!cleanName) throw new Error('Please enter your name.');
    if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
        throw new Error('Please enter a valid email address.');
    }
    if (!password || password.length < 8) {
        throw new Error('Password must be at least 8 characters.');
    }
    const people = loadPeople();
    if (people.find(p => emailSlug(p.email) === emailSlug(cleanEmail))) {
        throw new Error('An account with this email already exists. Try signing in instead.');
    }
    const id = generateUniqueId(cleanEmail);
    const result = await addPerson({ id, name: cleanName, email: cleanEmail, password });
    return result.person;
}

/**
 * If people.json contains entries from the old access-key schema (no
 * passwordHash), they're useless — wipe and let bootstrap reseed Sarah.
 * Returns true if a wipe happened.
 */
function migrateIfLegacy() {
    const people = loadPeople();
    if (people.length === 0) return false;
    const allHavePassword = people.every(p => p.passwordHash);
    if (allHavePassword) return false;
    console.log('[q/people] 🔄 Detected legacy access-key entries — wiping for re-bootstrap');
    savePeople([]);
    return true;
}

module.exports = {
    addPerson,
    signupPerson,
    generateUniqueId,
    verifyLogin,
    getPerson,
    getPersonByEmail,
    listPeople,
    changePassword,
    rotatePassword,
    removePerson,
    migrateIfLegacy,
    createResetToken,
    consumeResetToken,
};
