'use strict';

/**
 * Q PEOPLE — who you live with, and who you go away with.
 *
 * Sarah, 21 Aug 2026: *"they all have different links that will connect to
 * their names"* — a shared link where everyone types their own name is fine
 * until two people are called Sam, somebody leaves the box blank, or a name is
 * spelled three ways across a fortnight. A link that already knows who it was
 * sent to cannot be got wrong.
 *
 * The same list answers the other question she asked for /trips: *"there will
 * be your personal checklist that q will make for you and all members that live
 * with you so for me it will make mine and my kids on my page."* You cannot
 * write one checklist per person without a list of people.
 *
 * WHY THIS IS NOT `q-life`'s CONTEXT. That store is deliberately FREE TEXT —
 * four thousand characters of "who lives in the house, kids' year groups,
 * allergies" — and it is right for what it does, which is telling Q what to
 * notice when it reads a school letter. It cannot be enumerated. You cannot
 * loop over a paragraph and mint a link for each person in it.
 *
 * ⚠️ REAL PEOPLE'S DETAILS LIVE HERE. Per user, through user-data.js, so one
 * household is physically unable to read another's. Nothing in this file goes
 * near a prompt, a log line, or the repo.
 *
 *   userDataPath(owner, 'people/people.json')
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataPath } = require('./user-data');

const MAX_PEOPLE = 24;

function peopleFile(owner) { return userDataPath(owner, 'people/people.json'); }

function readAll(owner) {
    try {
        const j = JSON.parse(fs.readFileSync(peopleFile(owner), 'utf8'));
        return Array.isArray(j) ? j : [];
    } catch { return []; }
}

function writeAll(owner, list) {
    const file = peopleFile(owner);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
    return list;
}

const S = (v, n) => {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, n) : '';
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * ⚠️ A NAME IS COPIED, NEVER CORRECTED. Q's own rules say it outright: family
 * members routinely have different surnames, and a letter with the wrong name
 * on it is useless or actively harmful. No title-casing, no trimming to a
 * first name, no guessing. What she typed is what is stored.
 */
function normalise(p, existing) {
    const prev = existing || {};
    const email = S(p.email !== undefined ? p.email : prev.email, 200);
    return {
        id: prev.id || crypto.randomBytes(6).toString('hex'),
        name: S(p.name, 100) || prev.name || '',
        // An empty email is normal — a child who is coming but is not being
        // asked, or somebody you will message rather than email.
        email: email && EMAIL_RE.test(email) ? email : (EMAIL_RE.test(prev.email || '') ? prev.email : ''),
        relationship: S(p.relationship, 60) || prev.relationship || '',
        // Lives with you: the ones whose checklists appear on YOUR page.
        household: p.household !== undefined ? !!p.household : (prev.household ?? false),
        // Their own line on a packing or paperwork list, whether or not they
        // are old enough to have an email address.
        child: p.child !== undefined ? !!p.child : (prev.child ?? false),
        addedAt: prev.addedAt || new Date().toISOString(),
    };
}

function list(owner) {
    if (!owner) return [];
    return readAll(owner).map(p => normalise(p, p)).filter(p => p.name);
}

function get(id, owner) {
    return list(owner).find(p => p.id === id) || null;
}

function add(person, owner) {
    if (!owner) throw new Error('owner required');
    const rec = normalise(person || {});
    if (!rec.name) throw new Error('A person needs a name.');
    const all = readAll(owner);
    if (all.length >= MAX_PEOPLE) throw new Error(`That is already ${MAX_PEOPLE} people.`);
    // Same name AND same email is the same person being added twice, which is
    // how you end up sending one relative three links.
    const clash = all.find(p => p.name === rec.name && (p.email || '') === (rec.email || ''));
    if (clash) return normalise(clash, clash);
    all.push(rec);
    writeAll(owner, all);
    return rec;
}

function update(id, patch, owner) {
    if (!owner) throw new Error('owner required');
    const all = readAll(owner);
    const i = all.findIndex(p => p.id === id);
    if (i === -1) return null;
    all[i] = normalise({ ...patch, id }, all[i]);
    all[i].id = id;
    writeAll(owner, all);
    return all[i];
}

function remove(id, owner) {
    if (!owner) throw new Error('owner required');
    const all = readAll(owner);
    const next = all.filter(p => p.id !== id);
    if (next.length === all.length) return false;
    writeAll(owner, next);
    return true;
}

/** The ones with an address, i.e. the ones a link can actually be sent to. */
function contactable(owner) {
    return list(owner).filter(p => p.email);
}

/** The ones who live with you — whose checklists belong on your page. */
function household(owner) {
    return list(owner).filter(p => p.household);
}

module.exports = { list, get, add, update, remove, contactable, household, MAX_PEOPLE };
