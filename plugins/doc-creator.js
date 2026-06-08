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
const { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, AlignmentType } = require('docx');
const { userDataPath, userDir, USER_BASE_DIR } = require('./user-data');

const FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Image embedding helpers ──────────────────────────────────────
// docx@9 requires an explicit image `type`. Sniff it from the buffer's
// magic bytes rather than trusting a caller-supplied mime — the buffer
// is the source of truth (a Street View JPEG, a Brave thumbnail, etc).
function imageTypeFromBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
    return null; // unsupported (svg/webp/etc) — caller writes a text fallback
}

// Cheap intrinsic-size read for the two formats we actually get (PNG,
// JPEG). No new dependency. Returns {w,h} or null — null falls back to
// a sensible default so a doc never fails to build over a sizing miss.
function imageDimensions(buf, type) {
    try {
        if (type === 'png' && buf.length >= 24) {
            return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        }
        if (type === 'jpg') {
            let off = 2;
            while (off + 9 < buf.length) {
                if (buf[off] !== 0xff) { off++; continue; }
                const marker = buf[off + 1];
                // SOF0..SOF15 (excluding DHT/DAC/RST) carry frame dimensions
                if (marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
                }
                off += 2 + buf.readUInt16BE(off + 2);
            }
        }
    } catch { /* fall through to default */ }
    return null;
}

// Fit an image to a max width (and a max height so a tall capture can't
// run off the page), preserving aspect ratio. Pixels → docx points.
function fitImage(buf, type) {
    const MAX_W = 460, MAX_H = 620, DEFAULT = { width: 460, height: 345 };
    const dim = imageDimensions(buf, type);
    if (!dim || !dim.w || !dim.h) return DEFAULT;
    let { w, h } = dim;
    if (w > MAX_W) { h = Math.round(h * (MAX_W / w)); w = MAX_W; }
    if (h > MAX_H) { w = Math.round(w * (MAX_H / h)); h = MAX_H; }
    return { width: w, height: h };
}

function safeFilenameStem(s) {
    return String(s || 'document')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'document';
}

function generatedDirFor(personEmail) {
    // userDataPath() only creates the *parent* of the returned path. When the
    // subpath is a directory (no filename), the dir itself isn't created and
    // the first stashFile/createDocx for a user throws ENOENT. Ensure it here
    // so every stash path (image, vector, music, video, narration, docx) is
    // safe on the first call.
    const dir = userDataPath(personEmail, 'q-generated');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
 *
 * `images` is OPTIONAL and backward-compatible: existing callers pass
 * { title, content } and get exactly the same text-only document as
 * before. When provided, `images` is an array of
 *   { buffer:Buffer, caption?:string }
 * appended after the body — each picture centred, fitted to the page,
 * with its caption (source/provenance) in small italics underneath.
 * One bad image never fails the doc — it degrades to a text line so an
 * evidence pack still builds.
 */
async function createDocx({ title, content, images = [] }, personEmail) {
    if (!title || typeof title !== 'string') throw new Error('title (string) is required');
    if (!content || typeof content !== 'string') throw new Error('content (string) is required');
    if (!personEmail) throw new Error('personEmail required — generated docs must belong to a user');

    pruneOldFiles(personEmail);

    const paragraphs = [];
    paragraphs.push(new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1,
    }));

    // Parse markdown-style content into properly formatted Word paragraphs.
    // Handles: # / ## / ### headings, **bold**, *italic*, bullet lists, ---
    const lines = content.split('\n');
    let inList = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();

        // Horizontal rule → page-break-style spacer
        if (/^---+$/.test(trimmed) || /^===+$/.test(trimmed)) {
            paragraphs.push(new Paragraph({ text: '', spacing: { before: 200, after: 200 }, border: { bottom: { color: 'AAAAAA', style: 'single', size: 6, space: 2 } } }));
            inList = false; continue;
        }

        // Headings
        const h3 = trimmed.match(/^###\s+(.*)/);
        const h2 = trimmed.match(/^##\s+(.*)/);
        const h1 = trimmed.match(/^#\s+(.*)/);
        if (h1) { paragraphs.push(new Paragraph({ text: h1[1], heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 120 } })); inList = false; continue; }
        if (h2) { paragraphs.push(new Paragraph({ text: h2[1], heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 80 } })); inList = false; continue; }
        if (h3) { paragraphs.push(new Paragraph({ text: h3[1], heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 60 } })); inList = false; continue; }

        // Blank line — emit space if not already between sections
        if (!trimmed) { inList = false; continue; }

        // Bullet / numbered list item
        const bullet = trimmed.match(/^[-*•]\s+(.*)/);
        const numbered = trimmed.match(/^\d+\.\s+(.*)/);
        if (bullet || numbered) {
            const text = (bullet || numbered)[1];
            paragraphs.push(new Paragraph({
                children: parseInline(text),
                bullet: bullet ? { level: 0 } : undefined,
                numbering: numbered ? { reference: 'default-numbering', level: 0 } : undefined,
                indent: { left: 360 },
                spacing: { after: 60 },
            }));
            inList = true; continue;
        }

        // Normal paragraph — parse inline formatting
        inList = false;
        paragraphs.push(new Paragraph({ children: parseInline(trimmed), spacing: { after: 160 } }));
    }

    // ── Inline markdown parser (bold / italic / bold+italic) ─────────
    function parseInline(text) {
        const runs = [];
        // Pattern: ***bold+italic***, **bold**, *italic*, plain
        const re = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*)/g;
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }));
            if (m[2]) runs.push(new TextRun({ text: m[2], bold: true, italics: true }));
            else if (m[3]) runs.push(new TextRun({ text: m[3], bold: true }));
            else if (m[4]) runs.push(new TextRun({ text: m[4], italics: true }));
            last = m.index + m[0].length;
        }
        if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }));
        return runs.length ? runs : [new TextRun({ text })];
    }

    // Optional image appendix — evidence pictures with provenance captions.
    const imgs = Array.isArray(images) ? images : [];
    for (const img of imgs) {
        const caption = (img && typeof img.caption === 'string') ? img.caption.trim() : '';
        const buf = img && img.buffer;
        const type = imageTypeFromBuffer(buf);
        if (!buf || !type) {
            // Couldn't embed (missing/unsupported format) — keep the
            // provenance in the doc so the evidence trail isn't lost.
            paragraphs.push(new Paragraph({
                spacing: { before: 200, after: 80 },
                children: [new TextRun({
                    text: `[Image could not be embedded${caption ? ' — ' + caption : ''}]`,
                    italics: true,
                })],
            }));
            continue;
        }
        try {
            const { width, height } = fitImage(buf, type);
            paragraphs.push(new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 240, after: 60 },
                children: [new ImageRun({ type, data: buf, transformation: { width, height } })],
            }));
            if (caption) {
                paragraphs.push(new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 200 },
                    children: [new TextRun({ text: caption, italics: true, size: 18 })],
                }));
            }
        } catch (e) {
            paragraphs.push(new Paragraph({
                spacing: { before: 200, after: 80 },
                children: [new TextRun({
                    text: `[Image could not be embedded${caption ? ' — ' + caption : ''}]`,
                    italics: true,
                })],
            }));
        }
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
