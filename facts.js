/**
 * q-lab/facts.js — Q's persistent fact store
 *
 * Distinct from memory.js (which holds chronological chat history).
 * facts.js is the discrete things Q has chosen to remember about the user
 * across sessions: preferences, names, ongoing projects, important dates.
 *
 * Same path resolution as memory.js — Railway volume in production,
 * q-lab/data/ locally.
 *
 * Single-user mode for now. Multi-user split later (key by user_id).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const Q_DATA_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-memory')
    : path.join(__dirname, 'data');

const FACTS_FILE = path.join(Q_DATA_DIR, 'q-facts.json');

try {
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[q/facts] could not create data dir:', e.message);
}

const MAX_FACTS = 500;            // soft cap — guard against runaway growth
const MAX_FACT_LENGTH = 1000;     // characters per fact

function loadFacts() {
    try {
        if (!fs.existsSync(FACTS_FILE)) return [];
        const data = fs.readFileSync(FACTS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[q/facts] load error:', e.message);
        return [];
    }
}

function saveFacts(facts) {
    try {
        fs.writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/facts] save error:', e.message);
        return false;
    }
}

function newFactId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Add a fact. Idempotent on exact-content match — duplicates of the same
 * string are silently ignored so Q doesn't accidentally fill the store
 * by re-remembering the same thing on every turn.
 */
function addFact({ content, tags = [], source = 'chat' } = {}) {
    if (!content || typeof content !== 'string' || !content.trim()) {
        return { error: 'Fact content required' };
    }
    const trimmed = content.trim().substring(0, MAX_FACT_LENGTH);
    const facts = loadFacts();

    // Deduplicate on exact content (case-insensitive).
    const lower = trimmed.toLowerCase();
    const existing = facts.find(f => f.content.toLowerCase() === lower);
    if (existing) {
        return { ok: true, id: existing.id, deduplicated: true, content: existing.content };
    }

    const fact = {
        id: newFactId(),
        content: trimmed,
        tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string').slice(0, 10) : [],
        source: typeof source === 'string' ? source.substring(0, 100) : 'chat',
        createdAt: new Date().toISOString(),
    };
    facts.push(fact);

    // Soft cap — drop oldest when exceeded so the store can't grow forever.
    if (facts.length > MAX_FACTS) {
        facts.splice(0, facts.length - MAX_FACTS);
    }
    saveFacts(facts);
    return { ok: true, id: fact.id, content: fact.content };
}

/**
 * List all facts, most recent first.
 */
function listFacts({ limit = 100 } = {}) {
    const facts = loadFacts();
    const sorted = facts.slice().reverse();
    return sorted.slice(0, Math.min(limit, MAX_FACTS));
}

/**
 * Substring search across content + tags. Case-insensitive.
 * Returns most-recent matches first.
 */
function searchFacts(query, { limit = 20 } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
        return listFacts({ limit });
    }
    const q = query.trim().toLowerCase();
    const facts = loadFacts();
    const matches = facts.filter(f =>
        (f.content || '').toLowerCase().includes(q)
        || (Array.isArray(f.tags) && f.tags.some(t => String(t).toLowerCase().includes(q)))
    );
    return matches.reverse().slice(0, Math.min(limit, MAX_FACTS));
}

/**
 * Delete one fact by id.
 */
function deleteFact(id) {
    const facts = loadFacts();
    const idx = facts.findIndex(f => f.id === id);
    if (idx === -1) return { ok: false, error: 'Fact not found' };
    const removed = facts.splice(idx, 1)[0];
    saveFacts(facts);
    return { ok: true, removed };
}

/**
 * Wipe all facts. Use with care.
 */
function clearFacts() {
    return saveFacts([]);
}

/**
 * Where the file actually lives. For debugging.
 */
function getFactsPath() {
    return FACTS_FILE;
}

module.exports = {
    addFact,
    listFacts,
    searchFacts,
    deleteFact,
    clearFacts,
    getFactsPath,
};
