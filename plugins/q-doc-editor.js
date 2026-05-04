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
function replaceText(docxBytes, target, replacement, paragraphIndex = null) {
    if (!target) throw new Error('replace_text: target string required');
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);

    let totalReplacements = 0;
    let newXml = xml;

    // Walk paragraphs in REVERSE so absolute offsets earlier in the file
    // remain valid after each edit (we splice in changes that may differ
    // in length from what they replaced).
    for (let i = paragraphs.length - 1; i >= 0; i--) {
        if (paragraphIndex !== null && i !== paragraphIndex) continue;
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

// ─────────────────────────────────────────────────────────────
//  EDITING TOOLS — delete / insert / move / merge / format
// ─────────────────────────────────────────────────────────────

/**
 * delete_paragraph — remove a paragraph by index. The remaining paragraphs
 * shift down (paragraph 5 becomes paragraph 4, etc.). Q should call read_doc
 * after to refresh his view of the indices.
 */
function deleteParagraph(docxBytes, index) {
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);
    if (index < 0 || index >= paragraphs.length) {
        throw new Error(`delete_paragraph: index ${index} out of range (0..${paragraphs.length - 1})`);
    }
    const p = paragraphs[index];
    const newXml = xml.slice(0, p.absoluteStart) + xml.slice(p.absoluteEnd);
    return { bytes: saveDocx(zip, newXml) };
}

/**
 * insert_paragraph — add a new paragraph at a given position.
 * `after_index` of -1 inserts at the very top of the document.
 * `style` is optional: 'Normal', 'Heading1', 'Heading2', 'Title', etc.
 */
function insertParagraph(docxBytes, afterIndex, text, style = 'Normal') {
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs, bodyStart } = findParagraphs(xml);

    const newParagraphXml = buildParagraphXml(text, style);
    let insertAt;
    if (afterIndex === -1 || paragraphs.length === 0) {
        insertAt = bodyStart;
    } else {
        if (afterIndex < 0 || afterIndex >= paragraphs.length) {
            throw new Error(`insert_paragraph: after_index ${afterIndex} out of range`);
        }
        insertAt = paragraphs[afterIndex].absoluteEnd;
    }
    const newXml = xml.slice(0, insertAt) + newParagraphXml + xml.slice(insertAt);
    return { bytes: saveDocx(zip, newXml) };
}

/**
 * move_paragraph — relocate a paragraph from one index to another.
 * `to_index` is the position in the *original* numbering. After the move,
 * indices shift; Q should re-read.
 */
function moveParagraph(docxBytes, fromIndex, toIndex) {
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);
    if (fromIndex < 0 || fromIndex >= paragraphs.length) {
        throw new Error(`move_paragraph: from_index ${fromIndex} out of range`);
    }
    if (toIndex < 0 || toIndex >= paragraphs.length) {
        throw new Error(`move_paragraph: to_index ${toIndex} out of range`);
    }
    if (fromIndex === toIndex) return { bytes: docxBytes };

    const moving = paragraphs[fromIndex];
    // Step 1: remove the source paragraph
    let working = xml.slice(0, moving.absoluteStart) + xml.slice(moving.absoluteEnd);

    // Step 2: re-find paragraphs in the trimmed XML (offsets have shifted)
    const { paragraphs: shrunk } = findParagraphs(working);

    // Map the original toIndex onto the shrunk array
    let insertionPoint;
    if (toIndex >= shrunk.length) {
        // Append at the end
        const last = shrunk[shrunk.length - 1];
        insertionPoint = last ? last.absoluteEnd : working.indexOf('</w:body>');
    } else {
        // toIndex in the original meant "before paragraph at toIndex"
        // After removing one earlier, we want to insert before the same
        // logical neighbour
        const adjusted = toIndex > fromIndex ? toIndex - 1 : toIndex;
        const target = shrunk[Math.max(0, adjusted)];
        insertionPoint = target.absoluteStart;
    }
    const newXml = working.slice(0, insertionPoint) + moving.xml + working.slice(insertionPoint);
    return { bytes: saveDocx(zip, newXml) };
}

/**
 * merge_paragraph — take the text from `source_index` and inline it into
 * `target_index`. The source paragraph is removed; its text becomes part of
 * the target paragraph. `position` controls where in the target the source
 * text lands: 'start', 'end' (default), or a literal phrase from the target
 * after which the source slots in.
 *
 * This is THE critical tool for the form-filler fix-up: a stranded value
 * gets inlined into the line that contains its label.
 */
function mergeParagraph(docxBytes, sourceIndex, targetIndex, position = 'end') {
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);
    if (sourceIndex < 0 || sourceIndex >= paragraphs.length) {
        throw new Error(`merge_paragraph: source_index out of range`);
    }
    if (targetIndex < 0 || targetIndex >= paragraphs.length) {
        throw new Error(`merge_paragraph: target_index out of range`);
    }
    if (sourceIndex === targetIndex) return { bytes: docxBytes };

    const source = paragraphs[sourceIndex];
    const target = paragraphs[targetIndex];
    const sourceText = source.text;
    if (!sourceText.trim()) {
        // Nothing to merge — just delete the empty source
        return deleteParagraph(docxBytes, sourceIndex);
    }

    // Build a new run carrying the source text, inheriting target's default
    // run formatting where possible (we skip explicit rPr — Word will fall
    // back to the paragraph's pPr defaults, which is the right behaviour for
    // form-filler clean-up where we want the value to look like its label).
    const inlineRun = buildRunXml(' ' + sourceText);

    let mergedTargetXml;
    if (position === 'start') {
        mergedTargetXml = injectRunAtStart(target.xml, buildRunXml(sourceText + ' '));
    } else if (position === 'end') {
        mergedTargetXml = injectRunAtEnd(target.xml, inlineRun);
    } else {
        // position is a literal phrase from the target paragraph; insert after it
        mergedTargetXml = injectRunAfterPhrase(target.xml, position, inlineRun);
    }

    // Apply edits back-to-front so offsets stay valid
    const earlier = sourceIndex < targetIndex ? source : target;
    const later = sourceIndex < targetIndex ? target : source;
    const earlierEdit = earlier === source ? '' : mergedTargetXml;
    const laterEdit = later === source ? '' : mergedTargetXml;

    let newXml = xml.slice(0, later.absoluteStart) + laterEdit + xml.slice(later.absoluteEnd);
    newXml = newXml.slice(0, earlier.absoluteStart) + earlierEdit + newXml.slice(earlier.absoluteEnd);

    return { bytes: saveDocx(zip, newXml) };
}

/**
 * format_paragraph — apply a style or formatting flag to a paragraph.
 * Supported: 'Heading1' | 'Heading2' | 'Heading3' | 'Title' | 'Normal'
 *            'bold' | 'italic' | 'underline' (toggle on every run in the paragraph)
 *            'left' | 'center' | 'right' | 'justify' (alignment)
 */
function formatParagraph(docxBytes, index, style) {
    const { zip, xml } = loadDocx(docxBytes);
    const { paragraphs } = findParagraphs(xml);
    if (index < 0 || index >= paragraphs.length) {
        throw new Error(`format_paragraph: index out of range`);
    }
    const p = paragraphs[index];

    let updated = p.xml;
    const styleNames = ['Heading1', 'Heading2', 'Heading3', 'Title', 'Normal'];
    const alignments = { left: 'left', center: 'center', right: 'right', justify: 'both' };
    const runFlags = ['bold', 'italic', 'underline'];

    if (styleNames.includes(style)) {
        updated = setParagraphStyle(updated, style);
    } else if (alignments[style]) {
        updated = setParagraphAlignment(updated, alignments[style]);
    } else if (runFlags.includes(style)) {
        updated = applyRunFormatting(updated, style);
    } else {
        throw new Error(`format_paragraph: unknown style "${style}"`);
    }

    const newXml = xml.slice(0, p.absoluteStart) + updated + xml.slice(p.absoluteEnd);
    return { bytes: saveDocx(zip, newXml) };
}

// ─────────────────────────────────────────────────────────────
//  XML BUILDERS — small helpers for the editing tools
// ─────────────────────────────────────────────────────────────

function buildParagraphXml(text, style = 'Normal') {
    const styleXml = style && style !== 'Normal'
        ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
        : '';
    return `<w:p>${styleXml}${buildRunXml(text)}</w:p>`;
}

function buildRunXml(text) {
    return `<w:r><w:t xml:space="preserve">${encodeXmlEntities(text)}</w:t></w:r>`;
}

function injectRunAtEnd(paragraphXml, runXml) {
    return paragraphXml.replace(/<\/w:p>$/, runXml + '</w:p>');
}

function injectRunAtStart(paragraphXml, runXml) {
    // After any <w:pPr>...</w:pPr> if present, otherwise after the opening <w:p ...>
    const pPrMatch = paragraphXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    if (pPrMatch) {
        const insertAt = pPrMatch.index + pPrMatch[0].length;
        return paragraphXml.slice(0, insertAt) + runXml + paragraphXml.slice(insertAt);
    }
    const openMatch = paragraphXml.match(/<w:p\b[^>]*>/);
    const insertAt = openMatch.index + openMatch[0].length;
    return paragraphXml.slice(0, insertAt) + runXml + paragraphXml.slice(insertAt);
}

function injectRunAfterPhrase(paragraphXml, phrase, runXml) {
    // Find the <w:t> element whose decoded content contains the phrase, then
    // split it: the first half stays as-is, the run goes after, the second half
    // becomes a new <w:t>. Phrase-boundary insertion only — no fancy re-runs.
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(paragraphXml)) !== null) {
        const decoded = decodeXmlEntities(m[1]);
        const idx = decoded.indexOf(phrase);
        if (idx === -1) continue;
        const before = decoded.slice(0, idx + phrase.length);
        const after = decoded.slice(idx + phrase.length);
        const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
        const newOpen = openTag.includes('xml:space=')
            ? openTag
            : openTag.replace(/<w:t/, '<w:t xml:space="preserve"');
        const replaced = newOpen + encodeXmlEntities(before) + '</w:t>'
            + '</w:r>'  // close the original run before our injected one
            + runXml
            + (after ? `<w:r>${newOpen}${encodeXmlEntities(after)}</w:t></w:r>` : '');
        // The original <w:t> sits inside a <w:r>; we need to re-open a run for the tail
        // Simpler robust approach: keep the surrounding <w:r> intact and put the run AFTER
        // the entire run that contained the phrase.
        const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
        runRe.lastIndex = 0;
        let rm;
        while ((rm = runRe.exec(paragraphXml)) !== null) {
            if (rm.index <= m.index && rm.index + rm[0].length >= m.index + m[0].length) {
                // Found the run containing the phrase. Inject after this run.
                const insertAt = rm.index + rm[0].length;
                return paragraphXml.slice(0, insertAt) + runXml + paragraphXml.slice(insertAt);
            }
        }
    }
    // Phrase not found — fall back to end-of-paragraph
    return injectRunAtEnd(paragraphXml, runXml);
}

function setParagraphStyle(paragraphXml, styleName) {
    const pPrMatch = paragraphXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const styleXml = `<w:pStyle w:val="${styleName}"/>`;
    if (pPrMatch) {
        const newPPr = pPrMatch[0].includes('<w:pStyle')
            ? pPrMatch[0].replace(/<w:pStyle\s+w:val="[^"]*"\/>/, styleXml)
            : pPrMatch[0].replace('<w:pPr>', `<w:pPr>${styleXml}`);
        return paragraphXml.replace(pPrMatch[0], newPPr);
    }
    // No pPr exists — add one right after the <w:p ...> open tag
    const openMatch = paragraphXml.match(/<w:p\b[^>]*>/);
    const insertAt = openMatch.index + openMatch[0].length;
    return paragraphXml.slice(0, insertAt) + `<w:pPr>${styleXml}</w:pPr>` + paragraphXml.slice(insertAt);
}

function setParagraphAlignment(paragraphXml, alignVal) {
    const pPrMatch = paragraphXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const jcXml = `<w:jc w:val="${alignVal}"/>`;
    if (pPrMatch) {
        const newPPr = pPrMatch[0].includes('<w:jc')
            ? pPrMatch[0].replace(/<w:jc\s+w:val="[^"]*"\/>/, jcXml)
            : pPrMatch[0].replace('</w:pPr>', `${jcXml}</w:pPr>`);
        return paragraphXml.replace(pPrMatch[0], newPPr);
    }
    const openMatch = paragraphXml.match(/<w:p\b[^>]*>/);
    const insertAt = openMatch.index + openMatch[0].length;
    return paragraphXml.slice(0, insertAt) + `<w:pPr>${jcXml}</w:pPr>` + paragraphXml.slice(insertAt);
}

function applyRunFormatting(paragraphXml, flag) {
    const tag = { bold: 'b', italic: 'i', underline: 'u' }[flag];
    const flagXml = flag === 'underline' ? `<w:u w:val="single"/>` : `<w:${tag}/>`;
    // For each <w:r>, ensure its <w:rPr> has the flag.
    return paragraphXml.replace(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g, (run) => {
        const rPrMatch = run.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
        if (rPrMatch) {
            if (rPrMatch[0].includes(`<w:${tag}`)) return run;
            return run.replace(rPrMatch[0], rPrMatch[0].replace('<w:rPr>', `<w:rPr>${flagXml}`));
        }
        // Insert a fresh <w:rPr> right after the <w:r ...> open tag
        return run.replace(/<w:r\b[^>]*>/, (open) => `${open}<w:rPr>${flagXml}</w:rPr>`);
    });
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

// ─────────────────────────────────────────────────────────────
//  SESSION STORAGE — per-user current doc
// ─────────────────────────────────────────────────────────────
//  Q's tools and the upload/save routes both need access to the doc the
//  user is currently editing. We keep one current doc per personId in
//  memory. Simple and fast; if it grows we move to the SQLite db.

const sessions = new Map();
// personId → { bytes, filename, fieldValues, updatedAt }

function setSession(personId, data) {
    sessions.set(personId, { ...(sessions.get(personId) || {}), ...data, updatedAt: Date.now() });
}

function getSession(personId) {
    return sessions.get(personId) || null;
}

function clearSession(personId) {
    sessions.delete(personId);
}

module.exports = {
    loadDocx,
    saveDocx,
    findParagraphs,
    readDoc,
    replaceText,
    deleteParagraph,
    insertParagraph,
    moveParagraph,
    mergeParagraph,
    formatParagraph,
    // Session helpers — used by routes and Q's tool dispatcher
    setSession,
    getSession,
    clearSession,
};
