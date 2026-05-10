/**
 * doc-creator.js — generates .docx files (and stashes any other binary
 * Q produces — images, audio, video) for the create_document and other
 * tools.
 *
 * Each user's generated files live in their own directory on the volume
 * (userDataPath(email, 'q-generated/<token>__<filename>')) so a download
 * URL only resolves for the user who created the file. The /download/:token
 * route checks ownership via the same per-user lookup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const { userDataPath, userDir, USER_BASE_DIR } = require('./user-data');

const FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function safeFilenameStem(s) {
    return String(s || 'document')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'document';
}

function generatedDirFor(personEmail) {
    return userDataPath(personEmail, 'q-generated');
}

function pruneOldFiles(personEmail) {
    if (!personEmail) return;
    try {
        const dir = generatedDirFor(personEmail);
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
            const full = path.join(dir, f);
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
 * Produce a .docx and return { token, filename } scoped to one user.
 */
async function createDocx({ title, content }, personEmail) {
    if (!title || typeof title !== 'string') throw new Error('title (string) is required');
    if (!content || typeof content !== 'string') throw new Error('content (string) is required');
    if (!personEmail) throw new Error('personEmail required — generated docs must belong to a user');

    pruneOldFiles(personEmail);

    const paragraphs = [];
    paragraphs.push(new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1,
    }));

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
    const dir = generatedDirFor(personEmail);
    fs.writeFileSync(path.join(dir, onDiskName), buffer);
    return {
        token,
        filename,
        sizeBytes: buffer.length,
    };
}

/**
 * Resolve a token only inside the calling user's directory. If they don't
 * own the file (or it doesn't exist), returns null — same shape regardless,
 * so it's safe to wire into a /download/:token route.
 */
function resolveToken(token, personEmail) {
    if (!token || !/^[a-f0-9]{16}$/.test(token)) return null;
    if (!personEmail) return null;
    try {
        const dir = generatedDirFor(personEmail);
        const files = fs.readdirSync(dir);
        const match = files.find(f => f.startsWith(token + '__'));
        if (!match) return null;
        const fullPath = path.join(dir, match);
        const filename = match.slice(token.length + 2);
        return { fullPath, filename };
    } catch (e) {
        return null;
    }
}

/**
 * Stash an arbitrary file buffer (image, audio, video) under a token in
 * the calling user's generated dir. Returns { token, filename, sizeBytes }.
 */
function stashFile(buffer, extension, label, personEmail) {
    if (!Buffer.isBuffer(buffer)) throw new Error('stashFile: buffer required');
    if (!extension) throw new Error('stashFile: extension required');
    if (!personEmail) throw new Error('stashFile: personEmail required');
    pruneOldFiles(personEmail);
    const token = crypto.randomBytes(8).toString('hex');
    const filename = safeFilenameStem(label || 'file') + '.' + extension.replace(/^\./, '');
    const onDiskName = token + '__' + filename;
    const dir = generatedDirFor(personEmail);
    fs.writeFileSync(path.join(dir, onDiskName), buffer);
    return { token, filename, sizeBytes: buffer.length };
}

/**
 * Search every user's generated dir for a file matching `token`. Used ONLY
 * by /public-download/:token (the external-services route that has no auth
 * — the 64-bit random token is the auth itself, practically unguessable).
 * Returns the same shape as resolveToken or null.
 */
function resolveTokenAcrossUsers(token) {
    if (!token || !/^[a-f0-9]{16}$/.test(token)) return null;
    try {
        if (!fs.existsSync(USER_BASE_DIR)) return null;
        for (const userSlug of fs.readdirSync(USER_BASE_DIR)) {
            const dir = path.join(USER_BASE_DIR, userSlug, 'q-generated');
            if (!fs.existsSync(dir)) continue;
            try {
                const files = fs.readdirSync(dir);
                const match = files.find(f => f.startsWith(token + '__'));
                if (match) {
                    return {
                        fullPath: path.join(dir, match),
                        filename: match.slice(token.length + 2),
                    };
                }
            } catch { /* skip unreadable user dir */ }
        }
    } catch { /* ignore */ }
    return null;
}

module.exports = { createDocx, resolveToken, resolveTokenAcrossUsers, stashFile, generatedDirFor };
