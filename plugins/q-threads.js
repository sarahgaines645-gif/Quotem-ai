'use strict';

/**
 * Q THREADS
 *
 * Per-situation storage. Each Thread is one ongoing thing — a complaint,
 * a dispute, a project, a party — with its own emails, chat history with Q,
 * and notes. Stored as JSON on the Railway volume.
 *
 * Schema:
 *   {
 *     id, title, summary, status,
 *     createdAt, updatedAt,
 *     emails: [{ id, type:'in'|'out', from, to, date, subject, body, addedAt }],
 *     chatHistory: [{ role, content, timestamp }],
 *     notes: [string]
 *   }
 */

const fs = require('fs');
const path = require('path');
const { userDataPath, USER_BASE_DIR } = require('./user-data');

// Threads now physically live under each user's directory tree:
//   ${VOLUME}/users/{email-slug}/threads/{thread-id}.json
// There is no shared threads dir. Functions that take an ownerEmail look
// only inside that user's directory — no other user's data is reachable.
//
// The legacy shared dir (${VOLUME}/threads/) still exists from before the
// per-user refactor; the bootstrap migration in server/index.js + the
// claimLegacyThreads helper below sweep it into Sarah's user dir on boot.
const LEGACY_SHARED_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'threads')
    : path.join(__dirname, '..', 'data', 'threads');

function userThreadsDir(email) {
    return userDataPath(email, 'threads');
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'thread-' + Date.now();
}

function pathFor(id, ownerEmail) {
    return path.join(userThreadsDir(ownerEmail), id + '.json');
}

function uniqueId(base, ownerEmail) {
    let id = base;
    let counter = 1;
    while (fs.existsSync(pathFor(id, ownerEmail))) {
        id = `${base}-${++counter}`;
    }
    return id;
}


// Owner used to lock legacy Threads (created before owner-scoping shipped) so
// they're invisible to everyone. Sarah can recover them via /api/threads/claim-legacy.
const LEGACY_OWNER = '__legacy__';

function normaliseOwner(email) {
    return String(email || '').trim().toLowerCase();
}

function listThreads(ownerEmail) {
    const owner = normaliseOwner(ownerEmail);
    if (!owner) return [];
    const dir = userThreadsDir(owner);
    try {
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    } catch {
        return [];
    }
}


function readThread(id, ownerEmail) {
    const owner = normaliseOwner(ownerEmail);
    if (!owner) return null;
    try {
        const t = JSON.parse(fs.readFileSync(pathFor(id, owner), 'utf8'));
        // Lazy migration: earlier versions of save_situation stored the case-
        // summary content as a fake email in emails[0]. Spot that exact shape
        // and move the content into notes where it belongs. The heuristic is
        // tight (single email with empty from/to/subject/date and body that
        // starts with a markdown H1) so it only catches the legacy bug.
        if (Array.isArray(t.emails) && t.emails.length === 1) {
            const e = t.emails[0];
            if (e && !e.from && !e.to && !e.subject && !e.date &&
                typeof e.body === 'string' && e.body.trim().startsWith('# ')) {
                if (!Array.isArray(t.notes)) t.notes = [];
                t.notes.unshift({
                    id: 'note-migrated-' + Date.now(),
                    content: e.body.trim(),
                    kind: 'case-summary',
                    addedAt: e.addedAt || t.createdAt,
                });
                t.emails = [];
                writeThread(t);
                console.log('[q-threads] migrated legacy case-summary email -> note for thread ' + t.id);
            }
        }
        // Lazy migration: strip the old auto-kickoff message from chatHistory.
        // The previous version saved the kickoff prompt as a user message; it's
        // now sent silentUser:true. Old threads still have it in history so
        // remove any user message that opens with the legacy kickoff phrase.
        if (Array.isArray(t.chatHistory) && t.chatHistory.length > 0) {
            const isLegacyKickoff = (m) => m && m.role === 'user' && typeof m.content === 'string'
                && (/^Take this case\.?\s/i.test(m.content)
                    || /^Open this( case)? in Phase 1\.?\s/i.test(m.content));
            const before = t.chatHistory.length;
            t.chatHistory = t.chatHistory.filter(m => !isLegacyKickoff(m));
            if (t.chatHistory.length !== before) {
                writeThread(t);
                console.log('[q-threads] removed ' + (before - t.chatHistory.length) + ' legacy kickoff message(s) from thread ' + t.id);
            }
        }
        return t;
    } catch {
        return null;
    }
}


function writeThread(thread) {
    if (!thread || !thread.ownerEmail) throw new Error('writeThread: thread must have ownerEmail');
    thread.updatedAt = new Date().toISOString();
    fs.writeFileSync(pathFor(thread.id, thread.ownerEmail), JSON.stringify(thread, null, 2), 'utf8');
    return thread;
}


function createThread({ title, summary = '', content = '', ownerEmail = '' } = {}) {
    if (!title) throw new Error('title is required');
    const owner = normaliseOwner(ownerEmail);
    if (!owner) throw new Error('ownerEmail is required — Threads must be owned by a person');
    const id = uniqueId(slugify(title), owner);
    const now = new Date().toISOString();
    const thread = {
        id,
        ownerEmail: owner,
        title,
        summary,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        emails: [],
        chatHistory: [],
        notes: [],
        files: [],
        contacts: [],
        refs: [],
    };
    // `content` is the case summary / analysis — NOT an email. Goes into notes.
    if (content && content.trim()) {
        thread.notes.push({
            id: 'note-' + Date.now(),
            content: content.trim(),
            addedAt: now,
            kind: 'case-summary',
        });
    }
    writeThread(thread);
    return thread;
}

function addNote(threadId, { content, kind = 'note' } = {}, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread || !content) return null;
    if (!Array.isArray(thread.notes)) thread.notes = [];
    thread.notes.push({
        id: 'note-' + Date.now(),
        content: String(content).trim(),
        kind,
        addedAt: new Date().toISOString(),
    });
    return writeThread(thread);
}


function filesDirFor(threadId, ownerEmail) {
    return userDataPath(ownerEmail, 'threads/' + threadId + '-files');
}

// ── Contacts on a case ─────────────────────────────────────────
// People involved in this situation (council officer, landlord, the other
// side's rep, a helpful caseworker) so the user can phone/email straight from
// the case. Stored on the thread like notes/emails. A contact needs at least
// one of name / phone / email to be worth saving.
const cleanField = (s) => String(s || '').trim().slice(0, 300);

function addContact(threadId, contact = {}, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    const c = {
        id: 'contact-' + Date.now(),
        name: cleanField(contact.name),
        role: cleanField(contact.role),
        phone: cleanField(contact.phone),
        email: cleanField(contact.email),
        company: cleanField(contact.company),
        notes: cleanField(contact.notes),
        addedAt: new Date().toISOString(),
    };
    if (!c.name && !c.phone && !c.email) return null;
    if (!Array.isArray(thread.contacts)) thread.contacts = [];
    thread.contacts.push(c);
    return writeThread(thread);
}

function updateContact(threadId, contactId, patch = {}, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread || !Array.isArray(thread.contacts)) return null;
    const c = thread.contacts.find(x => x.id === contactId);
    if (!c) return null;
    for (const k of ['name', 'role', 'phone', 'email', 'company', 'notes']) {
        if (patch[k] !== undefined) c[k] = cleanField(patch[k]);
    }
    return writeThread(thread);
}

function removeContact(threadId, contactId, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread || !Array.isArray(thread.contacts)) return null;
    thread.contacts = thread.contacts.filter(c => c.id !== contactId);
    return writeThread(thread);
}

// ── Key details / reference numbers on a case ──────────────────
// Quick label:value facts you read off on a call — PCN ref, account number,
// claim ref, case number. Distinct from prose notes; meant to be glanceable.
function addRef(threadId, ref = {}, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    const r = {
        id: 'ref-' + Date.now(),
        label: cleanField(ref.label),
        value: cleanField(ref.value),
        addedAt: new Date().toISOString(),
    };
    if (!r.label && !r.value) return null;
    if (!Array.isArray(thread.refs)) thread.refs = [];
    thread.refs.push(r);
    return writeThread(thread);
}

function removeRef(threadId, refId, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread || !Array.isArray(thread.refs)) return null;
    thread.refs = thread.refs.filter(r => r.id !== refId);
    return writeThread(thread);
}

function addFile(threadId, { filename, mimeType, base64 } = {}, ownerEmail) {
    if (!filename || !base64) return null;
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;

    // Sanitise filename — strip path separators, keep extension
    const safe = String(filename).replace(/[\\/]/g, '_').replace(/^\.+/, '').slice(0, 200);
    if (!safe) return null;

    const dir = filesDirFor(threadId, thread.ownerEmail);
    fs.mkdirSync(dir, { recursive: true });

    // De-duplicate filenames within a thread
    let finalName = safe;
    let counter = 1;
    while (fs.existsSync(path.join(dir, finalName))) {
        const dot = safe.lastIndexOf('.');
        finalName = dot > 0
            ? `${safe.slice(0, dot)}-${++counter}${safe.slice(dot)}`
            : `${safe}-${++counter}`;
    }

    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(path.join(dir, finalName), buf);

    if (!Array.isArray(thread.files)) thread.files = [];
    thread.files.push({
        id: 'file-' + Date.now(),
        filename: finalName,
        mimeType: mimeType || 'application/octet-stream',
        size: buf.length,
        uploadedAt: new Date().toISOString(),
    });
    return writeThread(thread);
}

function readFile(threadId, filename, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    const safe = String(filename).replace(/[\\/]/g, '_').replace(/^\.+/, '');
    const filepath = path.join(filesDirFor(threadId, thread.ownerEmail), safe);
    if (!fs.existsSync(filepath)) return null;
    const meta = Array.isArray(thread.files)
        ? thread.files.find(f => f.filename === safe)
        : null;
    return {
        buffer: fs.readFileSync(filepath),
        mimeType: meta?.mimeType || 'application/octet-stream',
        filename: safe,
    };
}

function removeFile(threadId, filename, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    const safe = String(filename).replace(/[\\/]/g, '_').replace(/^\.+/, '');
    try { fs.unlinkSync(path.join(filesDirFor(threadId, thread.ownerEmail), safe)); } catch { /* already gone */ }
    if (Array.isArray(thread.files)) {
        thread.files = thread.files.filter(f => f.filename !== safe);
    }
    return writeThread(thread);
}

function renameFile(threadId, oldName, newName, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    const safeOld = String(oldName).replace(/[\\/]/g, '_').replace(/^\.+/, '');
    let safeNew = String(newName).replace(/[\\/]/g, '_').replace(/^\.+/, '').slice(0, 200);
    if (!safeOld || !safeNew || safeOld === safeNew) return thread;
    // Preserve extension if not supplied in new name
    const oldExt = path.extname(safeOld);
    if (oldExt && !path.extname(safeNew)) safeNew += oldExt;
    const dir = filesDirFor(threadId, thread.ownerEmail);
    const oldPath = path.join(dir, safeOld);
    const newPath = path.join(dir, safeNew);
    if (!fs.existsSync(oldPath)) return null;
    if (fs.existsSync(newPath)) return null; // would clobber
    fs.renameSync(oldPath, newPath);
    if (Array.isArray(thread.files)) {
        const f = thread.files.find(f => f.filename === safeOld);
        if (f) f.filename = safeNew;
    }
    return writeThread(thread);
}


function addEmail(threadId, { type = 'in', from = '', to = '', date = '', subject = '', body = '' } = {}, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    thread.emails.push({
        id: 'email-' + Date.now(),
        type, from, to, date, subject, body,
        addedAt: new Date().toISOString(),
    });
    return writeThread(thread);
}


function removeEmail(threadId, emailId, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    const before = (thread.emails || []).length;
    thread.emails = (thread.emails || []).filter(e => e.id !== emailId);
    if (thread.emails.length === before) return null;
    return writeThread(thread);
}

// Per-thread persistent text extraction cache.
// Stores Gemini/RTF extracted text inside the thread JSON so it survives
// Railway restarts. The in-memory _threadDocCache in routes.js is still
// the hot path; this is the cold-start fallback bucket.
function getTextCache(threadId, filename, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread || !thread.textCache) return null;
    return thread.textCache[filename] ?? null;
}

function setTextCache(threadId, filename, text, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return;
    if (!thread.textCache) thread.textCache = {};
    thread.textCache[filename] = text;
    writeThread(thread);
}

function appendChat(threadId, role, content, ownerEmail) {
    const thread = readThread(threadId, ownerEmail);
    if (!thread) return null;
    thread.chatHistory.push({
        role, content,
        timestamp: new Date().toISOString(),
    });
    return writeThread(thread);
}


function updateThread(id, patch, ownerEmail) {
    const thread = readThread(id, ownerEmail);
    if (!thread) return null;
    if (patch.title)   thread.title = patch.title;
    if (patch.summary !== undefined) thread.summary = patch.summary;
    if (patch.status)  thread.status = patch.status;
    return writeThread(thread);
}


function deleteThread(id, ownerEmail) {
    const owner = normaliseOwner(ownerEmail);
    if (!owner) return false;
    // Verify ownership before deleting
    const thread = readThread(id, owner);
    if (!thread) return false;
    try {
        fs.unlinkSync(pathFor(id, owner));
        // Best-effort cleanup of the files dir
        try {
            const fdir = filesDirFor(id, owner);
            if (fs.existsSync(fdir)) fs.rmSync(fdir, { recursive: true, force: true });
        } catch { /* ignore */ }
        return true;
    } catch {
        return false;
    }
}


/**
 * One-time legacy migration: move every Thread from the old shared dir
 * (${VOLUME}/threads/) into the given user's per-user dir. Used by the
 * server bootstrap to claim legacy unowned data for the admin (Sarah).
 * Idempotent — re-running on an already-claimed shared dir is a no-op.
 * Returns { claimed: N }.
 */
function claimLegacyThreads(ownerEmail) {
    const owner = normaliseOwner(ownerEmail);
    if (!owner) return { claimed: 0, error: 'ownerEmail required' };
    if (!fs.existsSync(LEGACY_SHARED_DIR)) return { claimed: 0 };

    const userDir = userThreadsDir(owner);
    fs.mkdirSync(userDir, { recursive: true });   // ensure target dir exists
    let claimed = 0;
    try {
        for (const f of fs.readdirSync(LEGACY_SHARED_DIR)) {
            if (!f.endsWith('.json')) continue;
            const oldPath = path.join(LEGACY_SHARED_DIR, f);
            try {
                const t = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
                t.ownerEmail = owner;
                t.updatedAt = new Date().toISOString();
                const newPath = path.join(userDir, f);
                fs.writeFileSync(newPath, JSON.stringify(t, null, 2), 'utf8');
                fs.unlinkSync(oldPath);
                // Move associated files dir if present
                const oldFilesDir = path.join(LEGACY_SHARED_DIR, t.id + '-files');
                if (fs.existsSync(oldFilesDir)) {
                    const newFilesDir = filesDirFor(t.id, owner);
                    fs.mkdirSync(path.dirname(newFilesDir), { recursive: true });
                    try { fs.renameSync(oldFilesDir, newFilesDir); }
                    catch { /* may exist or cross-device — leave for next boot */ }
                }
                claimed++;
            } catch (e) {
                console.warn('[q-threads] could not migrate ' + f + ': ' + e.message);
            }
        }
        // If shared dir is now empty, remove it
        try {
            if (fs.readdirSync(LEGACY_SHARED_DIR).length === 0) fs.rmdirSync(LEGACY_SHARED_DIR);
        } catch { /* not empty or cannot remove — leave */ }
    } catch { /* dir issue */ }
    return { claimed };
}

/**
 * Best-effort email parser — pulls From/To/Subject/Date and body out of a
 * .eml-style or pasted-headers text blob. Returns null if it doesn't look
 * like an email (so the caller can fall back to treating it as a file).
 */
function parseEmailContent(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.replace(/^﻿/, ''); // strip BOM if present
    // Find header / body separator (blank line)
    const sep = trimmed.search(/\r?\n\r?\n/);
    const headers = sep === -1 ? trimmed : trimmed.slice(0, sep);
    const body    = sep === -1 ? ''      : trimmed.slice(sep).replace(/^\r?\n\r?\n/, '');

    const hasFrom    = /^from:\s*\S/im.test(headers);
    const hasSubject = /^subject:\s*\S/im.test(headers);
    const hasTo      = /^to:\s*\S/im.test(headers);
    if (!hasFrom && !hasSubject && !hasTo) return null;

    const get = (key) => {
        const m = headers.match(new RegExp(`^${key}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'));
        return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
    };
    return {
        from:    get('from'),
        to:      get('to'),
        subject: get('subject'),
        date:    get('date'),
        body:    body.trim() || trimmed.trim(),
    };
}

module.exports = {
    listThreads,
    readThread,
    createThread,
    addEmail,
    removeEmail,
    addNote,
    addContact,
    updateContact,
    removeContact,
    addRef,
    removeRef,
    appendChat,
    getTextCache,
    setTextCache,
    updateThread,
    deleteThread,
    writeThread,
    addFile,
    readFile,
    removeFile,
    renameFile,
    parseEmailContent,
    claimLegacyThreads,
    LEGACY_OWNER,
    normaliseOwner,
};
