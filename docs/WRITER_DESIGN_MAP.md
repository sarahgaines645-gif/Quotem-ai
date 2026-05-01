# Q's Writer — Design Map

**Status**: Phase 1 (wizard-style spine) shipped 2026-04-30 then redesigned 2026-05-01 before testing. Rebuild starts next session.

## Core principle

Q does NOT write the document. Q draws the writing out of the user, **in their own document**, **in their own words**. The output is theirs. AI detectors won't flag it because it genuinely isn't AI-written.

The wizard approach (questions in one place, assembly at the end) is wrong — the assembly step IS AI writing connective tissue. Replace with **document-first inline coaching**.

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

## Open questions for next session

- Does the document start blank, or does Q give a starter prompt?
- TV panel: which video sources are realistic to integrate? (YouTube has API limits; Khan Academy has open content; audible needs partnership)
- Word suggestions: trigger on every word, or only when the user pauses / selects?
- How long does the voice sample need to be to give Q a real signature? (200 words minimum probably)

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
