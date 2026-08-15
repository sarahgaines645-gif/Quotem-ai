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
