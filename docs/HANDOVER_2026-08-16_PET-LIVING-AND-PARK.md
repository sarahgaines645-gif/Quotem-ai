# HANDOVER — 16 Aug 2026 (late) — THE PET: living, moving, playing with other pets

**Repo `quotem-ai`, branch `main`, push = Railway. Live: `cd5d1a5`.**
Follows `HANDOVER_2026-08-16_ROWAN_FINANCE-REVISE-PET.md` (Rowan). Another session
shares this tree (writer work, `ba4d8bb`) — commit by path.

## What Sarah asked (her words)
"A basic virtual pet that can actually be a living pet that children can keep
alive and it moves and plays with other pets. I don't believe it will cost me
£500 to do this."

**She was right.** The £1.2–1.8k figure was for an animator to redraw the pets
as rigged cartoons. The art she already has (generated last night, ≈$4) is
good and the engine runs it. What was missing was code — this handover is that
code. Art spend this session: £0.

## Shipped in `cd5d1a5`

1. **BUG — the pet reset on every visit.** `loadProgress` in `revise.html`
   restored settings/history/streak/quiz/ui but never `pet`. Server saved it
   (`routes.js` POST /revision/progress writes the whole body); the page threw
   it away on load → "pick an egg" every time. Now `pet.hydrate(d.pet)`
   sanitises and restores it. Verified: seeded a book with a capybara at 42
   right → page loaded "Pip", bow on, 2 treats.

2. **LIVING (keep it alive).** `progress.pet` gained `fed` (0–100),
   `hungrySince`, `park`.
   - `settle()` — runs at mount, every 60s (`tick`), and on tab-return.
     Tummy empties at 2.8/hour (full → empty ≈ 36h; ×0.35 while asleep in its
     bed). Happiness still drifts −2/h, floor 35.
   - `fed < 30` → **hungry**: pet sits at the front, thought-bubble with its
     food, card line "hungry — feed X" (or "get one right for a treat" if no
     treats), treat button gets `.urge` (gentle bob). No wandering.
   - empty for 12h → **poorly**: lies down (sleep frame, alpha .82) with a 💧,
     ball button dimmed and refuses, card "🤒 poorly — needs feeding".
   - Feed = +30 fed, +8 happy; reaching 30 clears `hungrySince` → well again
     ("X is feeling better 💛"). Feed ignored while an animation runs (no
     double-spend). Treats come only from right answers → the loop is:
     revise → treat → feed → well. **Never dies** (my call — a pet that dies
     because a child didn't revise for a week makes them quit the app; state
     it if she wants stakes harder than "poorly").
   - Hatch resets fed to 100.
   - Timings: a child who visits daily never sees hungry; 2 days away →
     hungry; ~3 days → poorly.

3. **THE PARK (plays with other pets).**
   - Server `routes.js`: `POST /revision/park` `{action: create|join|ping|leave,
     code?, pet?}` behind `requirePerson`. Park file `q-park-<code>.json` on the
     volume (`memory.js getParkPath`). Code = `word-animal-NN`
     (`sunny-otter-27`, 16×16×90 combos, collision-checked). Members keyed by an
     opaque sha of person id (never the id). Snapshot = name·kind·stage·wearing·
     mood only, sanitised (`cleanPetSnapshot`: whitelist kinds/wear/mood, name
     stripped to letters/digits/space/'/-, 18 chars). 12 members max; a member
     unseen for 30 days drops out of `friends`; last leaver deletes the file.
     Verified with two test people by curl (create/join/ping/leave, junk
     stripped, 401 without cookie).
   - Client (`pet` module): `parkPing` every 25s while `!document.hidden`
     (and on visibilitychange) — posts snapshot, receives friends → `setFriends`
     keeps each friend's behaviour state by id. 404 → leaves the park quietly
     with a toast. Panel is INSIDE the card (`#pet-park`, opened by 🏞): make a
     park / join with a code (inline input, no window.prompt) / code + who's
     here / leave. `renderPark(force)` won't wipe a half-typed code.
   - Verified live in-page: page made a park, Kid B joined by curl, page
     showed "Biscuit the hamster" (grown, hat) in the scene and the card
     widened. (Headless Edge flips `document.hidden` after ~20s so the 25s
     poll skipped in the harness — a real front tab never does; the
     visibilitychange path proved the poll itself.)

4. **ENGINE → actors.** The singleton `beh` became `me` + `friends[]` (up to
   `SHOW_FRIENDS = 3` drawn; the rest named on the card). `step(actor)` and
   `drawActor(actor)` per pet, drawn back-to-front by y. Friends wander, hop
   over to say hello (`visit` → `greet`: both hop, hearts), chase the ball with
   you (staggered), sleep if asleep at home, poorly if poorly, name under
   them. Everyone 0.82× when company is in; `.pet-card.park { width: 300px }`,
   canvas sizes itself to the card (`fit()`). Lab (`/revise?petlab=1`) has
   hungry/poorly/fed, +🐶/+🐹/+🦫/no friends, and `window.__pet`.

5. **The 48 sheets she paused on are SHIPPED** (`assets/pet/sheet_*` — hamster,
   capybara, puppy young/grown, 720px). Engine picks them up by name. Repo
   `assets/pet` is now 15MB; sheets load lazily per pet+stage.

## Honest state / open
- **Slicer frame counts vary** (2–6 per sheet; e.g. capy young run_side 2, ham
  grown run_side 2, puppy baby run_side 3). That's last night's `sliceSheet`
  on sheets whose frames touch/run off the edge — it keeps whatever complete
  frames it finds. A 2-frame run cycle animates but flaps. Fix = better
  slicing of the 1024 originals in `pet-art-generated/originals-1024`, or
  regenerate the weak sheets with wider gaps (~$0.10 each). Not a code bug.
- Park codes are guessable by a logged-in user (23k combos). Only pet names
  leak and members cap at 12. Add a per-person rate limit if it ever matters.
- Children may type their own name as the pet's name → shared with park
  members only (people they gave the code to).
- Not built: pets visiting each other's screens live in real time (it's a
  25s poll, which is right for this); trading/gifting; more than 3 in scene.

## Test recipe (local, no Railway)
Scratch data dir + two test people + minted cookies + headless Edge over CDP:
`scratchpad/shot.js`, `cookie.js`, `joinB.sh` in this session's scratchpad.
Server: `RAILWAY_VOLUME_MOUNT_PATH=<scratch>/vol Q_AUTH_PEPPER=<16+> EMAIL_TOKEN_KEY=<16+> PORT=8099 node server/index.js`
(setting a RAILWAY_* var flips IS_PRODUCTION, hence the two keys).

---

## 17 Aug — THE RIG (`39b5359`) — supersedes the picture/sheet route

Sarah: "I want an interactive pet, not videos — millions of games do this." and
"I don't like the ones we have." She said NO to any spend (video clips, part
sheets). So the pets are now **drawn in code and rigged** — `drawRig()` in
`revise.html`, RIG table per pet, STAGE_PROP per stage, `pose` per act (see
commit body). Eyes follow the pointer, click = pat, tail wags on hover. The PNG
art + sprite sheets are the FALLBACK (`RIG_ON`, lab button "art: rig/pictures").
Verified in the lab: idle/run/jump/beg/poorly/eat/approach/lick/dressed for
puppy, hamster, capybara (contact sheets in the session scratchpad).

**Do NOT go back to generating sheets or proposing video.** The look is shapes:
change colours/ears/proportions in the RIG table. Next quality steps if she wants
them: soft shading (a second darker ellipse on body/head), an idle "sit → stand →
stretch" cycle, walk (slower gait) vs run, a shake, a roll-over, tail visible in
front view for all kinds, accessories drawn in the same vector style (currently
still the item PNGs on top).

## 17 Aug (later) — APPY IS THE CHARACTER (`a95a980`)

My drawn dog/hamster/capybara were rejected ("scary", "creepy"). Then Sarah:
*"what about appy? he's the original thing we made to represent the apps."*

Appy (`Quoteapp/client/public/assets/appy-idle.jpg`, `-happy`, `-shocked`,
`-talking`, `-blink-half/full`; driven by `client/src/components/AppyAvatar.jsx`
as swapped JPEGs + a CSS breathe) is a **white fluffy BALL**: huge glossy eyes
with two highlights and lashes, tiny pink nose, tiny mouth, blush, two little
pink feet, no anatomy at all.

**The lesson: a ball is the right shape.** It squashes, bounces, rolls and
wobbles — everything code does well — and it hits the baby schema without
needing anatomy. The revise pets are now Appy's family, drawn in code:
snow / butter / lilac (the saved `kind` keys puppy/hamster/capybara are kept so
existing pets still load). Fur = 96-point fine serrated edge + 3-pass halo + 34
wisps + ambient shadow; face low on the ball; every act is squash-and-stretch.
Friends spawn in lanes and push apart so they never stack.

If a bought character is ever wanted: the industry route is **Rive** (Duolingo's
tool) — state machines, ~50KB .riv files, web runtime by script tag; community
files are CC BY 4.0 (free, credit required), marketplace files a few pounds.
**Nothing has been spent.**
