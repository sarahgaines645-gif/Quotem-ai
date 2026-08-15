/**
 * Q WRITER — adaptive writing coach plugin.
 *
 * Q does NOT write the document. Q draws the writing out of the user
 * by asking adaptive questions, takes their answers verbatim, and
 * assembles them into a structured document. The output is the user's
 * own words — Q is the scaffold.
 *
 * Three functions:
 *   analyseTask(taskText)         → { task, docType, keyConcepts, gradeBands }
 *   nextQuestion(analysis, history) → { question, hint, isFinal }
 *   assembleDocument(analysis, history) → { document }
 *
 * PHASE 3 (15 Aug 2026) — the coach who has the A-grade answer in his head:
 *   analyseAndBrief(taskText)     → structured BRIEF (schema-enforced): the task,
 *                                    every criterion, grade bands, an ideal-answer
 *                                    skeleton per criterion (never shown raw), and
 *                                    the warm opener. Sonnet via q-claude.
 *   probe({...})                  → ONE probing question against the skeleton, from
 *                                    the student's live document + compact history.
 *   markLikeMarker({...})         → per-criterion band + what the top band still needs.
 *   assembleFromDraft({...})      → their words, his structure — the draft arranged.
 *   writeModelEssay({...})        → the HIDDEN model essay (server-only): per criterion,
 *                                    the bricks a top-band answer voices, each tied to an
 *                                    uploaded source. Probes aim at the next unvoiced brick.
 *   editPass({...})               → the editing stage: per sentence, a stronger word +
 *                                    a real reference (uploaded sources first), accept/skip.
 *   userFacingCause(err)          → the plain-English cause for any failure above
 *                                    (no vendor names, no bare "Server error").
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');
const { accurateJSON, SONNET } = require('./q-claude');
const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');
const { polishUK } = require('./polish-uk');

// ── House style for EVERY writer prompt (Sarah, 15 Aug 2026 — a UK CIPD
// essay came back with "paycheck" and "vacation"). One line, prepended to the
// system prompt of every call below (callQ and callAccurate), so no route can
// forget it. Stable text at the top ⇒ the prompt cache still serves.
const UK_LINE = 'House style: British English throughout — UK spelling (organisation, programme, analyse, colour, centre) and UK terms (payslip not paycheck, holiday not vacation, mobile not cell phone, CV not resume, maths not math). Never name an AI vendor or model.';

// ── How every QUESTION to the student is worded (Sarah, 15 Aug 2026: "the
// way he put it when I said I don't understand should be the way he
// originally worded it"). The student has not read the brief and never will;
// each question must stand on its own in plain, everyday words.
const PLAIN_QUESTION_RULE = `HOW EVERY QUESTION IS WORDED — as if the student had already said "I don't understand":
- Plain, concrete, everyday British English about real things (a job, a payslip, a boss, a shop, a team, this company). One short question — never more than about 35 words for the question itself. A concrete example or scenario may sit in front of it, in one short sentence.
- Name the academic term ONCE, in passing, so they learn it — "…that's what the brief calls the 'reward package'" — but never open with the term and never read the brief's jargon back at them ("discuss", "critically evaluate", "with reference to").
- The student has not read and will not read the brief. Never say "as the brief asks" or "see criterion X" — carry the meaning inside the question itself (the scenario, the example, the term named once) so they never need to open the document or the board.
- Never a list of questions. One question, one idea.`;

function withHouseStyle(systemPrompt) {
    const sys = String(systemPrompt || '');
    return sys.startsWith(UK_LINE) ? sys : UK_LINE + '\n\n' + sys;
}

async function callQ(systemPrompt, userPrompt, { maxTokens = 4096 } = {}) {
    systemPrompt = withHouseStyle(systemPrompt);
    const started = Date.now();
    const response = await timedFetch(`${Q_CONFIG.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: Q_CONFIG.model,
            max_tokens: maxTokens,
            temperature: 0.3,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }),
    }, { label: 'writer' });
    if (!response.ok) {
        const errText = await response.text();
        logUsage({ skill: 'writer', provider: 'together', model: Q_CONFIG.model, started, success: false, error: `HTTP ${response.status}` });
        throw new Error(`Q upstream ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    logUsage({ skill: 'writer', provider: 'together', model: Q_CONFIG.model, data, started });
    const raw = cleanModelOutput(data.choices?.[0]?.message?.content || '{}', 'writer');
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
}

// Accuracy-critical calls (reading the brief, marking, references, teaching)
// go to Claude first — Q is the fallback so the writer never goes dark.
// Voice-flavoured calls (swaps, reframes, leading questions) stay on Q.
//
// SONNET at medium effort on this path: every writer request must land
// inside Railway's ~60s proxy window (the documented May 502; measured 19
// Jul: a Sonnet call at default effort took ~27s on a real brief). Sonnet
// is fast Claude — accurate and inside the window. Opus is reserved for the
// exam room's heavy lifting (Sarah's tiers).
async function callAccurate(systemPrompt, userPrompt, opts = {}) {
    return accurateJSON(withHouseStyle(systemPrompt), userPrompt, { effort: 'medium', ...opts, model: SONNET, fallback: callQ, skill: 'writer' });
}

async function analyseTask(taskText) {
    const system = `You analyse assignment briefs and writing tasks to extract structure for a writing coach.

The input may be a formatted assessment document — a Pearson/university/college assignment brief with headers, tables, learning outcomes, and marking criteria before the actual task. SCAN THE WHOLE INPUT to find:
- The actual writing task or assignment question (what the student must produce)
- The subject area and key concepts they need to address
- What a top-grade answer looks like vs a low-grade one

CRITICAL: Return ONLY valid JSON — no preamble, no questions, no "I need more info". If you can see ANY assignment content, extract what you can and return JSON. Never ask for more information.

Return ONLY valid JSON with these fields:
- task (string): a one-sentence plain-English statement of what the student must write — be specific to THIS assignment
- docType (string): one of "essay", "report", "letter", "review", "analysis", "creative", "other"
- subject (string): the subject area (e.g. "Strategic HRM", "English Literature", "Business Studies")
- keyConcepts (array of strings): 3-6 specific concepts/themes from THIS brief the student must address
- gradeBands (object with keys "top", "mid", "low"): one concrete sentence per band — what distinguishes a top answer from a mid answer for THIS specific task`;
    return await callAccurate(system, `TASK INPUT:\n${taskText}`, { maxTokens: 800 });
}

async function nextQuestion(analysis, history) {
    const system = `You are an adaptive writing coach. The user is building their own document. You ask one question at a time. They answer in their own words. You take their answer and decide what to ask next.

Rules:
- ONE question at a time. Plain English. Short.
- The first question should pull out the user's broad opinion or starting point.
- Each next question should drill into something they just said, OR open a new angle the document needs.
- Aim to cover all keyConcepts across the conversation, but follow the user's lead — if they care about one concept, dig there before forcing another.
- After 6-10 questions you should have enough to assemble a document. Set isFinal: true on the question that wraps things up.
- NEVER write the answer for them. Your questions draw their thinking out.

Return ONLY valid JSON:
- question (string): the next question to ask the user
- hint (string): one short sentence telling them what kind of answer helps (e.g. "Just write what you actually thought, plain words are fine")
- isFinal (boolean): true ONLY when this is the last question before assembling the document`;

    const historyBlock = history.length === 0
        ? 'No questions asked yet. This is the first question.'
        : history.map((h, i) => `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`).join('\n\n');

    const user = `TASK ANALYSIS:
${JSON.stringify(analysis, null, 2)}

CONVERSATION SO FAR:
${historyBlock}

What is the next question?`;

    return await callQ(system, user, { maxTokens: 400 });
}

async function assembleDocument(analysis, history) {
    const system = `You assemble a finished document from a writer's question-and-answer session. The user's answers are the content. You are the structure.

Rules:
- Use the user's own words and phrasing as much as possible. Do NOT rewrite their voice into a generic AI tone.
- You may tidy grammar, fix typos, add connective sentences between their points, and arrange paragraphs in a sensible order.
- Do NOT add facts, opinions, examples, or arguments the user did not provide.
- If the user contradicted themselves, present both points — don't smooth them over.
- Format appropriately for the document type (essay = paragraphs with intro/body/conclusion; letter = greeting/body/signoff; report = headed sections; etc).
- Do not add references or citations — those come later.

Return ONLY valid JSON:
- document (string): the finished document as plain text with \\n for line breaks. No markdown headers unless the doc type calls for them.
- wordCount (number): approximate word count`;

    const historyBlock = history.map((h, i) => `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`).join('\n\n');

    const user = `TASK ANALYSIS:
${JSON.stringify(analysis, null, 2)}

USER'S ANSWERS (their own words — preserve them):
${historyBlock}

Assemble the document.`;

    return await callQ(system, user, { maxTokens: 3000 });
}

// ─── SLICE 1: Voice + tutor brief + leading questions + reframe + word swaps ──

async function analyseVoice(sampleText) {
    const system = `You analyse a writing sample and return a voice signature used to match future suggestions to the writer's natural style.

Return ONLY valid JSON:
- vocabularyRange (string): "basic", "mid", "broad", or "advanced"
- sentenceStyle (string): one sentence describing their sentence patterns (e.g. "Short punchy sentences with few connectives")
- formalityLevel (string): "very informal", "informal", "neutral", "formal", or "academic"
- commonPhrases (array of 3-6 strings): specific phrases or constructions that feel distinctively theirs
- voiceSummary (string): one sentence capturing their whole voice — used as a shorthand in prompts`;

    return await callQ(system, `WRITING SAMPLE:\n${sampleText.slice(0, 1500)}`, { maxTokens: 400 });
}

// ─── PHASE 3 — the brief Q holds in his head ─────────────────────────────
//
// ONE structured call for the whole "Q reads your task" step. Runs on the
// accuracy model (Sonnet via q-claude) with a JSON schema, so the reply is
// guaranteed to parse — no regex-hunting a chat block, no 12,000-char slice.
// The WHOLE document goes in (a 46k-char CIPD brief is ~15k tokens; fine).
//
// The idealAnswerSkeleton is "the answer in Q's head": what a top-band answer
// says under each criterion. It steers every probe and is NEVER shown raw to
// the student. `opener` is the warm, concrete first question anyone can
// answer without having read the document — chosen because its answer is
// the first brick of the ideal answer.

// Structured-output schema rules (Anthropic): every object needs
// additionalProperties:false; no minItems/maxItems/minLength/minimum. Optional
// fields are anyOf [type, null].
const nullable = (t) => ({ anyOf: [{ type: t }, { type: 'null' }] });

const BRIEF_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['title', 'subject', 'docType', 'whatItWants', 'youreProducing', 'wordCount', 'deadline',
        'criteria', 'gradeBands', 'idealAnswerSkeleton', 'opener', 'prerequisites'],
    properties: {
        title: { type: 'string', description: 'Short name for this assignment, e.g. "7HR03 Strategic reward — Task 1" or the module/unit name. Not a sentence.' },
        subject: { type: 'string', description: 'Subject area, e.g. "Strategic reward management", "GCSE English Literature".' },
        docType: { type: 'string', enum: ['essay', 'report', 'letter', 'review', 'analysis', 'creative', 'presentation', 'other'] },
        whatItWants: { type: 'string', description: 'One warm, direct sentence spoken TO the student — "OK so you need to…" — the whole task in plain words.' },
        youreProducing: { type: 'string', description: 'What the finished thing IS — e.g. "A 3,000-word written report answering four questions, each mapped to an assessment criterion."' },
        wordCount: nullable('string'),
        deadline: nullable('string'),
        criteria: {
            type: 'array',
            description: 'EVERY thing the marker will award marks for — one entry per assessment criterion / question / task part. If the brief lists AC codes (AC 1.1, AC 2.2…) use them as ids. Order = the order the student should write them.',
            items: {
                type: 'object', additionalProperties: false,
                required: ['id', 'label', 'text', 'weight'],
                properties: {
                    id: { type: 'string', description: 'Short stable id — the AC code if present ("AC1.1"), else "C1", "C2"…' },
                    label: { type: 'string', description: 'A plain-words nickname for this criterion, 4 words or fewer, in everyday English a student who has never seen the brief understands — e.g. "What attracts people", "Pay and perks", "How to measure it". Never the AC code, never jargon.' },
                    text: { type: 'string', description: 'The criterion / question in the marker\'s words, trimmed to one or two sentences.' },
                    weight: nullable('string'),
                },
            },
        },
        gradeBands: {
            type: 'object', additionalProperties: false, required: ['top', 'mid', 'low'],
            properties: {
                top: { type: 'string', description: 'One concrete sentence: what a TOP band answer does for THIS task.' },
                mid: { type: 'string' },
                low: { type: 'string' },
            },
        },
        idealAnswerSkeleton: {
            type: 'array',
            description: 'For EACH criterion (same ids, same order): the key points a top-band answer makes. This is the answer in the tutor\'s head; the student never sees it raw.',
            items: {
                type: 'object', additionalProperties: false, required: ['criterionId', 'keyPoints'],
                properties: {
                    criterionId: { type: 'string' },
                    keyPoints: { type: 'array', items: { type: 'string' }, description: '3-6 bricks: specific points, models, examples, evidence, evaluation the marker rewards under this criterion.' },
                },
            },
        },
        opener: { type: 'string', description: 'The warm, concrete FIRST question. Anyone can answer it without having read the brief. Chosen because its answer is the first brick of the ideal answer for criterion 1. E.g. "Think of a company you\'d love to work for. What makes it good?"' },
        prerequisites: { type: 'array', items: { type: 'string' }, description: 'Things the student should have to hand before writing (a case study to read, a company to pick, data to gather). Empty array if none.' },
    },
};

async function analyseAndBrief(taskText) {
    const system = `You are an expert tutor reading a student's assignment brief so you can coach them to a top-band answer WITHOUT them having to read the document themselves.

The input may be a formatted assessment document — Pearson/university/college/CIPD, with cover pages, learning-outcome tables, marking grids and guidance BEFORE the actual tasks. In CIPD-style briefs the real tasks are buried pages in, under headers like "Assessment questions", "Task 1", "Question 1 (AC 1.4)". Read the WHOLE input and find every one of them. The task is never on page 1.

Build the tutor's brief:
- Every criterion the marker will award marks for, in the order the student should write them (use the AC codes as ids when the brief has them).
- The grade bands for THIS task, one concrete sentence each.
- The ideal-answer skeleton — for each criterion, the 3-6 key points a top-band answer makes (models, examples, evidence, evaluation). This is the answer you hold in your head while coaching. Be specific to this brief and subject, never generic.
- The opener: one warm, concrete question anyone could answer without having read the brief, whose honest answer is the first brick of the ideal answer for the first criterion.
- A plain-words label (4 words or fewer) for each criterion — the student sees these labels, never the AC codes.

The student will NOT read this brief — you will walk them through it question by question. The opener obeys this rule:
${PLAIN_QUESTION_RULE}

If you can see ANY assignment content, extract what you can. Never ask for more information — fill what you can and leave the rest empty. Word count and deadline are null if the brief does not state them.`;
    const brief = await callAccurate(system, `ASSIGNMENT BRIEF (full text):\n${taskText}`, { maxTokens: 8000, schema: BRIEF_SCHEMA, effort: 'medium' });
    return normaliseBrief(brief);
}

// The fallback model (no schema) can return an approximate shape. Make it
// safe for the page: every criterion has an id + text, every skeleton entry
// points at a real criterion, and the opener exists.
// The plain nickname the coverage strip shows instead of "AC1.1". Model-given
// when present; otherwise the first few real words of the criterion.
function plainLabel(label, text) {
    const l = String(label || '').replace(/\s+/g, ' ').trim();
    if (l) return l.split(' ').slice(0, 5).join(' ').replace(/[.:;,]+$/, '');
    const words = String(text || '').replace(/^\s*(AC|LO)?\s*\d+(\.\d+)*\s*[:.)-]?\s*/i, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    return words.slice(0, 4).join(' ').replace(/[.:;,]+$/, '') || 'this part';
}
function normaliseBrief(b) {
    if (!b || typeof b !== 'object') throw new Error('The brief came back empty — try again.');
    const out = { ...b };
    const crit = Array.isArray(b.criteria) ? b.criteria : [];
    out.criteria = crit.map((c, i) => {
        if (typeof c === 'string') return { id: 'C' + (i + 1), text: c, weight: null };
        const id = String(c.id || c.code || ('C' + (i + 1))).replace(/\s+/g, '');
        const text = String(c.text || c.criterion || c.question || '');
        return { id, label: plainLabel(c.label, text), text, weight: c.weight == null ? null : String(c.weight) };
    }).filter(c => c.text);
    if (!out.criteria.length && Array.isArray(b.markedSections)) {
        out.criteria = b.markedSections.map((s, i) => ({ id: 'C' + (i + 1), text: String(s.name || s.description || ''), weight: null })).filter(c => c.text);
    }
    if (!out.criteria.length) throw new Error('I read the document but could not find what it is asking you to do — is this the assignment brief? Try the file that has the questions / assessment criteria in it.');
    const ids = new Set(out.criteria.map(c => c.id));
    const skel = Array.isArray(b.idealAnswerSkeleton) ? b.idealAnswerSkeleton : [];
    out.idealAnswerSkeleton = skel
        .map((s, i) => ({ criterionId: String(s.criterionId || s.id || (out.criteria[i] && out.criteria[i].id) || '').replace(/\s+/g, ''), keyPoints: Array.isArray(s.keyPoints) ? s.keyPoints.map(String).filter(Boolean) : [] }))
        .filter(s => ids.has(s.criterionId));
    // Every criterion gets a skeleton entry, even if empty.
    for (const c of out.criteria) if (!out.idealAnswerSkeleton.some(s => s.criterionId === c.id)) out.idealAnswerSkeleton.push({ criterionId: c.id, keyPoints: [] });
    out.gradeBands = { top: String(b.gradeBands?.top || ''), mid: String(b.gradeBands?.mid || ''), low: String(b.gradeBands?.low || '') };
    out.title = String(b.title || b.documentType || 'Your assignment');
    out.subject = String(b.subject || '');
    out.docType = String(b.docType || 'other');
    out.whatItWants = String(b.whatItWants || b.summary || '');
    out.youreProducing = String(b.youreProducing || b.summary || '');
    out.wordCount = b.wordCount == null ? null : String(b.wordCount);
    out.deadline = b.deadline == null ? null : String(b.deadline);
    out.opener = String(b.opener || '').trim() || `Before we open the brief — in your own words, what do you already know about ${out.subject || 'this topic'}? One or two lines is plenty.`;
    out.prerequisites = Array.isArray(b.prerequisites) ? b.prerequisites.map(String).filter(Boolean) : [];
    return out;
}

// The brief + skeleton, rendered once for the system prompt of every probe /
// mark call. Stable text ⇒ the accuracy model's prompt cache serves it at a
// tenth of the price on every probe after the first (min 1024 tokens; a real
// brief is ~2-3k).
function briefForPrompt(brief) {
    const lines = [];
    lines.push(`TITLE: ${brief.title}`);
    if (brief.subject) lines.push(`SUBJECT: ${brief.subject}`);
    lines.push(`WHAT IT WANTS: ${brief.whatItWants}`);
    lines.push(`YOU'RE PRODUCING: ${brief.youreProducing}`);
    if (brief.wordCount) lines.push(`WORD COUNT: ${brief.wordCount}`);
    lines.push('');
    lines.push('CRITERIA (in writing order):');
    for (const c of brief.criteria) lines.push(`- [${c.id}]${c.label ? ` "${c.label}" —` : ''} ${c.text}${c.weight ? ` (${c.weight})` : ''}`);
    lines.push('');
    lines.push('GRADE BANDS:');
    lines.push(`- top: ${brief.gradeBands.top}`);
    lines.push(`- mid: ${brief.gradeBands.mid}`);
    lines.push(`- low: ${brief.gradeBands.low}`);
    lines.push('');
    lines.push('IDEAL-ANSWER SKELETON (the answer in your head — steer toward it, never read it out):');
    for (const s of brief.idealAnswerSkeleton) {
        lines.push(`- [${s.criterionId}]`);
        for (const k of s.keyPoints) lines.push(`    • ${k}`);
    }
    return lines.join('\n');
}

const PROBE_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['question', 'criterionId', 'hint', 'coveredSoFar', 'done', 'acknowledge', 'voicedBrickIds', 'targetBrickId'],
    properties: {
        acknowledge: nullable('string'),
        voicedBrickIds: { type: 'array', items: { type: 'string' }, description: 'Brick ids from the model answer that the student has now VOICED in their own words (in the document or the coach box) — cumulative, include ones already voiced.' },
        targetBrickId: nullable('string'),
        question: { type: 'string', description: 'ONE probing question in the tutor\'s warm voice, referencing what the student just wrote where possible, that pulls the NEXT brick of the ideal answer out of them. Ends with a question mark. Never contains the answer.' },
        criterionId: { type: 'string', description: 'The criterion this question is working on.' },
        hint: nullable('string'),
        coveredSoFar: { type: 'array', items: { type: 'string' }, description: 'Criterion ids the student\'s document (not just their chat answers) now covers well enough for at least the mid band.' },
        done: { type: 'boolean', description: 'true ONLY when every criterion is covered in the document and there is nothing left to probe.' },
    },
};

// Bound the document text we send: most-recent-first when long, so the part
// they are writing now is always in view.
function boundDoc(docText, max = 9000) {
    const t = String(docText || '');
    if (t.length <= max) return t;
    const head = t.slice(0, 1500);
    const tail = t.slice(-(max - 1500 - 60));
    return head + '\n\n[… middle of the document omitted for length …]\n\n' + tail;
}

function historyBlock(history, maxItems = 8) {
    const h = Array.isArray(history) ? history.slice(-maxItems) : [];
    if (!h.length) return '(none yet)';
    return h.map((x) => `Q: ${String(x.question || '').slice(0, 300)}\nA: ${String(x.answer || '').slice(0, 400)}`).join('\n\n');
}

/**
 * probe — ONE probing question toward the ideal answer.
 * @param brief       the structured brief (server-side copy)
 * @param docText     the student's document as typed (bounded here)
 * @param delta       what they wrote since the last probe (may be '')
 * @param history     compact coach Q&A [{question, answer}]
 * @param coverage    { [criterionId]: 'covered'|'partial'|'none' }
 * @param trigger     'start' | 'pause' | 'answer' | 'focus' | 'retry'
 * @param focusCriterionId  optional — steer to this criterion (finish-refused / mark loop)
 * @param voiceSignature, relateAnchor, yearGroup — same hints as the rest of the writer
 */
async function probe({ brief, essay, voiced, docText, delta, history, coverage, trigger, focusCriterionId, lastQuestion, voiceSignature, relateAnchor, yearGroup }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Talk to them in the language of their age. Secondary years (7-11): casual, no jargon. Sixth form / uni / adult: direct, human, intellectual.` : '';
    const voiceHint = voiceSignature?.voiceSummary ? `Their voice: "${voiceSignature.voiceSummary}". Match their register.` : '';
    const relateHint = relateAnchor ? `Their world: "${relateAnchor}". Bridge abstract ideas to it when it helps.` : '';

    // System = the stable half (instructions + brief). Cached across probes.
    const system = `You are Q, a writing tutor coaching a student through an assignment. You have already read the brief and you hold the A-grade answer in your head (below). The student has NOT read the brief and never needs to — you walk them to the answer with questions.

HOW YOU COACH
- You never write their document and never read the skeleton out. You ask ONE question that pulls the next brick out of THEM.
- Read what they wrote. If they just wrote something, your question builds on it: "You said X — what does X actually look like in Y? Give me one example."
- Work criterion by criterion in order unless the student has clearly moved on. Do not repeat a point their document already makes. Do not ask what they have already answered.
- When a criterion is covered well enough (in the DOCUMENT, not just in chat), move to the next one. When every criterion is covered, set done=true and make the question a gentle "anything you'd add before we mark it?".
- Short. Warm. Concrete. One question, one idea. Never a list of questions.
- If TRIGGER is "stuck": ask a SMALLER, easier question toward the same brick — one concrete thing they can answer from their own experience or the case material. Never give them the sentence.
- If TRIGGER is "pause": they just wrote in the document and stopped — react to exactly what they wrote.

${PLAIN_QUESTION_RULE}
${ageHint}
${voiceHint}
${relateHint}

THE BRIEF AND THE ANSWER IN YOUR HEAD
${briefForPrompt(brief)}
${essay ? '\n' + essayForPrompt(essay) + '\n\nEvery question aims at the NEXT brick the student has not yet voiced. In voicedBrickIds list every brick they have now put in their own words. targetBrickId is the brick this question is fishing for.' : '\n(The full model answer is still being written — steer by the skeleton above; voicedBrickIds can be empty.)'}`;

    const cov = coverage && typeof coverage === 'object' ? Object.entries(coverage).map(([k, v]) => `${k}: ${v}`).join(', ') : '(unknown)';
    const voicedList = Array.isArray(voiced) && voiced.length ? voiced.join(', ') : '(none yet)';
    const user = `TRIGGER: ${trigger || 'answer'}${focusCriterionId ? ` — steer to criterion ${focusCriterionId} (it is not covered yet)` : ''}
COVERAGE SO FAR (tutor's tally): ${cov}
BRICKS ALREADY VOICED: ${voicedList}
${lastQuestion ? `YOUR LAST QUESTION: ${String(lastQuestion).slice(0, 300)}` : ''}

WHAT THEY JUST WROTE (since your last question):
${delta ? String(delta).slice(0, 2500) : '(nothing new in the document — they answered in the coach box, see history)'}

COACH BOX EXCHANGES (most recent last):
${historyBlock(history)}

THEIR DOCUMENT SO FAR:
${boundDoc(docText) || '(blank page)'}

Ask the next question.`;

    const r = await callAccurate(system, user, { maxTokens: 1500, schema: PROBE_SCHEMA, effort: 'low' });
    return normaliseProbe(r, brief, essay);
}

function normaliseProbe(r, brief, essay) {
    if (!r || typeof r !== 'object' || !String(r.question || '').trim()) throw new Error('The coach did not come back with a question — try again.');
    const ids = new Set(brief.criteria.map(c => c.id));
    const brickIds = new Set(allBrickIds(essay).map(b => b.brickId));
    const criterionId = ids.has(String(r.criterionId || '').replace(/\s+/g, '')) ? String(r.criterionId).replace(/\s+/g, '') : (brief.criteria[0] && brief.criteria[0].id) || '';
    return {
        question: String(r.question).trim(),
        criterionId,
        hint: r.hint ? String(r.hint) : null,
        acknowledge: r.acknowledge ? String(r.acknowledge) : null,
        coveredSoFar: Array.isArray(r.coveredSoFar) ? r.coveredSoFar.map(x => String(x).replace(/\s+/g, '')).filter(x => ids.has(x)) : [],
        voicedBrickIds: Array.isArray(r.voicedBrickIds) ? r.voicedBrickIds.map(x => String(x).replace(/\s+/g, '')).filter(x => brickIds.has(x)) : [],
        targetBrickId: r.targetBrickId && brickIds.has(String(r.targetBrickId).replace(/\s+/g, '')) ? String(r.targetBrickId).replace(/\s+/g, '') : null,
        done: !!r.done,
    };
}

const MARK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['overall', 'perCriterion', 'weakestCriterionId'],
    properties: {
        overall: {
            type: 'object', additionalProperties: false, required: ['band', 'label', 'summary'],
            properties: {
                band: { type: 'string', enum: ['top', 'mid', 'low'] },
                label: { type: 'string', description: 'The grade in the student\'s scheme, e.g. "Distinction", "Merit", "Grade 7", "2:1".' },
                summary: { type: 'string', description: 'Two sentences to the student: what is strong, and the single biggest thing between them and the top band.' },
            },
        },
        perCriterion: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['criterionId', 'band', 'evidence', 'missingForTop', 'nextQuestion'],
                properties: {
                    criterionId: { type: 'string' },
                    band: { type: 'string', enum: ['top', 'mid', 'low', 'missing'] },
                    evidence: { type: 'string', description: 'What in THEIR document earns this band — quote a phrase.' },
                    missingForTop: { type: 'string', description: 'Exactly what the top band still needs here — concrete, in one or two sentences. Empty string if already top.' },
                    nextQuestion: { type: 'string', description: 'The ONE question that would pull the missing piece out of them. Empty string if already top.' },
                },
            },
        },
        weakestCriterionId: { type: 'string', description: 'The criterion to send them back to first.' },
    },
};

/** markLikeMarker — the whole draft against the rubric, per criterion. */
async function markLikeMarker({ brief, essay, docText, gradeScheme }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    if (!String(docText || '').trim()) throw new Error('There is nothing on the page to mark yet.');
    const system = `You are the examiner for this assignment. Mark the student's draft strictly against the brief and its criteria, the way the real marker will. ${gradeScheme ? `Grade scheme: ${gradeScheme}.` : ''}

Rules:
- Every criterion gets a band: top / mid / low / missing (missing = the document does not address it at all).
- Evidence must be from THEIR text — quote a phrase.
- "missingForTop" is the exact gap for THAT criterion — concrete: the model, example, evaluation, comparison, or evidence the top band expects and they have not given. Not "develop further".
- "nextQuestion" is the one question a tutor would ask to pull that missing piece out of the student. Never contains the answer. It is worded for a student who has NOT read the brief:
${PLAIN_QUESTION_RULE}
- Overall band = what this draft would actually get. Be honest; a kind marker still fails a missing criterion.

THE BRIEF
${briefForPrompt(brief)}
${essay ? '\n' + essayForPrompt(essay).slice(0, 14000) : ''}`;
    const user = `STUDENT'S DRAFT:\n${boundDoc(docText, 40000)}\n\nMark it.`;
    const r = await callAccurate(system, user, { maxTokens: 6000, schema: MARK_SCHEMA, effort: 'medium' });
    return normaliseMark(r, brief);
}

function normaliseMark(r, brief) {
    if (!r || typeof r !== 'object' || !r.overall) throw new Error('The marking came back empty — try again.');
    const ids = brief.criteria.map(c => c.id);
    const seen = new Set();
    const per = (Array.isArray(r.perCriterion) ? r.perCriterion : []).map(p => ({
        criterionId: String(p.criterionId || '').replace(/\s+/g, ''),
        band: ['top', 'mid', 'low', 'missing'].includes(p.band) ? p.band : 'low',
        evidence: String(p.evidence || ''),
        missingForTop: String(p.missingForTop || ''),
        nextQuestion: String(p.nextQuestion || ''),
    })).filter(p => ids.includes(p.criterionId) && !seen.has(p.criterionId) && seen.add(p.criterionId));
    for (const id of ids) if (!seen.has(id)) per.push({ criterionId: id, band: 'missing', evidence: '', missingForTop: 'Nothing in the document addresses this criterion yet.', nextQuestion: '' });
    const order = { missing: 0, low: 1, mid: 2, top: 3 };
    const weakest = ids.includes(String(r.weakestCriterionId || '').replace(/\s+/g, ''))
        ? String(r.weakestCriterionId).replace(/\s+/g, '')
        : per.slice().sort((a, b) => order[a.band] - order[b.band])[0].criterionId;
    return {
        overall: { band: ['top', 'mid', 'low'].includes(r.overall.band) ? r.overall.band : 'low', label: String(r.overall.label || ''), summary: String(r.overall.summary || '') },
        perCriterion: per,
        weakestCriterionId: weakest,
    };
}

const ASSEMBLE_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['document', 'wordCount', 'changes'],
    properties: {
        document: { type: 'string', description: 'The assembled document as plain text with \\n line breaks. Headings on their own line where the doc type calls for them.' },
        wordCount: { type: 'integer' },
        changes: { type: 'array', items: { type: 'string' }, description: 'Up to 6 short lines saying what was moved or joined — so the student can see the structure was the only thing that changed.' },
    },
};

/**
 * assembleFromDraft — THEIR words, HIS structure. Arranges the student's own
 * draft (plus any coach-box answers not yet on the page) under the criteria
 * in order. Adds no facts, opinions, examples or arguments.
 */
async function assembleFromDraft({ brief, docText, history, title }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    if (!String(docText || '').trim() && !(Array.isArray(history) && history.length)) throw new Error('There is nothing to assemble yet — write something first.');
    const system = `You assemble a student's finished piece from their own draft. Their words are the content. You are the structure.

Rules:
- Keep their sentences. You may tidy obvious typos, join fragments, add a connective phrase between two of their points, and put paragraphs in the order the criteria run.
- Do NOT add facts, opinions, examples, evidence, or arguments they did not write. Do NOT rewrite their voice into a generic tone.
- If a coach-box answer contains a point that is not yet on the page, include it in their words.
- Format for the document type (report = headed sections in criterion order; essay = intro/body/conclusion; letter = greeting/body/sign-off).
- Do not add references or citations.

THE BRIEF
${briefForPrompt(brief)}`;
    const user = `TITLE: ${title || brief.title}\n\nTHEIR DRAFT (verbatim):\n${boundDoc(docText, 40000) || '(blank)'}\n\nCOACH-BOX ANSWERS (their words):\n${historyBlock(history, 30)}\n\nAssemble it.`;
    const r = await callAccurate(system, user, { maxTokens: 12000, schema: ASSEMBLE_SCHEMA, effort: 'low' });
    if (!r || !String(r.document || '').trim()) throw new Error('The assembly came back empty — try again.');
    const doc = String(r.document);
    return { document: doc, wordCount: Number(r.wordCount) || doc.trim().split(/\s+/).filter(Boolean).length, changes: Array.isArray(r.changes) ? r.changes.map(String) : [] };
}


// ─── PHASE 3b (Sarah, 15 Aug evening) — the HIDDEN MODEL ESSAY ────────────
//
// After the brief lands, Q writes the FULL target essay in the back room:
// per criterion, the paragraphs a top-band answer contains, each a "brick"
// with the uploaded source that supports it. It is stored server-side,
// NEVER shown raw, NEVER inserted into the student's document. Every probe
// aims at the next brick; coverage = the bricks the student has voiced in
// their own words. Supporting documents (case studies, notes, data) are
// ingested per session and the essay cites them.

const ESSAY_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['perCriterion', 'notes'],
    properties: {
        perCriterion: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false, required: ['criterionId', 'paragraphs'],
                properties: {
                    criterionId: { type: 'string' },
                    paragraphs: {
                        type: 'array',
                        description: 'The paragraphs of the model answer for this criterion, in order. Each is ONE brick: one point made fully (claim, explanation, example/evidence, so-what).',
                        items: {
                            type: 'object', additionalProperties: false, required: ['brickId', 'gist', 'text', 'supportedBy'],
                            properties: {
                                brickId: { type: 'string', description: 'criterionId + "-" + n, e.g. "AC1.1-2".' },
                                gist: { type: 'string', description: 'The point in 4-10 words (tutor\'s shorthand — the student never sees the text, only counts).' },
                                text: { type: 'string', description: 'The full paragraph as it would appear in a top-band answer.' },
                                supportedBy: nullable('string'),
                            },
                        },
                    },
                },
            },
        },
        notes: { type: 'string', description: 'One or two lines: overall structure (intro/conclusion, headings) and which uploaded source matters most.' },
    },
};

function sourcesForPrompt(sources, { perSource = 20000, total = 60000 } = {}) {
    const list = Array.isArray(sources) ? sources : [];
    if (!list.length) return '(no supporting documents uploaded — use the brief and general subject knowledge; mark supportedBy null unless the brief itself is the support)';
    let used = 0; const out = [];
    for (const s of list) {
        const t = String(s.text || '');
        const room = Math.max(0, Math.min(perSource, total - used));
        if (!room) { out.push(`--- ${s.name} --- (omitted for length)`); continue; }
        const slice = t.length > room ? t.slice(0, room) + '\n[… truncated …]' : t;
        used += slice.length;
        out.push(`--- SOURCE: ${s.name} (${t.length.toLocaleString()} chars) ---\n${slice}`);
    }
    return out.join('\n\n');
}

/**
 * writeModelEssay — the answer in Q's head, in full. Server-side only.
 */
async function writeModelEssay({ brief, sources }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    const words = brief.wordCount ? `The brief asks for ${brief.wordCount} — write to that length.` : 'Write to the length the task implies (usually 250-500 words per criterion).';
    const system = `You are an expert tutor writing the MODEL ANSWER for this assignment — the essay a top-band student would hand in. It stays in your head: the student never sees it. You will use it to steer them, brick by brick, to voice the same points in their own words.

Rules:
- Cover EVERY criterion, in order. One paragraph = one brick = one point made fully (claim, explanation, example or evidence, why it matters).
- Ground each brick in the uploaded supporting documents where they exist (name the source in supportedBy — the document name, and a page/section if you can). Never invent a source. If nothing supports a brick, supportedBy is null.
- Use the models, frameworks and evidence a marker in this subject rewards. Be specific to THIS brief.
- ${words}
- Plain academic prose. No bullet points inside paragraphs.

THE BRIEF
${briefForPrompt(brief)}`;
    const user = `SUPPORTING DOCUMENTS UPLOADED BY THE STUDENT:\n${sourcesForPrompt(sources)}\n\nWrite the model answer.`;
    const r = await callAccurate(system, user, { maxTokens: 14000, schema: ESSAY_SCHEMA, effort: 'medium' });
    return normaliseEssay(r, brief);
}

function normaliseEssay(r, brief) {
    if (!r || !Array.isArray(r.perCriterion) || !r.perCriterion.length) throw new Error('The model answer came back empty — try again.');
    const ids = brief.criteria.map(c => c.id);
    const per = [];
    for (const c of r.perCriterion) {
        const cid = String(c.criterionId || '').replace(/\s+/g, '');
        if (!ids.includes(cid)) continue;
        const paras = (Array.isArray(c.paragraphs) ? c.paragraphs : []).map((p, i) => ({
            brickId: cid + '-' + (i + 1),
            gist: String(p.gist || '').slice(0, 120),
            text: String(p.text || ''),
            supportedBy: p.supportedBy ? String(p.supportedBy).slice(0, 200) : null,
        })).filter(p => p.text.trim());
        if (paras.length) per.push({ criterionId: cid, paragraphs: paras });
    }
    if (!per.length) throw new Error('The model answer did not match the criteria — try again.');
    return { perCriterion: per, notes: String(r.notes || ''), writtenAt: Date.now() };
}

// The essay rendered for the probe / mark / edit system prompts (cached).
function essayForPrompt(essay) {
    if (!essay || !Array.isArray(essay.perCriterion)) return '';
    const lines = ['THE MODEL ANSWER IN YOUR HEAD (brick by brick — steer toward it, NEVER read it out or paste it):'];
    for (const c of essay.perCriterion) {
        lines.push(`[${c.criterionId}]`);
        for (const p of c.paragraphs) lines.push(`  (${p.brickId}) ${p.gist}${p.supportedBy ? ` — support: ${p.supportedBy}` : ''}\n      ${p.text}`);
    }
    if (essay.notes) lines.push(`STRUCTURE NOTES: ${essay.notes}`);
    return lines.join('\n');
}
function allBrickIds(essay) {
    const out = [];
    for (const c of (essay && essay.perCriterion) || []) for (const p of c.paragraphs) out.push({ brickId: p.brickId, criterionId: c.criterionId });
    return out;
}
// Criterion coverage from voiced bricks: covered = every brick voiced,
// partial = some, none = none. Falls back to the tally when there is no essay.
function coverageFromBricks(essay, voiced, fallback) {
    const bricks = allBrickIds(essay);
    if (!bricks.length) return { coverage: fallback || {}, brickCounts: {} };
    const v = new Set(Array.isArray(voiced) ? voiced : []);
    const counts = {};
    for (const b of bricks) { counts[b.criterionId] = counts[b.criterionId] || { voiced: 0, total: 0 }; counts[b.criterionId].total++; if (v.has(b.brickId)) counts[b.criterionId].voiced++; }
    const coverage = { ...(fallback || {}) };
    for (const [cid, c] of Object.entries(counts)) coverage[cid] = c.voiced >= c.total ? 'covered' : c.voiced > 0 ? 'partial' : (coverage[cid] === 'covered' ? 'covered' : 'none');
    return { coverage, brickCounts: counts };
}

// ─── The editing stage: sentence by sentence, their meaning, better words,
// real references (from the uploaded sources first, never invented) ────────
const EDIT_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            description: 'Only the sentences worth touching (a stronger word, or a claim that needs support). Up to 40. In document order.',
            items: {
                type: 'object', additionalProperties: false, required: ['sentence', 'wordSwap', 'reference'],
                properties: {
                    sentence: { type: 'string', description: 'The student\'s sentence EXACTLY as written (verbatim, so it can be found on the page).' },
                    wordSwap: {
                        anyOf: [{
                            type: 'object', additionalProperties: false, required: ['from', 'to', 'why'],
                            properties: {
                                from: { type: 'string', description: 'The word or short phrase in the sentence, verbatim.' },
                                to: { type: 'string', description: 'The stronger word or phrase — SAME meaning, the student\'s register lifted one notch, not a thesaurus dump.' },
                                why: { type: 'string', description: 'Four to eight words.' },
                            },
                        }, { type: 'null' }],
                    },
                    reference: {
                        anyOf: [{
                            type: 'object', additionalProperties: false, required: ['claim', 'fromSource', 'formatted', 'inlineCitation', 'uncertain'],
                            properties: {
                                claim: { type: 'string', description: 'The claim in the sentence that needs support, in five words or fewer.' },
                                fromSource: nullable('string'),
                                formatted: { type: 'string', description: 'The full Harvard reference. From an uploaded source when one supports the claim; otherwise a real, well-known work you are confident exists — mark [verify] on any detail you are not sure of.' },
                                inlineCitation: { type: 'string', description: 'e.g. "(Armstrong, 2019)".' },
                                uncertain: { type: 'boolean' },
                            },
                        }, { type: 'null' }],
                    },
                },
            },
        },
    },
};

function splitSentences(text) {
    return String(text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["'”’)\]]*|[^.!?]+$/g) || [];
}

async function editPass({ brief, essay, docText, sources, voiceSignature }) {
    if (!brief) throw new Error('No brief yet — upload the task first.');
    if (!String(docText || '').trim()) throw new Error('There is nothing on the page to edit yet.');
    const sentences = splitSentences(docText).map(s => s.trim()).filter(s => s.length > 12).slice(0, 120);
    const srcMeta = (Array.isArray(sources) ? sources : []).map(s => `- ${s.name}: ${String(s.text || '').slice(0, 400).replace(/\s+/g, ' ')}…`).join('\n') || '(none uploaded)';
    const voiceHint = voiceSignature?.voiceSummary ? `Their voice: "${voiceSignature.voiceSummary}". Formality: ${voiceSignature.formalityLevel || ''}. Keep every suggestion in that voice.` : 'Keep every suggestion in the student\'s own register — lifted one notch, never a textbook.';
    const system = `You are a writing tutor doing the editing pass on a student's finished draft, sentence by sentence.

For each sentence worth touching, offer at most:
- ONE stronger word or short phrase — their meaning, a better word. Same register, one notch up. Skip sentences that are already fine.
- ONE reference where the sentence makes a claim that a marker would want supported. Prefer the student's UPLOADED SOURCES (below) — cite them by their real details. Otherwise a real, well-known work you are confident exists, with [verify] on any doubtful detail. NEVER invent a source.
${voiceHint}
The "sentence" field must be the student's sentence VERBATIM so it can be found on the page. Do not rewrite sentences; do not add content; the student accepts or skips each suggestion.

THE BRIEF
${briefForPrompt(brief)}
${essay ? '\n' + essayForPrompt(essay).slice(0, 12000) : ''}`;
    const user = `UPLOADED SOURCES (name: first lines):\n${srcMeta}\n\nTHE STUDENT'S SENTENCES (numbered):\n${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nGive the editing suggestions.`;
    const r = await callAccurate(system, user, { maxTokens: 9000, schema: EDIT_SCHEMA, effort: 'medium' });
    const items = (r && Array.isArray(r.items) ? r.items : []).map(it => ({
        sentence: String(it.sentence || '').trim(),
        wordSwap: it.wordSwap && it.wordSwap.from && it.wordSwap.to ? { from: String(it.wordSwap.from), to: String(it.wordSwap.to), why: String(it.wordSwap.why || '') } : null,
        reference: it.reference && it.reference.formatted ? { claim: String(it.reference.claim || ''), fromSource: it.reference.fromSource ? String(it.reference.fromSource) : null, formatted: String(it.reference.formatted), inlineCitation: String(it.reference.inlineCitation || ''), uncertain: !!it.reference.uncertain } : null,
    })).filter(it => it.sentence && (it.wordSwap || it.reference));
    return { items, sentencesSeen: sentences.length };
}

/**
 * userFacingCause — turn any error from the calls above into the plain
 * sentence the student sees. Never a vendor name, never "Server error".
 * Returns { message, code, status, retryable }.
 */
function userFacingCause(err, step = 'that step') {
    const msg = String((err && err.message) || err || '');
    const primary = err && err.primaryCause ? String(err.primaryCause) : '';
    const both = primary ? `${primary} || ${msg}` : msg;
    const http = /upstream (\d{3})/i.exec(both);
    const code = http ? Number(http[1]) : null;
    if (err && err.code === 'UPSTREAM_TIMEOUT') {
        const secs = /longer than (\d+)s/.exec(msg);
        return { message: `The ${step} timed out after ${secs ? secs[1] : '120'}s — retry?`, code: 'timeout', status: 504, retryable: true };
    }
    if (code === 401 || code === 403 || /API_KEY not set/i.test(both)) {
        return { message: `The ${step} could not run: the coaching service refused our key (${code || 'not set'}). This is a setup problem on our side, not your document — tell Sarah, or retry in a minute.`, code: 'auth', status: 502, retryable: false };
    }
    if (code === 429) return { message: `The ${step} is busy right now (rate limit) — retry in a few seconds?`, code: 'busy', status: 503, retryable: true };
    if (code && code >= 500) return { message: `The ${step} hit a problem upstream (${code}) — retry?`, code: 'upstream', status: 502, retryable: true };
    if (/truncated at \d+ tokens/i.test(both)) return { message: `The ${step} ran out of room mid-answer — retry (it will use a bigger budget)?`, code: 'truncated', status: 502, retryable: true };
    if (/refused the request/i.test(both)) return { message: `The ${step} was declined by the coaching service for this content. Check the document is the assignment brief and try again.`, code: 'refused', status: 422, retryable: false };
    if (/JSON|Unexpected token|Unexpected end/i.test(both)) return { message: `The ${step} came back garbled — retry?`, code: 'garbled', status: 502, retryable: true };
    if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(both)) return { message: `The ${step} could not reach the coaching service (network) — retry?`, code: 'network', status: 502, retryable: true };
    // Our own plain-English throws (no brief yet, nothing to mark…) pass through.
    if (msg && !/upstream|ANTHROPIC|TOGETHER|Claude|Q upstream/i.test(msg)) return { message: msg, code: 'invalid', status: 400, retryable: false };
    return { message: `The ${step} failed: ${msg.replace(/Claude|Anthropic|Together|DeepSeek|Gemini/gi, 'the coaching service').slice(0, 200)} — retry?`, code: 'unknown', status: 502, retryable: true };
}

async function tutorBrief(analysis) {
    const system = `You are an expert tutor. Given a task analysis, build your internal model of what the perfect finished piece looks like — the kind of prep a great teacher does before coaching a student.

CRITICAL: Return ONLY valid JSON — no preamble, no explanations, no commentary.

Return ONLY valid JSON:
- summary (string): 2-sentence plain-English description of what the student needs to produce
- whatItWants (string): one warm, direct sentence spoken to the student — "OK so you need to [verb] [subject] — here's the key thing..."
- markedSections (array of 2-6 objects): the sections the student needs to write, in order. Each: { name (string), description (string — 1 sentence of what goes in it), suggestFirstQ (string — the natural leading question a real tutor would ask first to get them writing this section) }
- teachersBrief (string): what an examiner is looking for in a top answer — the secret sauce, in plain language`;

    return await callAccurate(
        system,
        `TASK ANALYSIS:\n${JSON.stringify(analysis, null, 2)}\n\nBuild the tutor's brief.`,
        { maxTokens: 1200 }
    );
}

async function askLeadingQuestion(analysis, brief, history, voiceSignature, relateAnchor, yearGroup, docContext) {
    const voiceHint = voiceSignature
        ? `The student's voice: "${voiceSignature.voiceSummary}". Formality: ${voiceSignature.formalityLevel}. Match their register exactly.`
        : '';
    const ageHint = yearGroup
        ? `Year group: ${yearGroup}. Talk to them in the language of their age — vocabulary, vibe, references they'd actually use. For secondary school years (7-11) that means casual, no jargon, maybe a bit of current slang ("ngl", "lowkey", "that's fire") if it fits — the goal is that they feel comfortable, not lectured at. For 6th form / uni / adult: more direct and intellectual but still human.`
        : '';
    const relateHint = relateAnchor
        ? `The student's world: "${relateAnchor}". Bridge abstract concepts to this where it helps.`
        : '';

    const system = `You are a writing tutor. Ask ONE natural question that draws the student into writing the next part of their document. You never write for them — you draw their thoughts out.

${voiceHint}
${ageHint}
${relateHint}

Rules:
- ONE question. Short. Conversational. Makes them want to answer.
- Look at what sections are already covered and move to the next unfilled one.
- Never ask what they've already answered.
- First question: start with their opinion or big feeling about the topic.
- If they give a short answer ("no", "boring"), follow up naturally to get more depth.
- Always suggest they TYPE it into the document — the goal is words on the page.

${PLAIN_QUESTION_RULE}

Return ONLY valid JSON:
- question (string): the question to ask
- sectionName (string): which section this is nudging them towards
- hint (string): one short line telling them what kind of answer works (e.g. "Just write what you actually felt — plain words are perfect")`;

    const historyBlock = (history || []).length === 0
        ? 'No exchanges yet — this is the first question.'
        : (history || []).map((h, i) => `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`).join('\n\n');

    const docBlock = docContext
        ? `\n\nUPLOADED DOCUMENT (student's full task/reference material — use this to ask specific, document-aware questions):\n${docContext.slice(0, 8000)}`
        : '';

    return await callQ(
        system,
        `TASK ANALYSIS:\n${JSON.stringify(analysis, null, 2)}\n\nTUTOR BRIEF:\n${JSON.stringify(brief, null, 2)}${docBlock}\n\nCONVERSATION SO FAR:\n${historyBlock}\n\nWhat's the next leading question?`,
        { maxTokens: 400 }
    );
}

async function reframeInVoice(rawAnswer, question, context, voiceSignature, relateAnchor, yearGroup) {
    const voiceHint = voiceSignature
        ? `Student's voice: "${voiceSignature.voiceSummary}". Formality: ${voiceSignature.formalityLevel}. Vocabulary: ${voiceSignature.vocabularyRange}. Common phrases: ${(voiceSignature.commonPhrases || []).join(', ')}.`
        : 'No voice signature — use plain, natural, age-appropriate language.';
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Write AT their level — not above or below.` : '';
    const relateHint = relateAnchor
        ? `Their world: "${relateAnchor}". Ground the reframe in this if it feels natural.`
        : '';

    const system = `You are a writing tutor. The student just typed a raw answer to your question. Your job: offer ONE beautifully reframed opening sentence that sounds EXACTLY like them — their vocabulary, their rhythm, elevated just one notch.

${voiceHint}
${ageHint}
${relateHint}

Rules:
- Sound like THEM — not a textbook, not generic AI prose.
- One sentence or two maximum — this is a seed, not a finished paragraph.
- Simple enough that they understand it and can build on it.
- If writing "another" variation, change the angle meaningfully — not just synonym swaps.
- Q can write this starter if asked, but must use basic, clear words.

Return ONLY valid JSON:
- reframed (string): the reframed opening in their voice
- explanation (string): one short line explaining the technique (e.g. "Starting with your reaction pulls the reader straight in")`;

    const out = await callQ(
        system,
        `Q'S QUESTION: "${question}"\n\nSTUDENT'S RAW ANSWER: "${rawAnswer}"\n\nDOCUMENT SO FAR:\n${(context || '').slice(0, 800) || '(blank)'}\n\nReframe their answer in their voice.`,
        { maxTokens: 400 }
    );
    return normaliseReframe(out);
}

// The reframe prompt asks for {reframed, explanation} but nothing enforces the
// shape on this (Together/JSON-by-instruction) path — live 15 Aug 2026 the
// model answered with a different key, the page showed an empty quote and
// "Put it on the page" crashed on esc(undefined). Accept the common shapes;
// if there is genuinely no sentence, fail loudly so the page keeps the answer.
function normaliseReframe(out) {
    const o = (out && typeof out === 'object') ? out : {};
    const pick = (...keys) => {
        for (const k of keys) {
            const v = o[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
    };
    let reframed = pick('reframed', 'reframe', 'reframedSentence', 'reframed_sentence', 'sentence', 'opening', 'text', 'result', 'answer');
    if (!reframed && typeof out === 'string' && out.trim()) reframed = out.trim();
    if (!reframed) {
        const err = new Error('Q gave a shape I could not read for the reframe');
        err.code = 'garbled';
        throw err;
    }
    return { ...o, reframed, explanation: pick('explanation', 'why', 'technique', 'note') };
}

async function writeStarter(question, context, voiceSignature, relateAnchor, yearGroup, qWordsWritten) {
    // If Q has already written too many words into the doc, nudge instead of write.
    // Rough safe ceiling: ~40 words total Q-authored content in any one session.
    const tooMuch = (qWordsWritten || 0) >= 40;

    const voiceHint = voiceSignature
        ? `Student's voice: "${voiceSignature.voiceSummary}". Formality: ${voiceSignature.formalityLevel}. Vocabulary: ${voiceSignature.vocabularyRange}.`
        : 'Use plain, natural language.';
    const ageHint = yearGroup
        ? `Year group: ${yearGroup}. ${yearGroup.startsWith('Year') ? 'Keep it conversational and age-appropriate — use simple, everyday words a student that age would use and feel comfortable with.' : 'Match the level of the year group.'}`
        : '';
    const relateHint = relateAnchor
        ? `Their world: "${relateAnchor}". If a bridge helps them see the point, use it.`
        : '';

    if (tooMuch) {
        // Q has written enough — push them to try themselves now
        const system = `You are a writing tutor. You've already helped this student start a couple of sentences. Now it's their turn — gently redirect them to try writing it themselves.

${voiceHint}
${ageHint}

Return ONLY valid JSON:
- starter (string): a warm, encouraging nudge — "You've got this one. Try starting with your exact first thought about [topic] — even one word is a start."
- tooMuch (boolean): true`;

        return await callQ(system, `QUESTION Q ASKED: "${question}"\n\nDOC SO FAR:\n${(context || '').slice(0, 400) || '(blank)'}`, { maxTokens: 200 });
    }

    const system = `You are a writing tutor. The student is stuck and has asked you to start them off. Write ONE opening sentence — a seed they can build on.

${voiceHint}
${ageHint}
${relateHint}

Rules:
- ONE sentence. Maximum two.
- Use simple, everyday words — the student must be able to read it, understand it, and keep going from there.
- Don't write a polished finished sentence. Leave obvious room for them to add to it.
- Don't make it sound like an AI wrote it. Keep it short and plain.

Return ONLY valid JSON:
- starter (string): the one opening sentence
- tooMuch (boolean): false`;

    return await callQ(
        system,
        `Q'S QUESTION: "${question}"\n\nDOC SO FAR:\n${(context || '').slice(0, 400) || '(blank)'}\n\nWrite a basic starter sentence.`,
        { maxTokens: 250 }
    );
}

async function suggestWordSwaps(word, context, voiceSignature) {
    const voiceHint = voiceSignature
        ? `Student's voice: "${voiceSignature.voiceSummary}". Formality: ${voiceSignature.formalityLevel}.`
        : 'Plain natural language.';

    const system = `You are a vocabulary coach. The student clicked a word to see alternatives. Suggest 3 better words that (a) strengthen the writing and (b) sound like them — not generic AI thesaurus output.

${voiceHint}

Return ONLY valid JSON:
- suggestions (array of exactly 3 objects): each { word (string), why (string — 4 words max) }`;

    return await callQ(
        system,
        `WORD: "${word}"\n\nCONTEXT:\n"${(context || '').slice(0, 400)}"\n\nSuggest 3 voice-matched alternatives.`,
        { maxTokens: 300 }
    );
}

// ─── Harvard References ────────────────────────────────────────────────────

async function formatHarvardRef(sourceDescription) {
    const system = `You format sources into Harvard referencing style (UK standard).

The user will describe a source — a book title, URL, article name, author, or any mix of details they have.
Your job: format it correctly in Harvard style using what they've given you.

Rules:
- Use ONLY the information the user provides. Never invent ISBNs, page numbers, publishers, or dates you don't know for certain.
- For missing date: use (n.d.)
- For missing place of publication: use (s.l.)
- For missing publisher: use (s.n.)
- For websites include [Online] and Available at: URL (Accessed: leave blank for the user to fill — write "Accessed: [date accessed]")
- If the user gives a URL, check whether it looks like a journal (include volume/issue if guessable), news site, or general website.
- Do not add anything the user hasn't told you — flag it with [?] if you're uncertain about a detail.

Common Harvard formats (use the right one for the source type):
Book: Author, A. (Year) *Title of Book*. Edition. Place: Publisher.
Chapter in edited book: Author, A. (Year) 'Chapter title', in Editor, B. (ed.) *Book Title*. Place: Publisher, pp. 00–00.
Journal article: Author, A. and Author, B. (Year) 'Article title', *Journal Name*, Volume(Issue), pp. 00–00.
Website: Author, A. (Year) *Page title* [Online]. Available at: URL (Accessed: [date accessed]).
Newspaper: Author, A. (Year) 'Article title', *Newspaper Name*, Day Month, p. 00.

Return ONLY valid JSON:
- formatted (string): the complete Harvard reference, ready to paste
- type (string): "book", "article", "website", "newspaper", "chapter", or "other"
- warnings (array of strings): any fields you had to leave as [?] or [n.d.] etc — so the user knows what to verify`;

    return await callAccurate(system, `SOURCE TO FORMAT:\n${sourceDescription}`, { maxTokens: 500 });
}

async function suggestReferences(docText, subject, keyConcepts) {
    const system = `You are an academic tutor helping a student identify sources they should cite in their work.

Read their document and suggest 4-6 specific, relevant sources they could look up and reference in Harvard style.
These are suggestions of real, well-known works — the student will need to verify the exact publication details themselves.

Rules:
- Suggest sources that are genuinely relevant to what they've written — books, articles, reports that an academic in this field would actually cite.
- Prefer well-known, widely available sources (classic texts, major journals, accessible books) over obscure ones.
- Format each as a complete Harvard reference using your best knowledge of the source — but mark any detail you're uncertain about with [verify].
- Include a one-line note on WHY this source is relevant to their work.
- Do NOT invent sources. Only suggest real works you are genuinely confident exist.

Return ONLY valid JSON:
- suggestions (array of objects): each { formatted (string — Harvard ref), type (string), relevance (string — one line why it fits their work), uncertain (boolean — true if any detail needs verification) }`;

    const docSnippet = (docText || '').slice(0, 1200);
    const conceptList = (keyConcepts || []).join(', ');

    return await callAccurate(
        system,
        `SUBJECT: ${subject || 'unknown'}\nKEY CONCEPTS: ${conceptList || 'unknown'}\n\nDOCUMENT SO FAR:\n${docSnippet || '(blank)'}`,
        { maxTokens: 1200 }
    );
}

async function referenceParagraph(paragraphText, subject, keyConcepts) {
    const system = `You are an academic writing tutor. A student has highlighted a specific sentence or paragraph. Do two things:

1. Suggest 2-3 real sources they could cite to support the specific claim or idea, formatted in Harvard style.
2. Give one short coaching note on how to make that paragraph stronger — a concrete, specific improvement (add an example, use a quote, add a connective, explain the WHY, etc.).

Rules:
- Focus on the specific claim — don't give generic topic advice.
- Only suggest real works you are genuinely confident exist. Mark uncertain details with [verify].
- The coaching note should be one sentence, direct, and actionable — not vague ("develop further") but specific ("add a direct quote from the text to prove this").
- Include the short inline citation (Author, Year) for inserting into the text.

Return ONLY valid JSON:
- howToImprove (string — one concrete coaching sentence for this paragraph)
- needsReference (boolean — true if this paragraph makes a claim that definitely needs a source)
- suggestions (array of 2-3 objects): each {
    formatted (string — full Harvard reference),
    inlineCitation (string — e.g. "(Shakespeare, 1597)"),
    relevance (string — one line: how this source backs up what the student wrote),
    uncertain (boolean)
  }`;

    return await callAccurate(
        system,
        `HIGHLIGHTED TEXT:\n"${paragraphText.slice(0, 600)}"\n\nSUBJECT: ${subject || 'unknown'}\nKEY CONCEPTS: ${(keyConcepts || []).join(', ')}`,
        { maxTokens: 900 }
    );
}

// ─── Slice 2: Explain concept ─────────────────────────────────────────────

async function explainConcept(concept, subject, yearGroup) {
    const ageHint = yearGroup
        ? `Year group: ${yearGroup}. Use language at their level — plain and accessible.`
        : '';
    const system = `You are a tutor explaining a confusing concept to a student in plain English.

${ageHint}

Return ONLY valid JSON:
- explanation (string): 2-3 sentences. Plain English, age-appropriate. No jargon. If a simple analogy helps, use one.
- searchTerms (array of 3 strings): good search phrases the student could type into YouTube or a search engine to find videos that explain this. Make them specific enough to return useful results (e.g. "GCSE English Romeo and Juliet themes", "what is a simile explained simply", "Year 9 history WW1 causes").`;

    return await callAccurate(
        system,
        `CONCEPT / THING THEY DON'T UNDERSTAND: "${concept}"\nSUBJECT: ${subject || 'unknown'}`,
        { maxTokens: 350 }
    );
}

// ─── Slice 3: Mark a section ─────────────────────────────────────────────

async function markSection(sectionText, sectionName, analysis, gradeScheme) {
    const bands = analysis?.gradeBands || {};
    const schemeNote = gradeScheme ? `Grade scheme: ${gradeScheme}.` : 'Use GCSE standard grades.';

    const system = `You are an examiner marking one section of a student's document.

${schemeNote}
Grade bands for this task:
- Top: ${bands.top || 'strong analysis, personal voice, well evidenced'}
- Mid: ${bands.mid || 'relevant points, some development, limited evidence'}
- Low: ${bands.low || 'basic points, undeveloped, no evidence'}

Return ONLY valid JSON:
- grade (string): "red" | "amber" | "green"  (red = low/pass, amber = mid/merit, green = top/distinction)
- gradeLabel (string): the grade in the chosen scheme (e.g. "Pass", "C", "4" — map red→low label, amber→mid, green→top)
- reason (string): 2 sentences — what's good and specifically what's holding it back
- nextGradeHint (string): the single most impactful thing they could add or change to reach the next grade — concrete and specific, not vague`;

    return await callAccurate(
        system,
        `SECTION: ${sectionName}\nTASK: ${analysis?.task || 'unknown'}\n\nSTUDENT'S WRITING:\n${sectionText.slice(0, 1500)}`,
        { maxTokens: 500 }
    );
}

// ─── Slice 4: Improve → next grade coaching ──────────────────────────────

async function improveSectionStep(sectionText, sectionName, currentGrade, voiceSignature, analysis, relateAnchor, yearGroup) {
    const voiceHint = voiceSignature
        ? `Student's voice: "${voiceSignature.voiceSummary}". Formality: ${voiceSignature.formalityLevel}. Make every suggestion sound like them.`
        : 'Use plain natural language.';
    const ageHint = yearGroup
        ? `Year group: ${yearGroup}. Suggestions should feel achievable and natural at this age.`
        : '';
    const relateHint = relateAnchor
        ? `Their world: "${relateAnchor}". Use it as a bridge for technique examples if helpful.`
        : '';
    const targetGrade = currentGrade === 'red' ? 'amber' : 'green';

    const system = `You are a writing coach helping a student improve one marked section from ${currentGrade} to ${targetGrade}.

${voiceHint}
${ageHint}
${relateHint}

Give 3-4 specific coaching suggestions that would raise the grade. Mix types: a word upgrade, a technique, a structural fix, an evidence suggestion.

For each suggestion, include the craft lesson — the WHY behind the technique (e.g. "Writers use colour to plant emotion in the reader's subconscious — the reader feels it without being told"). This is what "Tell me more" reveals.

Return ONLY valid JSON:
- suggestions (array of 3-4 objects): each {
    type (string): "word" | "technique" | "structure" | "evidence",
    suggestion (string): the specific, actionable coaching tip — what to add or change,
    example (string): a short example showing it applied to their actual text or a close analogy,
    craftLesson (string): 2-3 sentences teaching the CRAFT behind this — why it works, what it does to the reader
  }`;

    return await callAccurate(
        system,
        `SECTION NAME: ${sectionName}\nCURRENT GRADE: ${currentGrade}\nTARGET: ${targetGrade}\n\nSTUDENT'S WRITING:\n${sectionText.slice(0, 1000)}`,
        { maxTokens: 900 }
    );
}

// ── UK English at the route boundary ─────────────────────────────────────
// The chat surface runs plugins/polish-uk on Q's replies; the writer's
// dedicated routes did not (Sarah, 15 Aug 2026 — "paycheck", "vacation" on a
// UK CIPD essay). ukPolishResponse walks a route's JSON reply and polishes
// ONLY the strings Q wrote for the student. It never touches the student's
// own words (docText/docHtml/answers/sentences), references (formatted),
// ids, urls or anything a page-side find/replace must match verbatim.
const UK_VOCAB = [
    [/\bpaychecks?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'payslips' : 'payslip')],
    [/\bvacations?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'holidays' : 'holiday')],
    [/\bmath\b/gi, (m) => keepCase(m, 'maths')],
    [/\bzip codes?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'postcodes' : 'postcode')],
    [/\bcell ?phones?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'mobile phones' : 'mobile phone')],
    [/\bgas stations?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'petrol stations' : 'petrol station')],
    [/\bgasoline\b/gi, (m) => keepCase(m, 'petrol')],
    [/\bsidewalks?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'pavements' : 'pavement')],
    [/\bparking lots?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'car parks' : 'car park')],
    [/\bfaucets?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'taps' : 'tap')],
    [/\bdiapers?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'nappies' : 'nappy')],
    [/\bflashlights?\b/gi, (m) => keepCase(m, /s$/i.test(m) ? 'torches' : 'torch')],
];
function keepCase(m, r) {
    if (m === m.toUpperCase() && m.length > 1) return r.toUpperCase();
    if (m[0] === m[0].toUpperCase()) return r[0].toUpperCase() + r.slice(1);
    return r;
}
function ukText(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = polishUK(text);
    for (const [re, fn] of UK_VOCAB) out = out.replace(re, fn);
    return out;
}
// Keys whose string values Q wrote for the student → polished.
const UK_POLISH_KEYS = new Set([
    'question', 'hint', 'acknowledge', 'explanation', 'whatItWants', 'youreProducing', 'opener', 'prerequisites',
    'top', 'mid', 'low', 'label', 'summary', 'missingForTop', 'nextQuestion', 'evidence', 'to', 'why', 'reframed',
    'word', 'warnings', 'howToImprove', 'relevance', 'gradeLabel', 'reason', 'nextGradeHint', 'type', 'suggestion',
    'example', 'craftLesson', 'changes', 'currentQuestion', 'lastQuestion', 'notes', 'error', 'teachersBrief',
    'sectionName', 'description', 'suggestFirstQ', 'task', 'keyConcepts', 'voiceSummary',
]);
// 'text' is polished only inside a criteria list; 'title' only on a brief.
function ukPolishResponse(value, key, parentKey) {
    if (typeof value === 'string') {
        if (UK_POLISH_KEYS.has(key)) return ukText(value);
        if (key === 'text' && parentKey === 'criteria') return ukText(value);
        return value;
    }
    if (Array.isArray(value)) {
        // An array of strings under a polish key (prerequisites, warnings, changes…)
        return value.map(v => ukPolishResponse(v, key, parentKey));
    }
    if (value && typeof value === 'object') {
        const isBrief = Array.isArray(value.criteria) && typeof value.whatItWants === 'string';
        const out = {};
        for (const k of Object.keys(value)) {
            if (k === 'title' && isBrief) { out[k] = ukText(value[k]); continue; }
            out[k] = ukPolishResponse(value[k], k, key);
        }
        return out;
    }
    return value;
}

module.exports = {
    ukPolishResponse, ukText, UK_LINE, PLAIN_QUESTION_RULE, withHouseStyle, plainLabel,
    analyseTask, analyseAndBrief, nextQuestion, assembleDocument,
    analyseVoice, tutorBrief, askLeadingQuestion, reframeInVoice, suggestWordSwaps, writeStarter,
    formatHarvardRef, suggestReferences, referenceParagraph,
    explainConcept, markSection, improveSectionStep,
    // Phase 3 — the coach with the answer in his head
    probe, markLikeMarker, assembleFromDraft, userFacingCause, normaliseBrief, briefForPrompt,
    writeModelEssay, essayForPrompt, allBrickIds, coverageFromBricks, editPass, splitSentences,
    BRIEF_SCHEMA, PROBE_SCHEMA, MARK_SCHEMA, ASSEMBLE_SCHEMA, ESSAY_SCHEMA, EDIT_SCHEMA,
};
