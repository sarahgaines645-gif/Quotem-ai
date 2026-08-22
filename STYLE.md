# Style rules — Q (quotem-ai)

The whole app is **neumorphic light** — `#e8e8e8` base, soft inset/raised shadows, `#e91e63` pink accent for icons + emphasis only. Reference pages: `tools.html`, `scheduler.html`, `chat.html`, `life.html`.

## Hard rules

### 1. NO overlay on modals — no dark tint, no blur, no light tint
Neumorphic depth depends on light-on-light contrast. ANY overlay (dark or blurred) breaks the illusion. Focus comes from the modal's own raised neumorphic shadow against the live page beneath.

```css
.modal-bg {
    position: fixed; inset: 0;
    background: transparent;   /* nothing — kept transparent so click-outside-to-dismiss still works */
}
```

Don't add `backdrop-filter`, don't tint, don't dim. The page beneath stays fully visible; the modal floats above with its raised shadow doing the focus work.

### 2. Accent colour is for ICONS and indicators, not fills
`#e91e63` belongs on:
- Icon wells inside cards
- The brand "Q." dot
- Small attention indicators (recording dot, the "today" highlight in the calendar number)

It does NOT go on:
- Button backgrounds
- Button text (buttons get colour shift on hover only, via `color: var(--accent)` on `:hover`)
- Card borders or fills
- Large text blocks

### 3. ⚠️ NO INDENTS. NONE. Everything is RAISED.
**This rule used to say "inputs are INSET, buttons are RAISED". That is DEAD.**
Sarah has now said it more times than any other rule — 17 Aug: *"there should be
a clear rule somewhere that says no indents"*; 21 Aug: *"we dont indent we
raise"*. `CLAUDE.md` in this repo carries the full version and it is the one
that wins. This file was still telling agents the opposite, which is why her
inputs kept getting sunk.

- Every surface = **raised** (`--neu-raised-sm` / `--neu-raised`) on `var(--bg)`.
- A field she types into is a **raised card with a caret in it**, not a well.
- Selected / current / active is shown with the **accent on an icon or dot**, or
  bold text — never by sinking the thing.
- The only `--neu-inset` left anywhere is a button's `:active`, the momentary
  press under her finger. It is gone the instant she lets go.

### 3b. Nothing appears on hover
No boxes, no half-visible outlines, no tooltip cards. Sarah, 17 Aug: *"I don't
want all these half invisible boxes to appear as I move the cursor over it."*
An existing element may change state on hover — a card can lift. Nothing new
may materialise. If a mark on a map needs explaining, the explanation belongs
somewhere permanent, and pointing at the mark should light that place up.

### 4. Theme tokens are canonical — don't invent shadows
Every page declares the same `:root` block:
```css
--bg: #e8e8e8;
--text: #1a1a1a;
--text-muted: rgba(0,0,0,0.42);
--text-faint: rgba(0,0,0,0.26);
--accent: #e91e63;
--neu-raised:    10px 10px 28px #ababab, -8px -8px 20px #ffffff, inset 0 1px 0 rgba(255,255,255,0.5);
--neu-raised-sm: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
--neu-inset:     inset 5px 5px 14px #ababab, inset -4px -4px 10px #ffffff;
--neu-inset-sm:  inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
--neu-inset-xs:  inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
```
Use these. Don't author new shadow values — they'll read wrong next to existing surfaces.

### 5. Font is Space Grotesk
Loaded once via `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap">`. System fallback chain is `-apple-system, BlinkMacSystemFont, sans-serif`. No other fonts.

### 6. NO self-explanatory notes on the page — the interface explains itself
**Sarah, 20 Aug 2026: "can you please put a note somewhere to tell the agents to
stop putting self explanatory notes on the pages."**

Do not write a line of text telling the user what the screen in front of them
obviously does. This, sitting under a date picker and a button marked *Find
them*, is exactly the thing:

> ~~Set your dates and press **Find them** — the places that work turn pink.~~

The dates are a date field. The button says what it does. The pink is visible
the moment it happens. Every word of that is the interface describing itself to
someone who is already looking at it — and it makes the product feel like a
manual, not a tool.

**Delete it. Don't reword it, don't shrink it, don't make it muted grey.** If a
control needs a sentence of explanation to be usable, the control is wrong —
fix the control.

What IS allowed, and only where it earns its place:
- A **placeholder** inside an empty field showing the shape of the answer
  (`e.g. 15mm copper pipe`) — that is a worked example, not an instruction.
- An **empty state** where there is genuinely nothing yet and no other clue what
  the panel is for ("Nothing here. Tap + to add one.").
- A **caveat the data itself requires** — where a number came from, or what it
  cannot tell you. That is honesty, and it is required elsewhere in these rules.

The test: *would a competent stranger work this out in two seconds by looking?*
If yes, the sentence is furniture. Take it out.
