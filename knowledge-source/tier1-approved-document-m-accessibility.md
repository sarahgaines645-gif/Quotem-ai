# Approved Document M — Access to and use of buildings

> **Primary source:** [gov.uk/government/publications/access-to-and-use-of-buildings-approved-document-m](https://www.gov.uk/government/publications/access-to-and-use-of-buildings-approved-document-m)
> **Building Regulations basis:** Part M, Schedule 1 of the Building Regulations 2010
> **Last verified:** 2026-04-26 (gov.uk page last updated 1 October 2024)

## Volumes

The Approved Document M comes in two volumes:

- **Volume 1: Dwellings** — 2015 edition with 2016 amendments. Effective date: **1 March 2016**.
- **Volume 2: Buildings other than dwellings** — 2015 edition with 2024 amendments. Effective date: **1 October 2015**, latest amendment effective **1 October 2024**.

A separate "May 2024 amendments to Approved Document M" booklet was published addressing buildings other than dwellings.

## The three categories — Volume 1 (Dwellings)

These are the heart of Part M for new dwellings. Quoted definitions from the gov.uk landing page:

| Optional Requirement | Category | Title |
|---|---|---|
| **M4(1)** | Category 1 | **Visitable dwellings** |
| **M4(2)** | Category 2 | **Accessible and adaptable dwellings** |
| **M4(3)** | Category 3 | **Wheelchair user dwellings** |

> "Categories 2 and 3 apply only where required by planning permission."

This is the critical rule: **M4(1) is the baseline minimum** for all new dwellings in England. M4(2) and M4(3) are **optional uplifts that local planning authorities can require** through their Local Plan or planning conditions on a specific permission.

## What each category means (high level)

### M4(1) — Visitable dwellings (baseline)

A dwelling that **a wide range of people can visit and use the principal entrance and a WC**. Practical implications include:
- Step-free access from the boundary to the principal entrance (where reasonably practicable)
- A level threshold at the principal entrance
- Adequate clear width to internal doors on the entrance storey
- A WC on the entrance storey

### M4(2) — Accessible and adaptable dwellings (uplift)

Designed so that occupants can **continue to live in the home as their needs change** (e.g. age, mobility decline). Beyond M4(1), this requires:
- More generous circulation spaces
- Provision for a future stairlift / through-floor lift in some configurations
- An accessible bathroom on the entrance storey
- Reinforced wall fixings for future grab rails

This category is designed to **align broadly with the Lifetime Homes Standard** (16 design criteria, originally published by Habinteg / Joseph Rowntree Foundation).

### M4(3) — Wheelchair user dwellings (top tier)

A dwelling **wheelchair-accessible from arrival to use of every space**, with circulation, kitchens, bathrooms, and turning spaces all designed for wheelchair use. Two sub-categories exist:

- **M4(3)(2)(a) — Wheelchair adaptable** — readily adaptable for a wheelchair user
- **M4(3)(2)(b) — Wheelchair accessible** — fully fitted out for a wheelchair user from completion

This category aligns broadly with **Habinteg's Wheelchair Accessible Standard**.

## Volume 2 — Buildings other than dwellings

Covers offices, shops, schools, hotels, public buildings. Sections include:
- Approach to the building
- Vehicle parking and setting-down points
- Access into the building
- Horizontal circulation
- Vertical circulation
- Sanitary accommodation
- Audience and spectator facilities

Detailed dimensions live in the PDF — `GAP-LIST.md` tracks downloading and converting.

## Disability Facilities Grant (DFG) link

Adaptations funded under the **Disability Facilities Grant** (Housing Grants, Construction and Regeneration Act 1996) are designed to bring an existing dwelling up to a level of accessibility appropriate to the occupant's disability — often borrowing from M4(2) and M4(3) requirements. The Quotem `disability-adaptations.js` plugin uses this framework. DFG limits (current as of catalogue date):

- **England: £30,000** (max grant per applicant)
- **Wales: £36,000**
- **Children: not means-tested**

(Source: Quotem `server/templates/TEMPLATE_CATALOGUE.md` and Housing Grants, Construction and Regeneration Act 1996.)

## Cross-references

- **Habinteg Lifetime Homes Standard** — see `tier1-habinteg-and-lifetime-homes.md`
- **BS 8300:2018-1 / 8300-2** — British Standard for designing accessible environments (referenced in AD M Volume 2)
- **Equality Act 2010** — duty on service providers to make reasonable adjustments, distinct from Building Regs but often cited together

## What QB2 should never do

- Don't claim a dwelling is "M4(2) compliant" without evidence of the planning permission requiring it.
- Don't quote dimensions (door widths, corridor widths, turning circles) from memory — refer to the PDF.
- Don't conflate M4(2) with full wheelchair accessibility — that's M4(3).
