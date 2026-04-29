# Right to Rent — Landlord Immigration Checks (England)

> **Primary source:** [gov.uk/check-tenant-right-to-rent-documents](https://www.gov.uk/check-tenant-right-to-rent-documents)
> **Statutory basis:** Immigration Act 2014, Part 3, Chapter 1 (England only)
> **Last verified:** 2026-04-26

## Who you must check

Verbatim from gov.uk:

> "Before the start of a new tenancy, you must check all tenants aged 18 and over, even if:
> - they're not named on the tenancy agreement
> - there's no tenancy agreement
> - the tenancy agreement is not in writing"

> "It's against the law to only check people you think are not British citizens."

**Key rule:** every adult occupier paying to use the property as their main home must be checked, regardless of whether they appear on the contract. Discrimination by appearance/accent/nationality is itself an offence.

## What the check proves

The check confirms the tenant has either:

- a **permanent right to rent** (British/Irish citizens, those with indefinite leave, EUSS settled status, etc.) — proven by **List A** documents
- a **time-limited right to rent** (those with limited leave, work visas, EUSS pre-settled status, etc.) — proven by **List B** documents (these tenants must be re-checked when their permission expires)

## The check procedure (high level)

The Home Office calls this a **"three-step check"**, evolving to four steps where digital identity is used. Three established methods are accepted:

1. **Manual document check** — physical copy + face-to-face / video verification
2. **Identity Service Provider (IDSP) check** — for British/Irish citizens using a certified IDSP
3. **Home Office online check** — using a tenant-supplied **share code** at gov.uk/check-tenant-right-to-rent

For each method the duty is to:

1. **Obtain** the original document(s) or share code
2. **Check** they are valid in the tenant's presence (in person or via live video)
3. **Copy** the relevant pages and date the copy
4. **Retain** the copy for the duration of the tenancy and for 1 year after it ends

## Penalties — VERIFY BEFORE QUOTING

Civil penalty levels were significantly increased on **13 February 2024** under the Immigration (Restrictions on Employment and Residential Accommodation) (Maximum Amounts of Penalties) (Amendment) Order 2023.

> **GAP:** Exact post-Feb-2024 figures could not be quoted directly from the gov.uk landing page during the fetch. Last published Home Office figures (pre-2024) were £1,000 / £3,000 lodger and £3,000 / £20,000 occupier (first / repeat). The Feb 2024 increase tripled these. **Brian/Sarah: download the current Home Office Code of Practice on Civil Penalties (PDF) from gov.uk and paste the verified penalty amounts here.** See `GAP-LIST.md`.

A **criminal offence** with up to 5 years' imprisonment exists for landlords who knew or had reasonable cause to believe the occupier had no right to rent (Immigration Act 2014, sections 33A and 33B).

## When checks must be repeated

For tenants with **time-limited right to rent**, a **follow-up check** is required:

- before their permission expires, OR
- 12 months after the initial check, whichever is later

If the follow-up shows the tenant has lost the right to rent, the landlord must report it to the Home Office to maintain a "statutory excuse" against penalty.

## Where Quotem can help

The live app has a Right to Rent tool at `/right-to-rent` (shipped commit `0d1dc2d`):

- Test-code dropdown for trial runs
- Right to Rent / Right to Work / Immigration tabs
- Full result card with GOV.UK reference + photo + PDF output

QB2 should answer "how do I do a right to rent check?" by:

1. Pointing to the gov.uk check service
2. Explaining the three accepted methods
3. Reminding them to keep the copy for the whole tenancy + 1 year
4. Flagging that discrimination by appearance is illegal

## Authoritative documents to download (PDF — must be converted to text first to ingest)

- **Right to rent: a guide to immigration documents for tenants and landlords** — published by Home Office, gov.uk landing page: https://www.gov.uk/government/publications/right-to-rent-document-checks-a-user-guide
- **Code of Practice on civil penalties** — gov.uk Home Office collection
- **Code of Practice for landlords: avoiding discrimination** — gov.uk Home Office

These contain the **full List A and List B document tables** plus the current penalty schedule. They couldn't be free-quoted via web fetch (PDF binaries) and must be downloaded, converted to text, and added to this folder. Tracked in `GAP-LIST.md`.
