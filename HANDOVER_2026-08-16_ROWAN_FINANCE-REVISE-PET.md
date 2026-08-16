# HANDOVER — 16 Aug 2026 — ROWAN — finance truth, phone/batch, revise fixes, the PET

**Repo `quotem-ai`, branch `main`, push = Railway (`industrious-contentment`).
Live at handover: `a1b014a` (contains everything below). Another session shares this
tree and pushes concurrently — commit by path / private index, read `git diff --cached`.
Earlier handover from the same night: `HANDOVER_2026-08-16_ROWAN_FINANCE-TRUTH-CHAIN-PHONE-BATCH.md`
(finance detail lives there; this file adds what came after).**

---

## Finance (state at handover — see the earlier handover for the laws)

- **Headline** = Total spending · Total income · **You have / You owe** (from real balances, never netted). "In minus out" and the transaction count are in the small period line, which also explains balance change ("accounts up £X — £Y from your own pots, £Z more out than in").
- **Account cards** stripped to numbers (her: "all this is mess"). Statement checks show at drop time only.
- **Charges card**: unnamed "charges" listed under the bank's own merchant text with the account, not counted as penalties.
- **Problems & debts** = LETTERS: envelope grid, company mark on the stamp (logo via /api/logo, monogram fallback), amount on the stamp, postmark = time ("overdue by N · no action for N"), 3 round actions, duplicates folded, worst first.
- **Whole app on Quotem's white** (`#f3f3f3`, same clay shadows). Merchant/bank marks raised except inside a letter's stamp.
- **STILL OPEN (hers):** drop July + June Lloyds once more (phantom £47 leaves the store; June 81p named); "available" A/B; the three-card design (incoming/advice/subscriptions Keep-Cut-Cheaper) — asked, no answer. NatWest TXN download has NO balance column — screenshot balance is the source.

## Revise (study suite) — shipped tonight

- **Plays from the CURRENT topic list**, with a topic picker (toggle chips, all/just one). Root cause was pickFromBank drawing from the whole global bank.
- **UK school stages**: Reception, Year 1–6, Year 7–9, GCSE, A-Level, BTEC. `stageOf/stageRules` in `plugins/q-revision.js` inject age, key stage, what shapes the year, child-appropriate wording into writer/checker/marker; board locks to "National curriculum (England)" for a school year. GCSE/A-Level prompts unchanged.
- **Explanation popup**: × top-right, Escape/click-outside/next-question close it; it stays on screen (used to hang below the viewport).
- **THE PET** (`revise.html`, module `pet` before `game`): card on the LEFT (tube's mirror). Egg (spotty=puppy, stripy=hamster, dotty=capybara) cracks with right answers, hatches at 15, baby/young/grown at 15/60/120; treats per right answer; unlocks ball 20, bow 35, hat 55, scarf 80, bed 100; never dies. State = `progress.pet`. **Art = generated set (gpt-image-1, transparent) in `assets/pet/`**: eggs ×3 per pet, front + running side view per pet per stage, items. **Motion engine**: wander (run to a spot, sit, breathe), approach the glass + LICK (needs sheets), jump on right answer, eat, play, sleep. **Sprite sheets** (frame animation) exist for **puppy baby only** in the repo (`assets/pet/sheet_puppy_baby_*.png`, 720px); the other 48 sheets were generated and checked (slice report ok) but **NOT shipped — she paused**. They live outside the repo at `C:\Users\sarah\OneDrive\Desktop\pet-art-generated\sheets-720-unshipped\` with all 90 originals in `originals-1024\` and the generator `gen_pets.js`. To ship them: copy into `assets/pet/`, commit, push — the engine picks them up by name (`sheet_<kind>_<stage>_<act>.png`) automatically.
- **Pet lab**: `/revise?petlab=1` — hatched pet at once, buttons for pet/stage/actions, nothing saved.
- Slicer (`sliceSheet`) drops edge-cropped frames, cuts touching frames at valleys, uses whatever complete frames exist. Preview harness must be served over **localhost** (file:// taints the canvas) — `scratchpad/make_preview.js` + `python -m http.server`.

## THE DECISION SHE'S MAKING — proper cartoon
Told her: a rigged Rive/Lottie set from one freelance animator ≈ £300–£800 per pet, ~£1,000–£2,500 for three with growth as proportions; recommend ~£1,200–£1,800; brief with today's generated art; wiring in ≈ an afternoon (engine stays, drawing changes). She said "answer me before you build something we won't use" → **NOTHING more on the sprite route until she says**. Total spent on art tonight ≈ $4 (20 + 16 + 54 images at medium).

## Gotchas
- `www.quotem-ai.co.uk` only; apex fails TLS. Public-by-token routes must be in `server/index.js` PUBLIC_PREFIXES.
- Edge headless is at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` — `--headless=new --screenshot=… --virtual-time-budget=…` (use absolute paths).
- PowerShell System.Drawing resizes PNGs with alpha; the haze strip (alpha<48 → 0) matters for gpt-image transparent output.
- `railway run node script.js` injects env (OPENAI_API_KEY) locally — never print it.

⚠️ Repo pushes to GitHub: no payees, family names, account numbers, balances in files.
