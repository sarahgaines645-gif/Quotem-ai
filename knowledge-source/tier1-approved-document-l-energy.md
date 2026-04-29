# Approved Document L — Conservation of fuel and power

> **Primary source:** [gov.uk/government/publications/conservation-of-fuel-and-power-approved-document-l](https://www.gov.uk/government/publications/conservation-of-fuel-and-power-approved-document-l)
> **Building Regulations basis:** Part L, Schedule 1 of the Building Regulations 2010
> **Last verified:** 2026-04-26 (gov.uk page last updated 2 February 2023)

## Volumes

- **Volume 1: Dwellings**
- **Volume 2: Buildings other than dwellings**

Each volume covers both **new buildings** and **existing buildings** (including extensions, renovations, replacements of controlled fittings such as windows or boilers).

## Current edition

The **2021 edition incorporating 2023 amendments** is the current document (effective 2 February 2023). Earlier amendments occurred in 2018 and 2022.

## What Part L covers

Functional requirements from Schedule 1:

| Requirement | Subject |
|---|---|
| **L1** | Conservation of fuel and power (dwellings) |
| **L2** | Conservation of fuel and power (buildings other than dwellings) |

For new dwellings, four metrics must be met:

1. **Target Primary Energy Rate (TPER)** — total primary energy use per m²
2. **Target Emission Rate (TER)** — kg CO₂ per m² per year
3. **Target Fabric Energy Efficiency (TFEE)** — kWh per m² per year
4. **Minimum standards** for individual fabric elements (U-values) and building services

For existing dwellings, requirements apply to **renovation and replacement**:
- Replacement windows must meet a U-value or Window Energy Rating
- Replacement boilers must meet minimum efficiency
- Insulation must be added when "consequential improvements" are triggered

## Future Homes Standard (2025)

The **Future Homes Standard** is intended to make new dwellings produce **75–80% less CO₂ emissions** than current Part L dwellings, primarily by removing fossil fuel heating (gas boilers) from new builds. Government has consulted on it; commencement timeline and final form should be checked against the **current** gov.uk publication before quoting on a live project.

**GAP:** The 2025 Future Homes Standard final regulations and exact U-value tables couldn't be free-quoted from the gov.uk landing page (they're in the PDFs). Tracked in `GAP-LIST.md`.

## U-value benchmarks (existing dwellings — informational, not quotable for compliance)

Approved Document L sets **maximum** U-values (W/m²K) for elements when replaced or installed. Lower U-values = better insulation. The actual numbers live in the PDF tables and must be verified before specifying.

## Triggering "consequential improvements"

If a building has a total useful floor area > 1,000 m² and a renovation involves an extension or installation of fixed building services, **consequential improvements** to the existing fabric may be required (Volume 2 specifically — Volume 1 has narrower triggers).

## Replacement of controlled fittings

When replacing the following in any existing building, Part L applies:
- Windows, rooflights, roof windows, doors with > 50% glazed area
- Hot water cylinders, primary heating appliances (boilers, heat pumps)
- Lighting (in non-domestic buildings)

Each replacement must meet the minimum efficiency standard in force at the time.

## Air permeability and party walls

New dwellings must be air-tightness tested. **Party walls** (separating walls between dwellings) historically had a U-value of 0 in calculations on the assumption of zero heat flow; current Part L requires either evidence of effective air sealing in the cavity or a default U-value (typically 0.5 W/m²K for unfilled cavities).

## SAP — the calculation tool

Compliance is demonstrated using the **Standard Assessment Procedure (SAP)** for dwellings or the **Simplified Building Energy Model (SBEM)** for non-dwellings. The current versions are SAP 10.2 and SBEM 6.x — verify before use.

EPCs (Energy Performance Certificates) are produced from a **reduced** version of the SAP calculation (RdSAP for existing dwellings).

## What's in the PDFs (download to ingest)

The full U-value tables, building services efficiencies, sample compliance calculations, and the Future Homes Standard transitional arrangements live only in the PDFs. To ingest:

1. Download Volume 1 and Volume 2 from gov.uk
2. Convert to `.txt`
3. Save in this folder
4. Re-run `qwen-ingest.js`

## What QB2 should never do

- **Never give a specific U-value** for compliance from memory. Quote a range as approximate, and tell the user to check against the current PDF.
- **Never confirm a building is Part L compliant** from text alone — compliance is determined by SAP/SBEM calculation and Building Control sign-off.
- **Never advise installing a non-condensing boiler in a dwelling** — they have not been compliant since the **Building Regulations 2005** (effective April 2005 for England, with limited exceptions).
