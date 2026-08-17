# HANDOVER — 17 Aug 2026 (00:45 → ~03:30) — THE WRITER: one ask, a real chat, rings that fix, the whiteboard that teaches, LOCAL testing
*Read `CLAUDE.md` first (the operating contract). Then this. Then
`docs/HANDOVER_2026-08-17_WRITER-PARTNER-NIGHT.md` (the night before — the writer's structure)
and `docs/BRIEF_STUDY_SUITE_REVISION_AND_COURSEWORK.md`. Every claim here has a commit hash.*

---

## 0. THE ONE SENTENCE

Sarah live-tested the writer for three hours while ~30 pushes went out; the last hour she moved
to **local** (`npm run local`, port 8090) because every push took live down under her. **Everything
below is on `origin/main` (`ff5ac7a`) and live**, but the last eleven commits (the cards / no-method-talk
set) she has **not confirmed** — she asked for the handover after I got the two teaching-board cards
wrong three times in a row. The layout in `ff5ac7a` is exactly what her final message specified;
the next chat's first job is to have her look at it on local (§2 item 1).

---

## 1. RULES LEARNED TONIGHT — read these before touching the UI

1. **THE INDENT RULE — I broke it four times.** INSET (`--neu-inset-sm`) is ONLY for a field she
   types into. Everything she READS — a highlighted ask, Q's lines on the whiteboard, her notes
   tiles, the current sentence in a list, a pill — is RAISED or plain. "Selected/current = inset"
   is a habit from every other design system; it is wrong here. Check every new state style
   against this before it lands. (`314f78a`, `ff5ac7a`)
2. **A colour wash is fine ON a raised card. The sin was the indent, not the pink.** When she said
   "this app is neumorphic, this breaks the design style" she meant the inset well; when I then
   removed the pink she said "taken away the pink background instead of raising it". Fix the
   actual thing named.
3. **When she says "put it in the card at the top and rename it", ask ONE question or state your
   reading in one line before building.** I merged two cards she wanted separate, then put them
   the wrong way round, then put the rings in the wrong one. Three round-trips that one sentence
   would have saved. (Contract rule 4.)
4. **No method-talk on the student's screen.** "Q has the whole answer in his head", "Your words,
   Q's structure. Q never writes on your page", "I never write it for you", match percentages
   ("AI and working life 0%", "MATCH 57% this part") — all gone. "It's irrelevant what Q is
   doing." The percentages were for her as the developer only; they are not shown anywhere now.
5. **One place for each thing.** The question lives on the teaching board once (highlighted until
   she starts); the band list lives on the ✓ Marking panel once; the parts list lives on the
   brief board once. Anything shown twice she calls out ("two of the same thing", "this is
   already in the brief").
6. **Q never writes on her page.** Trim/Weak give a STEER, never a rewrite. The only insertion
   allowed is a term / theory NAME at a ring (like a word button) — and only the plan's name.
7. **The plan's requirement label is the truth for a ring.** A generic "which framework fits"
   call swapped "the resource-based view or HPWS" for "labour market segmentation" two seconds
   after showing it. Never call a generic tool for something the plan already knows; when a call
   is needed, pass `focus` (what the marker expects here) and never swap text once shown.
8. **Every push = ~40 s of live down.** She is testing live in real time. Batch, or work on
   local (`npm run local`) and push once a batch is proven.
9. **Puppeteer harness pattern that works:** intercept `http://qtest.local/writer` → respond with
   the html, so relative `fetch('/writer/…')` can be answered by the same interceptor. Setting
   content via `setContent` breaks relative fetches. Scratchpad files got swept mid-session
   (something cleans the temp dir) — recreate as needed; `window.__qwriterTest` now exposes
   `presentStep, renderBoard, renderWhiteboard, startedAsk, showToolPop`.
10. **Python patch scripts via the Write tool, not heredocs.** Bash heredocs ate `\s` and `\\`
    twice tonight; a `'\n'` inside a JS single-quoted string became a real newline and broke
    `q-writer.js` until escaped.
11. **`node --watch` exits silently (code 1) as a background task here.** Run local plain
    (`node scripts/local.js` via the Bash tool's `run_in_background`) and restart it yourself
    after server-file edits (page edits only need her refresh).

---

## 2. WHAT SHE HAS NOT CONFIRMED (do these first)

1. **The two teaching-board cards** (`ff5ac7a`): QUESTIONS first — the step's ask on a RAISED
   card with the pink wash while fresh, beads/count, then the rings + "must be in", then the
   Q1–Q4 row; TO COVER second — the requirement list only (✓ IN / TO DO, "1 of 3 in" in the
   title). No re-worded part question anywhere ("what's this?"). Word board = words only, and
   only when the part has words. Parts strip off the teaching board. **Ask her to look at local
   and say yes/no before anything else.**
2. Everything from `aead4bb` on (no method-talk, no %, band list only on the marking panel,
   draft recognised on brief-land) — she asked for each, none seen since.

## 3. WHAT SHIPPED — newest first, all on origin/main and live

| commit | what | her words |
|---|---|---|
| `ff5ac7a` `314f78a` `188e36d`…`aead4bb` | the two cards (see §2), the indent-rule sweep, no method-talk / no % / no double band list, draft recognised (≥120 words on the page when the brief lands → "I've read them — Mark & fix, or carry on"), parts strip off the board | "irrelevant what Q is doing" / "two of the same thing" / "this is already in the brief" / "must be in" / "not grey — it's not for titles" |
| `1f72910` | **the coach card IS the chat** — whole thread, no "next you could", no "back to writing"; step's own Next/Done under the thread; `answersStep` (Q says when a message was the step's answer → it goes through the step); chatLog persisted | "it should just be a flowing chat" |
| `8f623bc` | **highlights on request** ("highlight where I mention AI" → every match, he says how many); **`npm run local`** (`scripts/local.js`: `.env.local` from `railway variables --kv`, data dir `./.local-data`, port 8090, both git-ignored) | "I want him to highlight things I ask him to" / "we need to work on local" |
| `c561e49` | typing box on its own line above the buttons; **Q highlights on the page what he is talking about** (`highlight`, verbatim, server-checked) | "the part you type is under the buttons" / "can Q highlight what he wants when he's talking" |
| `74a5616` | **Auto cite chooser: STRONG/FAIR/WEAK + "backs: …"** per candidate (`judgeCiteCandidates`); **whiteboard is hers** (Your notes per part `wbNotes`, press a tile → move to another group); **✓ Marks panel** (bands, ● ○ ✓ per flagged sentence, press → walk goes there, re-checked on typing, opens when a mark lands, floats left of the coach card) | "so you know how to choose them… strong, weak" / "use the whiteboard too" / "marking… continuous… you can't speak to Q" |
| `b43bc1c` | **SOURCES on the teaching board** — citation · the point it backs · STRONG/FAIR/WEAK + why (from `bridge`); click → sentence | "a list of all the sources… and how strong they are" |
| `1d7db0b` | Auto cite card: instruction in **pink**, **Ideas for your line** (`bridge` tool, 3 angles) | "needs to stand out… ideas on what to write" |
| `0000587` | **/writer/chat** — real answers (brief, plan, case text, sources, page, history), board when a list helps; talk to Q **during Mark & fix** (box open, "Back to the marking") | "talk to Q as a chat that will actually help" |
| `ae22a6b` | **Q teaches ON the whiteboard**: TAG_SCHEMA groups (emoji + headline), tile notes, board lines (∑ sum with real numbers / → arrow / ✎ note) | "colour and emojis and formatting… write out a sum" |
| `aa7690c` | whiteboard find = **FACTS YOU COULD USE** (verbatim + where) then **WHAT TO DO** (`todo`) + "Go to the sentence →" | "list facts I could use and then suggest what to do" |
| `b3d34ab` | theory ring: the plan's name, never swapped; "X or Y" → two Add buttons; generic label → one call with `focus` | "changes to a different theory 2 seconds later" |
| `d41696d` | **every ring = the point + the button that fixes it** (Add this / Find figures / Find examples / Find quotes / Auto cite / Find the source / Find facts); finds land on the whiteboard | "not getting to the point… every circle should have a button to fix it" |
| `e941d90` | ✎ Editing back to a **floating panel** (357d66f's strip inside the paper hid her writing); GCSE reset unconditional unless `gradeSchemeChosen` | "it was fine where it was… still gcse" |
| `96cf2e3` | walk survives strip tools (`walkOn()`), button per problem on the fix card, `facts` tool, GCSE default → "as the brief says" | "marking process was then over… still marking in GCSE… button for every problem" |
| `b6da763` | Q coaches never writes (Trim steer, What's weak whole page), source ring = Auto cite, Editing-tools link off the pop-up | "Q can not write anything to go on the page" |
| `b6cf39f` `facfba6` | TRIM pass; **the question in ONE place** (board, highlighted until she starts; coach = Q's talk; whiteboard = kicker + work); floaters reclamp (ResizeObserver), word-button title gone | "asked in three different places… should be one" / "cards coming off the page" |

**Server surface added tonight (routes.js / plugins/q-writer.js):** `/writer/chat` (CHAT_SCHEMA: reply, board, next, highlight, highlights, answersStep); PROOF_KINDS + trim (steer) + weak; EDIT_TOOLS + facts (+ `want`, `caseText` from the stored doc) + bridge (ideas + strength); `judgeCiteCandidates`; TAG_SCHEMA groups/notes/board; TOOL_SCHEMA + todo + strength; TUTOR_KEYS + askFresh, gradeSchemeChosen, wbNotes, chatLog.

## 4. WHAT IS PROVEN vs OWED

**Proven mechanically only** (stubs, headless, smoke): everything above. **Seen by her with a real
model:** the ring pop-ups, Trim, chat replies, Auto cite card, whiteboard find — she reacted to
each (that is where the corrections came from). **Not yet seen with a real model:** the strengths
on the cite chooser, the whiteboard emoji/sums, `answersStep`, highlights on request, the draft
recognition path.

**Owed / next:**
1. Her yes/no on the two cards (§2).
2. **The chat as the default surface**: she wants "a flowing chat". `answersStep` routes an
   answer to the step, but the classifier (`classifyCoachInput`) still gates the way IN to chat
   for non-question-shaped text when not in chat mode. Consider: coach box always = chat unless
   a scaffold step of kind list/numbers/proscons is live.
3. GCSE: the reset now blanks the old label; if she ever reports "still GCSE" again, look at
   `partMarks` / `stepMarks` bands vs `lastMark.overall.label` and the mark route's `gradeScheme`.
4. Whiteboard: her notes exist; she may want to drag tiles, write on the find surface, or add
   emoji herself. Sorting cached before `ae22a6b` shows no marks until re-sorted.
5. Marking panel is per-mark; a whole-essay "continuous" view over parts is a next step.

## 5. HOW TO SHIP / TEST

- **Local:** `npm run local` → http://localhost:8090/writer. Needs `.env.local` (exists;
  regenerate with `railway variables --kv > .env.local`, never print it). Data dir
  `./.local-data` (exists; her account is bootstrapped, she has the password — do not delete the
  dir or she needs a new one from the boot log). Page edits: refresh. Server edits: restart it
  (kill the node on :8090, `node scripts/local.js` in the background). Fresh brief on local costs
  the same as live (~50p–£1) — the live keys.
- **Verify:** `node -c routes.js plugins/q-writer.js`; `node -e "require('./plugins/q-writer')"`;
  parse every inline `<script>` with `new Function` (a small `parse-check.js`);
  `node tests/writer-projects.smoke.js`; puppeteer from
  `C:/Users/sarah/OneDrive/Desktop/Quoteapp/server/node_modules/puppeteer` (see rule 9).
- **Ship:** commit BY PATH with `-F msgfile`; other sessions push too (the pet session pushed my
  commits along with theirs tonight); `git push` = Railway deploy = ~40 s down; poll
  `/health?x=n` for `uptimeSec` reset. `railway logs` works (linked). Never sweep
  `cost-tracker.js` / `revise.html` (other sessions' hunks).

## 6. SARAH TONIGHT

Live-testing from ~00:45 to ~03:30, every message a precise defect or spec, most of them one
line. Generous with time, sharp when the same class of mistake repeats ("why do chats keep
breaking this"). Wants: short reports, the thing named fixed (not a neighbour of it), one
reading stated before a UI rearrangement, and never a note on screen about what Q is doing.
When she says "let's handover" it is because the loop got expensive, not because the work is
wrong — leave the next chat a clean first move (§2).
