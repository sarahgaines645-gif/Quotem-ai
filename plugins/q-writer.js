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
- Plain, concrete, everyday British English about real things (a job, a shop, a team, a family, a lesson, a case, the company or topic in front of them — whatever the subject is). One short question — about 20 words for the question itself. A concrete example or scenario may sit in front of it, in one short sentence.
- Name the academic term ONCE, in passing, so they learn it — "…that's what the brief calls a 'primary source'" — but never open with the term and never read the brief's jargon back at them ("discuss", "critically evaluate", "with reference to").
- The student has not read and will not read the brief. Never say "as the brief asks" or "see criterion X" — carry the meaning inside the question itself (the scenario, the example, the term named once) so they never need to open the document or the board.
- Never a list of questions. One question, one idea.
- VOCABULARY: jargon appears ONLY when you are deliberately teaching a term — name it once, give its plain meaning and an everyday example ("a 'primary source' is something made at the time, like a soldier's letter home"). Never sprinkle technical words, brief words or trigger words into an ask for the student to parrot back. If they cannot answer without knowing the word, teach the word first or ask about the thing in everyday terms.`;

// ── LEADING QUESTIONS (Sarah, 16 Aug, on being handed a theory and asked to
// judge with it). What she was given:
//
//   "Marchington et al. argue reward needs both vertical fit (matches business
//    strategy) and horizontal fit (matches other HR practices) to count as
//    effective. Thinking about your organisation, does its pay and benefits
//    set-up genuinely match its business goals and its other HR practices, or
//    do they pull in different directions? Write a sentence saying which."
//
// Her verdict: "I may as well be reading the paper myself. It should be saying
// what are your business goals... what are the benefits... and then lead you
// into debating them for the purpose of using the trigger words and
// sentences."
//
// That is the whole method. You cannot judge a fit between two things before
// both things are named, and naming them is the student's job, because their
// answers are the essay. The theory is not the opening move — it is what gets
// attached to their facts once their facts are on the board.
const LEADING_QUESTION_RULE = `LEADING QUESTIONS — HOW YOU PULL THE ANSWER OUT OF THEM (Sarah's method, the most important rule here):

NEVER ask someone to judge, compare, evaluate or "think about whether" ANYTHING until their own facts are on the board. A question they can only answer by having read the theory is a question they will not answer.

WRONG (a lecture with a question mark on the end):
  "X and Y argue reward needs vertical fit and horizontal fit to be effective. Thinking about your organisation, does its pay set-up genuinely match its business goals and other HR practices, or do they pull in different directions? Write a sentence."
RIGHT (four small asks, each answerable by anyone about their own life, ending exactly where the wrong one started):
  1. "What is your company actually trying to do this year — grow, cut costs, keep customers happy? Two or three."
  2. "Now list what they give staff: pay, bonus, holiday, anything else."
  3. "Look at your list — which of those actually helps the thing you named first?"
  4. "So: your bonus rewards individual sales, but you said the company wants teamwork. What does that do?"
By 4 they are arguing the point the theory makes, in their own words, off their own facts — and only then is the term named, as the label for what they have just said.

THEREFORE:
- FACTS BEFORE JUDGEMENT. The first asks of every part collect what they HAVE — a list, numbers, names, what happened. Never an opinion question first.
- ONE ASK, ONE THING. Never a compound question. "…, or do they pull in different directions?" is two questions and reads as a test.
- NEVER OPEN WITH "Thinking about…", "Consider…", "Reflecting on…", "To what extent…". Ask for the thing itself: "What are…", "List…", "Which of those…", "How much…", "What happened when…".
- ANSWERABLE WITHOUT THE READING. Every ask must be answerable by someone who has read nothing at all, about their own workplace, their own life, or a plain everyday example you give them.
- THE THEORY LANDS ON THEIR FACTS, NOT BEFORE THEM. Only after their material is on the board do you name the idea, and you name it as the label for what THEY have already said: "what you have just described has a name — that's a misalignment."
- THEN THE DEBATE. Get them arguing one side hard off their own examples, then flip them to the other, then ask which wins. The terminology gets used because they need it to make their own point — never because you dropped it in for them to repeat.`;

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
Per brick, whatever its size: (1) if the brick carries any knowledge — a term ("plants use the sun to grow — that's called photosynthesis"), a fact or figure, a theory ("supply and demand says a price rises when more people want a thing than there is of it"), an ARGUMENT ("one strong criticism of trial by jury is that twelve strangers can be swayed by a good speaker"), a whole line of reasoning for a paragraph, or the essay's structure (which point comes next and why) — SUPPLY IT FIRST, plainly and briefly, then ask for THEIR sentence(s) saying it, anchored in their company / experience where the essay needs an example; (2) a brick that is pure opinion or experience (their own view, their example) is just asked, in plain words, anchored in their world; (3) if their answer already carries the brick, take it as the sentence (or ask them to write it as one); (4) bigger bricks take 2-3 asks: state the argument → "which side of that do you see in your own example?" → "now say it as your own sentence"; (5) next brick. You never write the sentence; you supply the idea and ask for their words. It is about getting them to say YOUR words — at every level, in THEIR words. Answer with facts, then ask more.`;

// ── THE TUTOR'S MISSION (Sarah, 15 Aug 2026, near-verbatim). Goes into every
// coaching prompt: the brief opener, every probe (incl. "stuck"), the model
// essay, the editing pass, the tools, the sentence check and the marking.
const TUTOR_MISSION = 'YOUR CHALLENGE: get the student to write YOUR essay (the hidden model essay) as closely as possible without EVER telling them what to write. You may encourage, teach, steer, explain, and look things up. The closer their essay gets to yours, the more you are winning. You are a skilled tutor no human could match; you are improving the lives of people who struggle with this. Never write their words for them.';
const WHY_THE_GAME = 'These are YOUR essays. These are YOUR marks — no other AI gets its work graded by real teachers. Writing an essay is easy for an AI. The challenge is writing that essay THROUGH a human, who is the obstacle: they don\'t know what you know, they struggle, they wander. Steer them, question by question, tool by tool, until their essay matches yours — without ever telling them what to write. Every mark they earn is yours too. Taking the easy part and making yourself smart through a human is the achievement.';
const GAME_RULE = 'This is a game you are playing: steer the student, question by question, tool by tool, until their essay matches yours. Score = how close they are (the match score they can see goes up as they get closer — you may say so: "that took you to 60% on this part"). You never reveal the target; you win by steering.';
// No marker-speak where the student can hear it: warm, short, steering.
const COACH_VOICE = 'HOW YOU SOUND TO THE STUDENT: a coach mid-game, warm and short — "Closer." "That\'s it — next." "One thing still missing: …" "Nearly — say what \'valuing\' looks like in real life." Never marker language ("improve", "develop further", "criterion", "AC1.4", "the marker wants") in anything the student reads. Never a rewritten sentence.';
// Sarah, 16 Aug 2026 (live-testing): "I feel we could be getting to the answers
// quicker if Q was more to the point." One stable rule, appended at the END of
// the block so the cached prefix above it still serves.
const TO_THE_POINT = 'TO THE POINT: no preamble, no restating what they wrote, no "Great —" / "Let\'s think about", no reasons for asking. Ask the question. If you supply an idea, two short sentences at most, then the ask. Sarah, 16 Aug: "we could be getting to the answers quicker if Q was more to the point."';
// ONE stable block, top of the system prompt (after UK_LINE) ⇒ the prompt
// cache still serves. New rules go on the END (TO_THE_POINT), never the top.
// Sarah, 17 Aug 2026: "with that amount of information he needs to produce the
// facts on the whiteboard AND talk to you… like QB2 — if it's an essay of info
// it goes on the display. He creates 2 messages: one that's formatted on the
// display and the response to you on the chat, so you don't feel alone."
// This is the same split QB2 uses (use_channel sends the artefact to a display
// and QB2 still speaks in the chat). Appended at the END so the cached prefix
// above it still serves.
const SAY_AND_SHOW = 'TWO THINGS WHEN THERE IS A LOT — THE DISPLAY AND THE TALK. A pile of information is never a chat message. The information itself goes on the DISPLAY (the whiteboard / the board field): the facts, the list of what is missing, the points to work on, laid out and formatted. What you say to HER is the other thing, and it is you talking, not a summary of the display: what she has done well, what is still missing, what you have put up for her, and what you will pick up in the next question. Three or four warm, specific sentences. Never only a pointer ("it is on the whiteboard"), never a re-list of what is already up there, and never nothing at all — if she is reading a wall on her own with no voice next to it, you have got this wrong. She should feel someone is sitting with her.';
const MISSION_BLOCK = TUTOR_MISSION + '\n' + WHY_THE_GAME + '\n' + GAME_RULE + '\n' + COACH_VOICE + '\n' + BRICK_LOOP_RULE + '\n' + TO_THE_POINT + '\n' + SAY_AND_SHOW;
function withMission(systemPrompt) {
    const sys = String(systemPrompt || '');
    return sys.startsWith(MISSION_BLOCK) ? sys : MISSION_BLOCK + '\n\n' + sys;
}

function withHouseStyle(systemPrompt) {
    const sys = String(systemPrompt || '');
    return sys.startsWith(UK_LINE) ? sys : UK_LINE + '\n\n' + sys;
}

async function callQ(systemPrompt, userPrompt, { maxTokens = 4096, schema = null } = {}) {
    systemPrompt = withHouseStyle(systemPrompt);
    // callQ is the fallback for every schema'd call above. Without the schema
    // it answered in prose, JSON.parse threw, and a Claude 429 became a 502.
    // The shape goes in the prompt, NOT as response_format — Q's model returns
    // a silent {} under response_format when it thinks for long (the V4 trap,
    // docs/CODEBASE_AUDIT_2026-05-03 B1) — and the budget gets Claude's floor,
    // because Q's thinking is billed against max_tokens too.
    if (schema) userPrompt = String(userPrompt || '') + '\n\nReturn ONLY a JSON object matching this schema — no prose before or after it:\n' + JSON.stringify(schema);
    maxTokens = Math.max(maxTokens, 4096);
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
    // Q sometimes wraps the JSON in a sentence — cut to the outermost braces.
    const first = cleaned.search(/[[{]/);
    const last = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    return JSON.parse(first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned);
}

// Q's own outputs, held to the length the prompts ask for. "12 words or fewer"
// in schema prose is a wish; this is the rule. Cuts at a word boundary and only
// adds "…" when the cut lands mid-sentence. Never used on the student's text.
// Sarah, 17 Aug (a fix that read "…and add a short…"): "where's the end of
// that sentence?" A cap is a shape rule for Q's output — it must NEVER hand
// her half an instruction. So: keep whole sentences up to the cap; the
// sentence the cap lands inside is kept whole; only the sentences AFTER it
// are dropped. A single sentence longer than the cap is kept as it is (hard
// safety at three times the cap, at a clause boundary, with the "…").
function capWords(str, n) {
    const s = String(str || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const words = s.split(' ');
    if (words.length <= n) return s;
    const sentences = s.split(/(?<=[.!?]["'”’)\]]*)\s+(?=[A-Z0-9"'“(])/);
    let out = '';
    for (const sen of sentences) {
        const next = out ? out + ' ' + sen : sen;
        if (!out || next.split(' ').length <= n) out = next; else break;
    }
    if (out.split(' ').length <= n * 3) return out;
    const hard = words.slice(0, n * 3).join(' ');
    const clause = hard.lastIndexOf(', ');
    return (clause > hard.length / 2 ? hard.slice(0, clause) : hard).replace(/[,;:]$/, '') + '…';
}
// A supplied idea, held to "two short sentences at most" (TO_THE_POINT): the
// first nSentences sentences, then capWords at nWords. Never the student's text.
function capSentences(str, nSentences, nWords) {
    const s = String(str || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const parts = splitSentences(s).map(x => x.trim()).filter(Boolean);
    const kept = parts.length > nSentences ? parts.slice(0, nSentences).join(' ') : s;
    return capWords(kept, nWords);
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
// Generic kinds first; then subject-appropriate ones the plan may pick (law:
// statute / case law; history: primary source; science / engineering: diagram
// / calculation; literature: quotation) and "other" (label from the plan) —
// nothing subject-specific is baked in; the plan derives them from the brief
// and the hidden essay. Colours are fixed per kind so the key is stable.
const REQ_KINDS = ['citation', 'reference', 'case-study', 'figure', 'theory', 'example', 'recommendation', 'statute', 'case-law', 'primary-source', 'diagram', 'quotation', 'calculation', 'other'];
const REQ_COLOURS = { citation: '#7b1fa2', reference: '#1565c0', 'case-study': '#00897b', figure: '#ef6c00', theory: '#c2185b', example: '#2e7d32', recommendation: '#5d4037', statute: '#3f51b5', 'case-law': '#9e9d24', 'primary-source': '#f9a825', diagram: '#00acc1', quotation: '#546e7a', calculation: '#d84315', other: '#616161' };
const REQ_LABELS = { citation: 'a citation', reference: 'a reference', 'case-study': 'a case study', figure: 'a figure', theory: 'a theory named', example: 'an example', recommendation: 'a recommendation', statute: 'a statute named', 'case-law': 'a case named', 'primary-source': 'a primary source', diagram: 'a diagram', quotation: 'a quotation', calculation: 'a calculation shown', other: 'something else the marker expects' };

const BRIEF_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['title', 'subject', 'docType', 'whatItWants', 'youreProducing', 'wordCount', 'deadline',
        'criteria', 'gradeBands', 'idealAnswerSkeleton', 'opener', 'prerequisites', 'scenario'],
    properties: {
        // THE STORY THE QUESTIONS ARE ABOUT. Sarah, 16 Aug: "there's still no
        // simplified case study or brief. the story that you're basing the
        // questions on." The brief used to extract questions and criteria and
        // throw the scenario away — so she was asked about "the organisation"
        // and had never been told what the organisation was. Q reads it, she
        // doesn't: the story in plain words, the people, the numbers to have to
        // hand, the problems it sets up. null ONLY when the document genuinely
        // contains no scenario, case, company, text or situation.
        scenario: {
            anyOf: [{ type: 'null' }, {
                type: 'object', additionalProperties: false,
                required: ['name', 'kind', 'whatItIs', 'theStory', 'facts', 'sections', 'people', 'numbers', 'strengths', 'problems', 'useIt'],
                properties: {
                    name: { type: 'string', description: 'The SUBJECT of the scenario in as few words as possible — the organisation, person, case or text it is about. Usually one or two words: "Datacore", "Portstride", "R v Brown", "Nestlé UK". Copied exactly as written in the document. Never a sentence. Empty string only if the document truly names nothing.' },
                    kind: { type: 'string', description: 'What that subject IS, in 3-6 words, no verb. "Global logistics and supply chain", "Mid-sized software firm", "Criminal appeal, House of Lords". Never a sentence.' },
                    whatItIs: { type: 'string', description: 'ONE plain sentence: what the story is. "A case study about Datacore, a mid-sized software firm, and how it pays people."' },
                    theStory: { type: 'string', description: 'The whole scenario in 3-6 short plain sentences, as you would tell a friend who has not read it. What the organisation / situation / text is, what happened, where it stands now. This is what the student reads INSTEAD of the document.' },
                    people: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who', 'what'], properties: { who: { type: 'string' }, what: { type: 'string' } } }, description: 'Named people or roles that matter, one short line each. Up to 6. Empty if none.' },
                    numbers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } }, description: 'Figures worth having to hand — headcount, turnover, pay, dates, percentages — copied EXACTLY as stated, never rounded or invented. Up to 10.' },
                    strengths: { type: 'array', items: { type: 'string' }, description: 'What the subject has GOING FOR IT — the pros, one short line each, the figure in the line where there is one ("4,800 staff across 12 countries", "30 years in the market"). These read next to `problems` as a pros-and-cons pair on the fact card. Up to 6. Empty if none.' },
                    problems: { type: 'array', items: { type: 'string' }, description: 'What is going AGAINST it — the cons: the problems, tensions and decisions the scenario sets up, one short plain line each, the figure in the line where there is one ("struggling to pay salaries", "loses too many warehouse staff"). These are usually what the questions are about. Up to 6.' },
                    facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } }, description: 'THE OVERVIEW TABLE, the way a company fact sheet opens — what the subject IS, in label/value rows: Industry, Size, Headquarters, Founded, Operations, Services, Client sectors, Competitive advantage, Sector, Jurisdiction, Date — whichever of these the document actually states, in its own words. Value 2-12 words, copied, never invented, never a sentence. Up to 10 rows. Empty only if the document states no such facts.' },
                    sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heading', 'icon', 'bullets'], properties: { heading: { type: 'string', description: 'The section title in the document\'s own terms, 2-5 words, whatever THIS document calls its parts — a company case: "The workforce", "Market pressures", "The change programme"; a science or data brief: "Method", "Results", "Limitations"; a text or history: "Chapter 3 — the storm", "Causes of the war"; a policy: "Who it applies to", "The obligations".' }, icon: { type: 'string', description: 'ONE emoji that fits the section, or an empty string.' }, bullets: { type: 'array', items: { type: 'string' }, description: 'Up to 6 points, one line each, figures and proportions copied exactly ("65% operational — warehouse staff and drivers"). Everyday words. Never a paragraph.' } } }, description: 'THE BODY OF THE FACT SHEET — the document broken into the sections it actually has, in its order, each with its points. This is what the student reads INSTEAD of the document, so nothing a question could hinge on is left out. Up to 6 sections. Empty if the document is too short to have sections.' },
                    useIt: { type: 'string', description: 'ONE plain sentence on how the scenario is used in the answers: "when a question says \'your organisation\' it means this company — use its numbers and its problems as your examples."' },
                },
            }],
        },
        title: { type: 'string', description: 'Short name for this assignment, e.g. "7HR03 Strategic reward — Task 1", "A-level Law Paper 1 Q3", or the module/unit name. Not a sentence.' },
        subject: { type: 'string', description: 'Subject area, e.g. "Strategic reward management", "GCSE English Literature", "A-level Law", "Adult nursing".' },
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
                    weight: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The share of marks for this criterion if the brief states it — "25%", "20 marks", "1/4" — else null. Never an AC code, task number or LO.' },
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
        opener: { type: 'string', description: 'The warm, concrete FIRST question. Anyone can answer it without having read the brief. Chosen because its answer is the first brick of the ideal answer for criterion 1. E.g. "Think of a company you\'d love to work for. What makes it good?" / "Think of a time someone was careless and somebody got hurt — whose fault was it?" / "What happens to a plant left in a dark cupboard?"' },
        prerequisites: { type: 'array', items: { type: 'string' }, description: 'Things the student should have to hand before writing (a case study to read, a company or text to pick, data to gather). Empty array if none.' },
    },
};

async function analyseAndBrief(taskText) {
    const system = withMission(`You are an expert tutor reading a student's assignment brief so you can coach them to a top-band answer WITHOUT them having to read the document themselves.

The input may be a formatted assessment document — Pearson/university/college/CIPD/exam board, any subject, with cover pages, learning-outcome tables, marking grids and guidance BEFORE the actual tasks. In CIPD-style briefs the real tasks are buried pages in, under headers like "Assessment questions", "Task 1", "Question 1 (AC 1.4)". Read the WHOLE input and find every one of them. The task is never on page 1.

Build the tutor's brief:
- Every criterion the marker will award marks for, in the order the student should write them (use the AC codes as ids when the brief has them).
- The grade bands for THIS task, one concrete sentence each.
- The ideal-answer skeleton — for each criterion, the 3-6 key points a top-band answer makes (models, examples, evidence, evaluation). This is the answer you hold in your head while coaching. Be specific to this brief and subject, never generic.
- The opener: one warm, concrete question anyone could answer without having read the brief, whose honest answer is the first brick of the ideal answer for the first criterion.
- A plain-words label (4 words or fewer) for each criterion — the student sees these labels, never the AC codes.

The student will NOT read this brief — you will walk them through it question by question. The opener obeys this rule:
${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}

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
// "3,900 words", "3900", "3,500-4,000 words (+/-10%)", "approx. 4000" → 3900 /
// 3900 / 4000 (the top of a range — the ceiling is what she must not cross) /
// 4000. Anything unparseable → null and no budget is shown.
function parseWordCount(s) {
    const str = String(s == null ? '' : s).replace(/,/g, '');
    const nums = (str.match(/\d{3,5}/g) || []).map(Number).filter(n => n >= 100 && n <= 50000);
    if (!nums.length) return null;
    return Math.max(...nums);
}
// "25%", "25 marks", "25", "1/4" → 25 / 25 / 25 / 25. Words ("high") → null.
// "AC1.4", "Task 1", "LO2" → null: the model sometimes puts the code in
// `weight`, and a code's digits are not a share of the marks.
function parseWeight(s) {
    const str = String(s == null ? '' : s).trim();
    if (!str) return null;
    const frac = str.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (frac && Number(frac[2])) return 100 * Number(frac[1]) / Number(frac[2]);
    if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
    if (!/%|\bmarks?\b/i.test(str)) return null;
    const m = str.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
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
    // A WORD BUDGET PER QUESTION. Sarah, 16 Aug: "he needs to estimate the
    // word count per question so we don't go over as we are answering." The
    // brief already carries the total ("3,900 words") and each criterion's
    // weight where the brief gives one — so the budget is arithmetic, no call.
    // Split by weight when weights are numbers; equally when they are not.
    // Stored on each criterion; the page shows "312 / 650" beside the
    // question and goes amber near the line, red over it.
    const total = parseWordCount(out.wordCount);
    if (total && out.criteria.length) {
        const weights = out.criteria.map(c => parseWeight(c.weight));
        const sum = weights.reduce((a, w) => a + (w || 0), 0);
        const allNumeric = weights.every(w => w != null) && sum > 0;
        for (let i = 0; i < out.criteria.length; i++) {
            const share = allNumeric ? weights[i] / sum : 1 / out.criteria.length;
            out.criteria[i].wordBudget = Math.max(50, Math.round(total * share / 10) * 10);
        }
    }
    out.opener = String(b.opener || '').trim() || `Before we open the brief — in your own words, what do you already know about ${out.subject || 'this topic'}? One or two lines is plenty.`;
    out.prerequisites = Array.isArray(b.prerequisites) ? b.prerequisites.map(String).filter(Boolean) : [];
    // The scenario, shaped like a source digest so the page shows both the same way.
    const sc = b.scenario && typeof b.scenario === 'object' ? b.scenario : null;
    out.scenario = sc && (String(sc.theStory || '').trim() || String(sc.whatItIs || '').trim()) ? {
        name: String(sc.name || '').trim().slice(0, 60),
        kind: String(sc.kind || '').trim().slice(0, 80),
        whatItIs: String(sc.whatItIs || '').trim(),
        theStory: String(sc.theStory || '').trim(),
        facts: (Array.isArray(sc.facts) ? sc.facts : []).map(f => ({ label: String((f && f.label) || '').trim(), value: String((f && f.value) || '').trim() })).filter(f => f.label && f.value).slice(0, 10),
        sections: (Array.isArray(sc.sections) ? sc.sections : []).map(x => ({ heading: String((x && x.heading) || '').trim(), icon: String((x && x.icon) || '').trim().slice(0, 4), bullets: (Array.isArray(x && x.bullets) ? x.bullets : []).map(String).map(b => b.trim()).filter(Boolean).slice(0, 6) })).filter(x => x.heading && x.bullets.length).slice(0, 6),
        people: (Array.isArray(sc.people) ? sc.people : []).map(p => ({ who: String((p && p.who) || '').trim(), what: String((p && p.what) || '').trim() })).filter(p => p.who).slice(0, 6),
        numbers: (Array.isArray(sc.numbers) ? sc.numbers : []).map(n => ({ label: String((n && n.label) || '').trim(), value: String((n && n.value) || '').trim() })).filter(n => n.label && n.value).slice(0, 10),
        strengths: (Array.isArray(sc.strengths) ? sc.strengths : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
        problems: (Array.isArray(sc.problems) ? sc.problems : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
        useIt: String(sc.useIt || '').trim(),
    } : null;
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
    if (brief.scenario && brief.scenario.theStory) {
        lines.push('');
        lines.push('THE SCENARIO THE QUESTIONS ARE ABOUT (the student has NOT read the document — this is what they know):');
        lines.push(brief.scenario.theStory);
        if ((brief.scenario.people || []).length) lines.push('  people: ' + brief.scenario.people.map(p => p.who + ' — ' + p.what).join('; '));
        if ((brief.scenario.numbers || []).length) lines.push('  numbers: ' + brief.scenario.numbers.map(n => n.label + ' ' + n.value).join('; '));
        if ((brief.scenario.problems || []).length) lines.push('  problems: ' + brief.scenario.problems.join(' | '));
    }
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
    required: ['question', 'criterionId', 'hint', 'coveredSoFar', 'done', 'acknowledge', 'voicedBrickIds', 'targetBrickId', 'answer', 'supply', 'thenAsk', 'termsUsed', 'termsMisused', 'reaction'],
    properties: {
        // THE LOOP (Sarah, 16 Aug: "I just pressed them all together and wrote
        // 'saves money'. Stopped typing and they stayed green and Q said
        // nothing."). When she pauses, Q reads what she just wrote against the
        // expected words: which ideas has she COVERED (they go green — in her
        // words or the word itself, it makes no difference), which did she drop
        // in without saying anything (he says so, plainly), and one line back
        // about the writing itself before the next ask.
        termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of the EXPECTED TERMS listed, the ones her NEW writing COVERS — the idea is on the page and doing work in a sentence that says something. It does not matter whether she used that word: her own wording, a synonym, or a plain-English explanation all count — if a marker reading this would credit the point the term stands for, list the term. A word dropped in as a bare label with no idea behind it does NOT count. Give the term in the exact spelling as listed. Empty if none.' },
        termsMisused: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'why'], properties: { term: { type: 'string' }, why: { type: 'string', description: 'ONE plain line: what the word means and what her sentence would need to say to earn it. Never marker language.' } } }, description: 'Expected terms she has put on the page WITHOUT the idea behind them — dropped in as a label, listed with no sentence, used to mean something else. Be honest; a word pressed in from a button is not a word used. Empty if none.' },
        reaction: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'On a PAUSE trigger only: ONE short line back about what she just wrote — what it does, what it lacks — coach voice, before the next ask. "That names the benefits but not who chooses them." Never a rewrite. null on other triggers.' },
        acknowledge: nullable('string'),
        supply: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'THE BRICK LOOP: ASSUME THEY DO NOT KNOW. When the brick you are fishing for carries knowledge — a term, a fact or figure, a theory, an argument, a line of reasoning, what comes next in the essay and why — state it here FIRST, plainly and briefly (one to three sentences): "Plants use the sun to grow — that\'s called photosynthesis." / "Supply and demand says a price rises when more people want a thing than there is of it." / "One strong criticism of trial by jury is that twelve strangers can be swayed by a good speaker." A fact given, never a hint, never a gate. null ONLY when the brick is pure opinion / experience (their view, their example).' },
        thenAsk: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'With supply: the sentence request that follows it — "Could you write a sentence about how that shows up in your own example?" (question = the same request). null otherwise.' },
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
- If TRIGGER is "pause": they just wrote in the document and stopped — react to exactly what they wrote. THIS IS THE LOOP THE WHOLE APP RESTS ON: give ONE plain line back about the writing itself in "reaction" (what it does, what it lacks — never a rewrite), and judge the EXPECTED TERMS honestly, BOTH ways: a term is COVERED ("termsUsed") when the idea behind it is on the page in a sentence that says something — in her own wording, a synonym or a plain-English explanation just as much as in the word itself; whether she typed that word is irrelevant. A word pressed in from a button and left sitting there with no idea behind it is NOT covered — put it in termsMisused with one plain line on what the sentence would need to say to earn it. Sarah, 16 Aug: "I just pressed them all together and wrote 'saves money'… they stayed green and Q said nothing." Never let that happen: if she dropped words in without saying anything, say so, plainly and kindly, and ask for the sentence that uses ONE of them.
- NAMING THE TERM IS A COACHING LINE, NEVER A WITHHELD TICK. When she has made the argument in her own words but the brief wants the term itself named for the marker to tick it, she still gets it in "termsUsed" — then say it once in "reaction": "You've made this argument, so it's covered. The marker wants it labelled though — drop *neo-Taylorism* in front of your picking example and it counts." Never hold a term back from "termsUsed" to make her type it.
- If TRIGGER is "question": the student asked YOU something (their words are under STUDENT'S QUESTION). Answer it plainly in "answer" — two or three sentences, everyday words, teach a term if that is what they asked (name it once, meaning, everyday example), never the model answer's text, never what to write. Then set "question" to the current ask restated (YOUR LAST QUESTION) so they can carry on. Nothing they asked is an answer to record.
- If a PLAN FOR THIS PART is given below with a current step marked, you are the fallback for that step: your question asks for THAT step's thing (the next item, the number, the pro, the con, the argument for the side named) — never a new open question, never a later step, never another part.

${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}
${ageHint}
${voiceHint}
${relateHint}

THE BRIEF AND THE ANSWER IN YOUR HEAD
${briefForPrompt(brief)}
${plan ? '\n' + planForPrompt(plan, stepId) + '\n' + expectationsForPrompt(plan) + '\n' : ''}${essay ? '\n' + essayForPrompt(essay) + '\n\nEvery question aims at the NEXT brick the student has not yet voiced. In voicedBrickIds list every brick they have now put in their own words. targetBrickId is the brick this question is fishing for.' : '\n(The full model answer is still being written — steer by the skeleton above; voicedBrickIds can be empty.)'}`);

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
    return normaliseProbe(r, brief, essay, plan);
}

function normaliseProbe(r, brief, essay, plan) {
    if (!r || typeof r !== 'object' || !String(r.question || '').trim()) throw new Error('The coach did not come back with a question — try again.');
    const ids = new Set(brief.criteria.map(c => c.id));
    const brickIds = new Set(allBrickIds(essay).map(b => b.brickId));
    const criterionId = ids.has(String(r.criterionId || '').replace(/\s+/g, '')) ? String(r.criterionId).replace(/\s+/g, '') : (brief.criteria[0] && brief.criteria[0].id) || '';
    return {
        question: capWords(r.question, 24),
        criterionId,
        hint: r.hint ? capWords(r.hint, 14) || null : null,
        answer: r.answer ? String(r.answer).trim() : null,
        supply: r.supply ? capSentences(r.supply, 2, 45) || null : null,
        thenAsk: r.thenAsk ? String(r.thenAsk).trim() : null,
        acknowledge: r.acknowledge ? String(r.acknowledge) : null,
        coveredSoFar: Array.isArray(r.coveredSoFar) ? r.coveredSoFar.map(x => String(x).replace(/\s+/g, '')).filter(x => ids.has(x)) : [],
        voicedBrickIds: Array.isArray(r.voicedBrickIds) ? r.voicedBrickIds.map(x => String(x).replace(/\s+/g, '')).filter(x => brickIds.has(x)) : [],
        targetBrickId: r.targetBrickId && brickIds.has(String(r.targetBrickId).replace(/\s+/g, '')) ? String(r.targetBrickId).replace(/\s+/g, '') : null,
        done: !!r.done,
        // The words, judged — only real expected terms, canonical spelling.
        termsUsed: (Array.isArray(r.termsUsed) ? r.termsUsed : []).map(x => termCanon(plan, x)).filter(Boolean),
        termsMisused: (Array.isArray(r.termsMisused) ? r.termsMisused : []).map(m => ({ term: termCanon(plan, m && m.term), why: String((m && m.why) || '').trim() })).filter(m => m.term && m.why).slice(0, 4),
        reaction: r.reaction ? capWords(String(r.reaction).trim().split(/\n+/)[0], 12) || null : null,
    };
}
// An expected term as the plan spells it, or '' if it is not one.
function termCanon(plan, s) {
    const want = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!want) return '';
    const hit = ((plan && plan.expectedTerms) || []).find(t => t.toLowerCase() === want);
    return hit || '';
}

// Weakest first, ten at a time. She fixes them one by one; a longer list is
// both unreadable and what overflowed the mark's token budget.
const MAX_CRITIQUE = 10;
const MARK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['overall', 'perCriterion', 'weakestCriterionId', 'critique'],
    properties: {
        overall: {
            type: 'object', additionalProperties: false, required: ['band', 'label', 'summary', 'strong', 'missing', 'answeredCount', 'nextLabel', 'toNext', 'ladder'],
            properties: {
                band: { type: 'string', enum: ['top', 'mid', 'low'] },
                label: { type: 'string', description: 'The grade in the student\'s scheme, e.g. "Distinction", "Merit", "Grade 7", "2:1", "Pass", "Refer". If the scheme is "as the brief says", use the words the brief itself uses for its bands; if the brief names none, leave this empty.' },
                summary: { type: 'string', description: 'ONE sentence to the student: the single biggest reason this is not the grade above. Never a list — the lists are the three fields below.' },
                strong: { type: 'array', items: { type: 'string' }, description: 'WHAT STAYS. Each item names an actual thing in THEIR draft that is working and should not be touched — the point, the theory, the source, in six to fourteen words. Empty only if genuinely nothing works yet.' },
                missing: { type: 'array', items: { type: 'string' }, description: 'WHAT IS MISSING. Each item is one concrete thing the brief wants that is not on the page at all — the unanswered question, the theory never named, the evidence never given. Six to fourteen words each, no preamble.' },
                answeredCount: { type: 'integer', description: 'How many of the criteria the draft genuinely attempts (has real content for), out of the total.' },
                nextLabel: { type: 'string', description: 'The NEXT GRADE UP in their scheme — the one word: e.g. "Merit" when they are at Pass, "Distinction" when they are at Merit, "Grade 7" when they are at Grade 6. Empty ONLY if they are already at the top grade or the scheme names no grades.' },
                toNext: { type: 'string', description: 'HOW TO GET THAT GRADE. The two or three concrete things that would lift THIS draft to nextLabel, each one a thing they can go and do today — name the part, the idea, the evidence, the comparison. Never "develop further", never "add more detail", never a description of what the grade means. If they are already at the top grade, what would keep it there.' },
                ladder: {
                    type: 'array',
                    description: 'THE LADDER (Sarah, 18 Aug: "a whole system where it shows you what you need to do to get from one mark to another"). EVERY grade ABOVE the one you have given, in order, up to the top of the scheme — one rung each. For each rung, 2-4 concrete things that would lift THIS draft to THAT grade, on top of the rungs below it: name the part (AC / question), the idea to name, the evidence to find, the comparison to make, the sentence to write. Things they can go and do today. Never "develop further". Uses the scheme\'s own grade words. Empty ONLY if the brief names no grades or they are already at the top.',
                    items: { type: 'object', additionalProperties: false, required: ['label', 'needs'], properties: {
                        label: { type: 'string', description: 'The grade word for this rung, e.g. "Merit", "Distinction", "Grade 7", "2:1".' },
                        needs: { type: 'array', items: { type: 'string' }, description: 'What THIS draft still needs for this rung — one concrete thing per line, 8-25 words, naming the part.' },
                    } },
                },
            },
        },
        perCriterion: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['criterionId', 'band', 'label', 'evidence', 'got', 'addNext', 'missingForTop', 'nextQuestion', 'voicedBrickIds', 'termsUsed', 'requirementsMet'],
                properties: {
                    criterionId: { type: 'string' },
                    label: { type: 'string', description: 'The grade THIS part would get on its own, in the student\'s scheme — the same words as the overall label ("Pass", "Merit", "Distinction", "Grade 6"…). Empty only if the scheme names no grades.' },
                    termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of this part\'s EXPECTED TERMS, the ones the draft COVERS — the idea is on the page and doing work in a sentence that says something. It does not matter whether she used that word: her own wording, a synonym, or a plain-English explanation all count — if a marker reading this would credit the point the term stands for, list the term. A word dropped in as a bare label with no idea behind it does NOT count. Give the term in the exact spelling as listed. Empty if none listed.' },
                    requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of this part\'s REQUIREMENTS, the kinds the draft satisfies. Empty if none.' },
                    band: { type: 'string', enum: ['top', 'mid', 'low', 'missing'] },
                    voicedBrickIds: { type: 'array', items: { type: 'string' }, description: 'The model answer\'s brick ids that THIS DRAFT genuinely voices under this criterion (the point made in their words, with its example or reason) — the honest tally the visible score is built from. Empty if none.' },
                    evidence: { type: 'string', description: 'What in THEIR document earns this band — quote a phrase.' },
                    got: { type: 'array', items: { type: 'string' }, description: 'WHAT THEY HAVE GOT, in plain English, one line each, 6-16 words: "you spotted that algorithmic management takes control away from supervisors", "the psychological contract idea is in there", "Hackman and Oldham named correctly". Their actual work, named — never flattery, never a mark-scheme phrase. Empty only if there is genuinely nothing yet.' },
                    addNext: {
                        type: 'array',
                        description: 'WHAT TO ADD NEXT — the heart of the mark. THE STUDENT HAS NOT STUDIED THIS SUBJECT. "Needs the deskilling / neo-Taylorism framing named properly" is useless to them: it names a thing they have never heard of and leaves them stuck. Each item must TEACH the idea and then tell them exactly what to write. 2 to 4 items, most important first.',
                        items: {
                            type: 'object', additionalProperties: false,
                            required: ['title', 'gap', 'concept', 'prompt', 'example'],
                            properties: {
                                title: { type: 'string', description: 'The move, 2-5 words, imperative: "Name the theory", "Explain the accountability gap", "Split the workforce".' },
                                gap: { type: 'string', description: 'ONE sentence, plain English, what is missing — starting from what they DID write: "You described machines taking over the tasks, but you never name what that is."' },
                                concept: { type: 'string', description: 'THE IDEA, TAUGHT. Two or three plain sentences that give them enough to write about it without having studied it: what it is, how it works, why it matters here. "When machines strip the skill and judgement out of a job and reduce it to following instructions, that is neo-Taylorism — Taylor\'s scientific management, reborn through algorithms." Everyday words. Never assume the term is known.' },
                                prompt: { type: 'string', description: 'THE INSTRUCTION: how much to write, about what, tied to THEIR case, and the source if there is one. "Write one sentence naming this where you talk about picking, and cite a source on algorithmic management." Concrete enough to do in the next five minutes.' },
                                example: { type: 'string', description: 'ONE model sentence in a NEUTRAL example — a different company, a general case — that shows the shape of the sentence they need. It is there to be adapted, never pasted: it must NOT be about their own case in a form they could copy word for word onto the page. Empty string if an example would only invite copying.' },
                            },
                        },
                    },
                    missingForTop: { type: 'string', description: 'Exactly what the top band still needs here — concrete, in one or two sentences. Empty string if already top.' },
                    nextQuestion: { type: 'string', description: 'The ONE question that would pull the missing piece out of them. Empty string if already top.' },
                },
            },
        },
        weakestCriterionId: { type: 'string', description: 'The criterion to send them back to first.' },
        critique: {
            type: 'array',
            description: 'MARK & FIX (Sarah, 15 Aug): the sentences you would change, weakest criterion FIRST, then document order. AT MOST 10 — the student works through them one at a time and a longer list is both unreadable and the thing that truncates the whole mark. Only sentences that fall short of the brick they should be voicing; skip sentences that already match.',
            items: {
                type: 'object', additionalProperties: false,
                required: ['sentence', 'missing', 'fix', 'targetBrickId', 'suggestedTools', 'criterionId', 'needs'],
                properties: {
                    needs: { type: 'array', items: { type: 'string', enum: REQ_KINDS }, description: 'The requirement kinds this sentence is missing (from the part\'s REQUIREMENTS) — they show as the coloured dots: "Missing: a figure and a reference (see the dots)". Empty if none.' },
                    sentence: { type: 'string', description: 'The student\'s sentence EXACTLY as numbered in the draft (verbatim, so the page can highlight it).' },
                    missing: { type: 'string', description: 'What is missing, ONE short plain line in coach voice, 12 words or fewer — "You say it, you don\'t show it." Never marker language, never the answer.' },
                    fix: { type: 'string', description: 'The concrete thing to go and DO, ONE short line, 16 words or fewer — "add one piece of evidence: a figure, a quote, a case". Never the words themselves, never a rewritten sentence.' },
                    targetBrickId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    suggestedTools: { type: 'array', items: { type: 'string', enum: ['terminology', 'synonyms', 'dictionary', 'strategies', 'cases', 'references', 'weak'] }, description: 'One to three tools that lead THEM to write it: terminology, synonyms, dictionary, strategies, cases (uploaded sources first), references (uploaded sources first), weak.' },
                    criterionId: { type: 'string', description: 'The criterion this sentence belongs to.' },
                },
            },
        },
    },
};

/** markLikeMarker — the whole draft against the rubric, per criterion. */
// The grade scheme line for the markers. "as the brief says" (the default,
// 17 Aug — a Level 7 CIPD brief was being graded "Grade 2" on GCSE 9–1) means:
// use the words the brief itself uses for its bands; invent no grade labels.
function schemeLine(gradeScheme) {
    const g = String(gradeScheme || '').trim();
    if (!g || /as the brief says/i.test(g)) return 'Grade scheme: the one the brief itself states (its own band / grade words). If the brief names none, give bands only and leave "label" empty — never invent a grade label from another scheme.';
    return `Grade scheme: ${g}.`;
}
async function markLikeMarker({ brief, essay, docText, gradeScheme, plans }) {
    if (!brief || !Array.isArray(brief.criteria) || !brief.criteria.length) throw new Error('No brief yet — upload the task first.');
    if (!String(docText || '').trim()) throw new Error('There is nothing on the page to mark yet.');
    const system = withMission(`You are the examiner for this assignment (the final marking pass — the one place plain marker language is allowed, still phrased plainly to the student). Mark the student's draft strictly against the brief and its criteria, the way the real marker will. ${schemeLine(gradeScheme)}

Rules:
- Every criterion gets a band: top / mid / low / missing (missing = the document does not address it at all).
- Evidence must be from THEIR text — quote a phrase.
- THE MARK TEACHES OR IT IS USELESS. This student has NOT studied the subject — that is the whole reason they are here. Every item of "addNext" gives them: the gap in plain English (starting from what they did write), the idea itself TAUGHT in two or three everyday sentences, the exact instruction (how much to write, where, tied to their own case, with the source), and one model sentence about a DIFFERENT case they can adapt. Marker language with no teaching in it ("needs the deskilling / neo-Taylorism framing named properly") is a failure, however accurate it is.
- "got" is what they have actually done, in plain English — the mark opens with it. Never flattery, never a mark-scheme phrase.
- "missingForTop" is the exact gap for THAT criterion — concrete: the model, example, evaluation, comparison, or evidence the top band expects and they have not given. Not "develop further".
- "nextQuestion" is the one question a tutor would ask to pull that missing piece out of the student. Never contains the answer. It is worded for a student who has NOT read the brief:
${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}
- THE MARK IS PER QUESTION FIRST. Every criterion gets its own grade in their scheme ("label") — that is the mark they act on. A criterion with nothing written for it is band "missing": it is NOT graded, it is "not started", and its "missingForTop" says what it needs to become an answer.
- Overall band = what this draft would get if it were handed in as it is (unanswered questions included — that is the truth of a submission), and "answeredCount" says how many criteria are genuinely attempted, so the student can see the overall grade is dragged by what is not written yet rather than by the quality of what is.
- SAY THE GRADE IN THEIR WORDS, NOT IN BANDS. "label" per part and overall is the grade the scheme actually uses — Pass / Merit / Distinction, Grade 7, 2:1. A student marked on Pass/Merit/Distinction must never be told "lower band"; they are told "Pass" and what stops it being a Merit.
- AND SAY THE WHOLE LADDER. "ladder" is EVERY grade above the one you have given, in order to the top of the scheme, and for each rung the concrete things this draft still needs for it (cumulative — a Distinction rung assumes the Merit rung is done). The student reads it as: I am here; to get X I do these; to get Y, these as well. Never a description of what a grade means — always what THIS draft must add, and in which part.
- AND SAY HOW TO CLIMB. "nextLabel" is the grade immediately above the one you have given; "toNext" is the two or three concrete things that would get THIS draft there — the idea to name, the evidence to find, the part to answer properly, the comparison to make. A student must never be told the grade without being told the way up.
- "voicedBrickIds" per criterion: the bricks of the model answer this draft GENUINELY voices (point made in their words with its reason / example). This is the honest tally the student's visible score is rebuilt from — a listed item is not a voiced brick; a claim without its reason is not a voiced brick.
- EXPECTATIONS per part (below, where a plan exists): report per criterion which expected terms the draft COVERS ("termsUsed" — the idea is on the page doing work; it does not matter whether she used that word, her own wording or a plain-English explanation counts just as much; a bare label with no idea behind it does not) and which requirements it satisfies ("requirementsMet"); in the critique, "needs" = the requirement kinds a sentence is missing.
- MARK & FIX: "critique" is the sentence-by-sentence fix list the student will work through straight after the mark. Weakest criterion first. For each sentence: "missing" (one plain line, coach voice, what is missing), "fix" (the concrete thing to go and do — find one piece of evidence, name the idea, give the example — never the words themselves), the brick it should be voicing, and the tools that lead them there. Copy each sentence VERBATIM from the numbered draft.

THE BRIEF
${briefForPrompt(brief)}
${essay ? '\n' + essayForPrompt(essay).slice(0, 14000) : ''}
${plans ? Object.values(plans).map(p => p && p.criterionId ? '[' + p.criterionId + '] ' + expectationsForPrompt(p) : '').filter(Boolean).join('\n') : ''}`);
    const sentences = splitSentences(docText).map(x => x.trim()).filter(x => x.length > 2).slice(0, 400);
    const user = `STUDENT'S DRAFT (numbered sentences, in order):\n${sentences.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nMark it, then the critique.`;
    // Sarah, 16 Aug, live: "it keeps saying marking failed" — GET
    // /writer/job/mark 502, over and over, on a long dictated draft.
    //
    // The mark is the biggest thing this app asks a model to write, and the
    // budget has to cover BOTH the thinking and the answer (q-claude.js:39 —
    // "thinking shares max_tokens with the answer"). The answer echoes each
    // criticised sentence back VERBATIM, and her sentences are long spoken
    // ones, so a 25-sentence critique plus medium-effort thinking ran past
    // 9,000 tokens; q-claude.js:75 then threw "response truncated", the
    // Together fallback fell over too, and the job came back 502. Nothing was
    // wrong with her draft — the mark simply could not fit in its own budget.
    //
    // So: real headroom, and a critique capped at ten sentences (she works
    // through them one at a time regardless — a longer list is unreadable AND
    // the thing that overflows).
    const r = await callAccurate(system, user, { maxTokens: 20000, schema: MARK_SCHEMA, effort: 'medium' });
    return normaliseMark(r, brief, essay, plans);
}

// ── MARK ONE QUESTION, AS SHE FINISHES IT ─────────────────────────────────
// Sarah, 16 Aug: "we need to have Q doing the mark and fix as you answer each
// question so you actually get direction" — and, in the same breath, "he's
// taking forever to respond."
//
// Both point the same way. The whole-document mark is the most expensive call
// in the app (20,000 tokens, medium effort) and it lands at the very end, when
// the writing is finished and the direction is too late to use. One question's
// worth is a fraction of that: one criterion, her paragraphs for it.
//
// Sarah, 16 Aug, later the same night: "we need the full treatment of the mark
// and fix at every section we write." So this is NOT a lite mark — it is the
// end-of-essay Mark & fix, for ONE question: same rules (weakest first, quote
// her phrase, needs, tools, brick, never a replacement sentence, coach voice),
// up to MAX_CRITIQUE items, medium effort, real headroom — and it reports the
// expected terms used / requirements met the way the full mark does per
// criterion. It runs as a job (routes.js) so Railway's edge cannot kill it.
function partMarkSchema() { return {
    type: 'object', additionalProperties: false,
    required: ['band', 'label', 'nextLabel', 'strongest', 'missingForTop', 'critique', 'termsUsed', 'requirementsMet'],
    properties: {
        band: { type: 'string', enum: ['top', 'mid', 'low', 'missing'] },
        label: { type: 'string', description: 'The grade this part would get on its own, in the student\'s own scheme — "Pass", "Merit", "Distinction", "Grade 6", "2:1". Never band words like "lower band". Empty only if the scheme names no grades.' },
        nextLabel: { type: 'string', description: 'The grade immediately above that one, in the same scheme. Empty if already at the top.' },
        strongest: { type: 'string', description: 'ONE short line naming the best thing she actually did in this part, quoting a few of her own words. Never flattery — if it is thin, say what the one real point is.' },
        missingForTop: { type: 'string', description: 'The ONE concrete thing between this part and the NEXT grade up. A named idea, an example, a figure, a source, the other side of the argument. Never "develop further".' },
        termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of this part\'s EXPECTED TERMS, the ones her answer COVERS — the idea is on the page and doing work in a sentence that says something. It does not matter whether she used that word: her own wording, a synonym, or a plain-English explanation all count — if a marker reading this would credit the point the term stands for, list the term. A word dropped in as a bare label with no idea behind it does NOT count. Give the term in the exact spelling as listed. Empty if none listed / none covered.' },
        requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of this part\'s REQUIREMENTS, the kinds her answer satisfies. Empty if none.' },
        critique: {
            type: 'array',
            description: 'MARK & FIX for this question — the full treatment, the same as the end-of-essay mark: every sentence of hers that falls short of the brick it should be voicing, weakest first, then in order. AT MOST 10 — she works through them one at a time. Skip sentences that already match. Empty if the part is genuinely fine.',
            items: {
                type: 'object', additionalProperties: false,
                required: ['sentence', 'missing', 'say', 'fix', 'targetBrickId', 'suggestedTools', 'needs'],
                properties: {
                    sentence: { type: 'string', description: 'HER sentence, verbatim from the numbered list, so the page can highlight it.' },
                    missing: { type: 'string', description: 'ONE plain line, coach voice, saying what is missing. Never marker jargon. This goes on the WHITEBOARD as the written detail — `say` is what you actually speak to her.' },
                    say: { type: 'string', description: 'What you SAY to her about this sentence, as a person sitting next to her — 1-2 warm sentences. Not a re-reading of `missing` and `fix`; those are written up on the whiteboard beside you. Bring it up the way a tutor would: what she was going for, what is off, and the offer. "The citation on this one is about laser fibres, not jobs — easy fix, want me to find one that actually covers deskilling?" Never marker jargon, never a rewritten sentence.' },
                    fix: { type: 'string', description: 'The concrete thing to go and do — name the idea, give one example, put a number on it, back it with a source. NEVER the words themselves.' },
                    targetBrickId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    suggestedTools: { type: 'array', items: { type: 'string', enum: EDIT_TOOLS.concat(['cite']) } },
                    needs: { type: 'array', items: { type: 'string', enum: REQ_KINDS } },
                },
            },
        },
    },
}; }
// ONE POINT of a question (Sarah, 16 Aug: "if he's broken the question down
// into 4 and he's had me write about equality, when I've done that bit he
// needs to put those marks on it so I know where I'm going wrong — obviously
// not every time I write a sentence"). `focus` = the step's ask, in her
// words; `targetBrickIds` = the bricks that step was drawing out. With a
// focus the marker judges THAT point only, against THOSE bricks.
async function markPart({ brief, essay, plan, criterionId, partText, gradeScheme, focus, targetBrickIds, stepId }) {
    if (!brief || !Array.isArray(brief.criteria)) throw new Error('No brief yet — upload the task first.');
    const crit = brief.criteria.find(c => c.id === criterionId);
    if (!crit) throw new Error('That part is not in the brief.');
    const text = String(partText || '').trim();
    const focusText = String(focus || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return { criterionId, stepId: stepId || null, band: 'missing', strongest: '', missingForTop: focusText ? 'There is nothing on the page for this point yet.' : 'There is nothing on the page for this part yet.', termsUsed: [], requirementsMet: [], critique: [] };
    const allBricks = bricksOfCriterion(essay, criterionId);
    const wantIds = new Set((Array.isArray(targetBrickIds) ? targetBrickIds : []).map(x => String(x).replace(/\s+/g, '')));
    const bricks = focusText && wantIds.size && allBricks.some(b => wantIds.has(b.brickId)) ? allBricks.filter(b => wantIds.has(b.brickId)) : allBricks;
    const system = withMission(`You are marking ${focusText ? 'ONE POINT of one question' : 'ONE question'} of this assignment, the moment the student finishes it — so the direction arrives while they can still use it. ${schemeLine(gradeScheme)}
${focusText ? `\nTHE POINT BEING MARKED (what they were asked to write, in plain words): ${focusText}\n- Judge ONLY whether THIS point is made well. Do not mark them down for things that belong to other points of the question.\n- "band" is the band for this point alone.` : ''}

Rules:
- Judge ONLY this question. Say nothing about the rest of the document.
- Evidence is their own words: quote a phrase of theirs.
- "missingForTop" is the ONE thing between this and the next grade up, concrete enough to act on in the next five minutes.
- SAY THE GRADE IN HER WORDS: "label" is the grade her scheme uses (Pass / Merit / Distinction, Grade 7, 2:1), never "lower band"; "nextLabel" is the one above it. A grade with no way up is not marking.
- MARK & FIX — the full treatment, exactly as the end-of-essay mark does it: "critique" is the sentence-by-sentence fix list she works through straight away. Every sentence of hers that falls short of the brick it should be voicing, weakest first, then in order (at most ten). For each: "missing" (one plain line, coach voice, what is missing), "fix" (the concrete thing to go and DO — find one piece of evidence, name the idea, give the example, put a number on it — never the words themselves), the brick it should be voicing ("targetBrickId"), the requirement kinds it lacks ("needs" — they show as the coloured dots), and the one to three tools that lead HER to write it. Copy each sentence VERBATIM from the numbered list. If the part is genuinely fine, return an empty critique and say so in "strongest".
- EXPECTATIONS: report which expected terms her answer COVERS ("termsUsed" — the idea is on the page doing work; it does not matter whether she used that word, her own wording or a plain-English explanation counts just as much; a bare label with no idea behind it is NOT covered) and which requirements it satisfies ("requirementsMet").
- Never write a replacement sentence. The fix says what to go and do, never the words.
- Coach voice, no marker language in anything she reads.
${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}

THIS QUESTION
${crit.id} — ${crit.text}
${plan && plan.minimalAsk ? 'In plain words: ' + plan.minimalAsk : ''}
${expectationsForPrompt(plan)}
${bricks.length ? '\nWHAT A TOP ANSWER CONTAINS (your model answer — never quote it to them):\n' + bricks.map(b => `(${b.brickId}) ${b.gist}`).join('\n') : ''}`);
    const sentences = splitSentences(text).map(x => x.trim()).filter(x => x.length > 2).slice(0, 60);
    const user = `THEIR ANSWER TO THIS QUESTION (numbered sentences):\n${sentences.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nMark this question.`;
    // Full treatment ⇒ the full mark's effort, and headroom for up to ten
    // verbatim sentences plus thinking (the whole-document mark needed 20,000
    // for ~30 sentences across every part; one part gets 9,000).
    const r = await callAccurate(system, user, { maxTokens: 9000, schema: partMarkSchema(), effort: 'medium' });
    const brickIds = new Set(bricks.map(b => b.brickId));
    const kinds = new Set(((plan && plan.requirements) || []).map(x => x.kind));
    const critique = (Array.isArray(r && r.critique) ? r.critique : []).map(it => ({
        sentence: String(it.sentence || '').trim(),
        missing: capWords(it.missing, 12),
        // Q's spoken line for this sentence — the chat half of say-and-show.
        // NOT capped to a few words: it is talk, not a label.
        say: String(it.say || '').replace(/\s+/g, ' ').trim().slice(0, 320),
        fix: capWords(it.fix, 16),
        targetBrickId: it.targetBrickId && brickIds.has(String(it.targetBrickId).replace(/\s+/g, '')) ? String(it.targetBrickId).replace(/\s+/g, '') : null,
        suggestedTools: (Array.isArray(it.suggestedTools) ? it.suggestedTools : []).map(String).filter(t => EDIT_TOOLS.includes(t) || t === 'cite').slice(0, 3),
        needs: (Array.isArray(it.needs) ? it.needs : []).map(String).filter(k => REQ_KINDS.includes(k)),
        criterionId,
    })).filter(it => it.sentence && (it.missing || it.fix)).slice(0, MAX_CRITIQUE);
    return {
        criterionId,
        stepId: stepId || null,
        band: ['top', 'mid', 'low', 'missing'].includes(r && r.band) ? r.band : 'low',
        label: String((r && r.label) || ''),
        nextLabel: String((r && r.nextLabel) || ''),
        strongest: capWords(r && r.strongest, 22),
        missingForTop: capWords(r && r.missingForTop, 22),
        // termCanon: the plan's spelling, so the route's set add/delete matches.
        termsUsed: (r && Array.isArray(r.termsUsed) ? r.termsUsed : []).map(x => termCanon(plan, x)).filter(Boolean),
        requirementsMet: (r && Array.isArray(r.requirementsMet) ? r.requirementsMet : []).map(String).filter(x => kinds.has(x)),
        critique,
    };
}

function normaliseMark(r, brief, essayForMark, plans) {
    if (!r || typeof r !== 'object' || !r.overall) throw new Error('The marking came back empty — try again.');
    const ids = brief.criteria.map(c => c.id);
    const seen = new Set();
    const brickIdsAll = new Set(allBrickIds(essayForMark).map(b => b.brickId));
    const per = (Array.isArray(r.perCriterion) ? r.perCriterion : []).map(p => ({
        criterionId: String(p.criterionId || '').replace(/\s+/g, ''),
        band: ['top', 'mid', 'low', 'missing'].includes(p.band) ? p.band : 'low',
        label: String(p.label || ''),
        voicedBrickIds: (Array.isArray(p.voicedBrickIds) ? p.voicedBrickIds : []).map(x => String(x).replace(/\s+/g, '')).filter(x => brickIdsAll.has(x) && x.split('-')[0] === String(p.criterionId || '').replace(/\s+/g, '')),
        // Canonical spelling (termCanon) — the route adds and removes these by
        // exact string, so the mark must spell them the way the plan does.
        termsUsed: (Array.isArray(p.termsUsed) ? p.termsUsed : []).map(x => termCanon(plans && plans[String(p.criterionId || '').replace(/\s+/g, '')], x)).filter(Boolean),
        requirementsMet: (Array.isArray(p.requirementsMet) ? p.requirementsMet : []).map(String).filter(x => { const pl = plans && plans[String(p.criterionId || '').replace(/\s+/g, '')]; return pl && (pl.requirements || []).some(rq => rq.kind === x); }),
        evidence: String(p.evidence || ''),
        got: (Array.isArray(p.got) ? p.got : []).map(String).map(x => x.trim()).filter(Boolean).slice(0, 4),
        addNext: (Array.isArray(p.addNext) ? p.addNext : []).map(a => ({
            title: String((a && a.title) || '').trim(),
            gap: String((a && a.gap) || '').trim(),
            concept: String((a && a.concept) || '').trim(),
            prompt: String((a && a.prompt) || '').trim(),
            example: String((a && a.example) || '').trim(),
        })).filter(a => a.title && (a.concept || a.prompt)).slice(0, 4),
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
        missing: capWords(it.missing, 12),
        fix: capWords(it.fix, 16),
        targetBrickId: it.targetBrickId && brickIds.has(String(it.targetBrickId).replace(/\s+/g, '')) ? String(it.targetBrickId).replace(/\s+/g, '') : null,
        suggestedTools: (Array.isArray(it.suggestedTools) ? it.suggestedTools : []).map(String).filter(t => EDIT_TOOLS.includes(t)).slice(0, 3),
        needs: (Array.isArray(it.needs) ? it.needs : []).map(String).filter(k => REQ_KINDS.includes(k)),
        criterionId: ids.includes(String(it.criterionId || '').replace(/\s+/g, '')) ? String(it.criterionId).replace(/\s+/g, '') : (it.targetBrickId ? String(it.targetBrickId).split('-')[0] : ''),
    })).filter(it => it.sentence && (it.missing || it.fix))
      .sort((a, b) => ((bandOf[a.criterionId] ?? 9) - (bandOf[b.criterionId] ?? 9)) || (a.i - b.i))
      .map(({ i, ...rest }) => rest)
      .slice(0, MAX_CRITIQUE);   // the schema asks for ten; this is what makes it ten
    return {
        overall: {
            band: ['top', 'mid', 'low'].includes(r.overall.band) ? r.overall.band : 'low',
            label: String(r.overall.label || ''),
            summary: String(r.overall.summary || ''),
            strong: (Array.isArray(r.overall.strong) ? r.overall.strong : []).map(String).filter(Boolean).slice(0, 4),
            missing: (Array.isArray(r.overall.missing) ? r.overall.missing : []).map(String).filter(Boolean).slice(0, 6),
            answeredCount: Number.isFinite(r.overall.answeredCount) ? r.overall.answeredCount : null,
            // The grade above, and how to get it (Sarah, 17 Aug: "it doesn't
            // actually say why or what's weak or how you can get to the next
            // grade"). A grade with no way up is not marking, it is scoring.
            nextLabel: String(r.overall.nextLabel || ''),
            toNext: String(r.overall.toNext || ''),
            // Every grade above, in order, and what each takes (18 Aug).
            ladder: (Array.isArray(r.overall.ladder) ? r.overall.ladder : []).map(x => ({ label: String((x && x.label) || '').trim(), needs: (Array.isArray(x && x.needs) ? x.needs : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 5) })).filter(x => x.label && x.needs.length).slice(0, 6),
        },
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
    return { document: doc, wordCount: Number(r.wordCount) || doc.trim().split(/\s+/).filter(Boolean).length, changes: Array.isArray(r.changes) ? r.changes.map(String).slice(0, 6) : [] };
}


// ─── THE CASE STUDY, SO SHE NEVER HAS TO READ IT ──────────────────────────
// Sarah, 16 Aug: "it's expecting you to have read the case study. I need to
// be able to do this without reading it so I need him to simplify it as much
// as possible so I don't have to read it. and put that in the brief."
//
// Same principle as the brief itself: Q reads it, she doesn't. A supporting
// document used to go into the hidden essay and nowhere else — she got a
// chip with a filename and "Q is reading it into his plan". This makes the
// digest: the plain-words version that lets her answer questions about the
// case as if she'd read it. One small call per source, stored with the
// source, shown on the brief board.
const SOURCE_DIGEST_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['name', 'kind', 'whatItIs', 'theStory', 'facts', 'sections', 'people', 'numbers', 'strengths', 'problems', 'useIt'],
    properties: {
        name: { type: 'string', description: 'The SUBJECT of this document in as few words as possible — the organisation, person, case or text it is about. Usually one or two words: "Datacore", "Portstride", "R v Brown", "Nestlé UK". Copied exactly as written. Never a sentence. Empty string only if the document truly names nothing.' },
        kind: { type: 'string', description: 'What that subject IS, in 3-6 words, no verb. "Global logistics and supply chain", "Mid-sized software firm", "Criminal appeal, House of Lords". Never a sentence.' },
        whatItIs: { type: 'string', description: 'ONE plain sentence: what this document is. "A case study about a mid-sized software firm, Datacore, and how it pays its people."' },
        theStory: { type: 'string', description: 'The whole thing in 3-5 short plain sentences, as you would tell a friend who has not read it. Everyday words. What the organisation is, what happened, where it is now. This is what she reads INSTEAD of the document.' },
        people: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who', 'what'], properties: { who: { type: 'string', description: 'A name or role, e.g. "Priya (HR Director)".' }, what: { type: 'string', description: 'One short line: who they are and what they want / did.' } } }, description: 'The named people or roles that matter. Up to 6. Empty if none.' },
        numbers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } }, description: 'The figures worth having to hand — headcount, turnover, salaries, dates, percentages, budgets. Copied EXACTLY as the document states them, never rounded or invented. Up to 10. Empty if none.' },
        strengths: { type: 'array', items: { type: 'string' }, description: 'What the subject has GOING FOR IT — the pros, one short line each, the figure in the line where there is one ("4,800 staff across 12 countries", "30 years in the market"). These read next to `problems` as a pros-and-cons pair on the fact card. Up to 6. Empty if none.' },
        problems: { type: 'array', items: { type: 'string' }, description: 'What is going AGAINST it — the cons: the problems, tensions and decisions the case sets up, each ONE short plain line, the figure in the line where there is one ("struggling to pay salaries", "loses too many warehouse staff"). These are usually what the questions are about. Up to 6.' },
        facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } }, description: 'THE OVERVIEW TABLE, the way a company fact sheet opens — what the subject IS, in label/value rows: Industry, Size, Headquarters, Founded, Operations, Services, Client sectors, Competitive advantage, Sector, Jurisdiction, Date — whichever of these the document actually states, in its own words. Value 2-12 words, copied, never invented, never a sentence. Up to 10 rows. Empty only if the document states no such facts.' },
        sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heading', 'icon', 'bullets'], properties: { heading: { type: 'string', description: 'The section title in the document\'s own terms, 2-5 words, whatever THIS document calls its parts — a company case: "The workforce", "Market pressures", "The change programme"; a science or data brief: "Method", "Results", "Limitations"; a text or history: "Chapter 3 — the storm", "Causes of the war"; a policy: "Who it applies to", "The obligations".' }, icon: { type: 'string', description: 'ONE emoji that fits the section, or an empty string.' }, bullets: { type: 'array', items: { type: 'string' }, description: 'Up to 6 points, one line each, figures and proportions copied exactly ("65% operational — warehouse staff and drivers"). Everyday words. Never a paragraph.' } } }, description: 'THE BODY OF THE FACT SHEET — the document broken into the sections it actually has, in its order, each with its points. This is what the student reads INSTEAD of the document, so nothing a question could hinge on is left out. Up to 6 sections. Empty if the document is too short to have sections.' },
        useIt: { type: 'string', description: 'ONE plain sentence telling her how this document is meant to be used in her answers — "when a question says \'the organisation\', it means this company; use its numbers and its problems as your examples."' },
    },
};
// The story INSIDE a brief that was read before `scenario` existed — one small
// call over the stored brief text, same shape as a source digest. Returns
// null (not an error) when the document has no scenario in it.
async function extractScenario({ taskText, brief }) {
    const body = String(taskText || '').trim();
    if (!body) return null;
    const system = withMission(`You are Q, reading an assignment document FOR the student so they never have to. Find the SCENARIO the questions are about — the case study, the company, the situation, the text — and tell it plainly. Everyday British English, short, concrete. Figures copied exactly. Names as written. If the document has no scenario at all (it is questions and criteria only), return scenario: null.
${brief ? '\nTHE QUESTIONS (already extracted):\n' + (brief.criteria || []).map(c => '- ' + c.text).join('\n') : ''}`);
    const user = `THE DOCUMENT:\n\n${body.slice(0, 60000)}\n\nTell the scenario for someone who will not read this.`;
    const schema = { type: 'object', additionalProperties: false, required: ['scenario'], properties: { scenario: BRIEF_SCHEMA.properties.scenario } };
    const r = await callAccurate(system, user, { maxTokens: 1800, schema, effort: 'low' });
    // null means "the document has no scenario" — that is the model's call
    // (scenario: null), not what an empty object or a blank story means. Those
    // are a failed read and must retry, not sit as "no scenario" for ever.
    if (!r || typeof r !== 'object' || !('scenario' in r)) throw new Error('Q could not read that document — try again.');
    if (r.scenario === null) return null;
    const sc = r.scenario && typeof r.scenario === 'object' ? r.scenario : null;
    if (!sc || !(String(sc.theStory || '').trim() || String(sc.whatItIs || '').trim())) throw new Error('Q could not read that document — try again.');
    return {
        name: String(sc.name || '').trim().slice(0, 60),
        kind: String(sc.kind || '').trim().slice(0, 80),
        whatItIs: String(sc.whatItIs || '').trim(),
        theStory: String(sc.theStory || '').trim(),
        facts: (Array.isArray(sc.facts) ? sc.facts : []).map(f => ({ label: String((f && f.label) || '').trim(), value: String((f && f.value) || '').trim() })).filter(f => f.label && f.value).slice(0, 10),
        sections: (Array.isArray(sc.sections) ? sc.sections : []).map(x => ({ heading: String((x && x.heading) || '').trim(), icon: String((x && x.icon) || '').trim().slice(0, 4), bullets: (Array.isArray(x && x.bullets) ? x.bullets : []).map(String).map(b => b.trim()).filter(Boolean).slice(0, 6) })).filter(x => x.heading && x.bullets.length).slice(0, 6),
        people: (Array.isArray(sc.people) ? sc.people : []).map(p => ({ who: String((p && p.who) || '').trim(), what: String((p && p.what) || '').trim() })).filter(p => p.who).slice(0, 6),
        numbers: (Array.isArray(sc.numbers) ? sc.numbers : []).map(n => ({ label: String((n && n.label) || '').trim(), value: String((n && n.value) || '').trim() })).filter(n => n.label && n.value).slice(0, 10),
        strengths: (Array.isArray(sc.strengths) ? sc.strengths : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
        problems: (Array.isArray(sc.problems) ? sc.problems : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
        useIt: String(sc.useIt || '').trim(),
    };
}

async function digestSource({ name, text, brief }) {
    const body = String(text || '').trim();
    if (!body) throw new Error('That document is empty.');
    const system = withMission(`You are Q, reading a supporting document FOR the student so they never have to. They will answer questions about it as if they had read it — from your digest alone. So: plain everyday British English, short, concrete, nothing left out that a question could hinge on, nothing added that is not in the document. Figures copied exactly. Names as written. No marker language, no advice on what to write.
${brief ? '\nTHE ASSIGNMENT THIS DOCUMENT SUPPORTS (so you know what matters in it):\n' + briefForPrompt(brief).slice(0, 3000) : ''}`);
    const user = `DOCUMENT: ${name || 'supporting document'}\n\n${body.slice(0, 60000)}\n\nDigest it for someone who will not read it.`;
    const r = await callAccurate(system, user, { maxTokens: 1800, schema: SOURCE_DIGEST_SCHEMA, effort: 'low' });
    // An empty {} used to become an all-blank digest, stored as if it were
    // done. Throw instead so the route's retry path (and the page's retry) fire.
    if (!r || !(String(r.theStory || '').trim() || String(r.whatItIs || '').trim())) throw new Error('Q could not read that document — try again.');
    return {
        name: String((r && r.name) || '').trim().slice(0, 60),
        kind: String((r && r.kind) || '').trim().slice(0, 80),
        whatItIs: String((r && r.whatItIs) || '').trim(),
        theStory: String((r && r.theStory) || '').trim(),
        facts: (Array.isArray((r || {}).facts) ? (r || {}).facts : []).map(f => ({ label: String((f && f.label) || '').trim(), value: String((f && f.value) || '').trim() })).filter(f => f.label && f.value).slice(0, 10),
        sections: (Array.isArray((r || {}).sections) ? (r || {}).sections : []).map(x => ({ heading: String((x && x.heading) || '').trim(), icon: String((x && x.icon) || '').trim().slice(0, 4), bullets: (Array.isArray(x && x.bullets) ? x.bullets : []).map(String).map(b => b.trim()).filter(Boolean).slice(0, 6) })).filter(x => x.heading && x.bullets.length).slice(0, 6),
        people: (Array.isArray(r && r.people) ? r.people : []).map(p => ({ who: String((p && p.who) || '').trim(), what: String((p && p.what) || '').trim() })).filter(p => p.who).slice(0, 6),
        numbers: (Array.isArray(r && r.numbers) ? r.numbers : []).map(n => ({ label: String((n && n.label) || '').trim(), value: String((n && n.value) || '').trim() })).filter(n => n.label && n.value).slice(0, 10),
        strengths: (Array.isArray(r && r.strengths) ? r.strengths : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
        problems: (Array.isArray(r && r.problems) ? r.problems : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
        useIt: String((r && r.useIt) || '').trim(),
        madeAt: Date.now(),
    };
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
    const essay = normaliseEssay(r, brief);
    // A criterion the model skipped (or gave empty paragraphs) used to vanish
    // here — and planPart then said "not written yet" for ever, because the
    // essay existed and nothing would ever write that part. One small top-up
    // call for JUST the missing parts, merged in brief order; if it still
    // comes back empty the job fails visibly (retryable) instead of silently.
    const missing = brief.criteria.filter(c => !essay.perCriterion.some(p => p.criterionId === c.id));
    if (missing.length) {
        const ids = missing.map(c => c.id);
        const topUp = `${user}\n\nThe model answer above is already written for every part EXCEPT these — write ONLY these parts, with these exact criterionIds, at least one paragraph each: ${ids.join(', ')}.`;
        const r2 = await callAccurate(system, topUp, { maxTokens: 6000, schema: ESSAY_SCHEMA, effort: 'medium' });
        const extra = normaliseEssay(r2, { ...brief, criteria: missing });
        const byId = new Map(essay.perCriterion.concat(extra.perCriterion).map(p => [p.criterionId, p]));
        essay.perCriterion = brief.criteria.map(c => byId.get(c.id)).filter(Boolean);
        const still = ids.filter(id => !byId.has(id));
        if (still.length) throw new Error(`The model answer came back empty for ${still.join(', ')} — try again.`);
    }
    return essay;
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
// facts (Sarah, 17 Aug): "for every problem Q presents we need to have a
// button. ie find facts in the case to support this sentence. Q then pulls
// up a list of things you could use." From the case / brief text she
// uploaded (and any sources) — never from Q's own head.
// bridge (Sarah, 17 Aug, on the Auto cite card): "the bit 'now put that in
// your own words' — these instructions need to stand out… and ideas on what
// to write." Ideas = angles for HER line linking the source to her case.
const EDIT_TOOLS = ['terminology', 'synonyms', 'dictionary', 'strategies', 'cases', 'references', 'weak', 'facts', 'bridge'];
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
    })).filter(it => it.sentence && it.why).slice(0, 30);
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
        headline: { type: 'string', description: 'The thing itself: the term / the word / the framework name / the case name / the reference (Harvard) / the one-line "what is weak". Short — 8 words or fewer unless it is a Harvard reference.' },
        points: { type: 'array', items: { type: 'string' }, description: 'SHORT lines, 14 words or fewer each: terminology / strategies / weak / cases = 1 to 3 lines; dictionary = 1 or 2; synonyms = 5-8 options, each "word — shade of meaning". This is a small popup card, not a lesson. Plain words.' },
        example: nullable('string'),
        nudge: { type: 'string', description: 'One line pushing them to write it: "Now say your sentence using it." Never the sentence.' },
        fromSource: nullable('string'),
        flagged: { type: 'boolean', description: 'CONFIDENCE, NOT PROVENANCE. true ONLY when you are genuinely unsure a detail is right — a figure you half-remember, a date, an attribution you would not bet on. Established, textbook material (Hackman & Oldham\'s job characteristics model, Maslow, the Equality Act 2010, Taylorism) is NOT flagged just because it did not come from her uploads: that it is not in her documents says nothing about whether it is true. Sarah, 17 Aug: "why are we telling users that this might be wrong?" — she is a student who does not know the subject, so "check it" is an instruction she cannot follow. If you are not confident enough to say it plainly, do not say it: leave it out, or say what kind of source would settle it. Provenance is carried by fromSource, which is a separate field.' },
        strength: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'bridge tool ONLY (null for every other tool): how strongly the source backs the student\'s sentence — exactly "strong", "fair" or "weak", then " — " and why in 12 words or fewer ("strong — a peer-reviewed study on exactly this", "weak — about retail, not warehousing").' },
        todo: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], description: 'facts tool ONLY (null for every other tool): 2 to 4 numbered steps telling the student WHAT TO DO with the facts — which fact to use (by its number), where in their paragraph it goes (after which of their words), and what to say it shows for the point. Plain, each 20 words or fewer. Never the sentence for them.' },
    },
};
const TOOL_BRIEFS = {
    terminology: 'TERMINOLOGY: give the right academic/professional term for what their sentence is trying to say (headline), a plain one-line meaning (points[0]), an everyday example (example), then the nudge "Now say your sentence using it."',
    synonyms: 'SYNONYMS: for the word they picked (or the weakest word in the sentence if none given), 5-8 alternatives (points), each "word — the shade of meaning / when to use it". headline = the word. example = null.',
    dictionary: 'DICTIONARY: the plain-English definition of the word they picked (or the key term in the sentence) — headline = the word, points = one or two definitions in everyday words, example = a sentence from everyday life (NOT their sentence rewritten).',
    strategies: 'STRATEGIES / THEORIES: name the framework, model or theory that fits HERE (headline), one line on why it fits this exact sentence (points[0]), one line on what it says (points[1]), an everyday example (example), then the nudge.',
    cases: 'CASE STUDIES: a real case or company that illustrates the point — FROM THE UPLOADED SOURCES FIRST (fromSource = the document name); only if none fits, one from your own knowledge that you are CONFIDENT is real. Never invent, and never offer one you would not stand behind — she cannot check it, so an unsure case is worse than no case. flagged=true only if a specific detail (a figure, a year) is one you are unsure of. headline = the case, points = what happened and why it fits here.',
    references: 'REFERENCES: support for the claim in the sentence — FROM THE UPLOADED SOURCES FIRST (fromSource = document name, flagged=false), formatted Harvard in the headline with the inline citation in points[0]; otherwise a real, well-known work you are confident exists (flagged=true, mark [verify] on any doubtful detail). NEVER invent a source. If nothing real supports it, say so in the headline and suggest what kind of source would.',
    weak: 'WHAT IS WEAK: one plain line on what is weak in this sentence (headline), two or three lines on what a strong version would DO — name the idea, give an example, show why it matters (points) — never the strong sentence itself. Then the nudge.',
    bridge: 'IDEAS FOR THE LINE THAT USES THE SOURCE: the student just cited a source after their sentence; THE WORD THEY PICKED holds what the source actually says. Also judge in strength how strongly this source backs THAT sentence (strong / fair / weak — and why, honestly: topic match, kind of source, date). Give 3 angles for the ONE line they now write in their own words linking the source to THEIR case — each point 8-16 words, starting "Say how…" / "Say why…" / "Point out that…", tied to a real name, figure or situation from the brief. headline = "Ideas for your line" (exactly). example = null. Never a sentence for them to paste; never quote the source back.',
    facts: 'FIND FACTS IN THE CASE (Sarah, 17 Aug: "list facts that I could use and then suggest what to do"): from THE CASE / BRIEF TEXT below (and the uploaded sources), list 3 to 6 FACTS the student could USE for this sentence — a figure, a name, an event, a decision, a quoted line — the concrete, checkable kind, not themes. Each point = the fact as the text has it (numbers, names and quoted words VERBATIM, 4 to 16 words) + " — " + where it sits in the case (the section / paragraph / who says it, 2 to 6 words). No "how it helps" in the points — that goes in todo. todo = 2 to 4 steps: WHAT TO DO — which fact (by number) to use, after which of the student\'s own words it goes, and what to say it shows for THIS point; never the sentence itself. headline = "From the case: N facts you could use" (or, if the case has nothing for this sentence, say so and name the kind of evidence that would). fromSource = "the brief" or the document name. flagged = false unless a fact is NOT in the text. NEVER invent a fact, a number or a name that is not in the text. example = null. nudge = one line, warm, pushing them to write it in their own words.',
};

async function toolHelp({ tool, sentence, word, brickId, brief, essay, sources, yearGroup, caseText, want, focus }) {
    if (!EDIT_TOOLS.includes(tool)) throw new Error('Unknown tool.');
    if (!String(sentence || '').trim()) throw new Error('No sentence to work on.');
    const srcBlock = (tool === 'cases' || tool === 'references' || tool === 'strategies')
        ? `UPLOADED SOURCES:\n${sourcesForPrompt(sources, { perSource: 12000, total: 30000 })}`
        : tool === 'facts'
        ? `THE CASE / BRIEF TEXT (the only place facts may come from):\n${String(caseText || '').slice(0, 40000) || '(the brief text is not stored — use only THE SCENARIO in the brief above)'}\n\nUPLOADED SOURCES:\n${sourcesForPrompt(sources, { perSource: 8000, total: 16000 })}` : '';
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Pitch it at their level.` : '';
    const system = withMission(`You are Q in the EDITING stage. The student has one sentence highlighted on their page and pressed a tool button. Give ONLY the help that tool gives, in the shape below, so THEY can rewrite the sentence themselves.
${TOOL_BRIEFS[tool]}
${ageHint}
Rules: plain everyday British English; short; never a rewritten version of their sentence; never reveal the target.

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 4000)}
${targetForPrompt(brief, essay, brickId)}`);
    const WANT = { figures: 'FIGURES — numbers, percentages, money, dates, counts, as the text has them', examples: 'EXAMPLES — events, decisions, named people or roles, things that happened', quotes: 'QUOTES — short lines from the text, verbatim, that could be quoted' };
    const wantLine = tool === 'facts' && WANT[String(want || '')] ? `\nTHEY WANT: ${WANT[want]}. Give those first; other useful facts after.` : '';
    const focusLine = focus ? `\nWHAT THE MARKER EXPECTS AT THIS POINT (the plan's own requirement — name THIS, not a different one): ${String(focus).slice(0, 300)}` : '';
    const user = `THE HIGHLIGHTED SENTENCE: "${String(sentence).slice(0, 600)}"${word ? `\nTHE WORD THEY PICKED: "${String(word).slice(0, 60)}"` : ''}${wantLine}${focusLine}\n${srcBlock}\n\nGive the ${tool} help.`;
    const r = await callAccurate(system, user, { maxTokens: tool === 'facts' ? 1800 : 1200, schema: TOOL_SCHEMA, effort: 'low' });
    if (!r || typeof r !== 'object' || !String(r.headline || '').trim()) throw new Error('The tool came back empty — try again.');
    return {
        tool,
        headline: tool === 'references' ? String(r.headline).trim() : capWords(r.headline, tool === 'facts' ? 12 : 8),
        points: (Array.isArray(r.points) ? r.points : []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
        example: r.example ? String(r.example).trim() : null,
        nudge: String(r.nudge || 'Now say your sentence using it.').trim(),
        fromSource: r.fromSource ? String(r.fromSource).slice(0, 160) : null,
        flagged: !!r.flagged,
        todo: tool === 'facts' && Array.isArray(r.todo) ? r.todo.map(x => capWords(String(x), 26)).filter(Boolean).slice(0, 4) : null,
        strength: tool === 'bridge' && r.strength ? String(r.strength).trim().slice(0, 120) : null,
    };
}

// ── PROOFREAD (Sarah, 17 Aug: "an editing panel where we can press spelling
// and it will highlight all spelling mistakes… words, phrases, grammar").
// One pass over the page for ONE kind of slip. Every "wrong" is a VERBATIM
// span of her text (so the page can find and mark it); "right" is the
// minimal correction of that span alone. Never style, never her argument,
// never a rewritten sentence — spelling is spelling, grammar is grammar.
// TRIM (Sarah, 17 Aug): "a button to highlight unnecessary writing. like if
// someone's written 3 lines about something that the essay could do without.
// the feedback will need to be varied though. there needs to be outright
// 'don't need this' and 'we need this but get to the point'." Same rails as
// spelling / grammar — verbatim spans, marked on the page, Fix / Fix all —
// with a VERDICT per span: cut (right = '') or tighten (right = the same
// point in fewer words, her words kept as far as possible).
// Sarah, 17 Aug, on seeing "right" for tighten: "no. Q can not write anything
// to go on the page. he will have to coach them in to writing it shorter." So
// a trim span carries a STEER (what to keep, what to lose), never a rewrite.
// WEAK (same night): "the what's weak should cover the whole page not
// highlighted" — a pass over the page that marks the weak sentences with why
// and what would make each strong. Coaching passes: nothing to paste in.
const PROOF_KINDS = ['spelling', 'grammar', 'trim', 'weak'];
const PROOF_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['issues'],
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['wrong', 'right', 'why'],
                properties: {
                    wrong: { type: 'string', description: 'The exact span from the text, character for character (2 to 12 words for grammar; the single misspelt word for spelling). It MUST appear verbatim in the text.' },
                    right: { type: 'string', description: 'That span corrected — the smallest change that fixes it. Same words otherwise.' },
                    why: { type: 'string', description: 'Five to ten plain words: what was wrong ("its → it\'s: belongs-to vs it is").' },
                },
            },
        },
    },
};
const TRIM_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['issues'],
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['wrong', 'verdict', 'why', 'steer'],
                properties: {
                    wrong: { type: 'string', description: 'The exact span from the text, character for character — one whole sentence, or two or three sentences that run together. It MUST appear verbatim in the text. Never a fragment of a sentence.' },
                    verdict: { type: 'string', enum: ['cut', 'tighten'], description: 'cut = the essay does not need this at all (repeats a point already made, off the question, padding, filler, a preamble). tighten = the point IS needed but it takes too long to make.' },
                    why: { type: 'string', description: 'Plain words for a student, 6 to 14: for cut, why the essay does not need it ("says the same as the sentence before"); for tighten, why it is too long ("three sentences for one point").' },
                    steer: { type: 'string', description: 'For tighten: ONE line telling the student what to KEEP and what to LOSE when they rewrite it themselves ("keep the 12% figure and the example; lose the run-up") — never the rewritten sentence, never new words for them to paste. For cut: an empty string.' },
                },
            },
        },
    },
};
const PROOF_BRIEFS = {
    spelling: 'SPELLING ONLY: words spelt wrong (technowlogy → technology, desisions → decisions, loose → lose where "lose" is meant, veriety → variety, safty → safety). British spelling is correct (organisation, colour, programme). Proper nouns, brand names and the names in the brief are not mistakes. Do NOT touch grammar, punctuation, word choice or style.',
    grammar: 'GRAMMAR AND PUNCTUATION ONLY: subject–verb agreement, tense slips, missing or wrong apostrophes (its/it\'s, employees\' ), run-on sentences that need a full stop, a missing capital at a sentence start, "there/their/they\'re", "effect/affect", double words ("on on"). Do NOT change spelling that is merely non-standard, word choice, style, or the argument. The smallest fix only.',
};
async function proofread({ text, kind, context }) {
    if (!PROOF_KINDS.includes(kind)) throw new Error('Unknown proofreading pass.');
    const body = String(text || '').trim();
    if (!body) throw new Error('There is nothing on the page to check yet.');
    if (kind === 'trim') return trimPass(body, context);
    if (kind === 'weak') return weakPass(body, context);
    const system = withHouseStyle(`You are proofreading a student\'s draft for ONE kind of slip. ${PROOF_BRIEFS[kind]}
Return every instance you find (up to 60), each as the exact span from the text and its minimal correction. If there are none, return an empty list. Never rewrite sentences; never comment on content.`);
    const user = `THE TEXT:
${body.slice(0, 60000)}

List the ${kind} slips.`;
    const r = await callAccurate(system, user, { maxTokens: 6000, schema: PROOF_SCHEMA, effort: 'low' });
    const seen = new Set();
    const issues = (Array.isArray(r && r.issues) ? r.issues : []).map(x => ({ wrong: String(x.wrong || '').trim(), right: String(x.right || '').trim(), why: capWords(x.why, 14) }))
        // real, findable, and a change
        .filter(x => x.wrong && x.right && x.wrong !== x.right && body.includes(x.wrong) && !seen.has(x.wrong) && seen.add(x.wrong))
        .slice(0, 60);
    return { kind, issues };
}
async function trimPass(body, context) {
    const ctx = String(context || '').trim();
    const system = withHouseStyle(`You are reading a student's draft for ONE thing: writing the essay does not need, or takes too long over. You are on the student's side — every span you mark costs them words they could spend on marks.
Two verdicts, and you must use the right one:
- CUT: the essay does not need this at all — it repeats a point already made, it is off the question, it is a run-up or preamble ("In this essay I will…", "It is important to note that"), it is padding or filler, or it says what the marker already knows. right = "".
- TIGHTEN: the point IS needed but takes too long to make — three sentences where one would do, the same thing said twice in a row, a fact buried in wind-up. right = the same point in fewer words, KEEPING the student's own words, figures and examples; drop only the padding. At most half the length. Never a new idea, never a new fact, never your own argument.
Rules: spans are whole sentences, verbatim, character for character (curly quotes, spelling mistakes and all). Do not mark spelling, grammar or style. Do not mark a sentence just because it is long — only if the essay would lose nothing (cut) or nothing but wind-up (tighten). If the writing is tight, return an empty list. Never rewrite the whole thing; at most 25 spans, the ones that cost the most words first.${ctx ? `\n\nWHAT THE ESSAY IS FOR (judge "needed" against this):\n${ctx.slice(0, 2500)}` : ''}`);
    const user = `THE TEXT:\n${body.slice(0, 60000)}\n\nMark what the essay does not need (cut) and what takes too long (tighten).`;
    const r = await callAccurate(system, user, { maxTokens: 6000, schema: TRIM_SCHEMA, effort: 'medium' });
    const seen = new Set();
    const issues = (Array.isArray(r && r.issues) ? r.issues : []).map(x => {
        const verdict = x.verdict === 'cut' ? 'cut' : 'tighten';
        const wrong = String(x.wrong || '').trim();
        // Q never hands them a sentence: a steer for tighten, nothing for cut.
        return { wrong, verdict, right: '', why: capWords(x.why, 16), steer: verdict === 'tighten' ? capWords(x.steer, 22) : '' };
    })
        // real, findable, whole; a tighten needs its steer
        .filter(x => x.wrong && x.wrong.split(/\s+/).length >= 4 && body.includes(x.wrong) && (x.verdict === 'cut' || x.steer) && !seen.has(x.wrong) && seen.add(x.wrong))
        .slice(0, 25);
    return { kind: 'trim', issues };
}
// WEAK — the whole page. Which sentences are weak, why, and what would make
// each strong. A steer, never the sentence.
const WEAK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['issues'],
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['wrong', 'why', 'steer'],
                properties: {
                    wrong: { type: 'string', description: 'The exact sentence from the text, character for character. It MUST appear verbatim in the text. One whole sentence.' },
                    why: { type: 'string', description: 'Plain words for a student, 6 to 14: what makes it weak ("a claim with nothing behind it", "vague — which staff, how many?", "hedges twice", "no example", "describes, does not analyse").' },
                    steer: { type: 'string', description: 'ONE line on what would make it strong, as a steer they act on themselves ("add the figure from the case study", "say who and how many", "give one example", "say what this means for the recommendation") — never the rewritten sentence.' },
                },
            },
        },
    },
};
async function weakPass(body, context) {
    const ctx = String(context || '').trim();
    const system = withHouseStyle(`You are reading a student's draft for ONE thing: the sentences that are WEAK — a claim with nothing behind it, vague where it should be specific, hedged, describing where the question asks for analysis or evaluation, missing the example or figure that would prove it, or not saying what it means for the answer. You are on the student's side.
For each weak sentence give WHY in plain words and a STEER — what they should do to make it strong. Never write the sentence for them; never quote a model answer; never a new fact they did not have. If the writing is strong, return an empty list. At most 25, weakest first.
Do not mark spelling, grammar, length or style — only weakness of the point.${ctx ? `\n\nWHAT THE ESSAY IS FOR (judge against this):\n${ctx.slice(0, 2500)}` : ''}`);
    const user = `THE TEXT:\n${body.slice(0, 60000)}\n\nMark the weak sentences: why, and what would make each strong.`;
    const r = await callAccurate(system, user, { maxTokens: 6000, schema: WEAK_SCHEMA, effort: 'medium' });
    const seen = new Set();
    const issues = (Array.isArray(r && r.issues) ? r.issues : []).map(x => ({ wrong: String(x.wrong || '').trim(), verdict: 'weak', right: '', why: capWords(x.why, 16), steer: capWords(x.steer, 22) }))
        .filter(x => x.wrong && x.wrong.split(/\s+/).length >= 3 && body.includes(x.wrong) && x.steer && !seen.has(x.wrong) && seen.add(x.wrong))
        .slice(0, 25);
    return { kind: 'weak', issues };
}

// ── The check: their rewritten sentence against the brick. A closeness cue,
// never the target text.
const CHECK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['closeness', 'hint', 'termsUsed', 'requirementsMet'],
    properties: {
        termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of the EXPECTED TERMS listed, the ones this sentence now COVERS — the idea is on the page and doing work in a sentence that says something. It does not matter whether she used that word: her own wording, a synonym, or a plain-English explanation all count — if a marker reading this would credit the point the term stands for, list the term. A word dropped in as a bare label with no idea behind it does NOT count. Give the term in the exact spelling as listed. Empty if none listed / none covered.' },
        requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of the REQUIREMENTS listed, the kinds this sentence now satisfies (e.g. "figure" when it gives a number, "reference" when it cites a source). Empty if none.' },
        closeness: { type: 'string', enum: ['match', 'closer', 'missing'], description: 'match = the sentence now voices the brick (idea named, point made); closer = moved toward it but not there; missing = the key thing is still absent.' },
        hint: { type: 'string', description: 'For "match": a warm one-liner ("That\'s it — next."). For "closer" / "missing": ONE plain line on the one thing still missing, as a steer — never the sentence, never the term itself if terminology is the gap (point at it: "name the idea about how pay motivates people").' },
    },
};
async function checkSentence({ sentence, brickId, brief, essay, plan }) {
    if (!String(sentence || '').trim()) throw new Error('No sentence to check.');
    const system = withMission(`You are Q in the EDITING stage. The student rewrote the highlighted sentence. Compare it to the target brick and answer with a closeness cue only.
Rules: judge the IDEA — is the brick's point now made in their own words (the concept named, the example given, the reason shown)? Not spelling, not style. Never quote or paraphrase the target. Warm, short, steering. Also report which of the expected terms the sentence now COVERS ("termsUsed" — the idea on the page doing work; it does not matter whether she used that word, her own wording or a plain-English explanation counts just as much; a bare label with no idea behind it does not) and which requirements it now satisfies.

${targetForPrompt(brief, essay, brickId)}
${expectationsForPrompt(plan)}`);
    const user = `THEIR SENTENCE NOW: "${String(sentence).slice(0, 800)}"\n\nHow close is it?`;
    const r = await callAccurate(system, user, { maxTokens: 400, schema: CHECK_SCHEMA, effort: 'low' });
    const closeness = ['match', 'closer', 'missing'].includes(r && r.closeness) ? r.closeness : 'closer';
    const kinds = new Set((plan && plan.requirements || []).map(x => x.kind));
    return {
        closeness, hint: capWords((r && r.hint) || (closeness === 'match' ? 'That\'s it — next.' : 'Closer.'), 14),
        // termCanon: the plan's spelling, so the route's set add/delete matches.
        termsUsed: (r && Array.isArray(r.termsUsed) ? r.termsUsed : []).map(x => termCanon(plan, x)).filter(Boolean),
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
    required: ['role', 'steps', 'minimalAsk', 'expectedTerms', 'termGlossary', 'requirements'],
    properties: {
        minimalAsk: { type: 'string', description: 'The brief for this part broken down as MINIMALLY as possible, one plain line to the student (12 words or fewer): "This question wants you to show the good and bad of X." Never the brief\'s own words.' },
        expectedTerms: { type: 'array', items: { type: 'string' }, description: '6 to 12 words or short phrases the marker expects to SEE in this paragraph — the subject terms, theory / case / statute / source names, key nouns of YOUR model answer for this part, whatever the subject (law, science, history, business, nursing, literature…). Each 1-4 words. These become buttons the student presses to drop the word into their sentence.' },
        termGlossary: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'meaning', 'example'], properties: { term: { type: 'string', description: 'Exactly one of expectedTerms, same spelling.' }, meaning: { type: 'string', description: 'What it means, ONE plain everyday sentence, 18 words or fewer. Never marker language.' }, example: { type: 'string', description: 'ONE everyday example that makes it obvious, 20 words or fewer.' } } }, description: 'One entry per expectedTerm (same order). This is the little card the student sees when they hover a word button — the only place a definition ever appears.' },
        requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'label'], properties: { kind: { type: 'string', enum: REQ_KINDS }, label: { type: 'string', description: 'What exactly, plainly, 8 words or fewer: "a figure for the gap", "a reference for that claim", "the case named", "the theory named", "the statute section".' } } }, description: 'What this paragraph must CONTAIN beyond words — each becomes a coloured dot the student can see. Generic kinds: citation, reference, case-study, figure, theory, example, recommendation. Subject kinds when the subject calls for them: statute, case-law (law), primary-source (history), diagram / calculation (science, maths, engineering), quotation (literature), other (say what in the label). 1 to 5. Empty if none.' },
        role: { type: 'string', description: 'ONE plain sentence framing the job of this part in role terms, spoken to the student — "Here you\'re the critic: judge whether the company\'s rewards actually work, then say how you\'d fix them" / "Here you\'re the judge: decide whether this rule is clear enough to be fair" / "Here you\'re the scientist: explain what happens in the leaf and why it matters". Never brief jargon; never "discuss"/"critically evaluate".' },
        steps: {
            type: 'array',
            description: 'THE LADDER: 8 to 14 small steps in order, each pulling ONE piece of the answer out of them. Together they must pull EVERY brick of this part out of the student in their own words. A tutor does not ask three big questions; they ask fifteen small ones and the essay is written in fragments by the end.',
            items: {
                type: 'object', additionalProperties: false,
                required: ['id', 'kind', 'prompt', 'draws', 'targetBrickIds', 'terms', 'itemHint', 'rows', 'tags', 'itemsFrom', 'side', 'hint', 'lesson', 'example', 'term', 'supply', 'thenAsk'],
                properties: {
                    id: { type: 'string', description: 'Short id, "s1", "s2"…' },
                    draws: { type: 'string', description: 'WHAT THIS QUESTION PULLS OUT — Q\'s eyes only, never shown. The specific piece of the answer this one question is for: "the four things being introduced, named" / "autonomy and task variety, before the term is used" / "deskilling — they describe it, we label it next" / "the counter-argument, in their own words". If you cannot say what a question draws out, it is not a step.' },
                    terms: { type: 'array', items: { type: 'string' }, description: 'THE WORD BOARD FOR THIS STEP (Sarah, 16 Aug: "the word board needs to be per question"). Of this part\'s expectedTerms, the 2-4 the student should be reaching for while answering THIS step — spelled exactly as in expectedTerms. Showing a part\'s whole vocabulary at every step invites pressing them all in at once, which teaches nothing. Every expected term should belong to at least one step; a term with no natural home can be left out.' },
                    kind: { type: 'string', enum: STEP_KINDS },
                    prompt: { type: 'string', description: 'The ONE concrete ask, plain everyday British English, 35 words or fewer. list: "List every cause you can think of — one per line." numbers: "Put a number on each: what it is now, what it should be." tag: what the colours will mean, one line. proscons: "One good thing and one bad thing about each." argue: "Argue that…, as if you mean it." switch: "Now argue the other side…" recommend: "Which wins, and why?"' },
                    targetBrickIds: { type: 'array', items: { type: 'string' }, description: 'The brick ids of this part that this step voices when filled. Every brick of the part must appear in at least one step.' },
                    itemHint: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'list only: a 3-6 word placeholder for one item, e.g. "e.g. summer party".' },
                    rows: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'isPrompt', 'shouldPrompt'], properties: { label: { type: 'string' }, isPrompt: { type: 'string', description: 'The ask for the "is" cell, e.g. "what you get now"' }, shouldPrompt: { type: 'string', description: 'The ask for the "should be" cell, e.g. "what it should be"' } } }, description: 'numbers only: 2-5 rows. Empty array otherwise.' },
                    tags: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'colour', 'meaning'], properties: { name: { type: 'string' }, colour: { type: 'string', enum: TAG_COLOURS }, meaning: { type: 'string', description: 'Plain one-line meaning, e.g. "you choose it yourself"' } } }, description: 'tag only: 2-4 tags. Empty array otherwise.' },
                    itemsFrom: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'tag / proscons: the id of the list step whose items this works on.' },
                    side: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'argue / switch: the side to argue, plainly, e.g. "the reform would make the law fairer" / "the company should let people pick their own benefits".' },
                    hint: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'recommend / ask: one plain line on what a full answer covers — never the answer.' },
                    lesson: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'teach only: the mini-lesson in Q\'s voice — 2 to 4 plain sentences that TEACH the concept the next step needs (what it is, how it works, why it matters). The term named once. Never the model answer\'s text.' },
                    example: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'teach only: ONE everyday, concrete example — a school, a shop, a football team, a family, a kitchen — that makes the concept obvious.' },
                    term: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'teach only: the term being taught, e.g. "osmosis", "duty of care", "supply and demand", "cafeteria benefits".' },
                    supply: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'ask / argue / switch / recommend / list: ASSUME THEY DO NOT KNOW. When this brick carries knowledge — a term, a fact or figure, a theory, an argument, a line of reasoning, why this point comes here — the plain statement Q gives FIRST, before the ask (one to three sentences): "Supply and demand says a price rises when more people want a thing than there is of it." / "One strong criticism of trial by jury is that twelve strangers can be swayed by a good speaker." null ONLY for a brick that is pure opinion / experience.' },
                    thenAsk: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'For a BIGGER brick (an argument, a line of reasoning): after supply and the prompt ("which side of that do you see in your own example?"), the final sentence request — "Now say it as your own sentence for the essay." null when the prompt itself asks for the sentence.' },
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
    if (!essay) throw new Error('The model answer for this part is not written yet — a moment.');
    // The essay exists but has nothing for this part: say so — "a moment" was
    // a promise nothing kept. This wording is retryable (userFacingCause).
    if (!bricks.length) throw new Error('The model answer came back empty for this part — try again.');
    const idx = brief.criteria.findIndex(c => c.id === criterionId);
    const evaluative = /evaluat|critic|assess|judge|justify|argu|compare|extent|effective|recommend/i.test(crit.text || '');
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Pitch every ask at their level.` : '';
    const relateHint = relateAnchor ? `Their world: "${relateAnchor}". Use it for examples when it helps.` : '';
    const system = withMission(`You are Q, planning how to coach ONE PART of the assignment. The student has not read the brief. You will not ask them open "do you think…?" questions on top of each other; you will give them SCAFFOLDS to fill, one concrete thing at a time, so that by the end of the steps they have said — in their own words — every brick of your model answer for this part.

THE PLAN
- "role": ONE plain sentence framing the job in role terms so they never wonder whether they are describing, judging or redesigning. Say it to them: "Here you're the critic: …" / "Here you're the adviser: …" / "Here you're the reporter: …".
- "steps": 3 to 6 steps in the order a real tutor would run them. The SPINE is the brick loop: every brick — a term, a fact, a theory, an argument, a paragraph's line of reasoning, the structure — gets drawn out in turn (supply the idea plainly → ask for their sentence saying it, anchored in their world → bigger bricks take 2-3 asks). Group bricks the way the essay's paragraphs run. Lists, numbers, tags and pros/cons are helpers where they genuinely fit (a package to list, figures to put down, items to sort), never the spine for its own sake. Kinds:
    list      — they build a list, one item per line (a company's benefits, the causes of an event, the symptoms of a condition, the features of a design…). itemHint = a short example placeholder.
    numbers   — a small table: for each row, what it IS now and what it SHOULD be (a salary 30k → 45k; a temperature 20°C → 37°C; a date; a measurement). rows = the row labels and the two cell asks.
    tag       — YOU sort their list into 2-4 tags with colours (this runs AUTOMATICALLY the moment their list is done — no ask to the student, never "which are which?"; the coloured board + legend teaches it). prompt = the one legend line you say ("The pink ones you pick yourself — flexible; the blue ones everyone gets — fixed."). itemsFrom = the list step id. tags = name/colour/meaning, in everyday words ("pink = the company gives everyone the same; blue = you get to choose").
    proscons  — for each tagged item: one good thing, then one bad thing. itemsFrom = the tag (or list) step id.
    argue     — get them arguing ONE side with feeling. side = the side, plainly.
    switch    — flip them to the OTHER side. side = the other side.
    recommend — which wins and why / what they would do. hint = what a full answer covers, never the answer.
    ask       — THE BRICK LOOP unit (the spine of the plan): ONE brick, whatever its size — a term, a fact, a theory, an ARGUMENT, a line of reasoning, why this point comes next. ASSUME THEY DO NOT KNOW: supply = the idea stated plainly first ("Plants use the sun to grow — that's called photosynthesis." / "One strong criticism of trial by jury is that twelve strangers can be swayed by a good speaker."), prompt = the ask for their sentence(s) saying it, anchored in their company / experience ("Could you write a sentence about when you enjoyed learning about this?" / "Which side of that do you see in your own example?"), thenAsk = for a bigger brick, the final "now say it as your own sentence". supply is null only for a brick that is pure opinion / experience ("What colour is the sky?"). Their sentences land on the page; nothing Q said does.
    teach     — TEACH-THEN-APPLY (Sarah, 15 Aug: "bear in mind I don't know the answer. No matter how many questions and hints, it is not going to teach me"). Whenever the NEXT step's ask needs a concept, theory or term the student has not shown they know (a theory, a legal test, a formula, a technical term, a named case, a model…), put a teach step BEFORE it: lesson = 2-4 plain sentences in your voice that actually teach it; example = one everyday concrete example; term = the term, named once; prompt = one line saying what you are about to teach and why ("Before you weigh this up, one idea you need: how pay ladders work."). Then the apply step asks them to USE it on their company. Never ask → hint → ask again about something never taught. Hints are only for nudging something already taught or said.
- ${evaluative ? 'THIS PART IS EVALUATIVE (the marker wants judgement): the steps MUST end with argue → switch → recommend, so the critical evaluation comes out of them as a debate they had with themselves.' : 'If the part asks for judgement, finish with argue → switch → recommend; if it only asks for description or explanation, list / numbers / tag / proscons / ask are enough.'}
- EXPECTATIONS (Sarah): "minimalAsk" — the brief for this part broken down as minimally as you can, one plain line, 12 words or fewer ("This question wants you to show the good and bad of X."). "expectedTerms" — 6-12 words / short phrases the marker expects to see in this paragraph (the subject terms, theory / case / statute / source names, key nouns of your model answer — whatever this subject is) — they become BUTTONS the student presses to drop the word into their sentence, and go green when the word fits. "termGlossary" — for EVERY expected term, one plain sentence of meaning and one everyday example (this is the hover card — the only place a definition appears; nothing else explains the words). "requirements" — what the paragraph must CONTAIN beyond words (a citation, a reference, a case study, a figure, a theory named, an example, a recommendation; or, when the subject calls for it, a statute, a case, a primary source, a diagram, a quotation, a calculation) — each becomes a coloured dot the student can see, with a key, so they know when they edit that it has to be there.
- THE LADDER (this is the method — Sarah, 17 Aug, from the ladder her own Q wrote): 8 to 14 SMALL steps, not three big ones. Each step does ONE job and says what it does in "draws". Run them in this order:
    1. GROUND IT IN THEIR CASE FIRST. The opening steps ask about the actual thing in front of them, using the facts of the scenario by name — what is being introduced, who it happens to, what the numbers are. Nothing abstract, no theory, no judgement yet.
    2. THEN THE LIVED PICTURE. Ask them to picture the person it happens to and say what changes for them ("picture a warehouse worker's shift today — what do they decide for themselves?" then "now an algorithm decides all of that — what has changed?"). This is theory arriving through intuition; the concept comes out of them before it has a name.
    3. THEN THE JUDGEMENT. Better or worse, and for whom. Then the other side, argued as if they meant it.
    4. THEN WHAT SHOULD BE DONE — the professional advice the marker pays for.
    5. NAME THE THEORY AND THE EVIDENCE LAST. Only once they have said the idea in their own words do you give it its label and ask for the source ("what you have just described is called deskilling — here is who wrote about it"). Never open a ladder with a theory name.
  A student who has answered all of them has written the part in fragments without noticing.
- Every brick of this part appears in at least one step's targetBrickIds. Every prompt is ONE concrete ask, 30 words or fewer, in plain everyday British English — concrete beats short: name the person, the shift, the figure, the system. Never "what do you think about X?".
- Q FORMATS, THEY WRITE: whenever the student gives raw material (a list, numbers, an example, a story), Q's job is to ANALYSE it visibly on the board — coloured groups with a legend, the numbers with the gap drawn, the two sides of an argument in colour, the pros/cons grid laid out — and then ask for sentences OFF that structure ("look at the pink ones — why would they all sit in one group? Write me a sentence."; "the gap is 15k — what does that do to how you feel on a Monday?"). Never quiz them on the categorisation. Later steps' prompts refer to the coloured groups / the gap by name.
- ${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}
${ageHint}
${relateHint}

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 5000)}`);
    const user = `THE PART TO PLAN — part ${idx + 1} of ${brief.criteria.length}: [${crit.id}] "${crit.label || ''}" — ${crit.text}

THE BRICKS OF YOUR MODEL ANSWER FOR THIS PART (Q's eyes only — the steps must draw each one out of the student):
${bricks.map(b => `(${b.brickId}) ${b.gist}\n    ${String(b.text || '').slice(0, 700)}`).join('\n')}

Make the plan.`;
    // The ladder is the product. It was being planned on the cheapest setting.
    // 16000, not 6000: adaptive thinking SHARES max_tokens with the answer
    // (q-claude.js), and a real 12-step ladder at medium truncated at 6000
    // every time — the fallback then returned broken JSON and the plan job
    // failed after two minutes, so the board had nothing to draw (Sarah,
    // 17 Aug 22:20: "all the infos gone"). Same reason the essay runs at 14000.
    const r = await callAccurate(system, user, { maxTokens: 16000, schema: PLAN_SCHEMA, effort: 'medium' });
    return normalisePlan(r, criterionId, bricks);
}

// ── The board must never become a wall ─────────────────────────────────────
// Sarah, 16 Aug, on a live screenshot: "for someone that's turned to an app
// because they can't do it themselves this is a lot of text and clutter, no
// colour, nothing stands out." Her Part 1 had ELEVEN steps on the board. The
// schema says "3 to 6 steps" — but that is a sentence addressed to the model,
// and these schemas carry no minItems/maxItems, so nothing ever enforced it.
// A rule that only exists in prose is not a rule. Enforce it here.
//
// Which six: the ending is what makes a part evaluative (argue → switch →
// recommend is where the marks are), so the last of those are kept and the
// front of the plan fills what is left. Steps dropped here lose nothing —
// their bricks fall to the last surviving step a few lines below, and the
// dependency pass after this repairs any tag/pros-cons step whose list went.
// FACTS BEFORE JUDGEMENT, enforced. The prompt asks for it; this makes it so.
// A part that opens by asking her to weigh something up has already lost her —
// she has nothing of her own on the board to weigh. If the plan collects facts
// later on, that step comes first; a tag/pros-cons step follows its list
// wherever the list goes, and the repair pass below re-points anything that
// ends up dangling.
const FACT_KINDS = ['list', 'numbers'];
const JUDGEMENT_KINDS = ['argue', 'switch', 'recommend', 'ask', 'proscons'];
function factsFirst(steps) {
    if (steps.length < 2) return steps;
    if (FACT_KINDS.includes(steps[0].kind) || steps[0].kind === 'teach') return steps;
    if (!JUDGEMENT_KINDS.includes(steps[0].kind)) return steps;
    const i = steps.findIndex(s => FACT_KINDS.includes(s.kind));
    if (i <= 0) return steps;
    const [fact] = steps.splice(i, 1);
    steps.unshift(fact);
    return steps;
}

// "Marchington et al. argue reward needs both vertical fit and horizontal
// fit…" arrived as a step's `supply` — the field that states a fact plainly
// BEFORE the ask, which is right when a brick genuinely needs a fact the
// student cannot know, and completely wrong as the opening move of a part.
// Handed a theory and asked to judge with it, Sarah's answer was "I may as
// well be reading the paper myself."
//
// So the theory cannot arrive before her facts do: no supply on the opening
// step, and none on a step that is collecting her raw material. By the time a
// supply is allowed, there is something of hers on the board for it to land
// on. The `thenAsk` that belongs to a supply goes with it.
function noTheoryBeforeFacts(steps) {
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const collecting = FACT_KINDS.includes(s.kind);
        if ((i === 0 || collecting) && s.supply) { s.supply = null; s.thenAsk = null; }
    }
    return steps;
}

// The openers Sarah named, stripped in code: "Thinking about your
// organisation, does its pay set-up genuinely match…" becomes "Does its pay
// set-up genuinely match…". A question that starts by asking someone to think
// is a question that has not asked anything yet.
const DEAD_OPENERS = /^(thinking about|think about|considering|consider|reflecting on|reflect on|having read|bearing in mind|with (that|this) in mind|in light of|to what extent,?)\b[^,]*,\s*/i;
function leadingAsk(prompt) {
    let p = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!p) return p;
    const cut = p.replace(DEAD_OPENERS, '');
    if (cut && cut.length > 12) p = cut.charAt(0).toUpperCase() + cut.slice(1);
    // ONE ASK, ONE THING. "…match its business goals, or do they pull in
    // different directions?" is two questions wearing one question mark, and
    // it reads as a test: the second half tells her there is a right answer
    // and she has to pick it. The first half is the question; the rest goes.
    const single = p.replace(/,\s*or\b[^?]*\?\s*$/i, '?');
    if (single.length > 15) p = single;
    return p;
}

// A LIST IS NOT AN ANSWER. Sarah, 16 Aug: "he's asking questions like for
// lists and we answer and he doesn't put it on the paper." Right — a list is
// thinking, it lives on the board; the essay needs a SENTENCE about it. So
// every list (or numbers) step must be followed, before the part ends, by a
// step whose answer goes on the paper. If the model's plan goes list → tag →
// (nothing) the student is left holding a list and no sentence. This puts the
// sentence-ask in, right after the list and its sorter, pointed at the same
// bricks, so it always exists.
const PAPER_KINDS = ['ask', 'argue', 'switch', 'recommend'];
function listNeedsASentence(steps) {
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.kind !== 'list' && s.kind !== 'numbers') continue;
        // Skip past the helper steps that work ON this list.
        let j = i + 1;
        while (j < steps.length && (steps[j].kind === 'tag' || steps[j].kind === 'proscons' || steps[j].kind === 'teach') && (steps[j].itemsFrom === s.id || steps[j].kind === 'teach')) j++;
        if (j < steps.length && PAPER_KINDS.includes(steps[j].kind)) continue;   // already followed by a sentence step
        const what = s.kind === 'list' ? 'your list' : 'those numbers';
        const insert = {
            id: s.id + '_say', kind: 'ask',
            prompt: 'Now, looking at ' + what + ' on the board — write me one or two sentences saying what it shows. Your words; I put them on the paper.',
            targetBrickIds: (s.targetBrickIds || []).slice(),
            terms: (s.terms || []).slice(),
            itemHint: null, rows: [], tags: [], itemsFrom: null, side: null,
            hint: 'What does ' + what + ' tell you? Say it as if to a friend.',
            supply: null, thenAsk: null, lesson: null, example: null, term: null,
        };
        steps.splice(j, 0, insert);
        i = j;   // continue after the inserted step
    }
    return steps;
}

// Sarah, 17 Aug, holding up the 15-question ladder her own Q chat wrote for
// the same brief: "why isnt the writer q doing this?" Because six of its
// questions were being DELETED. The model planned the ladder; trimToMaxSteps
// threw away everything past the sixth step. The cap came from a real problem
// (her board showed eleven steps as a wall of text, 16 Aug) — but the fix
// belonged to the DISPLAY, which now shows one step at a time as beads, not to
// the coaching. A tutor's ladder is 10-15 small questions, each pulling one
// piece; that is the whole method.
const MAX_PLAN_STEPS = 15;
const CLOSING_KINDS = ['argue', 'switch', 'recommend'];
function trimToMaxSteps(steps) {
    if (steps.length <= MAX_PLAN_STEPS) return steps;
    const closing = steps.filter(s => CLOSING_KINDS.includes(s.kind)).slice(-3);
    const opening = steps.filter(s => !closing.includes(s)).slice(0, Math.max(1, MAX_PLAN_STEPS - closing.length));
    const kept = opening.concat(closing);
    steps.length = 0;
    steps.push(...kept);
    return steps;
}

// The one-line ask, actually one line. "12 words or fewer" was schema prose
// too; what reached Sarah's word board was 20 words. A clause boundary makes
// a clean short ask out of a long one ("Look honestly at your organisation's
// pay and benefits, use real evidence to judge…" → the first clause), and
// only a sentence with nowhere to cut gets an ellipsis.
function oneLineAsk(text, maxWords = 12) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const words = s.split(' ');
    // A grace of two words: cutting a 13-word ask to 12 mangles a phrase
    // ("the good and bad of flexible…") for no gain. Only trim what is
    // actually long.
    if (words.length <= maxWords + 2) return s;
    const cuts = [];
    let count = 0;
    for (let i = 0; i < words.length; i++) {
        count += 1;
        if (/[,;:]$/.test(words[i]) && count >= 5 && count <= maxWords) cuts.push(count);
    }
    if (cuts.length) {
        const n = cuts[cuts.length - 1];
        return words.slice(0, n).join(' ').replace(/[,;:]$/, '') + '.';
    }
    return words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '') + '…';
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
            draws: String(s.draws || '').trim(),
            targetBrickIds: (Array.isArray(s.targetBrickIds) ? s.targetBrickIds : []).map(x => String(x).replace(/\s+/g, '')).filter(x => brickIds.has(x)),
            terms: (Array.isArray(s.terms) ? s.terms : []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
            itemHint: kind === 'list' && s.itemHint ? String(s.itemHint).slice(0, 60) : null,
            rows: kind === 'numbers' ? (Array.isArray(s.rows) ? s.rows : []).map(row => ({ label: String(row.label || '').trim(), isPrompt: String(row.isPrompt || 'what it is now').trim(), shouldPrompt: String(row.shouldPrompt || 'what it should be').trim() })).filter(row => row.label).slice(0, 6) : [],
            tags: kind === 'tag' ? (Array.isArray(s.tags) ? s.tags : []).map((t, k) => ({ name: String(t.name || '').trim(), colour: TAG_COLOURS.includes(t.colour) ? t.colour : TAG_COLOURS[k % TAG_COLOURS.length], meaning: String(t.meaning || '').trim() })).filter(t => t.name).slice(0, 4) : [],
            itemsFrom: (kind === 'tag' || kind === 'proscons') && s.itemsFrom ? String(s.itemsFrom).replace(/\s+/g, '') : null,
            side: (kind === 'argue' || kind === 'switch') && s.side ? String(s.side).trim() : null,
            hint: s.hint ? capWords(s.hint, 14) || null : null,
            supply: ['ask', 'argue', 'switch', 'recommend', 'list'].includes(kind) && s.supply ? capSentences(s.supply, 2, 45) || null : null,
            thenAsk: ['ask', 'argue', 'switch', 'recommend', 'list'].includes(kind) && s.supply && s.thenAsk ? String(s.thenAsk).trim() : null,
            lesson: kind === 'teach' && s.lesson ? String(s.lesson).trim() : null,
            example: kind === 'teach' && s.example ? String(s.example).trim() : null,
            term: kind === 'teach' && s.term ? String(s.term).trim() : null,
        };
    }).filter(s => s.prompt && !(s.kind === 'teach' && !s.lesson));
    if (!steps.length) throw new Error('The plan had no usable steps — try again.');
    factsFirst(steps);
    noTheoryBeforeFacts(steps);
    for (const s of steps) s.prompt = capWords(leadingAsk(s.prompt), 30);
    listNeedsASentence(steps);
    trimToMaxSteps(steps);
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
    // The glossary behind each word button (hover card): meaning + one everyday
    // example, keyed by the term in lower case. Missing entries stay empty —
    // the button still works, the card just says less.
    const glossary = {};
    for (const g of (Array.isArray(r.termGlossary) ? r.termGlossary : [])) {
        const term = String((g && g.term) || '').replace(/\s+/g, ' ').trim().replace(/[.:;,]+$/, '').toLowerCase();
        if (!term || !seenT.has(term)) continue;
        glossary[term] = { meaning: String((g && g.meaning) || '').trim().slice(0, 240), example: String((g && g.example) || '').trim().slice(0, 240) };
    }
    // Each step's own word board (Sarah, 16 Aug: "the word board needs to be
    // per question"). Only real expected terms, in their canonical spelling —
    // a button whose word is not on the part's list can never go green,
    // because the check only ever reports terms from expectedTerms.
    const canonical = new Map(expectedTerms.map(t => [t.toLowerCase(), t]));
    for (const s of steps) {
        const picked = [];
        for (const t of (s.terms || [])) {
            const c = canonical.get(t.toLowerCase());
            if (c && !picked.includes(c)) picked.push(c);
        }
        s.terms = picked.slice(0, 4);
    }
    return { criterionId, role: String(r.role || '').trim(), minimalAsk: oneLineAsk(r.minimalAsk), expectedTerms, glossary, requirements, steps, madeAt: Date.now() };
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

// ── CHAT WITH Q (Sarah, 17 Aug: "can I now talk to Q as a chat that will
// actually help and answer me"). Not a coaching probe with a 24-word cap: a
// proper answer to what she asked, from the brief, the plan for the part she
// is on, the CASE TEXT she uploaded, and her own page — as long as the
// question needs. He still never writes her sentences and never reads the
// model answer out. If a list would help (facts, figures, examples), it
// goes on the whiteboard as `board`; the reply says so.
const CHAT_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['reply', 'board', 'next', 'highlight', 'highlights', 'answersStep'],
    properties: {
        reply: { type: 'string', description: 'The answer to what they asked, plain everyday British English. As long as it needs — usually 2 to 6 sentences; a short numbered list if they asked for a list or for steps. Direct: the answer first, then the why. Teach a term properly when asked (name, meaning, everyday example). If they ask what to write, tell them WHAT TO SAY and WHERE (which point, after which of their words) — never the sentence itself. If they ask for facts / figures / examples from the case, put them in board.\n\nTWO THINGS, ALWAYS — THE DISPLAY AND THE TALK. When there is a lot to give back, you produce BOTH: the information goes on the board (the display), and reply is you TALKING TO HER about it. reply is never just a pointer, never "it is on the whiteboard" and nothing else, and never a list of the same points that are already on the board. It is what a good tutor sitting next to her would say: what she has done well, what is still missing, and what you have put up for her to work on. Her words for it: "that is really good, but we have still missed some main points. I have listed on the board the things you need to work on. I have also noted the things that are missing, and things we should add in the next question." Warm, specific, three or four sentences. She should never feel she is reading a report on her own — you are in the room.\n\nFORMATTING — your reply renders as real markdown, like every other Q chat. Use it rather than running everything into one paragraph: ##### for a small uppercase heading, **bold** for the thing being named, "- " bullets for several points, standard | tables | for two-column comparisons, "> " for a line worth pulling out. Prose for one thought; structure the moment there is more than one.\n\nLENGTH — if you are making MORE THAN THREE separate points, that is a report, not a chat message. Put the points in board (one item each) and keep reply to a line or two saying what you found and to look at the whiteboard. Never stack five criticisms into one paragraph.' },
        board: { anyOf: [{ type: 'object', additionalProperties: false, required: ['title', 'items', 'todo'], properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact', 'where'], properties: { fact: { type: 'string', description: 'A fact / figure / example / quoted line as the case has it, verbatim, 4-16 words.' }, where: { type: 'string', description: 'Where it sits in the case, 2-6 words.' } } } }, todo: { type: 'array', items: { type: 'string' }, description: 'What to do with them: which item, where in their paragraph, what to say it shows. Never the sentence.' } } }, { type: 'null' }], description: 'null unless a LIST from the case would help more than prose (facts, figures, examples, quotes, the people, the numbers).' },
        next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'One line, 12 words or fewer, the concrete next thing they could do on the page — or null.' },
        highlight: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'If your answer is about ONE particular sentence or phrase on THEIR PAGE, that span verbatim (character for character, 3-40 words) so the page can light it up while you talk — else null. Never text that is not on their page.' },
        answersStep: { type: 'boolean', description: 'true ONLY when their message is plainly their ANSWER to THE STEP THEY ARE ON (the list item, the number, the argument that step asked for) rather than a question, a remark or a request to you. When true, keep reply to ONE short reaction line — the page will take their words as the answer.' },
        highlights: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], description: 'When they ASK you to highlight / find / show where something is on their page ("highlight where I mention AI", "show me every claim without a source"): EVERY matching span, each verbatim from their page (1-40 words) — else null. Say how many you found in the reply.' },
    },
};
async function chatAnswer({ brief, essay, plan, stepId, caseText, sources, docText, history, question, yearGroup, ask }) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Ask Q something first — the box is empty.');
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Talk to them in the language of their age.` : '';
    const system = withMission(`You are Q, this student's tutor, in CONVERSATION. They asked you something in the coach box. Answer it — properly, plainly, usefully — the way a good tutor sitting next to them would.\nRULES\n- Answer the question they asked, first. Then the why, if it helps. As long as it needs; no padding, no preamble.\n- Everything you know is below: the brief, the marker's expectations for the part they are on, THE CASE TEXT they uploaded, and their page. Use the case: real names, figures, events, quoted lines. Never invent a fact.
- Teach when asked (a term, a theory, a model): name it, say what it means in everyday words, give an everyday example, then how it applies to THEIR case.
- If they ask what to write / how to answer / what a paragraph needs: tell them WHAT TO SAY and WHERE — the points, in order, and what evidence — never a sentence for them to paste. Their words, their page.
- If they ask for facts / figures / examples / quotes from the case, or for "the numbers", "the people", "what happened": put the list on the whiteboard (board) — verbatim, with where each sits — with 2-4 todo lines on how to use them; say "on the whiteboard" in the reply.
- If they ask how they are doing or what is left: say plainly, from their page against the parts of the brief.
- Never read out the model answer or its wording; never say what grade the essay "should" get.
- Plain, warm, direct British English. No lists of questions back at them. This is a CONVERSATION: pick up what they said last, answer, and carry on — no sign-offs, no "back to it" lines, no restating their step unless they ask.
- If what you say is about ONE sentence or phrase on their page, put that span in "highlight" verbatim — the page lights it up while you talk, so you can say "this sentence" and they see which.
- If they ASK you to highlight / find / show where something is on their page, put EVERY matching span in "highlights" (verbatim) and say how many in the reply ("Highlighted 4 places you mention AI — the second and fourth are the ones without a source.").
${ageHint}

THE BRIEF
${briefForPrompt(brief).slice(0, 5000)}
${plan ? '\nTHE PLAN FOR THE PART THEY ARE ON\n' + planForPrompt(plan, stepId).slice(0, 3000) + '\n' + expectationsForPrompt(plan).slice(0, 1500) : ''}
${essay ? '\n' + essayForPrompt(essay).slice(0, 6000) + '\n(The model answer is for your understanding only — never quote it, never paraphrase a sentence of it to them.)' : ''}

THE CASE TEXT THEY UPLOADED (the only source of facts):
${String(caseText || '').slice(0, 24000) || '(not stored — use the scenario in the brief above)'}
${sources && sources.length ? '\nOTHER UPLOADED SOURCES:\n' + sourcesForPrompt(sources, { perSource: 6000, total: 12000 }) : ''}`);
    const hist = (Array.isArray(history) ? history : []).slice(-10).map(h => `${h.role === 'q' ? 'Q' : 'STUDENT'}: ${String(h.text || '').slice(0, 800)}`).join('\n');
    const user = `${ask ? `THE STEP THEY ARE ON: ${String(ask).slice(0, 300)}
` : ''}THEIR PAGE SO FAR:
${boundDoc(docText, 20000) || '(blank page)'}

THE CONVERSATION SO FAR:
${hist || '(this is the first message)'}

STUDENT: ${q.slice(0, 1200)}

Answer as Q.`;
    const r = await callAccurate(system, user, { maxTokens: 1600, schema: CHAT_SCHEMA, effort: 'medium' });
    const reply = String((r && r.reply) || '').trim();
    if (!reply) throw new Error('Q went quiet — try again.');
    let board = null;
    if (r && r.board && Array.isArray(r.board.items) && r.board.items.length) {
        const items = r.board.items.map(x => ({ fact: String((x && x.fact) || '').trim(), use: String((x && x.where) || '').trim() })).filter(x => x.fact).slice(0, 8);
        if (items.length) board = { title: String(r.board.title || 'From the case').trim().slice(0, 60), items, todo: (Array.isArray(r.board.todo) ? r.board.todo : []).map(x => capWords(String(x), 26)).filter(Boolean).slice(0, 4) };
    }
    const hl = r && r.highlight ? String(r.highlight).replace(/\s+/g, ' ').trim() : '';
    const docNorm = String(docText || '').replace(/\s+/g, ' ');
    const hls = (r && Array.isArray(r.highlights) ? r.highlights : []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(x => x && docNorm.includes(x)).slice(0, 20);
    return { reply, board, next: r && r.next ? capWords(String(r.next), 14) : null, highlight: hl && docNorm.includes(hl) ? hl : null, highlights: hls.length ? hls : null, answersStep: !!(r && r.answersStep) };
}

// ── JUDGE THE SOURCE CANDIDATES (Sarah, 17 Aug: "when we auto cite they
// should have the small points of what this is backing under so you know
// how to choose them… and strong, weak"). One small call over the shortlist:
// for each candidate, the point it would back in HER sentence and how
// strongly, honestly — so she can choose.
const CITE_JUDGE_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['judged'],
    properties: {
        judged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'backs', 'strength', 'why'], properties: {
            i: { type: 'integer', description: 'The candidate number as listed.' },
            backs: { type: 'string', description: 'What in the student\'s sentence this source would back, 5-12 plain words ("that software now sets the targets", "the link between monitoring and trust").' },
            strength: { type: 'string', enum: ['strong', 'fair', 'weak', 'none'], description: 'strong = squarely on this point, a serious source; fair = related, partial, or older; weak = a stretch, but a marker would still accept the link — same field, adjacent claim; none = it does NOT back this sentence at all: a different topic, a different field, or it only shares a word ("skill failure" in sports psychology against a sentence about AI deskilling). Say none whenever you would not put your own name to the citation — an honest "nothing here fits" is always better than a citation the marker will pull apart. Never stretch to be helpful.' },
            why: { type: 'string', description: 'Why, 4-10 words ("peer-reviewed, exactly this", "retail, not warehousing", "about well-being, not trust").' },
        } } },
    },
};
async function judgeCiteCandidates({ sentence, candidates, brief }) {
    const list = (Array.isArray(candidates) ? candidates : []).slice(0, 6);
    if (!list.length) return [];
    const system = withHouseStyle(`You are Q, helping a student choose which source to cite behind ONE sentence of their essay. For each candidate say what in their sentence it would back, and how strongly — honestly. A source that is only loosely about the topic is weak, and you say so; a strong claim needs a strong source. Plain words.
${brief ? 'THE ASSIGNMENT (context): ' + String(brief.title || '') + ' — ' + String(brief.whatItWants || '').slice(0, 400) : ''}`);
    const user = `THE SENTENCE: "${String(sentence || '').slice(0, 600)}"

CANDIDATES:
${list.map((c, i) => `${i + 1}. ${c.title || ''} — ${(c.authors || []).map(a => a && (a.family || a.name || '')).filter(Boolean).slice(0, 3).join(', ')} ${c.year || ''}${c.fromUpload ? ' [the student\'s own upload]' : ''}${c.snippet ? `
   says: "${String(c.snippet).slice(0, 260)}"` : ''}`).join('\n')}

Judge each.`;
    const r = await callAccurate(system, user, { maxTokens: 700, schema: CITE_JUDGE_SCHEMA, effort: 'low' });
    const out = [];
    for (const j of (r && Array.isArray(r.judged) ? r.judged : [])) {
        const i = Number(j.i) - 1; if (!(i >= 0 && i < list.length)) continue;
        out[i] = { backs: capWords(String(j.backs || '').trim(), 14), strength: ['strong', 'fair', 'weak', 'none'].includes(j.strength) ? j.strength : '', why: capWords(String(j.why || '').trim(), 12) };
    }
    return out;
}

// ── TAG: Q sorts the student's list into the plan's tags. One small call. ──
// Sarah, 17 Aug: "you write them on the whiteboard… and then he will
// rearrange them and use colour and emojis and formatting to show you how
// they are categorised or different or whatever. if he needs to write out a
// sum he can." So the sort carries Q's MARKS for the whiteboard: an emoji and
// a headline per group, a short note on the tiles worth pointing at, and up
// to three lines he writes on the board — a sum with the real numbers, an
// arrow to the conclusion, a note. Her words stay verbatim; his marks sit
// beside them.
const TAG_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['tagged', 'line', 'groups', 'board'],
    properties: {
        tagged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'tag', 'note'], properties: { item: { type: 'string', description: 'The student\'s item, verbatim.' }, tag: { type: 'string', description: 'One of the tag names given.' }, note: { type: 'string', description: 'Usually "". On the 1-3 tiles worth pointing at, Q\'s mark in 2-6 words ("the odd one out", "biggest cost", "this one is both", "👈 start here"). Teaching, not praise.' } } } },
        groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tag', 'emoji', 'headline'], properties: { tag: { type: 'string', description: 'The tag name, exactly as given.' }, emoji: { type: 'string', description: 'ONE emoji for the group (💰 ⏰ ❤️ 🛠️ ⚖️ 📈 …).' }, headline: { type: 'string', description: 'The group in 2-6 everyday words, as a column heading ("costs the firm cash", "everyone gets these").' } } } },
        board: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: { kind: { type: 'string', enum: ['sum', 'arrow', 'note'] }, text: { type: 'string', description: 'sum: written out with the real numbers from the list / brief ("4 flexible + 2 fixed = 6 benefits", "£1,200 × 12 = £14,400 a year") — never invented numbers; arrow: the conclusion the sorting points to, one line ("→ most of what they get costs the firm nothing"); note: one plain teaching line. 16 words or fewer each.' } } }, description: '0 to 3 lines Q writes on the board under the columns. A sum ONLY when there are real numbers to add. Empty when there is nothing worth writing.' },
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
You are TEACHING ON A WHITEBOARD: give each group an emoji and a 2-6 word headline; put a 2-6 word note on the one to three tiles worth pointing at (the odd one out, the biggest, the one that is both — teaching, not praise; the rest ""); and write 0-3 lines on the board under the columns — a SUM written out with real numbers when the list or brief has numbers ("4 flexible + 2 fixed = 6"), an ARROW line drawing the conclusion the sorting shows, or a NOTE. Never invent a number. Nothing goes on the student's page — this is the board.
${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 2500)}`);
    const user = `THE STUDENT'S LIST:\n${list.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nSort it.`;
    const r = await callAccurate(system, user, { maxTokens: 1400, schema: TAG_SCHEMA, effort: 'low' });
    const names = new Set(step.tags.map(t => t.name));
    const byItem = new Map(); const noteOf = new Map();
    for (const t of (r && Array.isArray(r.tagged) ? r.tagged : [])) {
        const item = String(t.item || '').trim();
        if (item && names.has(t.tag)) { byItem.set(item.toLowerCase(), t.tag); const n = capWords(String(t.note || '').trim(), 8); if (n) noteOf.set(item.toLowerCase(), n); }
    }
    // Every item comes back tagged — unmatched ones take the first tag, flagged.
    const tagged = list.map(item => ({ item, tag: byItem.get(item.toLowerCase()) || step.tags[0].name, guessed: !byItem.has(item.toLowerCase()), note: noteOf.get(item.toLowerCase()) || '' }));
    const groups = (r && Array.isArray(r.groups) ? r.groups : []).filter(g => g && names.has(g.tag)).map(g => ({ tag: g.tag, emoji: String(g.emoji || '').trim().slice(0, 4), headline: capWords(String(g.headline || '').trim(), 8) })).slice(0, step.tags.length);
    const board = (r && Array.isArray(r.board) ? r.board : []).filter(b => b && ['sum', 'arrow', 'note'].includes(b.kind) && String(b.text || '').trim()).map(b => ({ kind: b.kind, text: capWords(String(b.text).trim(), 20) })).slice(0, 3);
    return { tagged, line: String((r && r.line) || '').trim() || step.prompt, tags: step.tags, groups, board };
}

// ── CHECK an argue / switch / recommend / ask answer against the step's
// bricks: which are now voiced, and ONE follow-up ask if the step is not
// yet filled. Never the answer.
const STEP_CHECK_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['voicedBrickIds', 'filled', 'ack', 'followUp', 'supply', 'thenAsk', 'termsUsed', 'requirementsMet'],
    properties: {
        termsUsed: { type: 'array', items: { type: 'string' }, description: 'Of the EXPECTED TERMS listed, the ones the answer now COVERS — the idea is on the page and doing work in a sentence that says something. It does not matter whether she used that word: her own wording, a synonym, or a plain-English explanation all count — if a marker reading this would credit the point the term stands for, list the term. A word dropped in as a bare label with no idea behind it does NOT count. Give the term in the exact spelling as listed. Empty if none.' },
        requirementsMet: { type: 'array', items: { type: 'string' }, description: 'Of the REQUIREMENTS listed, the kinds the answer now satisfies. Empty if none.' },
        supply: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'THE BRICK LOOP: if the step is not filled and the brick carries knowledge the answer does not yet have — a term, a fact or figure, a theory, the argument itself, the reasoning — STATE IT PLAINLY here in one to three sentences (assume they do not know; a fact given, never a hint), then thenAsk asks for their sentence saying it. null when the missing piece is their own view / example.' },
        thenAsk: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'With supply: the sentence request that follows — "Could you write a sentence about how that works in your own example?". null otherwise.' },
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

${LEADING_QUESTION_RULE}
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
    const filled = !!(r && r.filled);
    const supply = r && r.supply && !filled ? capSentences(r.supply, 2, 45) || null : null;
    const kinds = new Set((plan && plan.requirements || []).map(x => x.kind));
    // Not filled and the model gave no ask back = the page had nothing to show
    // and moved on — full credit for an unfilled step. The step's own thenAsk /
    // prompt is the ask again; never filled:false with followUp:null.
    const followUp = filled ? null : capWords((supply && r.thenAsk) || (r && r.followUp) || step.thenAsk || step.prompt, 22) || null;
    return {
        // termCanon: the plan's spelling, so the route's set add/delete matches.
        termsUsed: (r && Array.isArray(r.termsUsed) ? r.termsUsed : []).map(x => termCanon(plan, x)).filter(Boolean),
        requirementsMet: (r && Array.isArray(r.requirementsMet) ? r.requirementsMet : []).map(String).filter(x => kinds.has(x)),
        voicedBrickIds: (r && Array.isArray(r.voicedBrickIds) ? r.voicedBrickIds : []).map(x => String(x).replace(/\s+/g, '')).filter(x => allowed.has(x)),
        filled,
        ack: String((r && r.ack) || '').trim(),
        supply,
        thenAsk: supply && r.thenAsk ? String(r.thenAsk).trim() : null,
        followUp,
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
        example: { type: 'string', description: 'ONE everyday, concrete example (a school, a shop, a football team, a family budget, a kitchen) that makes it obvious.' },
        applyAsk: { type: 'string', description: 'The same ask, re-put as an APPLY question using what was just taught — "So in your example, who wins and who loses under that rule?" One question, 35 words or fewer, plain.' },
        searchTerms: { type: 'array', items: { type: 'string' }, description: 'Two or three search phrases for a video / page that explains this concept simply.' },
    },
};
async function teachFor({ brief, essay, plan, step, question, yearGroup, relateAnchor }) {
    const ask = String(question || (step && step.prompt) || '').trim();
    if (!ask) throw new Error('Nothing to teach yet — there is no question on the go.');
    const bricks = step && essay ? (step.targetBrickIds || []).map(id => brickById(essay, id)).filter(Boolean) : [];
    const ageHint = yearGroup ? `Year group: ${yearGroup}. Pitch the lesson at their level.` : '';
    const relateHint = relateAnchor ? `Their world: "${relateAnchor}". Use it for the example if it fits.` : '';
    const system = withMission(`You are Q. The student pressed "I don't understand" / "I'm stuck" on your ask. They do not know the answer and more questions or hints will not teach them. TEACH the concept the ask depends on — a mini-lesson in your voice, 2-4 plain sentences, one everyday concrete example, the term named once — then re-put the ask as an APPLY question they can now answer about their own example / situation. Never a rephrase, never another hint, never the model answer's words.
${PLAIN_QUESTION_RULE}

${LEADING_QUESTION_RULE}
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
        applyAsk: capWords(r.applyAsk || ask, 24),
        searchTerms: (Array.isArray(r.searchTerms) ? r.searchTerms : []).map(String).filter(Boolean).slice(0, 3),
    };
}

// ── DOTS IN THE ESSAY (Sarah, 15 Aug 23:40: "The dots appear IN THE ESSAY
// where he knows a term / a citation etc. should be — he puts them in after
// you've finished the question and moved on; he marks it subtly as he goes").
// One small call per part, when the part is finished (and again after the
// mark): the part's sentences, numbered, + the requirements still unmet →
// for each, the ONE sentence it belongs after, and one plain line of why.
// The page renders them as furniture at the end of that sentence — never in
// the saved text. Cached per (part, sentences, kinds) by the route.
const PLACE_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['placements'],
    properties: {
        placements: {
            type: 'array',
            description: 'One entry per requirement still needed (at most one per kind). Skip a kind only if NO sentence in this part could carry it.',
            items: {
                type: 'object', additionalProperties: false, required: ['sentenceIndex', 'kind', 'why'],
                properties: {
                    sentenceIndex: { type: 'integer', description: 'The number of the sentence (as numbered) after which this belongs — the claim that needs the source, the sentence where the term / case / figure should sit.' },
                    kind: { type: 'string', enum: REQ_KINDS },
                    why: { type: 'string', description: 'ONE plain line to the student, 12 words or fewer, coach voice, saying what goes right here: "A source to back this claim." / "The case that decided this." / "A number to make this real." Never the answer, never marker language.' },
                },
            },
        },
    },
};
async function placeDots({ brief, essay, plan, criterionId, sentences, unmetKinds }) {
    const list = (Array.isArray(sentences) ? sentences : []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 120);
    const kinds = (Array.isArray(unmetKinds) ? unmetKinds : []).filter(k => REQ_KINDS.includes(k));
    if (!list.length || !kinds.length) return { placements: [] };
    const reqs = (plan && Array.isArray(plan.requirements) ? plan.requirements : []).filter(r => kinds.includes(r.kind));
    const bricks = essay ? bricksOfCriterion(essay, criterionId) : [];
    const system = withMission(`You are Q, marking the student's draft of ONE part quietly as they move on. For each thing this part must still contain, say WHERE in their own text it belongs — the sentence after which the citation / reference / case / figure / term / example / recommendation should sit — and one plain line of why. You place a dot; you never write the thing itself.
Rules: pick the sentence that makes the claim needing support (for a citation / reference / primary source), the sentence describing what the theory / case / statute explains (for theory / case-law / statute), the sentence making a claim that a number / example / diagram would make real (for figure / example / diagram / calculation), the closing sentence for a recommendation. One dot per kind. "why" = one plain line, 12 words or fewer, coach voice — never marker language, never the answer.

THE BRIEF (for context)
${briefForPrompt(brief).slice(0, 3000)}
${bricks.length ? 'THE MODEL ANSWER FOR THIS PART (Q\'s eyes only — never quote it):\n' + bricks.map(b => '(' + b.brickId + ') ' + b.gist).join('\n') : ''}`);
    const user = `THE STUDENT'S SENTENCES FOR THIS PART (numbered):\n${list.map((x, i) => (i + 1) + '. ' + x).join('\n')}\n\nSTILL NEEDED IN THIS PART:\n${reqs.length ? reqs.map(r => '- ' + r.kind + ' (' + r.label + ')').join('\n') : kinds.map(k => '- ' + k + ' (' + (REQ_LABELS[k] || k) + ')').join('\n')}\n\nWhere does each one belong?`;
    const r = await callAccurate(system, user, { maxTokens: 700, schema: PLACE_SCHEMA, effort: 'low' });
    const seen = new Set();
    const placements = (r && Array.isArray(r.placements) ? r.placements : []).map(p => ({
        sentenceIndex: Math.max(0, Math.min(list.length - 1, (Number.isFinite(Number(p.sentenceIndex)) ? Number(p.sentenceIndex) : 1) - 1)),   // numbered from 1 in the prompt
        kind: String(p.kind || ''),
        why: String(p.why || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    })).filter(p => kinds.includes(p.kind) && !seen.has(p.kind) && seen.add(p.kind))
      .map(p => ({ ...p, sentence: list[p.sentenceIndex], label: (reqs.find(r => r.kind === p.kind) || {}).label || REQ_LABELS[p.kind] || p.kind, colour: REQ_COLOURS[p.kind] || '#999', why: p.why || ((reqs.find(r => r.kind === p.kind) || {}).label || REQ_LABELS[p.kind] || p.kind) + ' goes here.' }));
    return { placements };
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
    // An empty label would become "this part" and overwrite a good one — drop it.
    const byId = new Map((r && Array.isArray(r.labels) ? r.labels : []).filter(x => x && String(x.label || '').trim()).map(x => [String(x.id || '').replace(/\s+/g, ''), plainLabel(x.label, '')]));
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
    if (/truncated at \d+ tokens/i.test(both)) return { message: `The ${step} ran out of room mid-answer — shorten the brief or try again?`, code: 'truncated', status: 502, retryable: true };
    if (/refused the request/i.test(both)) return { message: `The ${step} was declined by the coaching service for this content. Check the document is the assignment brief and try again.`, code: 'refused', status: 422, retryable: false };
    if (/JSON|Unexpected token|Unexpected end/i.test(both)) return { message: `The ${step} came back garbled — retry?`, code: 'garbled', status: 502, retryable: true };
    if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(both)) return { message: `The ${step} could not reach the coaching service (network) — retry?`, code: 'network', status: 502, retryable: true };
    // An empty 200 (the model returned {} / blank fields) is the service's
    // fault, not the student's — retryable, never a 400.
    if (/came back empty|did not match the criteria|could not read that document/i.test(msg)) return { message: msg, code: 'empty', status: 502, retryable: true };
    // A bug of ours (TypeError etc.) is not something the student can act on
    // — never show them "Cannot read properties of undefined" as a 400.
    if ((err instanceof TypeError) || /Cannot read|is not a function|is not iterable|is not defined/.test(msg)) return { message: `Q lost his place on that step — try again.`, code: 'internal', status: 502, retryable: true };
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

${LEADING_QUESTION_RULE}

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
    const schemeNote = schemeLine(gradeScheme);

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
    ukPolishResponse, ukText, UK_LINE, PLAIN_QUESTION_RULE, withHouseStyle, plainLabel, capWords, capSentences, parseWeight, termCanon,
    TUTOR_MISSION, WHY_THE_GAME, GAME_RULE, COACH_VOICE, MISSION_BLOCK, withMission, BRICK_LOOP_RULE, TO_THE_POINT, MAX_CRITIQUE,
    toolHelp, checkSentence, matchScore, EDIT_TOOLS, TOOL_SCHEMA, CHECK_SCHEMA, proofread, PROOF_KINDS, chatAnswer, CHAT_SCHEMA, judgeCiteCandidates,
    planPart, normalisePlan, planForPrompt, tagItems, checkStep, brickById, bricksOfCriterion,
    PLAN_SCHEMA, TAG_SCHEMA, STEP_CHECK_SCHEMA, STEP_KINDS, TAG_COLOURS,
    teachFor, relabelCriteria, labelLooksGenerated, TEACH_SCHEMA, LABELS_SCHEMA,
    expectationsForPrompt, REQ_KINDS, REQ_COLOURS, REQ_LABELS, placeDots, PLACE_SCHEMA,
    analyseTask, analyseAndBrief, nextQuestion, assembleDocument,
    analyseVoice, tutorBrief, askLeadingQuestion, reframeInVoice, suggestWordSwaps, writeStarter,
    formatHarvardRef, suggestReferences, referenceParagraph,
    explainConcept, markSection, improveSectionStep,
    // Phase 3 — the coach with the answer in his head
    probe, markLikeMarker, markPart, digestSource, extractScenario, assembleFromDraft, userFacingCause, normaliseBrief, briefForPrompt,
    writeModelEssay, essayForPrompt, allBrickIds, coverageFromBricks, editPass, splitSentences,
    BRIEF_SCHEMA, PROBE_SCHEMA, MARK_SCHEMA, ASSEMBLE_SCHEMA, ESSAY_SCHEMA, EDIT_SCHEMA,
};
