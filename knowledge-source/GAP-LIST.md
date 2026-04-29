# GAP LIST — What's Still Missing for QB2's Brain

> **Status:** What was either NOT verifiable from web sources, or what only Sarah/Brian can provide.
> **Last updated:** 2026-04-26

The Tier 1 / Tier 2 / Tier 3 .md files I wrote in this folder are **everything I could verify from official UK sources** (gov.uk, legislation.gov.uk, hse.gov.uk, habinteg.org.uk, the Quotem repo). Below is what I couldn't get — split into **(A) Sarah/Brian must provide** and **(B) PDF downloads needed**.

---

## (A) Sarah/Brian must provide — Quotem-internal content

These are things **only you have**. The web doesn't.

### A1. Quotem default specs — DONE (sourced from sor-facts.json)

✅ **File:** `tier1-quotem-default-specs.md` (mirrors `server/data/sor-facts.json` keyAnswers)

Originally I created an empty template here — Sarah pointed out the standards already exist in `server/data/sor-facts.json` (the QS persona's reference file). The new file contains all 32 "STANDARD X" lines verbatim, plus the multi-code rules and expert mistakes-to-avoid.

When `sor-facts.json` is regenerated, re-export this file to keep them in sync. Watch out: the brand name "Quotem Standards Register" is reserved for the photo check-in/check-out RAG product (see `memory/project_quotem_standards_register.md`) — don't reuse it for this file.

### A2. Sample past quotes — 5 to 10 "right" examples

📂 **Suggested filename:** `tier1-quotem-sample-quotes.md`

What QB2 needs:
- **Input** — what the customer said / sent (photos described, paste text, voice transcript)
- **Output** — the quote you produced and considered right
- **Why it was right** — what made the spec / SOR pick / price correct (this is the gold)

5–10 examples covers most of the common shapes (single repair, kitchen, bathroom, full refurb, accessibility adaptation, external works, damp/mould, social-housing planned works).

Format:
```markdown
## Quote 1 — [short title, e.g. "Damp + mould, 2-bed flat, social"]

**Input:**
[paste / photo description / voice transcript]

**Output:**
- Item 1: [SOR code, description, qty, price]
- Item 2: ...
- Total: £...

**Why this was right:**
- [The spec choice you'd defend if challenged]
- [The price you'd defend]
- [The thing a junior surveyor would have got wrong]
```

### A3. Brian's standard letter templates

📂 **Suggested filename:** `tier2-brian-letter-templates.md`

What QB2 needs:
- Rent reminder (gentle / firm / final)
- Eviction warning (Section 8 ground 8/10/11)
- End-of-tenancy comms (notice received / move-out reminder / deposit deductions / deposit return)
- Move-in welcome
- Repair scheduled / repair completed
- Inspection notice
- Rent review notice (post-RRA 2025: 2 months notice, S13 procedure)
- Compliance refusal (e.g. tenant refusing access for gas check)

Brian's voice is the gold. Drop them as plain text — QB2 will learn the tone and use it when drafting.

### A4. Tenant welcome pack — your standard template

📂 **Suggested filename:** `tier2-quotem-tenant-welcome-pack.md`

The pack you give a new tenant. Should typically include:
- Property address + key contacts (landlord, agent, emergency repair)
- Utility supplier handover
- Council tax band + LA contact
- Bin / recycling schedule
- Heating / hot water instructions
- Smoke / CO alarm test schedule
- House rules (smoking, pets, communal areas)
- How to report a repair
- Right to Rent confirmation
- "How to Rent: the checklist for renting in England" (latest gov.uk edition — required to be given for any s21 to be valid)
- Deposit protection certificate + prescribed information

### A5. Claude conversation export — your VOICE training data

📂 **Where to drop it:** anywhere in this folder, the ingest will read it
📂 **Suggested filename:** `tier3-claude-conversation-export.json`

How to get it:
1. Go to [claude.ai](https://claude.ai)
2. Settings → Privacy → **Export Data**
3. Wait for the email, download the `.zip`
4. Find the `conversations.json` file inside
5. Drop it directly into this folder

The ingest pipeline will pretty-print the JSON and chunk it. Months of you talking shop with me/Claude becomes QB2's voice training. **High value, zero effort.**

### A6. Council DLO standards — for the councils Quotem works with

📂 **Suggested filename:** `tier1-council-dlo-standards-[council-name].md` (one file per council)

Each council you work with has its own SOR variant or planned-works specification. Examples:
- "Lambeth DLO Repairs Schedule 2025"
- "Camden Major Works Specification"
- "Tower Hamlets Voids Standard"

Tell me the councils you're working with and I'll fetch what's publicly published. Some specs are **not public** — you'll need to ask the council's Asset Management or DLO team. They're usually willing to share with their contractors.

### A7. Survey reports / inspection reports — actual examples

📂 **Suggested filename:** `tier2-quotem-survey-report-examples.md`

The format you use for surveys + a couple of completed examples. Helps QB2 produce reports that match house style.

### A8. Voids / planned works / disrepair specs

📂 **Suggested filename:** `tier1-quotem-voids-spec.md` (and similar)

If you have any standard "this is what we do for a void turnaround" or "this is the disrepair response process" — drop those in. Sector-specific defaults beat generic UK trade.

---

## (B) PDF downloads needed — official sources, just need converting

These are publicly available; you (or Brian, or any executor chat with internet access) can grab them and convert PDF → text.

### Quick conversion methods

- **Online (free, but check privacy):** smallpdf.com, ilovepdf.com — paste PDF, get .txt
- **Local CLI:** `pdftotext input.pdf output.txt` (poppler-utils, Mac/Linux/Windows-via-WSL)
- **In Word:** open the PDF in Word — it converts on open. Save as .txt.

### B1. Approved Document M (Building Regs)

- **Vol 1 PDF:** Linked from https://www.gov.uk/government/publications/access-to-and-use-of-buildings-approved-document-m
- **Vol 2 PDF:** Same page, second link
- **May 2024 amendments PDF:** Same page

📂 **Save as:** `tier1-approved-document-m-volume-1-FULL.txt` and `-volume-2-FULL.txt`

### B2. Approved Document B (Fire Safety)

- **Vol 1 PDF (Dwellings):** https://www.gov.uk/government/publications/fire-safety-approved-document-b
- **Vol 2 PDF (Other buildings):** Same page

📂 **Save as:** `tier1-approved-document-b-volume-1-FULL.txt` and `-volume-2-FULL.txt`

### B3. Approved Document L (Energy)

- **Vol 1 PDF (Dwellings):** https://www.gov.uk/government/publications/conservation-of-fuel-and-power-approved-document-l
- **Vol 2 PDF (Other buildings):** Same page
- **2023 amendments:** Same page

📂 **Save as:** `tier1-approved-document-l-volume-1-FULL.txt` and `-volume-2-FULL.txt`

### B4. Approved Document F (Ventilation)

- **Vol 1 PDF (Dwellings):** https://www.gov.uk/government/publications/ventilation-approved-document-f
- **Vol 2 PDF (Other buildings):** Same page

📂 **Save as:** `tier1-approved-document-f-volume-1-FULL.txt` and `-volume-2-FULL.txt`

### B5. Right to Rent — full document lists (List A and List B)

- **Page:** https://www.gov.uk/government/publications/right-to-rent-document-checks-a-user-guide
- **Document:** "Right to rent checks: a guide to immigration documents for tenants and landlords" (PDF)
- **Also:** "Code of Practice on civil penalties" (current Feb-2024 increased rates) — same publisher
- **Also:** "Code of Practice for landlords: avoiding discrimination"

📂 **Save as:** `tier1-right-to-rent-document-lists-FULL.txt` and `tier1-right-to-rent-civil-penalties-FULL.txt`

### B6. Lifetime Homes Standard — 16 design criteria verbatim

- **Lifetime Homes Design Guide (EP 100):** BRE Bookshop (paid) — https://bregroup.com/store/bookshop/lifetime-homes-design-guide-ep-100-download-
- **Free council summary:** https://www.lbbd.gov.uk/sites/default/files/2022-09/Lifetime-Homes-Standards-Checklist-April-2015.pdf (Barking & Dagenham council's checklist — covers all 16 with brief)
- **Habinteg's own page:** Currently flaky — check https://www.habinteg.org.uk for the current download

📂 **Save as:** `tier1-habinteg-lifetime-homes-16-criteria-FULL.txt`

### B7. Habinteg Wheelchair Housing Design Guide (3rd edition)

- **Habinteg shop:** https://www.habinteg.org.uk (search "Wheelchair Housing Design Guide")
- **Or RIBA Bookshop**

📂 **Save as:** `tier1-habinteg-wheelchair-housing-design-guide-FULL.txt`

### B8. HHSRS Operating Guidance — full 29 hazards reference

- **Page:** https://www.gov.uk/government/publications/hhsrs-operating-guidance-housing-act-2004-guidance-about-inspections-and-assessment-of-hazards-given-under-section-9
- **Document:** 185-page PDF (~913KB)

📂 **Save as:** `tier2-hhsrs-29-hazards-FULL.txt`

### B9. Renters' Rights Act 2025 — full text

- **Page:** https://www.legislation.gov.uk/ukpga/2025/26/contents
- The legislation site offers HTML directly — you don't strictly need a PDF. But the **Explanatory Notes** are PDF-only:
- **Explanatory Notes:** https://www.legislation.gov.uk/ukpga/2025/26/pdfs/ukpgaen_20250026_en.pdf

📂 **Save as:** `tier1-renters-rights-act-2025-FULL.txt` (HTML scrape) and `tier1-renters-rights-act-2025-explanatory-notes-FULL.txt` (PDF convert)

### B10. Awaab's Law — full statutory guidance + regulations

- **Statutory guidance:** https://www.gov.uk/government/publications/awaabs-law-guidance-for-social-landlords (download HTML or PDF)
- **Regulations:** Hazards in Social Housing (Prescribed Requirements) (England) Regulations 2025 — available on legislation.gov.uk
- **Tenant guidance (different doc):** https://www.gov.uk/government/publications/awaabs-law-guidance-for-tenants-in-social-housing

📂 **Save as:** `tier2-awaabs-law-statutory-guidance-FULL.txt`

### B11. HSE — landlord gas safety + asbestos + CDM 2015

- **Gas (landlord pages):** https://www.hse.gov.uk/gas/landlords (multiple pages)
- **Asbestos ACoP L143:** https://www.hse.gov.uk/pubns/books/l143.htm (paid book, but free webpages cover most)
- **CDM 2015 ACoP L153:** https://www.hse.gov.uk/pubns/books/l153.htm (paid book; free web equivalent at https://www.hse.gov.uk/construction/cdm/2015/)

📂 **Save as:** `tier3-hse-gas-safety-FULL.txt`, `tier3-hse-asbestos-FULL.txt`, `tier3-hse-cdm-2015-FULL.txt`

### B12. Schedule 2 Housing Act 1988 (as amended by RRA 2025) — full grounds text

- **Page:** https://www.legislation.gov.uk/ukpga/1988/50/schedule/2 (HTML)

📂 **Save as:** `tier2-housing-act-1988-schedule-2-grounds-FULL.txt`

### B13. NRLA standards docs — landlord guidance

- **Page:** https://www.nrla.org.uk
- **Membership-gated:** much of the best content is members-only (Sarah, you may already have access)
- **Free guides** (cookies/checks) available too

📂 **Save as:** `tier2-nrla-guidance-FULL.txt`

---

## (C) Bonus — things I noticed while writing

### C1. Catalogue says "Renters' Rights Act 2026" — needs fixing

`server/templates/TEMPLATE_CATALOGUE.md` line ~960 (in the contract-writer.js section) lists:

> "Renters' Rights Act 2026 (AST abolition, Section 21 abolition, periodic-only)"

The Act is officially the **2025 Act** (Royal Assent 27 October 2025). It commences during 2026, hence the confusion. **Don't rename in the live app without permission** (per `feedback_stop_proposing_system_changes.md`) — but flagged for awareness when next touching the catalogue.

### C2. Decent Homes Standard now extending to PRS

**Part 3 of the Renters' Rights Act 2025** (Sections 100–101) extends the Decent Homes Standard to the private rented sector. The DHS was previously social-housing only. This is a notable Quotem opportunity — landlord finance + property file features could explicitly score against DHS criteria once the regs commence. Worth a follow-up brief.

### C3. Renters' Rights Act commencement 1 May 2026

The gov.uk eviction guidance flags "rules about private renting are changing on 1 May 2026". This is the **main private-renting reforms commencement date** for the RRA 2025. Not all sections — Chapter 3 of Part 4 (investigatory powers) commenced 27 December 2025 already. There will be further phased commencements. Worth tracking via legislation.gov.uk SI list.
