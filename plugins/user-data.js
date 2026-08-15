'use strict';

/**
 * USER DATA — single helper that resolves filesystem paths into per-user
 * directories on the Railway volume.
 *
 * Every user-specific store in Q-ai goes through this. The path itself
 * encodes the user, so a feature physically can't read or write data
 * belonging to another user — there is no shared file to leak.
 *
 *   userDataPath('sarah@example.com', 'finance/transactions.json')
 *   → /data-volume/users/sarah_example_com_<10-hex>/finance/transactions.json
 *
 * The directory name is the readable legacy slug PLUS a 10-hex sha256 tail
 * of the normalised email, so two DIFFERENT emails can never share a
 * directory (they used to — see legacyEmailSlug below and the boot-time
 * migration migrateLegacyUserDirs). Filesystem-safe on every OS.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_BASE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'users')
    : path.join(__dirname, '..', 'data', 'users');


function normaliseEmail(email) {
    return String(email || '').trim().toLowerCase();
}

/**
 * The ORIGINAL slug (pre 2026-08-15). Lowercase, every non-alphanumeric →
 * '_'. It is MANY-TO-ONE: john.smith@x.com, john-smith@x.com and
 * john_smith@x.com all became `john_smith_x_com` and therefore shared one
 * user directory (audit AUDIT_2026-05-19_USER-DATA-ISOLATION, issue 1 —
 * a real cross-user data leak). Kept ONLY so the boot-time migration can
 * find the old directories and rename them. Never key storage on this.
 */
function legacyEmailSlug(email) {
    return normaliseEmail(email).replace(/[^a-z0-9]/g, '_');
}

/**
 * Filesystem-safe slug from an email address that CANNOT collide for two
 * different addresses: the readable legacy slug + '_' + the first 10 hex
 * chars of sha256(trimmed, lowercased email). Two emails that differ in
 * any character get different hashes, so `a.b@x` and `a-b@x` now live in
 * `a_b_x_7c3f…` and `a_b_x_91e0…`. Stable for a given email.
 */
function emailSlug(email) {
    const norm = normaliseEmail(email);
    if (!norm) return '';
    const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 10);
    return `${legacyEmailSlug(norm)}_${hash}`;
}

/**
 * Migrate on-disk user directories from the legacy (collision-prone) slug to
 * the hashed slug. Called at boot with the list of KNOWN people; idempotent
 * and safe to run every start:
 *
 *   • old dir exists, new dir doesn't          → rename old → new
 *   • new dir already exists                    → nothing to do
 *   • two+ known people share ONE old slug AND
 *     that old dir exists                       → DO NOT GUESS whose data it
 *     is. Leave it, log a CRITICAL line naming the collision (emails masked)
 *     so Sarah resolves it by hand.
 *   • old dir exists AND new dir exists         → leave both, warn (someone
 *     already wrote under the new key; merging blindly could destroy data)
 *
 * Returns { renamed, skipped, collisions } for the boot log.
 */
function migrateLegacyUserDirs(people = []) {
    const out = { renamed: [], skipped: [], collisions: [] };
    if (!fs.existsSync(USER_BASE_DIR)) return out;

    // Group known people by their OLD slug so collisions are visible.
    const byOld = new Map();
    for (const p of people) {
        const email = normaliseEmail(p && p.email);
        if (!email) continue;
        const old = legacyEmailSlug(email);
        if (!byOld.has(old)) byOld.set(old, []);
        byOld.get(old).push(email);
    }

    for (const [oldSlug, emails] of byOld) {
        const oldDir = path.join(USER_BASE_DIR, oldSlug);
        if (!fs.existsSync(oldDir)) continue;                 // nothing under the old key
        if (emails.length > 1) {
            const masked = emails.map(maskEmail).join(', ');
            console.error(`[user-data] 🔴 CRITICAL: ${emails.length} accounts share the OLD storage key "${oldSlug}" (${masked}). Their data is FUSED in ${oldDir}. NOT migrating — Sarah must split it by hand into the new per-user directories, then this line goes away.`);
            out.collisions.push({ oldSlug, emails: emails.map(maskEmail) });
            continue;
        }
        const email = emails[0];
        const newDir = path.join(USER_BASE_DIR, emailSlug(email));
        if (fs.existsSync(newDir)) {
            // Both exist — never merge blindly.
            const newHasContent = safeReaddir(newDir).length > 0;
            if (!newHasContent) {
                // Empty new dir (e.g. created by a mkdirSync race at boot) — safe to replace.
                try { fs.rmdirSync(newDir); } catch { /* fallthrough to warn */ }
            }
            if (fs.existsSync(newDir)) {
                console.warn(`[user-data] ⚠️ both "${oldSlug}" and "${path.basename(newDir)}" exist for ${maskEmail(email)} — leaving both untouched; reconcile by hand.`);
                out.skipped.push({ oldSlug, newSlug: path.basename(newDir), reason: 'both-exist' });
                continue;
            }
        }
        try {
            fs.renameSync(oldDir, newDir);
            console.log(`[user-data] migrated ${maskEmail(email)}: ${oldSlug} → ${path.basename(newDir)}`);
            out.renamed.push({ oldSlug, newSlug: path.basename(newDir) });
        } catch (e) {
            console.error(`[user-data] ❌ could not rename ${oldSlug} → ${path.basename(newDir)}: ${e.message}`);
            out.skipped.push({ oldSlug, newSlug: path.basename(newDir), reason: e.message });
        }
    }
    return out;
}

function safeReaddir(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
}

// s***h@e***.com — enough to recognise, never the full address in a log.
function maskEmail(email) {
    const [local = '', domain = ''] = String(email).split('@');
    const m = (s) => s.length <= 2 ? s[0] + '*' : s[0] + '***' + s[s.length - 1];
    return domain ? `${m(local)}@${m(domain)}` : m(local);
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


module.exports = { userDataPath, userDir, emailSlug, legacyEmailSlug, migrateLegacyUserDirs, maskEmail, USER_BASE_DIR };
