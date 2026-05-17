'use strict';

/**
 * Q PUSH — web push notification engine
 *
 * Subscription storage: per-user JSON in the Railway volume.
 * VAPID keys: read from env vars (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
 *   If not set, keys are auto-generated on first boot and logged — add them
 *   to Railway env so they survive redeploys.
 *
 * Data path: data/users/{email-slug}/push/subscriptions.json
 */

const fs   = require('fs');
const path = require('path');
const { userDataPath } = require('./user-data');

function getWebPush() {
    try { return require('web-push'); }
    catch { throw new Error('[q-push] web-push not installed — run: npm i web-push'); }
}

// ── VAPID keys ───────────────────────────────────────────────────

const VAPID_SUBJECT = 'mailto:sarah@quotem.app';

function getVapidKeys() {
    const pub  = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (pub && priv) return { publicKey: pub, privateKey: priv };

    // Not in env — try persisted file in volume
    const keyFile = path.join(
        process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'),
        'q-push-vapid.json'
    );
    if (fs.existsSync(keyFile)) {
        try {
            const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
            if (saved.publicKey && saved.privateKey) return saved;
        } catch { /* corrupt — regenerate below */ }
    }

    // Generate new keys, persist, log once so Sarah can add them to Railway
    const webpush = getWebPush();
    const keys = webpush.generateVAPIDKeys();
    try {
        const dir = path.dirname(keyFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyFile, JSON.stringify(keys, null, 2));
    } catch (e) {
        console.warn('[q-push] could not save VAPID keys:', e.message);
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Q PUSH — new VAPID keys generated (copy to Railway env vars)');
    console.log('  VAPID_PUBLIC_KEY=' + keys.publicKey);
    console.log('  VAPID_PRIVATE_KEY=' + keys.privateKey);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    return keys;
}

let _vapidInitialised = false;
function ensureVapid() {
    if (_vapidInitialised) return;
    const webpush = getWebPush();
    const keys = getVapidKeys();
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    _vapidInitialised = true;
}

function getPublicKey() {
    return getVapidKeys().publicKey;
}


// ── Subscription storage ─────────────────────────────────────────

function subsPath(email) {
    return userDataPath(email, 'push/subscriptions.json');
}

function loadSubs(email) {
    const p = subsPath(email);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* */ }
    return [];
}

function saveSubs(email, subs) {
    const p = subsPath(email);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(subs, null, 2));
}

function saveSubscription(email, subscription) {
    const subs = loadSubs(email);
    const endpoint = subscription.endpoint;
    // Replace if already stored (e.g. re-subscribe after permission revoke)
    const idx = subs.findIndex(s => s.endpoint === endpoint);
    if (idx >= 0) subs[idx] = subscription;
    else subs.push(subscription);
    saveSubs(email, subs);
    console.log(`[q-push] subscription saved for ${email} (${subs.length} total)`);
}

function removeSubscription(email, endpoint) {
    const subs = loadSubs(email).filter(s => s.endpoint !== endpoint);
    saveSubs(email, subs);
}

function getSubscriptions(email) {
    return loadSubs(email);
}


// ── Send ─────────────────────────────────────────────────────────

/**
 * Send a push notification to all subscriptions for a given user.
 * Silently removes any subscription that the push service reports as expired/gone.
 *
 * @param {string} email
 * @param {object} payload  — { title, body, url, icon }
 * @returns {{ sent: number, failed: number }}
 */
async function pushToUser(email, { title = 'Q', body = '', url = '/', icon = '/favicon-192.png' } = {}) {
    ensureVapid();
    const webpush = getWebPush();
    const subs = loadSubs(email);
    if (!subs.length) {
        console.log(`[q-push] no subscriptions for ${email}`);
        return { sent: 0, failed: 0 };
    }

    const payload = JSON.stringify({ title, body, url, icon });
    let sent = 0;
    let failed = 0;
    const dead = [];

    await Promise.all(subs.map(async (sub) => {
        try {
            await webpush.sendNotification(sub, payload);
            sent++;
        } catch (err) {
            failed++;
            // 404 or 410 = subscription is gone, clean it up
            if (err.statusCode === 404 || err.statusCode === 410) {
                dead.push(sub.endpoint);
            } else {
                console.warn(`[q-push] send error (${err.statusCode}):`, err.message?.slice(0, 120));
            }
        }
    }));

    if (dead.length) {
        saveSubs(email, subs.filter(s => !dead.includes(s.endpoint)));
        console.log(`[q-push] removed ${dead.length} expired subscription(s) for ${email}`);
    }

    console.log(`[q-push] pushed to ${email}: ${sent} sent, ${failed} failed`);
    return { sent, failed };
}


module.exports = {
    getPublicKey,
    saveSubscription,
    removeSubscription,
    getSubscriptions,
    pushToUser,
};
