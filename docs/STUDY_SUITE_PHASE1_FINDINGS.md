# STUDY SUITE — PHASE 1 FINDINGS (Revision + Coursework)
*15 Aug 2026. Code-level investigation + local reproduction with NO paid AI calls (Sarah has not
yet given the £-yes). Every AI provider host was blocked at the network layer by a test harness
(`preload.js`) that captured the outbound request bodies instead — so prompt sizes, models,
budgets and tool lists below are the REAL payloads the live code builds, measured, not guessed.
Method and every command are at the bottom. Nothing in the repo was changed for this phase.*

Brief: `docs/BRIEF_STUDY_SUITE_REVISION_AND_COURSEWORK.md`. Prior pass: `docs/HANDOVER_2026-07-22_REVISION-WRITER-AUDIT.md`.

---

## 0. THE FIVE THAT MATTER (ranked by how badly they block "upload → never read the doc → get an A")

| # | Finding | Root cause (file:line) | Blocks |
|---|---|---|---|
| 1 | **The brief board CANNOT populate for a real CIPD/Pearson brief.** The page only ever sends the FIRST 12,000 characters of the extracted document to the model. My made-up 7-page CIPD-style .docx extracts to 33,629 chars with "Question 1 (AC 1.1)" at char **27,810**; Deana's real 7HR03 doc was 46,317 chars (handover). The AC questions never reach the model. This is the open item "Sarah never confirmed the brief board populated with the 4 AC questions" — it can't. | `writer.html:1076-1078` (`srcLimit = sourceChars \|\| 3000`, `sourceState.text.slice(0, srcLimit)`), `writer.html:1235` (`12000`), `writer.html:1650-1651`, `1717-1721` (`MAX_TASK = 12000`). The server-side full doc (`/writer/doc`, `routes.js:1035-1058`) is stored but the brief step never reads it. | Coursework goal, step 1 |
| 2 | **The July "Sonnet on the writer path" fix never reached the page.** `writer.html` never calls `/writer/brief`. `git log -S"/writer/brief" -- writer.html` = empty. The brief goes through `POST /chat` with `surface:'writer'`, `reasoningEffort:'off'`, tools ON — i.e. DeepSeek V4 Pro with the full Q persona (18,413-char system prompt) + **30 tool schemas** + the doc slice, temperature 0.7, max_tokens 4096, and the page then regex-hunts a ```` ```writer-brief ```` fenced JSON block out of free-form prose. `plugins/q-writer.js analyseAndBrief()` (Sonnet, structured) is dead code from the page's perspective. | `writer.html:1073-1100` (`qWriterChat` → `/chat`), `1229-1259` (`runBrief`), `1105-1112` (`parseQBlock`); `routes.js:1314-1321` ("DORMANT — replaced 2026-05-17"), `1326-1337`; `plugins/q-chat.js:475-509` (SURFACE_PROMPTS.writer), `987-989` (max_tokens 4096), `993-995` (model = `Q_CONFIG.model` = DeepSeek-V4-Pro), `1123` (temperature 0.7), `1144-1159` (tools). Captured payload #1: sys 18,413 chars, user 12,236 chars, tools 30, body 59,265 bytes. | Coursework goal, step 1 (quality + reliability) |
| 3 | **Nothing survives a refresh, a phone lock, or a Railway restart.** The document body (`contenteditable`), the brief, the coaching Q&A history and the current question live only in page JS `state`. No autosave, no restore on load, `"Not yet saved"` is a static label that never changes. `GET /writer/doc` and `GET /writer/tutor` exist server-side but the page never calls them. | `writer.html:877-893` (state), `753` (`meta-saved` static), `937-945` (only `/writer/voice` is loaded on boot); no `chat-history`/`writer/doc` GET anywhere in the file (grep). | Coursework goal ("never lose work") |
| 4 | **There is no assemble / download step at all.** `/writer/assemble` (`routes.js:991-1004`) exists but nothing in `writer.html` calls it; there is no Download/Export/Copy-all control (grep for `download|assemble|Blob|export` = 0 hits). The flow ends with text in a div. | `writer.html` (whole), `routes.js:991` | Coursework goal ("assemble → download") |
| 5 | **Every writer turn re-sends the whole doc slice AND the server replays it back N times.** Each `/chat` writer message = 12k source + doc-so-far + prompt; `/chat` stores that whole message in memory (`appendMessage`, `routes.js:1658`) and prepends the last 50 writer-surface messages next turn (`routes.js:1596-1598`). Measured: 4 turns → 48,930 chars stored; captured payloads grow 12,236 → 24,486 → 36,741 → 48,976 user chars (+30 tool schemas + 18k system every time). Turn 10 ≈ 135k user chars ≈ 34k tokens. That is the 60-s Railway edge window and the money bleed the handover warned about, in a new place. | `writer.html:1073-1100`; `routes.js:1596-1598, 1654-1658`; capture log `ai-calls.jsonl` #1-#4 | Latency (502s mid-session), cost, and the sister's "problem uploading and working on her coursework" |

---

## 1. COURSEWORK (writer.html → /chat surface writer, /extract-text, /writer/*) — everything found

### 1.1 Upload path (reproduced locally)
- **.docx extraction works** — mammoth, 33,629 chars, all four "Question N (AC x.x)" lines present, table rows preserved (`routes.js:1751-1765`). **.pdf works** — pdf-parse, 30,884 chars / 7 pages (`routes.js:1739-1750`). Extraction is NOT the sister's problem.
- **Only .pdf / .docx / images / .txt / .md are accepted** (`writer.html:1684-1705`). A **.doc** (old Word — common from colleges) → server 400 "Unsupported file type" → page shows the generic *"Couldn't load that — try pasting the task as text."* (`writer.html:1725`). .pptx, .odt, .rtf, .pages likewise. Reproduced: `.doc → 400 {"error":"Unsupported file type for extraction."}`.
- **Scanned PDFs**: pdf-parse returns ~0 chars; upload path does not check length (`writer.html:1698` accepts `''`), so the brief runs on an empty source and the model is asked to build a brief from nothing → no block → *"Couldn't read that"*. (The URL path DOES check `< 200` chars, `routes.js:1123, 1132` — the file path doesn't.)
- **Corrupt files** → 500 with the raw library error: `"Could not read that file: Invalid PDF structure"` / `"End of data reached (data length = 3, asked index = 4). Corrupted zip ?"` (`routes.js:1767-1771`) — the page swallows it into the generic line anyway.
- **Body-size limits are guessed and a 413 is a generic 500** — reproduced: 25 MB JSON to `/extract-text` (limit `24mb`, `routes.js:1722`) → **HTTP 500 `{"error":"Server error"}`** because body-parser's `entity.too.large` error skips every route try/catch and lands in the global handler `server/index.js:415-419`. Same for `/writer/doc` at `4mb` (`routes.js:1035`) — reproduced 500. Real-world trigger: base64 inflates ×1.37, so any PDF over ~17.5 MB (a scanned brief with images is easily that) = "Server error"; a 3 MB+ extracted text (long handbook) = "Server error" on `/writer/doc`. Only `/chat` has the honest-413 middleware (`routes.js:1518-1528`) — none of the writer/revision/extract routes do.
- **Image uploads** never go through `/extract-text` — the data URL is attached to the `/chat` message (`writer.html:1090-1092`), routed to Gemini vision (`q-chat.js:1049-1071`) if `GEMINI_API_KEY`, else Together vision. Fine, but the resulting reply is prose; the brief block still has to be regex-found.

### 1.2 The brief step (root causes #1 and #2 above) — extra detail
- `runBrief(taskText)` ignores its argument for the model call (`writer.html:1233-1236`) — `taskText` is only used for `saveTutor`. The model sees `sourceState.text.slice(0, 12000)`.
- The reply must contain a valid JSON block inside a ```` ```writer-brief ```` fence (`writer.html:1237-1238`, prompt at `q-chat.js:490-495`). Any of: prose-only reply, tool call (30 tools are on the table incl. `web_search`, `create_document`, `remember`…), DSML tool markup, malformed JSON, `[OPTIONS]` block placement, or the friendly-error bank reply (`q-chat.js:1214-1221` — reproduced: *"White knight temporarily dismounted. Cape got caught. One moment."*) → `parseQBlock` returns `data:null` → **`"Couldn't read that — try pasting the task as text."`** (`writer.html:1257`). The message blames the file when the model/upstream/session was the failure. A 401 (30-day cookie cliff) returns `{"error":"Sign in required."}` → same generic line (`writer.html:1098-1099` maps `d.error` into the reply string).
- Reasoning is deliberately OFF for the brief (`writer.html:1235`, commit `6ed44d4`) because of the ~60 s Railway edge window — so the "deep scan of a formatted brief" the prompt asks for runs with no thinking, on the wrong model tier, on the wrong 12k slice.
- Timeouts: `q-chat.js` Together fetch now goes through `timedFetch` at 120 s (gates agent, working tree `q-chat.js:1193`); Railway's edge is ~60 s (handover) → the user still sees the edge 502 before our timeout fires. Same for `q-claude.js` (120 s, `q-claude.js` working tree). AbortController is present now; the budget is above the edge, so it protects the server, not the user.

### 1.3 Coaching turns
- Each answer → `/writer/reframe` (DeepSeek, ~1.2 KB, fine) then `askNextQuestion` → `/chat` again with the 12k source + history (root cause #5).
- `post()` helper (`writer.html:1049-1056`) returns `r.json()` with no status check — a 401/413/500 HTML or non-JSON body throws inside a `catch` that shows a generic message; the cause is never shown.
- The teaching board and coach card render fine; brief board drag is `mousedown/mousemove` only (`writer.html:993-1015`) → not movable on a phone (cosmetic).

### 1.4 The URL path (`/writer/fetch-url`, reproduced)
- SSRF guard blocks `127.0.0.1`, `localhost`, `[::1]`, hex/decimal IPs, `127.1`, RFC1918 (`routes.js:1093-1098`) — all reproduced as 400 "That address can't be fetched." **Gaps:** redirects are followed (`redirect:'follow'`, `1105`) so a public URL that 302s to an internal address bypasses the guard; DNS names resolving to private IPs bypass it. Low priority for the study suite, real for the platform.
- Non-existent host → 502 `"Couldn't reach that link: fetch failed …"` (raw undici text leaks). `example.com` (short page) → `"That page didn't give me much to read — it probably needs a login"` — good message. Direct-PDF fetch works when the host allows it (w3.org test PDF returned 403 to our UA — the code path is fine).
- 20 s AbortController present (`routes.js:1100-1101`). Text capped at 200,000 chars (`1124, 1135`) — then the page slices to 12,000 anyway (finding #1).

### 1.5 Model routing on the writer (Sonnet vs DeepSeek) — what actually runs
| Step | Route | Model (actual) | Evidence |
|---|---|---|---|
| Brief board | `POST /chat` surface writer | DeepSeek V4 Pro, tools ON, reasoning OFF, temp 0.7, max_tokens 4096 | capture #1; `q-chat.js:987-995,1123` |
| Coaching question | `POST /chat` | same | captures #2-#4 |
| Reframe / starter / word swaps | `/writer/reframe` etc. | DeepSeek (`callQ`) | `q-writer.js:245-347`, capture #47 |
| Explain / mark-section / improve / refs / harvard | `/writer/*` | **Sonnet 5 effort medium**, DeepSeek fallback | `q-writer.js:56-58`, `q-claude.js:19-20`, captures #43-45 |
| `/writer/brief` (Sonnet, one call) | never called by the page | — | `routes.js:1314-1321` |
So the ACCURACY-critical step (reading the brief) is the one step NOT on the accuracy model.

### 1.6 Vendor names / honesty of messages
- No vendor names in the writer or revise UI text (grep for DeepSeek/Claude/Gemini/Sonnet in both html files = 0). Server error strings DO carry them (`"Claude upstream 401…"`, `"Q upstream 401…"`, `"Checker unavailable — quiz needs ANTHROPIC_API_KEY"`, `q-revision.js:314`) and travel in the JSON `error` field — visible in devtools, and `writer.html:1655` shows `e.message` for link errors. Not user-visible today on the study pages, but one `setCoach({msg: d.error})` away.
- Cut-off handling: `q-claude.js:69` throws on `stop_reason==='max_tokens'` (good, but becomes "try again" with no cause). `q-chat.js:1233-1235` only logs `finish_reason==='length'` — a truncated writer-brief JSON block simply fails `JSON.parse` → generic message.

---

## 2. REVISION (revise.html → /revision/*, q-revision.js, q-bank.js) — everything found

### 2.1 What works (verified locally without AI)
- Setup persists (`/revision/progress` round trip OK; `routes.js:1256-1275`), prefill on return (`revise.html:1039-1046`).
- Bank play is genuinely zero-AI (`revise.html:1254-1334`); redemption ordering is sound; mastery gate maths correct (`942-945`); Enter-to-advance; tube pauses when not live (`1968-1973`); mute persisted; explain popup with channel-first YouTube links (`2141-2181`).
- Marking recomputes the band from the score so band and number can never disagree (`q-revision.js:190-192`). Structured-output schema on quiz batches (`235-257`) — with the caveat below.

### 2.2 Failures / dead-ends / stuck states
1. **A failed bank build is invisible to the student.** Reproduced: 17-topic build → all 17 batches failed → `bank/status` reports `building:false, added:0, lastError:"Tort: remedies: Claude upstream 401…"` and the page renders **"Bank: 0 questions"** with no error (`revise.html:1193-1207` never reads `lastError`). Meanwhile live batches also fail → the paper shows *"Your questions didn't come through — probably a network blip"* (`revise.html:635`) for what is actually a key/billing/upstream failure. Retry loops forever.
2. **Bank build never resumes after a restart / partial failure.** `builds` is in-memory (`q-bank.js:25`); the page only kicks a build when `bank.count < 15` (`revise.html:1227-1240`). Once ≥15 questions exist for a subject, the remaining topics of a 17-topic list are never built unless someone re-POSTs `/revision/bank/build`. "Restart-safe / resumable" (`q-bank.js:12-15`) is only true if something re-runs it — nothing does.
3. **Per-topic top-up matches `topicTag` by exact lower-case string** (`q-bank.js:127-130`) while the writer is told only to label "matching the topic list wording where possible" (`q-revision.js:265`). "Criminal: causation" vs "Causation" → topic looks unstocked, `count = perTopic - have + 1` → over-generation and duplicate spend; the shelf/mastery (`revise.html:942-945, 1423-1428`) fragments the same topic into several chips, so mastery (10 at 85% on ONE tag) arrives late or never → **Exam Room stays locked** longer than the design intends.
4. **A quiz batch can silently be smaller than asked.** `normaliseQuizQuestions` drops any question without exactly 4 options or a bad `correctIndex` (`q-revision.js:212-230`); the checker may DROP questions (`322`); the schema (`235-257`) does not enforce `options.length === 4` or `correctIndex ∈ 0..3` (no `minItems/maxItems`, no `minimum/maximum` — the API doesn't support numeric/array constraints, `structured outputs` limitations). Result: 10 asked, 6 served, quietly.
5. **Wrong-key risk is only as good as the checker prompt** — checker gets the DRAFT batch as JSON and returns a full batch; nothing verifies the checker kept the same question set or didn't invent new stems ("Do not add new questions" is a prompt line, `q-revision.js:323`). Needs a paid run to measure (see §5).
6. **Progress save is fire-and-forget and unbounded.** `saveProgress()` posts the whole book each answer and swallows errors (`revise.html:1034-1036`); `qstate` grows one entry per distinct question forever. Reproduced: 7,000 entries = 487,704 bytes → still under the `512kb` limit (`routes.js:1267`), so headroom is ~7,300 questions before every save becomes a silent 413→500 and progress silently stops persisting. Not imminent, but it is a cliff with no message.
7. **No resume mid-run.** Refresh = setup card again (prefilled), no question on the paper, run counter reset; best-run only persists on answer/overflow (`revise.html:1978-1992`). Acceptable for a game, but "phone lock mid-question" loses the question.
8. **Exam Room** — question + mark both Sonnet at effort medium (`q-revision.js:56-62`); on any failure the page says "network blip" (`revise.html:2049, 2112`). `askedSoFar` is per session only (`revise.html:808, 2031`) → the same exam question can recur next day (bank play has memory, exam room doesn't).
9. **Client trusts `correctIndex` from the bank forever** — a wrong key banked once is served to every student until someone edits the JSON file; there is no "report this question" and no unbank path.
10. **`/revision/quiz` write-through banks with `subject/board/level` from the client** (`routes.js:1182-1184`) — any typo in Subject creates a new global bank; the setup card is free-text (`revise.html:571`). "law" vs "Law" is fine (slugged) but "A-Level Law" vs "Law" is a different bank.
11. **THE TUBE**: canvas resize on hide/show is handled (`838-846`); no `prefers-reduced-motion` anywhere in revise.html (grep) — required by the brief for the teen mode; the amber "warning" state and shake exist; sound is off only if muted (`1995-1999`) — default is ON (`muted:false`, `784`) — brief wants sound-off-by-default.
12. Copy: the idle text still says "right answers build your tower, wrong ones shake it" (`revise.html:625, 665`) — the tower is gone; it's the tube.

### 2.3 Copyright constraint
No past-paper text is served or stored anywhere in the revision code; questions are generated (`q-revision.js`) and the prompt forbids fake paper refs (`101`). OK.

---

## 3. STATE OF THE GATES-AGENT WORK (observed in the working tree, uncommitted, read-only)
- `plugins/timed-fetch.js` (new) — AbortController wrapper, 120 s; applied in `q-claude.js`, `q-writer.js`, `q-revision.js`, `q-chat.js`. Good; note 120 s > Railway edge (~60 s), so it doesn't stop the user-facing 502.
- `cost-tracker.js` `PRICE_USD_PER_MTOK` now has DeepSeek-V4-Pro 1.74/3.48, GLM-5.2, claude-sonnet-5 2/10, claude-opus-4-8 5/25 (verified against the provider pages below), `GBP_PER_USD = 0.78`. `logUsage` is wired into `q-claude.js`, `q-writer.js callQ`, `q-revision.js callQ`. So the study-suite cost meter is landing — every figure in §4 can be replaced by real numbers on the first paid run.
- Not touched by the gates agent: the 413 handling on `/extract-text`, `/writer/doc`, `/writer/*`, `/revision/*` (still generic 500), and none of the client-side findings above.

---

## 4. COST + LATENCY PER STEP (derived from captured payloads × verified prices; NOT measured — see §5)

**Prices verified 15 Aug 2026:**
- Anthropic — https://platform.claude.com/docs/en/about-claude/pricing — Claude Sonnet 5: **$2 / MTok in, $10 / MTok out** (page: "The $2/$10 … introductory pricing … is now the standard price"); cache read 0.1×, 5-min cache write 1.25×; Opus 4.8 $5/$25. Note on the same page: 4.7+ tokenizer (Sonnet 5 included) ≈ **30% more tokens** for the same text.
- Together AI — https://www.together.ai/pricing — DeepSeek V4 Pro: **$1.74 / MTok in ($0.20 cached), $3.48 / MTok out**; GLM-5.2 $1.40/$4.40; Kimi K2.5 not listed.
- Conversion used: `GBP_PER_USD = 0.78` (the repo's own `cost-tracker.js:93`). Sarah's card rate applies.
- Token estimate: chars ÷ 4 for DeepSeek; chars ÷ 4 × 1.3 for Sonnet 5. Thinking tokens (adaptive, effort medium) are billed as output and are the least certain number — I assumed 1–3k per Sonnet call; the paid run will tell.

| Step (as the code runs today) | Model | Input (measured chars → est. tokens) | Output (est.) | Est. cost | Latency notes |
|---|---|---|---|---|---|
| Writer brief, turn 1 | DeepSeek V4 Pro | 59,265-byte body (18.4k sys + 12.2k doc + 30 tools) ≈ 15k tok | ~800 | ≈ $0.029 ≈ **2.3p** | ~10-25 s live (handover measured 27 s for Sonnet path); reasoning off |
| Writer coaching turn N | DeepSeek | 15k + 3k×(N−1) tokens | ~300 | turn 10 ≈ $0.076 ≈ 6p; **10-turn session ≈ $0.51 ≈ 40p** | grows every turn — turn ~15+ risks the 60 s edge |
| Reframe / starter (per answer) | DeepSeek | ~1.2k chars ≈ 300 tok | ~120 | ≈ $0.001 ≈ 0.1p | fast |
| `/writer/brief` (dormant Sonnet path, for comparison) | Sonnet 5 | 14,113 bytes ≈ 4.6k tok | 1–2.5k + thinking | ≈ $0.03–0.05 ≈ **3-4p** | 27 s measured 19 Jul (handover) |
| Explain ("I don't understand") | Sonnet 5 | ~900 chars ≈ 300 tok | ~150 + thinking ~800 | ≈ $0.01 ≈ **1p** | 3-8 s |
| Quiz batch of 10 (DeepSeek writes → Sonnet checks) | both | writer 1.6k bytes; checker ~5k chars ≈ 1.6k tok | writer ~3.5k tok; checker ~1.6k + thinking | ≈ $0.012 + $0.04 ≈ **$0.05 ≈ 4p per batch** | 20-45 s ("half a minute, tops" is about right) |
| Bank build, 17 topics × 10 | as above ×17 | | | ≈ $0.85 ≈ **65-70p once per subject** (handover: "under £1") | 6-12 min background |
| Bank build, no topic list (5 batches) | ×5 | | | ≈ **20p** | |
| Exam question | Sonnet 5 | 2,759 bytes ≈ 900 tok | ~500 + thinking | ≈ $0.02 ≈ 1.5p | 8-20 s |
| Exam mark | Sonnet 5 | ~2k bytes ≈ 700 tok | ~300 + thinking | ≈ $0.02 ≈ 1.5p | 6-15 s |
| Play from bank | none | 0 | 0 | **£0** | instant |

---

## 5. PAID RUNS STILL NEEDED (need Sarah's £-yes; figures from §4)

| # | Run | What it proves | Est. £ (USD) | Pricing source |
|---|---|---|---|---|
| P1 | Upload the fixture `.docx` (33.6k chars, 4 AC questions at char 27,810) into `writer.html` on live exactly as a user, once as-is | Confirms finding #1/#2 in the wild: what the brief board shows (or doesn't) and what Q's raw reply looks like; latency of the /chat writer call | ≈ 3p ($0.03) for the brief; + 40p ($0.51) if we walk 10 coaching turns; + 1p reframes | Together pricing page |
| P2 | Same text through the dormant `/writer/brief` (Sonnet) with the FULL 33k text (not the 12k slice) via curl | Whether the accuracy path finds all 4 AC questions + rubric + word count + deadline — the design Phase 3 should build on | ≈ 4-6p ($0.05-0.08) per call (bigger input than §4 because full text) | Anthropic pricing page |
| P3 | Revision as a new user, "Law · A-Level Year 12 · AQA" with the 17-topic list: let the bank build finish, play 20+ questions from live batches then bank | Question quality, WHY-line quality, checker drop rate (10 asked → N served), topicTag fragmentation (2.2 #3), build time, and the real per-batch cost from the new cost meter | ≈ 70p ($0.85) build + 8p ($0.10) for two live batches | both |
| P4 | Exam Room: 5 questions + 5 typed answers marked (mix of good/bad answers) | Marking strictness, feedback quality, band correctness, latency inside the 60 s edge | ≈ 15p ($0.20) | Anthropic |
| P5 | "I don't understand this" ×3 (both stages) | Explanation + YouTube link quality | ≈ 3p ($0.03) | Anthropic |
| P6 | Optional: 3 further subjects × no-topic-list core build (to see how generic subjects behave) | Bank quality across subjects | ≈ 60p ($0.75) | both |
| **Total P1–P5** | | | **≈ £1.45 ($1.85)**; with P6 ≈ £2.05 ($2.60) | |

Every figure above is an estimate from payload sizes × list price; the run itself will log the real cost via the new `logUsage` wiring, and this table should be replaced by those numbers.

---

## 6. WHAT PHASE 3 MUST DO (from the evidence — not a plan, just the list the findings force)
1. Feed the brief step the WHOLE document (or a task-hunting pass over all of it), on the accuracy model, structured — the `/writer/brief` route + `analyseAndBrief` already exist and are unused.
2. Stop replaying the source in every writer turn (send it once, cache it, or reference the server copy).
3. Autosave + restore (doc, brief, Q&A history, current question) — server-side per person; the notebook route already merges.
4. Assemble → mark against rubric → download (docx/pdf/text). Nothing exists.
5. Honest errors: 413 middleware on every study route, real causes on the card, no vendor names in `error` strings, empty-extraction check on the file path, accept `.doc` (or refuse it with a reason).
6. Revision: surface `lastError`, re-kick builds when topics are missing, normalise `topicTag` to the teacher's list, enforce 4-options-in-schema and report drops, sound off by default, `prefers-reduced-motion`, fix the "tower" copy.

---

## 7. METHOD (so it can be re-run)
- Server booted locally on `:8799` with `RAILWAY_VOLUME_MOUNT_PATH` = scratch dir, throwaway `TOGETHER_API_KEY`/`ANTHROPIC_API_KEY`, no `GEMINI_API_KEY`, `Q_AUTH_PEPPER` = harness value; `.env` loading stubbed; `node -r preload.js server/index.js`. The preload wraps `globalThis.fetch` and returns 401 for `api.together.xyz`, `api.anthropic.com`, `generativelanguage.googleapis.com` etc., writing each blocked request body to `captures/call-NNN.json` + `ai-calls.jsonl`. **Zero provider requests left the machine.**
- Fixtures: `make-fixtures.js` builds a fictional "Institute of People Practice / 7ZZ99" brief as `.docx` (docx lib) and `.pdf` (pdf-lib): cover, LO/AC table, marking grid, guidance, then "Assessment questions" with word count, deadline and Questions 1-4 (AC 1.1/1.3/2.2/3.2), appendix. No real student work.
- Driver: `drive.js` signs a `qsess` cookie with the harness pepper and drives `/extract-text` (docx, pdf, .doc, corrupt, 25 MB), `/writer/doc` (normal, 4.5 MB), `/chat` surface writer ×4, `/chat-history`, `/writer/fetch-url` ×9 (SSRF + real hosts), `/revision/progress` (round trip + 7,000-entry payload), `/revision/bank`, `/revision/quiz`, `/revision/bank/build` (17 topics) + status, `/revision/question`, `/revision/mark`, `/writer/explain`, `/writer/brief`, `/writer/reframe`, and an unauthenticated call. Output saved as `drive-out.txt`. All under the session scratchpad; nothing written to the repo except this file and `docs/study-suite-looks/`.
