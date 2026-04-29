/**
 * Q RAG — Q's library. Stores knowledge and retrieves relevant chunks
 * before Q answers. Same Together AI account, open-weight embedding model.
 *
 * Three jobs:
 *   - embedText(text)               → vector via BAAI/bge-large-en-v1.5
 *   - addDocument(source, text)     → chunk + embed + store
 *   - retrieve(query, topK)         → embed query, find top-K most similar chunks
 *
 * Storage: single JSON file at q-lab/q-knowledge.json (lab-only, isolated).
 * Embeddings stored as base64-encoded Float32 buffers; similarity is cosine
 * on read. For Q's expected scale (thousands of chunks) this is fine — file
 * sits in memory after first load. Upgrade to a proper vector DB at ~50K+
 * chunks if needed.
 *
 * Why JSON not SQLite: q-lab keeps storage as plain files (memory.js does
 * the same). sqlite3 isn't installed at q-lab/ level; would need to import
 * across folders or add a separate package.json. JSON is simpler, fits the
 * pattern, and matches the scale we need.
 *
 * Embedding model: BAAI/bge-large-en-v1.5 (1024-dim, open weights, MIT).
 * Top of HuggingFace's MTEB English retrieval leaderboard for its size class.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Q_CONFIG } = require('../config');

const STORE_PATH = path.join(__dirname, '..', 'q-knowledge.json');
// Embedding model on Together AI. E5-large-instruct is operational + 1024-dim.
// Tried BAAI/bge-large-en-v1.5 first but Together returns 503 for it (model
// not currently being served on their serverless). E5 is a strong alternative
// — Microsoft Research, top of MTEB for multilingual, open weights.
const EMBEDDING_MODEL = 'intfloat/multilingual-e5-large-instruct';
const EMBEDDING_DIM = 1024;

// ─────────────────────────────────────────────────────────────
//  Storage — single JSON file, in-memory after first load
// ─────────────────────────────────────────────────────────────

let cache = null; // { chunks: [...], loadedAt }

function loadStore() {
    if (cache) return cache;
    if (!fs.existsSync(STORE_PATH)) {
        cache = { chunks: [], loadedAt: Date.now() };
        return cache;
    }
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        cache = {
            chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
            loadedAt: Date.now(),
        };
    } catch (e) {
        console.warn(`[qwen-rag] Could not parse ${STORE_PATH}: ${e.message}. Starting empty.`);
        cache = { chunks: [], loadedAt: Date.now() };
    }
    return cache;
}

function saveStore() {
    if (!cache) return;
    fs.writeFileSync(STORE_PATH, JSON.stringify({ chunks: cache.chunks }, null, 0), 'utf8');
}

function reloadStore() {
    cache = null;
    return loadStore();
}

// ─────────────────────────────────────────────────────────────
//  Embedding — Together AI's BAAI/bge-large-en-v1.5
// ─────────────────────────────────────────────────────────────

async function embedText(text) {
    if (!Q_CONFIG.apiKey) throw new Error('TOGETHER_API_KEY not configured');
    if (!text || typeof text !== 'string') throw new Error('Text required for embedding');

    const response = await fetch(`${Q_CONFIG.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: EMBEDDING_MODEL,
            // E5 caps at 512 tokens (~2000 chars). Hard-truncate to be safe.
            input: text.substring(0, 1800),
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Embedding HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
        throw new Error(`Unexpected embedding shape: ${vec?.length}-dim, expected ${EMBEDDING_DIM}`);
    }
    return vec;
}

function vecToBase64(vec) {
    const buf = Buffer.from(new Float32Array(vec).buffer);
    return buf.toString('base64');
}

function base64ToVec(b64) {
    const buf = Buffer.from(b64, 'base64');
    return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}

function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─────────────────────────────────────────────────────────────
//  Chunking — paragraph-aware with size cap
// ─────────────────────────────────────────────────────────────

function chunkText(text, maxChars = 1200, overlap = 150) {
    if (!text) return [];
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        if ((current + '\n\n' + trimmed).length <= maxChars) {
            current = current ? `${current}\n\n${trimmed}` : trimmed;
        } else {
            if (current) chunks.push(current);
            if (trimmed.length > maxChars) {
                let pos = 0;
                while (pos < trimmed.length) {
                    chunks.push(trimmed.substring(pos, pos + maxChars));
                    pos += maxChars - overlap;
                }
                current = '';
            } else {
                current = trimmed;
            }
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// ─────────────────────────────────────────────────────────────
//  Public API: addDocument / retrieve / stats / wipe
// ─────────────────────────────────────────────────────────────

/**
 * Add a document to Q's library. Replaces existing chunks for the same source.
 * Returns { source, chunks: N, durationMs }.
 */
async function addDocument(sourceName, text) {
    if (!sourceName || !text) throw new Error('sourceName and text required');
    const startTime = Date.now();
    const store = loadStore();

    // Drop previous chunks for this source so re-ingestion is clean
    store.chunks = store.chunks.filter(c => c.source_file !== sourceName);

    const chunks = chunkText(text);
    const now = new Date().toISOString();
    let nextId = (store.chunks.reduce((max, c) => Math.max(max, c.id || 0), 0)) + 1;

    for (let i = 0; i < chunks.length; i++) {
        const vec = await embedText(chunks[i]);
        store.chunks.push({
            id: nextId++,
            source_file: sourceName,
            chunk_index: i,
            chunk_text: chunks[i],
            embedding: vecToBase64(vec),
            created_at: now,
        });
    }

    saveStore();
    return { source: sourceName, chunks: chunks.length, durationMs: Date.now() - startTime };
}

/**
 * Retrieve top-K most similar chunks to the query.
 * Returns array of { source_file, chunk_text, similarity }.
 */
async function retrieve(query, topK = 3) {
    if (!query) return [];
    const store = loadStore();
    if (store.chunks.length === 0) return [];

    const queryVec = await embedText(query);
    const scored = store.chunks.map(c => ({
        source_file: c.source_file,
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        similarity: cosineSimilarity(queryVec, base64ToVec(c.embedding)),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}

/**
 * Stats — how many docs, how many chunks, biggest sources.
 */
function stats() {
    const store = loadStore();
    const bySource = {};
    for (const c of store.chunks) {
        bySource[c.source_file] = (bySource[c.source_file] || 0) + 1;
    }
    const sources = Object.entries(bySource)
        .map(([source_file, chunks]) => ({ source_file, chunks }))
        .sort((a, b) => b.chunks - a.chunks);
    return { total_chunks: store.chunks.length, sources };
}

/**
 * Wipe everything — useful when re-ingesting from scratch.
 */
function wipe() {
    cache = { chunks: [], loadedAt: Date.now() };
    saveStore();
}

module.exports = {
    embedText, addDocument, retrieve, stats, wipe, reloadStore,
    EMBEDDING_MODEL, EMBEDDING_DIM, STORE_PATH,
};
