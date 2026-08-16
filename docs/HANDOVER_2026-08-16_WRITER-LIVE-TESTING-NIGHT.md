# HANDOVER — 16 Aug 2026 — THE WRITER: one night of live testing, 22 fixes, and what is still owed
*Read `CLAUDE.md` first (the operating contract). Then this. Then
`docs/BRIEF_STUDY_SUITE_REVISION_AND_COURSEWORK.md` (the design, all addenda) and
`docs/HANDOVER_2026-08-15_STUDY-SUITE-COURSEWORK-COACH.md` (the previous night). Nothing
here is from memory — every claim has a commit hash.*

---

## 0. THE ONE SENTENCE
*(Updated ~05:00: three more shipped after the first write — the story in the brief, where-it-goes + sentence-after-list, source digests + spoken questions. Rows at the top of §2.)*

Sarah drove `writer.html` live on her sister's real CIPD Level 7 brief from ~01:00 to ~04:00,
screenshotting every rough edge; **each one became a precise fix and shipped within minutes**
(22 writer commits, all pushed, all live at www.quotem-ai.co.uk). The app is now materially
closer to her spec — one step at a time, colour on the words, honest green, per-question word
boards, real citations with evidence, question numbers, talk-onto-the-page, navigation, start
from scratch, leading questions, per-question mark & fix, two-file briefs, word budgets, and
finally THE LOOP (Q reacts in the pause). **The last three are proven mechanically, not with a
real model — her next upload is the test.**

Her verdict mid-way: "everything else is soooo good!!" — and then the next screenshot.
Her criticisms ARE the spec. Keep working that way.

---

## 1. RULES LEARNED TONIGHT (add these to how you work)

1. **A rule that lives only in prose to the model is not a rule.** Three times tonight a
   schema said "3 to 6 steps" / "12 words or fewer" / "up to 25" and the model returned 11 /
   20 / 25+. These schemas carry no minItems/maxItems. **Enforce every cap in code**
   (`trimToMaxSteps`, `oneLineAsk`, `MAX_CRITIQUE`, `factsFirst`, `noTheoryBeforeFacts`,
   `leadingAsk` in `plugins/q-writer.js`).
2. **"Real but not relevant" is the same failure as "invented".** The citation engine served
   a paper on airway syndrome in pugs; the video engine played a fitness vlog for "pay
   progression". Both real, both verified, both useless. Both now have a relevance gate
   (`isRelevant` in `q-cite.js`; `topicTerms` word-boundary match in `q-youtube.js`).
3. **Trace every way in, not just the one you fixed.** The two-file brief took two rounds:
   the drop path was fixed, the click path still set `multiple=false` (writer.html
   `renderSourceSlot`). Grep for every handler before saying done.
4. **Never assume a session is alone in the tree.** Three sessions shared this repo tonight
   (writer, finance, revise). Commit BY PATH, verify content after, check `git status` for
   other people's hunks. My `522cee8` swept the build agent's uncommitted Auto cite UI into
   HEAD with no route behind it — caught by checking, completed in `a6aa64e`.
5. **The Railway health check tells you when the new process is up:** `uptimeSec` resets.
   Poll `https://www.quotem-ai.co.uk/health?x=<n>` until it drops under ~200s.
6. **Load-order trap is real:** a schema that references `EDIT_TOOLS` above its definition
   throws on `require`. `node -e "require('./plugins/q-writer')"` catches it; `node -c` does
   not. Make such schemas lazy (`partMarkSchema()`).

---

## 2. WHAT SHIPPED TONIGHT (newest first, all on origin/main)

| commit | what | her words |
|---|---|---|
| `bac18aa` | **THE STORY IN THE BRIEF** — `scenario` on BRIEF_SCHEMA (story, people, numbers exact, problems, useIt); in `briefForPrompt` so EVERY prompt knows it; 📖 first on the brief board; `POST /writer/brief/scenario` (`extractScenario`) backfills a stored brief once on restore | "there's still no simplified case study or brief. the story that you're basing the questions on" |
| `96142fd` | every ask says WHERE it goes (board vs paper under Question n); `listNeedsASentence` — a list/numbers step is always followed by an ask for the SENTENCE about it (before the cap, so it survives) | "he doesn't put it on the paper. he needs to specify where to write it" |
| `c3b0f90` | supporting-doc DIGEST (`digestSource`, background, stored on the source, `/writer/source/digest` retry, backfilled on restore) on the brief board; spoken QUESTIONS classified as questions (no `?`, no word cap, "Q, …", "I do not understand"), answer ON THE CARD not board-only | "expecting you to have read the case study" / "he just asks the question again and ignores my question" |
| `f7434c4` | **THE LOOP** — pause probe judges the expected words (`termsUsed` → green, `termsMisused` → OFF green + one plain line why), returns a one-line `reaction`; watcher floor is 2 WORDS not 12 chars ("saves money" was 11 chars — that is literally why he said nothing) | "I just pressed them all together and wrote 'saves money'. Stopped typing and they stayed green and Q said nothing." |
| `0a8e0ab` | two-file brief, actually — click handler had `multiple=false`; "+ Add the rest of the brief" button; join is server-side (`/writer/brief {append:true}`) so it survives refresh | "it still won't let me upload 2 docs" |
| `263fffd` | word budget per question — arithmetic on brief total × criterion weight, on the criterion as `wordBudget`, live "312 / 980 words" in the Now block, amber 90%, red over; backfilled on GET /writer/tutor | "he needs to estimate the word count per question so we don't go over" |
| `c8e2398` | brief can be several files (drop path + input `multiple`) | "I need both to make the whole question and brief" |
| `5cb3370` | **mark & fix per question** — `markPart` + `POST /writer/mark-part` (sync, low effort, ≤3 fixes) fires when a part's steps finish, walks the fixes, then Next question; `endFixPass` continues via `state.partFixThen` | "we need Q doing the mark and fix as you answer each question so you actually get direction" |
| `1857a00` | **leading questions** — `LEADING_QUESTION_RULE` in all 8 question prompts with her 4-ask worked example; in code: `factsFirst` (fact step moved to front), `noTheoryBeforeFacts` (`supply` stripped from opening/collecting steps — this is where the Marchington dump came from), `leadingAsk` (dead openers + trailing ", or …?" cut) | "I may as well be reading the paper myself. It should be saying what are your business goals… what are the benefits… then lead you into debating them" |
| `60e007d` | Start again = from scratch, page too; stashes writing in localStorage + "Put my writing back" | "the start again isn't clearing. I want to start from scratch" |
| `dadba70` | beads are buttons (go to any step), Q1–Q4 buttons under them, restart | "no way to go back to other q's. no way to restart" |
| `ea98479` | citations show WHAT THE SOURCE SAYS (OpenAlex abstract reassembled from inverted index) and ask for her sentence; named-concept query (`namedConcept` — capitalised phrase or concept-noun phrase, searched ALONE); field-sorted; bad abstracts dropped | "isn't it supposed to actually quote them?" / "what's the point in citing if there's no words to back up your sentence?" |
| `8c2ba8f` | in-text citation goes IN THE SENTENCE (caret/part fallback), placement confirmed by reading the doc back, honest messages; `escapeRe` had a comment spliced into it — restored | "it's gone in at the end of the doc but isn't it supposed to be in the essay?" |
| `d430df9` | Talk button on the Mark & fix card; caret goes to end of highlighted sentence | "when you're editing you can no longer access the mic" |
| `5205341` | page mic ("Talk" on doc toolbar, final chunks only, caret-aware); question headings in the doc (`ensurePartHeading`, `p.q-part-head`); board captions + air | mic / "the doc needs question numbers" / "too crowded" |
| `277710a` | word board per question — `terms` on each step (2–4 of the part's expectedTerms), `termsForBoard` | "the word board needs to be per question" |
| `5632b2e` | Next always exists (was gated on step filled → trapped); green = Q checked, seen = muted + dot | "there's no next button. no way forward" / "they stayed green" |
| `ecd1f3b` | video relevance gate (word boundaries: "step" ≠ "Stepping") | fitness vlog for pay progression |
| `57bd897` | scaffold stays on the board — list/numbers/proscons no longer write into the doc | "the list he had me write went straight into the doc" / "isn't forming into sentences" |
| `658115f` | mark budget 9000→20000 + `MAX_CRITIQUE` 10 (the 502); wordless plans rebuild (`planHasWords`, server `wordless` check) | "it keeps saying marking failed" / "word board but no buttons" |
| `a6aa64e` | `/writer/cite` route + relevance fix (quote the concept, drop off-topic) — completes the build agent's slice C | pugs paper |
| `522cee8` | ONE step on the board (`tb-now` + beads, agenda list gone); colour on the WORDS (`li[data-tag]{color}`); unsorted item looks unsorted; server caps `MAX_PLAN_STEPS`=6, `oneLineAsk` | "one step at a time so he can make you write what he wants per sentence" / "no text has been coloured pink" |
| `e717563` | revise.html video card (drag/resize/remember; tube pauses); `q-youtube.js` accepts `GOOGLE_PLACES_KEY`/`GOOGLE_MAPS_KEY` (was gated on `YOUTUBE_API_KEY` alone → every lookup null) | "a card for YouTube… inside our page" |

Other sessions shipped alongside (not mine, don't break them): revise pet (`b0a4fe4`, `7d50945`),
UK stages (`a6c25bd`), popup fixes, palette to `#f3f3f3` (`84b2cf4`), finance work.

---

## 3. WHAT IS PROVEN vs WHAT NEEDS HER NEXT UPLOAD

**Proven (mechanically — parse, load, boot smoke, unit checks, served-page asserts):** everything
above. Every commit message lists exactly what was verified.

**Proven against live indexes (no model):** citation relevance across HR / law / biology /
nursing (`q-cite.js`); video relevance (8 title/query pairs).

**NOT yet seen with a real model — her next upload is the test, in this order:**
0. **The story in the brief** (`bac18aa`): on reload, 📖 lands on the brief board — is it a faithful plain telling of her CIPD case? Numbers exact? Then: do Q's asks now NAME the company instead of "your organisation"?
1. **THE LOOP** (`f7434c4`): press two word buttons in, write "saves money", wait 7s. Expect: a
   one-line reaction on the coach card, the pressed words dropping OFF green with a reason. If
   silent, ask what the card shows ("READING…" stuck ≠ silence).
2. **Leading questions** (`1857a00`): does a fresh plan open on a fact-gathering step with an
   answerable ask, theory demoted? Structure is code-guaranteed; wording is the model's.
3. **Per-question mark** (`5cb3370`): finish a part's steps → mark card → ≤3 fixes → Next.
4. **Word board buttons populate** with real terms on a fresh plan (`658115f` + `277710a`).
5. **Two-file brief** (`0a8e0ab`): pick both in the picker, or one then "+ Add the rest".
6. **Word budget** shows if her brief has a total; check the split matches the brief.

Anything built before these commits (her old session's plans) does NOT get per-step terms,
leading-question structure, or headings retro-fitted — **a fresh upload is required to see
them**. She knows; "Start again from scratch" gives a clean slate (~50p–£1 per fresh brief).

---

## 4. OWED — in priority order

1. **Live quality pass on §3** — the moment she reports.
2. **More than one project at a time.** NOT built, deliberately (told her why). The tutor
   notebook is one-per-person (`getTutorPath(personId)`); a second brief overwrites the first.
   Proper job: key sessions by project id, list + switcher + naming, server + storage + UI.
   Half-building it would leave two projects eating each other.
3. **Slowness.** She said "he's taking forever to respond." Per-question mark helps (small,
   low effort). The two remaining medium-effort calls: the model essay (`writeModelEssay`,
   14000 tokens) and the end-of-essay mark (20000). Dropping the mark to low would roughly
   halve that wait at some cost to depth — **her call, not ours**; asked, parked at her request.
4. **Draft/resubmission detection** (previous handover §5.2) — still open.
5. **`Consider whether…` no-comma openers** left alone by `leadingAsk` on purpose (stripping
   leaves a statement) — the prompt rule catches them; verify it does.
6. **Word budget from explicit per-question counts** — if her brief gives words per question
   rather than weights, read those (currently: weights, else equal split).
7. `partMarkDone` is per page-load: a refresh mid-essay re-marks a finished part once (one
   small call). Persist it if it annoys.
8. Video panel on `revise.html` shipped; `/revision/video` route pre-existed. Sound-off default
   kept.

---

## 5. HOW TO SHIP (what worked all night — same as the previous handover, plus)

- Verify: `node -c routes.js plugins/q-writer.js plugins/q-cite.js`; **`node -e
  "require('./plugins/q-writer')"`** (load order); parse every inline `<script>` in
  `writer.html` with the scratchpad `parse-check.js` recipe (extract + `new Function`);
  boot smoke on a throwaway port with the env from the previous handover §4 — **wait 15s and
  poll `/health` up to 30s** (memory migration on first boot is slow; a 6s wait raced it
  twice); log in with the one-time bootstrap password from the log; GET `/writer` and assert
  the new markup is IN THE SERVED PAGE; POST new routes with `{}` → 4xx not 500; grep the log
  for `TypeError|ReferenceError|Failed to mount`.
- Commit by path with `-F msgfile`; push; poll live `/health` for `uptimeSec` reset.
- Never `git add .`. Check `git status` for other sessions' hunks first.
- The Windows `netstat | grep | taskkill` cleanup returns non-zero on success sometimes — check
  the log, not the exit code.

---

## 6. SARAH TONIGHT
Testing at 1–4am on her sister's real coursework so she can demo it. Fully engaged, sharp,
generous ("everything else is soooo good!!"), and every message a precise defect. She wants
short reports, the work done, no menus. She said "carry on" and meant: keep going down the
list without asking. When she says something makes no sense, she is right — read the code
again. She switched the session model to `claude-fable-5[1m]` at ~02:00.

Never tell her to stop or rest. Never say done unless verified. Her criticisms are the spec.
