/**
 * writer-demo.js — "Introduction to the Writer": the pre-saved demo project Q
 * walks a new person round (Sarah, 19 Aug 2026: "the introduction to the
 * writer is a pre saved doc and you click on that to do the demo. it didnt
 * demonstrate").
 *
 * ONE job: hand back the notebook a fresh demo project is written from — a
 * short essay on the page, a brief, a reference on the list, and (when the
 * template carries one) a real mark so the Marks panel has something to show
 * without a model call. Nothing here calls a model. The brief and the mark in
 * writer-demo-template.json are generated ONCE, for real, by
 * scripts/build-writer-demo.js — never hand-written.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEMO_NAME = 'Introduction to the Writer';

// The task the demo brief was read from (scripts/build-writer-demo.js feeds
// this to the real brief reader; it is stored with the project so Auto cite /
// Q's context have the brief's words).
const DEMO_TASK = `Introduction to the Writer — a short practice essay

Write about 300 words answering these three questions about how a law is made in the UK:

1. Before the Bill — what happens before a Bill reaches Parliament? Mention Green and White Papers and what consultation is for.
2. Through Parliament — describe the stages a Bill goes through in the House of Commons and the House of Lords (first reading, second reading, committee stage, report stage, third reading) and what happens when the two Houses disagree.
3. Becoming law — explain Royal Assent and commencement: when does an Act actually start to apply?

Marking: a top answer names every stage in the right order, explains what each stage is for in plain words, and gives one real recent Act as an example. A middle answer lists the stages but says little about why they exist. A weak answer misses stages or muddles the order.`;

// The essay on the page — deliberately a middle-grade draft: the stages are
// there, the "why" is thin, the example Act is named but not explained. That
// is what makes the highlights, the notes and the mark worth watching.
const DEMO_PARAGRAPHS = [
    'Before a Bill gets anywhere near Parliament the government usually publishes a Green Paper, which is a set of ideas it wants people to comment on, and then a White Paper, which is a firmer statement of what it plans to do. This consultation stage lets charities, businesses and ordinary people say what they think before anything is written down as a Bill.',
    'Once a Bill is introduced it has a first reading, where its title is read out and there is no debate. The second reading is the main debate on the principle of the Bill. At committee stage it is gone through line by line and amendments are made, then the report stage lets the whole House look at those changes, and the third reading is the final vote. The Bill then goes to the other House and does all of this again. If the Lords change it, it goes back to the Commons, and this can go back and forth, which is called ping-pong, until both Houses agree on the same words.',
    'When both Houses have agreed, the Bill goes to the monarch for Royal Assent and becomes an Act of Parliament. That does not always mean it applies straight away: many Acts have a commencement section, and parts of the Act may start on different dates set by the minister. The Fisheries Act 2020 is a recent example of an Act that went through all of these stages.',
];
const DEMO_REFERENCE = {
    key: 'web:https://www.parliament.uk/about/how/laws/passage-bill/',
    inText: '(UK Parliament, n.d.)',
    reference: 'UK Parliament (n.d.) How does a bill become a law? Available at: https://www.parliament.uk/about/how/laws/passage-bill/ (Accessed: 19 August 2026).',
    title: 'How does a bill become a law?', year: '', url: 'https://www.parliament.uk/about/how/laws/passage-bill/', fromUpload: false, sourceName: null, points: [],
};

function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function demoDocHtml() {
    return DEMO_PARAGRAPHS.map(p => '<div>' + escHtml(p) + '</div><div><br></div>').join('')
        + '<div><b>References</b></div><div class="student-line">' + escHtml(DEMO_REFERENCE.reference) + '</div>';
}
function demoDocText() { return DEMO_PARAGRAPHS.join('\n\n') + '\n\nReferences\n' + DEMO_REFERENCE.reference; }

// The generated half (brief + mark), if it has been built. Missing = the demo
// still works (page, reference, tour) — the Marks panel just has no stored mark.
function loadTemplate() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'writer-demo-template.json'), 'utf8')); } catch (_) { return null; }
}

/** The notebook a new demo project is written from. */
function buildDemoTutor() {
    const tpl = loadTemplate();
    const criteria = (tpl && tpl.brief && Array.isArray(tpl.brief.criteria)) ? tpl.brief.criteria : [];
    return {
        brief: tpl && tpl.brief ? { ...tpl.brief, scenarioChecked: true } : null,
        sourceName: 'Introduction to the Writer.md',
        docTitle: 'Introduction to the Writer',
        docHtml: demoDocHtml(), docText: demoDocText(),
        coverage: Object.fromEntries(criteria.map(c => [c.id, 'none'])),
        currentCriterionId: criteria[0] ? criteria[0].id : null,
        task: DEMO_TASK.slice(0, 4000), whatItWants: tpl && tpl.brief ? tpl.brief.whatItWants : '',
        gradeScheme: 'as the brief says',
        references: [ { ...DEMO_REFERENCE, at: Date.now() } ],
        lastMark: tpl && tpl.lastMark ? tpl.lastMark : null,
        plans: {}, stepState: {}, calls: {}, chatLog: [], qNotes: [], qTabs: [], wbStickies: [], inlineDots: {}, termsFit: {}, reqMet: {}, partMarks: {},
        settings: { tourSeen: false },
        demo: true,
    };
}

module.exports = { DEMO_NAME, DEMO_TASK, DEMO_PARAGRAPHS, DEMO_REFERENCE, demoDocHtml, demoDocText, buildDemoTutor, loadTemplate };
