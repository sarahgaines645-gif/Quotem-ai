# DEV QUEUE — Q App

Shared backlog between Sarah, Q, and Claude (the dev). This file IS the
channel: Claude reads/writes it directly from the repo. A Thread created
in the live app can't be read by Claude (it lives on the production
volume, not the repo) — so the queue lives here instead.

**Protocol:** Sarah or Q adds items at the bottom of the relevant section.
Claude updates `Status` as work moves. Nothing here is auto-deployed —
fixes are described and wait for Sarah's go, per the standing rule.

_Last updated: 18 May 2026_

---

## Critical / Blocking

1. **Finance parser — model narrates instead of JSON.**
   Status: **SHIPPED 18 May — quotem-ai `main` `9862c8f`.** Dropped
   `response_format` (the V4-rule violation), reinforced the prompt
   (PARSE_SYSTEM untouched, max_tokens still 4000 — no trimming), robust
   extractor (strip fences → whole → first `{…}` → first `[…]`). Verified
   6/6 against pure/fenced/narrated/array/transactions-key/prose replies.
   **Verify on deploy:** upload the Monzo PDF and confirm transactions
   parse (the model-behaviour half can only be confirmed live/lab).

2. **Writer page routing — broken after 8+ attempts.**
   Status: **NEEDS RECONCILE before deploy.** Sarah: a paste-ready fix spec
   from 16 May exists (DB migration, API routes, frontend fetch). Claude's
   18 May investigation found a *different* root cause (silent text-extraction
   failure swallowed as success in `writer.html:~1623` → empty source block;
   plus `routes.js:~1061` data-URL regex 400s on no-MIME `.docx`). These may
   be different layers or different issues. Claude to locate the 16 May spec,
   compare against the diagnosis, and deploy the correct fix — not paste blind.

3. **Finance ↔ Threads connection.**
   Status: TODO. Finance debt/bills should feed into Threads so they appear
   in case files automatically. Builds on the 18 May case-builder
   (`add_file_to_thread`, finance tools already exist).

## Chat / UX

4. **Sub-agent / tool messages leaking** — user sees internal tool calls and
   reasoning steps that should be hidden. Status: TODO (q-chat tool loop /
   frontend render).
5. **"Let me get that for you" dead-end** — Q promises a fetch, follow-through
   never happens (tool chain breaks). Status: TODO. Likely same area as #4.
6. **"Speaking…" indicator stuck** — persists with no voice / doesn't clear
   after speech ends. Status: TODO (frontend).
7. **Chat input locks during streaming** — input should stay active while Q
   replies. Status: TODO (frontend).
8. **Responses cut off mid-sentence** — seen twice on 18 May. Token limit or
   streaming hiccup. Status: TODO (investigate max_tokens / stream end).

## Infrastructure

9. **Notification permission prompt / no bell icon.**
   Status: **SHIPPED 18 May — quotem-ai `main` `4242b08`.** Installed
   web-push (lockfile → prod build); site-wide gesture-driven bell in
   `q-auth.js` (mounts only for signed-in users; off/on/blocked; heals
   server copy after redeploy); `q-push.js` now reads `VAPID_EMAIL`
   (rejects dead `sarah@`, logs resolved contact); removed the buggy
   auto-on-load block from `chat.html`. Syntax + VAPID logic verified.
   **Verify on deploy:** (a) Railway redeploy so `VAPID_EMAIL` +
   `web-push` are live; (b) deploy log shows `[q-push] VAPID contact in
   use: mailto:hello@quotem.co.uk`; (c) bell appears top-right when
   signed in, click → real browser permission prompt → dot on; (d) a
   test push arrives. Also still open: `street_view` reads
   `GOOGLE_MAPS_KEY` but env shows `GOOGLE_PLACES_KEY` — add the
   Street-View key as `GOOGLE_MAPS_KEY` or tell me the var name.
10. **Push / emails / API keys / reminders** — flagged 30 Apr, still not
    fully wired. Overlaps #9. Status: TODO (scope properly).
11. **Shared dev queue** — DONE: this file. Claude reads it from the repo.
    Open question: auto-bridge so Q can write here without Sarah couriering
    (small build — Q→export→repo). Status: decide if wanted.

## Behavioural (Q config/steering — NOT persona files)

12. Q should always give direct links, emails, quickest routes to resolve —
    not just advice. Status: TODO (surface/steering, not persona edits).
13. Q never accepts defeat unless there's genuinely no path — creative
    reasoning first, surrender last. Status: TODO (same; mirrors the
    partner/no-doomsayer ethos).

---

### Shipped (context)
- **18 May** Q case-builder (quotem-ai `main` 335952c): `search_images`,
  `street_view`, `add_file_to_thread`, `create_document` w/ images, `thread`
  case-manager surface + hard fact-check rule. `street_view` dark until
  `GOOGLE_MAPS_KEY` set on quotem-ai Railway env + Maps Platform enabled.
