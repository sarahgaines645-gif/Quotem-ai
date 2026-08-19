/* ACTIONS — the unicorn DOING things, not just dancing.
 *
 * This is the thing a rig buys you that a generated video cannot. A clip shows
 * one performance; an action is a function of time, so it can be triggered when
 * a lesson reaches the right question, with a different liquid, a different
 * prop, at a different moment, for as long as you like, at no cost per use.
 *
 * Same contract as the dance: a pure function from SECONDS to a pose, keyed on
 * bone names, plus a little state for the props. Nothing is retargeted, nothing
 * is baked, everything is a number.
 *
 * Angles are radians, applied on top of each bone's rest pose in its own local
 * space. Written for a Mixamo-named skeleton (arms: Shoulder/Arm/ForeArm/Hand).
 */

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));   // smoothstep
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a, b, t) => a + (b - a) * t;

/* PICK UP THE TEST TUBE AND FILL IT.
 *
 *   0.0-1.2  reach down and across to the bench
 *   1.2-1.6  close the hand on it (the prop becomes the hand's child here)
 *   1.6-2.6  lift it up to eye level, turn to look at it
 *   2.6-5.2  fill it — the other hand tips the jug, the level climbs
 *   5.2-7.0  hold it up and look pleased with herself
 *
 * Returns { pose, held, fill, look } —
 *   pose  bone angles, same shape as the dance
 *   held  true once the tube should be parented to the hand
 *   fill  0..1, how full the tube is
 *   look  0..1, how much she is turned towards the tube
 */
export function testTubeAction(t, opts = {}) {
  const o = Object.assign({ reach: 1.0, lift: 1.0, hand: 'Right' }, opts);
  const pose = {};
  const set = (n, x, y, z) => { pose[n] = [x, y, z]; };

  const H = o.hand;                       // the working hand
  const O = H === 'Right' ? 'Left' : 'Right';   // the other one (jug)
  const dir = H === 'Right' ? -1 : 1;     // which way that arm swings

  const reach = ease(clamp01(t / 1.2));
  const grab = ease(clamp01((t - 1.2) / 0.4));
  const lift = ease(clamp01((t - 1.6) / 1.0));
  const pour = ease(clamp01((t - 2.6) / 0.6));
  const fill = ease(clamp01((t - 2.9) / 2.0));
  const done = ease(clamp01((t - 5.2) / 0.8));

  /* THE WORKING ARM.
     From the T-pose the arm has to come down and forward to reach a bench, then
     fold at the elbow to bring the tube up to her face. The elbow does most of
     the work — a straight arm swinging up from the shoulder looks like a barrier
     going up, not like a person lifting something to look at it. */
  const armDown = lerp(0, 1.15, reach) - lerp(0, 0.35, lift);
  const armIn = lerp(1.25, 0.55, reach * o.reach) - lerp(0, 0.15, lift);
  const elbow = lerp(0.1, 0.35, reach) + lerp(0, 1.45, lift) * o.lift;

  set(H + 'Shoulder', 0, 0, dir * (0.1 + lift * 0.25));
  set(H + 'Arm', -armDown, dir * (0.35 * reach + 0.25 * lift), dir * armIn);
  set(H + 'ForeArm', -elbow, dir * 0.25 * lift, dir * (0.5 - 0.3 * lift));
  set(H + 'Hand', 0, 0, dir * (0.15 - grab * 0.1 + lift * 0.35));

  /* THE OTHER ARM brings the jug across and tips it, then drops away. */
  const jug = pour * (1 - done * 0.9);
  set(O + 'Shoulder', 0, 0, -dir * (0.05 + jug * 0.2));
  set(O + 'Arm', -lerp(0.2, 1.05, jug), -dir * 0.3 * jug, -dir * lerp(1.25, 0.62, jug));
  set(O + 'ForeArm', -lerp(0.15, 1.25, jug), 0, -dir * 0.45);
  set(O + 'Hand', -jug * 0.6, 0, 0);        // the tip of the wrist that pours

  /* THE BODY. She leans down to reach, straightens to look, and at the end
     lifts the tube and her chin together — the small human touch that makes it
     read as pride rather than as a mechanism finishing its cycle. */
  const lean = reach * (1 - lift);
  set('Hips', lean * 0.12, 0, 0);
  set('Spine', lean * 0.18 - done * 0.05, dir * -0.10 * lift, 0);
  set('Spine1', lean * 0.12, dir * -0.08 * lift, 0);
  set('Spine2', lean * 0.06, dir * -0.06 * lift, 0);
  set('Neck', lerp(0.25, -0.12, lift) * (1 - done * 0.3), dir * -0.12 * lift, 0);
  set('Head', lerp(0.3, -0.18, lift) - done * 0.12, dir * -0.18 * lift, 0);

  // a little weight shift so she is not standing to attention
  set('LeftUpLeg', 0.04 * reach, 0, 0.05);
  set('RightUpLeg', 0.02 * reach, 0, -0.05);
  set('LeftLeg', -0.10 * reach, 0, 0);
  set('RightLeg', -0.06 * reach, 0, 0);

  return {
    pose,
    held: t >= 1.45,
    fill,
    look: lift,
    hand: H,
    duration: 7.0,
  };
}

/* What the liquid should look like. Named so a lesson can ask for one by name
   rather than a hex code appearing in the page. */
export const LIQUIDS = {
  water:    { colour: 0x6fd6ff, fizzy: false },
  acid:     { colour: 0xd8ff5a, fizzy: true },
  iodine:   { colour: 0x8a5a2b, fizzy: false },
  copper:   { colour: 0x2ec8ff, fizzy: false },
  potassium:{ colour: 0xc86bff, fizzy: true },
};
