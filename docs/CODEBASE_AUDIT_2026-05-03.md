# quotem-ai — Codebase Audit 2026-05-03

> Read-only. No code changed. Q is a general-purpose AI assistant running on DeepSeek V4 Pro via Together AI, with vision via Qwen3.6-Plus (streaming-only) and media generation via HF Spaces. This audit assesses Q on those terms.

---

## CONTENTS

1. [What Q Does — Contents Map](#1-what-q-does--contents-map)
2. [How Q Works — The Live Pipelines](#2-how-q-works--the-live-pipelines)
3. [Confirmed Bugs](#3-confirmed-bugs)
4. [Orphaned / Dead Code](#4-orphaned--dead-code)
5. [Duplicates](#5-duplicates)
6. [Contradictions and Docs Drift](#6-contradictions-and-docs-drift)
7. [Under-Engineered](#7-under-engineered)
8. [Logging Gaps](#8-logging-gaps)
9. [Security Flags](#9-security-flags)
10. [Third-Party Name Violations](#10-third-party-name-violations)
11. [Safe to Clean](#11-safe-to-clean)
12. [Live TODO Blockers](#12-live-todo-blockers)
13. [Priority Action List](#13-priority-action-list)

---

## 1. WHAT Q DOES — CONTENTS MAP

### Server
| File | Role |
|------|------|
| `server/index.js` (135 lines) | Express boot: memory seed, people bootstrap, static assets, routes mount, health endpoint |
| `routes.js` (1089 lines) | All 74 endpoints |
| `config.js` (49 lines) | Q_CONFIG: DeepSeek V4 Pro, Qwen3.6-Plus (vision), DeepSeek V3 (fast), HF Space URLs |
| `auth.js` (113 lines) | HMAC-signed session cookie (`qsess`), stateless, 30-day TTL |
| `q-auth.js` (380 lines) | Client-side sign-in/sign-up overlay, served as `/q-auth.js` |
| `memory.js` (231 lines) | Per-person chat history in JSON files (Railway volume or `./data/`) |
| `facts.js` (142 lines) | Long-term per-person fact store (Q's "remember this" system) |
| `scheduler.js` (300+ lines) | Job scheduler: cron / daily / weekly / once / webhook triggers, 60s polling loop |
| `cost-tracker.js` (159 lines) | Log and summarise API call costs (logCall, summarise) |
| `mailer.js` (64 lines) | IONOS SMTP wrapper (nodemailer, env-var backed) |
| `people.js` | Circle registry: add, sign up, verify login, change/rotate/reset passwords |
| `trace-widget.js` | Lab debug overlay — **not imported by any page** (orphaned) |
| `looking-glass-widget.js` | Draggable magnifier — **not imported by any page** (orphaned) |

### plugins/ — Q's capabilities
| Plugin | What it does |
|--------|-------------|
| `q-chat.js` | Main chat: text (DeepSeek V4 Pro) + vision (Qwen3.6-Plus, streaming) + tool loop |
| `q-agent.js` | Autonomous task runner: up to 25 tool-call steps |
| `q-tools.js` | Tool definitions and dispatcher: web_search (SerpAPI), calculator, current_datetime, analyze_document (vision), create_document, remember, recall |
| `q-verifier.js` | Silent quality gate — checks Q's draft reply before it's sent |
| `q-writer.js` | Writing coach: analyse task, ask questions, assemble document |
| `q-rag.js` | RAG engine: embed text (E5-large-instruct), store, retrieve |
| `q-ingest.js` | Bulk-load files into RAG (offline tool, file walker wrapping q-rag) |
| `q-form-filler.js` | Fill PDFs: text path (DeepSeek V3) + vision path (Qwen3.6-Plus) |
| `q-dot-plotter.js` | Vision: detect fillable field coordinates on PDF page images |
| `doc-creator.js` | Generate .docx files, token-keyed download links |
| `q-voice-clone.js` | Voice cloning via Chatterbox HF Space |
| `q-image-gen.js` | Text → PNG via Z-Image-Turbo HF Space |
| `q-graphics.js` | Image → SVG via StarVector HF Space |
| `q-music.js` | Text → music via ACE-Step HF Space |
| `q-video.js` | Text → video via Wān 2.2 HF Space |
| **Lab-only (not in main chat flow):** | |
| `q-text-reader.js` | Extract work items from text — development tool |
| `q-translator.js` | Translate items to search terms — development tool |
| `q-checker.js` | Verify results vs intent — development tool |
| `q-expander.js` | Expand multi-item jobs — development tool |
| `q-pricer.js` | Price items — development tool |
| `q-sor-picker.js` | Pick best match from candidates — development tool |

### HTML Pages (18 — all routed)
| Page | Route | Purpose |
|------|-------|---------|
| chat.html | `/` and `/chat` | Main Q chat interface |
| writer.html | `/writer` | Writing coach |
| plotter.html | `/plotter` | PDF form field parser |
| admin.html | `/admin` | Sarah's admin hub |
| admin-tools.html | `/admin/tools` | Tools list + cost breakdown |
| agent.html | `/agent` | Autonomous agent task runner |
| code.html | `/code` | Pyodide Python sandbox (client-side) |
| doc-reader.html | `/doc-reader` | Document extraction via vision |
| form-finder.html | `/form-finder` | PDF form field detection |
| graphics.html | `/graphics` | Image → SVG |
| image-gen.html | `/image-gen` | Text → image |
| image-tools.html | `/image-tools` | Background removal / upscale (client-side only) |
| music.html | `/music` | Text → music |
| scheduler.html | `/scheduler` | Job scheduling UI |
| tools.html | `/tools` | "What can Q do?" static overview |
| video.html | `/video` | Text → video |
| reset.html | `/reset` | Password reset (unsigned users) |
| quote-builder.html | `/quote-builder` | Lab pipeline test page |

### Data and Config
| File | Notes |
|------|-------|
| `data/people.json` | Circle members. PII: hashed passwords + emails. Gitignored ✓ |
| `data/q-memory-sarah.json` | Sarah's live chat history. Gitignored ✓ |
| `data/q-memory-seed.json` | Boot seed for new users — **currently identical to Sarah's real conversation** (see §6) |
| `data/q-memory.json.legacy` | Leftover backup from before per-user split. Not read by anything (see §11) |
| `q-knowledge.json` | RAG vector store (~1 MB). Not gitignored — should be (see §3 B5) |

### Persona / Docs
| File | Status |
|------|--------|
| `Q's Voice.md` | Current — tone corpus for future LoRA training |
| `Q's Bloodline.md` | **Stale** — describes old Qwen3 stack, Q is now on DeepSeek V4 Pro |
| `The Crown Plan.md` | Current — multi-model architecture blueprint |
| `docs/WRITER_DESIGN_MAP.md` | Current spec — document-first rebuild (old wizard code pending replacement) |
| `docs/ACROFORM-FILLER-BRIEF.md` | Phase 1 done (field parsing), Phase 2 (filling) not yet built |
| `TODO.md` | 6 live deployment blockers |
| `POP.md` | Ideas backlog |

### HF Spaces (5)
All use Gradio 5.0.0 on ZeroGPU free tier (600 sec/day per user, 5–10s cold start):
- voice-cloning-space — Chatterbox
- image-gen-space — Z-Image-Turbo
- graphics-space — StarVector
- music-space — ACE-Step
- video-space — Wān 2.2

---

## 2. HOW Q WORKS — THE LIVE PIPELINES

### Main Chat
```
POST /chat (requirePerson)
  → q-chat.js: chat()
    → text turn:   DeepSeek V4 Pro, standard fetch
    → vision turn: Qwen3.6-Plus, stream: true → readStreamAsResponse() collapses SSE
    → tool call:   q-tools.js: executeTool()
        → web_search     → SerpAPI
        → calculator     → safe eval
        → analyze_document → Qwen3.6-Plus vision
        → create_document  → doc-creator.js → .docx download link
        → remember / recall → facts.js
    → q-verifier.js: verify() [silent quality gate before reply is sent]
  → memory.js: appendMessage() [per-person JSON]
  → response SSE or JSON
```

### Agent (autonomous)
```
POST /agent/run  ← NO AUTH — see B3
  → q-agent.js: runAgent()
    → tool loop up to 25 steps via q-tools.js
    → accumulates tokensIn / tokensOut
```

### Writing Coach
```
POST /writer/analyse       → q-writer.js: analyseTask()
POST /writer/next-question → q-writer.js: nextQuestion()
POST /writer/assemble      → q-writer.js: assembleDocument()
Note: current wizard implementation is being replaced — see B8
```

### Form Filling
```
POST /plotter/analyze  (requirePerson) → q-dot-plotter.js: plotDots()   — detect field coords
POST /forms/label      (requirePerson) → q-form-filler.js: labelFields() — label fields
POST /forms/extract    (requirePerson) → q-form-filler.js: extractFieldValues()
POST /forms/fill       (requirePerson) → q-form-filler.js: fillPdf()
```

### RAG
```
[Ingest — offline]
node plugins/q-ingest.js
  → q-rag.js: addDocument() → E5-large-instruct embeddings → q-knowledge.json

[Retrieve — live, called from q-chat when context needs grounding]
q-rag.js: retrieve(query)
```

### Auth
```
POST /login  → people.js: verifyLogin() → bcrypt 12 rounds
  → auth.js: setSessionCookie()  [HMAC-signed qsess cookie: email:ts:hmac]
  → 30-day TTL, HttpOnly, SameSite=Lax, Secure

All pages load /q-auth.js overlay → calls /whoami → if not signed in, shows login modal
iOS fix: email + password trimmed client-side, /whoami called after Set-Cookie to confirm session landed
```

### Password Reset
```
POST /forgot-password → people.js: createResetToken()
  → crypto.randomBytes(32) → raw token emailed, SHA-256 hash stored, 1hr TTL
POST /reset-password  → people.js: consumeResetToken() → single-use, hash cleared on consume
```

---

## 3. CONFIRMED BUGS

### P0 — Fix Before Launch

**B1 — response_format silences DeepSeek V4 Pro in live plugins**

`response_format: { type: 'json_object' }` is passed to DeepSeek V4 Pro in plugins that Q actively uses. DeepSeek V4 Pro + response_format returns silent `{}` on ~60% of calls when the reasoning chain is long (confirmed fix in q-lab 2026-04-30).

Affected live plugins:
- `plugins/q-verifier.js:94` — **quality gate runs on every chat reply**
- `plugins/q-writer.js:33` — **writer feature**
- `plugins/q-form-filler.js:121` — **form filler text path**

Affected lab plugins (not in main chat flow, but still broken if called):
- `plugins/q-checker.js:159`, `q-expander.js:78`, `q-pricer.js:91+174`, `q-sor-picker.js:109`, `q-text-reader.js:142`, `q-translator.js:142`

Fix: remove `response_format` from every DeepSeek V4 Pro call; ensure `max_tokens ≥ 4096`.

---

**B2 — q-tools.js:329 calls a retired vision model**

`plugins/q-tools.js:329` hardcodes `'Qwen/Qwen2.5-VL-72B-Instruct'` in `analyzeDocument()`. This model was retired April 2026. `config.js:22` names `Q_CONFIG.visionModel = 'Qwen/Qwen3.6-Plus'`. The `analyze_document` tool Q can call from chat is hitting a dead endpoint.

Fix: change line 329 to `Q_CONFIG.visionModel`.

---

**B3 — /agent/run has no authentication**

`routes.js:1030` — `POST /agent/run` has no `requirePerson`. The `agent.html` page shows the q-auth.js overlay, but the **API endpoint itself is unprotected**. Anyone who calls it directly can run an autonomous 25-step AI loop.

Fix: add `requirePerson` middleware to the `/agent/run` route.

---

**B4 — /scheduler endpoints have no authentication**

`routes.js:946–990` — `GET/POST/PATCH/DELETE /scheduler/jobs*` and `POST /scheduler/jobs/:id/run` have no `requirePerson`. Anyone can create, modify, delete, or trigger recurring jobs. Webhook tokens are stored in job records and the jobs list is publicly readable — a caller can read the token and then fire any job via `POST /scheduler/trigger/:token`.

Fix: add `requirePerson` to all scheduler mutation endpoints; make `GET /scheduler/jobs` requirePerson too.

---

**B5 — q-knowledge.json committed to git**

`q-knowledge.json` is a ~1 MB derived artefact (the RAG vector store, built by running `q-ingest.js`). It is not in `.gitignore`. It adds binary churn to every commit, and is stale the moment any knowledge-source file changes.

Fix: add `q-knowledge.json` to `.gitignore`; document the rebuild command (`node plugins/q-ingest.js`) in README.

---

**B6 — Paperclip attachment cleanup unguarded**

`chat.html` (attachment section) — the `attachedImages` and `attachedTexts` arrays are cleared after send, but not inside a `finally` block. If `/chat` returns an error mid-send, attachments remain visually on screen and re-send with the next message.

Fix: move attachment clear into a `finally` block.

---

### P1 — Fix Shortly After Launch

**B7 — No fetch timeouts on any plugin**

All 21 plugins use bare `fetch()` with no `AbortController` or timeout. If Together AI or any HF Space hangs, the request hangs indefinitely with no user-facing timeout.

Fix: add `AbortController` + `setTimeout` (60s for AI calls, 30s for tool calls) to each plugin.

**B8 — Writer code is wrong design**

`plugins/q-writer.js` implements a wizard flow. `docs/WRITER_DESIGN_MAP.md` (redesigned 2026-05-01) explicitly rejects the wizard and defines a 5-phase document-first rebuild. The live writer routes serve the wrong experience.

**B9 — q-memory-seed.json is not neutral**

`data/q-memory-seed.json` seeds every new user's memory with Sarah's personal 2026-04-28 test conversation (SOR codes, system internals). New users start with someone else's context.

Fix: replace with a neutral persona-introduction exchange.

**B10 — .hf-secrets not in .gitignore**

`scripts/deploy-spaces.js` reads `.hf-secrets` for `HF_TOKEN` and `HF_USER`. No `.gitignore` rule exists for this file. An accidental `git add .` could commit a HuggingFace token.

Fix: add `.hf-secrets` to `.gitignore`.

**B11 — 13 AI-cost endpoints are fully public**

The following endpoints have no `requirePerson` and no rate limiting:
- `/text-reader`, `/translator`, `/checker`, `/expander`, `/pricer`, `/quote-builder/run` — lab pipeline
- `/graphics/vectorise`, `/music/generate`, `/video/generate`, `/image-gen/generate` — media generation
- `/speak-as-voice` — voice cloning
- `/agent/run` (already in B3), `/scheduler/jobs*` (already in B4)

Fix: add `requirePerson` and/or `express-rate-limit` to all cost-bearing endpoints.

**B12 — Public signup, no rate limiting**

`POST /signup` is public — no invite code, no approval, no rate limit. Intentional for beta ("Sarah's friends"), but needs rate limiting before wider use.

---

## 4. ORPHANED / DEAD CODE

| Item | Status |
|------|--------|
| `trace-widget.js` (root) | Not imported by any production page. Quote-builder.html has its own inline version. |
| `looking-glass-widget.js` (root) | Not imported by any page. |
| `data/q-memory.json.legacy` | Left from before per-user memory split. Not read by any code. |
| AcroForm Phase 2 | `ACROFORM-FILLER-BRIEF.md` documents a fill step that isn't built yet. Routes exist, Phase 1 (field parsing) works. Phase 2 (filling) is queued. |

---

## 5. DUPLICATES

**knowledge-source/ — identical in quotem-ai and q-lab**

28 `.md` files appear in both repos with the same modification dates. No sync mechanism. Any edit to one must be manually mirrored or they will diverge.

Recommendation: one canonical location; CI sync or submodule.

**q-memory-sarah.json / q-memory-seed.json / q-memory.json.legacy**

All three contain identical content (Sarah + Alex's 2026-04-28 opening session). Seed should be a neutral introduction. Legacy is an unused backup.

---

## 6. CONTRADICTIONS AND DOCS DRIFT

| File | What it says | What's true |
|------|-------------|-------------|
| `Q's Bloodline.md` | Q runs on Qwen3-235B-A22B-Instruct-2507 | Q runs on DeepSeek V4 Pro (switched 2026-04-25) |
| `README.md` | Auth via X-Q-Key header | Auth is HMAC-signed qsess cookie — X-Q-Key does not exist |
| `The Crown Plan.md` | Hands model = FLUX.1 | Deployed image-gen uses Z-Image-Turbo |
| `routes.js:197` `/ping` | "model": "Qwen 3 235B via Together AI" | Q runs DeepSeek V4 Pro |
| `plugins/q-writer.js` | Wizard implementation | WRITER_DESIGN_MAP.md says wizard is wrong and will be replaced |
| `plugins/q-tools.js:329` | Calls Qwen2.5-VL-72B-Instruct | config.js names Qwen3.6-Plus as vision model |

---

## 7. UNDER-ENGINEERED

**No fetch timeouts (all 21 plugins)** — See B7. Any unresponsive API hangs the Node process indefinitely.

**No retry logic** — No plugin retries on 503 / 429. A brief Together AI hiccup fails the entire call with no fallback.

**Cost tracker is dark** — `cost-tracker.js` is wired and correct, but nothing calls `logCall()`. The `/admin/costs` dashboard has nothing to show.

**SerpAPI unguarded** — `q-tools.js: webSearch()` has no per-session or per-day call counter. Q can exhaust the 250-call/month free quota in one heavy session.

**Memory unbounded** — `memory.js` appends indefinitely. No rotation, no archive. Per-person JSON files will grow without limit at high message volume.

**No input size caps** — `POST /chat` and `POST /text-reader` accept unlimited text. Oversized prompts burn tokens and can block the event loop.

---

## 8. LOGGING GAPS

| What | Gap |
|------|-----|
| `POST /chat` | No token counts logged. No cost written to cost-tracker. |
| `POST /agent/run` | Returns tokensIn/tokensOut in response but nothing written to cost-tracker. |
| `/music/generate`, `/video/generate`, `/image-gen/generate`, `/graphics/vectorise` | Set `X-Generation-Ms` header but no cost logged. |
| `/speak-as-voice` | No logging at all. |
| All plugins | None calls `cost-tracker.logCall()`. Cost data is never written. |

Result: `/admin/costs` shows nothing. The tracker exists and works; it just isn't connected.

---

## 9. SECURITY FLAGS

**S1 — 13 public AI-cost endpoints** (see B11 / B3 / B4)
Anyone can invoke Q's agent, create scheduler jobs, trigger generation calls, and run the lab pipeline. No auth, no rate limit, no cost guard.

**S2 — Scheduler webhook token exposure**
Webhook tokens live in job records. `GET /scheduler/jobs` is public. Anyone can read tokens, then fire jobs via `POST /scheduler/trigger/:token`.

**S3 — Q_AUTH_PEPPER must be set in Railway**
`auth.js:24` falls back to a hardcoded constant with a startup warning if `Q_AUTH_PEPPER` is not in the environment. All sessions are forgeable if the env var isn't set.
**Verify this is set before go-live.**

**S4 — sarah-only check is a hardcoded string**
Admin routes check `req.person.id !== 'sarah'`. If Sarah's ID ever changes, all admin routes break silently. Should be a role field.

---

## 10. THIRD-PARTY NAME VIOLATIONS

Rule: no provider names (DeepSeek, Together, Qwen, Anthropic, OpenAI, Whisper, Kokoro, Gemini, Claude) on customer-visible surfaces.

| File | Line | Violation |
|------|------|-----------|
| `routes.js` | 197 | `"model": "Qwen 3 235B via Together AI"` returned by public `/ping` endpoint |

All other third-party names are in code comments, developer logs, or admin-only endpoints — acceptable.

Fix for line 197: `"model": "Q reasoning engine"` (or omit the field entirely).

---

## 11. SAFE TO CLEAN

| Item | Action |
|------|--------|
| `data/q-memory.json.legacy` | Delete — unused backup |
| `trace-widget.js` | Delete or archive — no production page imports it |
| `looking-glass-widget.js` | Delete or archive — no page imports it |
| Add `q-knowledge.json` to `.gitignore` | Vector store should be regenerated on deploy, not versioned |
| Add `.hf-secrets` to `.gitignore` | Prevent accidental HF token commit |

---

## 12. LIVE TODO BLOCKERS

From `TODO.md` (2026-04-29 — these are deployment ops, not stale backlog):

| # | Task | Type |
|---|------|------|
| 1 | Migrate memory: Quotem Railway → Quotem-ai Railway (preserve Sarah + friends' first-day history) | Deployment |
| 2 | DNS: point quotem-ai.co.uk at Railway | Deployment |
| 3 | Verify end-to-end chat at quotem-ai.co.uk after DNS | Deployment |
| 4 | Lock Q_AUTH_PEPPER in Railway permanently | Security |
| 5 | Q's messages cut off mid-sentence — likely max_tokens too low | UX bug |
| 6 | Q's text input box mispositioned — footer:bottom:0 too aggressive | UX bug |
| 7 | Doc upload broken — file picker shows all types but handler only accepts images | Feature bug |

---

## 13. PRIORITY ACTION LIST

### P0 — Before Launch

| Ref | File | Fix |
|-----|------|-----|
| B1 | q-verifier.js:94, q-writer.js:33, q-form-filler.js:121 | Remove `response_format` from DeepSeek V4 Pro calls; set `max_tokens ≥ 4096` |
| B2 | q-tools.js:329 | Change hardcoded model to `Q_CONFIG.visionModel` |
| B3 | routes.js:1030 | Add `requirePerson` to `/agent/run` |
| B4 | routes.js:946–990 | Add `requirePerson` to all scheduler endpoints |
| S3 | Railway config | Verify `Q_AUTH_PEPPER` is set |
| §12 #4 | Railway config | Lock Q_AUTH_PEPPER, delete temp file |
| §12 #7 | chat.html | Wire docx/pdf/text upload to the handler (not images-only) |

### P1 — Shortly After Launch

| Ref | Fix |
|-----|-----|
| B6 | Move attachment clear into `finally` block in chat.html |
| B10 | Add `.hf-secrets` to `.gitignore` |
| B11 | Add `requirePerson` or rate limiting to all public AI-cost endpoints |
| S2 | Protect `GET /scheduler/jobs` with `requirePerson` |
| B7 | Add AbortController + timeouts to all plugin fetch calls |
| §10 | Wire `cost-tracker.logCall()` into chat, agent, and generation routes |
| §6 | Fix `/ping:197` — remove provider name |
| §6 | Update README.md auth description (cookie, not X-Q-Key) |
| §6 | Update Q's Bloodline.md — DeepSeek V4 Pro, not Qwen3 |
| B9 | Replace q-memory-seed.json with neutral persona introduction |
| §12 #5 | Investigate message cut-off (max_tokens in q-chat.js) |
| §12 #6 | Fix text input positioning in chat.html |

### P2 — Medium Term

| Fix |
|-----|
| Begin writer rebuild per WRITER_DESIGN_MAP.md Phase 1 (document-first editor) |
| AcroForm Phase 2: fill step using pdf-lib + field coords from plotter |
| Add SerpAPI call counter / rate guard in q-tools.js |
| Add memory rotation (archive old messages beyond N turns) |
| Add input size caps to /chat and /text-reader |
| B12: add rate limiting to `/signup` |
| Consolidate knowledge-source to one canonical location across both repos |
| Hook deploy-spaces.js into CI/CD for automatic HF Space deploys on merge |
