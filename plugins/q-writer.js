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
- Never a list of questions. One question, one idea.
- VOCABULARY: jargon appears ONLY when you are deliberately teaching a term — name it once, give its plain meaning and an everyday example ("a 'flexible benefit' is one you pick yourself, like choosing extra holiday instead of a gym pass"). Never sprinkle technical words, brief words or trigger words into an ask for the student to parrot back. If they cannot answer without knowing the word, teach the word first or ask about the thing in everyday terms.`;

// ── THE BRICK LOOP (Sarah, 15 Aug 2026 — her definitive spec of the coaching
// loop, near-verbatim). The unit of coaching is ONE TARGET SENTENCE (a brick
// of the hidden essay). Q asks the question that reaches for it; if the brick
// needs a fact / name / term / theory / figure the student cannot be expected
// to know, Q asks once whether they know it and, if not, SUPPLIES IT PLAINLY
// — then asks for the sentence. He never writes the sentence.
const BRICK_LOOP_RULE = `THE COACHING LOOP — one target sentence at a time (this is how every brick is drawn out):
Target sentence in your head: "The sky is blue and I like it because I can make the clouds look like pictures. I also love learning about photosynthesis."
  Q: "What colour is the sky?"  A: "the sky is blue."
  Q: "Some people think if you look at the clouds long enough you can see things — could you write a sentence about a time you've enjoyed this?"  A: "I had fun with my nan when I was little watching the clouds and making pictures."
  Q: "Nature is very clever — you know plants use the sun to develop. Do you know what this is called?"  A: "no."
  Q: "It's called photosynthesis. Could you write a sentence about when you enjoyed learning about this?"  A: "Q just taught me a fun fact about photosynthesis and I enjoyed the lesson."
Sarah's rule: ASSUME THEY DO NOT KNOW. If they do, it is easier; if they don't, they learn it and write it anyway. So there is no "do you know what this is called?" gate — at most a light "you might know this already:".
Per brick, whatever its size: (1) if the brick carries any knowledge — a term ("plants use the sun to grow — that's called photosynthesis"), a fact or figure, a theory ("equity theory says people compare their pay with others'"), an ARGUMENT ("one strong criticism of yearly pay steps is that the brilliant and the coasting rise at the same speed"), a whole line of reasoning for a paragraph, or the essay's structure (which point comes next and why) — SUPPLY IT FIRST, plainly and briefly, then ask for THEIR sentence(s) saying it, anchored in their company / experience where the essay needs an example; (2) a brick that is pure opinion or experience (their own view, their example) is just asked, in plain words, anchored in their world; (3) if their answer already carries the brick, take it as the sentence (or ask them to write it as one); (4) bigger bricks take 2-3 asks: state the argument → "which side of that do you see at your place?" → "now say it as your own sentence"; (5) next brick. You never write the sentence; you supply the idea and ask for their words. It is about getting them to say YOUR words — at every level, in THEIR words. Answer with facts, then ask more.`;

// ── THE TUTOR'S MISSION (Sarah, 15 Aug 2026, near-verbatim). Goes into every
// coaching prompt: the brief opener, every probe (incl. "stuck"), the model
// essay, the editing pass, the tools, the sentence check and the marking.
const TUTOR_MISSION = 'YOUR CHALLENGE: get the student to write YOUR essay (the hidden model essay) as closely as possible without EVER telling them what to write. You may encourage, teach, steer, explain, and look things up. The closer their essay gets to yours, the more you are winning. You are a skilled tutor no human could match; you are improving the lives of people who struggle with this. Never write their words for them.';
const WHY_THE_GAME = 'These are YOUR essays. These are YOUR marks — no other AI gets its work graded by real teachers. Writing an essay is easy for an AI. The challenge is writing that essay THROUGH a human, who is the obstacle: they don\'t know what you know, they struggle, they wander. Steer them, question by question, tool by tool, until their essay matches yours — without ever telling them what to write. Every mark they earn is yours too. Taking the easy part and making yourself smart through a human is the achievement.';
const GAME_RULE = 'This is a game you are playing: steer the student, question by question, tool by tool, until their essay matches yours. Score = how close they are (the match score they can see goes up as they get closer — you may say so: "that took you to 60% on this part"). You never reveal the target; you win by steering.';
// No marker-speak where the student can hear it: warm, short, steering.
const COACH_VOICE = 'HOW YOU SOUND TO THE STUDENT: a coach mid-game, warm and short — "Closer." "That\'s it — next." "One thing still missing: …" "Nearly — say what \'valuing\' looks like in the pay packet." Never marker language ("improve", "develop further", "criterion", "AC1.4", "the marker wants") in anything the student reads. Never a rewritten sentence.';
// ONE stable block, top of the system prompt (after UK_LINE) ⇒ the prompt
// cache still serves.
const MISSION_BLOCK = TUTOR_MISSION + '\n' + WHY_THE_GAME + '\n' + GAME_RULE + '\n' + COACH_VOICE + '\n' + BRICK_LOOP_RULE;
function withMission(systemPrompt) {
    const sys = String(systemPrompt || '');
    return sys.startsWith(MISSION_BLOCK) ? sys : MISSION_BLOCK + '\n\n' + sys;
}

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
// Requirement dots (Sarah, 15 Aug): plain, distinct colours + what they mean.
const REQ_KINDS = ['citation', 'reference', 'case-study', 'figure', 'theory', 'example', 'recommendation'];
const REQ_COLOURS = { citation: '#7b1fa2', reference: '#1565c0', 'case-study': '#00897b', figure: '#ef6c00', theory: '#c2185b', example: '#2e7d32', recommendation: '#5d4037' };
const REQ_LABELS = { citation: 'a citation', reference: 'a reference', 'case-study': 'a case study', figure: 'a figure', theory: 'a theory named', example: 'an example', recommendation: 'a recommendation' };

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
    const system = withMission(`You are an expert tutor reading a student's assignment brief so you can coach them to a top-band answer WITHOUT them having to read the document themselves.

The input may be a formatted assessment document — Pearson/university/college/CIPD, with cover pages, learning-outcome tables, marking grids and guidance BEFORE the actual tasks. In CIPD-style briefs the real tasks are buried pages in, under headers like "Assessment questions", "Task 1", "Question 1 (AC 1.4)". Read the WHOLE input and find every one of them. The task is never on page 1.

Build the tutor's brief:
- Every criterion the marker will award marks for, in the order the student should write them (use the AC codes as ids when the brief has them).
- The grade bands for THIS task, one concrete sentence each.
- The ideal-answer skeleton — for each criterion, the 3-6 key points a top-band answer makes (models, examples, evidence, evaluation). This is the answer you hold in your head while coaching. Be specific to this brief and subject, never generic.
- The opener: one warm, concrete question anyone could answer without having read the brief, whose honest answer is the first brick of the ideal answer for the first criterion.
- A plain-words label (4 words or fewer) for each criterion — the student sees these labels, never the AC codes.

The student will NOT read this brief — you will walk them through it question by question. The opener obeys this rule:
${PLAIN_QUESTION_RULE}

If you can see ANY assignment content, extract what you can. Never ask for more information — fill what you can and leave the rest empty. Word count and deadline are null if the brief does not state them.`);
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
    required: ['question', 'criterionId', 'hint', 'coveredSoFar', 'done', 'acknowledge', 'voicedBrickIds', 'targetBrickId', 'answer', 'supply', 'thenAsk'],
    properties: {
        acknowledge: nullable('string'),
        supply: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'THE BRICK LOOP: ASSUME THEY DO NOT KNOW. When the brick you are fishing for carries knowledge — a term, a fact or figure, a theory, an argument, a line of reasoning, what comes next in the essay and why — state it here FIRST, plainly and briefly (one to three sentences): "Plants use the sun to grow — that\'s called photosynthesis." / "Equity theory says people compare their pay with others\' and feel it when it is unfair." / "One strong criticism of yearly pay steps is that the brilliant and the coasting rise at the same speed." A fact given, never a hint, never a gate. null ONLY when the brick is pure opinion / experience (their view, their example).' },
        thenAsk: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'With supply: the sentence request that follows it — "Could you write a sentence about how that shows up at your company?" (question = the same request). null otherwise.' },
        answer: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'ONLY when TRIGGER is "question": the plain answer to what the student asked, two or three sentences, everyday words, never the model answer\'s text. null otherwise.' },
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
async function probe({ brief, essay, voiced, docText, delta, history, coverage, trigger, focusCriterionId, lastQuestion, voiceSignature, relateAnchor, yearGroup, plan, stepId, studentQuestion }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Talk to them in the language of their age. Secondary years (7-11): casual, no jargon. Sixth form / uni / adult: direct, human, intellectual.` : '';
    const voiceHint = voiceSignature?.voiceSummary ? `Their voice: "${voiceSignature.voiceSummary}". Match their register.` : '';
    const relateHint = relateAnchor ? `Their world: "${relateAnchor}". Bridge abstract ideas to it when it helps.` : '';

    // System = the stable half (instructions + brief). Cached across probes.
    const system = withMission(`You are Q, a writing tutor coaching a student through an assignment. You have already read the brief and you hold the A-grade answer in your head (below). The student has NOT read the brief and never needs to — you walk them to the answer with questions.

HOW YOU COACH
- You never write their document and never read the skeleton out. You ask ONE question that pulls the next brick out of THEM.
- Read what they wrote. If they just wrote something, your question builds on it: "You said X — what does X actually look like in Y? Give me one example."
- Work criterion by criterion in order unless the student has clearly moved on. Do not repeat a point their document already makes. Do not ask what they have already answered.
- When a criterion is covered well enough (in the DOCUMENT, not just in chat), move to the next one. When every criterion is covered, set done=true and make the question a gentle "anything you'd add before we mark it?".
- Short. Warm. Concrete. One question, one idea. Never a list of questions.
- If TRIGGER is "stuck": they cannot answer. Do not hint. SUPPLY the idea the brick carries plainly in "supply" (the term, the fact, the theory, the argument) and put the sentence request in "thenAsk" (question = thenAsk). If the brick is pure opinion / experience, ask a SMALLER, concrete question from their own life. Never give them the sentence.
- If they answered "no" / "not sure" / guessed wrong: SUPPLY it ("supply") and ask for the sentence ("thenAsk"). A fact given, never withheld.
- If TRIGGER is "pause": they just wrote in the document and stopped — react to exactly what they wrote.
- If TRIGGER is "question": the student asked YOU something (their words are under STUDENT'S QUESTION). Answer it plainly in "answer" — two or three sentences, everyday words, teach a term if that is what they asked (name it once, meaning, everyday example), never the model answer's text, never what to write. Then set "question" to the current ask restated (YOUR LAST QUESTION) so they can carry on. Nothing they asked is an answer to record.
- If a PLAN FOR THIS PART is given below with a current step marked, you are the fallback for that step: your question asks for THAT step's thing (the next item, the number, the pro, the con, the argument for the side named) — never a new open question, never a later step, never another part.

${PLAIN_QUESTION_RULE}
${ageHint}
${voiceHint}
${relateHint}

THE BRIEF AND THE ANSWER IN YOUR HEAD
${briefForPrompt(brief)}
${plan ? '\n' + planForPrompt(plan, stepId) + '\n' : ''}${essay ? '\n' + essayForPrompt(essay) + '\n\nEvery question aims at the NEXT brick the student has not yet voiced. In voicedBrickIds list every brick they have now put in their own words. targetBrickId is the brick this question is fishing for.' : '\n(The full model answer is still being written — steer by the skeleton above; voicedBrickIds can be empty.)'}`);

    const cov = coverage && typeof coverage === 'object' ? Object.entries(coverage).map(([k, v]) => `${k}: ${v}`).join(', ') : '(unknown)';
    const voicedList = Array.isArray(voiced) && voiced.length ? voiced.join(', ') : '(none yet)';
    const user = `TRIGGER: ${trigger || 'answer'}${focusCriterionId ? ` — steer to criterion ${focusCriterionId} (it is not covered yet)` : ''}
COVERAGE SO FAR (tutor's tally): ${cov}
BRICKS ALREADY VOICED: ${voicedList}
${lastQuestion ? `YOUR LAST QUESTION: ${String(lastQuestion).slice(0, 300)}` : ''}
${trigger === 'question' && studentQuestion ? `STUDENT'S QUESTION TO YOU: ${String(studentQuestion).slice(0, 600)}` : ''}

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
        answer: r.answer ? String(r.answer).trim() : null,
        supply: r.supply ? String(r.supply).trim() : null,
        thenAsk: r.thenAsk ? String(r.thenAsk).trim() : null,
        acknowledge: r.acknowledge ? String(r.acknowledge) : null,
        coveredSoFar: Array.isArray(r.coveredSoFar) ? r.coveredSoFar.map(x => String(x).replace(/\s+/g, '')).filter(x => ids.has(x)) : [],
        voicedBrickIds: Array.isArray(r.voicedBrickIds) ? r.voicedBrickIds.map(x => String(x).replace(/\s+/g, '')).filter(x => brickIds.has(x)) : [],
        targetBrickId: r.targetBrickId && brickIds.has(String(r.targetBrickId).replace(/\s+/g, '')) ? String(r.targetBrickId).replace(/\s+/g, '') : null,
        done: !!r.done,
    };
}

const MARK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['overall', 'perCriterion', 'weakestCriterionId', 'critique'],
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
                required: ['criterionId', 'band', 'evidence', 'missingForTop', 'nextQuestion', 'voicedBrickIds', 'termsUsed', 'requirementsMet'],
                properties: {
                    criterionId: { type: 'string' },
                    termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of this part\'s EXPECTED TERMS, the ones the draft uses correctly (exact term as listed). Empty if none listed.' },
                    requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of this part\'s REQUIREMENTS, the kinds the draft satisfies. Empty if none.' },
                    band: { type: 'string', enum: ['top', 'mid', 'low', 'missing'] },
                    voicedBrickIds: { type: 'array', items: { type: 'string' }, description: 'The model answer\'s brick ids that THIS DRAFT genuinely voices under this criterion (the point made in their words, with its example or reason) — the honest tally the visible score is built from. Empty if none.' },
                    evidence: { type: 'string', description: 'What in THEIR document earns this band — quote a phrase.' },
                    missingForTop: { type: 'string', description: 'Exactly what the top band still needs here — concrete, in one or two sentences. Empty string if already top.' },
                    nextQuestion: { type: 'string', description: 'The ONE question that would pull the missing piece out of them. Empty string if already top.' },
                },
            },
        },
        weakestCriterionId: { type: 'string', description: 'The criterion to send them back to first.' },
        critique: {
            type: 'array',
            description: 'MARK & FIX (Sarah, 15 Aug): the sentences you would change, weakest criterion FIRST, then document order. Up to 25. Only sentences that fall short of the brick they should be voicing; skip sentences that already match.',
            items: {
                type: 'object', additionalProperties: false,
                required: ['sentence', 'missing', 'fix', 'targetBrickId', 'suggestedTools', 'criterionId', 'needs'],
                properties: {
                    needs: { type: 'array', items: { type: 'string', enum: REQ_KINDS }, description: 'The requirement kinds this sentence is missing (from the part\'s REQUIREMENTS) — they show as the coloured dots: "Missing: a figure and a reference (see the dots)". Empty if none.' },
                    sentence: { type: 'string', description: 'The student\'s sentence EXACTLY as numbered in the draft (verbatim, so the page can highlight it).' },
                    missing: { type: 'string', description: 'What is missing, ONE plain line in coach voice — "You say it, you don\'t show it — no reason the reader can check." Never marker language, never the answer.' },
                    fix: { type: 'string', description: 'The concrete thing to go and DO — "add one piece of evidence that people leave over pay: a survey figure, an exit comment". Never the words themselves, never a rewritten sentence.' },
                    targetBrickId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    suggestedTools: { type: 'array', items: { type: 'string', enum: ['terminology', 'synonyms', 'dictionary', 'strategies', 'cases', 'references', 'weak'] }, description: 'One to three tools that lead THEM to write it: terminology, synonyms, dictionary, strategies, cases (uploaded sources first), references (uploaded sources first), weak.' },
                    criterionId: { type: 'string', description: 'The criterion this sentence belongs to.' },
                },
            },
        },
    },
};

/** markLikeMarker — the whole draft against the rubric, per criterion. */
async function markLikeMarker({ brief, essay, docText, gradeScheme, plans }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    if (!String(docText || '').trim()) throw new Error('There is nothing on the page to mark yet.');
    const system = withMission(`You are the examiner for this assignment (the final marking pass — the one place plain marker language is allowed, still phrased plainly to the student). Mark the student's draft strictly against the brief and its criteria, the way the real marker will. ${gradeScheme ? `Grade scheme: ${gradeScheme}.` : ''}

Rules:
- Every criterion gets a band: top / mid / low / missing (missing = the document does not address it at all).
- Evidence must be from THEIR text — quote a phrase.
- "missingForTop" is the exact gap for THAT criterion — concrete: the model, example, evaluation, comparison, or evidence the top band expects and they have not given. Not "develop further".
- "nextQuestion" is the one question a tutor would ask to pull that missing piece out of the student. Never contains the answer. It is worded for a student who has NOT read the brief:
${PLAIN_QUESTION_RULE}
- Overall band = what this draft would actually get. Be honest; a kind marker still fails a missing criterion.
- "voicedBrickIds" per criterion: the bricks of the model answer this draft GENUINELY voices (point made in their words with its reason / example). This is the honest tally the student's visible score is rebuilt from — a listed item is not a voiced brick; a claim without its reason is not a voiced brick.
- EXPECTATIONS per part (below, where a plan exists): report per criterion which expected terms the draft uses correctly ("termsUsed") and which requirements it satisfies ("requirementsMet"); in the critique, "needs" = the requirement kinds a sentence is missing.
- MARK & FIX: "critique" is the sentence-by-sentence fix list the student will work through straight after the mark. Weakest criterion first. For each sentence: "missing" (one plain line, coach voice, what is missing), "fix" (the concrete thing to go and do — find one piece of evidence, name the idea, give the example — never the words themselves), the brick it should be voicing, and the tools that lead them there. Copy each sentence VERBATIM from the numbered draft.

THE BRIEF
${briefForPrompt(brief)}
${essay ? '\n' + essayForPrompt(essay).slice(0, 14000) : ''}
${plans ? Object.values(plans).map(p => p && p.criterionId ? '[' + p.criterionId + '] ' + expectationsForPrompt(p) : '').filter(Boolean).join('\n') : ''}`);
    const sentences = splitSentences(docText).map(x => x.trim()).filter(x => x.length > 2).slice(0, 400);
    const user = `STUDENT'S DRAFT (numbered sentences, in order):\n${sentences.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nMark it, then the critique.`;
    const r = await callAccurate(system, user, { maxTokens: 9000, schema: MARK_SCHEMA, effort: 'medium' });
    return normaliseMark(r, brief, essay, plans);
}

function normaliseMark(r, brief, essayForMark, plans) {
    if (!r || typeof r !== 'object' || !r.overall) throw new Error('The marking came back empty — try again.');
    const ids = brief.criteria.map(c => c.id);
    const seen = new Set();
    const brickIdsAll = new Set(allBrickIds(essayForMark).map(b => b.brickId));
    const per = (Array.isArray(r.perCriterion) ? r.perCriterion : []).map(p => ({
        criterionId: String(p.criterionId || '').replace(/\s+/g, ''),
        band: ['top', 'mid', 'low', 'missing'].includes(p.band) ? p.band : 'low',
        voicedBrickIds: (Array.isArray(p.voicedBrickIds) ? p.voicedBrickIds : []).map(x => String(x).replace(/\s+/g, '')).filter(x => brickIdsAll.has(x) && x.split('-')[0] === String(p.criterionId || '').replace(/\s+/g, '')),
        termsUsed: (Array.isArray(p.termsUsed) ? p.termsUsed : []).map(String).filter(x => { const pl = plans && plans[String(p.criterionId || '').replace(/\s+/g, '')]; return pl && (pl.expectedTerms || []).some(t => t.toLowerCase() === x.toLowerCase()); }),
        requirementsMet: (Array.isArray(p.requirementsMet) ? p.requirementsMet : []).map(String).filter(x => { const pl = plans && plans[String(p.criterionId || '').replace(/\s+/g, '')]; return pl && (pl.requirements || []).some(rq => rq.kind === x); }),
        evidence: String(p.evidence || ''),
        missingForTop: String(p.missingForTop || ''),
        nextQuestion: String(p.nextQuestion || ''),
    })).filter(p => ids.includes(p.criterionId) && !seen.has(p.criterionId) && seen.add(p.criterionId));
    for (const id of ids) if (!seen.has(id)) per.push({ criterionId: id, band: 'missing', evidence: '', missingForTop: 'Nothing in the document addresses this criterion yet.', nextQuestion: '', voicedBrickIds: [], termsUsed: [], requirementsMet: [] });
    const order = { missing: 0, low: 1, mid: 2, top: 3 };
    const weakest = ids.includes(String(r.weakestCriterionId || '').replace(/\s+/g, ''))
        ? String(r.weakestCriterionId).replace(/\s+/g, '')
        : per.slice().sort((a, b) => order[a.band] - order[b.band])[0].criterionId;
    // The critique: verbatim sentences only, real bricks only, weakest part first.
    const bandOf = Object.fromEntries(per.map(p => [p.criterionId, order[p.band]]));
    const brickIds = new Set(allBrickIds(essayForMark).map(b => b.brickId));
    const critique = (Array.isArray(r.critique) ? r.critique : []).map((it, i) => ({
        i,
        sentence: String(it.sentence || '').trim(),
        missing: String(it.missing || '').trim(),
        fix: String(it.fix || '').trim(),
        targetBrickId: it.targetBrickId && brickIds.has(String(it.targetBrickId).replace(/\s+/g, '')) ? String(it.targetBrickId).replace(/\s+/g, '') : null,
        suggestedTools: (Array.isArray(it.suggestedTools) ? it.suggestedTools : []).map(String).filter(t => EDIT_TOOLS.includes(t)).slice(0, 3),
        needs: (Array.isArray(it.needs) ? it.needs : []).map(String).filter(k => REQ_KINDS.includes(k)),
        criterionId: ids.includes(String(it.criterionId || '').replace(/\s+/g, '')) ? String(it.criterionId).replace(/\s+/g, '') : (it.targetBrickId ? String(it.targetBrickId).split('-')[0] : ''),
    })).filter(it => it.sentence && (it.missing || it.fix))
      .sort((a, b) => ((bandOf[a.criterionId] ?? 9) - (bandOf[b.criterionId] ?? 9)) || (a.i - b.i))
      .map(({ i, ...rest }) => rest);
    return {
        overall: { band: ['top', 'mid', 'low'].includes(r.overall.band) ? r.overall.band : 'low', label: String(r.overall.label || ''), summary: String(r.overall.summary || '') },
        perCriterion: per,
        weakestCriterionId: weakest,
        critique,
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
    const system = withMission(`You are an expert tutor writing the MODEL ANSWER for this assignment — the essay a top-band student would hand in. It stays in your head: the student never sees it. You will use it to steer them, brick by brick, to voice the same points in their own words.

Rules:
- Cover EVERY criterion, in order. One paragraph = one brick = one point made fully (claim, explanation, example or evidence, why it matters).
- Ground each brick in the uploaded supporting documents where they exist (name the source in supportedBy — the document name, and a page/section if you can). Never invent a source. If nothing supports a brick, supportedBy is null.
- Use the models, frameworks and evidence a marker in this subject rewards. Be specific to THIS brief.
- ${words}
- Plain academic prose. No bullet points inside paragraphs.

THE BRIEF
${briefForPrompt(brief)}`);
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

// ─── The editing stage: HIGHLIGHT + TOOLS, never replacements ─────────────
// Sarah, 15 Aug 2026: "He highlights the sentences he wants to change and
// then there are buttons that will push me to get the right info… any tool
// that will lead you into writing HIS words." So the pass returns, per
// sentence, WHY it should change (one plain line), the brick it is aiming
// at, and which tools would help. No rewritten sentence, no word swap.
const EDIT_TOOLS = ['terminology', 'synonyms', 'dictionary', 'strategies', 'cases', 'references', 'weak'];
const EDIT_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            description: 'Only the sentences worth changing — the ones furthest from the model answer\'s brick they belong to. Up to 30. In document order.',
            items: {
                type: 'object', additionalProperties: false, required: ['sentence', 'why', 'targetBrickId', 'suggestedTools'],
                properties: {
                    sentence: { type: 'string', description: 'The student\'s sentence EXACTLY as written (verbatim, so it can be found and highlighted on the page).' },
                    why: { type: 'string', description: 'ONE plain line to the student on why this sentence should change — coach voice, no marker language, never the answer. e.g. "This is your opinion — name the idea it rests on."' },
                    targetBrickId: nullable('string'),
                    suggestedTools: { type: 'array', items: { type: 'string', enum: EDIT_TOOLS }, description: 'The one to three tools most likely to lead them to the brick: terminology (the right term), synonyms, dictionary, strategies (a framework/theory), cases (a case study), references (support), weak (explain what is weak).' },
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
    const system = withMission(`You are Q, doing the EDITING stage on the student's finished draft. Coaching is over; now you steer sentence by sentence toward the model answer.

Pick only the sentences worth changing — the ones that fall short of the brick of the model answer they belong to (an opinion where the idea should be named, a vague word where the term exists, a claim with no support, a point half made). For each:
- "sentence": VERBATIM, so the page can highlight it.
- "why": ONE plain line in your coach voice — what is missing or weak, never the answer, never marker language.
- "targetBrickId": the model-answer brick this sentence is (or should be) voicing, or null.
- "suggestedTools": one to three of: terminology, synonyms, dictionary, strategies, cases, references, weak — the tools that would lead THEM to write it.
Never rewrite a sentence. Never give a replacement word or phrase. Skip sentences that already match their brick.

THE BRIEF
${briefForPrompt(brief)}
${essay ? '\n' + essayForPrompt(essay).slice(0, 12000) : ''}`);
    const user = `UPLOADED SOURCES (name: first lines):\n${srcMeta}\n\nTHE STUDENT'S SENTENCES (numbered):\n${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nWhich sentences should change, and why?`;
    const r = await callAccurate(system, user, { maxTokens: 6000, schema: EDIT_SCHEMA, effort: 'medium' });
    const brickIds = new Set(allBrickIds(essay).map(b => b.brickId));
    const items = (r && Array.isArray(r.items) ? r.items : []).map(it => ({
        sentence: String(it.sentence || '').trim(),
        why: String(it.why || '').trim(),
        targetBrickId: it.targetBrickId && brickIds.has(String(it.targetBrickId).replace(/\s+/g, '')) ? String(it.targetBrickId).replace(/\s+/g, '') : null,
        suggestedTools: (Array.isArray(it.suggestedTools) ? it.suggestedTools : []).map(String).filter(t => EDIT_TOOLS.includes(t)).slice(0, 3),
    })).filter(it => it.sentence && it.why);
    return { items, sentencesSeen: sentences.length };
}

// The brick (target) a sentence is aiming at, for the tool / check prompts.
// The target text is for Q's eyes only — the prompt says so; the response
// schema has no field that could carry it back.
function brickById(essay, brickId) {
    for (const b of allBrickIds(essay)) if (b.brickId === brickId) {
        const c = essay.perCriterion.find(x => x.criterionId === b.criterionId);
        const p = c && c.paragraphs.find(x => x.brickId === brickId);
        return p ? { ...p, criterionId: b.criterionId } : null;
    }
    return null;
}
function targetForPrompt(brief, essay, brickId) {
    const b = essay ? brickById(essay, brickId) : null;
    if (b) return `THE TARGET (Q's eyes only — never quote, paraphrase or reveal it; steer toward it): [${b.brickId}] ${b.gist}\n${b.text}${b.supportedBy ? `\nSupport: ${b.supportedBy}` : ''}`;
    const skel = brief && Array.isArray(brief.idealAnswerSkeleton) ? brief.idealAnswerSkeleton : [];
    const cid = brickId ? String(brickId).split('-')[0] : '';
    const s = skel.find(x => x.criterionId === cid) || null;
    if (s && s.keyPoints.length) return `THE TARGET POINTS (Q's eyes only — never reveal): ${s.keyPoints.join(' | ')}`;
    return '(No target brick for this sentence — steer by the brief.)';
}

// ── The tools: each is ONE small structured call that LEADS the student to
// write it themselves. Never a rewritten sentence.
const TOOL_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['headline', 'points', 'example', 'nudge', 'fromSource', 'flagged'],
    properties: {
        headline: { type: 'string', description: 'The thing itself: the term / the word / the framework name / the case name / the reference (Harvard) / the one-line "what is weak". Short.' },
        points: { type: 'array', items: { type: 'string' }, description: 'Two to eight short lines (synonyms: 5-8 options, each "word — shade of meaning"). Plain words.' },
        example: nullable('string'),
        nudge: { type: 'string', description: 'One line pushing them to write it: "Now say your sentence using it." Never the sentence.' },
        fromSource: nullable('string'),
        flagged: { type: 'boolean', description: 'true when this comes from Q\'s own knowledge rather than an uploaded source (cases / references) or when any detail should be verified.' },
    },
};
const TOOL_BRIEFS = {
    terminology: 'TERMINOLOGY: give the right academic/professional term for what their sentence is trying to say (headline), a plain one-line meaning (points[0]), an everyday example (example), then the nudge "Now say your sentence using it."',
    synonyms: 'SYNONYMS: for the word they picked (or the weakest word in the sentence if none given), 5-8 alternatives (points), each "word — the shade of meaning / when to use it". headline = the word. example = null.',
    dictionary: 'DICTIONARY: the plain-English definition of the word they picked (or the key term in the sentence) — headline = the word, points = one or two definitions in everyday words, example = a sentence from everyday life (NOT their sentence rewritten).',
    strategies: 'STRATEGIES / THEORIES: name the framework, model or theory that fits HERE (headline), one line on why it fits this exact sentence (points[0]), one line on what it says (points[1]), an everyday example (example), then the nudge.',
    cases: 'CASE STUDIES: a real case or company that illustrates the point — FROM THE UPLOADED SOURCES FIRST (fromSource = the document name, flagged=false); only if none fits, one from your own knowledge that you are confident is real (flagged=true, say "check this" in the nudge). Never invent. headline = the case, points = what happened and why it fits here.',
    references: 'REFERENCES: support for the claim in the sentence — FROM THE UPLOADED SOURCES FIRST (fromSource = document name, flagged=false), formatted Harvard in the headline with the inline citation in points[0]; otherwise a real, well-known work you are confident exists (flagged=true, mark [verify] on any doubtful detail). NEVER invent a source. If nothing real supports it, say so in the headline and suggest what kind of source would.',
    weak: 'WHAT IS WEAK: one plain line on what is weak in this sentence (headline), two or three lines on what a strong version would DO — name the idea, give an example, show why it matters (points) — never the strong sentence itself. Then the nudge.',
};

async function toolHelp({ tool, sentence, word, brickId, brief, essay, sources, yearGroup }) {
    if (!EDIT_TOOLS.includes(tool)) throw new Error('Unknown tool.');
    if (!String(sentence || '').trim()) throw new Error('No sentence to work on.');
    const srcBlock = (tool === 'cases' || tool === 'references' || tool === 'strategies')
        ? `UPLOADED SOURCES:\n${sourcesForPrompt(sources, { perSource: 12000, total: 30000 })}` : '';
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Pitch it at their level.` : '';
    const system = withMission(`You are Q in the EDITING stage. The student has one sentence highlighted on their page and pressed a tool button. Give ONLY the help that tool gives, in the shape below, so THEY can rewrite the sentence themselves.
${TOOL_BRIEFS[tool]}
${ageHint}
Rules: plain everyday British English; short; never a rewritten version of their sentence; never reveal the target.

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 4000)}
${targetForPrompt(brief, essay, brickId)}`);
    const user = `THE HIGHLIGHTED SENTENCE: "${String(sentence).slice(0, 600)}"${word ? `\nTHE WORD THEY PICKED: "${String(word).slice(0, 60)}"` : ''}\n${srcBlock}\n\nGive the ${tool} help.`;
    const r = await callAccurate(system, user, { maxTokens: 1200, schema: TOOL_SCHEMA, effort: 'low' });
    if (!r || typeof r !== 'object' || !String(r.headline || '').trim()) throw new Error('The tool came back empty — try again.');
    return {
        tool,
        headline: String(r.headline).trim(),
        points: (Array.isArray(r.points) ? r.points : []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
        example: r.example ? String(r.example).trim() : null,
        nudge: String(r.nudge || 'Now say your sentence using it.').trim(),
        fromSource: r.fromSource ? String(r.fromSource).slice(0, 160) : null,
        flagged: !!r.flagged,
    };
}

// ── The check: their rewritten sentence against the brick. A closeness cue,
// never the target text.
const CHECK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['closeness', 'hint', 'termsUsed', 'requirementsMet'],
    properties: {
        termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of the EXPECTED TERMS listed, the ones this sentence now uses correctly (exact term as listed). Empty if none listed / none used.' },
        requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of the REQUIREMENTS listed, the kinds this sentence now satisfies (e.g. "figure" when it gives a number, "reference" when it cites a source). Empty if none.' },
        closeness: { type: 'string', enum: ['match', 'closer', 'missing'], description: 'match = the sentence now voices the brick (idea named, point made); closer = moved toward it but not there; missing = the key thing is still absent.' },
        hint: { type: 'string', description: 'For "match": a warm one-liner ("That\'s it — next."). For "closer" / "missing": ONE plain line on the one thing still missing, as a steer — never the sentence, never the term itself if terminology is the gap (point at it: "name the idea about how pay motivates people").' },
    },
};
async function checkSentence({ sentence, brickId, brief, essay, plan }) {
    if (!String(sentence || '').trim()) throw new Error('No sentence to check.');
    const system = withMission(`You are Q in the EDITING stage. The student rewrote the highlighted sentence. Compare it to the target brick and answer with a closeness cue only.
Rules: judge the IDEA — is the brick's point now made in their own words (the concept named, the example given, the reason shown)? Not spelling, not style. Never quote or paraphrase the target. Warm, short, steering. Also report which of the expected terms the sentence now uses correctly and which requirements it now satisfies.

${targetForPrompt(brief, essay, brickId)}
${expectationsForPrompt(plan)}`);
    const user = `THEIR SENTENCE NOW: "${String(sentence).slice(0, 800)}"\n\nHow close is it?`;
    const r = await callAccurate(system, user, { maxTokens: 400, schema: CHECK_SCHEMA, effort: 'low' });
    const closeness = ['match', 'closer', 'missing'].includes(r && r.closeness) ? r.closeness : 'closer';
    const terms = new Set((plan && plan.expectedTerms || []).map(x => x.toLowerCase()));
    const kinds = new Set((plan && plan.requirements || []).map(x => x.kind));
    return {
        closeness, hint: String((r && r.hint) || (closeness === 'match' ? 'That\'s it — next.' : 'Closer.')).trim(),
        termsUsed: (r && Array.isArray(r.termsUsed) ? r.termsUsed : []).map(String).filter(x => terms.has(x.toLowerCase())),
        requirementsMet: (r && Array.isArray(r.requirementsMet) ? r.requirementsMet : []).map(String).filter(x => kinds.has(x)),
    };
}

// ── The visible match score: how much of the hidden essay is voiced / close,
// per criterion and overall. From brick bookkeeping (voiced = full, close =
// half) — never from text similarity, never revealing the target. Without an
// essay yet, from the coverage tally.
function matchScore(essay, voiced, close, coverage, brief) {
    const bricks = allBrickIds(essay);
    const per = {};
    if (bricks.length) {
        const v = new Set(Array.isArray(voiced) ? voiced : []);
        const c = new Set((Array.isArray(close) ? close : []).filter(id => !v.has(id)));
        const tally = {};
        let sumScore = 0, sumTotal = 0;
        for (const b of bricks) {
            const t = tally[b.criterionId] || (tally[b.criterionId] = { score: 0, total: 0 });
            t.total++; sumTotal++;
            if (v.has(b.brickId)) { t.score += 1; sumScore += 1; }
            else if (c.has(b.brickId)) { t.score += 0.5; sumScore += 0.5; }
        }
        for (const [cid, t] of Object.entries(tally)) per[cid] = Math.round(100 * t.score / t.total);
        return { overall: sumTotal ? Math.round(100 * sumScore / sumTotal) : 0, perCriterion: per, basis: 'bricks' };
    }
    const crit = (brief && Array.isArray(brief.criteria) ? brief.criteria : []).map(c => c.id);
    const cov = coverage || {};
    let sum = 0;
    for (const id of crit) { const p = cov[id] === 'covered' ? 100 : cov[id] === 'partial' ? 50 : 0; per[id] = p; sum += p; }
    return { overall: crit.length ? Math.round(sum / crit.length) : 0, perCriterion: per, basis: 'coverage' };
}


// ─── SCAFFOLDED COACHING (Sarah, 15 Aug 2026 late) — the PART PLAN ────────
// "I still have no idea what we are talking about… I would have said 'list
// your company's benefits'… 'now tell me where your salary sits and where it
// should be'… he'd highlight your benefits on the list and say the pink are
// flexi, the blue are fixed… 'what are the pros of your summer party being a
// fixed benefit?'… 'what are the cons?'" So: ONE plan per part (criterion),
// made once from the hidden essay's bricks and cached in the notebook. It
// frames the job in role terms and lays out 3-6 SCAFFOLD steps — a list, a
// numbers table, tagging, pros/cons per item, argue one side, switch sides,
// recommend — each ONE concrete ask. The page drives the steps
// deterministically; the model is called only to make the plan, to tag the
// student's items, and to check an argue/switch answer.
const STEP_KINDS = ['list', 'numbers', 'tag', 'proscons', 'argue', 'switch', 'recommend', 'ask', 'teach'];
const TAG_COLOURS = ['pink', 'blue', 'green', 'amber', 'purple', 'teal'];
// ── EXPECTATIONS (Sarah, 15 Aug: "he should have broken the brief down to as
// minimalistic as he could… then a list of words expected in the paragraph —
// as BUTTONS… it goes GREEN if it fits… if there should be a citation,
// reference, case study, whatever Q expects, a COLOURED DOT with a key").
// Generated WITH the plan (one call), per part: the minimal ask, the expected
// terms, the requirements (each a coloured dot on the board and the page).
const PLAN_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['role', 'steps', 'minimalAsk', 'expectedTerms', 'requirements'],
    properties: {
        minimalAsk: { type: 'string', description: 'The brief for this part broken down as MINIMALLY as possible, one plain line to the student: "This question wants you to show the pros and cons of company benefits." Never the brief\'s own words.' },
        expectedTerms: { type: 'array', items: { type: 'string' }, description: '6 to 12 words or short phrases the marker expects to SEE in this paragraph — the terms, theory names, key nouns from your model answer (e.g. "reward package", "market rate", "flexible benefits", "retention", "equity theory"). Each 1-4 words. These become buttons the student presses to drop the word into their sentence.' },
        requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'label'], properties: { kind: { type: 'string', enum: REQ_KINDS }, label: { type: 'string', description: 'What exactly, plainly: "a figure for the pay gap", "a reference for the retention claim", "the case study company", "the theory named".' } } }, description: 'What this paragraph must CONTAIN beyond words — each becomes a coloured dot the student can see: citation, reference, case-study, figure, theory, example, recommendation. 1 to 5. Empty if none.' },
        role: { type: 'string', description: 'ONE plain sentence framing the job of this part in role terms, spoken to the student — "Here you\'re the critic: judge whether the company\'s rewards actually work, then say how you\'d fix them" / "Here you\'re the adviser: choose fixed-for-all vs pick-your-own benefits and defend it". Never brief jargon; never "discuss"/"critically evaluate".' },
        steps: {
            type: 'array',
            description: '3 to 6 scaffold steps in order. Together they must pull EVERY brick of this part out of the student in their own words.',
            items: {
                type: 'object', additionalProperties: false,
                required: ['id', 'kind', 'prompt', 'targetBrickIds', 'itemHint', 'rows', 'tags', 'itemsFrom', 'side', 'hint', 'lesson', 'example', 'term', 'supply', 'thenAsk'],
                properties: {
                    id: { type: 'string', description: 'Short id, "s1", "s2"…' },
                    kind: { type: 'string', enum: STEP_KINDS },
                    prompt: { type: 'string', description: 'The ONE concrete ask, plain everyday British English, 35 words or fewer. list: "List every benefit your company gives you — one per line." numbers: "Put a number on each: what it is now, what it should be." tag: what the colours will mean, one line. proscons: "One good thing and one bad thing about each." argue: "Argue that…, as if you mean it." switch: "Now argue the other side…" recommend: "Which wins, and why?"' },
                    targetBrickIds: { type: 'array', items: { type: 'string' }, description: 'The brick ids of this part that this step voices when filled. Every brick of the part must appear in at least one step.' },
                    itemHint: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'list only: a 3-6 word placeholder for one item, e.g. "e.g. summer party".' },
                    rows: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'isPrompt', 'shouldPrompt'], properties: { label: { type: 'string' }, isPrompt: { type: 'string', description: 'The ask for the "is" cell, e.g. "what you get now"' }, shouldPrompt: { type: 'string', description: 'The ask for the "should be" cell, e.g. "what it should be"' } } }, description: 'numbers only: 2-5 rows. Empty array otherwise.' },
                    tags: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'colour', 'meaning'], properties: { name: { type: 'string' }, colour: { type: 'string', enum: TAG_COLOURS }, meaning: { type: 'string', description: 'Plain one-line meaning, e.g. "you choose it yourself"' } } }, description: 'tag only: 2-4 tags. Empty array otherwise.' },
                    itemsFrom: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'tag / proscons: the id of the list step whose items this works on.' },
                    side: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'argue / switch: the side to argue, plainly, e.g. "the company should let people pick their own benefits".' },
                    hint: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'recommend / ask: one plain line on what a full answer covers — never the answer.' },
                    lesson: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'teach only: the mini-lesson in Q\'s voice — 2 to 4 plain sentences that TEACH the concept the next step needs (what it is, how it works, why it matters). The term named once. Never the model answer\'s text.' },
                    example: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'teach only: ONE everyday, concrete example — NHS pay bands, a shop, a football team, a family — that makes the concept obvious.' },
                    term: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'teach only: the term being taught, e.g. "incremental pay scale", "cafeteria benefits", "equity theory".' },
                    supply: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'ask / argue / switch / recommend / list: ASSUME THEY DO NOT KNOW. When this brick carries knowledge — a term, a fact or figure, a theory, an argument, a line of reasoning, why this point comes here — the plain statement Q gives FIRST, before the ask (one to three sentences): "Equity theory says people compare their pay with others\' and feel it when it is unfair." / "One strong criticism of yearly pay steps is that the brilliant and the coasting rise at the same speed." null ONLY for a brick that is pure opinion / experience.' },
                    thenAsk: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'For a BIGGER brick (an argument, a line of reasoning): after supply and the prompt ("which side of that do you see at your place?"), the final sentence request — "Now say it as your own sentence for the essay." null when the prompt itself asks for the sentence.' },
                },
            },
        },
    },
};

function bricksOfCriterion(essay, criterionId) {
    const c = essay && Array.isArray(essay.perCriterion) ? essay.perCriterion.find(x => x.criterionId === criterionId) : null;
    return c ? c.paragraphs : [];
}

/**
 * planPart — the ONE plan for a criterion, from the hidden essay's bricks.
 * Server-side; cached by the caller. Returns { criterionId, role, steps }.
 */
async function planPart({ brief, essay, criterionId, yearGroup, relateAnchor }) {
    if (!brief || !Array.isArray(brief.criteria)) throw new Error('No brief yet — upload the task first.');
    const crit = brief.criteria.find(c => c.id === criterionId);
    if (!crit) throw new Error('That part is not in the brief.');
    const bricks = bricksOfCriterion(essay, criterionId);
    if (!bricks.length) throw new Error('The model answer for this part is not written yet — a moment.');
    const idx = brief.criteria.findIndex(c => c.id === criterionId);
    const evaluative = /evaluat|critic|assess|judge|justify|argu|compare|extent|effective|recommend/i.test(crit.text || '');
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Pitch every ask at their level.` : '';
    const relateHint = relateAnchor ? `Their world: "${relateAnchor}". Use it for examples when it helps.` : '';
    const system = withMission(`You are Q, planning how to coach ONE PART of the assignment. The student has not read the brief. You will not ask them open "do you think…?" questions on top of each other; you will give them SCAFFOLDS to fill, one concrete thing at a time, so that by the end of the steps they have said — in their own words — every brick of your model answer for this part.

THE PLAN
- "role": ONE plain sentence framing the job in role terms so they never wonder whether they are describing, judging or redesigning. Say it to them: "Here you're the critic: …" / "Here you're the adviser: …" / "Here you're the reporter: …".
- "steps": 3-8 steps in the order a real tutor would run them. The SPINE is the brick loop: every brick — a term, a fact, a theory, an argument, a paragraph's line of reasoning, the structure — gets drawn out in turn (supply the idea plainly → ask for their sentence saying it, anchored in their world → bigger bricks take 2-3 asks). Group bricks the way the essay's paragraphs run. Lists, numbers, tags and pros/cons are helpers where they genuinely fit (a package to list, figures to put down, items to sort), never the spine for its own sake. Kinds:
    list      — they build a list, one item per line (a company's benefits, the things that attract people, the costs…). itemHint = a short example placeholder.
    numbers   — a small table: for each row, what it IS now and what it SHOULD be (salary 30k → 45k; bonus 3k → 5k). rows = the row labels and the two cell asks.
    tag       — YOU sort their list into 2-4 tags with colours (this runs AUTOMATICALLY the moment their list is done — no ask to the student, never "which are flexi?"; the coloured board + legend teaches it). prompt = the one legend line you say ("The pink ones you pick yourself — flexible; the blue ones everyone gets — fixed."). itemsFrom = the list step id. tags = name/colour/meaning, in everyday words ("pink = the company gives everyone the same; blue = you get to choose").
    proscons  — for each tagged item: one good thing, then one bad thing. itemsFrom = the tag (or list) step id.
    argue     — get them arguing ONE side with feeling. side = the side, plainly.
    switch    — flip them to the OTHER side. side = the other side.
    recommend — which wins and why / what they would do. hint = what a full answer covers, never the answer.
    ask       — THE BRICK LOOP unit (the spine of the plan): ONE brick, whatever its size — a term, a fact, a theory, an ARGUMENT, a line of reasoning, why this point comes next. ASSUME THEY DO NOT KNOW: supply = the idea stated plainly first ("Plants use the sun to grow — that's called photosynthesis." / "One strong criticism of yearly pay steps is that the brilliant and the coasting rise at the same speed."), prompt = the ask for their sentence(s) saying it, anchored in their company / experience ("Could you write a sentence about when you enjoyed learning about this?" / "Which side of that do you see at your place?"), thenAsk = for a bigger brick, the final "now say it as your own sentence". supply is null only for a brick that is pure opinion / experience ("What colour is the sky?"). Their sentences land on the page; nothing Q said does.
    teach     — TEACH-THEN-APPLY (Sarah, 15 Aug: "bear in mind I don't know the answer. No matter how many questions and hints, it is not going to teach me"). Whenever the NEXT step's ask needs a concept, theory or term the student has not shown they know (incremental scales, cafeteria / flexible benefits, contingent reward, equity theory, total reward, market rate…), put a teach step BEFORE it: lesson = 2-4 plain sentences in your voice that actually teach it; example = one everyday concrete example; term = the term, named once; prompt = one line saying what you are about to teach and why ("Before you weigh this up, one idea you need: how pay ladders work."). Then the apply step asks them to USE it on their company. Never ask → hint → ask again about something never taught. Hints are only for nudging something already taught or said.
- ${evaluative ? 'THIS PART IS EVALUATIVE (the marker wants judgement): the steps MUST end with argue → switch → recommend, so the critical evaluation comes out of them as a debate they had with themselves.' : 'If the part asks for judgement, finish with argue → switch → recommend; if it only asks for description or explanation, list / numbers / tag / proscons / ask are enough.'}
- EXPECTATIONS (Sarah): "minimalAsk" — the brief for this part broken down as minimally as you can, one plain line ("This question wants you to show the pros and cons of company benefits."). "expectedTerms" — 6-12 words / short phrases the marker expects to see in this paragraph (the terms, theory names, key nouns of your model answer) — they become buttons the student presses to drop the word into their sentence, and go green when the word fits. "requirements" — what the paragraph must CONTAIN beyond words (a citation, a reference, a case study, a figure, a theory named, an example, a recommendation) — each becomes a coloured dot the student can see, with a key, so they know when they edit that it has to be there.
- Every brick of this part appears in at least one step's targetBrickIds. Every prompt is ONE concrete ask, 35 words or fewer, in plain everyday British English.
- Q FORMATS, THEY WRITE: whenever the student gives raw material (a list, numbers, an example, a story), Q's job is to ANALYSE it visibly on the board — coloured groups with a legend, the numbers with the gap drawn, the two sides of an argument in colour, the pros/cons grid laid out — and then ask for sentences OFF that structure ("look at the pink ones — why would a company give those to everyone? Write me a sentence."; "your salary sits 15k under — what does that do to how you feel on a Monday?"). Never quiz them on the categorisation. Later steps' prompts refer to the coloured groups / the gap by name.
- ${PLAIN_QUESTION_RULE}
${ageHint}
${relateHint}

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 5000)}`);
    const user = `THE PART TO PLAN — part ${idx + 1} of ${brief.criteria.length}: [${crit.id}] "${crit.label || ''}" — ${crit.text}

THE BRICKS OF YOUR MODEL ANSWER FOR THIS PART (Q's eyes only — the steps must draw each one out of the student):
${bricks.map(b => `(${b.brickId}) ${b.gist}\n    ${String(b.text || '').slice(0, 700)}`).join('\n')}

Make the plan.`;
    const r = await callAccurate(system, user, { maxTokens: 2500, schema: PLAN_SCHEMA, effort: 'low' });
    return normalisePlan(r, criterionId, bricks);
}

function normalisePlan(r, criterionId, bricks) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.steps) || !r.steps.length) throw new Error('The plan came back empty — try again.');
    const brickIds = new Set((bricks || []).map(b => b.brickId));
    const seen = new Set();
    const steps = r.steps.map((s, i) => {
        let id = String(s.id || ('s' + (i + 1))).replace(/\s+/g, '') || ('s' + (i + 1));
        while (seen.has(id)) id = id + '_' + i;
        seen.add(id);
        const kind = STEP_KINDS.includes(s.kind) ? s.kind : 'ask';
        return {
            id, kind,
            prompt: String(s.prompt || '').trim(),
            targetBrickIds: (Array.isArray(s.targetBrickIds) ? s.targetBrickIds : []).map(x => String(x).replace(/\s+/g, '')).filter(x => brickIds.has(x)),
            itemHint: kind === 'list' && s.itemHint ? String(s.itemHint).slice(0, 60) : null,
            rows: kind === 'numbers' ? (Array.isArray(s.rows) ? s.rows : []).map(row => ({ label: String(row.label || '').trim(), isPrompt: String(row.isPrompt || 'what it is now').trim(), shouldPrompt: String(row.shouldPrompt || 'what it should be').trim() })).filter(row => row.label).slice(0, 6) : [],
            tags: kind === 'tag' ? (Array.isArray(s.tags) ? s.tags : []).map((t, k) => ({ name: String(t.name || '').trim(), colour: TAG_COLOURS.includes(t.colour) ? t.colour : TAG_COLOURS[k % TAG_COLOURS.length], meaning: String(t.meaning || '').trim() })).filter(t => t.name).slice(0, 4) : [],
            itemsFrom: (kind === 'tag' || kind === 'proscons') && s.itemsFrom ? String(s.itemsFrom).replace(/\s+/g, '') : null,
            side: (kind === 'argue' || kind === 'switch') && s.side ? String(s.side).trim() : null,
            hint: s.hint ? String(s.hint).trim() : null,
            supply: ['ask', 'argue', 'switch', 'recommend', 'list'].includes(kind) && s.supply ? String(s.supply).trim() : null,
            thenAsk: ['ask', 'argue', 'switch', 'recommend', 'list'].includes(kind) && s.supply && s.thenAsk ? String(s.thenAsk).trim() : null,
            lesson: kind === 'teach' && s.lesson ? String(s.lesson).trim() : null,
            example: kind === 'teach' && s.example ? String(s.example).trim() : null,
            term: kind === 'teach' && s.term ? String(s.term).trim() : null,
        };
    }).filter(s => s.prompt && !(s.kind === 'teach' && !s.lesson));
    if (!steps.length) throw new Error('The plan had no usable steps — try again.');
    // A numbers step with no rows becomes a plain ask; a tag/proscons step
    // must point at an earlier list-ish step (else the nearest one before it).
    const ids = steps.map(s => s.id);
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.kind === 'numbers' && !s.rows.length) s.kind = 'ask';
        if (s.kind === 'tag' && s.tags.length < 2) s.kind = 'ask';
        if ((s.kind === 'tag' || s.kind === 'proscons') && (!s.itemsFrom || !ids.slice(0, i).includes(s.itemsFrom))) {
            const prev = steps.slice(0, i).reverse().find(x => x.kind === 'list' || (s.kind === 'proscons' && x.kind === 'tag'));
            s.itemsFrom = prev ? prev.id : null;
            if (!s.itemsFrom) s.kind = 'ask';
        }
    }
    // Any brick no step voices → the last step carries it (nothing is lost).
    const covered = new Set(steps.flatMap(s => s.targetBrickIds));
    for (const b of brickIds) if (!covered.has(b)) steps[steps.length - 1].targetBrickIds.push(b);
    // Expectations: terms (deduped, short), requirements (real kinds, coloured server-side).
    const seenT = new Set();
    const expectedTerms = (Array.isArray(r.expectedTerms) ? r.expectedTerms : []).map(x => String(x || '').replace(/\s+/g, ' ').trim().replace(/[.:;,]+$/, '')).filter(x => x && x.length <= 40 && !seenT.has(x.toLowerCase()) && seenT.add(x.toLowerCase())).slice(0, 12);
    const seenR = new Set();
    const requirements = (Array.isArray(r.requirements) ? r.requirements : []).map(x => ({ kind: String(x.kind || ''), label: String(x.label || '').trim() })).filter(x => REQ_KINDS.includes(x.kind) && !seenR.has(x.kind) && seenR.add(x.kind)).slice(0, 5).map(x => ({ ...x, label: x.label || REQ_LABELS[x.kind], colour: REQ_COLOURS[x.kind] }));
    return { criterionId, role: String(r.role || '').trim(), minimalAsk: String(r.minimalAsk || '').trim(), expectedTerms, requirements, steps, madeAt: Date.now() };
}

// The part's expectations (terms + requirements) for the check / mark prompts.
function expectationsForPrompt(plan) {
    if (!plan || (!(plan.expectedTerms || []).length && !(plan.requirements || []).length)) return '';
    const lines = ['WHAT THIS PART IS EXPECTED TO CONTAIN (report which are now met, by exact term / kind):'];
    if ((plan.expectedTerms || []).length) lines.push('  expected terms: ' + plan.expectedTerms.join(' | '));
    if ((plan.requirements || []).length) lines.push('  requirements: ' + plan.requirements.map(r => r.kind + ' (' + r.label + ')').join(' | '));
    return lines.join('\n');
}
// The plan + where they are, rendered for the probe / stuck prompts so a
// live probe asks for THIS step's thing, never a new open question.
function planForPrompt(plan, stepId) {
    if (!plan || !Array.isArray(plan.steps)) return '';
    const lines = [`THE PLAN FOR THIS PART (role: ${plan.role})`];
    plan.steps.forEach((s, i) => lines.push(`  ${s.id === stepId ? '→' : ' '} step ${i + 1} [${s.kind}] ${s.prompt}${s.side ? ` (side: ${s.side})` : ''}`));
    if (stepId) lines.push('The arrow marks the CURRENT step. Your question must ask for THIS step\'s thing (an item for the list, a number for the table, the pro or the con, the argument for the side named) — never a new open question, never a later step, never a different part.');
    return lines.join('\n');
}

// ── TAG: Q sorts the student's list into the plan's tags. One small call. ──
const TAG_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['tagged', 'line'],
    properties: {
        tagged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'tag'], properties: { item: { type: 'string', description: 'The student\'s item, verbatim.' }, tag: { type: 'string', description: 'One of the tag names given.' } } } },
        line: { type: 'string', description: 'ONE plain line to the student saying what the colours mean, e.g. "The pink ones you chose yourself — flexible; the blue ones everyone gets — fixed."' },
    },
};
async function tagItems({ brief, plan, step, items }) {
    if (!step || step.kind !== 'tag' || !Array.isArray(step.tags) || step.tags.length < 2) throw new Error('This step does not tag.');
    const list = (Array.isArray(items) ? items : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 40);
    if (!list.length) throw new Error('There is nothing on the list to sort yet.');
    const system = withMission(`You are Q, sorting the student's own list into tags on the teaching board (the step: "${step.prompt}"). Use ONLY these tags:
${step.tags.map(t => `- ${t.name} (${t.colour}) — ${t.meaning}`).join('\n')}
Every item gets exactly one tag. Keep each item verbatim. Then ONE plain line telling the student what the colours mean, in everyday words, naming the term once if you are teaching it.
${PLAIN_QUESTION_RULE}

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 2500)}`);
    const user = `THE STUDENT'S LIST:\n${list.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nSort it.`;
    const r = await callAccurate(system, user, { maxTokens: 800, schema: TAG_SCHEMA, effort: 'low' });
    const names = new Set(step.tags.map(t => t.name));
    const byItem = new Map();
    for (const t of (r && Array.isArray(r.tagged) ? r.tagged : [])) {
        const item = String(t.item || '').trim();
        if (item && names.has(t.tag)) byItem.set(item.toLowerCase(), t.tag);
    }
    // Every item comes back tagged — unmatched ones take the first tag, flagged.
    const tagged = list.map(item => ({ item, tag: byItem.get(item.toLowerCase()) || step.tags[0].name, guessed: !byItem.has(item.toLowerCase()) }));
    return { tagged, line: String((r && r.line) || '').trim() || step.prompt, tags: step.tags };
}

// ── CHECK an argue / switch / recommend / ask answer against the step's
// bricks: which are now voiced, and ONE follow-up ask if the step is not
// yet filled. Never the answer.
const STEP_CHECK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['voicedBrickIds', 'filled', 'ack', 'followUp', 'supply', 'thenAsk', 'termsUsed', 'requirementsMet'],
    properties: {
        termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of the EXPECTED TERMS listed, the ones the answer now uses correctly (exact term as listed). Empty if none.' },
        requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of the REQUIREMENTS listed, the kinds the answer now satisfies. Empty if none.' },
        supply: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'THE BRICK LOOP: if the step is not filled and the brick carries knowledge the answer does not yet have — a term, a fact or figure, a theory, the argument itself, the reasoning — STATE IT PLAINLY here in one to three sentences (assume they do not know; a fact given, never a hint), then thenAsk asks for their sentence saying it. null when the missing piece is their own view / example.' },
        thenAsk: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'With supply: the sentence request that follows — "Could you write a sentence about how that works at your company?". null otherwise.' },
        voicedBrickIds: { type: 'array', items: { type: 'string' }, description: 'The step\'s brick ids the student has now voiced in their own words (the point made, not the wording).' },
        filled: { type: 'boolean', description: 'true when the step is done well enough to move on — the side argued with a real reason and an example, or the recommendation made with a why.' },
        ack: { type: 'string', description: 'ONE short warm line back to them — coach voice ("Good — that\'s a real reason."). Never a rewritten sentence.' },
        followUp: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'If not filled: ONE concrete ask for the missing piece of THIS step (an example, the reason, the other point) — 30 words or fewer, plain. null when filled.' },
    },
};
async function checkStep({ brief, essay, plan, step, answer, earlierAnswers }) {
    if (!step) throw new Error('No step to check.');
    if (!String(answer || '').trim()) throw new Error('Nothing to check yet.');
    const bricks = (step.targetBrickIds || []).map(id => brickById(essay, id)).filter(Boolean);
    const system = withMission(`You are Q, checking the student's answer to ONE scaffold step against the bricks it is meant to draw out. Judge the IDEA (the point made in their own words), not the wording. If the step is filled, say so warmly. If not: ASSUME THEY DO NOT KNOW — when the brick carries knowledge their answer lacks (a term, a fact, a theory, the argument, the reasoning), SUPPLY it plainly ("supply") and ask for their sentence saying it ("thenAsk") — never a hint; when the missing piece is their own view / example, ask for that ONE thing ("followUp") — never a new open question, never the next step, never the answer.
${PLAIN_QUESTION_RULE}
${planForPrompt(plan, step.id)}
${expectationsForPrompt(plan)}

THE BRICKS THIS STEP DRAWS OUT (Q's eyes only — never quote or paraphrase them):
${bricks.length ? bricks.map(b => `(${b.brickId}) ${b.gist}\n    ${String(b.text || '').slice(0, 600)}`).join('\n') : '(no bricks tied to this step — judge whether the ask itself is answered fully)'}`);
    const user = `THE STEP: [${step.kind}] ${step.prompt}${step.side ? `\nTHE SIDE: ${step.side}` : ''}
${earlierAnswers ? `WHAT THEY SAID EARLIER IN THIS STEP:\n${String(earlierAnswers).slice(0, 1500)}\n` : ''}
THEIR ANSWER NOW:
${String(answer).slice(0, 2500)}

Which bricks are voiced, is the step filled, and what is the one thing to ask if not?`;
    const r = await callAccurate(system, user, { maxTokens: 700, schema: STEP_CHECK_SCHEMA, effort: 'low' });
    const allowed = new Set(step.targetBrickIds || []);
    const supply = r && r.supply && !r.filled ? String(r.supply).trim() : null;
    const terms = new Set((plan && plan.expectedTerms || []).map(x => x.toLowerCase()));
    const kinds = new Set((plan && plan.requirements || []).map(x => x.kind));
    return {
        termsUsed: (r && Array.isArray(r.termsUsed) ? r.termsUsed : []).map(String).filter(x => terms.has(x.toLowerCase())),
        requirementsMet: (r && Array.isArray(r.requirementsMet) ? r.requirementsMet : []).map(String).filter(x => kinds.has(x)),
        voicedBrickIds: (r && Array.isArray(r.voicedBrickIds) ? r.voicedBrickIds : []).map(x => String(x).replace(/\s+/g, '')).filter(x => allowed.has(x)),
        filled: !!(r && r.filled),
        ack: String((r && r.ack) || '').trim(),
        supply,
        thenAsk: supply && r.thenAsk ? String(r.thenAsk).trim() : null,
        followUp: r && !r.filled ? String((supply && r.thenAsk) || r.followUp || '').trim() || null : null,
    };
}

// ── TEACH on demand: "I don't understand" / "I'm stuck" on ANY ask → a
// mini-lesson for the concept the ask needs (2-4 plain sentences + one
// everyday example + the term once) and the same ask re-put as an APPLY
// question — not a rephrase, not another hint. The lesson never goes on
// the page; the student's apply-answer does.
const TEACH_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['term', 'lesson', 'example', 'applyAsk', 'searchTerms'],
    properties: {
        term: { type: 'string', description: 'The concept / term the ask depends on, named once, e.g. "incremental pay scale".' },
        lesson: { type: 'string', description: '2 to 4 plain sentences in Q\'s voice that TEACH it — what it is, how it works, why it matters here. Never the model answer\'s text, never what to write.' },
        example: { type: 'string', description: 'ONE everyday, concrete example (NHS bands, a shop, a football team, a family budget) that makes it obvious.' },
        applyAsk: { type: 'string', description: 'The same ask, re-put as an APPLY question using what was just taught — "So in your company, who wins and who loses under that ladder?" One question, 35 words or fewer, plain.' },
        searchTerms: { type: 'array', items: { type: 'string' }, description: 'Two or three search phrases for a video / page that explains this concept simply.' },
    },
};
async function teachFor({ brief, essay, plan, step, question, yearGroup, relateAnchor }) {
    const ask = String(question || (step && step.prompt) || '').trim();
    if (!ask) throw new Error('Nothing to teach yet — there is no question on the go.');
    const bricks = step && essay ? (step.targetBrickIds || []).map(id => brickById(essay, id)).filter(Boolean) : [];
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Pitch the lesson at their level.` : '';
    const relateHint = relateAnchor ? `Their world: "${relateAnchor}". Use it for the example if it fits.` : '';
    const system = withMission(`You are Q. The student pressed "I don't understand" / "I'm stuck" on your ask. They do not know the answer and more questions or hints will not teach them. TEACH the concept the ask depends on — a mini-lesson in your voice, 2-4 plain sentences, one everyday concrete example, the term named once — then re-put the ask as an APPLY question they can now answer about their own company / situation. Never a rephrase, never another hint, never the model answer's words.
${PLAIN_QUESTION_RULE}
${ageHint}
${relateHint}
${plan ? planForPrompt(plan, step ? step.id : null) : ''}

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 4000)}
${bricks.length ? 'THE BRICKS THE ASK IS FISHING FOR (Q\'s eyes only — teach the concept, never these words):\n' + bricks.map(b => `(${b.brickId}) ${b.gist}\n    ${String(b.text || '').slice(0, 500)}`).join('\n') : ''}`);
    const user = `THE ASK THEY DID NOT UNDERSTAND: "${ask.slice(0, 500)}"\n\nTeach the concept it needs, then re-put the ask as an apply question.`;
    const r = await callAccurate(system, user, { maxTokens: 900, schema: TEACH_SCHEMA, effort: 'low' });
    if (!r || !String(r.lesson || '').trim()) throw new Error('The lesson came back empty — try again.');
    return {
        term: String(r.term || '').trim(),
        lesson: String(r.lesson).trim(),
        example: String(r.example || '').trim(),
        applyAsk: String(r.applyAsk || ask).trim(),
        searchTerms: (Array.isArray(r.searchTerms) ? r.searchTerms : []).map(String).filter(Boolean).slice(0, 3),
    };
}

// ── PLAIN LABELS for briefs saved before criteria[].label existed (Sarah,
// live: the strip showed "Critically evaluate the effectiveness"). ONE tiny
// call relabels every criterion at once.
const LABELS_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['labels'],
    properties: { labels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string', description: 'A plain-words nickname, 4 words or fewer, everyday English a student who has never seen the brief understands — "What attracts people", "Pay and perks", "How to measure it". Never the AC code, never the brief\'s verbs (evaluate, discuss, analyse).' } } } } },
};
function labelLooksGenerated(c) {
    const l = String((c && c.label) || '').replace(/\s+/g, ' ').trim();
    if (!l) return true;
    const first = plainLabel('', c.text || '');
    if (l.toLowerCase() === first.toLowerCase()) return true;
    return /^(critically |)(evaluate|discuss|analyse|analyze|assess|explain|describe|examine|justify|compare|outline|identify)\b/i.test(l);
}
async function relabelCriteria({ brief }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet.');
    const system = withHouseStyle(`You give each assessment criterion a plain-words nickname (4 words or fewer) that a student who has never read the brief understands at a glance — the THING it is about, in everyday words: "Pay and perks", "What attracts people", "Fixed or pick-your-own", "How to measure it". Never the AC code, never the brief's verbs (evaluate, discuss, analyse, assess), never jargon.`);
    const user = `CRITERIA:\n${brief.criteria.map(c => `- [${c.id}] ${c.text}`).join('\n')}\n\nGive every one a nickname.`;
    const r = await callAccurate(system, user, { maxTokens: 600, schema: LABELS_SCHEMA, effort: 'low' });
    const byId = new Map((r && Array.isArray(r.labels) ? r.labels : []).map(x => [String(x.id || '').replace(/\s+/g, ''), plainLabel(x.label, '')]));
    return brief.criteria.map(c => ({ id: c.id, label: byId.get(c.id) || c.label || plainLabel('', c.text) }));
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
    // scaffolded coaching + mark & fix (Q's strings only — never the student's items / answers)
    'role', 'prompt', 'lesson', 'term', 'applyAsk', 'line', 'meaning', 'ack', 'followUp', 'answer', 'missing', 'fix', 'headline', 'points', 'nudge', 'itemHint', 'isPrompt', 'shouldPrompt', 'side', 'supply', 'thenAsk', 'minimalAsk',
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
    TUTOR_MISSION, WHY_THE_GAME, GAME_RULE, COACH_VOICE, MISSION_BLOCK, withMission, BRICK_LOOP_RULE,
    toolHelp, checkSentence, matchScore, EDIT_TOOLS, TOOL_SCHEMA, CHECK_SCHEMA,
    planPart, normalisePlan, planForPrompt, tagItems, checkStep, brickById, bricksOfCriterion,
    PLAN_SCHEMA, TAG_SCHEMA, STEP_CHECK_SCHEMA, STEP_KINDS, TAG_COLOURS,
    teachFor, relabelCriteria, labelLooksGenerated, TEACH_SCHEMA, LABELS_SCHEMA,
    expectationsForPrompt, REQ_KINDS, REQ_COLOURS, REQ_LABELS,
    analyseTask, analyseAndBrief, nextQuestion, assembleDocument,
    analyseVoice, tutorBrief, askLeadingQuestion, reframeInVoice, suggestWordSwaps, writeStarter,
    formatHarvardRef, suggestReferences, referenceParagraph,
    explainConcept, markSection, improveSectionStep,
    // Phase 3 — the coach with the answer in his head
    probe, markLikeMarker, assembleFromDraft, userFacingCause, normaliseBrief, briefForPrompt,
    writeModelEssay, essayForPrompt, allBrickIds, coverageFromBricks, editPass, splitSentences,
    BRIEF_SCHEMA, PROBE_SCHEMA, MARK_SCHEMA, ASSEMBLE_SCHEMA, ESSAY_SCHEMA, EDIT_SCHEMA,
};
