# Handover — Thread floating form (2026-06-09)

Written because the session went in circles and Sarah ran out of time. Read this
fully before touching the thread forms panel. Do NOT guess what she wants — the
spec is below. If anything here is unclear, ask ONE sharp question first.

## What Sarah actually wants (the spec — stop re-deriving it)

The **floating form panel inside a Thread** (`thread.html`, `#forms-panel`) should
be a **visual form display, like the QB2 display on quotem and like the plotter
(`/plotter`, the "form filler page")** — but living **inside the thread's floating
form**, as an **extension / "remote"**:

- It **displays the actual form** in the floating panel (visual, like quotem's
  display — NOT a text list of "Q filled / Still needed").
- **Q fills it from the case context** (the thread is the "remote" driving it).
- **Q can edit it in real time**, exactly like the plotter's coach card does
  (you tell Q "put the date in", the field updates live on the form).
- It **saves the filled form as a real PDF WITH the text in it**.

Her words this session, verbatim:
- "it was supposed to be like the display on quotem. its like a remote. its an
  extension. it displays it through the floating form."
- "allow him to edit in real time like on the form filler page (plotter)"
- "the form is saving as it should look but with no text"
- When I made it launch the plotter in an iframe: **"I may as well just go in to
  forms"** — i.e. launching the separate plotter page defeats the point. It has
  to be **in the floating form**, not a redirect/popup to `/plotter`.

She also said "I had what I wanted built" — meaning a working version existed and
got lost/regressed. I could not pin which commit; verify with her.

## DO NOT do these (already tried, rejected)

1. **Do NOT replace the floating form with an iframe/launch to `/plotter`.** I did
   this (commit `ae725b0`) and it was wrong — "may as well go into forms". It was
   **reverted** in `17b206c`. The plotter's *engine* can be reused, but the UI must
   render **inside the floating panel**.
2. **Do NOT keep the text "review screen" (Q filled / Still needed list).** That is
   the current state and is NOT what she wants — she wants the visual form.

## THE ROOT-CAUSE BUG: "saves as it should look but no text" (still open)

Proven mechanism, with file:line:

- The thread panel scans the form with **Gemini vision**:
  `routes.js` `/api/threads/:id/form-scan` → `qFinance.scanFormFields()`
  (`plugins/q-finance.js:813`). Gemini **invents** field names — camelCase keys
  like `fullName` (`q-finance.js:826`). These are NOT the PDF's real AcroForm
  field names.
- The download writes the PDF with **pdf-lib**:
  `routes.js` `/forms/fill` → `qFormFiller.fillPdf()` (`plugins/q-form-filler.js:213`),
  which does `form.getField(name)` (`:254`) using those **invented** names.
- The PDF's real fields are named something else entirely (e.g.
  `topmostSubform[0].Page1[0].Title[0]`), so **every `getField` throws → caught →
  `notFound` → nothing is drawn**. `form.flatten()` (`:294`) then burns in the
  blank boxes, so you get the form "as it should look" with **no values**.

**The fix is to use the REAL field names.** The plotter already does this: it reads
the real AcroForm fields in the browser with **pdf.js** `page.getAnnotations()`
(`plotter.html:494`, `ann.fieldName` at `:511`), and `/forms/fill` with those real
names draws text correctly (that is why the plotter's download has text and the
thread panel's doesn't).

## The correct build (recommended approach)

Port the **plotter's engine into the floating panel** (do NOT launch the plotter):

1. Load **pdf.js** in `thread.html` (same as plotter — from **cdnjs**, NOT
   jsdelivr; jsdelivr is blocked by tracking-prevention in this app. See
   `plotter.html:14` and `:411-412` for the exact URLs/worker config).
2. In the panel's `loadFormFromBase64(b64)` (`thread.html:1441`), instead of the
   Gemini `form-scan`, render the PDF to a `<canvas>` inside the panel and
   enumerate the **real fields** (`getAnnotations`) — copy `loadPdf`'s field loop
   from `plotter.html:464-548` and the page/overlay render from
   `plotter.html:651-769` (the pink `.pdf-input` overlays positioned over each
   real field). This is the "visual display in the floating form".
3. **Auto-fill from the case**: call `/api/threads/:id/form-fill`
   (`routes.js:2456`) with the **real** fields (`{name, type, page, context,
   label}`). That route already injects the applicant identity + case context and
   returns `{ values }` keyed by field name. Apply with the plotter's
   `applyValues()` pattern (`plotter.html:940`) so values land on the overlays.
4. **Real-time edit**: reuse the plotter coach-card mechanism — Q replies with a
   ```` ```form-update ```` JSON block that the panel parses and applies live
   (`plotter.html:1339-1352`). In the thread, point that chat at the case so Q
   knows the PCN etc.
5. **Save with text**: download via `/forms/fill` with the real field-name values
   (already correct once names are real) — `plotter.html:1142-1181`.

Note: this only works for PDFs that **have a real AcroForm** (the GOV.UK PCN forms
TE7/TE9/PE2/PE3 do). A flat scanned image has no fields to fill — the plotter
honestly shows "no fillable fields"; the old Gemini scan faked fields it then
couldn't fill (the blank-download bug).

## Current state of the code (after revert `17b206c`, all pushed to `main`)

- **`thread.html`** — floating form is back to the **in-panel review-screen flow**
  (`loadFormFromBase64` → `/form-scan` → `showReadyCTA` → review → `downloadForm`).
  This still has the **no-text download bug** (root cause above). Kept from this
  session (good, leave in):
  - Delete-thread button moved to the **header** (`thread.html:302`) — it used to
    sit under the outbox and a mis-tap kept opening the "Delete this Thread"
    confirm modal on every email click. Fixed.
  - Delete + reminder modal **scrims** changed from `rgba(0,0,0,0.35)` to opaque
    `var(--bg)` (contract: no translucent wash behind floating UI).
  - Checkbox population fix (`thread.html:~1510`): keeps a checkbox `"true"` (so a
    ticked title survives) instead of discarding all true/false.
- **`plotter.html`** — back to original (thread-mode removed by the revert).
- **`routes.js` / `plugins/q-form-filler.js`** (commit `a57551a`, kept):
  - `/api/threads/:id/form-fill` now names the **logged-in person as the
    applicant** (name + email + stored facts) so Q fills the applicant's own
    name/title/contact instead of sending them to "ask". `routes.js:2470-2485`.
  - `EXTRACT_SYSTEM` prompt: the applicant's own fields are not a guess — fill
    them, tick the matching title checkbox. `q-form-filler.js:38-40`.

## Other open items Sarah raised this session

- **Outbox — Q can't edit saved drafts; new ones don't appear:**
  - There is **no Q tool to edit an existing outbox draft**. `save_email_draft`
    only adds (`q-tools.js:1229`, always-on at `:1901`). `patchOutboxItem` exists
    in the plugin (`plugins/q-email-accounts.js:247`) but no tool wraps it. ADD an
    `edit_email_draft` tool.
  - New drafts **save** fine but the **thread outbox list doesn't refresh after Q
    replies** (`thread.html` `sendMessage` at `:1300` doesn't call the outbox
    `load()` — the outbox IIFE is around `:1770`). So a saved draft only appears
    on reload, which reads as "can't save". Refresh the outbox after each reply.
- **Vision model retired:** `config.js` `visionModel: 'moonshotai/Kimi-K2.5'` is
  retired from Together — needs a working Together vision model. **Confirm with
  Sarah before changing** (model/cost changes are her call).
- **Cost / efficiency:** Sarah: "it cost me £20 yesterday and I have no money."
  `/admin/costs` returns JSON only (`routes.js:1240`) — the UI was never built;
  one admin page isn't loading. Cost logging exists (`cost-tracker.js`, used in
  `plugins/q-chat.js:1179/1219/1239`). NOTE: the Claude thread path
  (`claudeThreadChat`, `q-chat.js:628`) does **not** call `logCall` — Claude spend
  is currently untracked. Build the per-call cost table (model, user, tools,
  credits) she asked for.

## Hard rules reminder (cost)

- Threads run on **V4-Pro** (`surface:'thread'`). **Claude only on `check-this`**
  (`q-chat.js:920`). Do NOT switch threads to Claude — it cost ~£20/day. Do NOT
  make model/cost changes without asking Sarah.
