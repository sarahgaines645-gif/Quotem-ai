# SOR Catalogue — Digest

> Source: `c:\Users\sarah\OneDrive\Desktop\Quoteapp\server\data\pricing.csv`
> Total rows: **3,440 SOR codes** (one header row + 3,440 data rows)
> Last verified: 2026-04-26

## What this file is

Quotem's master pricing list. Every code in the live app's quotes/surveys/Appy comes from here. The Schedule of Rates (SOR) format is the UK social housing / DLO repair-pricing standard — each line item is a 6-digit code, a short description, a long description, a unit of measure, and a rate.

## CSV columns (in order)

| Column | Meaning |
|---|---|
| `Document Code` | The 6-digit SOR code (e.g. `001101`) — the unique key |
| `New v7.2` | "New" if added in v7.2 of the SOR; blank otherwise |
| `Priority` | `R` = Routine / `U` = Urgent / `E` = Emergency (most are `R`) |
| `Right to Repair` | `Y`/`N` — qualifies under tenant's statutory Right to Repair Scheme |
| `Component Accounting` | `Y`/`N` — used for component accounting (capital vs revenue) |
| `First Time Fix` | `Y`/`N` — should be completed in one visit |
| `NHF_Trade_Code` | National Housing Federation 2-letter trade code (see below) |
| `Short Description` | One-line summary in `COMPONENT:ACTION` format |
| `Element` | Top-level category (Groundworks, Roofing, Internal Walls, etc.) |
| `Section` | Subcategory within the Element |
| `Subsection` | Material/method-specific further subcategory |
| `UOM` | Unit of Measure (see below) |
| `SOR Rate` | The price in £ (note: file uses non-UTF-8 character `\xA3` for the £ sign) |
| `Long Description` | Full specification — what's included in the rate |

## NHF Trade Codes

Two-letter codes that indicate which trade does the work. Examples seen in the file:

- `GR` — Groundworks
- `BR` — Brickwork / Bricklaying
- `RF` — Roofing
- `CA` — Carpentry
- `PL` — Plumbing
- `EL` — Electrical
- `DC` — Decorating
- `PT` — Plastering
- `FL` — Flooring
- `GL` — Glazing

(Full list visible by inspection of the unique values in column G of pricing.csv.)

## Units of Measure (UOM)

| UOM | Meaning |
|---|---|
| `LM` | Linear metre |
| `SM` | Square metre |
| `CM` | Cubic metre |
| `IT` | Item (single piece of work, e.g. one pothole) |
| `NO` | Number (single unit, e.g. one toilet, one door) |
| `HR` | Hour |

## Short Description format

Always reads as `COMPONENT:ACTION`. Examples:

- `KERB:LAY NEW 127X254MM PCC KERB`
- `WC SUITE:RENEW CLOSE COUPLED`
- `DOOR:RENEW EXTERNAL HARDWOOD PANELLED`
- `MOULD:FUNGICIDAL WASH`

This means QB2 should expect the **first word(s) before the colon to be the primary component**, and the words after the colon to be the action verb + spec.

## Action verbs and their meaning

- `LAY` / `SUPPLY AND LAY` — install new where nothing existed
- `RENEW` — remove existing and replace with new (the default for damaged items)
- `REBED` — lift, clean, and re-lay an existing item (cheaper than RENEW)
- `REPOINT` — fill / refresh joints
- `OVERHAUL` — repair an existing item without full replacement
- `EASE AND ADJUST` — minor adjustment (e.g. a sticking door)
- `EXTRA FOR` — add-on rate (e.g. non-slip finish on top of a base path rate)

## How Quotem uses this

The live app:

1. User describes work in plain English ("new front door")
2. `text-to-trade.js` translates slang → SOR terminology ("hardwood panelled door renew")
3. `pricing-lookup.js` runs a waterfall search → top 15 candidates
4. `sor-engine.js` calls Gemini with QS persona to pick ONE
5. `qc-gate.js` validates the picked price exists in the CSV (no fabrication)

The CSV itself gets ingested into Q's RAG library when you run `qwen-ingest.js`. Each row becomes a searchable chunk.

## What QB2 should never do

- **Never invent a SOR code.** Codes that don't exist in pricing.csv are fabrications — flag them.
- **Never invent a price.** Every £ figure must come from the `SOR Rate` column for a real code.
- **Never quote the long description back to the customer verbatim** — it's specification language, not customer-facing text.

## Element taxonomy (top level)

The pricing.csv covers (sample of `Element` values):

- Groundworks (paths, kerbs, drainage, edging, fencing)
- Brickwork / Blockwork (walls, repairs, repointing)
- Roofing (tiles, slates, felt, lead flashing, fascia/soffit)
- External Doors / Windows
- Internal Walls / Ceilings (plasterboard, plaster, skim)
- Joinery (skirting, architrave, doors, frames)
- Plumbing (sanitaryware, taps, pipework, hot/cold)
- Heating (radiators, boilers, controls)
- Electrical (sockets, lighting, consumer units, smoke alarms)
- Decoration (paint, paper, prep)
- Floor Finishes (tiles, vinyl, carpet, laminate)
- Damp / Mould treatment
- Kitchens (units, worktops, sinks)
- Bathrooms (suites, showers, tiling)
- External works / Garden (sheds, gates, paving)

(For exhaustive list, the live app reads pricing.csv directly. Don't try to maintain a parallel taxonomy.)
