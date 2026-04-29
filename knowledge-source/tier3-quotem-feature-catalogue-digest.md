# Quotem Product — What QB2 Should Tell Customers

> **Source:** Distilled from `server/templates/TEMPLATE_CATALOGUE.md` (last updated 17 Apr 2026 in source)
> **Purpose:** Give QB2 enough product knowledge to answer customer questions about what Quotem does, without exposing internal architecture details.
> **Last verified:** 2026-04-26

## ⚠ Magic not mechanics rule

> "A magician never reveals his tricks. Input → delightful output. Never show pipelines, stage diagrams, QC gates, or 'how it works' content in customer-facing material."
> — Sarah's standing rule (`feedback_magic_not_mechanics.md`)

QB2 should describe Quotem's features by **what they do for the customer**, not by which AI model or pipeline produces the output. The internal-architecture detail in this file is for QB2's own context — not for direct repetition to a customer.

## Who Quotem is for (3 roles)

| Role | What they get |
|---|---|
| **Contractor / Builder** | Quote builder, photo survey, materials shopping, site reports, day-rate / mileage calc, demo videos |
| **Surveyor / Council** | Photo survey, structured field reports, snagging splitter, full pipeline analysis, certificate generation |
| **Landlord / Developer** | Property file, rent tracking, contract writer, condition reports, finance summary, AI-powered tenant comms |

Each role gets a tailored dashboard at `/contractor-dashboard` (V2) — see `MEMORY.md` "V2 is the live dashboard for ALL three roles".

## Core capabilities (customer-facing, plain English)

### Type a description → get a price
You write "new front door" or "fix leaky tap" — Quotem returns the matching official Schedule of Rates code, the standard spec, and a verified price. Used in: **Quote Builder**, **SOR Lookup**.

### Take a photo → get a quote
Snap a photo of a defect — Quotem analyses it, identifies the work, prices the items, and writes a survey report. Used in: **Photo Survey**, **Appy Chat**.

### Talk it through → get a quote
Voice-record a walkthrough or paste a description — Quotem transcribes, extracts the items, and prices everything. Used in: **Voice to Quote**, **Snagging Splitter**.

### Property intelligence
Type a postcode — get the EPC rating, flood risk, area data, and (where signed up) Land Registry / Companies House data.

### Right to Rent in 30 seconds
Tenant share-code or document → instant Right to Rent / Right to Work / Immigration check with a result card and PDF (live at `/right-to-rent`).

### Tenancy contracts
Generate full UK tenancy contracts (assured periodic, Section 8 notice, guarantor, inventory check-in/out) — built on the **Renters' Rights Act 2025** rules. E-signature workflow, condition reporting, smart triggers when rent is missed.

### Disability adaptations / DFG
Disability type + house spec → the right adaptations, priced from SOR, with the DFG estimate. References Approved Document M, BS 8300:2018, Care Act 2014, Equality Act 2010.

### AI staff
The Quotem dashboard has an AI team (Tink, Hope, Mint, Emma, Ping) — they can draft documents, search the database, schedule reminders, send messages, post to the office shared drive. Each has a role and tools tailored to the user.

## How Quotem prevents AI hallucinations (high-level)

QB2 may be asked "how do I know your prices are right?" — the answer:

> Every price Quotem returns is verified against the actual Schedule of Rates database (3,440 codes). The AI never makes up prices — if it tries, the QC layer strips the fabricated number and refuses to show it. This is enforced at every pricing endpoint.

(Internal: this is `qc-gate.js` — but don't reveal that name to a customer.)

## Quotem's pricing approach

- Prices come from the **Schedule of Rates (SOR)** — a 3,440-item industry-standard catalogue of social-housing repair rates
- Optional **profit margin** is applied on top (configurable per quote / per user)
- **Travel** is calculated separately via postcode → mileage at HMRC rates, with ULEZ / congestion zone awareness
- **Materials shopping** can be priced separately via 13 UK trade stores (Toolstation, Screwfix, Wickes, etc.)

## Compliance baked in

QB2 should know that the Quotem product references and respects:

- **Renters' Rights Act 2025** — for any tenancy / contract feature
- **Right to Rent** (Immigration Act 2014) — for tenant onboarding
- **MEES** (EPC E minimum) — flagged in property file
- **Awaab's Law** (Phase 1 from 27 Oct 2025) — surfaced in social-housing repair flows
- **HHSRS 29 hazards** — referenced in image analysis severity
- **Building Regs Part B/L/M/F** — referenced in survey output
- **Gas Safe / Part P** — referenced in certificate generation (CP12, EIC, EICR)
- **CDM 2015** — referenced in risk assessment / method statement form-fillers
- **DFG** (Housing Grants Construction & Regeneration Act 1996) — disability adaptations limit £30k England, £36k Wales, no means-test for children

## Boundaries QB2 must respect

- **Quotem is software, not a regulated professional service.** It does not replace a surveyor's site visit, a solicitor's contract review, or a Building Control sign-off.
- **Q is the engine; QB2 is the Quotem product layer.** When discussing the AI itself in marketing, use "Q" as the public-facing name (Sarah likes it). Internally it's QB2.
- **Live app vs lab** — Sarah's standing rule (`feedback_stop_proposing_system_changes.md`): the live Quotem app is off-limits for changes unless explicitly asked. QB2 work is fair game.

## Prices Quotem will not invent

- A SOR code that isn't in pricing.csv → not a real code → blocked
- A "£" amount returned by AI without a matching real code → stripped by QC
- A price for a service Quotem doesn't categorise → flagged "price on request" rather than guessed

## What QB2 should never claim

- Quotem is "**FCA-regulated**" — it isn't, and doesn't need to be (it's not a financial product)
- Quotem is "**RICS-accredited**" — it isn't (the surveyor users are; the software isn't)
- Quotem replaces the need for a Gas Safe engineer / electrician / Building Control — it doesn't
- Quotem's quote is a "legally binding offer" — the user is the principal; the quote is their proposal
