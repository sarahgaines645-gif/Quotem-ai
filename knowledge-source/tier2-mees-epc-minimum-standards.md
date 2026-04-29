# MEES — Minimum Energy Efficiency Standards (Domestic PRS)

> **Primary source:** [gov.uk/guidance/domestic-private-rented-property-minimum-energy-efficiency-standard-landlord-guidance](https://www.gov.uk/guidance/domestic-private-rented-property-minimum-energy-efficiency-standard-landlord-guidance)
> **Statutory basis:** Energy Efficiency (Private Rented Property) (England and Wales) Regulations 2015 (SI 2015/962), as amended
> **Last verified:** 2026-04-26 (gov.uk page last updated 20 August 2025)

## What MEES is

The Minimum Energy Efficiency Standard makes it **unlawful for a landlord to let a domestic private rented property** below a specified Energy Performance Certificate (EPC) rating, unless a valid exemption is registered.

## Current minimum: EPC E

> "Since 1 April 2020, landlords can no longer let or continue to let properties covered by the MEES Regulations if they have an EPC rating below E, unless they have a valid exemption in place."

— gov.uk

## Timeline

| Date | What changed |
|---|---|
| **1 April 2018** | MEES applied to **new tenancies and renewals** of existing tenancies |
| **1 April 2020** | MEES extended to **all relevant properties**, even where there has been no change in tenancy |

## Cost cap

> "The cost cap: you will never be required to spend more than £3,500 (including VAT) on energy efficiency improvements."

This is the **statutory maximum** — if all measures available within £3,500 don't get the property to EPC E, the landlord can register the **All Improvements Made** exemption.

## Exemptions (full list — 6 types)

Each exemption is registered on the **PRS Exemptions Register** with property address, exemption type, and a valid EPC.

| Exemption | Duration |
|---|---|
| All relevant improvements made | 5 years |
| High cost (estimated cost above £3,500 cap) | 5 years |
| Wall insulation concerns (technical objection) | 5 years |
| Third-party consent refusal (lender, freeholder, tenant) | 5 years (or until tenancy ends) |
| Property devaluation (5%+ devaluation expected) | 5 years |
| Recently became a landlord (new circumstance) | 6 months |

## Penalties for non-compliance

Maximum penalties **per property per breach**:

| Breach | Maximum penalty |
|---|---|
| Renting non-compliant property < 3 months | £2,000 |
| Renting non-compliant property 3+ months | £4,000 |
| False or misleading exemption registration | £1,000 |
| Failure to comply with a compliance notice | £2,000 |
| **Overall cap per property** | **£5,000** |

Local authorities (LAs) enforce. Penalty notices may be combined with publication on the public Exemptions Register.

## Future direction (proposed, not yet law)

> "Government has committed to look at a long-term trajectory to improve the energy performance standards of privately rented homes in England and Wales, with the aim for as many of them as possible to be upgraded to EPC Band C or equivalent by 2030."

— gov.uk (last verified 2026-04-26)

There is **no law in force** at the date of this verification raising the minimum to EPC C. Various consultations have proposed it; no statutory instrument has yet been laid. Verify against gov.uk before quoting "EPC C from 2028" or similar.

## Where this connects to Quotem's work

The Quotem **EPC** signup is in `MEMORY.md` ("EPC + Companies House (free, 5min) still to sign up") — once active, the landlord-finance.js plugin can read EPC data into the Property File.

For a survey or quote on a sub-EPC-E property, QB2 should:

1. Check the property's current EPC rating (via gov.uk register or property-intelligence.js)
2. Identify which improvements would lift the rating to E or better
3. Estimate cost against the £3,500 cap
4. If exceeds cap, prompt the landlord to register the **High Cost** exemption with evidence

Common improvements with high SAP/RdSAP impact:
- Loft insulation top-up to 270mm
- Cavity wall insulation (where suitable)
- LED lighting throughout
- Hot water cylinder insulation jacket
- Boiler replacement to A-rated
- Solar PV (significant impact, often above £3,500 alone)

## Cross-references

- **EPC regs (production of EPCs):** Energy Performance of Buildings (England and Wales) Regulations 2012 (SI 2012/3118)
- **Domestic Renewable Heat Incentive (now closed):** ECO4 / Boiler Upgrade Scheme are current funding routes
- **Approved Document L:** Building Regs side — see `tier1-approved-document-l-energy.md`

## What QB2 should never do

- **Never advise a landlord they "can let it for now and sort the EPC later"** — letting below E is unlawful.
- **Never** quote the £3,500 cap as a target — it's a maximum statutory spend, not a budget.
- **Never** confirm an exemption applies without seeing the registration — it must be on the public register to be valid.
- **Never** quote a future EPC C deadline as if it were law — it's a policy aspiration as of 2026-04-26.

## Practical for QB2 to surface

A property at EPC F or G is **already non-compliant** as of 1 April 2020 unless exempted. If a landlord asks for a quote on a sub-E property without a registered exemption, that's a **live legal risk** — flag it before scope, not after.
