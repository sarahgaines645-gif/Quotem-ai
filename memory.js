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

function getVoicePath(personId) {
    return path.join(Q_DATA_DIR, `q-voice-${safeId(personId)}.json`);
}

function getDocPath(personId) {
    return path.join(Q_DATA_DIR, `q-doc-${safeId(personId)}.json`);
}

// Q's tutor notebook — separate from his life memory and his facts. Holds the
// tutoring work for this person: the assignment he's coaching them on, the
// brief he built, which section they're on, the last thing they were stuck on.
// He knows it's a distinct notebook (not mixed into his everyday facts) and can
// reach it from any surface via the recall_tutor tool when the student asks.
function getTutorPath(personId) {
    return path.join(Q_DATA_DIR, `q-tutor-${safeId(personId)}.json`);
}

// ── Writer PROJECTS (16 Aug 2026) ────────────────────────────────────────
// One person, several assignments. The tutor notebook and the stored brief
// were one-per-person (a second brief overwrote the first). Now each project
// has its own notebook + doc, keyed by a SCOPE string that stands in for the
// personId in getTutorPath/getDocPath:
//     'main'  → the person's own id      (the legacy files — nothing moves,
//                                          Sarah's live session survives)
//     'p…'    → `${personId}--proj-${id}` (a new file pair per project)
// The index (one small file per person) lists the projects and which one is
// active. Voice signature and revision stay per person — they are not per
// assignment.
const PROJECT_ID_RE = /^(main|p[a-z0-9]{8,12})$/;
function getTutorIndexPath(personId) {
    return path.join(Q_DATA_DIR, `q-tutor-index-${safeId(personId)}.json`);
}
function tutorScope(personId, projectId) {
    const pid = String(projectId || 'main');
    return pid === 'main' ? String(personId) : `${personId}--proj-${pid}`;
}
function tutorFileHasWork(p) {
    try {
        if (!fs.existsSync(p)) return false;
        const t = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
        return Object.keys(t).some(k => k !== 'updatedAt');
    } catch (_) { return false; }
}
function readTutorIndex(personId) {
    const p = getTutorIndexPath(personId);
    try {
        if (fs.existsSync(p)) {
            const idx = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
            if (Array.isArray(idx.projects)) return idx;
        }
    } catch (_) { /* rebuild below */ }
    // First sight of this person: their existing notebook (if any) becomes
    // project 'main'. Nothing is copied or moved.
    const now = Date.now();
    const idx = { projects: [], active: null, updatedAt: now };
    if (tutorFileHasWork(getTutorPath(personId))) {
        idx.projects.push({ id: 'main', createdAt: now });
        idx.active = 'main';
    }
    writeTutorIndex(personId, idx);
    return idx;
}
function writeTutorIndex(personId, idx) {
    const out = { projects: Array.isArray(idx.projects) ? idx.projects : [], active: idx.active || null, updatedAt: Date.now() };
    fs.writeFileSync(getTutorIndexPath(personId), JSON.stringify(out));
    return out;
}
// The project a request is about: an explicit, valid, live id wins; else the
// active one; else 'main' (a brand-new person works exactly as before, and
// 'main' is registered the first time it is written to — see routes.js).
function resolveWriterProject(personId, requestedId) {
    const idx = readTutorIndex(personId);
    const req = String(requestedId || '').trim();
    if (req && PROJECT_ID_RE.test(req)) {
        if (req === 'main') return 'main';
        const hit = idx.projects.find(pr => pr.id === req && !pr.archived);
        if (hit) return req;
    }
    if (idx.active) {
        const act = idx.projects.find(pr => pr.id === idx.active && !pr.archived);
        if (act) return act.id;
    }
    return 'main';
}
// The notebook Q reads from other surfaces (recall_tutor): the active project.
function getActiveTutorPath(personId) {
    return getTutorPath(tutorScope(personId, resolveWriterProject(personId, null)));
}

// Q's revision book — per person: subject settings, question history (scores
// per topic), and the streak. The /revise page reads and writes the whole
// object; weak-topic targeting is derived from it.
function getRevisionPath(personId) {
    return path.join(Q_DATA_DIR, `q-revision-${safeId(personId)}.json`);
}

// The question bank — GLOBAL (shared, not per-person): Sonnet-checked
// multiple-choice questions kept forever, keyed by subject+board+level.
function getBankPath(bankKey) {
    return path.join(Q_DATA_DIR, `q-bank-${safeId(bankKey)}.json`);
}

module.exports = {
    loadMemory,
    saveMemory,
    appendMessage,
    clearMemory,
    getRecentMessages,
    getCircleSummary,
    getMemoryPath,
    getVoicePath,
    getDocPath,
    getTutorPath,
    getTutorIndexPath,
    tutorScope,
    readTutorIndex,
    writeTutorIndex,
    resolveWriterProject,
    getActiveTutorPath,
    PROJECT_ID_RE,
    getRevisionPath,
    getBankPath,
    migrateLegacyMemory,
};
