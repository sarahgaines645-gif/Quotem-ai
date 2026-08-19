/**
 * writer-docx.js — the writer's page, as a real Word document.
 *
 * doc-creator's createDocx() takes a STRING and reads markdown out of it.
 * That is right for everything Q generates; it is wrong for the writer's
 * paper, where the student's page already holds question headings, bold and
 * italic, bullet and numbered lists, tables, ruled diagrams and mind maps.
 * Flattened to text they all come out of Word as one wall of prose — and a
 * student hands in Word.
 *
 * So this plugin takes the page as BLOCKS (built by docBlocksForExport() in
 * writer.html — the same DOM, furniture stripped) and builds the .docx from
 * real Word objects. createDocx is untouched: this is a new plugin beside it
 * (plugin law — never modify a working plugin), and it stashes through
 * doc-creator's own stashFile() so /download/:token serves it unchanged.
 *
 * Block shapes (all produced client-side, nothing invented here):
 *   { kind:'heading', level:2, text }
 *   { kind:'para',    runs:[{text, bold?, italic?, underline?}] }
 *   { kind:'list',    ordered, items:[ runs[] ] }
 *   { kind:'table',   header:[string], rows:[[string]] }
 *   { kind:'diagram', rows:[[ {box,tone?} | {arrow} | {fan:[{box,tone?}]} ]] }
 *   { kind:'figure',  svg:'<svg …>' }
 *
 * The document's typeface is a SERIF (Georgia) — a submitted assignment is a
 * document, not a screen. The UI font never goes near it (CLAUDE.md).
 */
'use strict';

const {
    Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle, LevelFormat,
} = require('docx');
const { stashFile } = require('./doc-creator');

// ── limits: one enormous page can never hang or blow up the export ──
const MAX_BLOCKS = 2000;
const MAX_SVG_BYTES = 1024 * 1024;      // 1 MB
const DOC_FONT = 'Georgia';             // a printed record's face, not the UI's
const NUMBERING_REF = 'writer-numbering';

// Word's page is A4 with ~1in margins → about 6.2in of text width.
const FIGURE_MAX_W = 595;               // px @96dpi ≈ 6.2in
const FIGURE_MAX_H = 740;               // px @96dpi ≈ 7.7in — never overruns a page

// The tone a diagram box carries on the page, as its border colour here.
const TONE_COLOUR = { ok: '28A745', warn: 'E6A817', bad: 'E0245E', info: '3B82C4', tip: '7C5CBF' };
const BOX_COLOUR = '595959';

// XML will not carry the C0 controls; strip them rather than fail the doc.
function clean(s) {
    return String(s == null ? '' : s)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/\u00a0/g, ' ');
}

function runsToTextRuns(runs, extra) {
    const list = Array.isArray(runs) ? runs : [];
    const out = [];
    for (const r of list) {
        const text = clean(r && r.text);
        if (!text) continue;
        out.push(new TextRun(Object.assign({
            text,
            bold: !!(r && r.bold),
            italics: !!(r && r.italic),
            underline: (r && r.underline) ? {} : undefined,
        }, extra || {})));
    }
    return out;
}

function borderedRun(text, colour) {
    // A box on the page → a run with a thin rule round it and a space of air
    // inside, so a diagram still reads as a diagram in Word.
    return new TextRun({
        text: ' ' + clean(text) + ' ',
        border: { style: BorderStyle.SINGLE, size: 4, color: colour, space: 2 },
    });
}

function cellParagraph(text, bold) {
    return new Paragraph({
        spacing: { before: 20, after: 20 },
        children: [new TextRun({ text: clean(text), bold: !!bold })],
    });
}

function tableFrom(block) {
    const thin = { style: BorderStyle.SINGLE, size: 4, color: '9A9A9A' };
    const header = Array.isArray(block.header) ? block.header : [];
    const bodyRows = Array.isArray(block.rows) ? block.rows : [];
    const width = Math.max(header.length, ...bodyRows.map(r => (Array.isArray(r) ? r.length : 0)), 1);
    const mkRow = (cells, bold) => new TableRow({
        tableHeader: !!bold,
        children: Array.from({ length: width }, (_, i) => new TableCell({
            children: [cellParagraph((cells || [])[i] || '', bold)],
            margins: { top: 40, bottom: 40, left: 90, right: 90 },
        })),
    });
    const rows = [];
    if (header.length) rows.push(mkRow(header, true));
    for (const r of bodyRows) rows.push(mkRow(r, false));
    if (!rows.length) return null;
    return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin },
        rows,
    });
}

function diagramParagraphs(block) {
    const out = [];
    const rows = Array.isArray(block.rows) ? block.rows : [];
    for (const row of rows) {
        const kids = [];
        const gap = () => { if (kids.length) kids.push(new TextRun({ text: '  ' })); };
        for (const cell of (Array.isArray(row) ? row : [])) {
            if (!cell || typeof cell !== 'object') continue;
            if (cell.arrow) { gap(); kids.push(new TextRun({ text: clean(cell.arrow) })); continue; }
            if (Array.isArray(cell.fan)) {
                // The fan branches: boxes on the same line, ruled and parted,
                // so it reads as several boxes off one arrow — not a sentence.
                cell.fan.forEach((b, i) => {
                    if (i) kids.push(new TextRun({ text: ' | ' })); else gap();
                    if (b && b.box) kids.push(borderedRun(b.box, TONE_COLOUR[b.tone] || BOX_COLOUR));
                });
                continue;
            }
            if (cell.box) { gap(); kids.push(borderedRun(cell.box, TONE_COLOUR[cell.tone] || BOX_COLOUR)); }
        }
        if (kids.length) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 100 }, children: kids }));
    }
    return out;
}

function figureFallback() {
    return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 160, after: 160 },
        children: [new TextRun({ text: '[figure could not be embedded]', italics: true })],
    });
}

// Read the explicit width/height the client wrote onto the svg (it takes them
// off the viewBox), so the picture is fitted, not guessed.
function svgSize(svg) {
    const w = Number((/\bwidth="(\d+(?:\.\d+)?)"/.exec(svg) || [])[1]);
    const h = Number((/\bheight="(\d+(?:\.\d+)?)"/.exec(svg) || [])[1]);
    if (w > 0 && h > 0) return { w, h };
    const vb = (/viewBox="([^"]+)"/.exec(svg) || [])[1];
    if (vb) {
        const p = vb.trim().split(/[\s,]+/).map(Number);
        if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
    }
    return { w: 900, h: 560 };
}

async function figureParagraph(block) {
    const svg = typeof block.svg === 'string' ? block.svg : '';
    if (!svg || Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) return figureFallback();
    try {
        const sharp = require('sharp');
        const { w, h } = svgSize(svg);
        // Render at roughly 1400px across so the lines and the labels are
        // crisp on paper, then fit the page.
        const density = Math.max(72, Math.min(600, Math.round(72 * 1400 / w)));
        const png = await sharp(Buffer.from(svg, 'utf8'), { density }).png().toBuffer();
        // Fit the text width, but never blow a small figure up — a three-box fan
        // drawn at 420px stays 420px on paper, not a page-wide poster.
        let width = Math.min(FIGURE_MAX_W, Math.round(w)), height = Math.round(Math.min(FIGURE_MAX_W, Math.round(w)) * h / w);
        if (height > FIGURE_MAX_H) { width = Math.round(width * (FIGURE_MAX_H / height)); height = FIGURE_MAX_H; }
        return new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 200 },
            children: [new ImageRun({ type: 'png', data: png, transformation: { width, height } })],
        });
    } catch (e) {
        // A picture that will not rasterise never fails the whole document —
        // the rest of her assignment still downloads.
        return figureFallback();
    }
}

/**
 * Build the .docx from the writer's page blocks and stash it for this user.
 * Returns { token, filename, sizeBytes } — same shape as createDocx.
 */
async function createWriterDocx({ title, blocks }, personEmail) {
    if (!title || typeof title !== 'string') throw new Error('title (string) is required');
    if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks (non-empty array) is required');
    if (!personEmail) throw new Error('personEmail required — generated docs must belong to a user');

    const used = blocks.slice(0, MAX_BLOCKS);
    const truncated = blocks.length > MAX_BLOCKS;

    const children = [new Paragraph({ text: clean(title), heading: HeadingLevel.HEADING_1, spacing: { after: 240 } })];

    for (const b of used) {
        if (!b || typeof b !== 'object') continue;
        try {
            if (b.kind === 'heading') {
                const text = clean(b.text).trim();
                if (text) children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 320, after: 120 } }));
                continue;
            }
            if (b.kind === 'para') {
                const kids = runsToTextRuns(b.runs);
                children.push(new Paragraph({ children: kids, spacing: { after: 160 } }));
                continue;
            }
            if (b.kind === 'list') {
                const items = Array.isArray(b.items) ? b.items : [];
                for (const runs of items) {
                    const kids = runsToTextRuns(runs);
                    if (!kids.length) continue;
                    children.push(new Paragraph(Object.assign({
                        children: kids,
                        spacing: { after: 60 },
                    }, b.ordered
                        ? { numbering: { reference: NUMBERING_REF, level: 0 } }
                        : { bullet: { level: 0 } })));
                }
                continue;
            }
            if (b.kind === 'table') {
                const t = tableFrom(b);
                if (t) {
                    children.push(t);
                    children.push(new Paragraph({ text: '', spacing: { after: 160 } }));
                }
                continue;
            }
            if (b.kind === 'diagram') {
                diagramParagraphs(b).forEach(p => children.push(p));
                continue;
            }
            if (b.kind === 'figure') {
                children.push(await figureParagraph(b));
                continue;
            }
        } catch (e) {
            // One malformed block never costs her the download.
            children.push(new Paragraph({ children: [new TextRun({ text: '[this part of the page could not be formatted]', italics: true })], spacing: { after: 160 } }));
        }
    }

    if (truncated) {
        children.push(new Paragraph({
            spacing: { before: 200 },
            children: [new TextRun({ text: '[the page is longer than this export can format — use Download as text for every word]', italics: true })],
        }));
    }

    const doc = new Document({
        creator: 'Q (quotem-ai.co.uk)',
        title: clean(title),
        styles: {
            default: {
                document: { run: { font: DOC_FONT, size: 24 }, paragraph: { spacing: { line: 320 } } },
                heading1: { run: { font: DOC_FONT, size: 36, bold: true, color: '111111' }, paragraph: { spacing: { after: 240 } } },
                heading2: { run: { font: DOC_FONT, size: 28, bold: true, color: '111111' }, paragraph: { spacing: { before: 320, after: 120 } } },
            },
        },
        numbering: {
            config: [{
                reference: NUMBERING_REF,
                levels: [
                    { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
                    { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
                ],
            }],
        },
        sections: [{ properties: {}, children }],
    });

    const buffer = await Packer.toBuffer(doc);
    return stashFile(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), 'docx', title, personEmail);
}

module.exports = { createWriterDocx };
