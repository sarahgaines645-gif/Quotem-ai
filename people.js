/**
 * Q's circle — the registry of people Q knows.
 *
 * Q is not a public service. He knows specific people, by their access
 * key. Anyone Sarah adds to the circle gets a key, can talk to Q, and
 * Q remembers them as a distinct person in shared memory.
 *
 * On-disk shape (people.json):
 *   [
 *     {
 *       id: "sarah",
 *       name: "Sarah",
 *       intro: "Built Q. The reason he exists.",
 *       keyHash: "<sha256 of pepper + raw key>",
 *       addedAt: "2026-04-29T..."
 *     },
 *     ...
 *   ]
 *
 * Raw access keys are NEVER stored. Only the hash. When Sarah adds a
 * person, the raw key is shown ONCE — she sends it to them via secure
 * channel; if lost, she rotates and re-issues.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function getPepper() {
    const p = process.env.Q_AUTH_PEPPER;
    if (!p || p.length < 16) {
        console.warn('[q/people] ⚠️  Q_AUTH_PEPPER unset or too short — auth is degraded.');
        return 'unset-pepper-quotem-ai-do-not-use-in-prod';
    }
    return p;
}

function hashKey(rawKey) {
    return crypto
        .createHash('sha256')
        .update(getPepper() + ':' + rawKey)
        .digest('hex');
}

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

/**
 * Add a person to Q's circle. Returns { person, accessKey } where
 * accessKey is the RAW key — show it to Sarah ONCE, never again.
 */
function addPerson({ id, name, intro }) {
    if (!id || !name) throw new Error('id and name required');
    const people = loadPeople();
    if (people.find(p => p.id === id)) {
        throw new Error(`person id "${id}" already exists`);
    }
    const accessKey = crypto.randomBytes(24).toString('base64url');
    const keyHash = hashKey(accessKey);
    const person = {
        id,
        name,
        intro: intro || '',
        keyHash,
        addedAt: new Date().toISOString(),
    };
    people.push(person);
    savePeople(people);
    return { person: { id, name, intro: person.intro, addedAt: person.addedAt }, accessKey };
}

/** Find a person by their RAW access key. Returns null if no match. */
function getPersonByKey(rawKey) {
    if (!rawKey) return null;
    const target = hashKey(rawKey);
    const people = loadPeople();
    const found = people.find(p => p.keyHash === target);
    if (!found) return null;
    const { keyHash, ...safe } = found;
    return safe;
}

function getPerson(id) {
    const people = loadPeople();
    const found = people.find(p => p.id === id);
    if (!found) return null;
    const { keyHash, ...safe } = found;
    return safe;
}

function listPeople() {
    return loadPeople().map(({ keyHash, ...safe }) => safe);
}

/**
 * Rotate a person's access key. Returns the new RAW key. Old one
 * invalidates immediately.
 */
function rotateKey(id) {
    const people = loadPeople();
    const person = people.find(p => p.id === id);
    if (!person) throw new Error(`person "${id}" not found`);
    const accessKey = crypto.randomBytes(24).toString('base64url');
    person.keyHash = hashKey(accessKey);
    person.rotatedAt = new Date().toISOString();
    savePeople(people);
    return accessKey;
}

function removePerson(id) {
    const people = loadPeople();
    const filtered = people.filter(p => p.id !== id);
    if (filtered.length === people.length) return false;
    savePeople(filtered);
    return true;
}

module.exports = {
    addPerson,
    getPersonByKey,
    getPerson,
    listPeople,
    rotateKey,
    removePerson,
};
