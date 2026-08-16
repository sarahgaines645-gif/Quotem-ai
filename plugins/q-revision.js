/**
 * Q REVISION — exam question drill plugin.
 *
 * Takes a sixth-form student from ungraded to an A the only way that
 * actually works: real exam-style questions, marked strictly against a
 * proper mark scheme, over and over, biased towards whatever they are
 * weakest at. The page keeps score; this plugin keeps it honest.
 *
 * Two functions:
 *   generateQuestion({ subject, board, level, topic, askedSoFar, weakAreas })
 *     → { question, marks, markScheme, modelAnswer, topicTag, difficulty }
 *   markAnswer({ question, markScheme, modelAnswer, marks, answer, level })
 *     → { score, outOf, grade, feedback, missing, tip }
 *
 * Accuracy matters more than speed here — a wrong mark scheme teaches the
 * wrong thing. Every call goes to Claude first (accurateJSON) with Q as
 * the fallback, so revision degrades instead of dying.
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');
const { accurateJSON, claudeJSON, hasClaude, SONNET } = require('./q-claude');
const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');

async function callQ(systemPrompt, userPrompt, { maxTokens = 4096 } = {}) {
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
    }, { label: 'revision' });
    if (!response.ok) {
        const errText = await response.text();
        logUsage({ skill: 'revision', provider: 'together', model: Q_CONFIG.model, started, success: false, error: `HTTP ${response.status}` });
        throw new Error(`Q upstream ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    logUsage({ skill: 'revision', provider: 'together', model: Q_CONFIG.model, data, started });
    const raw = cleanModelOutput(data.choices?.[0]?.message?.content || '{}', 'revision');
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
}

// Exam-room calls run on SONNET (Sarah, 22 Jul: "opus is too much — use
// sonnet"). Still Claude, still marked strictly, ~2-4p per question+mark
// instead of 6-10p. Claude-ONLY either way: if Sonnet is unreachable the
// student sees "try again in a minute" — DeepSeek never marks anyone.
async function callAccurate(systemPrompt, userPrompt, opts = {}) {
    return accurateJSON(systemPrompt, userPrompt, {
        ...opts,
        model: SONNET,
        effort: 'medium',
        skill: 'revision',
    });
}

// ── Small helpers ─────────────────────────────────────────────────────────

function toInt(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

function asStringArray(v) {
    if (!Array.isArray(v)) return [];
    return v.map((s) => String(s || '').trim()).filter(Boolean);
}

// ── Generate one exam-style question ──────────────────────────────────────

// ── UK school stages ────────────────────────────────────────────────────
// A Year 4 child must get Year 4 questions — not GCSE questions with
// smaller numbers. The level string names the stage; this turns it into
// what the writer, the checker and the marker need to know: the child's
// age, the key stage, what the national curriculum for England covers at
// that year (and NOT later years), the national tests that shape the style,
// and how to write for that age. Sarah, 16 Aug: "put in primary school
// stages — whatever they will be studying at school in the UK."
const STAGES = {
    reception: { label: 'Reception (EYFS)', ages: '4–5', ks: 'Early Years Foundation Stage', tests: 'no formal tests — early learning goals: phonics, counting to 20, shapes, listening and talking' },
    1: { label: 'Year 1', ages: '5–6', ks: 'Key Stage 1', tests: 'the Year 1 phonics screening check (decoding real and made-up words); numbers to 100, adding and subtracting within 20' },
    2: { label: 'Year 2', ages: '6–7', ks: 'Key Stage 1', tests: 'end-of-KS1 teacher assessment (KS1 SATs are optional papers): reading, maths, spelling/punctuation/grammar' },
    3: { label: 'Year 3', ages: '7–8', ks: 'Key Stage 2 (lower)', tests: 'classroom assessment; times tables 3, 4, 8; column addition/subtraction; fractions as parts of a whole' },
    4: { label: 'Year 4', ages: '8–9', ks: 'Key Stage 2 (lower)', tests: 'the Year 4 multiplication tables check (all tables to 12×12, quick recall); numbers to 10,000; decimals to tenths and hundredths' },
    5: { label: 'Year 5', ages: '9–10', ks: 'Key Stage 2 (upper)', tests: 'classroom assessment; long multiplication, fractions/decimals/percentages, angles, roman numerals to 1000' },
    6: { label: 'Year 6', ages: '10–11', ks: 'Key Stage 2 (upper)', tests: 'the KS2 SATs in May: Reading paper; Maths Paper 1 (arithmetic) and Papers 2–3 (reasoning); English grammar, punctuation and spelling (GPS) papers' },
    7: { label: 'Year 7', ages: '11–12', ks: 'Key Stage 3', tests: 'classroom tests only; the KS3 programme of study, first year of secondary school' },
    8: { label: 'Year 8', ages: '12–13', ks: 'Key Stage 3', tests: 'classroom tests only; the KS3 programme of study' },
    9: { label: 'Year 9', ages: '13–14', ks: 'Key Stage 3', tests: 'classroom tests only; end of KS3, before GCSE courses begin — never GCSE-only content' },
};

function stageOf(level) {
    const l = String(level || '').toLowerCase();
    if (/reception|eyfs/.test(l)) return STAGES.reception;
    const m = l.match(/year\s*(\d{1,2})\b/);
    if (m && STAGES[m[1]]) return STAGES[m[1]];
    if (/\bks\s*1\b|key stage 1/.test(l)) return STAGES[2];
    if (/\bks\s*2\b|key stage 2/.test(l)) return STAGES[6];
    if (/\bks\s*3\b|key stage 3/.test(l)) return STAGES[9];
    return null;
}
function isSchoolStage(level) { return !!stageOf(level); }
function isPrimary(level) { const st = stageOf(level); return !!st && !/Key Stage 3/.test(st.ks); }

// The block every prompt gets when the level is a school stage. Empty
// string otherwise, so GCSE/A-Level prompts are byte-for-byte unchanged.
function stageRules(level, subject) {
    const st = stageOf(level);
    if (!st) return '';
    const primary = !/Key Stage 3/.test(st.ks);
    return `
THIS STUDENT IS A SCHOOL CHILD — ${st.label}, age ${st.ages}, ${st.ks}, national curriculum for England. Not an exam candidate.
- Test ONLY what the national curriculum programme of study covers by ${st.label} in ${subject || 'this subject'}. Nothing from later years. If unsure whether a child of ${st.ages} has met it, choose something you are sure they have.
- What shapes this year: ${st.tests}.
- Write for a ${st.ages}-year-old: short sentences, everyday words, one idea per question, numbers and situations a child that age meets (sweets, pets, the classroom, pocket money). Reading age must never be the barrier unless it is a reading question.
- Style like the classroom and the national tests for that year${primary ? ' (KS2 SATs style for maths reasoning, reading comprehension, and grammar/punctuation/spelling)' : ''}. Ask with "Which…", "What…", "How many…", "Choose the…", "Which word…" — never "Evaluate", "Analyse", "Discuss".
- Wrong options are the mistakes a child of this age REALLY makes (place-value slips, adding instead of multiplying, common misspellings, the confusable word) — never trick wording, never obviously silly.
- Warm and encouraging. ${primary ? 'One mark per question.' : 'One or two marks per question.'}
${primary ? '- Spelling in the child\'s answers: accept phonetic spelling where the meaning is clear, unless the question IS a spelling question.' : ''}`;
}

async function generateQuestion({ subject, board, level, topic, askedSoFar, weakAreas } = {}) {
    const boardLine = isSchoolStage(level)
        ? 'the national curriculum for England (no exam board at this stage)'
        : (board && board !== 'Other'
            ? board
            : 'a UK exam board (not specified — stay on content every board teaches)');

    const system = `You are a UK exam question writer and tutor. You write ONE exam-style revision question for a student, exactly as it would appear on a real paper, with the mark scheme a real examiner would mark it against.

Board: ${boardLine}
Level: ${level || 'A-Level'}
Subject: ${subject || 'General Studies'}
${stageRules(level, subject)}
Rules:
- ONE question only, using a realistic command word (State, Describe, Explain, Compare, Analyse, Evaluate). Match the marks to the command word: State/Describe 2-3, Explain 3-4, Compare/Analyse 4-6, Evaluate or extended response 6-12. Marks must be between 2 and 12.${isSchoolStage(level) ? ' FOR A SCHOOL CHILD: 1 to 3 marks, "What / Which / How many / Explain in one sentence" — never Evaluate/Analyse.' : ''}
- If a topic is given, stay on it. If not, pick a core topic every student of this subject at this level must know.
- If weak areas are listed, bias towards them — that is where this student's marks are hiding. Do not ONLY ask weak areas; roughly two in three questions should target them.
- NEVER repeat or closely rephrase anything in the already-asked list. A different topic or a genuinely different angle every time.
- Vary difficulty across a session: "foundation" eases them in, "standard" is exam-typical, "stretch" is top-band. Prefer "stretch" when revisiting a weak area they have started scoring on.

CRITICAL accuracy rules:
- Never invent specification codes, paper numbers, or fake past-paper references. No "(2019 Paper 2, Q4)" style tags — just the question.
- Only test content genuinely on this subject at this level. If you are not certain something is on the specification, choose something you are certain about instead.
- The mark scheme must contain ONLY genuinely creditable points — things a real examiner's scheme would award a mark for. No padding, no vague "shows understanding" points.
- The model answer must actually earn every mark on the scheme, written in plain student language — the way a strong student writes under exam conditions, not textbook-speak.

Return ONLY valid JSON:
- question (string): the full question text as it would appear on the paper
- marks (integer, 2-12)
- markScheme (array of strings): the creditable points, roughly one mark each
- modelAnswer (string): a full-mark answer in plain student language
- topicTag (string): short topic label, e.g. "Cell transport", "Weimar hyperinflation"
- difficulty (string): "foundation" | "standard" | "stretch"`;

    const asked = asStringArray(askedSoFar);
    const weak = asStringArray(weakAreas);

    const user = `SUBJECT: ${subject || 'not given'}
LEVEL: ${level || 'not given'}
TOPIC REQUESTED: ${topic && String(topic).trim() ? String(topic).trim() : '(none — pick a core topic)'}
WEAK AREAS (low scores so far): ${weak.length ? weak.join('; ') : '(none known yet)'}
ALREADY ASKED THIS SESSION (do not repeat any of these):
${asked.length ? asked.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(nothing yet — this is the first question)'}

Write the next question.`;

    const result = await callAccurate(system, user, { maxTokens: 1200 });

    // Normalise so the page can trust every field.
    const marks = clamp(toInt(result.marks, 4), 2, 12);
    const difficulty = ['foundation', 'standard', 'stretch'].includes(result.difficulty)
        ? result.difficulty
        : 'standard';
    return {
        question: String(result.question || '').trim(),
        marks,
        markScheme: asStringArray(result.markScheme),
        modelAnswer: String(result.modelAnswer || '').trim(),
        topicTag: String(result.topicTag || subject || 'General').trim(),
        difficulty,
    };
}

// ── Mark a student's answer strictly against the scheme ───────────────────

async function markAnswer({ question, markScheme, modelAnswer, marks, answer, level } = {}) {
    const outOf = clamp(toInt(marks, 4), 1, 20);

    const system = `You are a UK examiner marking one student answer strictly against the mark scheme.

Marking rules:
- Credit ONLY what earns a mark on the scheme. No sympathy marks, no marks for effort or length.
- DO credit valid alternative wording — if the student's phrasing means the same as a scheme point, it scores. Judge meaning, not word-matching.
- Irrelevant material earns nothing but loses nothing, unless it directly contradicts a correct point (a contradiction cancels that mark).
- The student is at ${level || 'A-Level'} — judge the answer at that standard, no higher.
${stageRules(level)}

Feedback rules — talk TO the student ("you"), never about them. Warm, specific, brief. A teacher handing the paper back, not a report:
- feedback: 2-3 sentences — what earned marks and the main thing that did not.
- missing: each mark-scheme point NOT credited, rephrased as what to add next time (start each with a verb: "Add...", "Name...", "Explain why...").
- tip: the single most impactful thing to do better next time — one concrete move ("Always give a number with 'increase'"), never "revise more".

Return ONLY valid JSON:
- score (integer, 0 to ${outOf})
- outOf (integer): ${outOf}
- grade (string): "red" if score is under 40%, "amber" for 40-70%, "green" above 70%
- feedback (string, 2-3 sentences)
- missing (array of strings)
- tip (string)`;

    const scheme = asStringArray(markScheme);
    const user = `THE QUESTION (${outOf} marks):
${String(question || '').trim()}

MARK SCHEME (one mark each, roughly):
${scheme.length ? scheme.map((p, i) => `${i + 1}. ${p}`).join('\n') : '(no scheme supplied — mark against the model answer)'}

FULL-MARK MODEL ANSWER (for reference):
${String(modelAnswer || '').trim() || '(none supplied)'}

STUDENT'S ANSWER:
"""
${String(answer || '').trim()}
"""

Mark it.`;

    const result = await callAccurate(system, user, { maxTokens: 700 });

    // Normalise. Grade is recomputed from the score so the band the student
    // sees can never disagree with the number next to it.
    const score = clamp(toInt(result.score, 0), 0, outOf);
    const pct = score / outOf;
    const grade = pct < 0.4 ? 'red' : pct <= 0.7 ? 'amber' : 'green';
    return {
        score,
        outOf,
        grade,
        feedback: String(result.feedback || '').trim(),
        missing: asStringArray(result.missing),
        tip: String(result.tip || '').trim(),
    };
}

// ── Clickable quiz batches (the game stage) ───────────────────────────────
// Sarah's cost design: Q (cheap) CREATES the questions, Sonnet CHECKS every
// answer key before a student sees it, and Opus is saved for the heavy
// lifting in the exam room. A whole batch of 10 costs pennies.
//
// Accuracy gate: if the Sonnet check can't run, we do NOT serve unchecked
// questions — a wrong answer key teaches the wrong law. We throw and the
// page shows "try again".
// A batch question as the page wants it: options is an ARRAY of exactly 4,
// correctIndex 0-3. Accepts the wire shape too ({a,b,c,d}) — see QUIZ_SCHEMA.
// Repairs what it safely can (an over-long option list is trimmed to the
// first four when the key still lands inside them) and REPORTS every drop,
// so a batch that comes back smaller than asked is never quiet
// (STUDY_SUITE_PHASE1_FINDINGS §2.2 #4).
function optionsArray(opts) {
    if (Array.isArray(opts)) return asStringArray(opts);
    if (opts && typeof opts === 'object') {
        return asStringArray(['a', 'b', 'c', 'd'].map((k) => opts[k]));
    }
    return [];
}

function normaliseQuizQuestions(raw) {
    const list = Array.isArray(raw?.questions) ? raw.questions : [];
    const out = [];
    let dropped = 0;
    for (const q of list) {
        if (!q || !q.question) { dropped++; continue; }
        let options = optionsArray(q.options);
        let correctIndex = toInt(q.correctIndex, -1);
        // repair: 5+ options with the key inside the first four → trim
        if (options.length > 4 && correctIndex >= 0 && correctIndex < 4) options = options.slice(0, 4);
        if (options.length !== 4) { dropped++; continue; }
        if (correctIndex < 0 || correctIndex > 3) { dropped++; continue; }
        // repair: two identical option strings make the key ambiguous → drop
        if (new Set(options.map((o) => o.toLowerCase())).size !== 4) { dropped++; continue; }
        out.push({
            question: String(q.question).trim(),
            options,
            correctIndex,
            why: String(q.why || '').trim(),
            topicTag: String(q.topicTag || '').trim() || 'General',
            difficulty: ['foundation', 'standard', 'stretch'].includes(q.difficulty) ? q.difficulty : 'standard',
        });
    }
    out.dropped = dropped;
    return out;
}

// The wire shape sent TO the checker: same as the schema, so the checker
// sees exactly the shape it must return.
function toWire(questions) {
    return {
        questions: questions.map((q) => ({
            question: q.question,
            options: { a: q.options[0], b: q.options[1], c: q.options[2], d: q.options[3] },
            correctIndex: q.correctIndex,
            why: q.why,
            topicTag: q.topicTag,
            difficulty: q.difficulty,
        })),
    };
}

// Structured-outputs schema for quiz batches — the API guarantees the
// response parses, so a big checked batch can never come back as broken JSON
// (live failure 19 Jul: truncated Sonnet batch → "Expected ':'" parse error).
//
// EXACTLY FOUR OPTIONS is enforced by the schema itself: structured outputs
// don't support minItems/maxItems, so options is an object with four
// required string keys (a/b/c/d, additionalProperties:false) and correctIndex
// is an integer enum 0-3. Nothing else can come back.
const QUIZ_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
        questions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['question', 'options', 'correctIndex', 'why', 'topicTag', 'difficulty'],
                properties: {
                    question: { type: 'string' },
                    options: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['a', 'b', 'c', 'd'],
                        properties: {
                            a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' }, d: { type: 'string' },
                        },
                    },
                    correctIndex: { type: 'integer', enum: [0, 1, 2, 3] },
                    why: { type: 'string' },
                    topicTag: { type: 'string' },
                    difficulty: { type: 'string', enum: ['foundation', 'standard', 'stretch'] },
                },
            },
        },
    },
};

const QUIZ_SHAPE = `Return ONLY valid JSON:
- questions (array): each {
    question (string — one clear multiple-choice question),
    options (object with EXACTLY four keys "a", "b", "c", "d" — each a string; one right, three genuinely tempting but wrong; never fewer or more than four),
    correctIndex (integer 0-3: 0 = a, 1 = b, 2 = c, 3 = d),
    why (string — ONE sentence that TEACHES: why the right answer is right AND what makes the closest wrong option wrong, worded so the student learns something even when they got it right),
    topicTag (string — short topic label; if a topic list was given, use the list's EXACT wording for the topic this question tests),
    difficulty ("foundation" | "standard" | "stretch")
  }`;

// User-safe wording for anything that goes wrong on this path — no vendor
// names on any student surface (Sarah's rule).
function publicError(msg) {
    let s = String(msg || 'unknown error');
    s = s.replace(/https?:\/\/\S+/g, '');                       // no vendor URLs
    // Pull the human "message" out of any upstream JSON blob and drop the blob
    // itself (they can be truncated mid-object, so match from the first brace).
    const msgs = [];
    s.replace(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (m, inner) => { msgs.push(inner.replace(/\\"/g, '"').trim()); return m; });
    const brace = s.indexOf('{');
    if (brace >= 0) s = s.slice(0, brace) + (msgs.length ? '(' + msgs.join('; ') + ')' : '');
    return s
        .replace(/Claude upstream/gi, 'accuracy service')
        .replace(/Q upstream/gi, 'question writer')
        .replace(/ANTHROPIC_API_KEY/gi, 'the accuracy service key')
        .replace(/TOGETHER_API_KEY/gi, 'the writer key')
        .replace(/\b(Anthropic|Claude|Sonnet|Opus|DeepSeek|Together|Gemini|OpenAI)\b/gi, 'the AI service')
        .replace(/\s+([;,.)])/g, '$1')
        .replace(/\(\s*\)/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 300);
}

async function generateQuiz({ subject, board, level, topic, count, avoid } = {}) {
    const n = clamp(toInt(count, 10), 3, 12);
    const boardLine = isSchoolStage(level)
        ? 'the national curriculum for England (no exam board at this stage)'
        : (board && board !== 'Other'
            ? board
            : 'a UK exam board (not specified — stay on content every board teaches)');
    const avoided = asStringArray(avoid);

    const writerSystem = `You write multiple-choice revision questions for a UK student. Board: ${boardLine}. Level: ${level || 'A-Level'}. Subject: ${subject || 'General Studies'}.
${stageRules(level, subject)}
Rules:
- Write ${n} questions. Mix difficulties: a couple of "foundation" to build confidence, mostly "standard", one or two "stretch".
- If a topic list is given, spread across it; keep each question on ONE topic and label it with topicTag using the list's exact wording.
- Wrong options must be genuinely tempting — the classic mix-ups students actually make — never obviously silly.
- Never repeat or closely rephrase anything in the avoid list.
- Only test content genuinely on this subject at this level. Real cases, real statutes, real terms — never invented ones, never fake specification codes.
- British English. Question stems short enough to read on a phone.

${QUIZ_SHAPE}`;

    const writerUser = `SUBJECT: ${subject || 'not given'}
LEVEL: ${level || 'not given'}
TOPICS: ${topic && String(topic).trim() ? String(topic).trim() : '(none — core topics for this subject)'}
AVOID (already asked): ${avoided.length ? avoided.join(' | ') : '(nothing yet)'}

Write the ${n} questions.`;

    // Step 1 — Q creates (cheap). If Q is down, Sonnet writes the batch
    // directly (still cheap, already accurate — the check is then built in).
    let draft = null;
    let writtenByClaude = false;
    let writerError = null;
    try {
        // 10 MCQs + why-lines run past 3000 tokens — live 20 Jul: two Q drafts
        // truncated mid-JSON ("Unterminated string"), forcing Sonnet writes.
        draft = normaliseQuizQuestions(await callQ(writerSystem, writerUser, { maxTokens: 5000 }));
    } catch (e) {
        writerError = e.message;
        console.warn('[q-revision] Q quiz writer failed, Sonnet writing directly: ' + e.message);
    }
    if (!draft || draft.length === 0) {
        try {
            draft = normaliseQuizQuestions(await claudeJSON(writerSystem, writerUser, { maxTokens: 6000, model: SONNET, effort: 'medium', schema: QUIZ_SCHEMA, skill: 'revision' }));
        } catch (e) {
            // Both writers failed — say so with both causes, vendor-free.
            const err = new Error(publicError(`Couldn't write the questions — ${writerError || 'the question writer returned nothing usable'}; ${e.message}`));
            err.publicMessage = err.message;
            throw err;
        }
        writtenByClaude = true;
    }
    if (draft.length === 0) throw Object.assign(new Error('No usable questions came back — try again.'), { publicMessage: 'No usable questions came back — try again.' });
    const writerDropped = draft.dropped || 0;
    if (writtenByClaude) {
        return { questions: draft, checkedBy: 'sonnet', asked: n, served: draft.length, dropped: { writer: writerDropped, checker: 0 } };
    }

    // Step 2 — Sonnet checks every answer key. No check, no quiz.
    if (!hasClaude()) throw Object.assign(new Error('Checker unavailable — the accuracy service key is not set on the server.'), { publicMessage: 'Checker unavailable — the accuracy service key is not set on the server.' });
    const checkerSystem = `You are the accuracy checker for a UK revision quiz (${boardLine}, ${level || 'A-Level'}, ${subject || 'General Studies'}). Another model drafted these multiple-choice questions. Your job: make sure a student can NEVER be taught something wrong by this batch.
${stageRules(level, subject)}${isSchoolStage(level) ? '\n- ALSO drop any question a child of this age has not been taught yet (content from a later year), and simplify wording a child of this age could not read.\n' : ''}
For every question:
- Verify the keyed answer (correctIndex) is definitely correct and the ONLY correct option. If the key is wrong, fix correctIndex.
- Verify the other three options are definitely wrong at this level. If a distractor is arguably right, rewrite it so it is cleanly wrong.
- Verify cases, statutes, dates, terms are real and correctly stated. Fix small errors in place.
- Verify the "why" sentence is accurate AND actually teaches one thing; rewrite it if it is vague.
- If a question is beyond repair (ambiguous, off-spec, not genuinely this subject), DROP it entirely rather than keep something doubtful.
- Do not add new questions. Do not rewrite question stems beyond fixing errors. Keep the same JSON shape and field wording style — every question keeps exactly four options a/b/c/d.

${QUIZ_SHAPE}`;

    let checkedRaw;
    try {
        checkedRaw = await claudeJSON(checkerSystem, `DRAFT BATCH:\n${JSON.stringify(toWire(draft), null, 1)}`, { maxTokens: 8000, model: SONNET, effort: 'medium', schema: QUIZ_SCHEMA, skill: 'revision' });
    } catch (e) {
        const err = new Error(publicError(`The answer-key check didn't run — ${e.message}`));
        err.publicMessage = err.message;
        throw err;
    }
    const checked = normaliseQuizQuestions(checkedRaw);
    if (checked.length === 0) throw Object.assign(new Error('The checker rejected the whole batch — try again.'), { publicMessage: 'The checker rejected the whole batch — try again.' });

    // Guard: the checker may DROP but never ADD or swap in new stems. Anything
    // whose stem isn't (roughly) in the draft is discarded and counted.
    const draftStems = new Set(draft.map((q) => stemKey(q.question)));
    const kept = checked.filter((q) => draftStems.has(stemKey(q.question)));
    const invented = checked.length - kept.length;
    if (invented > 0) console.warn(`[q-revision] checker returned ${invented} question(s) not in the draft — discarded`);
    if (kept.length === 0) throw Object.assign(new Error('The checker rejected the whole batch — try again.'), { publicMessage: 'The checker rejected the whole batch — try again.' });
    const checkerDropped = draft.length - kept.length;
    if (checkerDropped > 0) console.log(`[q-revision] checker dropped ${checkerDropped} of ${draft.length}`);
    return { questions: kept, checkedBy: 'sonnet', asked: n, served: kept.length, dropped: { writer: writerDropped, checker: checkerDropped + (checked.dropped || 0) } };
}

// A forgiving stem key so a checker that fixed a typo in a stem still matches
// the draft: first eight words, letters/digits only.
function stemKey(stem) {
    return String(stem || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
}

module.exports = {
    stageOf, stageRules, isSchoolStage, isPrimary, generateQuestion, markAnswer, generateQuiz, publicError, QUIZ_SCHEMA, normaliseQuizQuestions };
