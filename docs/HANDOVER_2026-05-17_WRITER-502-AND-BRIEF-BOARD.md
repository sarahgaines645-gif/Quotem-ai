# HANDOVER — Sat 17 May 2026 — Writer page: 502 crash-loop + brief board

**Repo:** `quotem-ai` (NOT Quoteapp). Live at `quotem-ai.co.uk/writer`, deployed
on Railway from `main`. Writer is the ONE `/chat` brain, `surface:'writer'`,
driven by `SURFACE_PROMPTS.writer` in `plugins/q-chat.js` (the `b92d21f`
architecture — no separate JSON pipeline).

## What this chat was

Started from a writer page where the **add-doc button was dead** and Q
**couldn't read the task** out of an uploaded document. Worked through a
crash-loop, a brief-board layout fight, and a CIPD-document blind spot.
Nothing here is lab-tested — all needs eyes-on after the last deploy lands.

## Commits made this session (oldest → newest)

| Commit | What | Why |
|---|---|---|
| `dda8f95` | Remove duplicate `escHtml` declaration | `const escHtml` (line ~1137) **and** `function escHtml` (line ~1971) in the same scope = `Uncaught SyntaxError: Identifier 'escHtml' has already been declared`. That killed the **entire** writer.html script — so `renderSourceSlot()` never ran and the add-doc button had no click handler. This was the real cause of "it won't let me add a doc". |
| `18cd566` | Brief board → left side + retry button | Brief board was `right:28px` — same side as the coach card — overlapping it (z-index 101 vs 100). Moved to `left:28px`. Also: `askNextQuestion`'s error path showed a dead "Try me again." with nothing to click — added a real `↻ Try again` button. |
| `47b377b` | Brief board 340×360 | **Wrong direction** — made it portrait/taller. Superseded by next. |
| `f54f801` | Brief board landscape 480×200, two-column | Original spec was "wider than tall". `.brief-board-body` is now a 2-col grid (left = doc type + asks, right = producing + grade chips); board-mode flips back to a single flex column. |
| `a835644` | Wrap `/chat` route in try/catch | `/chat` had **no** try/catch. Any throw in the handler → unhandled promise rejection → Node process exits → Railway returns **502** → auto-restart → next request 502s too. Now returns 500 with a logged `[/chat] unhandled error:` instead of crashing. |
| `572be3f` | CIPD document scanning in `SURFACE_PROMPTS.writer` | Q missed the task in a **hybrid** CIPD file (brief + completed answers in one doc, task buried on page 3 as "Question 1 (AC 1.4)"). Added explicit instructions: scan for "Assessment questions" / "Question N (AC x.x)" headers, ignore the submission, the task is never on page 1 of a CIPD brief. |
| `e37321b` | Coaching turns skip reasoning | Writer page sent **no** `reasoningEffort`, so the route defaulted to `'high'` on every call. High reasoning + CIPD context → slow response → **Railway's ~60s proxy timeout → 502 with no crash in the logs**. Now `qWriterChat(text, chars, useReasoning)`: `runBrief` passes `true` (deep scan needed), `askNextQuestion` passes `false`. Also fixed route logic that **ignored** an explicit `reasoningEffort:'off'` and fell back to `'high'` anyway. |

## The 502 — full diagnosis (this is the important bit)

Two independent causes, both fixed:

1. **No try/catch on `/chat`** (`a835644`). Express 4 + async handler: a throw
   becomes an unhandled rejection, Node 15+ exits the process. Railway shows
   502 and restarts. First `/chat` call (runBrief) often succeeded, the
   process died on/after it, so the **second** call (askNextQuestion, fired by
   "Yes, let's go →") hit a restarting container → 502 → page showed
   "try again".

2. **Railway proxy timeout** (`e37321b`). Even with the server alive, a
   `reasoningEffort:'high'` turn over a 12k-char CIPD doc can run past
   Railway's proxy window. Railway 502s the request itself; Node logs show
   nothing because Node didn't crash. Killing reasoning on coaching turns
   keeps them well under the window. Brief analysis still uses `'high'`.

Railway startup logs were healthy throughout (`✅ Routes mounted`,
`🟢 Listening`) — confirming the crash was per-request, not at boot. The
earlier "Cannot GET /writer" was a *separate* pre-session issue: `multer`
`require`d but not in `package.json` — already fixed by Sarah's `2d80f8b`
before the writer work started.

## State of the asks

- **Add-doc button** — fixed (`dda8f95`). Root cause was the SyntaxError, not
  position/z-index.
- **Brief board** — landscape 480×200, two-column, left side. May still need
  an eyeball tweak; if Sarah says "smaller than before", get her the *exact*
  previous dimensions rather than guessing again.
- **"Try again" / 502** — both causes fixed (`a835644` + `e37321b`).
  **Unverified** — needs a real run once `e37321b` is live on Railway.
- **CIPD task extraction** — prompt-only fix (`572be3f`). **Not tested
  against the actual hybrid Deana CIPD document.** This is the highest-risk
  open item — verify Q actually finds the four "Question N (AC x.x)" items.
- **`recall_tutor` from main chat** — the tool *is* wired (`q-tools.js`,
  trigger-gated on "assignment/essay/stuck on/..."). It returns "nothing in
  the notebook" until coaching **succeeds** at least once, because the
  notebook (`q-tutor-{id}.json`) is only written by `saveTutor()` after a
  question lands. So this unblocks itself once the 502 fix is confirmed.

## Next session — do this first

1. Wait for Railway green tick on `e37321b`, hard-refresh `quotem-ai.co.uk/writer`.
2. Upload the **real hybrid CIPD doc** (the Deana one). Confirm:
   - Brief board populates with the four AC questions, not the submission.
   - "Yes, let's go →" produces a coaching question (no 502, no "try again").
3. Answer one question, then go to **main chat** and ask "what assignment was
   I working on?" — confirm `recall_tutor` fires and returns the brief.
4. If CIPD extraction still misses the questions, the prompt fix wasn't
   enough — next step is a pre-parse pass that isolates the questions block
   before it reaches Q, not more prompt text.

## Don't repeat these mistakes

- Don't guess brief-board dimensions — get the exact target from Sarah.
- Don't push 6 tiny commits back-to-back — Railway chains the deploys and
  every window is a fresh 502 chance. Batch related changes.
- "Cannot GET" = server down / route not mounted. 502 = process crash OR
  proxy timeout. They are different failures — diagnose accordingly.
