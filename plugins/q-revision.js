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
const { accurateJSON } = require('./q-claude');

async function callQ(systemPrompt, userPrompt, { maxTokens = 4096 } = {}) {
    const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
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
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Q upstream ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    const raw = cleanModelOutput(data.choices?.[0]?.message?.content || '{}', 'revision');
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
}

// Everything in revision is accuracy-critical — Claude first, Q as fallback.
async function callAccurate(systemPrompt, userPrompt, opts = {}) {
    return accurateJSON(systemPrompt, userPrompt, { ...opts, fallback: callQ });
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

async function generateQuestion({ subject, board, level, topic, askedSoFar, weakAreas } = {}) {
    const boardLine = board && board !== 'Other'
        ? board
        : 'a UK exam board (not specified — stay on content every board teaches)';

    const system = `You are a UK exam question writer and tutor. You write ONE exam-style revision question for a student, exactly as it would appear on a real paper, with the mark scheme a real examiner would mark it against.

Board: ${boardLine}
Level: ${level || 'A-Level'}
Subject: ${subject || 'General Studies'}

Rules:
- ONE question only, using a realistic command word (State, Describe, Explain, Compare, Analyse, Evaluate). Match the marks to the command word: State/Describe 2-3, Explain 3-4, Compare/Analyse 4-6, Evaluate or extended response 6-12. Marks must be between 2 and 12.
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

module.exports = { generateQuestion, markAnswer };
