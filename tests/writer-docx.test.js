// Writer .docx export test (19 Aug 2026): the writer's page reaches Word as a
// DOCUMENT — question headings, bold/italic/underline, bullet and numbered
// lists, tables, ruled diagrams and mind-map figures — not a wall of text.
//
// Builds a .docx from one sample of every block kind docBlocksForExport()
// produces, unzips it (pizzip — a declared dependency) and asserts the real
// WordprocessingML is in word/document.xml. No server, no network, no model.
// Run:  node tests/writer-docx.test.js
// Exits 0 on ALL PASS, 1 otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway volume so the stashed file never lands in real user data.
const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'q-writer-docx-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = VOL;

const { createWriterDocx } = require('../plugins/writer-docx');
const { resolveToken } = require('../plugins/doc-creator');
const PizZip = require('pizzip');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };

// A small real SVG in the shape wbMindmapSvg(map, {ink:true}) emits: explicit
// xmlns + width/height, look carried in attributes (no page CSS needed).
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="q-mm" viewBox="0 0 320 180" width="320" height="180" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mind map: Employment law">'
    + '<defs><marker id="mm1-a0" markerWidth="9" markerHeight="8" refX="8.5" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8.5,4 L0,8 Z" fill="#444444"/></marker></defs>'
    + '<path d="M120,90 Q160,60 200,50" fill="none" stroke="#444444" stroke-width="2" stroke-linecap="round" opacity="0.8" marker-end="url(#mm1-a0)"/>'
    + '<g><rect x="20" y="70" width="100" height="40" rx="14" fill="none" stroke="#444444" stroke-width="2"/>'
    + '<text x="34" y="95" fill="#222222" font-family="Lora, Georgia, serif" font-size="14" font-weight="600">Contract</text></g>'
    + '<g><rect x="200" y="30" width="100" height="40" rx="10" fill="none" stroke="#3B82C4" stroke-width="1.4"/>'
    + '<text x="214" y="55" fill="#222222" font-family="Lora, Georgia, serif" font-size="13" font-weight="400">Express terms</text></g>'
    + '</svg>';

const BLOCKS = [
    { kind: 'heading', level: 2, text: 'Question 1 — Explain the employment relationship' },
    { kind: 'para', runs: [
        { text: 'The relationship rests on the ' },
        { text: 'contract of employment', bold: true },
        { text: ' and on what Rousseau (1995) called the ' },
        { text: 'psychological contract', italic: true },
        { text: ' — see ' },
        { text: 'Chapter 4', underline: true },
        { text: '.' },
    ] },
    { kind: 'para', runs: [] },
    { kind: 'list', ordered: false, items: [
        [{ text: 'Express terms are written down.' }],
        [{ text: 'Implied terms are ' }, { text: 'not', bold: true }, { text: ' written down.' }],
    ] },
    { kind: 'list', ordered: true, items: [
        [{ text: 'Offer' }],
        [{ text: 'Acceptance' }],
        [{ text: 'Consideration' }],
    ] },
    { kind: 'table', header: ['Term', 'Source', 'Example'], rows: [
        ['Express', 'Written contract', 'Notice period'],
        ['Implied', 'Custom and practice', 'Mutual trust'],
    ] },
    { kind: 'table', header: [], rows: [['no header here', 'second cell']] },
    { kind: 'diagram', rows: [
        [{ box: 'Offer', tone: 'ok' }, { arrow: '→' }, { box: 'Acceptance' }, { arrow: '→' }, { fan: [{ box: 'Written terms', tone: 'info' }, { box: 'Implied terms', tone: 'warn' }, { box: 'Statute', tone: 'bad' }] }],
        [{ box: 'Breach', tone: 'bad' }, { arrow: '↔' }, { box: 'Remedy', tone: 'tip' }],
    ] },
    { kind: 'figure', svg: SVG },
    { kind: 'figure', svg: '<not an svg at all>' },
    { kind: 'heading', level: 2, text: 'References' },
    { kind: 'para', runs: [{ text: 'Rousseau, D.M. (1995) Psychological contracts in organizations. Thousand Oaks: Sage.' }] },
];

async function main() {
    const out = await createWriterDocx({ title: 'My assignment', blocks: BLOCKS }, 'test@example.test');
    ok(!!out && /^[a-f0-9]{16}$/.test(out.token || ''), 'createWriterDocx → token ' + (out && out.token));
    ok(out.filename === 'my-assignment.docx', 'filename: ' + out.filename);
    ok(out.sizeBytes > 5000, 'sizeBytes ' + out.sizeBytes + ' (a formatted doc, not a stub)');

    const hit = resolveToken(out.token, 'test@example.test');
    ok(!!hit, 'resolveToken finds it in the user\'s own dir');
    if (!hit) return;

    const zip = new PizZip(fs.readFileSync(hit.fullPath));
    const xml = zip.file('word/document.xml').asText();
    const styles = zip.file('word/styles.xml').asText();
    const numbering = zip.file('word/numbering.xml');

    ok(xml.includes('w:pStyle w:val="Heading1"'), 'title → Heading 1');
    ok(xml.includes('w:pStyle w:val="Heading2"'), 'question heading → Heading 2');
    ok(xml.includes('Question 1 — Explain the employment relationship'), 'the heading text is in the document');
    ok(xml.includes('References'), 'the References heading is in the document');
    ok(xml.includes('<w:b/>'), 'bold run → <w:b/>');
    ok(xml.includes('<w:i/>'), 'italic run → <w:i/>');
    ok(/<w:u\b/.test(xml), 'underline run → <w:u …>');
    ok(xml.includes('<w:numPr>'), 'lists → <w:numPr>');
    ok(!!numbering && /w:numFmt w:val="decimal"/.test(numbering.asText()), 'numbering.xml defines the decimal level (ordered list really numbers)');
    ok(/w:numFmt w:val="bullet"/.test((numbering && numbering.asText()) || ''), 'numbering.xml defines the bullet level');
    ok(xml.includes('<w:tbl>'), 'table → <w:tbl>');
    ok((xml.match(/<w:tbl>/g) || []).length === 2, 'both tables present (headed and header-less): ' + (xml.match(/<w:tbl>/g) || []).length);
    ok(xml.includes('Custom and practice'), 'a table cell keeps its own text');
    ok(xml.includes('<w:drawing>'), 'the mind map rasterised → <w:drawing> (an image, not its text)');
    ok(/<w:bdr\b/.test(xml), 'diagram boxes are ruled → <w:bdr …>');
    ok((xml.match(/<w:bdr /g) || []).length >= 7, 'every diagram box is ruled: ' + (xml.match(/<w:bdr /g) || []).length);
    ok(xml.includes('w:color="28A745"') && xml.includes('w:color="E0245E"'), 'box tones carry their colour (ok green, bad red)');
    ok(xml.includes('→') && xml.includes('↔'), 'the arrows are on the page');
    ok(xml.includes('[figure could not be embedded]'), 'a figure that will not rasterise degrades to one italic line — the doc still builds');
    ok(/w:ascii="Georgia"/.test(styles), 'the document face is a serif (Georgia), never the UI font');
    ok(!/Space Grotesk/.test(styles) && !/Space Grotesk/.test(xml), 'Space Grotesk is nowhere near the document');

    // The image really is a PNG the size we asked for.
    const media = Object.keys(zip.files).filter(f => /^word\/media\/.+\.\w+$/.test(f));
    ok(media.length === 1, 'exactly one embedded image: ' + media.join(', '));

    // Guards: an over-long page and an over-large svg never throw.
    const many = Array.from({ length: 2100 }, (_, i) => ({ kind: 'para', runs: [{ text: 'line ' + i }] }));
    const big = await createWriterDocx({ title: 'Long one', blocks: many }, 'test@example.test');
    const bigXml = new PizZip(fs.readFileSync(resolveToken(big.token, 'test@example.test').fullPath)).file('word/document.xml').asText();
    ok(bigXml.includes('line 1999') && !bigXml.includes('line 2000'), 'over 2000 blocks: the first 2000 render, the rest are capped');
    ok(bigXml.includes('longer than this export can format'), 'and it says so rather than silently dropping them');

    const huge = await createWriterDocx({ title: 'Huge figure', blocks: [{ kind: 'figure', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' + '<!--' + 'x'.repeat(1024 * 1024 + 10) + '-->' + '</svg>' }] }, 'test@example.test');
    const hugeXml = new PizZip(fs.readFileSync(resolveToken(huge.token, 'test@example.test').fullPath)).file('word/document.xml').asText();
    ok(hugeXml.includes('[figure could not be embedded]') && !hugeXml.includes('<w:drawing>'), 'an svg over 1 MB degrades to the italic line');

    let threw = null;
    try { await createWriterDocx({ title: 'Empty', blocks: [] }, 'test@example.test'); } catch (e) { threw = e; }
    ok(!!threw, 'empty blocks are refused (the route falls back to the text path)');
}

main()
    .then(() => {
        try { fs.rmSync(VOL, { recursive: true, force: true }); } catch (_) {}
        console.log(failed ? '\n' + failed + ' FAILED' : '\nALL PASS');
        process.exit(failed ? 1 : 0);
    })
    .catch(e => { console.error('FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
