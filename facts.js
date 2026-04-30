/**
 * Q's persistent fact store — per-person files.
 *
 * Each person has their own q-facts-{personId}.json so memories never
 * bleed between users. Sarah's legacy q-facts.json is kept as-is for
 * backward compatibility (her existing memories are preserved).
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
    console.error('[q/facts] could not create data dir:', e.message);
}

const MAX_FACTS = 500;
const MAX_FACT_LENGTH = 1000;

function safeId(personId) {
    return String(personId || 'sarah').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// Sarah keeps her legacy file so her existing memories are not lost.
// Everyone else gets q-facts-{id}.json.
function factsPath(personId) {
    const id = safeId(personId);
    if (id === 'sarah') return path.join(Q_DATA_DIR, 'q-facts.json');
    return path.join(Q_DATA_DIR, `q-facts-${id}.json`);
}

function loadFacts(personId) {
    const file = factsPath(personId);
    try {
        if (!fs.existsSync(file)) return [];
        const data = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[q/facts] load error:', e.message);
        return [];
    }
}

function saveFacts(facts, personId) {
    const file = factsPath(personId);
    try {
        fs.writeFileSync(file, JSON.stringify(facts, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/facts] save error:', e.message);
        return false;
    }
}

function newFactId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addFact({ content, tags = [], source = 'chat' } = {}, personId) {
    if (!content || typeof content !== 'string' || !content.trim()) {
        return { error: 'Fact content required' };
    }
    const trimmed = content.trim().substring(0, MAX_FACT_LENGTH);
    const facts = loadFacts(personId);

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

    if (facts.length > MAX_FACTS) {
        facts.splice(0, facts.length - MAX_FACTS);
    }
    saveFacts(facts, personId);
    return { ok: true, id: fact.id, content: fact.content };
}

function listFacts({ limit = 100 } = {}, personId) {
    const facts = loadFacts(personId);
    const sorted = facts.slice().reverse();
    return sorted.slice(0, Math.min(limit, MAX_FACTS));
}

function searchFacts(query, { limit = 20 } = {}, personId) {
    if (!query || typeof query !== 'string' || !query.trim()) {
        return listFacts({ limit }, personId);
    }
    const q = query.trim().toLowerCase();
    const facts = loadFacts(personId);
    const matches = facts.filter(f =>
        (f.content || '').toLowerCase().includes(q)
        || (Array.isArray(f.tags) && f.tags.some(t => String(t).toLowerCase().includes(q)))
    );
    return matches.reverse().slice(0, Math.min(limit, MAX_FACTS));
}

function deleteFact(id, personId) {
    const facts = loadFacts(personId);
    const idx = facts.findIndex(f => f.id === id);
    if (idx === -1) return { ok: false, error: 'Fact not found' };
    const removed = facts.splice(idx, 1)[0];
    saveFacts(facts, personId);
    return { ok: true, removed };
}

function clearFacts(personId) {
    return saveFacts([], personId);
}

function getFactsPath(personId) {
    return factsPath(personId);
}

module.exports = {
    addFact,
    listFacts,
    searchFacts,
    deleteFact,
    clearFacts,
    getFactsPath,
};
