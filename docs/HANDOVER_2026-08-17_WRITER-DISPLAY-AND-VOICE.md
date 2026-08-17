# HANDOVER — 17 Aug 2026 (afternoon/evening) — THE WRITER: colour on cards, Q gets a voice, the whiteboard becomes QB2's display

*Read `CLAUDE.md` (the operating contract) first. Then this. It follows
`docs/HANDOVER_2026-08-17_WRITER-ONE-ASK-CHAT-LOCAL.md` (the night before) and
picks up the two things that handover left owed.*

**Repo `quotem-ai`, branch `main`. 7 commits, `c2f574b`..`100d0f8`, all
COMMITTED and NOT PUSHED — `main` is 7 ahead of `origin/main`. Live is
untouched.**

---

## 0. THE ONE SENTENCE

Sarah live-tested the writer all afternoon with her sister's real coursework
open; the same fault turned up five separate times — **information stacked into
the chat instead of put on a display, with Q silent beside it** — so the fix
stopped being per-screen and became a rule in the mission block, and the
whiteboard was rebuilt as QB2's kind of display: markdown, colour, tables,
tickable boxes, click-to-edit, send-to-page.

---

## 1. RULES LEARNED TODAY — read before touching this page

1. **SAY AND SHOW.** A pile of information is never a chat message. The
   information goes on the DISPLAY; what Q says to her is the other thing, and
   it is him talking, not a summary of the display. Her words: *"like QB2 — if
   it's an essay of info it goes on the display. He creates 2 messages. one
   that's formatted on the display and the response to you on the chat so you
   don't feel alone."* This is now `SAY_AND_SHOW` in `MISSION_BLOCK`
   (`q-writer.js`), so it applies to every coaching call, not one screen.
2. **`msg: ''` IS A BUG.** Twice today Q was handed an empty message while a
   wall of content sat under his name (the lesson card, the fix card). *"Q
   feels unavailable, absent."* If his card is on screen, he says something.
3. **COLOUR SITS ON A CARD, IT IS NOT THE CARD.** A coloured fill swallows the
   neumorphic shadow and the card reads flat. The house does it three ways and
   only three: a `.gw`-style **gradient** of the colour over `--bg` (strong
   top-left, nearly gone bottom-right), the `.zone` **left edge** (3px border
   + a short coloured cap), or **coloured ink**. Never a white frame —
   *"there's just enough white to make it look neumorphic. it's not a frame."*
4. **BUILT IS NOT WIRED.** `cc8e1f0` built the whole QB2-style display and left
   every caller writing the OLD fixed-HTML modes. She refreshed and said *"the
   whiteboard still looks the same"* — because it was. Check the callers.
5. **TITLES ARE PINK** (`var(--accent)`), matching the panel titles. Not grey,
   not `--text`. Small labels ON a value stay muted.
6. **THE INDENT RULE, AGAIN.** Read-only surfaces are RAISED. This bit us on
   the board's editor, the sorting columns, the numbers cells, the pros/cons
   cells and "the one we're on". Inset is for a real input and for a pressed
   toggle (a ticked box) — nothing else.
7. **NEVER GUESS WHERE TEXT GOES ON HER PAGE.** `docBody.focus()` with no live
   selection collapses the caret to the START of the document. Always restore a
   remembered range (`restoreDocCaret()`); if there is none, ASK. It is her
   essay.
8. **DO NOT BULK-EDIT THESE FILES WITH POWERSHELL.** `Get-Content` /
   `Set-Content -Encoding utf8` in PS 5.1 read UTF-8 as ANSI and re-encode —
   585 lines of mojibake in `writer.html`. Recovered by re-encoding
   UTF-8 → cp1252. Use targeted edits.
9. **ANOTHER SESSION IS LIVE IN THIS REPO** (`revise.html`, `cost-tracker.js`,
   `server/index.js`, `assets/models/`, and their own handover). **Commit BY
   PATH only.** Everything here was committed by path; none of their work was
   swept.

---

## 2. WHAT SHIPPED

| commit | what |
|---|---|
| `c2f574b` | colour on cards (gradient / `.zone` / ink), the case-study FACT CARD, coach card renders markdown, whiteboard display modes, **the coach box is a chat** |
| `24a82f4` | **Auto cite can say `none`**, the Mark & fix walk keeps its buttons while she talks, titles in pink, + the words-vs-ideas PLAN |
| `cc8e1f0` | **the whiteboard is QB2's display** — markdown, colour, callouts, tables, tickable boxes, send-to-page |
| `13adca4` | tool cards go somewhere: **+ Notes / → Whiteboard / → My page**; the CHECK THIS flag becomes "find the source →" |
| `25ec76d` | the display is **actually used** (all three callers), buttons stop eating the card, indent sweep |
| `99d4f6c` | **send-to-page goes where she was working** — and asks when it cannot know |
| `100d0f8` | **click any line to edit it**, blank lines are workspace, **+ Room to work** |

### The bigger ones, in detail

**THE COACH BOX IS A CHAT** (`c2f574b`). `classifyCoachInput` fell through to
`'answer'`, so a remark that was not shaped like a question got pushed through
the scaffold — she said *"I haven't studied and want to see if you can get me
an A"* and Q replied *"add that here, then Enter"*. The gate was sentence
shape. Now the rule is the SLOT: a live list/numbers/proscons step takes the
answer, short commands ("yes", "next", "done") still drive the step, and
**everything else goes to Q as chat**. If it turns out to have been the step's
answer, Q says so himself (`answersStep`) from inside `chatWithQ`. The "is that
an answer or a question?" prompt is gone — it only existed to cover the guess.

**AUTO CITE OFFERED A SOURCE THAT DID NOT BACK THE SENTENCE** (`24a82f4`).
"Choking under pressure: Multiple routes to skill failure" (sports psychology)
against a sentence about AI deskilling. Three faults, none of which could say
no: `isRelevant` passes on ONE shared word ("skill"); the judge's enum was
`strong|fair|weak` with **no "does not back this"** — it KNEW, it wrote *"about
choking under pressure, not deskilling"*, and weak was the strongest verdict
available; and `/writer/cite` only ANNOTATED, so it was still offered and still
went in. Fixed at the judge (`none` is a verdict) and the route (`none` is
dropped, with an honest note when they all drop). **Nothing was ever
fabricated** — every candidate is a real OpenAlex/CrossRef work.

**THE WHITEBOARD IS A DISPLAY** (`cc8e1f0`, `25ec76d`, `100d0f8`). Holds a
markdown source (`state.wbDoc = {title, src}`) rendered the way `QBCanvas.jsx`
renders QB2's: headings in the accent, callout lines coloured by their leading
emoji, 2-column tables as a table and 3+ as stacked cards, `[ ]`/`[x]` anywhere
including inside table cells. The checkbox helpers are **ported verbatim** from
`Quoteapp/client/src/utils/checkboxMd.js` — a tap reports the token's absolute
character offset so the tick flips in the source at that exact position and
persists. Click any line to edit it (the block carries its source line index +
markdown prefix). Blank lines are workspace. "+ Room to work" adds three and
grows the panel. "Send to my page" sends the TICKED lines if any are ticked,
else the lot, stripped of Q's headings.

---

## 3. WHAT IS OWED

1. **A Notes page and a Bibliography page.** She asked; not built. Mostly
   SURFACING what exists: `state.wbNotes` already holds per-part notes (and
   "+ Notes" on every tool card now feeds it), `state.references` already holds
   proper Harvard entries with in-text forms. Two surfaces, not two systems.
2. **`docs/PLAN_2026-08-17_WORDS-VS-IDEAS.md`** — her sister: *"Q is looking for
   those exact words and the exact words don't have to be used."* Sarah's spec:
   *"the words are still there and will go green when you've used a word that
   will cover it."* The plan is small because the plumbing exists — green comes
   from `termsFit`, filled from `termsUsed`, which is ALREADY a judgement about
   the idea. **One word blocks it**: the schema says the terms her writing
   *"uses"* correctly, which a model reads as "the word appears". Phase 1 is
   that wording. Nil cost, no new call. **Not built — awaiting her go.**
3. **Her question I could not answer honestly:** *"if I've used the others why
   aren't the buttons showing this"* — every word button unlit and everything
   in "Still to use". Either it is item 2 above, or `partParagraphs` is
   selecting the wrong slice of the page and `termSeen` is searching text she
   did not write in. **Needs her actual page state to tell which. Do not
   guess.**
4. **`Q & YOU` on the teaching board** — she asked *"what is this supposed to
   be?"* It is the board's transcript of question / her answer / Q's
   explanation. Now the coach card is a real flowing chat, it is a second copy
   of the conversation. My read: it should go. Her call.
5. **The two teaching-board cards from `ff5ac7a`** — still no yes or no, and
   that predates today.

---

## 4. PROVEN vs UNPROVEN

**Proven mechanically** — by pulling the REAL functions out of the page and
running them, and by rendering every changed component and looking at it:
- `classifyCoachInput` — 12 routing cases incl. her exact sentence
  (`scratchpad/classify-test.js`)
- the whiteboard renderer + `toggleCheckboxAt` — flips at the offset, leaves
  length and the rest untouched, ignores a bogus offset (`wb.js`)
- click-to-edit — 9 blocks map to the right source lines, the ticked line is
  excluded, every block's prefix + text rebuilds its line byte for byte
  (`wbedit-test.js`)
- tool cards — the three buttons, the flag button, and no "check it" wording
  survives (`toolcard-test.js`)
- the blockquote escaping fix, with XSS cases (`parse-all.js`)

**UNPROVEN — every prompt change. This is the honest gap.** Nothing that
depends on a live model answering has been seen: whether Q uses the markdown,
sounds like a person, splits display from talk, flags only genuine uncertainty,
or whether `none` fires on real cite candidates. **These cost money to test and
are hers to run.** Do not report them as working.

---

## 5. HOW TO RUN / SHIP

- **Local:** `node scripts/local.js` → http://localhost:8090/writer. Page edits
  need a refresh; `routes.js` / `plugins/*` need a restart (kill the node on
  :8090 and start it again).
- **Verify before committing:** `node -c routes.js plugins/q-writer.js
  plugins/q-cite.js`; `node -e "require('./plugins/q-writer')"`; and the
  scratchpad harnesses above — they pull the real functions out of the page, so
  they do not drift from it.
- **Check for mojibake after any bulk operation:**
  `git show HEAD:writer.html | Select-String -SimpleMatch 'â€'` must be 0.
- **Ship:** `git commit -F msgfile -- <paths>` — BY PATH, another session is in
  this repo. `git push` = Railway deploy ≈ 40s down. **Nothing is pushed yet;
  that is deliberate — none of the model-facing work has been seen by her.**

---

## 6. SARAH TODAY

She ran the app on her sister's real coursework and sent screenshots, mostly one
line each, nearly all of them right. She spotted things I had introduced within
minutes of me introducing them ("the whiteboard still looks the same", "it put
it at the beginning of the doc"). When she said *"I feel like this is getting
messy"* she was correct, and the mess was mine: I chased her screenshots one at
a time instead of finding the pattern, and the same fault appeared five times
before I stopped patching sites and put it in the mission block. Find the rule
earlier than I did.

Two of her points are worth carrying as principles, not preferences:

- *"why are we telling users that this might be wrong?"* — a caveat the user
  cannot act on is not honesty, it is handing them the risk. She does not study
  the subject; that is why she is here. Either Q sources it or he does not say
  it.
- *"if there wasn't a point that we working from it should have said where
  should I place this"* — ask, do not guess, when the thing you would guess at
  is her work.
