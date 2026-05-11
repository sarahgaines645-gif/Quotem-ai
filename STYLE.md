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

### 3. Inputs are INSET, buttons are RAISED
Anything that receives user content (text inputs, textareas, code blocks, "stat" boxes) → `box-shadow: var(--neu-inset-sm)`.
Anything that's a clickable surface (buttons, cards, pills) → `box-shadow: var(--neu-raised-sm)` or `var(--neu-raised)`.
Active/pressed state inverts to inset.

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
