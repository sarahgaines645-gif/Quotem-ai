# BRIEF — THE STUDY SUITE: Revision + Coursework, from 20% to 100%
*Written 15 Aug 2026 for the agent that takes this on. Sarah's words are quoted; everything
else is the working brief. Read `CLAUDE.md` first — the operating contract applies.*

---

## THE GOAL, IN SARAH'S WORDS

> "I want to be able to upload a course work file/link that I have no idea about and it walk me
> through until I've completed it and I never have to read the doc and get an A. That's the goal."

> "It needs to be moved from 20% to 100."

> "For teenagers studying: screen turns black, big flashing dopamine lights. This is a teen
> option. It still needs the sensible version so that's an option for revision. Graphics options
> — have them put them on a page I can view. I mean good ones, not something from an Amstrad."

> "My sister said there was a problem uploading and working on her coursework."

There are TWO tools in play and they must end up feeling like ONE study suite:
- **Coursework** = `writer.html` + `plugins/q-writer.js` (19 `/writer/*` routes) — the adaptive
  writing coach. Its own header says: *"Q does NOT write the document. Q draws the writing out
  of the user by asking adaptive questions, takes their answers verbatim, and assembles them."*
  That principle STAYS — it is the academic-integrity story. "Never have to read the doc" means
  *Q reads the brief for you and walks you through it*, not *Q writes it for you*.
- **Revision** = `revise.html` + `plugins/q-revision.js` + `plugins/q-bank.js`
  (`/revision/*` routes) — MCQ build stage with THE TUBE arcade game, then the Exam Room.

Related history you must read before touching anything:
`docs/HANDOVER_2026-07-22_REVISION-WRITER-AUDIT.md` (the last deep pass — cost bleed, writer
502 fix, the open item *"Sarah never confirmed the brief board populated with the 4 AC questions
after the last fix"*), and the memory note that the revision tool was built for Sarah's son
(6 Aug). Known hard constraint: **exam-board past papers are copyrighted — never serve them**;
questions are generated and Sonnet-checked.

---

## PHASE 1 — FIND OUT WHY IT DOESN'T WORK END TO END (investigate, don't fix yet)

1. **Reproduce the sister's coursework problem.** Take a real-shaped coursework brief — a
   multi-page .docx with a marking rubric and 3–4 assessment-criteria questions (make one; do
   NOT use real student work) — and drive `writer.html` exactly as a user would: upload → brief
   board → questions → answers → assemble → download. Also try the URL path (`/writer/fetch-url`).
   Record precisely where it breaks: upload limits (audit says body limits were guessed and a
   413 bypasses every route's try/catch → the generic "Server error"), docx extraction
   (`/extract-text`), the brief board not populating, timeouts (q-writer had no AbortController
   as of 15 Aug — the gates agent may have added one; check), Sonnet-vs-DeepSeek routing in
   `q-claude.js`, anything cut off mid-sentence.
2. **Reproduce the revision path end to end** as a brand-new user: pick level/board/subject/topics
   → build the bank → play the Build stage (incl. THE TUBE) → hit the Exam Room threshold → typed
   answers marked. Record every failure, dead-end, stuck state, and every place where the model
   output isn't real teaching (vague "why" lines, wrong marks, questions that don't match the
   spec).
3. **Cost + latency per step** for both flows (the cost meter is being wired by the gates agent —
   use it if landed, else log tokens yourself). Sarah's rule: no speculative figures.
4. Write the findings to `docs/STUDY_SUITE_PHASE1_FINDINGS.md` — file:line evidence, root causes,
   ranked by how badly they block the goal. Do NOT fix in this phase.

⚠️ Running the flows costs real API money. **Ask Sarah for a yes with a rough £ figure before
the first paid run** (her rule: no paid tests without price + yes). Sonnet marking/brief calls
are pennies each; a full end-to-end pass of both flows should be low single-digit pounds — say
the number, wait for the yes.

## PHASE 2 — THE LOOK: real graphics options on ONE page Sarah can open

Build `docs/study-suite-looks/index.html` (self-contained, no build step, opens from disk) that
shows **4–6 genuinely distinct visual directions**, each as a real, animated, interactive mock
of the same two screens (a revision question card + THE TUBE game state), NOT static thumbnails.
Sarah's bar: *"good ones, not something from an Amstrad."* That means: modern type, real motion
design (CSS/WebGL/canvas), considered colour, sound-off-by-default toggles, and each direction
must show BOTH modes:

- **TEEN MODE** — *"screen turns black, big flashing dopamine lights."* Dark canvas, high-contrast
  neon, streaks/combos, big satisfying correct-answer bursts, a visible run counter, screen
  shake on a wrong answer, celebratory finale. Think modern rhythm-game / arcade cabinet /
  Duolingo-streak energy — never garish for its own sake, and with a reduced-motion switch.
- **SENSIBLE MODE** — the calm version for the student (or parent) who wants the same engine
  without the light show: clean, paper-and-ink, focus on the question and the teaching line.

Directions to include (at minimum): (a) *Neon arcade* (black + one hot accent, CRT-free), (b)
*Synthwave / retro-future* (gradient horizon, glow), (c) *Streak / game-show* (Duolingo-meets-
Kahoot energy, chunky progress and streak fire), (d) *Focus lab* (near-black, minimal, single
accent, satisfying micro-animations only), plus one or two of your own. Each with a one-line
rationale and the toggle to flip teen ↔ sensible. Mobile viewport must work — this is used on
phones. Sarah will pick ONE (or mix); do not build into the live pages until she has.

## PHASE 3 — BUILD (only after Sarah's Phase-1 findings sign-off AND her Phase-2 pick)

Coursework, to the goal:
- **Upload or paste a link and never read the doc:** Q reads the brief, extracts the task,
  rubric, word count, deadline, and the assessment criteria — and *tells the student what it
  found in plain words first* ("This is asking for 4 things…"), so the brief board is never
  empty. Then walks them question by question (the adaptive-questions method), tracks
  coverage against every criterion, and refuses to "finish" while a criterion is uncovered.
- **"Get an A" = mark like the marker:** after assembly, mark each section against the rubric,
  say exactly what's missing for the top band, and loop the student back into that section —
  same integrity rule (their words, Q's structure). Never invent references — the existing
  Harvard/reference helpers propose, the student confirms.
- **Never lose work:** autosave every answer; a session survives a refresh, a phone lock, and a
  Railway restart. Big files, long briefs, URLs, docx/pdf/images all handled or politely refused
  with a reason (never "Server error").
- Same integrity + academic honesty positioning as today, made visible on the page.

Revision, to the goal:
- Fix everything from Phase 1. Ship the chosen look with the **teen/sensible switch as a
  first-class option** (remembered per user). Keep THE TUBE; make its game feel match the pick.
- Teaching quality: every "why" line must teach one thing; explanations link to a channel-first
  YouTube result (existing pattern); "I don't understand this" always works.
- The Exam Room marks strictly and explains the mark; progress and best-runs persist per user.
- Nothing served from copyrighted past papers.

Standards: plugin law (reuse; new pieces are new plugins with headers), no vendor names on any
user surface (Sarah's rule — no "DeepSeek/Gemini/Claude" text visible), no children's data
leaving the app beyond the AI calls it already makes, cost logged on every call, node -c and a
real end-to-end run before saying "done". Report short: what's fixed, what's proven, what's owed.

---

## ADDENDUM 15 Aug (evening) — HOW COACHING MUST FEEL, in Sarah's words, from a live run

Sarah uploaded a real CIPD 7HR03 brief on live. First try: "Couldn't read that" (brief block
missing — the general-chat + regex path). Retry: brief populated. She then typed one sentence
in the document — *"I think a company that values their employees is attractive."* — and Q
answered "Something went wrong — shall I try again?" (the coaching turn failed the same way).

Her spec, verbatim: **"Q should be saying right... think of a company, what do you think would
be good about working for them.... I dont know what the doc is about but he needs to ask
leading questions and he needs to read you writing and as you get to the end of a sentence...
say you stop for 7 seconds he will talk and ask questions to probe you in to saying what he's
written in his head because that's the answer that's worth the A."**

What the code does today (verified 15 Aug): typing in the document ONLY updates the word count
(`writer.html:918-920`). Q does not read the writing. Coaching is a separate Q&A box
(`askNextQuestion` → user types in `coachInput`) driven through the general `/chat` surface and
a regex hunt for a ```` ```writer-question ```` block — same brittle path as the brief. So the
behaviour Sarah describes is NOT broken; it does not exist yet. It is THE Phase 3 build:

1. **Q has the A-grade answer in his head first.** From the full brief (all of it, via the
   dedicated Sonnet route, structured output — never regex-hunting a chat reply): the task,
   every assessment criterion, the marking bands, and an *ideal-answer skeleton* per criterion.
   That skeleton is what every probe steers toward. The student never sees it raw.
2. **He opens with a leading question, not a wait.** Immediately after the brief lands, in
   plain words: what the brief found ("This is asking you for 3 things…") and then a warm,
   concrete opener that anyone can answer without having read the doc — e.g. *"Think of a
   company you'd love to work for. What makes it good?"* — chosen because its answer is the
   first brick of the ideal answer.
3. **He reads the writing live and speaks in the pause.** Watch the document as it's typed;
   when the student stops for ~7 seconds at the end of a sentence (`.?!` and new text since
   the last probe), Q reads what they wrote against the ideal-answer skeleton and asks ONE
   probing question that pulls the next brick out of them ("You said valuing employees makes a
   company attractive — what does 'valuing' actually look like in pay and benefits? Give me
   one example."). Non-blocking, one at a time, never while they're mid-flow, never repeats a
   covered point. The 7 seconds is a setting.
4. **Their words, his structure.** He never types into their document. Answers given in the
   coach box can be offered as a sentence in *their* voice to drop in (existing
   reframe/word-swap helpers). Coverage against every criterion is tracked; he doesn't let
   them "finish" with a criterion untouched; at the end he marks like the marker against the
   rubric and says exactly what the top band still needs.
5. **Failure is never silent.** No "Something went wrong" without the cause; retry keeps
   context; autosave every answer + the doc; a refresh, phone lock or Railway restart loses
   nothing. Assemble + download exists.

Cost rule unchanged: proving this end to end is paid runs (pennies each on Sonnet) — price it,
get Sarah's yes, then run.

## ADDENDUM 15 Aug (late) — DRAFTS AND RESUBMISSIONS ARE A FIRST-CLASS CASE

Sarah's live test file was a COMPLETED submission (four written answers, declared word count,
appendices, assessor-feedback slots) — not a blank brief. Q's brief board picked up facts from
the ANSWERS ("a medium-sized tech company") and blended them into "what it's asking". A real
CIPD/degree student will upload drafts and resubmissions constantly. Required:
1. On upload, detect whether the document contains answers/draft content and/or marker
   feedback as well as the questions (headings like "Question n (AC x.y)", "Assessor feedback",
   declared word count, appendices, long prose under each question).
2. If it does, ask ONE thing before building anything: "This already has answers in it —
   start fresh, or improve what's here?" (remembered for the session).
3. Improve mode: the brief = the QUESTIONS only; the existing answers become the student's
   draft on the page (their words — never the model essay); the marker's feedback (if present)
   becomes the first coaching target ("the marker said X — let's fix that first"); coverage
   starts from what the draft already covers.
4. Start-fresh mode: the brief = the questions only; existing answers are ignored (not shown,
   not used to write the model essay).
Never let a student's prior answers seed "what it's asking".

## ADDENDUM 15 Aug (late) — THE TUTOR'S CHALLENGE, and how EDITING works (Sarah, verbatim-ish)

Sarah, on seeing the edit stage say "replace vague phrases with the correct organisational
terminology: 'career progression'…": *"we are basing my non-existent knowledge on this — useful
for a person that struggles to learn. So this 'go and find the right terminology' will not help.
We need him to highlight parts and talk through those sentences. He highlights the sentences he
wants to change and then there are buttons that will push me to get the right info: find correct
terminology, find strategies, thesaurus, dictionary, synonyms, case studies, references — any
tool that will lead you into writing HIS words."*

*"He needs to know his goal is to get your essay to match his as closely as possible. Tell him
this is a challenge: your aim is to get a user to write your essay out as closely as possible
without ever telling them what to write. You can encourage, teach, steer, explain, look up — the
closer they get to your essay, the tutor is winning. They should take pride in having the skill to
transfer their skills without ever writing the words. They are a pro. A skilled tutor no human
could match, and they are going to improve the lives of the people that struggle to have nice
lives like the people that can easily do this."*

Therefore:
- **The tutor's mission goes into every writer system prompt** (probe, stuck, edit, mark) in
  those terms. Winning = the student's essay converging on the hidden model essay, brick by
  brick, with the student writing every word. Never tells them what to write. Encourages,
  teaches, steers, explains, looks things up.
- **Editing = highlight + tools, not replacements.** After coaching: Q highlights, one at a
  time, the sentence he would change (in the document itself), says in one plain line WHY
  ("this is your opinion — the marker wants the concept named"), and offers TOOL BUTTONS that
  lead the student to write it themselves: **Terminology** (the right term + a plain one-line
  meaning + an everyday example — then "now say your sentence using it"), **Thesaurus /
  Synonyms**, **Dictionary**, **Strategies / theories** (the relevant framework named with a
  one-line plain explanation of why it fits here), **Case studies** (from uploaded sources
  first; Q's knowledge second, flagged), **References** (from uploaded sources; never invented),
  **Explain what's weak**. The student rewrites the highlighted sentence; Q compares to his
  target and answers "closer / that's it / one thing still missing" — a visible closeness cue.
  No ready-made rewritten sentence is ever offered during editing either.
- Coaching stage stays: he asks, their exact words go on the page, he asks the next thing.

**Sarah, on WHY it's a game (goes into Q's writer prompts, near-verbatim):** *"These are his essays.
These are his marks. No other AI is managing to be graded by teachers. Yes, it comes easy to an AI
to write an essay — but are they up to the challenge of writing that essay THROUGH a human, who
creates the obstacle? That's the challenge. It's not just learning. You're taking the easy part
and making him work to be smart through a human. That's an achievement."*

## ADDENDUM 15 Aug (later) — SCAFFOLDED COACHING, not question-stacking (Sarah, verbatim-ish)

*"He's supposed to be pushing me into writing the right thing. I still have no idea what we are
talking about. I'm answering his questions but don't feel I'm getting anywhere. Every question
is costing money. His goal should be to get me passionately arguing the side he wants and then
get me to change sides. I don't know if I'm supposed to be redesigning the company or
scrutinising them. Say he wants pros and cons of flexible benefits and views on the company I
supposedly work for: I would have said 'list your company's benefits'… then 'now tell me where
you feel your salary sits and bonuses from where it should be — 30k should be 45; bonus 3k a
year, deserve 5'. Then he'd highlight your benefits on the list on the teaching sheet and say the
pink are flexi, the blue are fixed. 'What do you think the pros of your summer party being a fixed
benefit are?' You answer. 'What are the cons?' You answer. That's how it should be. He's asking
questions on top of my questions but if I don't know the answer we'll be here all night. If he
keeps name-dropping trigger words in I will use them back to him."*

Therefore the coaching engine becomes SCAFFOLDED:
1. **Frame each part in one plain sentence first** — the job, in role terms ("Here you're the
   critic: judge whether the company's rewards actually work, then say how you'd fix them" /
   "Here you're the adviser: choose fixed-for-all vs pick-your-own benefits for your company and
   defend it"). Never let the student wonder whether they're scrutinising or redesigning.
2. **A visible plan per part** (3–6 concrete steps, generated ONCE per part from the hidden
   essay, cached) shown on the board as an agenda; the current step is marked. Steps are
   scaffolds, not questions: BUILD A LIST → PUT NUMBERS ON IT → SORT/TAG IT → PROS/CONS PER
   ITEM → ARGUE ONE SIDE → SWITCH SIDES → RECOMMEND.
3. **Board scaffolds Q can drive**: a list the student fills (one item per line), a numbers
   table (is / should be), tagging (Q colours items on the board and says what the colours mean),
   a pros/cons grid per item. Their answers fill the scaffold AND land on the page in their words.
4. **One concrete ask per turn** — a list, a number, one pro, one con — never "do you think…?"
   on top of "do you think…?". Never stack; never move on until the scaffold step is filled.
5. **Debate steering** for evaluate/critically-evaluate criteria: get them arguing one side
   with feeling, then flip them to the other, then ask which wins and why → that's the critical
   evaluation, in their words.
6. **No trigger-word dropping.** Jargon appears only when Q is deliberately teaching a term
   (named once, meaning + everyday example) — never sprinkled into questions to be parroted.
7. **Cheaper by design**: plan once per part; scaffold steps are mostly deterministic; Q reasons
   between steps, not on every keystroke.

## ADDENDUM 15 Aug (23:40) — THE MARKING STAGE, PROPERLY (Sarah, verbatim-ish) — DUE TOMORROW NIGHT

*"There should be a board of words — photosynthesis, clouds look like shapes, blue sky — as
BUTTONS on a card. Q finds the words he expects to see in his essay and puts them up for each
section/question. The colour dots have a key you can always see. The dots appear IN THE ESSAY
where he knows a term/button, a citation etc. should be — he puts them in after you've finished
the question and moved on; he marks it subtly as he goes. When you hover over a terminology
button there's a little popup card that explains what it means. Put your cursor at the end of a
sentence and press AUTO CITE: it finds a list of citations you can use; press one and it puts it
in as a Harvard ref. This has to be ACCURATE. He needs to stop giving a shit-load of info and push
you into writing the words he wants you to write. Treat it like you're trying to get an 8-year-old
to write an A-level law essay with referencing and get an A — because that's what I expect this to
be able to do by tomorrow night."*

Also from her screenshot: the terminology tool dumped long definitions onto the board (twice), the
critique card was a paragraph — "all too much to try to teach you". And her session pre-dated the
plan engine, so no plan/worksheet/word buttons/dots ever appeared for her parts.

Required:
1. **Word board per question**: expected terms as buttons; hover → small popup (meaning + one
   everyday example); press → inserts at the caret; green when present/fits. Nothing else on it.
2. **Dots placed in the essay at the right place, quietly, when you move on** from a question:
   Q marks where a citation / term / case study / figure should sit inside the student's own
   text; key always visible; a dot clears when satisfied. Not a lecture at the end.
3. **Auto cite (accurate)**: caret at sentence end → list of real sources — uploaded sources
   first, then a real academic index (OpenAlex / CrossRef, verified metadata) — press one →
   correct Harvard in-text citation at the caret + reference list entry. Never invented.
4. **Critique card = one line + dots + one-line fix.** Tool help = popup card, not board text.
5. **Sessions without a plan get one on open** (backfill), so the worksheet/buttons/dots exist.
