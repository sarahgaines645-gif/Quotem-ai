# Section 21 and Section 8 Eviction Notices (England)

> **Primary source:** [gov.uk/evicting-tenants/section-21-and-section-8-notices](https://www.gov.uk/evicting-tenants/section-21-and-section-8-notices)
> **Statutory basis:** Housing Act 1988, sections 8 and 21 — substantially amended by the **Renters' Rights Act 2025**
> **Last verified:** 2026-04-26

## ⚠ The big change

The gov.uk eviction guidance flags:

> "The rules about private renting are changing on 1 May 2026"

The **Renters' Rights Act 2025** abolishes Section 21 of the Housing Act 1988 (no-fault eviction) and restructures Section 8 grounds. Until commencement, the existing rules below still apply. After commencement, all evictions must use Section 8 with a specified ground. See `tier1-renters-rights-act-2025.md`.

## Section 21 (no-fault eviction) — pre-1 May 2026

### When it can be used

> "after a fixed term tenancy ends — if there's a written contract"
> "during a tenancy with no fixed end date — known as a 'periodic' tenancy"

Applies to **assured shorthold tenancies (ASTs)** only.

### Notice period

> "at least 2 months' notice to leave your property"

Or longer if the tenancy is a contractual periodic with rental periods exceeding 2 months.

### Prerequisites — landlord MUST satisfy all of these or the s21 is invalid

A Section 21 notice is invalid if any of the following apply:

| Prerequisite | Detail |
|---|---|
| **Within first 4 months of tenancy** | Cannot serve unless the contract permits it. |
| **Unlicensed HMO** | Cannot serve if the property is an HMO that should be licensed but isn't. |
| **Deposit not protected** | "the tenancy started after April 2007 and you have not put the tenants' deposit in a deposit protection scheme" |
| **Improvement notice from council** | "the council has served an improvement notice on the property in the last 6 months" |
| **Emergency works notice from council** | Same 6-month bar applies |
| **Unrepaid unlawful fees** | "you haven't repaid any unlawful fees or deposits that you charged the tenant" |
| **EPC not provided** | Must have given a copy of the property's Energy Performance Certificate |
| **Gas safety not provided** | Must have given a current gas safety certificate (if gas is installed) |
| **How to Rent guide not provided** | Must have given the most recent edition of "How to Rent: the checklist for renting in England" |

The retaliatory eviction provisions in the **Deregulation Act 2015, s.33** also apply: if the tenant has complained in writing about disrepair and the landlord has failed to respond adequately within 14 days, a Section 21 served within 6 months can be invalid.

### Form 6A
The notice must be on the prescribed **Form 6A** — using the wrong form invalidates the notice.

## Section 8 (eviction with grounds) — applies before AND after 1 May 2026

### Notice period

> "between 2 weeks' and 2 months' notice depending on which terms they have broken"

(Specific notice periods vary by ground — see below.)

### Grounds for possession (Schedule 2, Housing Act 1988)

Grounds are **mandatory** (court must grant possession if proven) or **discretionary** (court may grant if reasonable).

> **GAP — full quoted text not in this file.** The complete Schedule 2 grounds run to several pages. Brian/Sarah: download Schedule 2 of the Housing Act 1988 (as amended by Renters' Rights Act 2025) from legislation.gov.uk and convert to text for full ingest. Tracked in `GAP-LIST.md`.

### Mandatory grounds (court MUST grant)

| Ground | Subject | Notice |
|---|---|---|
| **Ground 1** | Landlord previously occupied / wishes to move back in (notice required at start) | 2 months |
| **Ground 1A** | Landlord wishes to sell (post-RRA 2025; cannot use in first 12 months) | 4 months (post-RRA) |
| **Ground 2** | Mortgage lender repossession | 2 months |
| **Ground 6A** | Compliance with planning/enforcement (post-RRA) | varies |
| **Ground 7A** | Serious anti-social behaviour | 2 weeks–1 month |
| **Ground 8** | Serious rent arrears (currently 2 months+; see RRA changes) | 2 weeks |
| **Ground 14A** | Domestic violence (where landlord is a registered social landlord) | 2 weeks |

### Discretionary grounds (court MAY grant if reasonable)

| Ground | Subject | Notice |
|---|---|---|
| **Ground 9** | Suitable alternative accommodation available | 2 months |
| **Ground 10** | Some rent arrears (less than Ground 8 threshold) | 2 weeks |
| **Ground 11** | Persistent late payment of rent | 2 weeks |
| **Ground 12** | Breach of any other term of the tenancy | 2 weeks |
| **Ground 13** | Waste / neglect / damage to the property | 2 weeks |
| **Ground 14** | Anti-social behaviour | Immediate / 2 weeks |
| **Ground 15** | Damage to furniture provided | 2 weeks |
| **Ground 17** | Tenancy obtained by false statement | 2 weeks |

### What changes with the Renters' Rights Act 2025

After commencement (currently **1 May 2026** for the main private renting reforms):

- **Section 21 (no-fault) abolished entirely**
- **All possession claims must use Section 8** with a specified ground
- **New section 8(4AA)** sets notice periods of **2 weeks to 4 months** depending on ground
- **Ground 1A** (landlord wishes to sell) added — but cannot be used in the first **12 months** of a tenancy
- **Ground 6B** becomes actionable (some agricultural-succession exceptions)
- Compensation may be awarded under new **section 11A** if a landlord re-lets within a "restricted period" after using Ground 1 or 1A

(See `tier1-renters-rights-act-2025.md` for the verbatim Act references.)

## Form 3
Section 8 notices must be served on the prescribed **Form 3** (or its post-RRA replacement).

## Court process — high level

1. Landlord serves the notice (Form 6A or Form 3)
2. Notice period expires
3. If tenant hasn't left, landlord applies to the County Court for a possession order
4. Court grants Possession Order (or refuses if grounds aren't proven / notice is invalid)
5. If tenant still doesn't leave, landlord applies for a **Warrant of Possession** and the County Court bailiffs evict
6. Landlords can, in some cases, apply for a **High Court enforcement officer** transfer for faster eviction (with court permission)

The whole process typically takes **3–6 months** in 2026 court conditions.

## Where Quotem can help

The `contract-writer.js` plugin in `server/templates/` includes:

- **Section 8 notice generation** — `generateContract('section_8_notice', data)`
- Built-in grounds 1, 1A, 2, 7, 8, 10, 11, 12, 14, 14A
- Smart trigger: on **3rd missed rent payment** an eviction-warning popup appears with relevant Section 8 grounds

QB2 should:

1. **Always** remind landlords of the **prerequisite checklist** before issuing s21 (deposit, EPC, gas safety, How to Rent)
2. **Always** check whether the landlord has the right grounds for s8, and quote the correct notice period
3. **Refer to a solicitor for retaliatory-eviction or anti-social-behaviour cases** — these are highly fact-specific

## What QB2 should never do

- **Never** suggest a Section 21 can be served on a tenant whose deposit isn't protected. Period.
- **Never** quote a notice period from memory without verifying against current legislation.gov.uk.
- **Never** advise a landlord to physically remove a tenant or change locks. That is **unlawful eviction** under the Protection from Eviction Act 1977 (criminal offence).
- **Never** skip the "reasonable" hurdle on a discretionary ground — the court can refuse possession even if the ground is technically proven.
