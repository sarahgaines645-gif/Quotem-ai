# HANDOVER — 17 Aug 2026 (night of 16→17) — THE WRITER: partner night, 14 pushes, what is proven and what is owed
*Read `CLAUDE.md` first (the operating contract). Then this. Then
`docs/HANDOVER_2026-08-16_WRITER-LIVE-TESTING-NIGHT.md` (the night before) and
`docs/BRIEF_STUDY_SUITE_REVISION_AND_COURSEWORK.md` (the design, all addenda). Every claim
here has a commit hash; nothing is from memory.*

---

## 0. THE ONE SENTENCE

Sarah asked *"can you be my new partner to get the writer on quotem to work well enough to be
the next best seller for education?"* — and then live-tested for six hours while the answer
was built: **14 writer pushes to `origin/main`, all live on www.quotem-ai.co.uk, every one
mechanically verified (parse, load, unit checks, boot smoke, headless render).** Two review
sweeps found 30 file:line defects; 25 shipped in one commit. The big structural pieces
(**more than one assignment per person**, **marks per bit**, **the Whiteboard**, **the
Editing strip**, **the pause-or-Continue toggle**) exist now. **Nothing tonight was run
against a real model** — her next fresh upload is still the live test, and it needs her £-yes.

Her words that steered it, in order: "make these look nicer" → "more to the point / sea of
words / full mark & fix at every section / a toggle" → "every section = every BIT, and the
word buttons only for the bit we're on" → "a whiteboard he can teach on" → "a list, in colour"
→ "where's the end of that sentence? / what does Grade 2 mean? / what does highlighting mean?
/ this is messy — what's missing, what to do, then a button" → "when I refresh it goes back to
Q1" → "explain this — for people who are struggling; an editing panel with spelling" → "not
in a card, on the page" → "the shading is off — check the other pages" → "handover".

---

## 1. RULES LEARNED TONIGHT (add to how you work)

1. **A cap in code must never hand her half a sentence.** `capWords` (added earlier tonight)
   chopped a fix to "…and add a short…" — she asked "where's the end of that sentence?". Now
   it keeps whole sentences and drops the ones AFTER the cap (3× hard safety). Never
   ellipsis an instruction. (`9a6d532`)
2. **A default that fits the wrong learner is a defect.** Grade scheme defaulted to GCSE 9–1
   → a Level 7 CIPD essay was marked "Grade 2" with no scheme named. Default is now "as the
   brief says" (`schemeLine()`); the card names the scheme when it shows a label.
3. **Verify the fix you shipped last night actually fires.** THE LOOP's floor was
   `split(/s+/)` — the letter s. "total reward" was one word. It went out as "fixed" and was
   not. (`f33c628`) The read-only review sweep is what caught it — do a sweep after every
   live night.
4. **"On the page, not in a card."** Editing tools went into a floating panel first; she
   wants working tools ON the paper. Floating cards are for reading (coach, board,
   whiteboard), not for tools she uses while writing. (`357d66f`)
5. **Match the house.** The hard-edged shadow read as "too graphic"; revise/chat/finance all
   use `10px 10px 28px #ababab, -8px -8px 20px #ffffff` (panels) and `8px 8px 22px` (pop-ups).
   Check the other pages before inventing a look. (`de217b0`, `f0bd8cc`)
6. **Concurrent sessions: stage by HUNK.** The revise session had uncommitted park work in
   `routes.js`/`memory.js`. `scratchpad/stage-mine.py` filters `git diff` hunks by a regex
   and `git apply --cached`s only yours. Never sweep another session's half-done work.
7. **Headless verification works for this page.** Puppeteer at
   `Quoteapp/server/node_modules/puppeteer`; abort all requests (fonts block paint);
   `window.__qwriterTest` exposes `state()`, `setCoach`, `showEditItem`, `partParagraphs`,
   `renderInlineDots`, `termsForBoard`, `setBrief`, `openEditPanel`, `edSetProof`… Every
   feature tonight has a scratchpad `*-shot.js` / `*-test.js` that renders and asserts.

---

## 2. WHAT SHIPPED (newest first, all on origin/main, all live)

| commit | what | her words |
|---|---|---|
| `357d66f` | **Editing strip on the paper** — the tools + Spelling/Grammar under Talk · Download · Mark & fix, opened by "✎ Editing" (and ✎ on the coach card, and "Edit this now →") | "on the page not inside a pop up card" |
| `f0bd8cc` / `de217b0` | floaters back to the house shadows exactly (panels 10/28, pop-ups 8/22) | "shading is off — check the other pages" |
| `057b1f8` | **Spelling & Grammar passes** (`proofread`, `/writer/proofread`): verbatim spans + minimal fixes, underlined on the page (CSS Highlight API), listed with Fix / Fix all, click to jump. **Improve tools on highlight** (highlight → press, or press → highlight arms it). **"Explain this →" on every requirement dot** (`/writer/explain`, plain words + example, lands in the pop-up and on the board); the tool button is off the dot pop-up | "I don't know what this means… cover people that are struggling" |
| `bfa93ee` | **Refresh resumes the Mark & fix walk** (`editPos` TUTOR_KEY; restore rebuilds from lastMark / partMarks / stepMarks and lands on the sentence). **Free-typed page counts for the part she's on** (partParagraphs: no headings → current part; text before the first heading → earliest un-headed part) | "when I refresh it goes back to Q1" / "0 / 1000 words" |
| `9a6d532` | **The fix card = MISSING · DO THIS · "Edit this now →"** (word pile + dots off it; tools + Check it appear after the press; CSS 3-line clamp removed). **capWords never cuts a sentence.** **Grade scheme "as the brief says"** (+ Pass/Merit/Dist L7, Pass/Refer); card names the scheme. **Pink sentence labelled on the page** ("● the sentence Q is on") | "messy… what's missing, what to do, then a button" / "where's the end of that sentence" / "what does grade 2 mean" / "what does highlighting mean" |
| `e82ac23` | the mark on the coach card is a **list with a colour per band** (`bandListHtml`, `moveHtml`) | "better in a list and maybe in a colour" |
| `7101018` | **THE WHITEBOARD** — 4th panel, 760px centred: list tiles + input, sorting = coloured tiles separated into a column per group + legend, numbers table, pros/cons two columns, lesson big, writing step = big word buttons; auto-opens on scaffold/lesson steps; ▦ on the coach card; same state as the small board. Old "Teaching board" → "📝 Board" | "a whiteboard he can teach on… the teaching board is too full" |
| `c4bd2c8` | **Marks on the BIT she just wrote** — `markPart({focus, targetBrickIds, stepId})` marks ONE POINT; job `mark-part:cid:stepId`; `stepMarks[cid:stepId]`; filled accent dots after her failing sentences (click → missing + fix + Fix it →); "Fix these →" / "Next →". **Word buttons = only that step's** (`termsForBoard`: step.terms → derived from the ask → none) | "when I've done that bit he needs to put those marks on it" / "hot key word buttons just the ones for the bit we're on" |
| `ba4d8bb` | **To the point** (TO_THE_POINT rule + caps: question 24, supply 2 sentences/45, hint 14, reaction 12) · **mid-step pause keeps the step's own question wording** · **the toggle** `settings.coachMode` pause/button + "● Continue →" on the coach card and next to Talk · **brief board = story as points, figures bold** · **full Mark & fix per question** (markPart = the marker for one question, 10 items, medium, 9000 tokens, as a JOB `mark-part`) | "more to the point / sea of words / full treatment at every section / a toggle — he asks the question in a different way and I'm still thinking" |
| `8e2005a` | **The review wave — 25 verified defects**: Claude→fallback dropped the schema · essay skipping a criterion = dead end (top-up call) · termCanon everywhere · unfilled step ≠ done · caps in code · TypeError → 502 · weight "AC1.4"→1.4 rejected · re-brief resets stale plans (essayAt) · wordless plan rebuilt ONCE · essay job re-kicked · partMarks persisted · empty digest not stored · partParagraphs heading-range · forceProbe on "Ask me a question instead" · restart clears the task slot · numbers persist (call was in a comment) · no probe under a mark · pause never starts a part · Talk caret before References · first-run paste of a task = the brief · `tests/writer-projects.smoke.js` | (the two read-only sweeps) |
| `c871b7b` | **PROJECTS** — one person, several assignments (`main` = legacy files, `p<hex>` = `${person}--proj-${id}`, index per person, `X-Writer-Project` header, `/writer/projects` + open/rename/remove, switcher pill in the header, per-project stash) | (owed since 15 Aug — unsellable without it) |
| `f33c628` | **THE LOOP regex bomb** — `split(/s+/)` → `\s+` | (found by review) |
| `2656fa7` | tooltips = one soft card page-wide | "can we make these look nicer" |

Other sessions shipped alongside (not mine, don't break them): revise pet — living/park
(`cd5d1a5`, `392cf38`, `68d5886`…), `922f4ab`.

---

## 3. WHAT IS PROVEN vs WHAT NEEDS HER NEXT UPLOAD

**Proven (mechanically):** every commit above — `node -c`, plugin load, every inline script
parsed with `new Function`, unit checks (`scratchpad/check_qwriter.js`, 48/48: capWords /
capSentences / parseWeight / termCanon / userFacingCause / markPart shapes / caps), boot
smokes (`tests/writer-projects.smoke.js` 30+ checks incl. editPos round-trip and `{}` → 4xx
on the new routes; `scratchpad/smoke-mark-part.js` 23/23; `scratchpad/smoke-writer-stale.js`
17/17), headless renders (`tip-shot`, `proj-shot`, `asks-shot`, `pp-test`, `stepmark-test`,
`wb-shot`, `band-shot`, `edit-shot`, `ed-shot`).

**NOT yet seen with a real model — her next fresh upload is the test, in this order:**
0. **THE LOOP now that the floor counts words** (`f33c628`): press two word buttons, write
   "total reward matters here", pause 7s → reaction line, words judged.
1. **Marks on the bit** (`c4bd2c8`): finish a writing step → "Marking that bit…" → dots after
   the failing sentences → click one → missing + fix + Fix it →. Is the per-point mark honest
   and short? Is `focus` making it judge THAT point only?
2. **Full mark per question as a job** (`ba4d8bb`): finish a part → the walk arrives; does the
   medium-effort 9000-token call land inside a sane time on her sister's ~1000-word part?
3. **To the point** (`ba4d8bb`): are the asks ≤ ~20 words and preamble-free with a real model?
4. **Spelling / Grammar** (`057b1f8`): does `proofread` find her sister's real slips
   (technowlogy, desisions, loose, veriety, egsample, engeneers, inguries, wearhouses, safty,
   fule, forcast, fincial) — and NOTHING else? Any false positives = fix the brief text.
5. **"Explain this →"** on a dot: plain enough for someone who has not read the docs?
6. **The essay top-up** (`8e2005a`) and **followUp synthesis** — reasoned, not run.
7. **Refresh mid-walk** (`bfa93ee`): resume lands on the same sentence.
8. **The Whiteboard** on a real sorting step: do Q's colours/legend look like teaching?

Old plans do NOT retro-fit any of this — she must "Start again from scratch" (~50p–£1 per
fresh brief) and needs to set the grade scheme to "As the brief says" (cog) on the existing
session.

---

## 4. OWED — in priority order

1. **The live quality pass on §3** — the moment she gives the £-yes with a figure.
2. **Draft / resubmission detection** (open since 15 Aug): her sister's file was a completed
   submission — "start fresh or improve what's here?"
3. **Slowness**: model essay (14000) + end mark (20000) at medium; per-question mark now also
   medium/9000. Her call on depth vs wait; parked at her request.
4. **Toggle reachability**: the pause/Continue toggle lives in the setup strip (cog). She may
   want it on the coach card.
5. **Whiteboard as a teaching surface**: it renders the scaffold big and coloured; Q does not
   yet DRAW on it (arrows, annotations). Next step if she wants "he teaches on it": a
   `whiteboardNote` per step from the plan (2–3 annotations Q writes on tiles).
6. **Editing strip**: no persistence of proofread results across refresh (re-run is one small
   call); "phrases" tool = What's weak on a highlight — she may want a dedicated one.
7. `coachWordsHtml` is now dead code (word mirror removed from the fix card) — delete when
   convenient.
8. `partMarkDone` per page-load — now seeded from partMarks on restore (fixed in the wave).

---

## 5. HOW TO SHIP (what worked all night)

- Verify: `node -c routes.js plugins/q-writer.js plugins/q-claude.js memory.js`;
  `node -e "require('./plugins/q-writer')"` (load order); parse every inline `<script>` with
  `new Function` (script file, not inline `node -e`); `node tests/writer-projects.smoke.js`
  (boots a throwaway server + volume, logs in with the bootstrap password from the log,
  30+ checks — copy its harness for new smokes); headless renders with puppeteer from
  `C:/Users/sarah/OneDrive/Desktop/Quoteapp/server/node_modules/puppeteer` — abort all
  requests, replace `fetch(` with a rejecting stub, drive via `window.__qwriterTest`.
- Python patch scripts, not heredocs with quotes (the shell ate them twice); write the
  script with the Write tool, run it, assert each `old` occurs exactly once.
- Commit BY PATH with `-F msgfile`; if another session has hunks in the same file, stage by
  hunk (`scratchpad/stage-mine.py <file> "<drop-regex>"`), `git show :file | node -c`.
- Push = deploy (Railway). Poll `https://www.quotem-ai.co.uk/health?x=<n>` for `uptimeSec`
  reset. `git push` may show a different base hash — other sessions push too; fine as long as
  it fast-forwards.
- **No paid runs without her £ + yes.** Everything tonight was stubs, unit checks and headless.
- ⚠️ `callQ` must NOT get `response_format` (DeepSeek V4 silent-`{}` trap) — the schema goes
  in the prompt. ⚠️ Never sweep `cost-tracker.js` (another session's hunk sat there all night).

---

## 6. SARAH TONIGHT

Live-testing on her sister's real Level 7 brief from ~21:00 to ~03:00 the following morning
while this was built. Every message a precise defect or a precise design ("Missing · Do this
· Edit this now →"; "a whiteboard he can teach on"; "on the page, not in a card"). Sharp,
generous ("this is pretty impressive so far!", "thank you!!!"), and immediately back with the
next thing. She wants short reports, the work done, no menus. When she says something looks
wrong, look at what it WAS and what the other pages do before inventing.

Never tell her to stop or rest. Never say done unless verified. Her criticisms are the spec.
