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

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'threads')
    : path.join(__dirname, '..', 'data', 'threads');


function ensureDir() {
    fs.mkdirSync(VOLUME_DIR, { recursive: true });
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'thread-' + Date.now();
}

function pathFor(id) {
    return path.join(VOLUME_DIR, id + '.json');
}

function uniqueId(base) {
    let id = base;
    let counter = 1;
    while (fs.existsSync(pathFor(id))) {
        id = `${base}-${++counter}`;
    }
    return id;
}


function listThreads() {
    ensureDir();
    try {
        return fs.readdirSync(VOLUME_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(VOLUME_DIR, f), 'utf8')); }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    } catch {
        return [];
    }
}


function readThread(id) {
    try {
        return JSON.parse(fs.readFileSync(pathFor(id), 'utf8'));
    } catch {
        return null;
    }
}


function writeThread(thread) {
    ensureDir();
    thread.updatedAt = new Date().toISOString();
    fs.writeFileSync(pathFor(thread.id), JSON.stringify(thread, null, 2), 'utf8');
    return thread;
}


function createThread({ title, summary = '', content = '' } = {}) {
    if (!title) throw new Error('title is required');
    const id = uniqueId(slugify(title));
    const now = new Date().toISOString();
    const thread = {
        id,
        title,
        summary,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        emails: [],
        chatHistory: [],
        notes: [],
    };
    if (content) {
        thread.emails.push({
            id: 'email-' + Date.now(),
            type: 'in',
            from: '', to: '', date: '', subject: '',
            body: content,
            addedAt: now,
        });
    }
    writeThread(thread);
    return thread;
}


function addEmail(threadId, { type = 'in', from = '', to = '', date = '', subject = '', body = '' } = {}) {
    const thread = readThread(threadId);
    if (!thread) return null;
    thread.emails.push({
        id: 'email-' + Date.now(),
        type, from, to, date, subject, body,
        addedAt: new Date().toISOString(),
    });
    return writeThread(thread);
}


function appendChat(threadId, role, content) {
    const thread = readThread(threadId);
    if (!thread) return null;
    thread.chatHistory.push({
        role, content,
        timestamp: new Date().toISOString(),
    });
    return writeThread(thread);
}


function updateThread(id, patch) {
    const thread = readThread(id);
    if (!thread) return null;
    if (patch.title)   thread.title = patch.title;
    if (patch.summary !== undefined) thread.summary = patch.summary;
    if (patch.status)  thread.status = patch.status;
    return writeThread(thread);
}


function deleteThread(id) {
    try { fs.unlinkSync(pathFor(id)); return true; }
    catch { return false; }
}


module.exports = {
    listThreads,
    readThread,
    createThread,
    addEmail,
    appendChat,
    updateThread,
    deleteThread,
    writeThread,
};
