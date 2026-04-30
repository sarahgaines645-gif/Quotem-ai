/**
 * Q INGEST — bulk-load files into Q's library.
 *
 * Walks a folder, reads each supported file, calls addDocument() for each.
 *
 * Supported file types:
 *   - .md / .txt          → plain text
 *   - .json               → JSON.stringify (with special handling for known shapes)
 *   - .csv                → row-by-row "col: value" text
 *   - .pdf                → defer (convert to text outside for now)
 *
 * Usage as CLI:
 *   node q-lab/plugins/qwen-ingest.js                  → ingests q-lab/knowledge-source/
 *   node q-lab/plugins/qwen-ingest.js path/to/folder   → ingests a custom folder
 *   node q-lab/plugins/qwen-ingest.js --stats          → just print library stats
 *   node q-lab/plugins/qwen-ingest.js --wipe           → wipe library before re-ingest
 *
 * Usage as module:
 *   const { ingestFolder, ingestFile } = require('./q-ingest');
 *   await ingestFolder('/path/to/docs');
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Load .env BEFORE requiring qwen-rag so its config sees the TOGETHER_API_KEY.
// Idempotent — skip if already set (server startup will have loaded it).
if (!process.env.TOGETHER_API_KEY) {
    const envPath = path.join(__dirname, '..', '..', 'server', '.env');
    if (fs.existsSync(envPath)) {
        // Strip BOM if the file has one (Windows Notepad likes adding them)
        let raw = fs.readFileSync(envPath, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        for (const line of raw.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (m && !process.env[m[1]]) {
                let val = m[2].trim();  // strip trailing whitespace + carriage returns
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                process.env[m[1]] = val;
            }
        }
    }
}

const { addDocument, stats, wipe } = require('./q-rag.js');

const DEFAULT_FOLDER = path.join(__dirname, '..', 'knowledge-source');
const SUPPORTED_EXTS = ['.md', '.txt', '.json', '.csv'];

function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip hidden dirs and node_modules
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            walk(fullPath, files);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_EXTS.includes(ext)) files.push(fullPath);
        }
    }
    return files;
}

function readFileAsText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const raw = fs.readFileSync(filePath, 'utf8');

    if (ext === '.md' || ext === '.txt') {
        return raw;
    }

    if (ext === '.json') {
        try {
            const parsed = JSON.parse(raw);
            // Pretty-printed JSON is more readable for chunking
            return JSON.stringify(parsed, null, 2);
        } catch (e) {
            return raw; // malformed JSON, keep as text
        }
    }

    if (ext === '.csv') {
        // Convert CSV rows to "col1: val1 | col2: val2 | ..." text per row.
        // Better for retrieval than raw CSV (each row becomes searchable prose).
        const lines = raw.split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) return '';
        const headers = parseCSVLine(lines[0]);
        const rows = lines.slice(1).map(line => {
            const cols = parseCSVLine(line);
            return headers.map((h, i) => `${h}: ${cols[i] || ''}`).join(' | ');
        });
        return rows.join('\n');
    }

    return raw;
}

// Minimal CSV line parser — handles quoted fields with commas.
// Good enough for SOR pricing.csv which uses standard quoting.
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

async function ingestFile(filePath, displayPath = null) {
    const sourceName = displayPath || path.basename(filePath);
    try {
        const text = readFileAsText(filePath);
        if (!text || !text.trim()) {
            console.log(`[ingest] SKIP ${sourceName} (empty)`);
            return { source: sourceName, chunks: 0, skipped: true };
        }
        const result = await addDocument(sourceName, text);
        console.log(`[ingest] ✓ ${sourceName} → ${result.chunks} chunks (${result.durationMs}ms)`);
        return result;
    } catch (err) {
        console.error(`[ingest] ✗ ${sourceName}: ${err.message}`);
        return { source: sourceName, error: err.message };
    }
}

async function ingestFolder(folder = DEFAULT_FOLDER) {
    if (!fs.existsSync(folder)) {
        console.log(`[ingest] Folder does not exist: ${folder}`);
        console.log(`[ingest] Create it and drop files in: mkdir "${folder}"`);
        return [];
    }

    const files = walk(folder);
    if (files.length === 0) {
        console.log(`[ingest] No supported files found in ${folder}`);
        console.log(`[ingest] Supported: ${SUPPORTED_EXTS.join(', ')}`);
        return [];
    }

    console.log(`[ingest] Found ${files.length} file(s) in ${folder}\n`);
    const results = [];
    for (const file of files) {
        const relativePath = path.relative(folder, file);
        results.push(await ingestFile(file, relativePath));
    }

    const ok = results.filter(r => !r.error && !r.skipped).length;
    const totalChunks = results.reduce((sum, r) => sum + (r.chunks || 0), 0);
    console.log(`\n[ingest] ✅ Done: ${ok}/${files.length} files, ${totalChunks} total chunks\n`);
    return results;
}

// ─────────────────────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);

        if (args.includes('--stats')) {
            const s = await stats();
            console.log(`\nQ's library: ${s.total_chunks} chunks total\n`);
            console.log('Sources:');
            s.sources.forEach(src => console.log(`  ${src.chunks.toString().padStart(5)} chunks  ${src.source_file}`));
            console.log('');
            process.exit(0);
        }

        if (args.includes('--wipe')) {
            await wipe();
            console.log('[ingest] 🗑  Library wiped\n');
        }

        const folderArg = args.find(a => !a.startsWith('--'));
        const folder = folderArg ? path.resolve(folderArg) : DEFAULT_FOLDER;
        await ingestFolder(folder);
        process.exit(0);
    })();
}

module.exports = { ingestFile, ingestFolder, DEFAULT_FOLDER, SUPPORTED_EXTS };
