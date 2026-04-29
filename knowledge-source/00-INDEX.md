# QB2 Knowledge Source — Index

This folder is QB2's brain food. Everything in here gets chunked, embedded, and stored in `q-lab/q-knowledge.json` when you run:

```bash
node q-lab/plugins/qwen-ingest.js
```

## Rules for files in this folder

1. **Verified facts only.** Every claim that's a regulation, deadline, monetary penalty, or notice period must have a `Source:` line at the top of the section with the official URL. If a fact came from a non-primary source (a blog, a forum), it does not belong here.
2. **One topic per file.** Don't merge unrelated topics. Mixed files retrieve worse — Q's RAG searches for "Awaab's Law" and pulls a generic "landlord guide" chunk, that's a worse answer.
3. **Markdown only** (`.md`). Other supported formats: `.txt`, `.json`, `.csv`. PDFs need to be converted to text first.
4. **Date everything** with `Last verified: YYYY-MM-DD` so future-Sarah knows when the content was last checked. Regulations change.
5. **Gaps are honest.** When something can't be quoted directly, the file says so and points to the PDF/source for human download.

## Index

### Tier 1 — must-have

- `tier1-sor-catalogue-digest.md` — How Quotem's pricing.csv is structured (the actual file is at `server/data/pricing.csv` and gets ingested separately)
- `tier1-approved-document-b-fire-safety.md` — Building Regs Part B, fire safety
- `tier1-approved-document-l-energy.md` — Building Regs Part L, conservation of fuel and power
- `tier1-approved-document-m-accessibility.md` — Building Regs Part M, including M4(1)/M4(2)/M4(3) categories
- `tier1-approved-document-f-ventilation.md` — Building Regs Part F, ventilation
- `tier1-renters-rights-act-2025.md` — Royal Assent 27 Oct 2025, c.26 (NOT 2026 — corrected naming)
- `tier1-right-to-rent-checks.md` — Landlord immigration check duty (gov.uk verified)
- `tier1-habinteg-and-lifetime-homes.md` — Pointer doc: where to get the official 16 criteria + Wheelchair Housing Design Guide
- `tier1-quotem-default-specs.md` — Quotem's default component specs + multi-code rules + expert mistakes-to-avoid (mirrors `server/data/sor-facts.json`)

### Tier 2 — important

- `tier2-awaabs-law.md` — Phase 1 timeframes, social housing only, commenced 27 Oct 2025
- `tier2-section-21-and-section-8.md` — Eviction notice procedures + how RRA 2025 changes them
- `tier2-mees-epc-minimum-standards.md` — Minimum EPC E, £3,500 cap, exemptions, penalties
- `tier2-hhsrs-pointer.md` — 29 hazards reference (pointer to PDF — full list not free-quotable from gov.uk landing pages)

### Tier 3 — nice to have

- `tier3-quotem-feature-catalogue-digest.md` — What Quotem's product does (so QB2 can answer customer questions)
- `tier3-hse-pointers.md` — HSE references for Gas Safe, Asbestos, CDM 2015 (pointer doc)

### Meta files

- `GAP-LIST.md` — What still needs to be added (council DLOs, Brian's letter templates, past quotes, claude.ai export)
- `NEXT-LIST.md` — Sources to gather next (RICS, NRLA, EPC reg detail, etc.)

## How retrieval works

When QB2 is asked a question, his query is embedded and the **top 3 most similar chunks** are loaded into context. So:

- A question like "what's the gas safety check frequency?" will pull from the file that contains that fact most prominently
- If two files cover the same topic, the one with crisper, fact-dense prose tends to win
- This means: **say important facts directly and once.** Don't bury them in narrative prose.

## When you change a file

After editing, re-run ingest:

```bash
node q-lab/plugins/qwen-ingest.js --wipe   # clears library
node q-lab/plugins/qwen-ingest.js          # re-ingests everything
```

The `--wipe` is important if you've edited an existing file — otherwise old chunks linger.
