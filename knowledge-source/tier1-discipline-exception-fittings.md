# Discipline — Exception Fittings: Items That Are Never a Default

> **Rule:** Some items are exception fittings — they only appear when a specific site condition or occupant need justifies them. They are never a default; the trigger condition must be confirmed before the item is specified, priced or installed.
> **Audience:** specifiers, surveyors, contractors, building-control officers, occupational therapists, council DFG teams, MCS-certified renewables installers, landlords commissioning works.
> **Last verified:** 2026-04-26

## The exception fittings

| Item | Trigger condition | First diagnostic question |
|---|---|---|
| **Macerator (small lifting plant)** | Below-gravity-drainage WC / basin only | "Is gravity drainage available?" |
| **Stairlift** | Occupant-specific, usually DFG-funded | "Is this a DFG referral with an OT assessment?" |
| **Ground-source heat pump** | Site has space + ground-loop survey | "Has a ground-loop survey been done?" |
| **PV solar** | Roof orientation / unshaded / electrical headroom | "What's the roof orientation, pitch, unshaded area, and CU headroom?" |
| **Wind turbine** | Negligible domestic deployment | "Is there a wind-resource study and planning consent?" |
| **Waste chute** | High-rise blocks only | "What's the building height and storey count?" |

## Why each is an exception

### Macerator

UK domestic drainage is **gravity-first** under **Approved Document H**. Sanitary pipework should fall to a gravity discharge wherever practicable. Lifting plant (macerator/pump) is for situations where gravity is impossible — a basement WC, a converted outbuilding, a pumped en-suite below the soil-stack invert.

- **Standard:** **BS EN 12050-3** — Lifting plants for limited applications, for wastewater containing faecal matter.
  Source: https://knowledge.bsigroup.com/products/lifting-plants-for-wastewater-containing-faecal-matter-for-limited-applications
- **Approved Document H:** https://www.gov.uk/government/publications/drainage-and-waste-disposal-approved-document-h

### Stairlift

A stairlift is a **personal mobility aid**, not a building component. Specification depends on:

- **Curve vs straight stair**
- **User weight and mobility profile**
- **Funding route** — most commonly a **Disabled Facilities Grant (DFG)** assessed by the local-authority Occupational Therapist
  Source: https://www.gov.uk/disabled-facilities-grants

Product standards include **BS EN 81-40** (stairlifts and inclined platforms for persons with impaired mobility): https://knowledge.bsigroup.com/products/safety-rules-for-the-construction-and-installation-of-lifts-special-lifts-for-the-transport-of-persons-and-goods-stairlifts-and-inclined-lifting-platforms-intended-for-persons-with-impaired-mobility

There is no "default stairlift" — each install follows the OT recommendation and the user's profile.

### Ground-source heat pump (GSHP)

GSHP installation requires:

- **Ground-loop area** — a horizontal trench layout (significant garden area required) or vertical borehole(s) typically 50–150 m deep. Site-specific calculation, no generic figure.
- **MCS certification** — required for grant eligibility (Boiler Upgrade Scheme) and for the system to count as Permitted Development.
  Source (MCS): https://mcscertified.com/
  Source (Boiler Upgrade Scheme): https://www.gov.uk/apply-boiler-upgrade-scheme
- **Site survey** — ground thermal conductivity, planning constraints, fabric performance of the existing building (low flow temperatures need a thermally-efficient envelope).

Off-the-shelf default specs do not exist; each install is engineered.

### PV solar

PV sizing depends on:

- **Roof orientation** (south through south-west best in UK).
- **Pitch and shading.**
- **Roof area and structural capacity.**
- **Existing electrical load and consumer-unit headroom.**
- **MCS certification** — required for **Smart Export Guarantee** payments.
  Source (MCS): https://mcscertified.com/
  Source (Smart Export Guarantee, Ofgem): https://www.ofgem.gov.uk/environmental-and-social-schemes/smart-export-guarantee-seg

A "standard PV system" doesn't exist; kWp depends on the roof survey and the load.

### Wind turbine

Domestic wind turbines have negligible deployment in the UK. Practical constraints include planning consent, neighbour-boundary noise (controlled under planning conditions), wind-resource modelling, structural mounting and grid connection. Not a routine residential spec; treat as out of scope unless explicitly called for and supported by a wind-resource study.

### Waste chute

Used in **high-rise blocks** only — not a domestic default. Specification depends on building height, fire compartmentation of the chute (Approved Document B requirement), and refuse-room access. Out of scope for general-needs / low-rise work.

## Diagnostic questions before specifying

When a brief mentions any of the above, the first move is the trigger question, not a price or product:

- **Macerator** → "Is gravity drainage available, or is this an installation below the soil stack?"
- **Stairlift** → "Is this a DFG referral? Has an Occupational Therapist specified curve/straight and the user profile?"
- **GSHP** → "Has the site been surveyed for ground-loop capacity? Is the installer MCS-certified?"
- **PV solar** → "What's the roof orientation, pitch, unshaded area, and consumer-unit headroom?"
- **Wind turbine** → "Is there a wind-resource study and planning consent?"
- **Waste chute** → "What's the building height and storey count?"

If the answer doesn't establish the trigger, the item should not be specified at that point in the conversation.

## Common errors and red flags

- A macerator specified as a "standard WC option" — it's an exception fitting under ADH.
- A stairlift quoted from a description alone, with no DFG / OT route confirmed.
- GSHP, PV or wind specified without a site-specific survey.
- A waste chute included in a low-rise scope.
- MCS certification treated as optional on PV / heat-pump installs intended for grant funding or SEG payments — without MCS, the customer loses the funding/payment route.
- A PV system sized from roof footprint without checking consumer-unit headroom or shading.

## Cross-references

- `tier1-approved-document-m-accessibility.md` — accessibility category context for stairlifts
- `tier1-discipline-context-gates-tmv-doorentry.md` — sister discipline on use-class gates
- `tier1-discipline-la-specific-defaults.md` — items where the local authority sets the spec
