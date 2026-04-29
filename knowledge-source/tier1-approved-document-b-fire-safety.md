# Approved Document B — Fire Safety

> **Primary source:** [gov.uk/government/publications/fire-safety-approved-document-b](https://www.gov.uk/government/publications/fire-safety-approved-document-b)
> **Building Regulations basis:** Part B, Schedule 1 of the Building Regulations 2010
> **Last verified:** 2026-04-26 (gov.uk page last updated 11 March 2025)

## Volumes

- **Volume 1: Dwellings** — covers houses and flats
- **Volume 2: Buildings other than dwellings** — covers all other buildings (residential homes, schools, colleges, offices, etc.)

The current version is the **2019 edition** incorporating amendments from 2020, 2022, and 2025, collated with further amendments scheduled for 2026 and 2029.

## What Part B covers

Approved Document B is structured around **five functional requirements** drawn from Schedule 1 of the Building Regulations 2010:

| Requirement | Subject |
|---|---|
| **B1** | Means of warning and escape |
| **B2** | Internal fire spread (linings) |
| **B3** | Internal fire spread (structure) |
| **B4** | External fire spread |
| **B5** | Access and facilities for the fire service |

Each Volume contains sections corresponding to these five requirements.

## Key 2022 amendments (post-Grenfell)

The June 2022 amendments were added to both volumes following Grenfell Tower inquiry recommendations. They included changes around:

- Wayfinding signage in blocks of flats
- Evacuation alert systems for fire and rescue services
- Fire safety information

A consultation on **"Sprinklers in care homes; removal of national classes; and second staircases in residential buildings"** ran from December 2022 to March 2023 and led to subsequent updates. The "**second staircase rule**" requires a second staircase in new residential buildings above **18 metres** in height (note: the threshold and transition arrangements are technical — verify against the current PDF before quoting on a live project).

## Key concepts QB2 should know

### Compartmentation
Buildings are divided into fire-resisting compartments to limit fire and smoke spread. Compartment walls and floors must achieve specified fire-resistance ratings (typically 30, 60, 90, or 120 minutes).

### Means of escape
Every habitable room must have an escape route that meets:
- Minimum corridor / staircase widths
- Maximum travel distances to a place of relative safety
- Protected stairs (enclosed in fire-resisting construction)
- Smoke control where applicable

### Fire detection and alarm (BS 5839-6 for dwellings)
Approved Document B references BS 5839-6 for the design of fire alarm systems in domestic premises. Grade and category vary with dwelling type. Key obligations for landlords (Smoke and Carbon Monoxide Alarm (Amendment) Regulations 2022):

- **Smoke alarm on every storey** of the dwelling used as living accommodation
- **CO alarm in every room** with a fixed combustion appliance (excluding gas cookers)
- Alarms must be **tested at the start of every new tenancy** and repaired/replaced as soon as reasonably practicable when reported faulty

### External wall systems (post-Grenfell)
Materials used in the external walls of relevant buildings must achieve **European Class A1 or A2-s1, d0** for non-combustibility (with limited exceptions). The "relevant buildings" definition covers blocks of flats above 11m, hospitals, care homes, dormitories.

## What's in the PDFs (not free-quotable here)

The full technical detail — exact fire ratings, room-by-room dimensions, schedule of materials, compartment-size tables — lives only in the Approved Document PDFs. To get them into QB2's brain:

1. Download Volume 1 and Volume 2 from the gov.uk page above
2. Convert PDF to text (`pdftotext` or similar)
3. Save as `tier1-approved-document-b-volume-1-FULL.txt` and `tier1-approved-document-b-volume-2-FULL.txt`
4. Re-run `qwen-ingest.js`

Tracked in `GAP-LIST.md`.

## What QB2 should never do

- **Never give specific fire-rating advice** without verifying against the current Approved Document. Lives at stake.
- **Never claim a building is "Part B compliant" from a description alone** — compliance is determined by Building Control sign-off.
- For any fire safety question on a building above 18m or with cladding concerns, **escalate to a qualified fire engineer** — this is regulated work under the Building Safety Act 2022.

## Related legislation

- **Regulatory Reform (Fire Safety) Order 2005** — fire safety duties on building owners/managers
- **Fire Safety Act 2021** — clarified that the Fire Safety Order applies to external walls, balconies, doors of multi-occupied residential buildings
- **Building Safety Act 2022** — created the Building Safety Regulator, new gateway regime for higher-risk buildings
- **Smoke and Carbon Monoxide Alarm (Amendment) Regulations 2022** — extended alarm duties to social rented sector
