/**
 * mark-schemes.js — the awarding body's OWN marking standard, verbatim, for the
 * writer's marker to mark against (18 Aug 2026).
 *
 * Sarah, 18 Aug: "research how a paper should be marked so we can create
 * something that it can mark it against." A cheaper agent pulled the strings
 * below out of the actual documents. Nothing here is paraphrased. What is and
 * is not verified is stated per block — the marker is told the same.
 *
 * ONE job: given a brief (+ the chosen grade scheme, + the task text), say
 * which published scheme applies and hand back the block the marker reads and
 * the arithmetic that turns per-outcome marks into the unit result. No model
 * calls, no invention. Add a scheme = add an entry to SCHEMES.
 */
'use strict';

// ── CIPD Level 7 Advanced Diploma ─────────────────────────────────────────────
// Sources (as found 18 Aug 2026):
//  VERIFIED, cipd.org — Advanced Diploma in Strategic People Management, Level 7
//    specification, June 2024 v1.5: unit 7HR02 criteria (pp. 39–42), assessment
//    and grading (pp. 8–9); CIPD Advanced Qualifications & Diplomas (Level 7);
//    CIPD qualifications regulatory information.
//  CIPD-AUTHORED — the generic grade descriptors grid, the 1–4 marks per
//    learning outcome, the unit-result thresholds, the six marking criteria:
//    first taken from a 7CO01 Learner Assessment Brief v2022.1 (third-party
//    hosted), then VERIFIED word for word against a CIPD-issued Learner
//    Assessment Brief for 7HR03 (Assessment ID CIPD_7HR03_24_01) held
//    locally (18 Aug 2026) — same grid, same table, same rules.
const CIPD_L7_GRID = [
    { row: 'Focus',
      refer: 'Fails to address all the questions either sufficiently fully or directly.',
      pass: 'An adequate attempt to address all the questions fully and directly.',
      merit: 'A good attempt to address all the questions relatively well and directly.',
      distinction: 'An excellent attempt to address all the questions very well and directly.' },
    { row: 'Depth & breadth of understanding',
      refer: 'Inadequate knowledge and understanding in respect of one or more of the questions. Limited depth and breadth of analysis.',
      pass: 'Adequate knowledge and understanding across the questions. Satisfactory breadth and depth of analysis.',
      merit: 'Full and solid knowledge and understanding across all the questions. Good breadth and depth of analysis.',
      distinction: 'Very full knowledge and understanding across all the questions. Excellent breadth and depth of analysis.' },
    { row: 'Strategic application & professional advice',
      refer: 'Fails to provide appropriate or well-justified advice and/or recommendations. Lacks a strategic approach.',
      pass: 'Provides adequately justified advice and informed recommendations Some strategic application.',
      merit: 'Provides solid and thoughtful advice and well-informed recommendations. Clearly strategic in orientation.',
      distinction: 'Provides excellent advice and very well-informed recommendations. Strategically oriented in all respects.' },
    { row: 'Research & wider reading',
      refer: 'Limited original research and/or appropriate wider reading for the assignment. Limited or no referencing.',
      pass: 'Evidence of sufficient research and appropriate wider reading for the assignment. Satisfactory in-text referencing.',
      merit: 'Evidence of significant research and thoughtful, appropriate wider reading for the assignment. A good standard of in-text referencing.',
      distinction: 'Evidence of considerable research and excellent, appropriate wider reading for the assignment. An excellent standard of in-text referencing' },
    { row: 'Persuasiveness & originality',
      refer: 'Limited development of persuasive and original arguments. Inadequate use of examples.',
      pass: 'An adequate attempt to develop original arguments and to justify these persuasively. Includes appropriate examples.',
      merit: 'Some strong original arguments are presented which are mainly justified persuasively. Good use of examples.',
      distinction: 'Mostly strong original arguments are presented and justified very persuasively. Excellent use of examples.' },
    { row: 'Presentation & language',
      refer: 'An inadequate standard of presentation or language. The assignment is poorly written and/or poorly structured. It is not at the level required for a management presentation.',
      pass: 'A solid standard of presentation and use of language. The structure and ideas are satisfactory for a management presentation.',
      merit: 'A strong and professional standard of presentation and use of language. The structure and ideas are well crafted for a management presentation.',
      distinction: 'An outstanding standard of presentation and use of language. The structure and ideas are very well crafted for a management presentation.' },
];

// Unit result from the sum of the 1–4 marks per learning outcome (verbatim table).
function cipdL7UnitResult(loMarks) {
    const marks = (loMarks || []).map(x => Number(x && x.mark)).filter(n => Number.isInteger(n) && n >= 1 && n <= 4);
    if (!marks.length) return null;
    const total = marks.reduce((a, b) => a + b, 0);
    // "To pass the unit assessment learners must achieve a 2 (Pass) or above for
    // each of the learning outcomes" — one outcome at 1 refers the unit.
    if (marks.some(m => m < 2)) return { total, label: 'Refer', why: 'a learning outcome marked 1 refers the whole unit whatever the total' };
    if (total <= 7) return { total, label: 'Refer', why: 'total 0–7' };
    if (total <= 9) return { total, label: 'Pass', why: 'total 8–9' };
    if (total <= 13) return { total, label: 'Merit', why: 'total 10–13' };
    return { total, label: 'Distinction', why: 'total 14–16' };
}

const CIPD_L7 = {
    id: 'cipd-l7',
    name: 'CIPD Level 7 Advanced Diploma',
    labels: ['Refer', 'Pass', 'Merit', 'Distinction'],
    perOutcomeMarks: true,
    // Does this brief belong to the scheme? The brief's own words, the task text,
    // or her explicit choice in the settings.
    detect({ brief, gradeScheme, taskText }) {
        const g = String(gradeScheme || '');
        if (/cipd/i.test(g)) return true;
        const hay = [brief && brief.title, brief && brief.whatItWants, brief && brief.youreProducing, taskText].filter(Boolean).join(' \n ').slice(0, 20000);
        const ids = (brief && Array.isArray(brief.criteria) ? brief.criteria : []).map(c => String(c && c.id || '')).join(' ');
        // A CIPD Level 7 unit code (7HR02, 7CO01, 7OS…, 7LD…) is CIPD by definition.
        // "CIPD" itself is matched anywhere — the assessment IDs read CIPD_7HR02_22_01,
        // where a word boundary never fires (missed on Sarah's live mark, 18 Aug).
        const code = /\b7(HR|CO|OS|LD)\d{2}\b/i.test(hay) || /\b7(HR|CO|OS|LD)\d{2}\b/i.test(ids);
        const cipd = /CIPD/i.test(hay);
        const l7 = /Level\s*7|Advanced Diploma/i.test(hay);
        return code || (cipd && l7);
    },
    unitResult: cipdL7UnitResult,
    // The block the marker reads. Verbatim strings; the verification status is
    // stated so the marker (and anyone reading the prompt) knows what this is.
    promptBlock() {
        const rows = CIPD_L7_GRID.map(r => `- ${r.row}:\n    Refer/Fail (1): "${r.refer}"\n    Pass (2): "${r.pass}"\n    Merit (3): "${r.merit}"\n    Distinction (4): "${r.distinction}"`).join('\n');
        return `THE MARKING STANDARD — CIPD Level 7 Advanced Diploma. Mark against THIS, in its own words, as the CIPD assessor will.
(Grade descriptor grid and mark arithmetic: CIPD-authored, from CIPD Learner Assessment Briefs. Unit criteria and grading rules: CIPD's published specification.)

HOW THE MARK IS BUILT (verbatim from CIPD): "Assessors must provide a mark from 1 to 4 for each Learning Outcome in the unit. Assessors should use the generic grade descriptor grid as guidance so they can provide comprehensive feedback that is developmental for learners. Please be aware that not all of the generic grade descriptors will be present in every learning outcome for all the assignments, so assessors must use their discretion in making grading decisions." "To pass the unit assessment learners must achieve a 2 (Pass) or above for each of the learning outcomes. The overall mark achieved will dictate the Grade the learner receives for the Unit, provided NONE of the learning outcomes have been failed or referred." Unit result from the total of the learning-outcome marks: 0–7 Refer/Fail · 8–9 Pass · 10–13 Merit · 14–16 Distinction. Grades exist at UNIT level only.

THE SIX CRITERIA an assessor weighs (verbatim: "it may be that not all these criteria are present in every question"): focus; depth and breadth of understanding; strategic application and professional advice; research and wider reading; persuasiveness and originality; presentation and language.

WHAT EACH MARK MEANS, per criterion (verbatim grid):
${rows}

ALSO VERBATIM AND LOAD-BEARING: "As this is a Level 7 Diploma, it is important that you are able to demonstrate not only good knowledge and understanding of the material associated with each learning outcome, but also the ability to develop an original argument and justify it persuasively with reference to wider reading. Examples of approaches taken in a range of organisations are also an effective means by which to justify your arguments." And: "You must demonstrate within the submitted evidence (through headings and sub-headings) which learning outcomes and assessment criteria have been cited. We are unable to moderate your work if this is not included."

HOW TO APPLY IT HERE:
- Group the brief's criteria (AC1.1, AC1.2 … AC4.4) under their LEARNING OUTCOMES (LO1 = AC1.x, LO2 = AC2.x, …). Give EACH learning outcome present in the brief ONE mark, 1–4, from the grid — "loMarks": [{ label: "LO1", mark: 3, reason: "…" }] — the reason naming the grid rows that decided it (e.g. "depth and breadth: solid across 1.1–1.3 but 1.4 has no comparison; research: two sources, no wider reading").
- The unit result follows the arithmetic above (one outcome at 1 = Refer, whatever the total); "label" overall must be that result and "total" the sum. Per criterion, "label" is what that part would earn on its own on the same scale.
- Use the six criteria's names in your reasons; the ladder's rungs say which learning outcome(s) must rise, by how much, and what in the grid's words that takes.
- If the draft has no headings that map to the ACs, say so in "structure" (verbatim rule above) — one plain sentence; empty string if the headings are there.`;
    },
};

const SCHEMES = [CIPD_L7];

/** Which published scheme applies to this brief, or null. */
function detectMarkScheme(args) {
    for (const s of SCHEMES) { try { if (s.detect(args || {})) return s; } catch (_) {} }
    return null;
}

module.exports = { SCHEMES, detectMarkScheme, CIPD_L7, cipdL7UnitResult };
