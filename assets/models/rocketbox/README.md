# Microsoft Rocketbox — "Lab teacher"

`Medical_Female_01_facial.fbx` and its textures come from
**[Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox)** —
115 professionally rigged adult avatars, released by Microsoft under the
**MIT licence** (see `LICENSE-Rocketbox.md`). MIT means these can ship inside a
product we sell; that is why this one is committed and the Mixamo and pixiv
characters are not (see `.gitignore`).

## Why this avatar

- a realistic adult woman in a lab coat, **no glasses** — reads as a teacher
- **175 facial blendshapes**: the full ARKit set *and* 15 speech visemes
- real jaw, lip and tongue bones on top of the blendshapes
- 81 bones, mapped to our standard names by `assets/rig-map.js` (source `biped`)

## Two things that will bite the next person

1. **The skeleton is 3ds Max BIPED, not Mixamo.** `Bip01_L_UpperArm`,
   `Bip01_L_Forearm`, and fingers NUMBERED not named — `Finger0x` is the THUMB,
   then 1x index, 2x middle, 3x ring, 4x little. `rig-map.js` holds the table.
2. **The textures are `.tga`, which no browser decodes.** Without
   `assets/vendor/TGALoader.js` registered on the LoadingManager, FBXLoader
   quietly substitutes blank placeholders — she loads perfectly and renders as
   a grey mannequin, with nothing in the console to tell you why.

## Not included

`f152_body_normal.tga`, `f152_head_normal.tga` and the specular maps were left
out — they are 12MB each and only add surface detail. The page logs a 404 for
them; harmless. Fetch them from the same repo path if she looks flat.
