# POP — Q ideas backlog

Sarah's pop-up ideas for Q. Captured, not built. Don't act on these unless explicitly asked.

Format: one line per idea, dated.

---

- 2026-04-29: Eventually put Quotem tools on Q's page. Architecture: Q has tool definitions that call Quotem's API (e.g. `quote_builder.create(text)` → POSTs to Quotem's `/api/paste`). Q stays general, Quotem stays the specialised backend for the quoting skill, but on Q's page you can ask him to build a quote and he invokes the pipeline. Same pattern for survey tool, contracts, photo drop, etc. Brand stays separate, capability flows through one interface.
