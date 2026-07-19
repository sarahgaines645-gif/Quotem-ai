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
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');
const { accurateJSON, SONNET } = require('./q-claude');

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
    return accurateJSON(systemPrompt, userPrompt, { effort: 'medium', ...opts, model: SONNET, fallback: callQ });
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

// ONE call for the whole "Q reads your task" step. /writer/brief used to run
// analyseTask then tutorBrief back-to-back — two model calls in one HTTP
// request — which blew Railway's ~60s window and killed the coach on live
// (19 Jul). Same job, half the latency: one call returns both halves.
async function analyseAndBrief(taskText) {
    const system = `You are an expert tutor reading a student's assignment brief. The input may be a formatted assessment document — Pearson/university/college/CIPD, with headers, tables, learning outcomes and marking criteria BEFORE the actual task. In CIPD-style briefs the real tasks are often buried pages in, under headers like "Assessment questions" or "Question 1 (AC 1.4)" — scan the WHOLE input and find them; the task is never on page 1.

Do BOTH jobs in one pass — the analysis of the task, and the tutor's brief a great teacher builds before coaching.

CRITICAL: Return ONLY valid JSON — no preamble, no questions, no "I need more info". If you can see ANY assignment content, extract what you can. Never ask for more information.

Return ONLY valid JSON with these two top-level objects:
- analysis: {
    task (string): one plain-English sentence — what the student must write, specific to THIS assignment,
    docType (string): "essay" | "report" | "letter" | "review" | "analysis" | "creative" | "other",
    subject (string): the subject area,
    keyConcepts (array of 3-6 strings): specific concepts from THIS brief,
    gradeBands (object with keys "top", "mid", "low"): one concrete sentence per band for THIS task
  }
- brief: {
    summary (string): 2 sentences — what the student needs to produce,
    whatItWants (string): one warm, direct sentence spoken TO the student — "OK so you need to...",
    markedSections (array of 2-6 objects): the sections to write, in order — each { name (string), description (string, 1 sentence), suggestFirstQ (string — the natural leading question a real tutor asks first) },
    teachersBrief (string): what an examiner rewards in a top answer, in plain language
  }`;

    return await callAccurate(system, `TASK INPUT:\n${taskText}`, { maxTokens: 2500 });
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

    return await callQ(
        system,
        `Q'S QUESTION: "${question}"\n\nSTUDENT'S RAW ANSWER: "${rawAnswer}"\n\nDOCUMENT SO FAR:\n${(context || '').slice(0, 800) || '(blank)'}\n\nReframe their answer in their voice.`,
        { maxTokens: 400 }
    );
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

module.exports = {
    analyseTask, analyseAndBrief, nextQuestion, assembleDocument,
    analyseVoice, tutorBrief, askLeadingQuestion, reframeInVoice, suggestWordSwaps, writeStarter,
    formatHarvardRef, suggestReferences, referenceParagraph,
    explainConcept, markSection, improveSectionStep,
};
