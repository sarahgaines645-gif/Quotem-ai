# HHSRS — Housing Health and Safety Rating System

> **Primary source (operating guidance):** [gov.uk/government/publications/hhsrs-operating-guidance-housing-act-2004-guidance-about-inspections-and-assessment-of-hazards-given-under-section-9](https://www.gov.uk/government/publications/hhsrs-operating-guidance-housing-act-2004-guidance-about-inspections-and-assessment-of-hazards-given-under-section-9)
> **Primary source (landlord guidance):** [gov.uk/government/publications/housing-health-and-safety-rating-system-guidance-for-landlords-and-property-related-professionals](https://www.gov.uk/government/publications/housing-health-and-safety-rating-system-guidance-for-landlords-and-property-related-professionals)
> **Statutory basis:** Housing Act 2004, Part 1 — Sections 1 to 54
> **Last verified:** 2026-04-26 (operating guidance ISBN 9781851128464, published 27 February 2006; landlord guidance published 26 May 2006)

## What HHSRS is

> "The housing health and safety rating system (HHSRS) is a risk-based evaluation tool to help local authorities identify and protect against potential risks and hazards to health and safety from any deficiencies identified in dwellings."
>
> — gov.uk

The system **assesses 29 categories of housing hazard**. Each hazard has a weighting that helps determine whether a property is rated as having a **Category 1 (serious)** or **Category 2 (other)** hazard.

## Category 1 vs Category 2

- **Category 1 hazards** — local authorities have a **statutory duty to take enforcement action** under section 5 of the Housing Act 2004
- **Category 2 hazards** — local authorities have a **discretion to take enforcement action** under section 7

## The 29 hazards — overview

> **GAP — full official list not in this file.** The complete 29-hazard schedule, with full operating-guidance descriptions, appears only in the HHSRS Operating Guidance PDF (185 pages, 913KB) — it didn't extract from the gov.uk landing page during the WebFetch attempt.
>
> **To complete this file:** Brian/Sarah should download the Operating Guidance PDF from the gov.uk link above, convert it to text, save here as `tier2-hhsrs-29-hazards-FULL.txt`, then re-run `qwen-ingest.js`.

The 29 hazards are arranged under **four matters** (taken from the regulations under section 2 of the Housing Act 2004 — Housing Health and Safety Rating System (England) Regulations 2005):

### A. Physiological requirements
Hazards relating to:
1. Damp and mould growth
2. Excess cold
3. Excess heat
4. Asbestos and manufactured mineral fibres (MMF)
5. Biocides
6. Carbon monoxide and fuel combustion products
7. Lead
8. Radiation
9. Uncombusted fuel gas
10. Volatile organic compounds (VOCs)

### B. Psychological requirements
11. Crowding and space
12. Entry by intruders
13. Lighting
14. Noise

### C. Protection against infection
15. Domestic hygiene, pests and refuse
16. Food safety
17. Personal hygiene, sanitation and drainage
18. Water supply for domestic purposes

### D. Protection against accidents
19. Falls associated with baths etc
20. Falling on level surfaces
21. Falling on stairs and steps
22. Falling between levels
23. Electrical hazards
24. Fire
25. Flames, hot surfaces etc
26. Collision and entrapment
27. Explosions
28. Position and operability of amenities
29. Structural collapse and falling elements

(The numbering and exact wording above is drawn from the Housing Health and Safety Rating System (England) Regulations 2005 — verify against the official Operating Guidance before quoting on a live case.)

## Local authority enforcement options

If a Category 1 or 2 hazard is identified, the LA can serve any of:

| Action | What it does |
|---|---|
| **Improvement notice (s11/s12)** | Requires landlord to carry out specified work within a set period |
| **Prohibition order (s20/s21)** | Prohibits use of all or part of the property |
| **Hazard awareness notice (s28/s29)** | Formally records the hazard and recommends action (not enforceable) |
| **Emergency remedial action (s40)** | LA does the work and recovers cost from landlord |
| **Emergency prohibition order (s43)** | Bans use immediately |
| **Demolition order (s265 Housing Act 1985)** | In severe cases |
| **Slum clearance area (s289 Housing Act 1985)** | For groups of dwellings |

## Where Quotem can help

The Quotem **image-analysis.js** plugin (Survey Prompt V6) explicitly references **HHSRS severity** in its output. When a defect is detected from a photo, the analysis can suggest which HHSRS hazard category it maps to.

QB2 should:

1. When a survey turns up a defect, **name the specific hazard** (e.g. "this is HHSRS Hazard 1 — Damp and mould growth")
2. **Estimate severity** — Cat 1 (serious) vs Cat 2 (other)
3. For social landlords, **link to Awaab's Law timeframes** (see `tier2-awaabs-law.md`) — Phase 1 covers HHSRS hazards 1 (damp/mould) and the emergency-hazard subset
4. For private landlords, **flag risk of LA enforcement** if a tenant has complained
5. Recommend **remedial work + verify against the SOR catalogue** for pricing

## Cross-references

- **Awaab's Law** — `tier2-awaabs-law.md` (social housing timeframes for hazards 1 and emergency)
- **Decent Homes Standard** — extended to PRS by RRA 2025 (`tier1-renters-rights-act-2025.md`)
- **Approved Document F** — ventilation root cause for Hazard 1 (`tier1-approved-document-f-ventilation.md`)
- **Building Regs Part L** — excess cold / excess heat root causes (`tier1-approved-document-l-energy.md`)

## What QB2 should never do

- **Never** rate a hazard as Category 1 or 2 with confidence from a single photo — formal HHSRS assessment is a regulated activity carried out by trained Environmental Health Officers (EHOs)
- **Never** advise a tenant to refuse access to an LA inspection — they have statutory powers under s239 Housing Act 2004
- **Never** quote the precise HHSRS scoring formula from memory — it involves likelihood × spread of harm × time-period bands and is calibrated against age groups; the calculation lives in the Operating Guidance PDF
