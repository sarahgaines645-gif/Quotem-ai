# Handover — 2026-05-16 — Writer Doc Upload + Chat Input Fixes

**Repo:** `quotem-ai` (`main` branch, live on Railway)
**Session work:** Fixing the writer's document upload flow end-to-end + chat textarea clipping on mobile.

---

## What was fixed today

### Writer — document upload (7 commits)

The writer was built in the previous session but the document upload was broken in practice. A Pearson L7 `.docx` assignment brief (`7HR03_Strategic_reward_management`) was used as the test case throughout.

---

#### `12df396` — Doc upload: cap brief input + full doc context

**Problem:** The full PDF/Word text was being sent raw to `analyseTask`. Q would start reasoning about a huge input, hit its internal token ceiling, and respond in plain English ("I'm truncating…") instead of JSON. JSON parse then threw, coach showed "Couldn't read that."

**Fix:**
- Cap `taskText` at 5000 chars before calling `runBrief` (task question is usually near the top)
- Auto-start coaching after brief loads — removed the manual "Start coaching →" click requirement
- Pass full `sourceState.text` as `docContext` to `/writer/lead` (later replaced by server-side storage)
- Raise `/writer/lead` body limit to 256kb

---

#### `b27c0a7` — Harden `analyseTask` + `tutorBrief` prompts

**Problem:** Q was still breaking JSON format on long inputs.

**Fix:** Added `CRITICAL: Return ONLY valid JSON — no preamble, no questions, no "I need more info"` to both `analyseTask` and `tutorBrief` system prompts. Also made `whatItWants` warmer — spoken directly to the student rather than a dry academic sentence.

---

#### `994094a` — Brief persists, Start me off works, I don't understand uses real concept

**Three bugs fixed:**

1. **Brief disappeared in 1.8s** — increased to 4s (later replaced by button, see below)
2. **"Start me off" did nothing** — silent `if (!state.currentQuestion) return` guard removed. Falls back to `state.currentSection` if question state is empty. Now always fires.
3. **"I don't understand" opened YouTube with wrong search** — was using `state.currentSection` (just a section name like "Introduction") as the concept. Now uses `state.currentQuestion` (the full question Q just asked) — so the YouTube/Khan/BBC search is actually specific to what the student doesn't understand.

Also: task summary now stored in `state.taskSummary` and shown as a persistent `📋` note under every coaching question, so the student always knows what they're working towards.

---

#### `3381bb7` — Brief stays until student is ready

**Problem:** Any timer (1.8s or 4s) is wrong — a student reading a complex project brief needs as long as they need.

**Fix:** Removed the auto-fire timer entirely. The brief now shows:
- The `whatItWants` summary
- 🔑 The examiner's secret tip (`teachersBrief`)
- The numbered list of sections they need to cover (`markedSections`)
- A "I'm ready — start coaching →" button they click when they're done reading

No coaching starts until the student says they're ready.

---

#### `d1513fb` — Store uploaded doc server-side (Railway volume)

**Problem:** The full document text was being passed inline on every `/writer/lead` call. It was getting lost and Q wasn't actually reading the document content when asking coaching questions.

**Fix:** Same pattern as voice signature storage (`getVoicePath`):

- Added `getDocPath(personId)` to `memory.js` → `q-doc-{id}.json` in Railway volume
- `POST /writer/doc` — saves full extracted text after upload
- `GET /writer/doc` — loads stored doc (for future use)
- `/writer/lead` now reads the full doc from the Railway volume file server-side, passes up to 8000 chars to `askLeadingQuestion` as `docContext`
- Client no longer sends doc inline — server owns it

---

#### `9165567` — Scan full brief for task (Pearson docs bury task after headers/tables)

**Problem:** The Pearson L7 assignment brief has pages of headers, unit info, learning outcome tables, and boilerplate BEFORE the actual assignment question. The 5000 char cap meant Q was only seeing front matter and had no idea what the task was. Coach showed "I need a bit more to go on — could you share the task analysis?"

**Fix:**
- Increased brief extract from 5000 → **12,000 chars** (covers the whole brief for most Pearson/university docs)
- Rewrote `analyseTask` system prompt: explicitly tells Q it may be a formatted assessment document with tables/headers, to scan the whole input, find the task buried in it, and never ask for more information

---

### Chat — textarea clipping on mobile (`a310534`)

**Problem:** On phones and after sending a message, the input textarea was showing clipped/half-visible text. The long placeholder wrapped on small screens but the textarea was too short to show it; after sending, `height: 'auto'` didn't reliably reset the input back to one row.

**Fix:**
- `min-height: 24px` → `44px` — input tall enough to show two lines without clipping
- Added `overflow: hidden` — no scrollbar appearing inside the input
- Height reset after send: `height: ''` instead of `'auto'` — lets CSS take over, collapses reliably on mobile
- Placeholder shortened from `"Message Q, drop a PDF / image / .txt, or click the mic..."` → `"Message Q…"` — fits one line on any screen

---

## Files changed this session

| File | What changed |
|------|-------------|
| `writer.html` | Brief display, auto-start removed, doc store POST on upload, brief char cap 12k, task summary persists, Start me off fallback, "I don't understand" concept fix |
| `plugins/q-writer.js` | `analyseTask` prompt hardened + expanded for Pearson docs; `tutorBrief` CRITICAL instruction; `askLeadingQuestion` gains `docContext` parameter |
| `routes.js` | `POST /writer/doc` + `GET /writer/doc` routes; `/writer/lead` reads doc from Railway volume; `getDocPath` imported |
| `memory.js` | `getDocPath(personId)` added, exported |
| `chat.html` | Textarea min-height, overflow, height reset, placeholder |

---

## What's still to do on the writer

1. **Test with real student** — the Pearson L7 doc was used for debugging but hasn't been tested end-to-end in a real coaching session
2. **Image-based PDFs** — scanned PDFs return empty text from `pdf-parse`. If a student uploads a photo/scan of their assignment, Q gets nothing. Vision extraction would be needed (Qwen glasses).
3. **Writer Slice 5 — The TV** — educational video clips panel (YouTube/Khan/BBC) surfaced proactively by Q. Defined in `WRITER_DESIGN_MAP.md` but not built.
4. **Coaching ladder Phase 2** — 5-level deep coaching (why-probe, topic drill, relate-naming, bridge analogy). Also in design map, not built.
5. **Finance page** — next major page after writer. Not scoped yet.
6. **Mobile responsiveness** — full writer page on phone. Last in roadmap.
7. **Old wizard routes cleanup** — `/writer/next-question` and `/writer/assemble` still in `routes.js`. Can be retired when there's a session for cleanup.

---

## Architecture notes for next session

- **Doc storage path:** `q-doc-{personId}.json` in Railway volume (same dir as `q-memory-*` and `q-voice-*`)
- **Brief char limit:** 12,000 chars from the top of the extracted text
- **Q's doc context in coaching:** 8,000 chars from the stored doc, passed to `askLeadingQuestion` on every call
- **State:** `state.taskSummary` + `state.teachersBrief` stored in writer page state, shown as persistent hint under every coaching question
- **"Start me off" fallback:** `activeQuestion = state.currentQuestion || state.currentSection || 'the current section'`
