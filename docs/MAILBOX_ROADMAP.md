# Mailbox Roadmap — Quotem-ai + Quotem

Turning the working Gmail read into a **proper mailbox** across both apps. Written to
work through in phases when there's time — not all at once.

## Where we are now (done)
- **Read Gmail via OAuth** (both apps) — the send token + `gmail.readonly`, no IMAP/app-password.
  - quotem-ai: `plugins/q-email-accounts.js` (`listGmailInbox` / `readGmailMessage` / `listGmailLabels`), routes in `routes.js`, UI in `email-writer.html`.
  - Quotem: `server/routes/email-connect.js` (`gmailInboxForUser`), served through `/api/inbox` in `chat.js`; existing `AdminInbox.jsx` displays it.
- quotem-ai extras: folder switcher, draggable floating reader, Reply-with-Q, outbox edit.
- Body is **plain text / stripped HTML** only. No images, attachments, or actions yet.

## The one gating decision: OAuth scope
Everything that *changes* mail (delete, archive, mark read/unread, star, move/label) needs
**`gmail.modify`** instead of `gmail.readonly`. `modify` = read + trash + label changes (NOT
permanent delete — "delete" becomes "move to Bin", exactly like Gmail). It's a restricted scope
like `gmail.send`, which already works for Sarah's account, so it grants the same way (one
reconnect). **Decide this first** — Phase 1 depends on it.

---

## Phase 1 — Core actions (needs `gmail.modify`)
- Server: `POST /email/inbox/:id/modify { addLabels, removeLabels }` and `POST /email/inbox/:id/trash` (Gmail API `messages.modify` / `messages.trash`).
- Wire buttons in the reader + list: **Delete** (trash), **Archive** (remove `INBOX`), **Mark read/unread** (`UNREAD` label), **Star** (`STARRED`).
- Persist **read** state — remove `UNREAD` when a message is opened (fixes the current "reverts on refresh").
- Both apps.

## Phase 2 — Rich content (render like Gmail)
- **HTML rendering**: show the real formatted email, sanitised (DOMPurify — CDN in quotem-ai's HTML, npm in Quotem's React) to block scripts/XSS.
- **Inline images** (`cid:` parts): fetch the attachment part and swap `cid:` refs to data/URLs.
- **Remote images**: blocked by default with a "Show images" toggle (privacy/tracking, Gmail behaviour).
- **Attachments**: list as chips; `GET /email/inbox/:id/attachment/:attId` to download; inline preview for images/PDF.
- **Video**: email almost never embeds real video — render the poster/thumbnail + link. Low priority.

## Phase 3 — Organisation
- **Labels/folders**: apply/remove/create labels; move between folders (quotem-ai already *lists* folders — add apply/move). Quotem gets the folder switcher too.
- **Search**: Gmail API `q=` (search box over the inbox).
- **Pagination**: `pageToken` → "Load more" beyond 25.
- **Conversation view**: group by `threadId` (a thread, not loose messages).

## Phase 4 — Compose, reply, and the design suite
- Proper **Reply / Reply-all / Forward** with correct threading headers (`In-Reply-To`, `References`) so replies thread inside Gmail.
- **Rich compose** (formatting + attachments) — this is where Sarah's **Quotem email design suite / smart emails** plugs in (port from Quotem, drop Puck per the note).

## Phase 5 — Parity, performance, and Q
- **Two-app parity**: bring Quotem's React inbox up to the same feature set (folders, floating/clean reader, actions). Decide shared vs per-app UI.
- **Performance**: current per-message `format=full` fetch is heavy. Move to **metadata list + body-on-open** (quotem-ai already opens body on click; Quotem should switch its list to metadata + fetch body when a message is opened). Consider batch requests + short cache + unread badge + periodic refresh.
- **Q watch-and-notify** (Sarah's ask): Q watches for expected senders/subjects and pings her (push) when a reply lands. Builds on the label/modify infra + the existing push system.

---

## Notes / risks
- `gmail.modify` reconnect: same consent flow as now; Sarah reconnects once.
- HTML email is hostile — **always sanitise**; never inject raw email HTML.
- Quotem client changes deploy via **Netlify** (check credits); server changes deploy via **Railway**. Server-only work (like the read fix) ships without Netlify.
- Keep the plain-text fallback for accessibility and when HTML is missing.

## Suggested order
Phase 1 (scope + actions) → Phase 2 (HTML/images/attachments) → Phase 3 (labels/search) →
Phase 4 (compose/design suite) → Phase 5 (parity/perf/Q). Each phase is shippable on its own.
