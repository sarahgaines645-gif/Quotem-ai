# HANDOVER — 15 Aug 2026 (late) — THE STUDY SUITE: coursework coach + revision teen mode + the spin-outs
*Written because the session's context got too big to keep paying for. Read `CLAUDE.md` first
(the operating contract). Then this, all of it. Then the brief. Nothing here is from memory —
it is what happened today, with commit hashes you can check.*

---

## 0. THE ONE SENTENCE
Q's coursework coach (`writer.html`) is being rebuilt to Sarah's method — **Q holds the whole
essay in his head and steers the student into writing it in their own words, never writing a
word himself** — it is LIVE and Sarah is using it on a real CIPD Level 7 brief. A build agent
was mid-way through the next four slices when this session handed over. **Sarah's deadline,
her words: "treat it like you're trying to get an 8-year-old to write an A-level law essay
with referencing and get an A — because that's what I expect this to be able to do by
tomorrow night" (16 Aug). She said "deal?" — the answer given was deal.**

---

## 1. SOURCE OF TRUTH FOR THE DESIGN — read every addendum
`docs/BRIEF_STUDY_SUITE_REVISION_AND_COURSEWORK.md` — the original brief + ~10 ADDENDA, each
in Sarah's own words from her live use tonight. The LAST addendum ("THE MARKING STAGE, PROPERLY
— DUE TOMORROW NIGHT") is the current work order. The rules, all hers, in the order she gave
them:

1. **Q reads the brief so the student never does.** "I want to upload a coursework file/link
   that I have no idea about and it walk me through until I've completed it and I never have to
   read the doc and get an A." Brief board collapsed to one line in Q's words; formal brief
   behind a fold.
2. **Q writes the full model essay in his back room** (from the brief + any case studies
   uploaded), keeps it hidden, and steers the student toward it. **His sentences never enter the
   document** — integrity line, shown on the page. This is what makes it sellable to a college.
3. **Steer, don't suggest.** "He shouldn't be suggesting as we go. He should be steering and
   then editing when we are done." The mid-flow reframe card ("your sentence, your voice") was
   REMOVED. An answer (typed or dictated) lands on the page in the student's exact words; Q asks
   the next thing.
4. **The tutor's mission** (in every writer prompt as MISSION_BLOCK, near-verbatim): "These are
   his essays. These are his marks. No other AI is managing to be graded by teachers. Writing an
   essay is easy for an AI — the challenge is writing it THROUGH a human who is the obstacle…
   Steer them until their essay matches yours without ever telling them what to write. Every
   mark they earn is yours too." It's a game; closeness score per part; no marker-speak.
5. **The brick loop** (her sky/photosynthesis example, verbatim in the brief): Q asks →
   student answers → **Q SUPPLIES the fact/term/theory/argument plainly ("it's called
   photosynthesis") — ASSUME THEY DON'T KNOW, always supply first** → asks for THEIR sentence
   about it → it lands on the page → next brick. Works at every level: term, fact, theory,
   argument, whole line of reasoning, structure. "It's about getting them to say your words —
   on a bigger level."
6. **Q formats, they write.** "Tell me 5 benefits your company offers → he writes them in
   colours: pink are flexi, blue are fixed. Now you've learned which is which and only because
   he formatted them. He doesn't need to ask." Raw material from the student → Q colours/sorts/
   labels it on the board with a legend; later asks refer to the coloured groups.
7. **Scaffolded, not question-stacked.** "List your benefits… now numbers: 30k should be 45,
   bonus 3k deserve 5… then pros and cons per item… get me passionately arguing one side then
   change sides." Frame each part in role terms first ("here you're the critic…"); one concrete
   ask per turn; teach-then-apply (hints don't teach someone who doesn't know); no trigger words
   sprinkled ("if he keeps name-dropping trigger words I'll use them back to him").
8. **The card is where he talks; the board is the worksheet.** No echoing the same question on
   both. Cards = three blocks: where you are (small, muted, full only first time) / the ask (big,
   alone) / one hint (never repeating the ask).
9. **The marking stage** (LAST addendum, the current job): a **word board** per question —
   the terms Q expects in his essay as BUTTONS (hover → small popup with meaning + everyday
   example; press → inserts at the caret; green when present/fits; "still to use" list).
   **Coloured requirement DOTS placed IN THE STUDENT'S TEXT at the exact spot** (end of the
   sentence that needs a citation / term / case study / figure), quietly, when they finish a
   question and move on — **click a dot → what's missing right there + the ONE tool to fix
   it**; key always visible. **AUTO CITE, accurate**: caret at sentence end → list of REAL
   sources (uploaded sources first, then a real academic index — OpenAlex/CrossRef, verified
   metadata) → press → Harvard in-text + reference list. Never invented. **Critique card = one
   line + dots + one-line fix.** Tool help as a POPUP, not dumped on the board. "He needs to
   stop giving a shit-load of info and push you into writing the words he wants."
10. **All subjects.** "This has to work for all subjects." Nothing CIPD/HR-specific in prompts,
    kinds, or lookups; the harness must include a second-subject fixture (e.g. fictional A-level
    Law). Requirement kinds generic + subject-appropriate extras (statute, case law, primary
    source, diagram) allowed with label + colour.
11. **Cost matters.** Plan once per part (cached); ~plan 1 + tag 1 + ~3 checks per part; every
    call through `logUsage`. "Every question is costing money."
12. **Never real student work in fixtures**; Sarah's test file (Downloads:
    `7HR03_Strategic_reward_management -FV.docx`, her sister's real completed CIPD submission)
    was read locally only and must never be committed or used as a fixture.

---

## 2. WHAT IS LIVE (www.quotem-ai.co.uk — bare host has a TLS fault; ALWAYS use `www.`)
All on origin/main and deployed by Railway (push = deploy). Newest first:

- `7032edc` **expectations** — per part: minimalAsk (one line), expectedTerms (buttons that
  insert at the caret and go green), requirements (citation / reference / case-study / figure /
  theory / example / recommendation with fixed colours) as dots + key on the board AND in the
  page margin; check-sentence, step checks and the mark report termsUsed/requirementsMet;
  Mark & fix critique cards use the same dot vocabulary.
- `7308174` **auto-tag + video** — pressing Done on a list runs the tag step itself (one call,
  no click, no quiz), Q's ack IS the legend line, a persistent WORKSHEET block keeps the coloured
  list + legend + the numbers table with the gap drawn; `plugins/q-youtube.js` (YouTube Data
  API v3, key ONLY from `process.env.YOUTUBE_API_KEY`, no key → null, safeSearch strict,
  embeddable only, GB, channel-first ranking by level, 24h cache) + `POST /writer/video` +
  `POST /revision/video` + a Video panel (same panel manager, youtube-nocookie 16:9 embed).
  **Sarah enabled the API — she still has to put `YOUTUBE_API_KEY` into Railway → Variables.**
  Without it the button opens a YouTube search tab; nothing breaks.
- `fc20e94` **Sarah's method, slices 1–3** — part PLAN once per part (role sentence, 3–8 steps
  of kinds list/numbers/tag/pros-cons/argue/switch/recommend/ask/TEACH, each with targetBrickIds,
  scaffold spec, supply/thenAsk, lesson/example/term; cached in the tutor notebook `plans[cid]`);
  BRICK_LOOP_RULE in MISSION_BLOCK; scaffold widgets on the board; restore lands on the same
  step; coach-box intent ("how am I doing?" answered locally with part/step/score/missing;
  questions to Q answered once via probe trigger 'question'; ≤3-word ambiguous → "answer, or a
  question for me?"); board = worksheet (one-line step title; full Q+A only in "Earlier (n)");
  teach-on-demand ("I'm stuck"/"I don't understand" → mini-lesson + example → apply ask; lesson
  never on the page); supply-first on knowledge bricks; **legacy grade bands + "Improve →" flow
  REMOVED and stripped from restored docs**; **"Mark & fix →"** primary button (one mark call →
  bands + per-sentence critique, weakest part first → critique card → tools → check → score
  climbs → next → end-of-pass card); plain criterion labels regenerated once for old briefs
  (one tiny paid call on next load). Routes added: `/writer/plan`, `/writer/tag`, `/writer/step`,
  `/writer/teach`, `/writer/labels`; probe takes plan/stepId/studentQuestion.
- `b8bbbbd` **the game pass** — no reframe mid-flow (exact words to page, 10s undo);
  MISSION_BLOCK in every writer prompt; edit stage = highlight one sentence + why + tool buttons
  (Terminology · Synonyms · Dictionary · Strategies · Case studies · References · Explain
  what's weak) + "Check it" → closer / that's it / one thing missing (`/writer/tool`,
  `/writer/check-sentence`); brief folded ("Show the brief"); "Part n of N — <plain label>" on
  card + board; closeness score (matchScore from bricks voiced/close — never text similarity);
  brief board / teaching board / coach card are windows (drag by header, corner resize,
  minimise to pill, clamped to viewport, remembered per user; ≤700px = docked bottom sheet);
  board simplified (current + latest hint, "Earlier (n)" folded, answers in normal ink, no
  italics, hairline rule; same for `p.student-line` on the page); ukJson polish at every
  `/writer/*` route boundary (student's words/refs/ids/urls untouched); marker-speak removed.
- `dff18e6` **hotfix** — pause-watcher no longer requires focus (idle = no typing for pauseMs;
  re-arms; fires on sentence end or 2× pause; 12 new chars; 8s floor only pause-probes start);
  reframe response shape normalised server-side (the "Put it on the page" TypeError);
  `insertQText` refuses empty; UK_LINE house style + PLAIN_QUESTION_RULE in every writer prompt;
  plain ≤4-word labels in the brief schema; `polish-uk.js` -ize rule bug fixed ("organize" →
  "organises" — was live on chat).
- `897613b` **revision TEEN MODE** — opt-in Teen ↔ Sensible switch (remembered; sensible = page
  unchanged); `assets/study-fx.js` (52 effects ported from the catalogue, sound-free,
  reduced-motion aware, perf-scaled); starter set (correct → paint splat + sparks, COMBO from a
  streak of 3, sunburst every 5th, flame border grows; wrong → tomato + glitch + shake + red
  vignette, shatter on 3 in a row; unlock/mastered → sunburst + neon flicker); **Lights** panel
  (every effect on/off per event, Try, Motion, Sound); Phase-1 defects fixed (bank-build
  failures shown + Retry, top-up not restart, tag normalisation, 4-option schema with repair,
  honest progress save with 413→compact, examAsked persisted, sound off by default,
  prefers-reduced-motion, "tower" copy). Server half went in `3a969f1`.
- `3a969f1` **the coursework coach** — `/writer/brief` reads the WHOLE brief (12k-char slice
  gone) via Sonnet with a schema (criteria, bands, skeleton, opener); hidden model essay
  (`writeModelEssay`, per criterion → bricks tied to uploaded sources; up to 6 supporting docs
  via `/writer/source`); `/writer/probe`; autosave every 1.5s + full restore; jobs persist
  across restarts; failures show their cause; `.docx` download; typed 413s; `.doc` refused
  with a reason. Root cause of "Something went wrong — shall I try again?" since 17 May:
  `switchToBoardMode()` reached for `#brief-board-badge` and the span only had a class.
- `ad85c61` **Q clean-up** — voice-clone + music RETIRED (`retired/2026-08-15-voice-clone-and-
  music/` + RETIRED.md; yt-dlp/ffmpeg out of nixpacks); `emailSlug()` collision fixed (legacy
  slug + sha256 suffix) with idempotent boot migration that refuses (CRITICAL log) on a real
  collision; signup email verification (grandfathered existing Circle; approval also verifies);
  `Q_AUTH_PEPPER` mandatory in production (refuses to boot; dev gets a random key);
  `EMAIL_TOKEN_KEY` derives from the pepper if unset (the key existing mailbox tokens were
  written with — no outage) and warns; cost meter (`logUsage/usageFrom/runAs`) wired into
  every LLM caller with a provider-verified price table (Kimi-K2.5 flagged unpriced); global
  unhandledRejection/uncaughtException handlers; `plugins/timed-fetch.js` AbortController
  wrapper; typed error handler; street_view accepts GOOGLE_MAPS_KEY or GOOGLE_PLACES_KEY.
- `959f547` **hotfix cost-tracker.js** — the finance session's `fb3cc8f` had swept in
  `logUsage(...)` calls in q-finance.js without the tracker → every finance AI call would have
  thrown on Railway; shipped the tracker alone.
- Docs committed: `docs/STUDY_SUITE_PHASE1_FINDINGS.md`, `docs/study-suite-looks/index.html`
  (six palettes — reference only) and `docs/study-suite-looks/effects.html` (55 fireable
  effects, the one Sarah loved), `THE BREAK-OFF LIST - Q (15 Aug 2026).md` at repo root.

---

## 2b. UPDATE 16 Aug 00:15 — SLICE A SHIPPED (`d27a2e4`)
Word board (buttons only, hover/long-press popup with meaning + example from a plan glossary),
tool help as popup not board, one-line critique + dots, three-block coach card, backfill plans
for pre-plan sessions (one call per part), subject-neutral prompts + extended requirement kinds,
second-subject (A-level Law) fixture in the harness. 117/117. **The build agent is CONTINUING
with slices B → C → D and will send SAFE messages; a new session should treat those as its own,
verify with §4, and push by path.** If no SAFE arrives, `git status` tells you what is on disk.

## 2c. UPDATE 16 Aug 00:40 — SLICE B SHIPPED (`283b58f`)
Dots placed IN the student's text at the end of the sentence that needs them (one structured
call per finished part + per part with unmet kinds after a mark; content-cached), furniture only,
click → "MISSING HERE · label" + one why line + ONE action; margin dots retired; 128/128.
**Agent continuing with C (Auto cite) then D.** Slice C's dot action "Auto cite" currently falls
back to the References tool until C lands.

## 3. WHAT WAS IN FLIGHT AT HANDOVER — check `git status` in this repo FIRST
A build agent was working the LAST addendum in four slices, under these rules: no commits;
no paid AI calls (AI stubbed via a `--require` preload replacing `q-claude.accurateJSON`);
verify per slice (node -c, inline parse, boot smoke, headless Edge harness incl. a
SECOND-subject fixture); report SAFE at each slice boundary; keep every slice deployable.
- **Slice A** — backfill: sessions/parts without a plan get one on open (Sarah's live session
  pre-dates the plan engine, so she saw no worksheet/buttons/dots); WORD BOARD card per part
  (buttons only; hover/long-press popup with meaning + example from a term glossary added to
  PLAN_SCHEMA; press inserts; green); tool help as a POPUP anchored to the coach card, not board
  items; critique card = one line "Missing: ● ● ●" + one-line fix + tools + Check; three-block
  card layout for every step (where you are / the ask / one hint — no duplicate "one per line").
- **Slice B** — inline dots IN the student's text at sentence end when a part is finished (and
  after Mark): a small structured call → [{sentenceIndex, kind, why}]; furniture only
  (contenteditable=false, never in docPlainText/save); click → popup "what's missing right here"
  + the ONE matching action at that caret; key visible; dot clears when satisfied; margin dots
  become secondary/removed.
- **Slice C** — `plugins/q-cite.js` AUTO CITE: uploaded sources first (bibliographic details
  extracted from the file, never invented), then OpenAlex (`https://api.openalex.org/works?
  search=…`, polite `mailto` from env if set) with CrossRef fallback; Harvard formatting in code
  from verified metadata (in-text author-date; Cite Them Right reference list); "Auto cite"
  button on the coach card + Mark & fix cards; press a candidate → in-text at the caret +
  References list entry (dedupe, sync the existing references drawer); nothing reliable → say
  so, offer the References tool.
- **Slice D** — push, don't inform: ≤ one supply line + one ask per turn; explanations only on
  "I don't understand" (≤4 sentences) or hover popups; measured card-text cap in the harness.
- Also asked of it: subject-agnostic everywhere + a fictional A-level Law fixture; grep prompts
  for subject words before SAFE.

**If `git status` shows uncommitted changes to `writer.html` / `plugins/q-writer.js` /
`routes.js` / `plugins/q-cite.js`: do NOT assume they are finished or consistent.** Either
relaunch a build agent with the last addendum + this section as its brief and tell it to
inspect the on-disk state and continue from there, or verify the diff yourself (recipe below)
before shipping. If the tree is clean, nothing landed — start at slice A.

---

## 4. HOW TO SHIP (what worked all day)
1. Verify: `node -c routes.js plugins/q-writer.js plugins/<new>.js`; extract every inline
   `<script>` in `writer.html` and `new Function()` it (a script file, not inline `node -e` —
   shell escaping mangled a regex once); `node -e "require('./plugins/q-writer')"` loads
   (a load-order bug — REQ_KINDS used before definition — was caught this way once).
2. Boot smoke: `NODE_ENV=production RAILWAY_VOLUME_MOUNT_PATH=<scratch dir> PORT=81xx
   TOGETHER_API_KEY=throwaway Q_AUTH_PEPPER=<16+ chars throwaway>
   SARAH_EMAIL=verify@example.test node server/index.js` → poll `/health` until 200, then wait
   ~4s more (the bootstrap prints Sarah's password ONCE in the log after listen), log in, GET
   `/writer` `/revise` `/writer/tutor` = 200, POST the new routes with `{}` → 4xx not 500, grep
   the log for `TypeError|ReferenceError|cannot find module|Failed to mount`. Kill it
   (`netstat -ano | grep :81xx` → `taskkill //PID … //F`).
3. Commit **by path only** (`git add -- <files>`; `git commit -F <msgfile>` — heredocs with
   quotes break; write the message to a file). **The finance session shares this repo and
   commits/pushes concurrently** — never `git add .`; check `git status` for other people's
   hunks first; a stray commit of a shared file once broke live (`959f547`). Push = deploy.
4. Confirm live: fetch `https://www.quotem-ai.co.uk/health?x=<n>` (`uptimeSec` resets on the
   new process). The sandbox's `curl` cannot reach the host (returns 000) — use the fetch tool
   with a cache-busting query. Sandbox `Remove-Item` on scratch dirs gets blocked — leave them.
5. Every user-facing string Q writes goes through `ukJson`/`polishUK`; no vendor names on any
   user surface; UK English; no Quotem font/style — Q has its own look.

---

## 5. OWED / NOT DONE (in priority order)
1. **Slices A–D above — due 16 Aug night.** Then the FULL harness on both fixtures.
2. **Draft/resubmission detection**: on upload, detect answers/marker feedback in the document
   ("Question n (AC x.y)", "Assessor feedback", declared word count, appendices) and ask ONE
   thing — "This already has answers in it: start fresh, or improve what's here?" Improve mode:
   brief = questions only; existing answers = the student's draft on the page; marker feedback =
   first coaching target. Never let prior answers seed "what it's asking" (that's exactly what
   happened with Sarah's test file — the "medium-sized tech company" came from the answers).
3. Video panel on `revise.html` (route `/revision/video` already exists; use the same panel
   manager pattern; do not disturb teen mode).
4. Railway: Sarah to set `YOUTUBE_API_KEY`. `Q_AUTH_PEPPER` confirmed present by her.
5. **Real-model QUALITY is unproven** — everything today was verified with stubbed AI (68 → 81
   → 93 → 104 headless checks). Sarah's live use is the test; the cost meter (`logUsage` →
   `cost-tracker.js`, view at `/admin/costs`) shows the true £ per essay. Estimates from token
   sizes: brief ~6–7p, model essay ~7–10p (+ per source), probes ~1p cached, mark ~6p,
   edit ~7p → roughly 50p–£1 per essay; plan-based coaching should be cheaper.
6. Rule kept all day and to keep: **no paid test runs without Sarah's £ figure + yes.**
7. Revision paid quality checks (~£1: bank build, live batches, exam marks, explains).
8. `/writer/edit-pass` route left in place unused (harmless); Kimi-K2.5 unpriced in the cost
   table; the finance session's own owed items are in its own handovers.

---

## 6. THE SPIN-OUTS (Quoteapp side — separate from Q, decided today)
- **Fix My Sheet = the break-away product** (Sarah's brief: "one I can break away to sell to
  see how it's done… I don't need to give out my main app"). The spreadsheet audit engine
  (`server/templates/sheet-cleaner.js` chain — universal, proven) as a standalone: own domain,
  no accounts, free teaser audit → one-off Stripe → full findings + fixed COPY; originals never
  touched; money-moving fixes never auto-applied. **Scaffold built** at
  `Quoteapp/fix-my-sheet-standalone/` (engine copied verbatim, server.js on :3100 in safe mode
  — no key = clean 503; DEV_MODE=1 fake-pay stub; one-page front end with its own look, zero
  Quotem branding). Plan: `SPINOUT PLAN - Fix My Sheet (15 Aug 2026).md`. **Waiting for Sarah's
  yes on a few pounds of cost-measure runs**, then name/price (Excel consultants £75–200/hr; file
  repair ~$10/file are the anchors), domain, real Stripe, own repo.
- **Quote Builder = what people buy from the MAIN app** (later; restore-to-magic first;
  Tradify £34–44/user/mo, Payaca from £299/mo verified). Plan doc at Quoteapp root.
- **SOR licence** (Sarah): cannot sell the dataset whole; CAN sell products that use it.
- **The break-off lists**: `Quoteapp/THE BREAK-OFF LIST - everything sellable (15 Aug 2026).md`
  (~60 units, 14 own-app candidates, Landlord Legal Pack + Council Field-Ops bundles; Quotem
  Health & Safety already specced 7 Jul; Linkmail the dark horse) and `quotem-ai/THE BREAK-OFF
  LIST - Q (15 Aug 2026).md` (8 worth breaking off; the Revision drill = standout; three gates
  that blocked selling anything from Q were closed today in `ad85c61`).
- Side-findings still owed: `q-tool-deploy/README.md` + `HANDOVER.md` hold live plaintext
  Replicate/HuggingFace/RunPod keys — rotate + scrub; RunPod may still bill ~$0.083/hr for the
  old 177GB volume; `Quoteapp/client/dist-site-report/` is a stale July build.

---

## 7. SARAH TONIGHT — how to work with her on this
Fully engaged, testing live, screenshotting every rough edge; her criticisms ARE the spec —
turn each one into a precise change and ship it. She said: "the more I criticise the better
this gets", "we need to move faster" (→ ship in verified slices; her live use is the test), and
"treat it like you're trying to get an 8-year-old to write an A-level law essay with
referencing and get an A." Keep replies short, do the work, report. Never tell her to stop or
rest. Never say done unless verified. Memory notes for this work:
`project_q_cleanup_and_study_suite_2026_08_15`, `project_q_break_off_list_2026_08_15`,
`project_spinout_breakaway_fix_my_sheet_2026_08_15`, `project_spinout_quote_builder_first_2026_08_15`,
`project_sor_licence_terms_2026_08_15`.
