# Habinteg, Lifetime Homes Standard, Wheelchair Housing Design Guide

> **Primary publisher:** Habinteg Housing Association — [habinteg.org.uk](https://www.habinteg.org.uk)
> **Last verified:** 2026-04-26

## What Habinteg is

Habinteg Housing Association has been the **lead UK author** of accessible-housing design standards since the 1970s. Two of their publications are the most-cited residential accessibility benchmarks in the UK:

1. **Lifetime Homes Standard** (16 design criteria, originally published 1991, revised July 2010)
2. **Wheelchair Housing Design Guide** (currently in its 3rd edition)

Both feed directly into the Building Regulations Approved Document M categories — see `tier1-approved-document-m-accessibility.md`:

| Habinteg standard | Aligns with |
|---|---|
| Lifetime Homes Standard | M4(2) — Accessible and adaptable dwellings |
| Wheelchair Housing Design Guide | M4(3) — Wheelchair user dwellings |

## Lifetime Homes Standard — 16 design criteria (overview)

> **GAP — verbatim list not yet ingested.** The Lifetime Homes website (lifetimehomes.org.uk) was unreachable during the WebFetch attempt and the Habinteg page (habinteg.org.uk/lifetime-homes-design-guide/) returned a 404 on the WebFetch's secondary call. To get all 16 criteria into QB2's brain with verbatim accuracy, Brian/Sarah should:
>
> 1. Download the **Lifetime Homes Design Guide (EP 100)** PDF from BRE Bookshop or the Habinteg site
> 2. Convert PDF → text
> 3. Save in this folder as `tier1-habinteg-lifetime-homes-16-criteria-FULL.txt`
> 4. Re-run `qwen-ingest.js`

**The 16 criteria cover the following themes** (verified from authoritative summaries — exact wording must be drawn from the official PDF):

1. Parking — width and proximity for wheelchair user
2. Approach to the dwelling — gradient and surface
3. Approach to all entrances — level / step-free
4. Entrances — door width and threshold
5. Communal stairs and lifts (where applicable)
6. Internal doorways and hallways — clear widths
7. Circulation space — turning provision
8. Entrance-level living space
9. Potential for entrance-level bed-space
10. Entrance-level WC and shower drainage
11. WC and bathroom walls — reinforced for grab rails
12. Stair design — for future stairlift
13. Through-floor lift potential — identified location
14. Tracking hoist potential — bedroom-to-bathroom route
15. Bathroom layout — wheelchair access
16. Window glazing and handle heights — reachable seated

(The numbering and exact thematic ordering may differ from the official guide — verify against the PDF before use in any project.)

## Wheelchair Housing Design Guide

Habinteg's **Wheelchair Housing Design Guide (3rd edition)** is the basis for M4(3) wheelchair user dwellings — fully wheelchair-accessible homes. Key requirements include:

- Step-free access from the boundary throughout
- Wheelchair turning circles in every key space (bedroom, bathroom, kitchen, living)
- Sufficient clear width for wheelchairs to pass at corridors and doorways
- Adapted kitchen with knee-clear under-counter space, accessible appliance heights
- Accessible bathroom with level-access shower, grab rail provision, accessible WC
- Provision for ceiling track hoist routes (in the Wheelchair Accessible variant)

> **GAP — full verbatim text not ingested.** Same as the Lifetime Homes guide above. Brian/Sarah: order the PDF from Habinteg's bookshop, convert to text, save as `tier1-habinteg-wheelchair-housing-design-guide-FULL.txt`.

## How this connects to Quotem's work

The `disability-adaptations.js` plugin in `server/templates/` calculates DFG-eligible adaptations driven by:

- **Disability type** (8 categories: wheelchair, mobility_impaired, deaf, blind, dementia, upper_limb, neurological, children)
- **House specification** (property type, floors, stairs, tenure)

Output references back to:
- **Housing Grants Construction & Regeneration Act 1996** (statutory basis for DFG)
- **BS 8300:2018** (designing accessible environments)
- **Approved Document M** (Building Regs)
- **Equality Act 2010** (reasonable adjustments duty)
- **Care Act 2014** (local authority assessment duties)

## What QB2 should know to be useful

When a landlord or surveyor describes an accessible-adaptation problem, QB2 should:

1. **Identify the dwelling's current category** — most existing housing is M4(1) or sub-M4(1)
2. **Identify the occupant's needs** — temporary mobility issue, permanent wheelchair user, dementia, sensory impairment
3. **Map needs to specific adaptations** — many minor adaptations don't need DFG and can be done quickly:
   - Grab rails — usually < £200 fitted
   - Lever taps — < £100 each
   - Half-step at threshold — < £400
   - Stair rail (second handrail) — < £300
4. **Major adaptations** typically require DFG application and a council Occupational Therapy assessment:
   - Level-access shower
   - Stairlift
   - Through-floor lift
   - Ramped access
   - Door widening
   - Wheelchair extension

## What QB2 should never do

- **Never claim a dwelling meets Lifetime Homes** without seeing the design specification or built evidence — it's a 16-point standard, not a single tick-box.
- **Never quote DFG eligibility for someone without an OT assessment** — eligibility is determined by the council, not by the landlord/surveyor.
- **Never confuse Habinteg's Lifetime Homes (M4(2) alignment)** with **Habinteg's Wheelchair Housing Design Guide (M4(3) alignment)** — they're different standards for different needs.

## Authoritative sources to reference

- **Habinteg main site:** https://www.habinteg.org.uk
- **Habinteg Wheelchair Housing Design Guide 3rd edition:** order via Habinteg or RIBA Bookshop
- **Lifetime Homes Design Guide (EP 100):** BRE Bookshop / Habinteg
- **Approved Document M, Volume 1:** [gov.uk](https://www.gov.uk/government/publications/access-to-and-use-of-buildings-approved-document-m)
- **BS 8300-1 / BS 8300-2:2018** — British Standards Institution
