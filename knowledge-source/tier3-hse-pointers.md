# HSE — Quick Reference Pointers (Gas, Asbestos, CDM, Part P)

> **Status:** Pointer doc — verbatim text not free-quotable from HSE landing pages during fetch attempts.
> **Last verified:** 2026-04-26

This file is a **pointer to where the authoritative content lives** so QB2 can route users to the right HSE / gov.uk pages, plus the high-level facts that ARE verifiable from the HSE site overview.

## Gas Safety (landlords)

> **Primary source:** [hse.gov.uk/gas/landlords](https://www.hse.gov.uk/gas/landlords/index.htm)
> **Statutory basis:** Gas Safety (Installation and Use) Regulations 1998 (SI 1998/2451), reg 36 (landlord duties)

### Three landlord duties (high level)

1. **Maintain** gas pipework, appliances, and flues so they're safe to use
2. **Annually check** all gas appliances and flues by a **Gas Safe registered engineer** (12-month cycle)
3. **Keep records** for 2 years and provide a Landlord Gas Safety Record (LGSR / "CP12") to:
   - **Existing tenants** within **28 days** of the check
   - **New tenants** before move-in

### The 10-12 month service-due window

Since 2018 amendments, the annual check can be carried out **up to 2 months early** without resetting the anniversary date — so check at month 10–12 from the last check, and the next deadline still falls 12 months from the **original** last-check date.

### Who is allowed to do the work

Only a **Gas Safe registered engineer** with the right competence categories (e.g. cooker, boiler, fire) for the appliance(s) being checked. Verify on the Gas Safe Register: https://www.gassaferegister.co.uk

### Quotem product link
The Quotem **certificate-generator.js** plugin includes **CP12** (Gas Safety Record) — usable by landlords once the engineer has completed the check.

> **GAP:** Verbatim quotes of the Gas Safety Regulations couldn't be extracted from the HSE landing page during fetch. Brian/Sarah: download HSE's "Landlords: Gas Safety" guidance PDF and convert to text if you want full QB2 ingest. Tracked in `GAP-LIST.md`.

## Asbestos

> **Primary source:** [hse.gov.uk/asbestos](https://www.hse.gov.uk/asbestos/index.htm)
> **Statutory basis:** Control of Asbestos Regulations 2012 (SI 2012/632)

### Key principles

1. **Duty to manage** (regulation 4) — applies to non-domestic premises and the **common parts of residential buildings** (e.g. communal staircases, lift shafts, plant rooms — not inside flats themselves)
2. **Three survey types:**
   - **Management Survey** — for ongoing occupation; minimal disturbance
   - **Refurbishment & Demolition (R&D) Survey** — destructive; before any major works
   - **(Also Re-inspection)** — periodic check on previously identified ACMs
3. **Three categories of work:**
   - **Licensed Work** — most riskier work (sprayed coatings, lagging, AIB) — requires HSE-licensed contractor
   - **Notifiable Non-Licensed Work (NNLW)** — short-duration / lower-risk asbestos work that still needs notification
   - **Non-Licensed Work (NLW)** — minor, low-risk (e.g. removing intact ACM with appropriate PPE / RPE)

### Duty of care

Anyone removing asbestos must:
- Use a **competent contractor**
- Dispose at a **licensed waste site**
- Provide an **air clearance certificate** for licensed work
- **Notify HSE** at least 14 days in advance for licensed work

### Quotem product link
Quotem's **image-analysis.js** flags suspected ACMs in survey photos (Survey Prompt V6 includes asbestos awareness). QB2 should always recommend a **professional asbestos survey** before specifying any disturbance work in pre-2000 buildings.

> **GAP:** Verbatim regulation text not extracted. Brian/Sarah: HSE's "ACoP L143: Managing and working with asbestos" is the Approved Code of Practice — download from HSE Books and convert if needed.

## CDM 2015 — Construction (Design and Management) Regulations

> **Primary source:** [hse.gov.uk/construction/cdm/2015](https://www.hse.gov.uk/construction/cdm/2015/)
> **Statutory basis:** Construction (Design and Management) Regulations 2015 (SI 2015/51)

### When CDM applies

**CDM 2015 applies to all construction projects in Great Britain.** It's not just for big jobs — even small domestic refurbs are covered, although duties are reduced for **domestic clients**.

### Five duty-holders

| Role | Who | Key duty |
|---|---|---|
| **Client** | The person/organisation paying for the work | Make suitable arrangements; check competence |
| **Principal Designer** | Coordinates pre-construction H&S | Identify, eliminate, control risks at design stage |
| **Designer** | Anyone whose work prepares for construction | Avoid foreseeable risks |
| **Principal Contractor** | Coordinates construction-phase H&S | Plan, manage, monitor |
| **Contractor** | Anyone carrying out construction work | Plan their part safely |
| **Workers** | (also have duties) | Look after own and others' safety |

### Notifiable projects

A project is **notifiable** to HSE if:
- Construction work lasts **more than 30 working days** AND has **more than 20 workers** working simultaneously, OR
- Exceeds **500 person days** of work

Notification uses **Form F10**.

### Health & Safety File

Required at the end of any project with more than one contractor. Held by the client. Contains information needed to manage health and safety in any future construction work or maintenance.

### Quotem product link
The **form-filler.js** plugin offers **Risk Assessment** and **Method Statement** templates — useful for Contractors / Principal Contractors meeting CDM 2015 obligations.

> **GAP:** Full L153 ACoP text not extracted. Brian/Sarah: HSE's L153 "Managing health and safety in construction" is the Approved Code of Practice — order from HSE Books.

## Part P (electrical work in dwellings)

> **Primary source:** [gov.uk/government/publications/electrical-safety-approved-document-p](https://www.gov.uk/government/publications/electrical-safety-approved-document-p)
> **Building Regulations basis:** Part P, Schedule 1 of the Building Regulations 2010

### Scope

Part P sets requirements for electrical safety in dwellings. **Notifiable work** must be either:
- Done by a **registered competent person** (NICEIC, NAPIT, ELECSA, etc.) who self-certifies, OR
- Notified to **Building Control** before work starts and signed off afterwards

### What is notifiable

Notifiable installations (post-2013 simplification):
- **New circuits** in any location
- Work in special locations (bathrooms — defined zones, swimming pools, saunas)

(Replacing a like-for-like socket or light fitting is **not** notifiable — but must still meet BS 7671.)

### BS 7671 — IET Wiring Regulations (18th edition + amendments)

The technical standard for safe electrical installation in the UK. All Part P work must comply with the current edition of BS 7671. **Amendment 3** (2024) is the current amendment.

### Quotem product link
The **electrical-calculator.js** plugin generates a Part P / BS 7671 compliant electrical schedule from room type + area. Output references BS 7671, Part P, Part F, Part L, BS 5839-6.

The **certificate-generator.js** plugin includes **EIC** (Electrical Installation Certificate), **EICR** (Electrical Installation Condition Report), **MWC** (Minor Works Certificate), and **PAT** (Portable Appliance Testing).

## How QB2 should use these

For any user question that touches on:
- **"Can I do this myself?"** — flag CDM duties, Part P notifiability, Gas Safe Register requirements as applicable
- **"Is this asbestos?"** — refuse to confirm from a photo; recommend a **competent person survey** for any pre-2000 building
- **"Who has to do the gas check?"** — Gas Safe registered engineer, annually, 28 days to give the cert to the tenant
- **"Is my project CDM notifiable?"** — apply the 30-days-and-20-workers OR 500-person-days test

## What QB2 should never do

- **Never** advise a domestic client to act as their own Principal Contractor on a project they're not competent to manage
- **Never** suggest skipping the CP12 because "the appliance is new" — the duty is annual regardless of appliance age
- **Never** confirm asbestos identification from photo alone — sample analysis by an accredited lab is required
- **Never** quote a Part P self-certification path for a contractor who isn't registered with a Competent Person Scheme
