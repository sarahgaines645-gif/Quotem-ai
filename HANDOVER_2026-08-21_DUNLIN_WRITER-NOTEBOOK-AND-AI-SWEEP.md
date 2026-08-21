# HANDOVER — DUNLIN — the writer as a notebook, and the AI-words sweep
**20–21 Aug 2026.** Everything below is in `quotem-ai`, branch `main`.

---

## ⚠️ READ THIS FIRST — THREE THINGS THAT WILL BITE YOU

**1. Another chat is editing `writer.html` at the same time.**
All afternoon, a second session has been building a *pencil case* and a
*notepad* in the same 12,000-line file (`cc4cba5`, `3fe2830`, `9c93db5`,
`3fecf40`, `ca96041`, `ba740e1`, `3542ca4`). Nothing of mine was lost, but that
was luck. **Sarah has not yet said who owns `writer.html`.** Ask her before you
touch it. Commit by path (`git commit -F msg -- writer.html`), never `-a`, and
`git log -3 -- writer.html` before you start so you know what moved under you.

**2. Server edits need a restart. Page edits need a hard refresh.**
Her local server is **`npm run local` → http://localhost:8090/writer**
(`scripts/local.js`, loads `.env.local` with the live keys, data in
`./.local-data` so the live volume is never touched).
`node server/index.js` on **8080 is a stray** left by old sessions — it loads
`.env`, which does not exist, so it has **no API keys at all** and Q cannot
reason on it. Do not send her there.
Anything in `routes.js`, `plugins/*.js` → stop the process on 8090 and
`npm run local` again. Give it ~15s; it prints `🟢 Listening` when it is
actually up (I called it dead once at 8s and was wrong).

**3. Live is `https://www.quotem-ai.co.uk` (www — the apex fails TLS).**
It was 502 for most of 20 Aug. Not our code: Railway had a Google Cloud
incident from 14:53 UTC that congested their deploy pipeline, and four deploys
stacked up. Check `railway.com/status` before debugging a 502.

---

## WHAT THE WRITER PAGE IS NOW

The paper is a **notebook**. Everything that is not writing came off it.

- **The paper** carries the title, the word count, and **Talk** — nothing else.
  Talk lives in a sticky rail down the **left margin** so it rides down the page
  with her (`.doc-mic-rail`).
- **The workbench**, the strip above the paper, carries the controls: the task
  drop-down, Editing / Marks, Tidy / Close all, Download / Mark & fix. Every
  group is a CSS grid of equal columns — *a row of buttons is a list, so it is
  one size*.
- **Five divider tabs** on the top edge of the paper: **Writing · Brief ·
  Bibliography · Citing · Notes**. Pressing one turns the notebook to that
  section. They live in a `.sheet` wrapper *behind* the paper (z-index 0 vs 1)
  so the top sheet laps over their feet; the section you are on stands **7px
  proud**, never pressed in.
- **The pages hold the REAL bodies**, moved out of the floating cards at boot
  (`#bib-body`, `#notes-body`, `#refs-panel`). There is one bibliography and one
  set of notes, not two that can disagree. `openNotesPanel` / `openBibPanel`
  keep their names so every existing caller still works — they turn the page now.
- **The card rail** down the left is the same species of divider, facing left,
  tucked behind the page, sized to its longest name, one line each.
- **Post-its**: a note sent from the whiteboard lands as the card itself, stuck
  on the paper where she puts it, in `#pg-notes` — **outside `.doc-body`**, so
  it is never counted, never marked, never in the .docx.

---

## THE THING THAT MAKES IT SELLABLE — the AI-words sweep

Sarah, 21 Aug: *"he will need to do a sweep when marking it to highlight that
they are words that they have taken from ai."*

- Every passage **Q composed** that reaches her page is recorded in
  `state.qInk` (`recordQInk`). **Nothing is written into her document** — no
  span, no attribute, nothing that could survive into the .docx.
- `sweepQInk()` is a plain search: which of those passages are still on the page
  **word for word**. It **clears itself** — the moment she rewrites a passage in
  her own words it stops matching. Nothing to tick.
- Mark & fix shows a **"Still in Q's words"** block: each passage, where it came
  from, *Take me to it*, amber-underlined in the text (`::highlight(q-ink)`).
- **Her own notes are never flagged.** Only notes Q wrote count
  (`state.qWroteNotes`). Flagging a student's own writing as AI would be far
  worse than missing some. **Keep that property.** A passage under 12 characters
  is never recorded either.
- New: **`write_note`** tool (`plugins/q-tools.js`, in `WRITER_TOOLS`) so Q can
  put a line in her Notes; the existing *→ My page* button transfers it.
- `TUTOR_KEYS` in `routes.js` gained `qInk`, `qWroteNotes`, `pageNotes`.

---

## BUGS FIXED THAT WERE NOT WHAT THEY LOOKED LIKE

- **`[writer/plan] failed after 0.0s: The model answer came back empty`** —
  hundreds of them, and she could not get past it. `0.0s` = no model call.
  Proved against her own `.local-data`: brief criteria `C1..C4`, hidden essay
  `AC1.2 / AC2.4 / AC3.3 / AC4.3`. `bricksOfCriterion` did a raw `===`.
  `critIdResolver` already existed and the **marker** has used it since 19 Aug;
  the **planner** never was. Fixed (`c69e760`). The same raw compare made
  `writeModelEssay` think every part was missing and fire **a paid top-up call
  every run** — also fixed.
  **Still open, same family:** `normaliseMark` filters `voicedBrickIds` with
  `brickId.split('-')[0] === resolvedCriterionId`, which drops them when the
  brickId carries the essay's prefix.
- **Download was not a download.** It handed the press to Q — a coach card with
  a menu whose third option fired the paid `/writer/assemble`. Now one press,
  one .docx, no model called.
- **Q was telling her to delete her own writing.** His prompt literally taught
  him to colour lines `🔴 cut/wrong` and group them under `## Cut`, and the
  pre-mark step said *"I would take out first"* and copied the cut list onto the
  whiteboard. Cutting now has **one home**: the ✕ list in the marking panel with
  *Cut it / Keep it*, where nothing happens until she presses.
  **This is a standing rule** (she said it on 17 Aug too). Do not reintroduce it.
- **The mic icon was being deleted.** `stopDocDictation` set
  `docMic.textContent`, which throws away child elements — the SVG went on the
  first stop.

---

## WHAT I COULD NOT VERIFY, AND WHY

**Images stopped reaching me part-way through 20 Aug** and never came back —
a per-conversation cap. I proved it by downscaling one of my own screenshots to
640×374; still refused. From that point I worked from **measurements taken in
the headless browser** (`node scripts/shoot.js … --eval`), which is reliable for
geometry and useless for "does it look right".

Two changes are **my reading of her words, not of her screenshot** — say so to
her, and revert if wrong:
1. `9054656` — the file, the link and *"just say what it is"* folded into one
   **"＋ Add your task"** drop-down (from *"this can all be in here together"*).
2. `d6d902e` — **Tidy no longer touches the page.** It was pushing the whole
   document down by the whiteboard band's height (264px on her screen) and
   narrowing the desk. She said *"the tabs dont stay with the paper when you
   press tidy"* and *"it breaks everything"*. I removed the two things Tidy did
   **to** the page rather than confirming the symptom is gone. What is left only
   moves floating cards.

---

## OPEN

- **Who owns `writer.html`** — unanswered. Ask first.
- **3 commits ahead of `origin/main`, unpushed** (`15a7d10`, `9054656`,
  `d6d902e`). She has not said push. Note that the other chat's pushes have
  twice carried my commits out with them — same branch.
- The `normaliseMark` / `voicedBrickIds` prefix bug above.
- Assemble ("their words, his structure") is **not** recorded as Q's ink. It
  reorders her sentences rather than writing new ones — deliberate, but worth
  her opinion.
- The market is **A-levels and coursework**, not CIPD — she built it for her son
  (failing A-levels) and her sister (coursework alongside work). Do not read the
  audience off whatever brief happens to be on screen. Sparx has **no**
  third-party API; the platforms that carry a school brief are Google Classroom
  and Microsoft Teams for Education.

---

## HOW TO CHECK YOUR OWN WORK WITHOUT HER EYES

```
node scripts/shoot.js <url> <out.png> --size 1368x800 --wait 2200 --after 800 \
  --eval "(()=>{ …return JSON.stringify(measurements) })()"
```
`window.__qwriterTest` and `window.__qwriterPanels` expose nearly everything —
`state()`, `showDocPage`, `arrangeDesk`, `sweepQInk`, `recordQInk`,
`addQWrittenNotes`, `renderPageNotes`, `panels`, `tidyAll`, `stowedKeys`.
Sweep for overflow at 1368 / 1100 / 900 / 820 before calling a layout done.

⚠️ `writer.html` has **no global `.hidden` rule** — every new hidden element
needs its own scoped one.
