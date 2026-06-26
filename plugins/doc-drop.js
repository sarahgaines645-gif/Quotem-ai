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

// ── Persistence ───────────────────────────────────────────────────────────
// Sessions WERE in-memory only, so every server restart/deploy wiped active QR
// upload links — the phone would scan a token that no longer existed and show
// "Link not found" (even though the desktop had just generated the code). Persist
// them to disk so a restart can't orphan a live link. Best-effort; never throw.
const SESSIONS_FILE = path.join(getStorageRoot(), '_doc-drop-sessions.json');

function saveSessions() {
    try {
        fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()]), 'utf8');
    } catch (e) { console.warn('[doc-drop] could not persist sessions: ' + e.message); }
}

function loadSessions() {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return;
        const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        const now = Date.now();
        let n = 0;
        for (const s of (Array.isArray(arr) ? arr : [])) {
            if (s && s.id && typeof s.expiresAt === 'number' && s.expiresAt > now) { sessions.set(s.id, s); n++; }
        }
        if (n) console.log('[doc-drop] restored ' + n + ' live upload session(s) from disk');
    } catch (e) { console.warn('[doc-drop] could not load sessions: ' + e.message); }
}
loadSessions();

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
    saveSessions();
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
    saveSessions();
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


// ── Upload handler (base64 JSON — no multer dep) ──────────────────────────

/**
 * Handle a base64 upload POST from the mobile page.
 * Body: { base64, mimeType, filename }
 * Files are kept in-memory on the session object — no disk write needed
 * because the finance page reads them straight back as base64 via readFileAsBase64().
 *
 * Usage in routes.js:
 *   router.post('/api/doc-drop/upload/:token', express.json({ limit: '25mb' }), (req, res) => {
 *       docDrop.handleBase64Upload(req.params.token, req.body, res);
 *   });
 */
function handleBase64Upload(token, body, res) {
    const session = getSessionByToken(token);
    if (!session) return res.status(404).json({ error: 'Invalid or expired upload link' });

    const fullSession = sessions.get(session.id);
    if (!fullSession) return res.status(404).json({ error: 'Session expired' });

    const { base64, mimeType, filename } = body || {};
    if (!base64) return res.status(400).json({ error: 'base64 required' });

    const fileEntry = {
        id:         newId(),
        filename:   String(filename || 'upload').slice(0, 200),
        mimeType:   String(mimeType || 'application/octet-stream'),
        sizeBytes:  Math.round(base64.length * 0.75), // approx decoded size
        base64,     // stored in-memory — no disk needed
        uploadedAt: new Date().toISOString(),
    };
    fullSession.files.push(fileEntry);
    saveSessions();
    return res.json({ ok: true, uploaded: 1, files: [{ id: fileEntry.id, filename: fileEntry.filename }] });
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
    return {
        base64:   f.base64,
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
    handleBase64Upload,
    readFileAsBase64,
};
