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
        files: [],
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


function filesDirFor(threadId) {
    return path.join(VOLUME_DIR, threadId + '-files');
}

function addFile(threadId, { filename, mimeType, base64 } = {}) {
    if (!filename || !base64) return null;
    const thread = readThread(threadId);
    if (!thread) return null;

    // Sanitise filename — strip path separators, keep extension
    const safe = String(filename).replace(/[\\/]/g, '_').replace(/^\.+/, '').slice(0, 200);
    if (!safe) return null;

    const dir = filesDirFor(threadId);
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

function readFile(threadId, filename) {
    const safe = String(filename).replace(/[\\/]/g, '_').replace(/^\.+/, '');
    const filepath = path.join(filesDirFor(threadId), safe);
    if (!fs.existsSync(filepath)) return null;
    const thread = readThread(threadId);
    const meta = thread && Array.isArray(thread.files)
        ? thread.files.find(f => f.filename === safe)
        : null;
    return {
        buffer: fs.readFileSync(filepath),
        mimeType: meta?.mimeType || 'application/octet-stream',
        filename: safe,
    };
}

function removeFile(threadId, filename) {
    const thread = readThread(threadId);
    if (!thread) return null;
    const safe = String(filename).replace(/[\\/]/g, '_').replace(/^\.+/, '');
    try { fs.unlinkSync(path.join(filesDirFor(threadId), safe)); } catch { /* already gone */ }
    if (Array.isArray(thread.files)) {
        thread.files = thread.files.filter(f => f.filename !== safe);
    }
    return writeThread(thread);
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
    addFile,
    readFile,
    removeFile,
};
