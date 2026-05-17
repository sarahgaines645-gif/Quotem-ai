'use strict';

/**
 * doc-drop — QR-code document upload plugin
 *
 * Lets a user on a desktop generate a QR code. Someone scans it with
 * a phone, picks a file or takes a photo, and it lands on the server.
 * The desktop page polls until it arrives and processes it.
 *
 * Flow:
 *   1. Authenticated user calls createSession(label, ownerEmail)
 *      → gets back { id, token, label, createdAt, expiresAt }
 *   2. Desktop encodes `${baseUrl}/doc-drop/${token}` as a QR code
 *      (client-side — use qrcode.js or similar, no extra dep needed)
 *   3. Phone scans QR → opens the mobile upload page
 *   4. Phone POSTs file(s) to uploadHandler — NO auth, the token IS the auth
 *   5. Desktop polls getSession(id, ownerEmail) every 3s. When files
 *      appear in session.files, process them.
 *
 * Sessions are in-memory only (Map + TTL). They auto-expire after
 * SESSION_TTL_MS (default 30 min). Files persist on disk until the
 * consuming app explicitly calls deleteSession() or removes them.
 *
 * Dependencies: multer (file upload middleware — install in consuming app)
 * Storage: configurable via STORAGE_ROOT option or DOC_DROP_DIR env var
 *
 * Exports:
 *   createSession(label, ownerEmail, opts?)  → session object
 *   getSessionByToken(token)                 → session | null
 *   getSession(id, ownerEmail)               → session | null (ownership check)
 *   listSessions(ownerEmail)                 → session[]
 *   deleteSession(id, ownerEmail)            → { ok }
 *   makeUploadHandler(multerInstance)        → Express middleware for POST /doc-drop/:token
 *   readFileAsBase64(filePath)               → { base64, mimeType }
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// In-memory session store. Key = session id (hex). Values are session objects.
const sessions = new Map();

// ── Storage root ──────────────────────────────────────────────────────────

function getStorageRoot(opts = {}) {
    if (opts.storageRoot) return opts.storageRoot;
    if (process.env.DOC_DROP_DIR) return process.env.DOC_DROP_DIR;
    // Default: Railway volume if present, else local fallback
    const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    return vol
        ? path.join(vol, 'doc-drop')
        : path.join(process.cwd(), 'data', 'doc-drop');
}

// ── Session helpers ───────────────────────────────────────────────────────

function newId()    { return crypto.randomBytes(12).toString('hex'); }
function newToken() { return crypto.randomBytes(20).toString('hex'); }

function pruneExpired() {
    const now = Date.now();
    for (const [id, s] of sessions.entries()) {
        if (s.expiresAt < now) sessions.delete(id);
    }
}

/**
 * Create a new upload session.
 * @param {string} label       — human-readable name shown on mobile page
 * @param {string} ownerEmail  — email of the authenticated user who owns this session
 * @param {object} opts        — { ttlMs, storageRoot, meta }
 */
function createSession(label, ownerEmail, opts = {}) {
    pruneExpired();
    const id        = newId();
    const token     = newToken();
    const now       = Date.now();
    const ttl       = opts.ttlMs || SESSION_TTL_MS;
    const session   = {
        id,
        token,
        label:      String(label || 'Upload').slice(0, 120),
        ownerEmail: String(ownerEmail || '').toLowerCase().trim(),
        createdAt:  new Date(now).toISOString(),
        expiresAt:  now + ttl,
        meta:       opts.meta || {},       // consuming app can store context (e.g. 'statement' vs 'document')
        files:      [],
    };
    sessions.set(id, session);
    return safeSession(session);
}

/**
 * Look up a session by its public upload token.
 * Returns only the safe (non-path) view.
 */
function getSessionByToken(token) {
    pruneExpired();
    for (const s of sessions.values()) {
        if (s.token === token) return safeSession(s);
    }
    return null;
}

/**
 * Get a session by id, ownership-checked.
 * Returns the session with the full file list (paths stripped for safety).
 */
function getSession(id, ownerEmail) {
    pruneExpired();
    const s = sessions.get(id);
    if (!s) return null;
    if (s.ownerEmail !== String(ownerEmail || '').toLowerCase().trim()) return null;
    return safeSession(s);
}

/**
 * List all active sessions owned by this email.
 */
function listSessions(ownerEmail) {
    pruneExpired();
    const owner = String(ownerEmail || '').toLowerCase().trim();
    return [...sessions.values()]
        .filter(s => s.ownerEmail === owner)
        .map(safeSession);
}

/**
 * Delete a session and remove its files from disk.
 */
function deleteSession(id, ownerEmail) {
    const s = sessions.get(id);
    if (!s) return { ok: false, error: 'Session not found' };
    if (s.ownerEmail !== String(ownerEmail || '').toLowerCase().trim()) {
        return { ok: false, error: 'Not your session' };
    }
    // Remove files from disk
    for (const f of s.files) {
        try { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); } catch { /* */ }
    }
    sessions.delete(id);
    return { ok: true };
}

// Strip internal filePath from the response — consuming app accesses via readFileAsBase64
function safeSession(s) {
    return {
        id:         s.id,
        token:      s.token,
        label:      s.label,
        ownerEmail: s.ownerEmail,
        createdAt:  s.createdAt,
        expiresAt:  new Date(s.expiresAt).toISOString(),
        meta:       s.meta,
        files:      s.files.map(f => ({
            id:         f.id,
            filename:   f.filename,
            mimeType:   f.mimeType,
            sizeBytes:  f.sizeBytes,
            uploadedAt: f.uploadedAt,
        })),
    };
}


// ── Upload handler ────────────────────────────────────────────────────────

/**
 * Build an Express route handler for  POST /doc-drop/:token
 * Pass in a configured multer instance — the consuming app controls
 * file size limits and storage location.
 *
 * Usage in routes.js:
 *   const multer = require('multer');
 *   const upload = multer({ dest: os.tmpdir() });
 *   const { makeUploadHandler } = require('./doc-drop');
 *   router.post('/doc-drop/:token', upload.array('files', 10), makeUploadHandler());
 */
function makeUploadHandler(opts = {}) {
    const storageRoot = getStorageRoot(opts);
    fs.mkdirSync(storageRoot, { recursive: true });

    return async function uploadHandler(req, res) {
        const token   = req.params.token;
        const session = getSessionByToken(token); // safe view only
        if (!session) return res.status(404).json({ error: 'Invalid or expired upload link' });

        const fullSession = sessions.get(session.id); // need mutable ref
        if (!fullSession) return res.status(404).json({ error: 'Session expired' });

        const files = req.files || (req.file ? [req.file] : []);
        if (!files.length) return res.status(400).json({ error: 'No files received' });

        const sessionDir = path.join(storageRoot, session.id);
        fs.mkdirSync(sessionDir, { recursive: true });

        const saved = [];
        for (const f of files) {
            const ext      = path.extname(f.originalname || '').toLowerCase().slice(0, 8) || '';
            const safeName = crypto.randomBytes(10).toString('hex') + ext;
            const dest     = path.join(sessionDir, safeName);

            try {
                if (f.path) {
                    // multer disk storage — move from tmp to session dir
                    fs.renameSync(f.path, dest);
                } else if (f.buffer) {
                    // multer memory storage — write buffer
                    fs.writeFileSync(dest, f.buffer);
                } else {
                    continue;
                }
            } catch (e) {
                console.error('[doc-drop] file save error:', e.message);
                continue;
            }

            const fileEntry = {
                id:         newId(),
                filename:   f.originalname || safeName,
                mimeType:   f.mimetype || 'application/octet-stream',
                sizeBytes:  f.size || 0,
                filePath:   dest,
                uploadedAt: new Date().toISOString(),
            };
            fullSession.files.push(fileEntry);
            saved.push({ id: fileEntry.id, filename: fileEntry.filename });
        }

        res.json({ ok: true, uploaded: saved.length, files: saved });
    };
}


// ── File access ───────────────────────────────────────────────────────────

/**
 * Read a file from a session as a base64 string + mimeType.
 * The consuming app calls this when it's ready to process the file
 * (e.g. send it to a vision model or statement parser).
 *
 * @param {string} sessionId   — session id
 * @param {string} fileId      — file id within the session
 * @param {string} ownerEmail  — ownership check
 * @returns {{ base64, mimeType, filename }} | null
 */
function readFileAsBase64(sessionId, fileId, ownerEmail) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    if (s.ownerEmail !== String(ownerEmail || '').toLowerCase().trim()) return null;
    const f = s.files.find(x => x.id === fileId);
    if (!f) return null;
    if (!fs.existsSync(f.filePath)) return null;
    return {
        base64:   fs.readFileSync(f.filePath).toString('base64'),
        mimeType: f.mimeType,
        filename: f.filename,
    };
}


module.exports = {
    createSession,
    getSessionByToken,
    getSession,
    listSessions,
    deleteSession,
    makeUploadHandler,
    readFileAsBase64,
};
