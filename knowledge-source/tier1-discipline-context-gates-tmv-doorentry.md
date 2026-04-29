# Discipline — Context Gates: TMV2 vs TMV3, Audio vs Video Door Entry

> **Rule:** Some defaults flip on the **use class** of the building. The occupant profile must be checked before specifying a thermostatic mixing valve or a door-entry system.
> **Audience:** specifiers, plumbers, electricians/security installers, surveyors, healthcare estates managers, sheltered/care-home managers, landlords commissioning works, environmental health officers.
> **Last verified:** 2026-04-26

## Why this discipline exists

A default that's right for general-needs housing is wrong for sheltered or care settings. Two cases come up most:

1. **Thermostatic Mixing Valves (TMV)** — TMV2 in domestic, TMV3 in sheltered/care/healthcare.
2. **Door entry** — Audio is the long-established baseline for general-needs blocks; video is justified when block size, accessibility need or risk profile requires it.

## TMV2 vs TMV3

### Scheme basis

TMV2 and TMV3 are **third-party performance schemes operated by BuildCert (NSF)** that test thermostatic mixing valves against scheme-specific requirements which reference the relevant BS EN standards.

- **BS EN 1111:2017** — Thermostatic mixing valves (PN 10) — general technical specification.
  Source: https://knowledge.bsigroup.com/products/sanitary-tapware-thermostatic-mixing-valves-pn-10-general-technical-specification
- **BS EN 1287:2017** — Low-pressure thermostatic mixing valves — general technical specification.
  Source: https://knowledge.bsigroup.com/products/sanitary-tapware-low-pressure-thermostatic-mixing-valves-general-technical-specification

The BuildCert TMV scheme documents are the source of the scheme-specific maximum mixed temperatures: https://www.buildcert.com/tmv-schemes/

### TMV2 — domestic baseline

- Applies to **general-needs domestic** dwellings.
- Recommended maximum mixed water outlet temperatures under the BuildCert TMV2 scheme:
  - **Bath fill:** 44 °C
  - **Basin (washbasin):** 41 °C
  - **Shower:** 41 °C
  - **Bidet:** 38 °C
- Tested for fail-safe shutdown if cold supply fails.

Source: https://www.buildcert.com/tmv-schemes/

### TMV3 — healthcare / care / sheltered

- Applies to **healthcare premises and any setting where users are at greater risk of scalding** (very young, very old, disabled, unconscious, or where the user cannot react quickly enough to dangerous water).
- Tighter tolerances on temperature stability, response and fail-safe than TMV2.
- Used in NHS and equivalent care settings; technical guidance is given in **HTM 04-01 (Safe water in healthcare premises)**.
  Source (HTM 04-01): https://www.england.nhs.uk/publication/safe-water-in-healthcare-premises-hsg-04-01/
- HSE publishes managing-the-risk-of-scalding guidance applicable to care settings.
  Source: https://www.hse.gov.uk/healthservices/safer-bathing.htm

### The simple rule

| Setting | Default |
|---|---|
| General-needs flat / house | **TMV2** |
| Sheltered housing | **TMV3** |
| Extra-care / care home | **TMV3** |
| Healthcare premises | **TMV3** |
| Supported living for vulnerable adults | **TMV3** |

If the setting isn't known, ask before specifying.

## Audio vs video door entry

### What's standard

**Audio handset to flat + surface call panel + electric strike release** is the long-established baseline for blocks of flats. Video is increasingly common but not yet a universal default.

There is **no Building Regulations requirement** mandating video over audio. The choice is driven by block size, system topology, accessibility, security risk profile and client preference.

### When video is justified

- **Larger blocks** where the cabling topology shifts from 2-wire to IP-based becomes more cost-effective.
- **Higher-risk locations** — concierge-managed entrances, blocks with a history of unauthorised access, sheltered schemes where a resident may not safely buzz in an unknown caller.
- **New build** where the developer or client has specified video as standard.
- **Accessibility / reasonable adjustments** — for partially-sighted, hearing-impaired or vulnerable residents, a video station (or a panel with induction loop, large buttons, audio-visual confirmation) may be required as a reasonable adjustment under the Equality Act 2010.
  Source: https://www.legislation.gov.uk/ukpga/2010/15/contents

### Topology rule of thumb

- **2-wire systems:** typically used for smaller blocks; capacity per riser depends on the manufacturer (commonly in the order of low tens of flats per system).
- **IP-based systems:** scale to hundreds of flats with structured cabling.

Manufacturer data sheets give the system-specific limits — confirm against the chosen product before specifying.

### The simple rule

| Setting | Default |
|---|---|
| Small block, general-needs | **Audio** |
| Large block, or new build with video specified | **Video** |
| Sheltered scheme | **Video** (often with concierge integration) |
| Existing audio system, partial replacement | **Audio** to match (no benefit in mixing topologies) |

## Other context gates worth flagging

- **Smoke / heat alarm grade** — under BS 5839-6:2019, the recommended minimum for new and materially-altered rented dwellings is **Grade D1 LD2**. Larger HMOs and sheltered schemes typically require **Grade A1 / LD1** (mains-powered system with dedicated control panel and full coverage).
  Source (BS 5839-6): https://knowledge.bsigroup.com/products/fire-detection-and-fire-alarm-systems-for-buildings-code-of-practice-for-the-design-installation-commissioning-and-maintenance-of-fire-detection-and-fire-alarm-systems-in-domestic-premises
  Source (Smoke and Carbon Monoxide Alarm (England) Regulations 2015, as amended 2022): https://www.legislation.gov.uk/uksi/2015/1693/contents/made
- **M4 accessibility category** — M4(1) baseline / M4(2) accessible & adaptable / M4(3) wheelchair user dwellings. Whichever the local plan or planning condition requires.
  Source (Approved Document M Vol 1): https://www.gov.uk/government/publications/access-to-and-use-of-buildings-approved-document-m

## In practice

A specifier picking a TMV by price alone, or defaulting to video door entry without checking block size and budget, will mis-spec sheltered or care work. The default chain is: **TMV2 for domestic, TMV3 for sheltered/care/healthcare**; **audio for general-needs blocks, video where size, accessibility or risk justifies**. If the brief is silent, ask.

## Common errors and red flags

- A TMV2 valve specified in a sheltered or care setting.
- "Domestic" assumed without checking — sheltered units may be described as "flats" but require TMV3.
- Video door entry specified as a default when the brief is silent on block size, risk and budget.
- TMV scheme references (TMV2/TMV3) and BS EN numbers used loosely or interchangeably — BS EN 1111 / 1287 are the underlying standards; TMV2 / TMV3 are the third-party certification schemes.
- Failure to specify induction-loop / accessible call panels where the building has hearing-impaired residents (Equality Act 2010 reasonable-adjustment exposure).

## Cross-references

- `tier1-approved-document-m-accessibility.md` — M4(1)/M4(2)/M4(3) categories
- `tier1-discipline-standard-over-brand.md` — TMV2/TMV3 reference BS EN 1111 / 1287
- `tier1-discipline-exception-fittings.md` — items that need a specific trigger before being specified
