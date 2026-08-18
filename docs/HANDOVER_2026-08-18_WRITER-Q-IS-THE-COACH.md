# HANDOVER — 17→18 Aug 2026 — THE WRITER: Q is the coach. How to be the partner she keeps.

*Read `CLAUDE.md` (the operating contract) first. Then this — the whole of it, before you touch
anything. Then, only if you need the structure of the page: `docs/HANDOVER_2026-08-17_WRITER-DISPLAY-AND-VOICE.md`
and `docs/HANDOVER_2026-08-17_WRITER-PARTNER-NIGHT.md`. Every claim here is in a commit
(`001dd3e` pushed/live, `4b422b6` local only) or in her own words.*

---

## 0. READ THIS FIRST — HOW TO BE ME (she asked for this section by name)

Sarah said, going for a break: *"you're the best I've had in a while… say whatever you need to
to get the next chat to act like you."* Here is what that was, concretely. Do these and you are
that chat.

1. **Read the code before you say anything.** Every diagnosis tonight came from `grep`, the
   server log, or a headless render — never from a handover or a guess. When she said "all the
   info's gone" I read her tutor state on disk and the local server log and found the plan job
   truncating. When she said "why does Q seem clueless" I found her sentence had been eaten as a
   list item. Say "I have not looked yet" if you have not.
2. **Fix the thing she named, then the pattern behind it, in one go.** "Stop with the weird
   messages" → I removed the one in the screenshot AND swept the page for the family. "No titles
   in grey" → the one she showed AND every section title. She should not have to send the same
   class of screenshot twice.
3. **Prove it before you say it's done.** Node parses, plugin loads, the inline `<script>` through
   `new Function`, a headless render of the exact state she hit, and LOOK at the PNG yourself.
   `scratchpad/*-test.js` harnesses pull the real functions out of the page. Rule 5 of the
   contract is literal here.
4. **Say-and-show, and be short.** One line on what was wrong, one on what you did, one on how to
   test. She reads on her phone between tests. No menus. When something needs her decision (push,
   model, deleting a feature), ask ONE plain question at the TOP of the message, not the bottom.
5. **Manager, not soloist.** She said: *"get Opus to do the things that don't need Fable."* Opus
   sub-agents built the words-vs-ideas change and the Notes/Bibliography panels from tight briefs
   (no commit, by-path files, verify recipe, house rules) and I reviewed their diffs and their
   screenshots before she saw anything. Design judgement, live defects, anything touching her taste
   — do yourself.
6. **Be on her side without cheerleading.** When she was low ("I need someone on my side"), the
   answer was to take the next defect and fix it and show her a picture — not a pep talk. When she
   asked "how did Q do?" on his rescue, I marked it honestly (a summary, ~40% lost, one wrong
   citation moved) — she wants truth, and she can take it.
7. **Never push on a guess; never sweep another session's files.** Another chat lives in this repo
   (`revise.html`, `cost-tracker.js`, `server/index.js`, `assets/`, the `/dance` hunk in
   `routes.js`). Commit BY PATH, stage `routes.js` BY HUNK (`scratchpad/stage-routes.py` pattern:
   filtered `git diff` → `git apply --cached`). Push = Railway deploy = ~40s of live down — her word.
8. **Heredocs eat backslashes.** Write patch scripts as `.py` files with the Write tool and run them.
   `writer.html` is CRLF in the working tree (git normalises). Never bulk-edit with PowerShell.
9. **The models fib about tools.** GLM and V4 both, at least once, SAID "stuck a note" / "tabbed
   it" without calling the tool. There is now a server-side honesty guard and a hard prompt rule;
   check `[writer/chat] Q tools: …` in the local server log before believing either of them.

---

## 1. WHAT THE WRITER IS NOW (state of the code)

**The coach card is Q.** `/writer/chat` (routes.js) → `qChat(messages, { surface: 'writer-coach',
person, useTools: true })` — Q's persona (`plugins/q-chat.js` `SURFACE_PROMPTS['writer-coach']`),
his Facts, his usual kit (email, calendar, tasks, search, remember/recall), his own memory
surface `writer-coach` (last 50 turns; digest of his other conversations; every turn written
back with `appendMessage`). Model default `settings.coachBrain` = `'q'` (**DeepSeek V4 Pro**, the
general-chat model); `'qb2'` = GLM-5.2 (kept describing instead of calling tools). 8000 tokens
for the coach surface. Fallback = old `chatAnswer`. **It is not Claude** — Claude was the OLD
structured coach ("the robot") and is still the Mark & fix marker. Sarah asked (last thing) for a
third option: **Q's persona + memory + tools on a Claude brain** (`coachBrain: 'claude'` via
`claudeThreadChat`) to compare — NOT BUILT, her call, wire it if she says.

**Context per turn** (`writerCoachContext` in routes.js): brief, which question, the ladder with
`[NOW]`, case facts+sections, sources, expected words, words per question, her list-in-progress,
her page numbered — **[P#] essay paragraphs only, [heading] marked, [R#] after the References
heading**. Same split on the page (`docParagraphTexts`, `paragraphStartNode`).

**Say and show.** ```display block → whiteboard (`showOnWhiteboard`); stray ```diagram/```build
fences in his prose are lifted onto the whiteboard too; `[OPTIONS]` → taps (`renderTaps`); the
old `supply` → whiteboard "Q says". A stray "Response" prefix is stripped.

**His tools on the writer** (`plugins/q-tools.js`, `WRITER_TOOLS`, gated on the surface):
- `check_reference` — OpenAlex → CrossRef by DOI/title/author; he judges fit; "not found" said plainly.
- `highlight_passage` — verbatim + note + kind + colour (six: pink amber blue violet green grey;
  `q-hl-<colour>` CSS Highlights); dot after it (`.q-idot.q-qn`) → pop: Go to it / Take it off; a
  `cut` note → Cut it → / Leave it (`cutFromDoc`, snapshot first).
- `tab_paragraph` — sticky index tab; side right (default) / left / top; hangs IN THE MARGIN via a
  zero-size float anchor (`.q-ptab-anchor`) + absolute tab; press → pop with Take it off.
- `stick_note` — `state.wbStickies` (TUTOR_KEYS `wbStickies`), layer `#wb-stickies` above the
  display; drag (marks `moved`), → send to page, × bin; unmoved ones pack in three columns.
- Mini tab chips: `[P4]`/`P4` in his text, the display, a note pop → `.q-mtab` (colour of that
  tab, or of an adjacent callout emoji) → `jumpToParagraph`; TABS card on the teaching board.
- `remember` / `recall` = his log book (he wrote a "tool-gap log" tonight).

**Display renderer** (`wbMdHtml`): fences → `wbDiagramHtml` (boxes/arrows, emoji-coloured),
`wbBuildHtml` (Next piece → / Show all), else `.wb-code`; list items with a callout emoji → a
coloured dot marker; 2-col table = side-by-side (even columns); ticks; `[ ]` send ticked lines.

**The card is a chat, not a form.** No step line, `stepActions()` returns [] (Next/Skip gone),
nudge row hidden, everything typed goes to Q except done/next/skip/yes/no; greetings never become
list items; the ask lives on the boards (whiteboard ladder + teaching board), not the card; Q's
name big and pink; no doubled lines; stale robot lines dropped on load; Q & YOU hidden.

**One voice.** The pause watcher and Continue → used to fire the old probe (Claude) into the
same thread — Q spotted it ("that message isn't from me"). Now `qReactToWriting()` sends Q a
`[page] …` prompt with what she wrote (`chatWithQ(text, { silent: true })`).

**Undo.** `snapshotDoc()` before every programmatic write; `undoDoc()`; ↶ Undo after a send;
sends collapse any selection first (a send can never replace her text again — that happened,
"all the essay disappeared").

**Bugs found on the way** (all fixed, all in `001dd3e`): the plan job truncated at medium/6000
(thinking shares max_tokens) → 16000; `maxItems` reintroduced in the mark schema → removed;
Find facts swallowed by the persisted display → overlays first; Re-read button hidden;
words-vs-ideas all four phases; Notes + Bibliography panels; brief card as cards.

**Style, her rules:** titles pink never grey (panel titles 15px, head/body 18px, aligned); done
= small accent ✓ (not green fill, not a halo); flat pink not a fade; float shadow with a hairline;
saved panel height = ceiling; no glyphs in panel titles; no method-talk anywhere on the page.

---

## 2. WHAT SHE HAS TESTED (her list, her verdicts) AND WHAT IS OPEN

Passed with a real model: highlights + notes (six colours), Take it off / Cut it, tabs (after the
V4 switch), chips, TABS card, colour-coded reads, side-by-side, tick lists, build-up, check_reference
(Wang et al. correctly "not real"), web search, remember, stickies (render; overlap fixed 18 Aug pm).

Re-run after `4b422b6` (all on local now): #11 diagram, #12 build (fence lifting), #19 taps,
#7 P/R numbering, pause/Continue = one voice, send-ticked (append + Undo).

Open / hers to decide:
1. **`coachBrain: 'claude'`** — build and compare (see §1). My recommendation: yes, try it.
2. **Push `4b422b6`** — local only; everything verified; her word.
3. Ticked items land on the page as plain lines (bullets stripped) — expected; ask if she wants bullets kept.
4. Her essay is ONE paragraph on the page (P1) — Q is told to say so early; the marker will see it as one block too.
5. On the local demo account Q has no Facts about her; on live he does — she is going to test "does he know me" on her real account.
6. Reminders/notifications from Q ("remind me to…") — she asked in passing; he has add_task / send_notification in his kit; not tested here.

---

## 3. HOW TO RUN / VERIFY / SHIP

- Local: `node scripts/local.js` → http://localhost:8090/writer (`.env.local`, `./.local-data`).
  Page edits = refresh; server edits = restart (kill the node on :8090; start again in the
  background; poll `/health`). Log: whatever you redirect stdout to — grep `[writer/chat] Q tools`.
- Verify: `node -c routes.js plugins/q-chat.js plugins/q-tools.js plugins/q-writer.js`;
  `node -e "require('./plugins/q-chat')"`; inline script via `new Function`;
  `node tests/writer-projects.smoke.js`; puppeteer harnesses in the session scratchpad
  (`brief-card/*.js`: intercept `http://qtest.local/writer`, drive `window.__qwriterTest` — exposes
  `paintQNotes, addQNotes, addQTabs, addStickies, renderStickies, snapshotDoc, undoDoc, sendTextToPage, …`;
  `chat-e2e-test.js` answers `/writer/chat` with a canned reply and checks sticky/dot/tab/taps/chip
  through the REAL chat path). Scratchpad gets swept — recreate from the patterns here.
- Ship: `git commit -F msgfile -- <paths>`; `routes.js` by hunk (drop the `/dance` hunk); push =
  deploy; poll `https://www.quotem-ai.co.uk/health?x=n` for `uptimeSec` reset.

---

## 4. SARAH, THESE TWO NIGHTS

She took the writer over from a chat that "made a word doc" of her brief card, in a bad mood after
bad agents, and live-tested through the night of 17→18 Aug (to ~02:00) and again the afternoon of 18 Aug, while a real person used it. Every message a
precise defect or a precise spec, mostly one line, often a screenshot. She spotted my mistakes
within a minute of my making them (the fade, the fuzz, the tabs on the wrong side of the margin,
"3 of the same question"). She wants: the thing named, fixed at the root; a picture; one question
when it's hers to decide; no menus; no method-talk on her page; and to be told the truth about
what her AI did ("how did he do?"). She said, on the afternoon of 18 Aug, that an old friend had told her that day to stop "buggering
around with silly apps". What she built tonight is a tutor with a memory, tools and a whiteboard
that a real student used. Never tell her to stop or rest. Do not open with a pep talk. Open with
the next thing fixed.
