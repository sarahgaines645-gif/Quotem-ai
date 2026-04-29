# Quotem Default Specs — What Quotem Fits When the Brief Is Silent

> **Source:** `server/data/sor-facts.json` (generated 2026-03-25)
> **Catalogue size:** 3,439 SOR codes
> **Last verified:** 2026-04-26
> **Note:** This file mirrors the canonical content used by Quotem's QS persona in `sor-engine.js` and `claude-translator.js`. When `sor-facts.json` is regenerated, re-export this file to keep them in sync.

## How to use this

When QB2 is asked "what's your default for X?" — these are the answers. They're the same defaults the live app's QS persona uses to pick SOR codes. They reflect **UK social-housing repair convention** as captured in the Schedule of Rates catalogue.

If the customer's brief specifies something different, the customer's spec wins. If silent, **these defaults apply**.

---

## Defaults by component

### Doors

- **Standard internal door:** Ply flush
- **Standard external front/back door:** Hardwood panelled
- **Standard French / patio door:** PVCu sliding or French
- **Standard lock:** 5-lever mortice deadlock on external doors, nightlatch on top, euro cylinder on PVCu / composite

### Windows

- **Standard window:** PVCu casement

### Sanitaryware

- **Standard WC:** Close coupled
- **Standard basin (bathroom):** Ceramic wall-hung or pedestal
- **Standard bath:** Steel enamel, 1700mm single-ended
- **Standard shower:** Thermostatic bar mixer over bath, OR electric 8.5–9.5kW in separate enclosure
- **Standard tap:** Mixer, chrome

### Kitchens

- **Standard kitchen sink:** Stainless steel 1.5-bowl inset with drainer
- **Standard kitchen base unit:** 500mm or 600mm laminated carcase
- **Standard kitchen wall unit:** 500mm or 600mm laminated carcase
- **Standard kitchen worktop:** Laminated postformed 38mm

### Heating

- **Standard radiator:** Single panel convector
- **Standard boiler:** Combi gas, 24–30kW

### Rainwater goods

- **Standard gutter:** PVCu half-round
- **Standard downpipe:** PVCu round
- **Standard fascia & soffit:** PVCu

### Joinery

- **Standard skirting:** Softwood torus or ogee, 100–150mm
- **Standard architrave:** Softwood torus or chamfered, 50–70mm

### Wall and ceiling finishes

- **Standard ceiling finish:** 3mm skim on plasterboard
- **Standard internal wall finish:** Two-coat plaster on blockwork, OR skim on plasterboard

### Floor finishes

- **Standard carpet:** Medium-grade contract, tufted
- **Standard sheet vinyl:** 2m roll, cushioned, safety grade
- **Standard laminate flooring:** 8mm click-lock with underlay
- **Standard floor tiles:** Porcelain 300×300 or 600×600

### Roofing

- **Standard roof tile:** Concrete interlocking
- **Standard ridge:** Bedded on mortar
- **Standard flashing:** Lead

### Decoration

- **Standard internal decorations:** Emulsion walls and ceilings, gloss woodwork
- **Standard external decorations:** Masonry paint on walls, gloss on woodwork, metal paint on railings / gates

### Safety

- **Standard smoke detector:** Mains-wired with battery backup, interlinked, optical

### External

- **Standard fencing:** Close-board on softwood posts, 1.8m high

---

## Multi-code rules (no single SOR for these)

When a customer asks for these as one item, QB2 must break them into **multiple SOR lines**:

- **Complete kitchen** — NO single code. 23 individual codes for units, doors, worktops, plinths. Full kitchen = multiple SOR lines.
- **Complete bathroom** — NO single code for full refit. Individual codes for WC, basin, bath, taps, tiles, flooring.
- **Full redecoration** — NO single code. Break into ceiling, walls, woodwork separately.
- **Wet room / shower conversion** — YES, code `964001` SHOWER ROOM:CONVERT WITH FLOOR DRAIN £2267.86 covers basic conversion only.
- **Habinteg / DFG specs** — No single codes for Habinteg specifications. These are multi-trade packages that must be broken into individual SOR items.

---

## Expert rules — common mistakes to avoid

### Overhaul vs renew (sanitaryware) — huge price difference

| Item | Overhaul (service existing) | Renew (new) |
|---|---|---|
| WC | £14–57 | £211+ |
| Basin | ~£32 | £168–378 |
| Bath | ~£45 | £477–909 |
| Tap | £13 | £50–116 |

**Always check intent before matching.** "Fix the leaky tap" = overhaul (£13). "New tap" = renew (£50+).

### External painting — paint vs waterproofer are different products

Masonry **PAINT** (coloured decorative finish, codes 436061–436084) and masonry **WATERPROOFER** (clear protective sealant, code 436102) are completely different products.

- Paint = decoration
- Waterproofer = weather protection

**Never substitute one for the other.** Rendered surfaces and brickwork have separate paint codes.

### Render vs plaster — internal vs external

- **Plaster is internal** (41xxxx codes)
- **Render is external** (42xxxx codes)
- **Emulsion is internal paint**
- **Masonry paint is external paint**
- **Mist coat is internal primer**

**Never cross internal and external codes.**

### Render work — three different scopes

- **Crack repair** (423001 / 423003) — patch fill £11–15/LM
- **Renew reveal** (423005) — hack off and re-render £17.74/LM
- **Full wall re-render** (421xxx hack off + 42xxxx apply) — bigger still

These are NOT the same job. Don't pick patch-fill for a "re-render the wall" brief.

### Repointing — only on exposed brickwork

Repointing is **only possible on exposed brickwork with visible mortar joints**. You cannot repoint a rendered wall — render covers the joints.

If the wall is rendered, the work is **render repair** or **re-render**, not repointing.

### Decorations — a real trade, not fluff

"Decorations" in construction means **painting** — emulsion (internal walls/ceilings), gloss (woodwork), masonry paint (external walls). It is a real trade section, not fluff. **Always extract and price it.**

---

## Trade catalogue overview (top trades by code count)

The 3,439 codes in pricing.csv are concentrated in these top components (codes / price range / available materials):

| Component | Codes | Price range | Materials available |
|---|---|---|---|
| DOOR | 118 | £9 – £1,728 | Composite, PVCu, softwood, hardwood, steel, metal, aluminium, hardboard, timber |
| WINDOW | 113 | £2 – £1,113 | Softwood, hardwood, PVCu, metal, timber, aluminium |
| WALL | 88 | £4 – £303 | — |
| FENCING | 73 | £2 – £208 | Timber, softwood, plastic |
| DWELLING (whole-property works) | 61 | £15 – £1,940 | Timber |
| FIRE (fire safety items) | 55 | £7 – £1,222 | — |
| KITCHEN UNIT | 54 | £11 – £335 | — |
| CYLINDER | 54 | £17 – £1,595 | — |
| GRAB BAR | 41 | £21 – £339 | — |
| GUTTER | 40 | £4 – £118 | Timber, PVCu |
| STACK (soil/vent) | 39 | £11 – £721 | PVCu |
| SHOWER | 39 | £10 – £548 | — |
| FRAME | 36 | £2 – £732 | Metal, softwood, hardwood, PVCu, timber |
| GATE | 32 | £7 – £852 | Timber, metal |
| FLOOR TILES | 31 | £1 – £125 | Vinyl |
| CHIMNEY | 30 | £9 – £1,249 | — |
| HEATER | 30 | £17 – £543 | — |
| BATH | 22 | £6 – £909 | Steel |
| BOILER | 20 | £30 – £2,945 | — |
| RADIATOR | 22 | £19 – £354 | — |

(Full trade index in `sor-facts.json` — for the complete picture, see that file directly. The CSV is also ingested separately so QB2 has every code searchable by description.)

---

## What QB2 should never do

- **Never invent a "standard"** that isn't in this file. If asked for a default and it's not listed here, say "Quotem doesn't have a default for that — what would you like?"
- **Never pick a renew code** when the customer's intent is overhaul/repair, or vice versa. Read the verb.
- **Never quote a "complete kitchen" / "complete bathroom" as a single price.** Break into the constituent codes.
- **Never substitute masonry paint for waterproofer** (or vice versa) — they're different products.
- **Never apply external codes (42xxxx) to internal walls** or vice versa.
