# HANDOVER — PETREL, 19 Aug 2026 (evening)
## The lab: she actually picks it up, pours, and shows you. The studio: drop a hand on a prop and she takes hold.

Follows `HANDOVER_2026-08-19_GANNET_CHARACTER-CONTROL-AND-CHEM-LAB.md`. Sarah's
brief for this session: *"we cant seem to make it work and I need someone that
can."* Read GANNET §3–§5 first — its laws still hold. This file is what was
actually wrong, what was changed, and how to see it.

---

## 1. WHAT WAS ACTUALLY BROKEN (measured, not guessed)

All found with `scripts/shoot.js --eval` against the page's own `window.__lab`.

| Symptom Sarah would see | Root cause | Evidence |
|---|---|---|
| She "picks up" the tube and it **vanishes**; then pours a stream into her empty palm | `lab.html` `pickUp()` parented the tube to `RightHand`, whose world scale is **0.01** (cm skeleton under a 0.01 root). `tube.scale.setScalar(1)` in bone space = 1 cm... the tube came out **2.6 mm tall**. The exact trap GANNET §4 documented for the coat, repeated on the prop. | `tubeWorldSize [0.0012, 0.0026, 0.002]` at t=3.8 |
| "Do it again" — she reaches for nothing | `putBack()` dropped the tube at `(0.34, …, 0.12)` — the OLD unreachable spot GANNET had already moved it away from — not at its home | code, `lab.html` v1 `putBack()` |
| Open flat palm "holding" the tube; beaker raised above her head | IK only moves the wrist. Nothing ever set the wrist's orientation or closed the fingers; the jug followed the hand instead of the hand going to the jug | `lab-held.png` in the session scratchpad |
| Glass reads as a ghost on a real GPU | `transmission: 0.9` | `lab2-real.png` |
| Studio: drag the hand up and the tube stays on the bench | "Hold" copied the tube to the wrist each frame with no grip geometry; nothing placed the prop in the palm | measured before the change |
| Disco: pale green pool round every dancer's feet | chroma test was `g > 1.35·r && g > 1.35·b` — misses the darker, desaturated green inside her own drop shadow | `disco1.png` vs `disco2.png` |

---

## 2. WHAT WAS BUILT

### `assets/grip.js` — NEW. Making a hand HOLD a thing (any Mixamo rig)
- `setHandOrientation(bones, side, fingerDir, thumbDir)` — turns the wrist after IK so the palm faces the prop.
- `curlFingers(bones, restQ, side, amount)` — closes Index/Middle/Ring/Pinky 1–3 and folds the thumb ACROSS.
- `wristFor(bones, side, propPoint, fingerDir, thumbDir, along, off)` — where the wrist must be for the prop to sit in the palm. **Props are positioned FROM the hand's pose every frame; they are NEVER parented to a bone.**
- `grip(...)` = orientation + curl in one call.

Measured on Michelle (and it is the Mixamo convention): hand local **+Y = fingers**, **+Z = out of the palm**, **±X = thumb side** (read off `Thumb1.position.x`, not assumed). Finger curl = **+X** rotation on each finger bone. Thumb: +X folds it in, **+Z sweeps it across** (Thumb1 +Z took the tip from x=6.7 → 2.1 in hand space; the first guess had the sign wrong and gave a thumbs-up).

### `assets/lab-action.js` — NEW (V2 of `unicorn-actions.js` testTubeAction, which is untouched)
`planLab(t, ctx)` — the **props are the authority**: for every instant it says where the tube and the jug ARE and derives each hand's wrist/fingers/thumb/curl from that. The jug's pose is defined by its **LIP** and its tilt, so the stream always leaves the lip and lands in the mouth. Timeline is the exported `T` table (8.2 s): reach → close → lift → tilt → fill → untilt → jug down → present → release.

### `lab.html` — rebuilt on the above (v1 vaulted at `.work/lab-v1-before-grip.html`)
- Idle = the plan at t=0: arms at rest, props at home. Never a T-pose.
- Tube home `(-0.14, bench, -0.24)` on her RIGHT for the right hand; jug `(+0.24, …)` on her left. 0.34–0.40 m from the reaching shoulder.
- Lab coat defaults **off** (the primitives read as paint on her; the button still works).
- Glass `transmission 0.35`.
- `window.__lab`: `freeze(t)`, `seek(t)`, `view(angle, dist, height)`, `snap()` (now includes `tubeSize`, `jugSize`, `rightErr/leftErr`, `loopErr`).
- Verified end-to-end headless: play runs to `t=8.39 done`, "Do it again" resets the tube to home and the water to 0, `loopErr: null`. Hand error 0.000 m both hands at every sampled moment.

### `studio.html` — rebuilt (v1 vaulted at `.work/studio-v1-before-grip.html`)
- **Drop a hand's disc on a prop's disc and she takes hold** (judged on screen, which is what you can see; depth is the one thing a mouse cannot tell you). The prop's button lights while you hover.
- Holding = the prop hangs from the hand's disc via `grip.js`: wrist turned, fingers closed, prop in the palm. **Drag the hand and the prop comes with it.** The held prop's own disc hides; "✋ Holding the tube / beaker" buttons let go.
- Both hands: right ↔ tube, left ↔ beaker. Keys store `grip` and `gripJ`.
- Hands start READY in front of her above the bench, not in a T-pose. Elbows break **outward** (v1 had the right elbow breaking inward — `+0.4` on X for the right arm, which is her LEFT).
- Free hands: fingers continue the line of the forearm, thumb up, 20% curl — no flat palms.
- `window.__studio.api`: `grip(v)`, `gripJ(v)`, `setHandle`, `addKey`, `seek`, `view`, `report()` (now with `holding`, `tubeSize`, `jugSize`).
- Verified headless with real mouse drags (`scratchpad/drag2.js`): hand→tube snaps and holds; hand→beaker snaps; lifting the hand carries the tube; 3 keys play and seek with both held.

### `disco.html` — key on **greenness** (`g - max(r,b)`), fade the fringe, despill. Pools gone.

### `scripts/shoot.js` — `--eval` output limit 300 → 6000 chars (it was truncating every `snap()`).

---

## 3. HOW TO SEE IT (the only way to know)

```bash
# idle, then four moments of the action
node scripts/shoot.js "http://localhost:8080/lab?fast=1" out.png --wait 5000 --eval "JSON.stringify(window.__lab.snap())"
node scripts/shoot.js "http://localhost:8080/lab?fast=1" out.png --wait 5000 --after 1500 \
  --eval "(async()=>{window.__lab.freeze(4.4); await new Promise(r=>setTimeout(r,1200)); return JSON.stringify(window.__lab.snap());})()"
# close-up of the grip
 ... --eval "(async()=>{window.__lab.freeze(2.8); window.__lab.view(0.3,0.9,1.25); await new Promise(r=>setTimeout(r,1200)); return 'ok';})()"
# studio: real mouse drags — copy scratchpad/drag2.js (in this session's scratchpad) if it is gone
```
If `tubeSize` ever reads millimetres again, something parented a prop to a bone. Don't.

---

## 4. STATE OF THE REPO — READ THIS

**None of the 3D work is committed or deployed** — not GANNET's, not this. `lab.html`, `studio.html`, `assets/ik.js`, `assets/grip.js`, `assets/lab-action.js`, `assets/models/` (≈100 MB of GLBs), `assets/vendor/`, the `PUBLIC_PATHS` change in `server/index.js` — all untracked/uncommitted on `main`. Live `https://www.quotem-ai.co.uk/lab` returns 401 and would 404 after login. **The lab exists only on Sarah's machine at `http://localhost:8080/lab` and `/studio`.** If she opens the live URL she gets nothing — that alone could be "we can't make it work".

Before committing: `assets/models/` is ~100 MB (seven raw Tripo GLBs that nothing loads). Commit `michelle.glb`, `xbot.glb`, `unicorn-fixb.glb` and the vendor/assets/pages; keep the raw ones out or in `.work/`. Not done — it is her call (push = Railway deploy of the Q app).

---

## 5. NEXT

1. **Sarah drives `/studio` and `/lab` on localhost** and says what is still wrong. She has not seen this yet.
2. She confirms exam board + level for `assets/chem-tests.js` (still unverified, still gating).
3. Wire a test: the dropdown picks a reagent from `chem-tests.js`, the pour happens, the tube shows the observation (precipitate colour / "dissolves in excess" as a second pour). `planLab` + `LIQUIDS` already give the mechanics; `water` material colour + a cloudy material for precipitates is the remaining work.
4. Decide what to commit (see §4).
5. A real character with a face is still the wall (GANNET §8). Nothing here changes that; everything here survives a character swap because it is written on bone names.
