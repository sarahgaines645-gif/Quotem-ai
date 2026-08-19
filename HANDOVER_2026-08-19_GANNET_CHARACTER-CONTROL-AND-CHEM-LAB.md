# HANDOVER — GANNET, 19 Aug 2026
## Getting a character to move on demand: the studio, the IK, and seeing your own work

**Read this before touching anything 3D.** Two days went into this. Most of the
cost was not in building — it was in building blind, and in a handful of traps
that each look like a different bug and are the same one.

---

## 1. WHERE IT ENDED UP

Sarah's goal moved during the session and landed here: **a character who can be
made to do chemistry tests on demand** — pick up a test tube, add a reagent,
show the correct observation. Not a dancing unicorn; that was the road in.

Her decisive words, and they are the brief:

> *"I dont want to get technical until I know we can get her moving properly.
> thats why I said we needed to make sure we can control the whole scene."*

So the deliverable became **control**, not chemistry.

---

## 2. WHAT EXISTS NOW (all in `quotem-ai`, all routed and public)

| Route | What it is | State |
|---|---|---|
| `/studio` | **The important one.** Drag her hands, place props, set keyframes, scrub, export. | Works |
| `/lab` | Scripted demo: she picks up a tube and pours. | Mechanics work, staging rough |
| `/rig` | Bench: character switcher, dance dropdown, sliders, drop-a-clip | Works |
| `/dance` | Control test — three.js's own character + its own Samba | Works |
| `/disco` | Video unicorns keyed into a disco scene | **Broken** — the browser key does not run; see §6 |
| `/unicorn` | The 2D canvas unicorn, now beat-locked to the record | Works |

### The files that matter

- **`scripts/shoot.js`** — headless screenshots + in-page measurement. **The single
  most valuable thing built.** See §4.
- **`assets/ik.js`** — two-bone inverse kinematics. Say where the hand goes; it
  solves the shoulder and elbow. Measured error **0.000–0.004 m**.
- **`assets/unicorn-actions.js`** — an ACTION as a function of time (reach, grab,
  lift, pour, present), written against bone NAMES.
- **`assets/unicorn-dance.js`** — the Gangnam routine, same idea, tuned to Sarah's
  own slider values. Do not "fix" `lasso: 0` — she chose it.
- **`assets/chem-tests.js`** — 26 GCSE qualitative tests as data (flame, NaOH
  precipitates, gases, anions, indicators). **⚠️ NOT YET CHECKED against a board
  spec. Do not put it in front of a student until Sarah confirms AQA/Edexcel/OCR
  and level.**
- **`assets/models/`** — `unicorn-fixb.glb` (hers, rigged, dances),
  `michelle.glb` + `xbot.glb` (three.js, MIT, artist-made, 65–67 bones).

---

## 3. THE ONE IDEA THAT MADE EVERYTHING WORK

**Write motion against BONE NAMES, never bake it into a file.**

Every character here uses the Mixamo naming (`mixamorig:Hips`, `LeftArm`, …).
Because the dance and the actions are functions keyed on those names:

- the same routine drives the unicorn, Michelle and Xbot with **zero changes**
- swapping in a commissioned character later costs **one filename**
- nothing is ever retargeted, so nothing can tear

The corollary, learned the hard way: **a borrowed clip authored on another
skeleton will never sit right.** A clip stores rotation from *its own* rest pose.
Retargeting only approximates. Every "she moves like she's on drugs" moment came
from this. The exception that proves it: Michelle's own SambaDance plays
perfectly on her, and **name-matches onto the unicorn** (22 of 23 bones).

---

## 4. ⚠️ THE THING THAT WAS ACTUALLY BROKEN: I COULD NOT SEE MY OWN WORK

Sarah, after hours of it:

> *"you need to create something that allows you to see the actual image and
> video you create not just the coad"*

She was right, and it was the root cause of most of the waste. **`scripts/shoot.js`**
fixes it: drives the installed Edge headlessly, screenshots any page, and — the
real prize — **runs JS in the page and returns measurements**.

```bash
node scripts/shoot.js "http://localhost:8080/studio" out.png \
  --wait 5000 --eval "JSON.stringify(window.__studio.api.report())"
```

Within minutes of existing it found four bugs that were invisible in code:

1. **The prop was out of reach.** Her arm is 0.46 m; the tube was 1.18 m away. No
   pose could ever have reached it.
2. **The lab coat was 2 mm wide.** A mesh parented to a bone is built in THAT
   BONE'S space. Michelle's root is scaled 0.01 with a skeleton in centimetres,
   so metres-sized clothing vanished. Not missing — microscopic.
3. **Sleeves pointed sideways** because I assumed limbs run along local X. They
   do not. **A bone's `child.position` IS the limb's direction and length in the
   right units** — build along that and it fits any rig.
4. **The render loop looked dead.** It was running at **2 fps** because headless
   uses software WebGL and shadows + `transmission` glass cost ~500 ms a frame.
   Every measurement was a stale frame. Hence `?fast=1` on `/lab` and `/studio`.

### Rules for using it
- WebGL needs `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`
  or the canvas comes back blank.
- **`page.click()` proved unreliable.** Click from inside instead:
  `--eval "(async()=>{document.getElementById('b-play').click(); await new Promise(r=>setTimeout(r,3000)); return JSON.stringify(window.__state);})()"`
- Add `window.__something.report()` to any page you want to debug. Measuring
  beats reasoning about units from the outside, every time.
- `/lab` and `/studio` expose `freeze(t)` / `seek(t)` so a shot lands on an exact
  moment instead of a wall-clock guess.

---

## 5. THE STUDIO — how Sarah drives it

`/studio`. Four white-ringed discs: **pink** right hand, **cyan** left hand,
**yellow** test tube, **green** beaker.

- Left-drag a disc → the arm solves to it. Right-drag orbits, wheel zooms.
- **Hold the tube** parents the tube to the hand bone; it then travels with her.
- Pose → **+ Key at this time** → move the scrubber → pose again → **Play**
  (blends with ease-in-out).
- **Copy the animation** puts the keys on the clipboard as JSON.

**Keys store HAND POSITIONS, not joint angles.** So a pose survives a change of
character: a different body with different arm lengths re-solves to the same
world-space targets. Nothing posed is wasted when the character is replaced.

⚠️ Handles must be `depthTest: false` with a high `renderOrder`. The first
version drew them normally and they sat *inside* her wrists and inside the
glass — present, named, and invisible. Sarah reported "theres no colourd balls".

---

## 6. WHAT IS BROKEN OR UNFINISHED

- **`/disco`** — the unicorn videos show as white boxes. The source file *is*
  green (corner pixel measured `140,233,130`); the in-browser chroma key is not
  running. Short fix, not yet done.
- **`/lab` staging** — the pick-up, hold, pour and fill all work and are
  measured, but the composition is stiff and the glassware reads faintly.
- **The lab coat** is primitives. It fits the arms now, but a cylinder will
  never be a coat. This is the wall: **primitives and generated meshes cannot do
  fine detail** — the unicorn's face, the coat, the glassware, all the same wall.
- **`assets/chem-tests.js` is unverified against a spec.** See §2.

---

## 7. THE 3D ROUTE — what was tried, what it cost

**Tripo** (`TRIPO_API_KEY`, on Railway and in `.env.local`):
- image→3D **30 credits**, rig **25**. Rig output is a clean **23-bone
  `mixamorig` skeleton** — genuinely Mixamo-standard, proven by Michelle's clip
  name-matching onto it.
- **Their preset animations will not bind.** Every `preset:biped:dance_01` /
  `preset:dance_01` retarget failed at run time with error 1004 — proven not to
  be the name, the rig version, or the spec. Failed binds cost 0 credits.
  **Don't buy the animation step.**
- Rig tasks sometimes return `expired` (queue drop, 0 credits) — retry.

**⚠️ THE PRETTY REFERENCE MAKES THE WORST 3D.** Glossy and fluffy references with
big manes fuse into slabs and lose their arms — three builds wasted. What works:
**flat cel-shaded, clear air between arms and body, mane tight to the head,
short muzzle.** `.work/fix-b.png` is the shape that works. Strip the drop shadow
from the reference first (`.work/strip-shadow.js`) or it becomes geometry welded
to the feet.

**Grok Imagine** (`xai/grok-imagine-video` on Replicate, ~$0.08/s): a picture in,
a video out, ~43 s, ~65p for 8 s. **Best-looking character of the whole session**,
face moving, no rig at all. But it is a fixed clip: it cannot react, and each one
costs. Use for hero shots, not for anything interactive.

**Spend:** Tripo 500 → ~155 credits (~£3.45). Four Grok clips (~£2.60).

---

## 8. WHAT NOBODY HAS THAT WE NEED

A cartoon character with a **facial rig** does not exist off the shelf — even
paid game-ready animals ship body animation and no blendshapes (checked). The
unicorn has **0 morph targets and no jaw, eye or brow bones**; nothing to
animate. Options, in order of sense:

1. **Commission it.** Brief is in the transcript: Mixamo-standard skeleton in
   T-pose, ARKit blendshapes (`eyeBlinkLeft/Right`, `jawOpen`, `mouthSmileLeft/
   Right`, `browInnerUp` minimum), GLB, arms long enough to reach in front of the
   body, no shadow in the mesh. Industry rates found: **$50–5,000**, freelancers
   typically **$100–120** for a rig; blendshapes push it up.
2. **Mixamo** (mixamo.com, free Adobe login, no API) for ready animations. FBX
   drop is already wired into `/rig` — `FBXLoader` is vendored. Their licence
   permits use in a product but **not redistributing the raw animation files**.
3. **Blender** (free) or **phone video → Rokoko Vision / DeepMotion** (free
   tiers) to author motion. Both export to a Mixamo-named skeleton.

⚠️ **Ready Player Me's animation library is licensed for RPM avatars ONLY** —
using it on Michelle is expressly prohibited. GitHub repos dumping Mixamo files
breach Mixamo's redistribution terms. Do not build on either.

---

## 9. NEXT

1. Sarah drives `/studio` and says whether dragging feels controllable. That
   gates everything.
2. She confirms the **exam board and level** for `assets/chem-tests.js`.
3. Build the first test — recommend **NaOH precipitates**: six tests, five
   distinct colours, and the "dissolves in excess" distinction is the mark
   students drop.
4. Fix the `/disco` chroma key (small).
5. Decide on commissioning a character; nothing else removes the detail wall.

---

## 10. HOW TO WORK WITH HER ON THIS

- **She has been right about the direction repeatedly** — the video route, the
  need to see the work, the need for scene control. When she says the approach is
  wrong, it is.
- **Do not hand her angles to judge.** Give her sliders, handles, dropdowns —
  anything she can move — and bake in the numbers she sends back.
- **Show her a picture, not a claim.** `scripts/shoot.js` exists for this.
- Nothing in this session was deleted. Every model, reference and clip is still
  on disk.
