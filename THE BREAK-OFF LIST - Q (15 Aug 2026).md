# THE BREAK-OFF LIST — Q (quotem-ai): EVERYTHING THAT COULD MAKE MONEY
*15 Aug 2026 · Companion to the Quotem list. From a full sweep of every page, all 42 plugins,
the README/TODO/DEV_QUEUE, the four 19-May audits, the 22-Jul revision/writer audit and the
15-Aug finance roadmap. Same columns as the Quotem list.*

**SELL column:** OWN APP · PACK · ADD-ON · API (license to other software) · KEEP (personal/moat)

---

## READ THIS FIRST — three things that gate the WHOLE repo

Nothing here can be sold to a stranger until these are fixed. Not "should be" — the audits
say they are live today.

1. **Cross-user data leak (CRITICAL, unfixed):** `plugins/user-data.js:29-31` turns emails
   into folder names by replacing every symbol with `_`, so `john.smith@`, `john-smith@` and
   `john_smith@` all land in the SAME folder. Finance, threads, life, the cloned voice sample,
   generated documents — a second user with a near-identical email would see (and overwrite)
   the first user's data. Sign-up has no email verification either.
2. **Boot-time key fallback:** without `Q_AUTH_PEPPER` the server logs an error and boots on a
   public hardcoded string — and Gmail refresh-token encryption falls back to that same string.
3. **No cost meter:** only the chat plugin logs spend; ~19 other AI callers log nothing, and the
   price table returns £0 for GLM, Kimi, Gemini and every Claude model. You cannot price a
   usage product when the unit cost reads zero. Also no per-tool on/off switch exists yet.

Also structural: one uncaught error takes the whole monolith down (no global handler), and Q
sends bank statements and case files to two non-UK processors by design (audited).

---

## A. THE ONES WORTH BREAKING OFF (generalisable, working, own front door)

| # | Thing | What it does | Sell | Status / honest notes |
|---|---|---|---|---|
| 1 | **Revision / exam drill** (`revise.html`, `q-revision`, `q-bank`) | GCSE/A-Level/BTEC MCQ builder with one-line "why" teaching, "I don't understand" explainer with a YouTube link, THE TUBE arcade game, and an Exam Room (unlocks at ≥10 answered at ≥85%) marking typed answers against a mark scheme | **OWN APP — the strongest candidate in this repo.** Nothing Sarah-specific in the code; level/board/subject are free inputs | Live since 22 Jul. Cost is tiny: bank build <£1 per subject once, playing from the bank = £0 per answer, exam marking 2–4p a question. ⚠️ Cannot use real past papers (copyright); questions are generated + Sonnet-checked. Under-18 users = children's data rules |
| 2 | **Writer — adaptive writing coach** (`writer.html`, `q-writer`, 19 routes) | Does NOT write for you — asks adaptive questions, takes your answers verbatim, assembles your own words; marks sections, suggests Harvard refs, explains concepts | **OWN APP** (students, apprentices, CIPD/degree essays). Academic-integrity story is built in by design | 502 root cause fixed 22 Jul; ⚠️ one open item never confirmed on live (brief board with the 4 AC questions); no request timeout in the plugin yet |
| 3 | **Doc Editor — voice/chat-driven Word editing** (`q-doc-editor`) | Upload .docx, tell Q what to change, get it back with formatting preserved | OWN APP (small) or **API** — cleanest big plugin in the repo, 4 routes | Built, session-based; needs the chat tool loop to drive it |
| 4 | **Threads / case files** (`thread.html`, `q-threads`) | One file per situation — emails, uploads, contacts, notes, chat, a cite-check pass, form-scan + fill, drafted actions | OWN APP later (disputes, complaints, tenancy fights) | Live and heavily used; the £11 cost bleed came from here (now cached). 50MB in-memory upload route needs fixing |
| 5 | **Forms pipeline** (`plotter.html`, `q-form-filler`, `q-dot-plotter`) | Render any PDF form, detect fields, intake by chat/voice/screenshot, export filled/editable PDF, DOCX via LibreOffice, public fill link | Same product family as Quotem's Form Filler — **merge, don't sell twice** | Works; DOCX path relies on a LibreOffice subprocess that can outrun the proxy window |
| 6 | **Life — calendar/tasks from a letter** (`life.html`, `q-life`, `q-event-extractor`) | Paste or photograph a school letter → events + tasks extracted → one-press add; repeating reminders, push | OWN APP (parents) — the "school letter → calendar" hook is genuinely sharp | Live, repeating reminders shipped 15 Aug. Children's data in the letters |
| 7 | **Graphics — image → editable SVG** (`q-graphics`) | Photo/logo → clean SVG | OWN APP (tiny) — 63-line plugin, one route, £0 direct cost on HF ZeroGPU | Works when the Space is up; capacity is free-tier, not commercial |
| 8 | **Client-side media trio** — `image-tools.html` (background removal + upscale), `voices.html` (15-voice TTS), `code.html` (Python in the browser) | Runs 100% in the visitor's browser — **zero server cost per use** | Free lead-magnets or a one-off "tools" page; not a subscription | Model licences to check before commercial use (RMBG-1.4 history; Kokoro Apache-2.0; Pyodide MPL) |

## B. SELLABLE BUT WITH A LEGAL WALL IN FRONT

| # | Thing | Sell | The wall |
|---|---|---|---|
| 9 | **Finance engine** (`finance.html`, `q-finance` — 94KB, reworked 14–15 Aug) — where your money goes, subscriptions, income, money rhythm, problems & debts, statement paste, phone scan | OWN APP eventually — the ADHD/disorganised-money hook is real, and the roadmap's Club Lloyds packaged-benefits cross-check is a genuine killer feature | Full bank statements + debt/court letters go to two non-UK processors; roadmap item 0.4 ("your bank data only ever goes to one place") not done; the `read_finance` chat tool leaks 30 raw transactions into any chat; **debt counselling is FCA-regulated** — the roadmap's "line we do not cross" is enforced only by prompt. Real credit scores need a CRA agreement. Sell LAST, after the wall is code |
| 10 | **Voice cloning** (`voice-clone.html`, `q-audio-fetch`) — clone from a 5–15s sample, or from ANY URL via yt-dlp | — | **Highest legal risk in the repo.** The page advertises "clone any voice"; zero consent language anywhere; the URL path can clone a voice off YouTube. Biometric data under GDPR Art. 9, passing-off, source-site ToS. **Do not sell as-is.** Consent-gated "clone YOUR OWN voice" is the only sellable shape |
| 11 | **Music / video generation** (`q-music`, `q-video`) | — | No licensing or commercial-use statement to the user anywhere; video is 2 seconds long at defaults; both ride free HF capacity. Not products yet |
| 12 | **Image generation** (`q-image-gen` — OpenAI gpt-image-1) | ADD-ON only | Real per-use cost (~4–17p an image) with no meter; OpenAI resale terms |

## C. GLUE, DUPLICATES AND KEEPS

| # | Thing | Verdict |
|---|---|---|
| 13 | **Email writer + full mailbox** (`q-email-accounts` 45KB — Gmail OAuth, Outlook Graph, IMAP/SMTP) | Duplicate of Quotem's `email-connect.js` — sell once, from Quotem. Google OAuth app is unverified (test users only) |
| 14 | **Chat itself** (`q-chat` + `q-tools` = 282KB, 52 tools) | **KEEP — this is Q.** Sarah-personal by construction (persona files, cross-Circle memory is a designed feature — the opposite of what a sold product needs). Known UX defects (tool messages leaking, dead-ends, stuck "Speaking…", cut-off replies) |
| 15 | **Agent runner + scheduler** | KEEP internal — up to 100 unmetered iterations; audit names it the biggest spend risk |
| 16 | **SOR mirror stack** (`q-text-reader/translator/checker/expander/pricer/sor-picker`, `quote-builder.html`) | Quotem IP living in Q's repo (prompts copied verbatim; reads Quotem's data files) — contradicts Q's own "No Quotem-specific code" rule. Belongs to the Quotem list, not this one |
| 17 | **RAG library** (`q-rag`, `q-knowledge.json` — 1.09MB committed) | Infrastructure. ⚠️ contents of the committed knowledge file unaudited |
| 18 | **QR toolkit, doc-drop mobile, NFC tags page, `cjk-filter`, `polish-uk`** | Glue, small, self-contained; `cjk-filter` header already frames itself as a UK-gov sales requirement |
| 19 | **Travel search** (`q-travel`) | Inert until a RapidAPI key is set; adapter-swappable; not a product |

---

## THE HONEST TOTALS FOR Q

- **~19 units; 8 genuinely worth breaking off** (section A), and one of those — the **Revision
  drill (#1)** — is the standout: generalisable, live, near-zero per-use cost, and it sells to
  a market (parents of exam-year kids) that has nothing to do with Quotem's territory. It's
  arguably the second-best break-away across BOTH repos after Fix My Sheet.
- **Q's chat is not for sale** — by design it's a personal AI with cross-Circle memory. The
  sellable things are the *tools Q grew*, not Q.
- **The three gates at the top block everything** — the email-slug leak most of all. Fix that,
  add email verification, make the pepper mandatory, wire the cost meter — then Section A opens.
- **Two products exist in both repos** (form filler, email/mailbox) — sell each once.
- Nothing here has a Stripe or paywall of any kind yet; Q was built with a Circle door, not a
  till. The Fix My Sheet rails (one-off Stripe, no accounts) fit #1, #3 and #7 exactly.
