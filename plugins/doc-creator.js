/**
 * doc-creator.js — generates .docx files for Q's create_document tool.
 *
 * Q calls create_document with title + sections (or plain content). We write
 * a .docx into the data/generated/ folder under a random token name, and
 * return the download URL. The /download/:token route serves the file back.
 *
 * The content shape Q sends:
 *   {
 *     title: 'Cover letter for the council',
 *     content: 'Full plain text of the document, paragraphs separated by blank lines'
 *   }
 *
 * Plain text is enough for v1 — Q writes the body in his reply, and we just
 * shape it into a Word doc with a heading + paragraphs. Tables / styles can
 * come later when there's a real ask for them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const GENERATED_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-generated')
    : path.join(__dirname, '..', 'data', 'generated');

try {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
} catch (e) {
    console.error('[doc-creator] could not create generated dir:', e.message);
}

const FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function safeFilenameStem(s) {
    return String(s || 'document')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'document';
}

function pruneOldFiles() {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(GENERATED_DIR)) {
            const full = path.join(GENERATED_DIR, f);
            try {
                const st = fs.statSync(full);
                if (now - st.mtimeMs > FILE_TTL_MS) fs.unlinkSync(full);
            } catch { /* ignore single-file errors */ }
        }
    } catch (e) {
        // Directory missing or unreadable — non-fatal.
    }
}

/**
 * Produce a .docx and return { token, filename, downloadUrl }.
 * The caller embeds downloadUrl into Q's reply as a markdown link.
 */
async function createDocx({ title, content }) {
    if (!title || typeof title !== 'string') throw new Error('title (string) is required');
    if (!content || typeof content !== 'string') throw new Error('content (string) is required');

    pruneOldFiles();

    const paragraphs = [];
    paragraphs.push(new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1,
    }));

    // Split on blank lines → each block is a paragraph. Single newlines stay
    // as soft breaks within the same paragraph (Word renders this naturally).
    const blocks = content.split(/\n\s*\n/);
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        const lines = trimmed.split('\n');
        const runs = [];
        lines.forEach((line, idx) => {
            if (idx > 0) runs.push(new TextRun({ break: 1 }));
            runs.push(new TextRun(line));
        });
        paragraphs.push(new Paragraph({ children: runs, spacing: { after: 200 } }));
    }

    const doc = new Document({
        creator: 'Q (quotem-ai.co.uk)',
        title,
        sections: [{ properties: {}, children: paragraphs }],
    });

    const buffer = await Packer.toBuffer(doc);
    const token = crypto.randomBytes(8).toString('hex');
    const filename = safeFilenameStem(title) + '.docx';
    const onDiskName = token + '__' + filename;
    fs.writeFileSync(path.join(GENERATED_DIR, onDiskName), buffer);
    return {
        token,
        filename,
        sizeBytes: buffer.length,
    };
}

/**
 * Look up a token and return { fullPath, filename } if it exists, else null.
 * Token is 16 hex chars; we glob the generated dir for a file starting with it.
 */
function resolveToken(token) {
    if (!token || !/^[a-f0-9]{16}$/.test(token)) return null;
    try {
        const files = fs.readdirSync(GENERATED_DIR);
        const match = files.find(f => f.startsWith(token + '__'));
        if (!match) return null;
        const fullPath = path.join(GENERATED_DIR, match);
        const filename = match.slice(token.length + 2); // strip "<token>__"
        return { fullPath, filename };
    } catch (e) {
        return null;
    }
}

module.exports = { createDocx, resolveToken, GENERATED_DIR };
