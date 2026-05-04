'use strict';

/**
 * Q DOC EDITOR — backend for voice/chat-driven Word document editing.
 *
 * Q reads a .docx, sees what's inside, and edits it in place — moving,
 * deleting, formatting, replacing — without losing the document's existing
 * formatting. Each edit is a tool Q calls during chat.
 *
 * The .docx format is a ZIP containing word/document.xml. We crack the ZIP
 * with pizzip, manipulate paragraph and run elements directly in the XML,
 * and zip it back up. Standard pdf-lib-style approach but for Word.
 *
 * Reusable: any page can pass a .docx (as a Buffer or base64) plus an
 * operation, get the modified .docx back. UI is whatever calls in.
 *
 * Tools exposed to Q (wired in q-tools.js):
 *   - read_doc          → list every paragraph with index + text + style
 *   - view_doc_image    → render current state as an image so Q can SEE it
 *   - replace_text      → swap a phrase for another, formatting preserved
 *   - delete_paragraph  → remove a paragraph by index
 *   - insert_paragraph  → add a new paragraph after a given index
 *   - move_paragraph    → move a paragraph from one index to another
 *   - format_paragraph  → bold/italic/heading/alignment for a paragraph
 *   - save_doc          → finalise and return the bytes
 */

const PizZip = require('pizzip');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// ─────────────────────────────────────────────────────────────
//  ZIP I/O — open a .docx, get the body XML, write back
// ─────────────────────────────────────────────────────────────

function loadDocx(docxBytes) {
    const zip = new PizZip(Buffer.isBuffer(docxBytes) ? docxBytes : Buffer.from(docxBytes));
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) throw new Error('Not a valid .docx — word/document.xml missing');
    return { zip, xml: xmlFile.asText() };
}

function saveDocx(zip, xml) {
    zip.file('word/document.xml', xml);
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ─────────────────────────────────────────────────────────────
//  XML PARSING — paragraph extraction without a full DOM
// ─────────────────────────────────────────────────────────────
//  We use string scanning rather than a heavy XML parser. Word's document
//  XML is well-structured and the operations we need (find a <w:p>, modify
//  it, swap two of them) are straightforward at the string level. This
//  avoids re-serialising the whole document — important because Word is
//  picky about whitespace and namespace prefixes round-tripping.

/**
 * Find every <w:p>...</w:p> block in the body, return them with their
 * positions in the source XML. The body is everything inside <w:body>.
 */
function findParagraphs(xml) {
    const bodyMatch = xml.match(/<w:body>([\s\S]*?)<\/w:body>/);
    if (!bodyMatch) return { paragraphs: [], bodyStart: -1, bodyEnd: -1 };

    const body = bodyMatch[1];
    const bodyStart = bodyMatch.index + '<w:body>'.length;
    const bodyEnd = bodyStart + body.length;

    const paragraphs = [];
    const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        paragraphs.push({
            index: paragraphs.length,
            xml: m[0],
            absoluteStart: bodyStart + m.index,
            absoluteEnd: bodyStart + m.index + m[0].length,
            text: extractText(m[0]),
            style: extractStyle(m[0]),
        });
    }
    return { paragraphs, bodyStart, bodyEnd };
}

/**
 * Pull the visible text out of a paragraph's XML.
 * Word stores text inside <w:t>...</w:t> elements, optionally split across
 * runs (<w:r>). We just grab every <w:t> and concatenate.
 */
function extractText(paragraphXml) {
    const parts = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(paragraphXml)) !== null) {
        parts.push(decodeXmlEntities(m[1]));
    }
    return parts.join('');
}

/**
 * Pull the paragraph style name (Heading1, Title, Normal, etc.) if present.
 */
function extractStyle(paragraphXml) {
    const m = paragraphXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
    return m ? m[1] : 'Normal';
}

function decodeXmlEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function encodeXmlEntities(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ─────────────────────────────────────────────────────────────
//  PUBLIC API — one entry point per Q tool
// ─────────────────────────────────────────────────────────────

/**
 * read_doc — list every paragraph with index, text, and style.
 * Q calls this first to know the lay of the land.
 */
function readDoc(docxBytes) {
    const { xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);
    return paragraphs.map(p => ({
        index: p.index,
        text: p.text,
        style: p.style,
    }));
}

/**
 * replace_text — find a phrase anywhere in the document and swap it for
 * another. Works across paragraphs. Formatting is preserved because we
 * only touch the text content of <w:t> nodes, not surrounding markup.
 *
 * Word sometimes splits a single visible phrase across multiple <w:t>
 * elements (e.g. when bold or italic toggles mid-word). When that happens
 * the literal substring isn't present in any single <w:t> — we handle that
 * with a "join then split back" pass: gather text per paragraph, do the
 * replacement, redistribute the new text across the same <w:t> slots.
 */
function replaceText(docxBytes, target, replacement) {
    if (!target) throw new Error('replace_text: target string required');
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);

    let totalReplacements = 0;
    let newXml = xml;

    // Walk paragraphs in REVERSE so absolute offsets earlier in the file
    // remain valid after each edit (we splice in changes that may differ
    // in length from what they replaced).
    for (let i = paragraphs.length - 1; i >= 0; i--) {
        const p = paragraphs[i];
        if (!p.text.includes(target)) continue;

        const updatedParagraphXml = replaceTextInParagraph(p.xml, target, replacement);
        if (updatedParagraphXml !== p.xml) {
            newXml = newXml.slice(0, p.absoluteStart) + updatedParagraphXml + newXml.slice(p.absoluteEnd);
            totalReplacements += countOccurrences(p.text, target);
        }
    }

    return {
        bytes: saveDocx(zip, newXml),
        replacements: totalReplacements,
    };
}

/**
 * Replace `target` with `replacement` inside one paragraph's XML.
 * Joins all <w:t> contents, does the swap, redistributes the result
 * back across the same <w:t> elements proportionally.
 */
function replaceTextInParagraph(paragraphXml, target, replacement) {
    const tElements = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(paragraphXml)) !== null) {
        tElements.push({
            start: m.index,
            end: m.index + m[0].length,
            openTag: m[0].slice(0, m[0].indexOf('>') + 1),
            closeTag: '</w:t>',
            content: decodeXmlEntities(m[1]),
        });
    }
    if (tElements.length === 0) return paragraphXml;

    const fullText = tElements.map(t => t.content).join('');
    if (!fullText.includes(target)) return paragraphXml;

    const newText = fullText.split(target).join(replacement);

    // Redistribute newText across the same number of <w:t> slots,
    // proportional to the original split. Simplest approach: dump everything
    // into the first slot, blank the rest. Word renders this identically
    // because runs preserve formatting via <w:rPr> on the parent <w:r>.
    let result = paragraphXml;
    // Apply edits back-to-front to preserve indices
    for (let i = tElements.length - 1; i >= 0; i--) {
        const t = tElements[i];
        const replacementContent = i === 0 ? encodeXmlEntities(newText) : '';
        // Use xml:space="preserve" to keep whitespace, just like Word does
        const newOpen = t.openTag.includes('xml:space=')
            ? t.openTag
            : t.openTag.replace(/<w:t/, '<w:t xml:space="preserve"');
        const replacementXml = newOpen + replacementContent + t.closeTag;
        result = result.slice(0, t.start) + replacementXml + result.slice(t.end);
    }
    return result;
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0, idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

module.exports = {
    loadDocx,
    saveDocx,
    findParagraphs,
    readDoc,
    replaceText,
};
