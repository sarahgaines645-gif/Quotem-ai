# Handover — Finance Page
**Date:** 17 May 2026  
**Repo:** `quotem-ai` (NOT Quoteapp — completely separate)  
**Branch:** `main`  
**Status:** Page live, statement import being debugged

---

## What Was Built This Session

A full personal finance page at `/finance` (`finance.html`). Sarah's goal: drop in a bank statement, Q works out where her money goes, spots subscriptions she's forgotten about, shows graphs, lets her assign spending to people (e.g. "all McDonald's = Charlie"), and manages a debt/letter problem queue with Q drafting creditor emails.

### New Files
| File | What it does |
|---|---|
| `finance.html` | The full page — upload zones, summary bar, two graphs, transaction list, subscriptions panel, problem queue, Q advice coach card |
| `plugins/q-finance.js` | Finance engine — all AI calls, data storage, transaction parsing, categorisation, merchant assignment, graph data, subscription detection, problem queue, advice |
| `plugins/doc-drop.js` | QR-code document upload plugin — in-memory sessions, base64 JSON upload (no multer), 30-min TTL. Also copied to `C:\Users\sarah\OneDrive\Desktop\shared-plugins\doc-drop.js` |
| `doc-drop-mobile.html` | Phone upload page at `/doc-drop/:token` — three buttons (camera, gallery, file), base64 JSON POST |

### Modified Files
| File | What changed |
|---|---|
| `routes.js` | `/finance` page route + 15 `/api/finance/*` routes + 4 `/api/doc-drop/*` routes |
| `tools.html` | Finance card added after Threads |
| `config.js` | `fastModel` V3 retired → now aliased to V4-Pro |

---

## Architecture

### Data Storage
All finance data is per-user, stored on the Railway volume under:
```
data/users/{email-slug}/finance/
  transactions.json   — all transactions
  assignments.json    — merchant → bucket mappings
  problems.json       — debt/letter problem queue
```
The email slug comes from `userDataPath(email, 'finance/...')` in `user-data.js`. GDPR-safe by construction — no cross-user bleed.

### Transaction Schema
```js
{ id, date, description, amount, category, bucket, merchant, recurring, flagged }
// amount: negative = money out, positive = money in
```

### Problem Schema
```js
{ id, type, title, provider, amount, dueDate, status, documents[], addedAt }
```

### AI Models Used
| Task | Model | Why |
|---|---|---|
| Parse statement text → transactions | `Q_CONFIG.model` (V4-Pro) | Text parsing, needs accuracy |
| Categorise transactions | `Q_CONFIG.model` (V4-Pro) | Same |
| Read PDF/image statements | `Q_CONFIG.visionModel` (Kimi-K2.5) | V4-Pro is text-only |
| Read bill/letter images | `Q_CONFIG.visionModel` (Kimi-K2.5) | Same |
| APS advice / debt coaching | `Q_CONFIG.model` (V4-Pro) | Main brain |

**Critical:** V4-Pro cannot see images. All vision calls MUST use `visionModel`. V3 (`fastModel` previously) is **retired** — it was causing 503s in this session.

### Upload Flow — Statement
```
User drops CSV/TXT → /api/finance/statement → importStatement() → parseStatementText() (V4-Pro) → categoriseTransactions() (V4-Pro) → save
User drops PDF      → /api/finance/statement/pdf → importStatementFromImage() → Kimi-K2.5 reads doc → same parse+categorise chain
QR from phone       → doc-drop session poll → /api/finance/statement/pdf → same as above
```

### Upload Flow — Bill/Letter
```
User drops image/PDF → /api/finance/document → extractDocument() → Kimi-K2.5 → structured JSON → auto-creates Problem
QR from phone        → doc-drop session poll → same extractDocument() path
```

### QR / Doc-Drop
- User clicks "📱 Scan from phone" → client calls `POST /api/doc-drop/sessions` → gets session id + token
- Client renders QR code (qrcode.js CDN) pointing to `{origin}/doc-drop/{token}`
- Phone opens `doc-drop-mobile.html`, picks file or takes photo, base64 POSTs to `/api/doc-drop/upload/{token}`
- Desktop polls `/api/doc-drop/sessions/{id}` every 3 seconds — when file appears, fetches it via `/api/doc-drop/sessions/{id}/files/{fileId}` and processes
- Sessions are in-memory only (Map, 30-min TTL). No disk write — base64 held in memory until consumed.

---

## API Routes (all require auth via `requirePerson`)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/finance/transactions` | All transactions for user |
| GET | `/api/finance/graph` | Spending graph data (category + bucket breakdowns) |
| GET | `/api/finance/subscriptions` | Detected recurring payments |
| POST | `/api/finance/statement` | Import from CSV/text |
| POST | `/api/finance/statement/pdf` | Import from PDF or image (vision) |
| POST | `/api/finance/document` | Extract bill/letter data from image |
| PATCH | `/api/finance/transactions/:id` | Update a single transaction |
| DELETE | `/api/finance/transactions` | Delete transactions (body: `{ ids[] }`) |
| POST | `/api/finance/assign` | Tag merchant to a bucket (`{ merchant, label }`) |
| GET | `/api/finance/assignments` | All merchant → bucket mappings |
| GET | `/api/finance/problems` | Problem queue |
| POST | `/api/finance/problems` | Add a problem |
| PATCH | `/api/finance/problems/:id` | Update problem (status, notes, etc.) |
| POST | `/api/finance/problems/:id/documents` | Attach a document image to a problem |
| POST | `/api/finance/advice` | Q gives APS-aware financial advice |

Doc-drop routes (no auth on upload — token IS the auth):

| Method | Path | What it does |
|---|---|---|
| GET | `/doc-drop/:token` | Serves `doc-drop-mobile.html` |
| GET | `/api/doc-drop/by-token/:token` | Phone checks if token is valid |
| POST | `/api/doc-drop/upload/:token` | Phone uploads file (base64 JSON) |
| POST | `/api/doc-drop/sessions` | Create session (auth required) |
| GET | `/api/doc-drop/sessions/:id` | Poll for files (auth required) |
| GET | `/api/doc-drop/sessions/:id/files/:fileId` | Read a file as base64 (auth required) |
| DELETE | `/api/doc-drop/sessions/:id` | Delete session + files |

---

## What's Working

- Page loads at `/finance` ✓
- Finance card on tools page ✓
- Both upload zones render correctly with separate file-picker and QR buttons ✓
- QR modal generates and shows the code ✓
- Doc-drop mobile page renders and polls ✓
- Problem queue UI renders ✓
- Two graphs (category doughnut + bucket bar) ✓
- Summary stat boxes ✓
- Q advice coach card ✓

## What Was Broken This Session (Now Fixed)

1. **Server wouldn't load at all** — `q-finance.js` originally used `require('openai')` which isn't installed. Fixed by replacing with plain `fetch` `togetherChat()` helper (same pattern as `q-email-writer.js`).

2. **`os` already declared** — routes.js block added `const os = require('os')` but it was already declared earlier. Fixed by removing it.

3. **multer not installed** — initial doc-drop routes used multer. App comment says "no multipart parser dep". Fixed by switching to base64 JSON upload entirely.

4. **QR button opened file picker** — `input[type=file]` with `position:absolute; inset:0` was covering the whole upload zone. Fixed by restructuring: each button is its own element, only the file-picker button contains the hidden input.

5. **PDF import: 500 error** — `handleStatementFile` was calling `/api/finance/document` (bill/letter extractor prompt) for PDFs, then passing the resulting JSON object to the statement text parser. Fixed by adding `/api/finance/statement/pdf` with a statement-specific vision prompt.

6. **503 on text import** — `parseStatementText` and `categoriseTransactions` were using `Q_CONFIG.fastModel` which pointed to `deepseek-ai/DeepSeek-V3`. V3 is **retired**. Fixed by switching both to `Q_CONFIG.model` (V4-Pro).

7. **config.js still listed V3 as fastModel** — Fixed: `fastModel` now aliased to V4-Pro. `q-event-extractor.js` and `q-form-filler.js` also use `fastModel` so they were broken too — now fixed automatically.

---

## Current State — Still To Test

The latest deploy (commit `c09aaf1`) has all the above fixes. The statement import has **not been successfully tested end-to-end yet** because of the V3 outage during this session. This is the first thing to verify:

1. Drop a bank statement CSV → should show "✓ X transactions imported"
2. Drop a bank statement PDF → Kimi-K2.5 reads it, same result
3. QR scan → take photo of statement on phone → processes on desktop

---

## Known Gaps / Next Steps

These features are in the spec but not yet built or tested:

| Feature | Status | Notes |
|---|---|---|
| **Calendar send** | Not built | "Press send to calendar" from due dates — needs Q's calendar tools wired |
| **"Help me with this" letter drafting** | Scaffolded | Problem queue has a coach card but the creditor letter drafter isn't wired to the email/letter plugin yet — check threads page pattern |
| **Subscription cancel links** | Not built | Detected subscriptions show but no action buttons |
| **Merchant assignment flow** | Built, not tested | "All McDonald's = Charlie" — `POST /api/finance/assign` is wired |
| **APS discount advice** | Built, not tested | `/api/finance/advice` calls Q with APS context — needs live test |
| **Transaction delete/edit** | Built, not tested | PATCH + DELETE routes are there |

---

## Tech Notes for Next Agent

- **No npm packages beyond what's already installed** — this app deliberately avoids new deps. Check `package.json` before reaching for anything.
- **No multer, no openai package** — upload = base64 JSON body. AI = plain `fetch` to Together AI.
- **Auth pattern** — `requirePerson` middleware, use `req.person.email` for all user data.
- **Page style** — neumorphic, `--neu-raised-*` / `--neu-inset-*` CSS vars, Space Grotesk font, accent `#e91e63`. Inputs = inset shadow. Buttons = raised shadow.
- **Silent crash trap** — `server/index.js` wraps `require('./routes.js')` in try/catch. A broken require causes silent 404 on ALL routes. Always run `node -e "require('./routes')"` to validate before pushing.
- **V4-Pro is text-only** — any call that includes an image MUST use `Q_CONFIG.visionModel` (Kimi-K2.5). V4-Pro on vision = silent failure or error.
- **fastModel is now V4-Pro** — V3 is gone. Don't introduce new `fastModel` references expecting a "lighter" model.

---

## Commits This Session

```
c09aaf1  fix(config): retire fastModel V3 — point to V4-Pro
fd74ce9  fix(finance): switch statement parser from fastModel (V3, 503) to model (V4-Pro)
46a731b  fix(finance): use Q vision for PDFs same as every other page — remove pdf-parse path
1ffc443  fix(finance): pdf-parse error handling + clearer client feedback on zero results
0240167  fix(finance): PDF statement — use pdf-parse instead of vision model
a835644  fix(chat): wrap /chat route in try/catch — prevent unhandled rejection crashing server
aec8d59  fix(finance): separate file pick and QR into two distinct buttons per upload zone
```
(Commits before `aec8d59` are from prior sessions)
