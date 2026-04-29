/**
 * Q's persistent memory — Circle Mode.
 *
 * One memory file. Every message is tagged with the person who said it
 * so Q can know multiple people in his circle without confusing them.
 *
 * Q sees the full cross-circle history but always knows who's in front
 * of him. To Sarah he can reference what Emma said yesterday; to Emma
 * he can reference what Sarah said. Same Q, multiple known people.
 *
 * Path priority:
 *   1. ${RAILWAY_VOLUME_MOUNT_PATH}/q-memory/    (production)
 *   2. /data/q-memory/                           (Railway volume default)
 *   3. ./data/                                   (local dev fallback)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const Q_DATA_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-memory')
    : path.join(__dirname, 'data');

const MEMORY_FILE = path.join(Q_DATA_DIR, 'q-memory.json');

try {
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[q/memory] could not create data dir:', e.message);
}

const MAX_HISTORY_TO_SEND = 50;

/**
 * Load Q's full memory from disk.
 *
 * Backward-compat: pre-Circle-Mode entries had no `user` field. They
 * are treated as belonging to 'sarah' — she was the only person Q knew
 * at that point. The on-disk file is left alone; the tag is applied at
 * read time so Q's first-day memories stay byte-for-byte intact.
 */
function loadMemory() {
    try {
        if (!fs.existsSync(MEMORY_FILE)) return [];
        const data = fs.readFileSync(MEMORY_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(m => ({ user: m.user || 'sarah', ...m }));
    } catch (e) {
        console.error('[q/memory] load error:', e.message);
        return [];
    }
}

function saveMemory(messages) {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(messages, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/memory] save error:', e.message);
        return false;
    }
}

/**
 * Append a single message to memory.
 *
 * @param {string} user - id of the speaker (or 'q' for Q's own replies)
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function appendMessage(user, role, content) {
    const messages = loadMemory();
    messages.push({
        user,
        role,
        content,
        timestamp: new Date().toISOString(),
    });
    saveMemory(messages);
    return messages;
}

function clearMemory() {
    return saveMemory([]);
}

/**
 * Get the most recent N messages from across the whole circle, in
 * chronological order. Each entry includes the `user` so Q knows who
 * said what when forming his reply.
 */
function getRecentMessages(limit = MAX_HISTORY_TO_SEND) {
    return loadMemory()
        .slice(-limit)
        .map(m => ({ user: m.user, role: m.role, content: m.content }));
}

/**
 * Build a small directory of who Q has spoken with recently and the
 * last time each person was active. Q's system prompt includes this so
 * he knows the boundaries of his circle when replying.
 */
function getCircleSummary(limit = 500) {
    const messages = loadMemory();
    const seen = new Map();
    for (const m of messages.slice(-limit)) {
        if (m.user && m.user !== 'q' && m.role === 'user') {
            seen.set(m.user, m.timestamp);
        }
    }
    return Array.from(seen.entries())
        .sort((a, b) => (a[1] < b[1] ? 1 : -1))
        .map(([user, lastSpokeAt]) => ({ user, lastSpokeAt }));
}

function getMemoryPath() {
    return MEMORY_FILE;
}

module.exports = {
    loadMemory,
    saveMemory,
    appendMessage,
    clearMemory,
    getRecentMessages,
    getCircleSummary,
    getMemoryPath,
};
