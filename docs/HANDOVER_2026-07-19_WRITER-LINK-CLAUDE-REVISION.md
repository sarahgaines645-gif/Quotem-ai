# HANDOVER — Sat 19 Jul 2026 — Writer takes links, Claude accuracy brain, Revision page

**Repo:** `quotem-ai`. Built for Sarah's son (ungraded in Year 12 → target A) and
her sister's CIPD HR course. Not committed/pushed yet — awaiting Sarah's go.

## What was built

### 1. Claude is now the accuracy brain (`plugins/q-claude.js`, NEW)
- `accurateJSON(system, user, {maxTokens, fallback})` — Claude Opus 4.8
  (`claude-opus-4-8`, adaptive thinking, prompt-cached system) via the same
  `ANTHROPIC_API_KEY` the Check button uses. If Claude is missing/down, runs
  the caller's Q fallback so nothing goes dark.
- `plugins/q-writer.js`: the 8 accuracy-critical calls now go Claude-first —
  analyseTask, tutorBrief, markSection, improveSectionStep, explainConcept,
  formatHarvardRef, suggestReferences, referenceParagraph. Voice-flavoured
  calls (word swaps, reframes, starters, leading questions) stay on Q.
- Verified live: with no keys set, the chain fell through Claude → Q → clean
  JSON error. On Railway both keys exist.

### 2. Writer takes a LINK (`routes.js` + `writer.html`)
- `POST /writer/fetch-url` — server-side fetch of a pasted URL, HTML→text
  (or pdf-parse if the link is a PDF), SSRF-guarded, 20s timeout. Thin result
  (<200 chars, i.e. login walls) returns a friendly "copy-paste instead" hint.
- writer.html: "Add a link" button next to the source drop + pasting a bare
  URL anywhere on the page fetches it. Same pipeline as file upload (stores
  /writer/doc, runs the brief). Chip shows 🔗.
- Verified live: BBC Bitesize page → 1.2k chars extracted, brief pipeline fed;
  PDF link → pdf kind extracted; localhost/private IPs blocked.
- NOT yet tested with the real sister's-course link — Sarah has it.

### 3. Revision page (`revise.html` + `plugins/q-revision.js`, NEW; routes in routes.js)
- `/revise` — active-recall: ONE exam-style question at a time (board/level/
  subject/topic aware), student answers, marked strictly against a mark scheme.
- `generateQuestion` + `markAnswer` in q-revision.js, both Claude-first via
  q-claude. Grade band (red/amber/green) recomputed deterministically from
  score so the colour can never contradict the number.
- U→E→D→C→B→A→A* ladder from rolling last-10 average; 🔥 streak; XP today;
  weak-topic targeting (topics averaging <50% get asked more).
- "I don't understand this" reuses `POST /writer/explain` (now Claude-backed)
  with YouTube search links.
- Progress per person: `data/q-revision-{id}.json` (`getRevisionPath` in
  memory.js). Routes: POST /revision/question, POST /revision/mark,
  GET+POST /revision/progress. Writer header links to /revise and back.
- Verified live: page serves, progress round-trips, question route reaches the
  AI layer. Real question/marking quality needs a run on Railway (keys).

## Files changed
- NEW: plugins/q-claude.js, plugins/q-revision.js, revise.html, this doc
- EDIT: plugins/q-writer.js (8 call sites → callAccurate), routes.js
  (fetch-url + revision routes + /revise page), memory.js (getRevisionPath),
  writer.html (link input + paste-URL + nav link)

## The real test material (both in C:\Users\sarah\Downloads)
- **Charlie (Sarah's son, Year 12, A-Level LAW):** `Law revision.docx` — his
  teacher's holiday topic list, 17 topics (ELS: Parliament, delegated
  legislation, statutory interpretation, precedent, Law Commission, courts,
  legal personnel, sentencing; Criminal: causation ⚠ very important, mens rea
  ⚠ very important, strict liability, non-fatal offences, theft; Tort:
  negligence, occupiers' liability, psychiatric harm, remedies). Teacher
  recommends **The Law Teacher** YouTube channel → the /revise setup card now
  has a "Videos by" field that puts that channel first in explain links, and
  the Topics field is a textarea that takes the whole pasted list.
- **Deana (Sarah's sister, CIPD L7 HR):** `7HR03_Strategic_reward_management
  -FV.docx` — extraction VERIFIED locally: 46k chars and all four buried
  "Question N (AC x.x)" task headers survive mammoth extraction (this was the
  May handover's highest-risk untested item). The AI brief-reading half now
  runs on Claude — confirm the brief board shows the 4 AC questions on live.

## Next session — do this first
1. Push to main (Railway auto-deploys) once Sarah says go.
2. On the live site: paste the sister's real course link into /writer — confirm
   the brief board populates. If the page is login-walled the friendly hint
   shows; copy-paste is the fallback.
3. Run /revise with her son's actual subjects — sanity-check question realism
   and marking strictness per board.
4. If Claude latency on the brief feels slow, that's adaptive thinking on
   Opus — acceptable for accuracy; revisit only if Sarah flags it.
