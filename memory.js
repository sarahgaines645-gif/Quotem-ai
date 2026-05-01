/**
 * Q's persistent memory — per-person files.
 *
 * Each person Q knows has their own memory file. Q only sees the calling
 * person's history when generating a reply, so two people chatting with Q
 * get isolated experiences and one person's conversation never bleeds into
 * another's context.
 *
 * Path priority for the data directory:
 *   1. ${RAILWAY_VOLUME_MOUNT_PATH}/q-memory/    (production)
 *   2. /data/q-memory/                           (Railway volume default)
 *   3. ./data/                                   (local dev fallback)
 *
 * On disk:
 *   q-memory-sarah.json     ← Sarah's full thread with Q (preserves the
 *                              first-day memories from before per-person split)
 *   q-memory-{personId}.json
 *   q-memory.json.legacy    ← original shared file, kept as a safety backup
 *                              (untouched after migration; never read)
 *
 * Migration runs once on boot: if a legacy `q-memory.json` exists and the
 * per-person files don't, the legacy file is split — Sarah's pre-Circle-Mode
 * untagged turns go to her file, every other turn is routed to whoever spoke,
 * and Q's replies follow the most recent user (whoever Q was replying to).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const Q_DATA_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-memory')
    : path.join(__dirname, 'data');

try {
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[q/memory] could not create data dir:', e.message);
}

const MAX_HISTORY_TO_SEND = 50;

// Sanitise a person id for safe use as a filename component. Mirrors the
// id-generation rule in people.generateUniqueId so files always line up.
function safeId(personId) {
    return String(personId || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function getMemoryPath(personId) {
    return path.join(Q_DATA_DIR, `q-memory-${safeId(personId)}.json`);
}

function legacyPath() {
    return path.join(Q_DATA_DIR, 'q-memory.json');
}

function loadFile(file) {
    try {
        if (!fs.existsSync(file)) return [];
        const data = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[q/memory] load error for ' + file + ':', e.message);
        return [];
    }
}

/**
 * One-time migration. Splits a legacy shared `q-memory.json` into per-person
 * files. Idempotent — silently no-ops if the legacy file is missing or any
 * per-person file already exists. The legacy file is renamed to .legacy
 * after a successful split so it's preserved but never re-read.
 */
function migrateLegacyMemory() {
    const legacyFile = legacyPath();
    if (!fs.existsSync(legacyFile)) return;

    const messages = loadFile(legacyFile);
    if (messages.length === 0) {
        // empty legacy file — just rename it out of the way
        try { fs.renameSync(legacyFile, legacyFile + '.legacy'); } catch (e) {}
        return;
    }

    // Tag pre-Circle-Mode entries (no `user` field) — these all belong to
    // Sarah, the only person Q knew at that point.
    const tagged = messages.map(m => ({
        ...m,
        user: m.user || (m.role === 'assistant' ? 'q' : 'sarah'),
    }));

    // Group: each user turn goes to that user's file. Q's replies go to the
    // file of whoever Q was replying to (the most recent user before the reply).
    const perPerson = {};   // { personId: [{ role, content, timestamp }] }
    let lastSpeaker = 'sarah';
    for (const m of tagged) {
        const entry = { role: m.role, content: m.content, timestamp: m.timestamp };
        if (m.role === 'user') {
            lastSpeaker = m.user;
            (perPerson[m.user] = perPerson[m.user] || []).push(entry);
        } else if (m.role === 'assistant') {
            (perPerson[lastSpeaker] = perPerson[lastSpeaker] || []).push(entry);
        }
    }

    // Write each person's file. Skip if a per-person file already exists
    // (don't clobber anything that's been written since the legacy file).
    let wroteAny = false;
    for (const [personId, msgs] of Object.entries(perPerson)) {
        const file = getMemoryPath(personId);
        if (fs.existsSync(file)) continue;
        try {
            fs.writeFileSync(file, JSON.stringify(msgs, null, 2), 'utf8');
            wroteAny = true;
            console.log('[q/memory] migrated ' + msgs.length + ' messages → ' + file);
        } catch (e) {
            console.error('[q/memory] could not write ' + file + ':', e.message);
        }
    }

    if (wroteAny) {
        try {
            fs.renameSync(legacyFile, legacyFile + '.legacy');
            console.log('[q/memory] legacy file backed up to ' + legacyFile + '.legacy');
        } catch (e) {
            console.error('[q/memory] could not rename legacy file:', e.message);
        }
    }
}

// Run the migration at module load. Safe to call repeatedly — the function
// is idempotent (no-op when no legacy file is present).
migrateLegacyMemory();

/**
 * Load the full memory for a single person, in chronological order.
 * Returns an empty array for new people who haven't chatted with Q yet.
 */
function loadMemory(personId) {
    return loadFile(getMemoryPath(personId));
}

function saveMemory(personId, messages) {
    try {
        fs.writeFileSync(getMemoryPath(personId), JSON.stringify(messages, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/memory] save error for ' + personId + ':', e.message);
        return false;
    }
}

/**
 * Append a single message to a specific person's memory file.
 *
 * @param {string} personId - whose file to write to (the calling person)
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {string} [surface] - which UI the message came from ('chat', 'writer', etc).
 *                              Used for display filtering only — Q always sees the
 *                              whole thread regardless of surface.
 */
function appendMessage(personId, role, content, surface) {
    const messages = loadMemory(personId);
    messages.push({
        role,
        content,
        timestamp: new Date().toISOString(),
        surface: surface || 'chat',
    });
    saveMemory(personId, messages);
    return messages;
}

/** Wipe one person's memory. Sarah's wipe doesn't touch anyone else's. */
function clearMemory(personId) {
    return saveMemory(personId, []);
}

/**
 * Get the most recent N messages for a single person, in chronological
 * order. Used to build Q's prompt context — Q only ever sees the calling
 * person's history.
 */
function getRecentMessages(personId, limit = MAX_HISTORY_TO_SEND) {
    return loadMemory(personId)
        .slice(-limit)
        .map(m => ({ role: m.role, content: m.content }));
}

/**
 * Build a small directory of who Q has spoken with recently. Reads every
 * per-person file in the data dir and reports the last activity for each.
 * Used by admin views — NOT included in Q's chat context (privacy).
 */
function getCircleSummary() {
    try {
        const entries = fs.readdirSync(Q_DATA_DIR);
        const summary = [];
        for (const name of entries) {
            const m = name.match(/^q-memory-(.+)\.json$/);
            if (!m) continue;
            const personId = m[1];
            const msgs = loadFile(path.join(Q_DATA_DIR, name));
            const lastUser = [...msgs].reverse().find(x => x.role === 'user');
            if (lastUser && lastUser.timestamp) {
                summary.push({ user: personId, lastSpokeAt: lastUser.timestamp });
            }
        }
        return summary.sort((a, b) => (a.lastSpokeAt < b.lastSpokeAt ? 1 : -1));
    } catch (e) {
        console.error('[q/memory] circle summary error:', e.message);
        return [];
    }
}

module.exports = {
    loadMemory,
    saveMemory,
    appendMessage,
    clearMemory,
    getRecentMessages,
    getCircleSummary,
    getMemoryPath,
    migrateLegacyMemory,
};
