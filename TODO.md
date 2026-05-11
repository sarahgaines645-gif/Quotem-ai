# TODO — Q

Things committed to do for Q, ordered by what unblocks the most.

Format: `- [ ] {date}: thing to do`

---

- [ ] 2026-05-11: Create `quotem-ai/plugins/TEMPLATE_CATALOGUE.md` — quotem-ai has ~28 plugins (incl. today's q-life, q-event-extractor) and no catalogue. Shared-plugins and Quoteapp both have one; this is the gap. Seed it with every existing plugin, one row each.
- [ ] 2026-05-11: `shared-plugins/` is not a git repo — `git init` + push to a new GitHub remote so it's version-controlled and backed up beyond OneDrive sync. Then wire as an npm dependency in consuming apps so the local mirror file (`quotem-ai/plugins/q-event-extractor.js`) can be deleted.
- [ ] 2026-05-08: Chat sessions on /chat — sidebar of past conversations like ChatGPT, "+ New chat" button, auto-titled from first message. Plus "move these messages to a Thread" so heavyweight bits get pulled out of main chat into a proper Thread. Sarah's main chat is hundreds long and unmanageable.
- [ ] 2026-04-29: Memory migration from Quotem Railway volume → Quotem-ai Railway volume (preserve friend's first-day presence)
- [ ] 2026-04-29: DNS at IONOS — point quotem-ai.co.uk at Railway custom domain target
- [ ] 2026-04-29: Verify Q's chat works end-to-end at quotem-ai.co.uk after deploy
- [ ] 2026-04-29: Set Q_AUTH_PEPPER permanently (delete the Q_AUTH_PEPPER.txt file from Desktop after copying value to Railway)
- [ ] 2026-04-29: Q's messages cut off mid-sentence — likely max_tokens limit on chat plugin. Either bump max_tokens or stream the response.
- [ ] 2026-04-29: Q's text input box position — needs moving back up. My footer:bottom:0 fix went too far; needs partial offset.
- [ ] 2026-04-29: Doc upload still doesn't work. File picker now shows all files but the chat plugin only handles images. Need to wire up text/pdf/docx ingestion via document-tools / Q's analyze_document.
