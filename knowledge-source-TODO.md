# QB2 Knowledge Source — TODO

> **Maintenance metadata for Sarah/Brian — NOT for Q's brain.**
>
> This file lives one level above `knowledge-source/` on purpose. `qwen-ingest.js` walks `q-lab/knowledge-source/` only, so anything here stays out of Q's RAG library. Keeps "NEEDS RESEARCH: balustrade" from becoming a retrievable chunk that QB2 could answer with.

---

## Standards research (opened 2026-04-26)
- [ ] **Review `knowledge-source/PROPOSED-STANDARDS-DRAFT.md`** — 56 proposed default-spec standards across 12 trade groups. Each entry has `[ ] approved [ ] rejected [ ] modified` ticks. Approved entries get merged into `server/data/sor-facts.json` keyAnswers.
- [ ] **Decide: add a `STANDARD FIRE DOORSET PACKAGE` rule to keyAnswers?** The catalogue splits DOOR / FRAME / HINGES / CLOSER / INTUMESCENT into separate codes. Q can match each one and produce a non-compliant assembly (an FD30S doorset must be the certified package). Same shape as the existing `EXTERNAL PAINTING` rule that forces paint vs waterproofer separation.
- [ ] **Resolve the 10 `NEEDS RESEARCH` items** in `PROPOSED-STANDARDS-DRAFT.md` (door-entry video, mat well, bin store, wheelie bin, DPC retrofit, stair nosing, grab bar, worktop upstand, gate-post mass, rooflight/domelight).

## Quotem-internal content (Sarah/Brian only — full briefs in `knowledge-source/GAP-LIST.md`)
- [ ] **A2.** 5–10 sample past quotes (input + output + why it was right)
- [ ] **A3.** Brian's standard letter templates
- [ ] **A4.** Tenant welcome pack template
- [ ] **A5.** Claude conversation export (claude.ai → Settings → Privacy → Export Data) — drop `conversations.json` into the knowledge-source folder
- [ ] **A6.** Council DLO standards (one file per council Quotem works with)
- [ ] **A7.** Survey/inspection report examples
- [ ] **A8.** Voids / planned works / disrepair specs

## PDF downloads (anyone with internet — see `knowledge-source/GAP-LIST.md` Part B)
- [ ] **B1–B4.** Approved Documents B / L / M / F — full PDFs converted to `.txt`
- [ ] **B5.** Right to Rent — full document lists + civil-penalty Code of Practice
- [ ] **B6.** Lifetime Homes Standard — 16 criteria verbatim
- [ ] **B7.** Habinteg Wheelchair Housing Design Guide (3rd ed.)
- [ ] **B8.** HHSRS Operating Guidance — 29 hazards reference (185-page PDF)
- [ ] **B9.** Renters' Rights Act 2025 — full Act text + Explanatory Notes
- [ ] **B10.** Awaab's Law — statutory guidance + regulations
- [ ] **B11.** HSE — gas safety + asbestos (L143) + CDM 2015 (L153)
- [ ] **B12.** Housing Act 1988 Schedule 2 — full grounds text
- [ ] **B13.** NRLA member guidance

## Forward-looking notes (from `knowledge-source/GAP-LIST.md` Part C)
- [ ] **C1.** `server/templates/TEMPLATE_CATALOGUE.md` line ~960 calls it "Renters' Rights Act 2026" — Act is officially the **2025 Act** (Royal Assent 27 Oct 2025). Flagged, NOT changed (live-app rule).
- [ ] **C2.** Decent Homes Standard extends to PRS via RRA 2025 Part 3 — Quotem opportunity for landlord-finance / property-file scoring.
- [ ] **C3.** Main RRA 2025 commencement is **1 May 2026**. Track phased commencements.

## Tier 4 (deferred — see `knowledge-source/NEXT-LIST.md`)
- [ ] RICS guidance, NRLA full library, HMO regs, EPC reg detail, sector-specific schedules.
