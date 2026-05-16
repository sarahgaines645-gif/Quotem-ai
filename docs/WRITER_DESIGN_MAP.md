# Q's Writer — Design Map

**Status**: 2026-05-16 — document-first shell built (title, writing area, source-drop, draggable coach card that feeds Q the page + photos). The wizard is gone. Sarah articulated the FULL product flow on 2026-05-16 — see "THE FULL FLOW (canonical)" below; that section overrides anything older it conflicts with. Phase 1 (rich writing surface + voice signature + in-voice word swaps) authorised as the first vertical slice of the tutor loop.

## Core principle

Q does NOT write the document. Q draws the writing out of the user, **in their own document**, **in their own words**. The output is theirs. AI detectors won't flag it because it genuinely isn't AI-written.

The wizard approach (questions in one place, assembly at the end) is wrong — the assembly step IS AI writing connective tissue. Replace with **document-first inline coaching**.

## THE FULL FLOW (canonical) — Sarah, 2026-05-16

The philosophy, in her words: *"AI doesn't write. We cheat the system by getting the AI to write the homework through the human, thereby getting the human to learn and do their work without realising they are doing it all themselves."* The student genuinely authors every word; they learn the craft on the way; detectors can't flag it because it is genuinely theirs.

The writing surface is a real page where **both the user and Q can write**, words can be clicked, lists pop up on words, words can be searched. (This settles the surface fork: rich editable surface, not a plain textarea.)

The end-to-end loop:

1. **Upload the work.** Coursework, homework, a poem in progress — file, photo, screenshot, or paste.
2. **Q reads it like a tutor.** Gives the plain-English summary of what it's actually asking ("analyse the book, give your opinion, cite others' opinions"). Q forms an internal model of **what the finished piece should look like and what the marked sections are** — the rubric/structure.
3. **Leading questions, section by section.** For each marked section Q asks a natural question to make the user type:
   - Q: "did you like the book?" → user: "no."
   - Q: "start the paragraph with a sentence saying that." → user types *"I didn't like the book."*
   - Q reframes: *"what if we started with 'I read [book] and my thoughts on this are…'"* → **popup: [use it] / [no] / [give me another]**.
   - Q probes deeper (the ladder, as natural tutor questioning): "why didn't you like it?" → … and so on per section.
   - Q **can write if asked** — but only a sentence or two to break the blank page and get the flow going. Simple language so the student understands it and has room to build on it. Never more than that; the rest is theirs.
   - Q **never imposes** — he proposes, the user chooses, the words land as the user's.
4. **"I don't understand this" button** (per section/concept) → Q sends links to videos that explain it.
5. **Q marks each section** once written and puts a **colour band around that section**: red = pass/low, amber/yellow = merit/medium, green = top. Grade scheme configurable (A–C, 1–9, pass/merit/dist, etc.).
6. **Improve button** on each marked section. Click the section → Improve → Q opens a chat coaching it toward the **next grade up**:
   - "could we find a better word for 'don't like'?" → dropdown of better words (**in the user's voice**).
   - "what if we used a simile to compare the colour of Juliet's dress to…"
   - **"tell me more"** button → Q teaches the *craft/technique* behind the suggestion (e.g. *"writers use colour and objects to inject feeling into the reader's subconscious, so the reader feels it without it being described"*) — teaching, not just fixing.

Voice signature (below) underpins every suggestion so swaps/reframes sound like the user, never generic AI. Word-swaps are one tactic *inside* step 6's improve loop and step 3's reframes — not a standalone Grammarly feature.

**Build as vertical slices (proper, no shortcut):**
- **Slice 1 (Phase 1):** rich editable surface (user + Q write) · upload → Q tutor briefing + section/rubric model · voice signature · first marked section: leading question → user types → in-voice reframe + word-swap with [use it]/[no]/[another] popup.
- **Slice 2:** full section-by-section progression + "I don't understand" → video teaching.
- **Slice 3:** marking + colour grade bands per section (configurable scheme).
- **Slice 4:** Improve → next-grade coaching loop + simile/technique suggestions + "tell me more" craft explainer.

## The UI — document-first

- Looks like a document the user is writing, not a form/wizard
- User types directly into the document
- Coaching boxes appear **around the bit they're working on** — never in a separate pane
- Document grows organically as they go

## The coaching ladder (5 levels deep, user-driven)

Each level is optional. The user can stop at any depth. Q only goes deeper if they engage.

1. **Word** — user types "boring" → 3 better words pop up next to it → click to swap
2. **Why** — button next to swapped word: "why was it boring?" → user types "it was old"
3. **Topic** — Q follows the thread: "what is it about period dramas you don't like?" → "they don't make sense"
4. **Relate** — Q names what's underneath: "are you saying you don't relate to them?"
5. **Bridge** — Q connects something they DO know to the source material:
   *"The main character is basically Kim Kardashian when she was with [X]."*

The bridge step is the magic. The user never writes something Q gave them — they write what they understand because Q showed them they already understood it. Their world unlocks the source.

## The TV (educational clips panel)

Small video panel that surfaces educational clips related to what the user is currently writing about. Multiple modes for different learners:

- **Visual** — video clips
- **Audio** — narrated explanations (audible API or TTS)
- **Colour/diagrammatic** — concept maps, character relationship diagrams

Triggered by the user (button click) or proactively when Q detects confusion in their answers. Source: YouTube education channels, Khan Academy, BBC Bitesize, audible API for audio explanations.

## Source material input

- File upload (homework PDF, screenshot of question, brief)
- Paste link
- Paste text directly
- Photo of handwritten task (uses Q's vision)

Q analyses it and extracts: the actual task, document type, key concepts, grade-band guidance.

## Voice sample (REQUIRED before suggestions)

User pastes or types a sample of their own writing. Q analyses:

- Vocabulary range
- Sentence length distribution
- Common phrasing markers
- Formality level

Every word suggestion, every rephrase Q makes is matched to this voice. So even when Q suggests "boring" → 3 alternatives, those alternatives sound like the user, not like generic AI.

## Harvard references

- **Manual**: user tells Q the source (book/article/URL) → Q auto-formats Harvard reference
- **Smart**: reference button reads document → dropdown of suggested references → user picks → relevant snippet inserts at the cursor

## Teaching pop-ups

Buttons available throughout:

- **Explain the question** — Q breaks the task down in plain English
- **Teach me this in simple words** — concept explained at age-appropriate level
- **What grade does this answer get?** — live grade indicator (colour changes as the answer strengthens)

Pop-up quotes appear at moments — short teaching moments inline with writing.

## Grade band live indicator

(Per section, not at the top of the page.)

A coloured bar/dot next to each section that updates as the user writes. Red = basic, amber = mid, green = top band. Live feedback as they refine.

## Starting is the hardest bit (Sarah, 2026-05-01)

Q helps from word one — there is no "blank vs starter prompt" question because Q is always coaching, including before the first word. Don't drop the user onto an empty page and wait. Q breaks the ice, suggests the first move, holds the door open.

## Open questions for next session

- TV panel: which video sources are realistic to integrate? (YouTube has API limits; Khan Academy has open content; audible needs partnership)
- Word suggestions: trigger on every word, or only when the user pauses / selects? (Recommendation: idle pause ~800ms + on-select)
- How long does the voice sample need to be to give Q a real signature? (Recommendation: 150 min, 300+ ideal)

## What's currently built (to be REPLACED)

- `/writer` page (`writer.html`) — wizard UI, will be discarded
- `plugins/q-writer.js` — analyseTask + nextQuestion + assembleDocument. Keep `analyseTask` (still useful for source material analysis), discard the wizard flow
- Routes: `/writer/analyse` (keep), `/writer/next-question` (discard), `/writer/assemble` (discard)

## Rebuild phasing

**Phase 1 — Document editor + voice analyser + word suggestions**
- Document editor UI (replaces wizard)
- Voice sample input + analyser plugin
- Word-level suggestions (Grammarly-style inline) matched to user's voice

**Phase 2 — The coaching ladder**
- Why-probe button per swapped word
- Topic drill questions
- Relate-naming
- Bridge analogy generator (uses user's interest tags)

**Phase 3 — Source material + teaching**
- Upload/link/paste task input (file, photo, screenshot)
- Question analyser → "explain the question" / "teach me simply" / "grade bands" buttons
- Live grade indicator per section

**Phase 4 — Harvard references**
- Manual reference formatter
- Smart reference detector + insertion

**Phase 5 — The TV**
- Video clip surfacer (YouTube education API or curated channel set)
- Audio narration (TTS or audible API)
- Diagrammatic explanations
