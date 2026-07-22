# HANDOVER — 19–22 Jul 2026 — Revision, Writer, Cost Bleed, AI Audit

**Repo:** `quotem-ai` (Railway project `industrious-contentment` / service Quotem-ai,
domain quotem-ai.co.uk). Everything below is **committed + pushed + live** through
`e8b003c`. Built for Sarah's son **Charlie** (ungraded Year 12, **A-Level Law**,
target A) and her sister **Deana** (CIPD L7 HR, unit 7HR03).

Railway CLI works from Sarah's machine for BOTH apps:
- quotem-ai → `industrious-contentment` / Quotem-ai
- Quoteapp  → `laudable-creativity` / Quotem (the one WITH Postgres; there are
  decoy "Quotem" services in `thriving-serenity` and `zestful-expression`).
`railway logs` gives live eyes; re-run `railway login` if it 401s.

---

## 1. THE WRITER (quotem-ai /writer) — LIVE

- Takes a **link** now: "Add a link" button + pasting a URL fetches the page
  (HTML→text, or pdf-parse for PDF links), SSRF-guarded, feeds the same brief
  pipeline as an upload. `POST /writer/fetch-url` (routes.js). Login-walled
  pages return a friendly "copy-paste instead" hint.
- **Claude accuracy brain** `plugins/q-claude.js`: `accurateJSON(system, user,
  {maxTokens, model, effort, schema, fallback})`. Sends adaptive thinking,
  caches the system prompt, supports structured-output schemas, throws on
  max_tokens truncation, logs `[q-claude] <model> effort=.. → <status> in Ns`.
  Tiers: `MODEL='claude-opus-4-8'`, `SONNET='claude-sonnet-5'`.
- Writer accuracy calls (brief, marking, references, explain) run **Sonnet at
  effort medium** with Q (DeepSeek) as fallback. Voice calls (word swaps,
  reframes, starters) stay on Q.
- `/writer/brief` is now ONE combined `analyseAndBrief()` call (was two chained
  Opus calls — see §4). Deana's 7HR03 docx VERIFIED on live: extracts 46,317
  chars; the 4 buried "Question N (AC x.x)" tasks survive extraction.
- **OPEN:** Sarah never confirmed the brief board populated with the 4 AC
  questions after the last fix. First thing to check on live.

## 2. REVISION (quotem-ai /revise) — LIVE — the big build

Purpose: less reading, more doing; take Charlie U→A. Two stages, tabbed.

**Build stage (default): clickable quiz + THE TUBE game.**
- One multiple-choice question at a time, 4 tap-friendly options, instant
  right/wrong + a one-line WHY (the teaching). "I don't understand this" reuses
  `/writer/explain` with a channel-first YouTube link.
- **THE TUBE** (Sarah's own game design, replaced an earlier CSS tower AND a
  canvas "Tower Drop" she rejected): a tube of tiny colourful balls fills while
  a question sits unanswered; correct answer flushes an inch out (streaks flush
  more), wrong answer splashes more in, overflow ends the run. Pace tightens
  with survival; persisted **best run time + best questions**; fills ONLY while
  a question is live (reading the why = free time; also pauses in Exam Room, on
  popups, hidden tabs). Heartbeat + amber glow past 75%. Synth WebAudio + mute.
  Mobile = bottom trough. Pure canvas, no libraries.

**Exam Room (locked): typed answers marked strictly.**
- Unlocks when a topic is **mastered = ≥10 answered at ≥85%**. The full
  typed-answer + mark-scheme flow, red/amber/green band recomputed from score.

**The question bank (`plugins/q-bank.js`) — Sarah's 3 calls, all built:**
- KEEP every checked question forever. Global per subject+board+level, file
  `q-bank-<key>.json` (`getBankPath` in memory.js). `GET /revision/bank`,
  `POST /revision/bank/build` (background, resumable, restart-safe — 10/topic
  from the pasted list, or 40 core if no list), `GET /revision/bank/status`.
  `/revision/quiz` write-throughs every live batch into the bank too.
- CREATE IN BULK: with a stocked bank, play is served **client-side — ZERO AI
  calls per answer**. Build-progress line while stocking; switch to bank play
  between questions.
- OVER AND OVER: per-question memory `progress.quiz.qstate[id]={seen,right,
  wrong,streak,last}`. Wrong questions RETURN (after a 3-question gap) until
  answered right, then once more later. Order: redemption > unseen(weak-first)
  > consolidation > least-recent.

**The pipeline (Sarah's cost design):** Q (DeepSeek) WRITES a batch → **Sonnet
CHECKS every answer key** (`generateQuiz` in q-revision.js; batches use an
enforced `QUIZ_SCHEMA` so they can't come back unparseable). Never serve
unchecked — checker down = quiz down. Exam-room questions + marking = **Sonnet
at effort medium** (was Opus; Sarah 22 Jul: "opus is too much — use sonnet").
DeepSeek NEVER marks a student.

**Costs (this is what Sarah cares about):** build the bank ≈ **under £1 once**
per subject (≈15-20p for the 40-core build). Playing from the bank incl.
repeats = **£0**. Exam room ≈ **2-4p per question+mark**, locked + slow by
nature. Every runaway path is capped: enforced schemas kill retry loops, all
calls budget-capped, only the bank build runs unattended and it stops when
stocked.

**Charlie's setup (do once, on HIS OWN login):** subject Law · level A-Level
Year 12 · board (ask him — AQA or OCR) · paste the 17-topic list · "Videos by"
= The Law Teacher. Topic list (teacher flags causation + mens rea VERY
IMPORTANT): Parliament: acts and bills; Delegated legislation; Statutory
interpretation; Precedent; The Law Commission; Courts: criminal and civil, and
funding cases; Legal personnel; Sentencing; Criminal: causation; Criminal: mens
rea; Criminal: strict liability; Criminal: non-fatal offences; Criminal: theft;
Tort: negligence; Tort: occupiers' liability; Tort: psychiatric harm; Tort:
remedies. **Charlie needs his own circle login** — progress/streak/ladder are
per-person; revising under Sarah's account mixes their data.

## 3. AQA
No public API. Exampro is a paid teacher product; past papers are copyrighted —
cannot serve their questions. NEXT-STEP OFFERED (not built): fetch the public
AQA Law spec PDF via the `/writer/fetch-url` machinery and ground question
generation in it.

## 4. THE MONEY BLEED — root-caused + FIXED
Sarah's account went negative; a $9 top-up showed as -£3. NOT the revision app
(its sonnet-5/opus-4-8 barely register). Two causes:
- **quotem-ai Check button** (`check-this` → `claudeThreadChat`,
  `claude-sonnet-4-6`, q-chat.js): its tool loop (≤9 passes) re-sent the FULL
  case (documents+history) at full price each pass; only the system prompt was
  cached. 3.85M input tokens in ~30 min on 20 Jul ≈ £11; Jul 20 total $14.58.
  FIX `3182d12`: cache breakpoint on the case itself (passes 2..N read at
  ~0.1x, ~85-90% cheaper, zero quality change) + every Claude run logs
  in/out tokens + approx $.
- Writer coach dying on Railway = two chained Opus-thinking calls blowing the
  ~60s proxy window (the documented May 502). FIX `7960a18`+`cf495dc`: one
  Sonnet call. Also `218c03f`: Q draft budget 3000→5000 (live batches were
  truncating mid-JSON and forcing pricier Sonnet writes).
LESSON: any Claude tool-loop MUST cache the conversation prefix; every AI
surface MUST log its own spend.

## 5. THE AI AUDIT — DONE (read-only, nothing changed) → feeds the next build
Two read-only auditors mapped EVERY AI surface across both repos. Full reports
are in the session; headline findings that matter:

**Quoteapp:** "claude-sonnet-4-6" means REAL Anthropic in some surfaces
(RTR/Quote-Studio, DocCases advisor, Landlord advisor, email-job-triage,
Email-Writer, SOR, Looking-Glass=Haiku) and the **DeepSeek/GLM shim** in others
(QB2 main=GLM-5.2, Team chat=DeepSeek, Tour chat) — `q-anthropic-adapter.js`
routes "claude-*" to Together and strips cache_control. Live sibling money
risks: **DocCases `followUpCase`** (10-round loop re-sending up to 5 full docs
uncached on real Sonnet — the SAME bug as the Check button, still unfixed) and
**QB2 brain=MAX real-Claude path** (20-round loop, message history not cached).
Cost-logging is inconsistent: QB2/Team mislabel shim turns to `claude_logs` at
Sonnet price; DocCases/Landlord/Looking-Glass/linkmail/SOR have NO per-user
cost meter. **No per-AI tool on/off toggle exists anywhere** — gating is
keyword/DB-assignment only. **QB2 = Together (GLM-5.2), confirmed by Sarah.**

**quotem-ai:** only `q-chat.js` calls the cost tracker; ~19 other LLM callers
(agent, revision, writer, email-writer, finance, life-intake, check-this,
claudeReadImage, all q-claude) log NOTHING. `q-agent.js` = up to 100 iterations
with the FULL tool menu, uncached AND unlogged (highest quotem-ai spend risk).
cost-tracker price table has NO entry for GLM-5.2, Kimi-K2.5 (typo'd K2.6),
Gemini or any claude-* → those log £0. Two Sonnet ids coexist
(`claude-sonnet-5` in q-claude vs `claude-sonnet-4-6` in q-chat). Chat temp is
hardcoded 0.7, overriding config's 0.0. STYLE violations: solid accent-fill
buttons in thread.html/threads.html/finance.html/email-writer.html/etc., dark
scrims in thread.html/plotter.html photo-lightbox, a blur scrim at
writer.html:208.

## 6. NEXT — the AI control page (Sarah's spec, NOT yet built)
One page like the feature tracker, every AI by name, with:
- **Per-tool on/off toggles** — a real permission store the server checks
  before handing tools (does not exist today — must be built, not a list under
  the name).
- **Memory details** per AI (what/where/size/last-touched).
- **30-day call log with costs, per AI, per provider** (Together vs Anthropic
  vs Gemini shown separately) — needs the missing cost meters wired first
  (fix the £0 price-table gaps + add logCall to the ~19 silent callers).
The audit above is the parts list. Build order: (1) wire cost logging on every
silent caller + fix the price table, (2) fix the DocCases/QB2-MAX uncached
loops (Check-button pattern), (3) build the permission store + toggles, (4)
build the page.

## Commits (oldest→newest), all live
`1fad160` writer links + Claude brain + revision · `7960a18` coach Sonnet fix ·
`5ed6b2e` clickable quiz + gated exam room · `cf495dc` one-call brief + schema
quiz · `657c7e6` Tower Drop (rejected) · `1cb49de` THE TUBE · `79091f6` the
question bank · `218c03f` Q draft budget · `3182d12` Check-button cache fix ·
`e8b003c` exam room → Sonnet.
