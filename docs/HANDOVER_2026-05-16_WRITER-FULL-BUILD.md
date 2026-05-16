# Handover — 2026-05-16 — Writer Full Build

**Repo:** `quotem-ai` (`main` branch, live on Railway)
**Session work:** Q Writer — all four slices built and pushed in one session.

---

## What was built today

### Pre-writer fixes (already on main before this session)
- `7645079` — UI declutter: random buttons removed from chat header, back-links moved to top of all 15 tool pages
- `e83498b` — Perception: Q sees photos in threads + Life coach feeds live calendar/tasks state every turn

### Writer commits (all on `main`, all live)

| Commit | What |
|--------|------|
| `dc9d445` | Life tile added to Tools menu in chat.html + WRITER_DESIGN_MAP.md updated |
| `8672c1e` | **Slice 1** — rich contenteditable surface, setup strip (voice/relate/year group), tutor brief flow, leading question → reframe → [Use it/No/Another], word-swap on double-click |
| `c7df289` | Fix: setup strip hidden by default — gear cog always visible, no barrier to writing |
| `ae7cfdd` | "Start me off" + "How could I put this?" buttons in coach card; age-appropriate language sharpened; 40-word Q-writing budget tracked |
| `85fe34f` | Harvard references — manual (describe source → Q formats it) + smart suggest (Q reads doc → suggests 4-6 sources) |
| `739e378` | Select any paragraph → "Reference this?" pill floats up → Q suggests what to cite + how to improve that paragraph → [Use (Author, Year)] inserts inline citation + appends full ref |
| `664da17` | **Slices 2-4** — "I don't understand" → YouTube/Khan/BBC links; colour grade bands per section (red/amber/green); Improve → next grade coaching + "Tell me more" craft teaching |

---

## How the writer works now (full flow)

1. **Open `/writer`** — blank paper loads immediately, gear cog (bottom-left) opens optional settings
2. **Settings (gear cog):** voice sample, relate-to anchor (Kardashians etc), year group, grade scheme (GCSE 9-1 / A-Level / Pass/Merit/Dist etc)
3. **Drop/paste/click the task** (homework, PDF, image, text) → source chip appears → Q auto-reads it
4. **Tutor brief** — coach card shows "This is asking you to…" + examiner's secret hint + [Start coaching →]
5. **Leading question loop** — Q asks one question at a time. Student answers in coach input. Three helper buttons:
   - **Start me off** — Q writes one plain sentence (tracked against 40-word budget; pushes back when spent)
   - **How could I put this?** — reframes what student has typed since last question
   - **I don't understand this** — plain explanation + YouTube/Khan Academy/BBC Bitesize search links
6. **Reframe popup** — [✓ Use it] / [↻ Another] / [✗ Keep mine]
7. **Grade band inserted** — after each section is accepted, a coloured band appears in the doc (red/amber/green) showing section name, grade label, and the #1 tip for next grade
8. **Improve →** button on every grade band — coach shows 3-4 targeted suggestions with "Tell me more" craft lessons
9. **Word swap** — double-click any word → 3 voice-matched alternatives
10. **Harvard references** — "Harvard References" button above doc body:
    - *Add a source* tab: describe source → Q formats Harvard ref → [Insert]/[Copy]
    - *Suggest for this doc* tab: Q reads doc and suggests 4-6 sources to cite
    - *Select paragraph → "Reference this?"* pill: Q reads the highlighted text, suggests the specific source to back it up + how to improve that paragraph. [Use (Author, Year)] inserts inline citation + appends full ref to References section at the bottom

---

## Files changed

### `plugins/q-writer.js`
New functions added (all exports intact, old wizard functions kept):
- `analyseVoice(sampleText)` — voice signature
- `tutorBrief(analysis)` — what the finished piece looks like + marked sections
- `askLeadingQuestion(analysis, brief, history, voiceSignature, relateAnchor, yearGroup)` — next question
- `reframeInVoice(rawAnswer, question, context, voiceSignature, relateAnchor, yearGroup)` — reframe in student's voice
- `suggestWordSwaps(word, context, voiceSignature)` — 3 alternatives on double-click
- `writeStarter(question, context, voiceSignature, relateAnchor, yearGroup, qWordsWritten)` — starter sentence with word budget
- `formatHarvardRef(sourceDescription)` — Harvard formatting (never invents details)
- `suggestReferences(docText, subject, keyConcepts)` — suggest sources for the whole doc
- `referenceParagraph(paragraphText, subject, keyConcepts)` — source + improvement for a specific paragraph
- `explainConcept(concept, subject, yearGroup)` — plain-English explanation + search terms
- `markSection(sectionText, sectionName, analysis, gradeScheme)` — grade + reason + nextGradeHint
- `improveSectionStep(sectionText, sectionName, currentGrade, voiceSignature, analysis, relateAnchor, yearGroup)` — coaching to next grade

### `memory.js`
- Added `getVoicePath(personId)` — returns path for per-person voice signature file (`q-voice-{id}.json` in Railway volume)

### `routes.js`
New routes (all `requirePerson`, all after existing writer routes):
- `GET /writer/voice` — load stored voice signature
- `POST /writer/voice` — analyse + store voice signature
- `POST /writer/brief` — analyseTask + tutorBrief in one call
- `POST /writer/lead` — next leading question
- `POST /writer/reframe` — reframe in voice
- `POST /writer/words` — word swap suggestions
- `POST /writer/starter` — starter sentence (with word budget)
- `POST /writer/harvard` — format a Harvard reference
- `POST /writer/refs` — suggest references for the doc
- `POST /writer/ref-para` — reference + improve for a selected paragraph
- `POST /writer/explain` — explain a concept + search terms
- `POST /writer/mark-section` — grade a section
- `POST /writer/improve` — improve coaching suggestions

### `writer.html`
Complete rewrite from the old wizard shell. Key things to know:
- `docBody` is now `contenteditable="true"` div (was textarea)
- Coach card has a state machine: idle → brief → questioning → reframe → back to questioning
- `state.qWordsWritten` tracks Q-authored words — hard ceiling ~40 words total per session
- `state.gradeScheme` set from gear cog select, sent to `/writer/mark-section`
- Grade bands are `contenteditable="false"` divs appended to docBody — clicking Improve → triggers coach improve mode
- Voice signature stored server-side, auto-loaded on page open via `GET /writer/voice`
- Setup strip starts hidden; gear cog (fixed, bottom-left) toggles it

---

## What's NOT done yet (next sessions)

1. **Finance page** — new page, not scoped yet. Sarah mentioned this after writer.
2. **Mobile responsiveness** — make everything work on a phone. Last in roadmap (after writer + finance).
3. **Q-controls-every-page Phase 2** — Q writes/recolours/acts on Life + threads. Deferred until perception is tested.
4. **Writer wizard routes** — `/writer/next-question` and `/writer/assemble` still exist in routes.js (old wizard). These can be retired to `routes-retired` when there's a session for cleanup.

---

## Things to test on `/writer` (not yet tested end-to-end)

- Voice signature: save from gear cog → reload page → confirm it auto-loads (check Railway volume path)
- Tutor brief: drop a PDF homework → confirm brief appears in coach card
- Grade band insertion: complete one section, confirm coloured band appears in doc
- Improve → Tell me more: confirm craft lesson toggles correctly
- Harvard ref: manual + suggest both tabs
- "Reference this?" pill: select text → pill appears → suggestions load
- "I don't understand": confirm YouTube/Khan/BBC links open correctly

---

## Design map
Canonical spec: `quotem-ai/docs/WRITER_DESIGN_MAP.md` — "THE FULL FLOW (canonical)" section is authoritative.
Memory: `C:\Users\sarah\.claude\projects\c--Users-sarah-OneDrive-Desktop-Quoteapp\memory\project_q_writer_design_map.md`
