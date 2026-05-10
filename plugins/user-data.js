'use strict';

/**
 * USER DATA — single helper that resolves filesystem paths into per-user
 * directories on the Railway volume.
 *
 * Every user-specific store in Q-ai goes through this. The path itself
 * encodes the user, so a feature physically can't read or write data
 * belonging to another user — there is no shared file to leak.
 *
 *   userDataPath('sarah@example.com', 'q-voice/override.wav')
 *   → /data-volume/users/sarah_example_com/q-voice/override.wav
 *
 * Email is slugified (lowercase, non-alphanumeric → underscore) so it's
 * filesystem-safe across operating systems.
 */

const fs = require('fs');
const path = require('path');

const USER_BASE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'users')
    : path.join(__dirname, '..', 'data', 'users');


/**
 * Filesystem-safe slug from an email address. Lowercased, non-alphanumeric
 * characters become underscores. Stable for a given email.
 */
function emailSlug(email) {
    return String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
}


/**
 * Return the user's root directory on disk, creating it if needed.
 * Throws if email is empty — callers should never reach this code path
 * without a verified person on the request.
 */
function userDir(personEmail) {
    const slug = emailSlug(personEmail);
    if (!slug) throw new Error('user-data: a non-empty personEmail is required');
    const dir = path.join(USER_BASE_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}


/**
 * Resolve `subpath` inside the user's directory, creating any missing
 * parent directories. Returns an absolute filesystem path.
 *
 * Example:
 *   userDataPath('a@b.com', 'q-voice/override.wav')
 *   → '/.../users/a_b_com/q-voice/override.wav'   (parent dir guaranteed)
 */
function userDataPath(personEmail, subpath) {
    const root = userDir(personEmail);
    if (!subpath) return root;
    const safe = String(subpath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (safe.includes('..')) throw new Error('user-data: subpath cannot contain ..');
    const full = path.join(root, safe);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    return full;
}


module.exports = { userDataPath, userDir, emailSlug, USER_BASE_DIR };
