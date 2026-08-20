# HANDOVER — KITE, 20 Aug 2026
## The lab: told what to do, a teacher with a face, 113 characters to choose from — and the three things Sarah asked for next

Follows `HANDOVER_2026-08-19_PETREL_LAB-SHE-ACTUALLY-HOLDS-IT.md`.
Read §1 first — it is what she actually wants, in her words.

---

## 1. WHAT SARAH ASKED FOR NEXT (her words, 20 Aug)

> *"I think wed need more of a pixar looking character for kids and we need a
> whole design suit so I can create the experiments and shes not holding the
> stuff they are floating next to her arms"*

Three separate things. Taking them in reverse order, because one is done:

### 1c. "they are floating next to her arms" — FIXED, see §3
Her hands were not closing AT ALL on any non-Mixamo character. Root cause and
measurements in §3. She now grips.

### 1b. "a whole design suit so I can create the experiments" — NOT BUILT
This is the big one and it is a PRODUCT, not a tweak. What she is describing:
she wants to author an experiment herself, without me, the way she authors a
quote. Think: pick the apparatus, pick the reagents, say what the observation
should be, set the steps, save it, play it back.

What already exists to build it on:
- `assets/lab-commands.js` — the command engine. `parse()` turns a sentence into
  commands; `LabEngine` runs them. **An experiment is already a list of
  commands** — the format is there, there is just no way for her to write one.
- `assets/chem-tests.js` — 26 GCSE tests as DATA (flame, NaOH precipitates,
  gases, anions, indicators). ⚠️ still UNVERIFIED against a board spec.
- `/studio` — drag handles, keyframes, export. That is the *posing* half of an
  authoring tool and it already exists.

The shape I would build (NOT started, needs her yes):
1. an **experiment file** — apparatus, reagents, steps (existing commands),
   expected observation, the mark-scheme wording;
2. an **editor page** where she picks from the apparatus/reagent lists and
   drags the steps into order, previewing on the character live;
3. **play it back** in `/lab`, which already knows how to run commands.
Start at (1) — the format — because (2) and (3) are both just views of it.

### 1a. "more of a pixar looking character for kids" — NOT SOLVED
The Rocketbox teacher (§2) is a REALISTIC adult, which is right for a
professional demo and wrong for children. What we have and why none of it fits:

| Option | Pixar-ish? | Face? | Licence | Verdict |
|---|---|---|---|---|
| Rocketbox | No — photoreal | 175 blendshapes | MIT | great, but adult/realistic |
| Mixamo (Claire) | Stylised | **none** | no redistribution | no face, cannot ship |
| VRM / VRoid | Anime, not Pixar | full | per-model | closest today; anime ≠ Pixar |
| Ready Player Me | semi-stylised | ARKit | — | **DEAD, see §5** |

Nothing off the shelf is Pixar-styled AND rigged AND has a face AND is
licensed to sell. Realistic routes, cheapest first:
- **VRoid Studio** (free, reachable) — she designs it; anime house style though;
- **commission one** — the brief from GANNET §8 still stands (Mixamo-standard
  skeleton, T-pose, ARKit blendshapes, GLB). $100–120 typical for a rig,
  blendshapes push it up;
- **generate** via the Replicate pipeline (`scripts/make-character.js`) — pennies
  per attempt, but GANNET measured the quality wall: generated faces are poor.
  ⚠️ costs money — needs her explicit yes and a price first.

**My recommendation:** do NOT chase the character next. The design suite (1b) is
worth far more and is character-agnostic — everything is written on bone names,
so a Pixar character dropped in later costs one file. Build the suite on the
teacher, swap the character when one exists.

---

## 2. WHAT SHIPPED TODAY

- **Told what to do.** `/lab` has a text box, a mic, and chips. "pick up the
  cup", "pour it in", "show me", "put them down", "do the whole thing" compose
  in any order, each starting from wherever she is now.
- **A teacher with a face.** Microsoft Rocketbox `Medical_Female_01`, **MIT
  licensed** so it can ship in a product. Realistic adult woman, lab coat, no
  glasses, **175 facial blendshapes** (full ARKit set + 15 speech visemes).
- **113 characters to choose from.** More ▾ → 👤 Choose character. Gallery with
  previews, names and a search box. **Nothing lives in this repo** —
  raw.githubusercontent.com serves Rocketbox with `Access-Control-Allow-Origin:
  *`, so the browser fetches the model and textures straight from Microsoft when
  she clicks. Carrying all 113 would be ~4GB of TGA.
- **`assets/rig-map.js`** — four naming systems: Mixamo, Ready Player Me,
  VRM/VRoid (reads the character's OWN humanoid table), 3ds Max Biped.
- **`assets/face.js`** — blink, brows, jaw, smile. Drives real blendshapes
  (ARKit or VRM naming), and where a character has none, moves its separate
  mouth/brow/eye MESHES directly.

---

## 3. ⚠️ THE BUG SHE REPORTED — WHY NOTHING WAS EVER HELD

`setChainCurl()` in `grip.js` looked the rest pose up by **the bone's own name**:

```js
const b = bones[side + 'Hand' + f + i];
if (!b || !restQ[key(b)]) continue;      // key(b) = "Bip01_R_Finger11"
```

But `bones` and `restQ` are keyed by **our standard names** (`RightHandIndex2`).
Those only coincide on a Mixamo rig. On Rocketbox (`Bip01_R_Finger11`) and on
VRM (`J_Bip_R_Index2`) the lookup missed, `continue` fired, and **no finger ever
moved** — while `closeOn` cheerfully reported `curl: 1.0`.

Measured on the teacher, fingertip distance to a **0.050m** cup:

| | before | after |
|---|---|---|
| Index | 0.119 | 0.065 |
| Middle | 0.126 | 0.068 |
| Ring | 0.107 | 0.061 |
| Pinky | 0.075 | 0.050 |
| touching | 1/5 | 3/5 |

The giveaway in the numbers: joint distance from the wrist went 0.107 → 0.148 →
0.173, i.e. steadily INCREASING. That is a dead straight finger. A curled one
comes back towards the wrist.

**Fix:** look up by the standard name (`side + 'Hand' + f + i`), never `b.name`.

Also in this pass: `handFrame()` now decides the palm direction **by
experiment** — bend a finger both ways, keep whichever shortens the fingertip-
to-wrist distance, because that is the way that makes a fist. The thumb's lean
was the old signal and it is inverted on Biped rigs.

---

## 4. ⚠️ LIVE IS DOWN — quotem-ai only

At the time of writing **https://www.quotem-ai.co.uk returns 502 on every
path** — `/`, `/lab`, `/welcome`, every asset. It was healthy at 15:38 (commit
`98c43d0` deployed and verified 200), then stopped after `c1afabf`.

- **The main Quoteapp is FINE** — `quotem-production.up.railway.app` = 200.
  This is the Q app only.
- `c1afabf` changed only `lab.html` and added a client-side JS file. Nothing
  server-side. So a code crash is unlikely.
- Suspicion, unproven: the 43MB of TGA textures in `98c43d0` pushing the
  Railway build or image over a limit.
- **I could not check the logs** — `railway status` returns *Unauthorized* and
  `railway login` needs an interactive browser. **Sarah needs to open the
  Railway dashboard for the Q app and read the deploy log.**

If it is the size, the fix is to stop committing the textures and fetch them
from GitHub like the other 112 avatars already do (see §2) — the machinery is
already written, the teacher just predates it.

---

## 5. READY PLAYER ME IS DEAD — do not chase it

Netflix acquired it Dec 2025; the public platform shut down **31 Jan 2026**.
The domain resolves with **no address record at all**. I wrongly told Sarah her
router was blocking it and sent her to her EE settings — it was not, and she was
the one who spotted the site had changed. Verified from public DNS:

```
readyplayer.me        exists, NO A record
models.readyplayer.me NXDOMAIN
api.readyplayer.me    NXDOMAIN
```

Their GitHub repo is still up, which is why a sample file loaded fine and the
skeleton genuinely was a 13/13 match — the format checked out while the service
behind it was already gone. **Verify the service, not just the file.**

---

## 6. TOOLING — `scripts/shoot.js`

Being unable to see the page cost most of a day. Three separate causes, all now
fixed in the script:
1. **puppeteer was required by absolute path** into one session's scratchpad.
   Those get cleaned up; when it went, so did all sight. Now resolves from the
   project's `node_modules` (`npm install --no-save puppeteer-core`).
2. **Edge refuses to start** when it has a staged update (`new_msedge.exe`
   present) or an open profile — it exits 0 with NO output, even for
   `--version`. It now prefers puppeteer's cached Chrome at
   `%USERPROFILE%/.cache/puppeteer/chrome/*/chrome-win64/chrome.exe`.
3. **It leaked a browser on every failure**, and 40 of them ate the machine down
   to 489MB free. It now closes in a `finally`.

There is also an offline harness worth keeping: load a rig in plain Node (no
DOM, no WebGL), run the REAL `ik.js`/`grip.js`, and print fingertip distances.
Every grip number in §3 came from it. It is how you debug a hand without eyes.

---

## 7. NEXT

1. **Sarah reads the Railway log** for the Q app and we get live back up (§4).
2. **Decide: design suite first** (my recommendation) or character first.
3. If design suite: agree the experiment FILE FORMAT before any UI.
4. `assets/chem-tests.js` still needs a board + level confirmed before a student
   sees it. Still gating, still unanswered since 19 Aug.
5. Small: two of the teacher's texture maps 404 (the 12MB normal maps, skipped
   deliberately). Harmless; grab them if she looks flat.
