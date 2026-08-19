/* THE LAB ACTION, V2 — she picks up a test tube, pours into it, shows it.
 *
 * V1 (`unicorn-actions.js` testTubeAction) authored the ARMS as angles and had
 * the page override them with IK afterwards; the two fought, the wrist stayed
 * an open palm, and the tube was parented to a bone (and shrank to 2.6mm).
 *
 * V2 is built the other way up: the PROPS are the authority. For every moment
 * this says where the tube and the jug ARE, and derives from that where each
 * wrist must be and how each hand must be turned to be holding them. The page
 * then solves the arms with IK (`ik.js`) and closes the hands (`grip.js`).
 * Nothing is parented, nothing is guessed, and the same plan drives any
 * Mixamo-named character — only the shoulder positions change, and they are
 * read off the skeleton, not assumed.
 *
 * Everything is a pure function of time, so a screenshot can land on an exact
 * instant and a lesson can trigger it whenever it likes.
 *
 *   planLab(t, ctx) -> {
 *     pose,                      body angles by bone name (no arms, no hands)
 *     tube: {pos, mouth},        world position of the tube's BASE (upright) and its mouth
 *     jug:  {pos, tilt, lip},    world position of the jug's BASE, tilt (rad about +Z), lip point
 *     right: {...}, left: {...}  each hand's job — see below
 *     fill, pouring, held, phase, duration
 *   }
 *
 * ctx = { shoulderR, shoulderL (world Vector3), tubeHome, jugHome (world, base),
 *         TUBE_H, TUBE_R, JUG_H, JUG_R, THREE }
 */
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const seg = (t, a, b) => ease((t - a) / (b - a));

/* The timeline. Named so the page's debug line and a lesson can speak about
   it without magic numbers. */
export const T = {
  reach: [0.0, 1.3],    // hands go from rest to the props
  close: [1.3, 1.7],    // fingers close
  lift:  [1.7, 2.8],    // tube to the hold point, jug up beside it
  tilt:  [2.8, 3.4],    // jug tips, lip over the mouth
  fill:  [3.2, 5.4],    // liquid climbs
  untilt:[5.4, 5.9],
  down:  [5.9, 7.0],    // jug back to the bench
  present:[5.7, 7.2],   // tube up to where she (and the camera) can see it
  release:[7.0, 7.4],   // left hand lets go
  end: 8.2,
};

/* Grip geometry — how far the fist centre sits from the wrist, in metres.
   Michelle's hand is ~0.18m long; a 3cm tube sits in the middle of the palm. */
export const GRIP = {
  tube: { along: 0.045, off: 0.032, up: 0.40 },     // `up` = fraction of the prop's height where the fist closes
  jug:  { along: 0.02,  off: 0.022, up: 0.45 },     // `off` is measured from the jug's WALL
};

export function planLab(t, ctx) {
  const V = ctx.THREE.Vector3;
  const v = (x, y, z) => new V(x, y, z);
  const { shoulderR, shoulderL, tubeHome, jugHome, TUBE_H, JUG_H, JUG_R } = ctx;

  const reach = seg(t, ...T.reach);
  const close = seg(t, ...T.close);
  const lift = seg(t, ...T.lift);
  const tilt = seg(t, ...T.tilt) * (1 - seg(t, ...T.untilt));
  const fill = seg(t, ...T.fill);
  const down = seg(t, ...T.down);
  const present = seg(t, ...T.present);
  const release = seg(t, ...T.release);

  /* ── hand directions (world) ─────────────────────────────────────────── */
  // resting: hanging, fingers down, thumbs forward
  const restFR = v(0, -1, 0.15), restTh = v(0, 0, 1);
  // holding the tube: fingers across the body and a little back, thumb up —
  // knuckles to the camera, the tube rises out of the top of the fist
  const tubeFR = v(1, 0.05, -0.35), tubeTh = v(0.2, 1, 0.15);
  // holding the jug with the left: mirror of that
  const jugFL = v(-1, 0.05, -0.35), jugTh = v(-0.2, 1, 0.15);

  /* ── where the props are ─────────────────────────────────────────────── */
  // the tube: bench -> hold point in front of the chest -> up to show it
  const holdGrip = shoulderR.clone().add(v(0.13, -0.17, 0.27));          // where the fist is when holding
  const showGrip = shoulderR.clone().add(v(0.05, 0.02, 0.30));
  const tubeGripHome = tubeHome.clone().add(v(0, TUBE_H * GRIP.tube.up, 0));
  const tubeGrip = tubeGripHome.clone().lerp(holdGrip, lift).lerp(showGrip, present);
  const tubePos = tubeGrip.clone().sub(v(0, TUBE_H * GRIP.tube.up, 0));
  const tubeMouth = tubePos.clone().add(v(0, TUBE_H, 0));

  // the jug: bench -> hanging beside the tube's mouth -> tipped over it -> back down.
  // Its pose is defined by where its LIP is and how far it is tipped; the
  // base position falls out of that, so the stream always leaves the lip and
  // lands in the mouth whatever else moves.
  const lipLocal = v(-JUG_R, JUG_H, 0);                                 // the pouring lip, jug space
  const lipBeside = tubeMouth.clone().add(v(0.12, 0.06, 0.0));
  const lipOver = tubeMouth.clone().add(v(0.0, 0.055, 0.0));
  const lipUp = lipBeside.clone().lerp(lipOver, tilt);
  const jugTilt = tilt * 1.15;
  const rotZ = new ctx.THREE.Quaternion().setFromAxisAngle(v(0, 0, 1), jugTilt);
  let jugPos;
  {
    const upPos = lipUp.clone().sub(lipLocal.clone().applyQuaternion(rotZ)); // base, when up
    const a = jugHome.clone().lerp(upPos, lift);                             // lift from home,
    jugPos = a.lerp(jugHome, down);                                          // and later back down to home
  }
  const jugTiltNow = jugTilt * (1 - down);                                  // tilt only while up
  const rotNow = new ctx.THREE.Quaternion().setFromAxisAngle(v(0, 0, 1), jugTiltNow);
  const jugGrip = jugPos.clone().add(v(0, JUG_H * GRIP.jug.up, 0).applyQuaternion(rotNow)); // the fist centre, on the jug's axis

  /* ── the hands ───────────────────────────────────────────────────────── */
  const restR = shoulderR.clone().add(v(-0.06, -0.42, 0.10));
  const restL = shoulderL.clone().add(v(0.06, -0.42, 0.10));

  // right: rest -> tube grip (and it stays on the tube from then on)
  const right = {
    fingers: restFR.clone().lerp(tubeFR, reach).normalize(),
    thumb: restTh.clone().lerp(tubeTh, reach).normalize(),
    curl: 0.15 + 0.85 * close,
    grip: tubeGrip, along: GRIP.tube.along, off: GRIP.tube.off,
    wristRest: restR, attach: reach,       // attach 0..1: wrist lerps from rest to the grip-derived point
  };
  // left: rest -> jug grip -> (follows the jug, rotating with the tilt) -> rest
  const fL = jugFL.clone().applyQuaternion(rotNow), thL = jugTh.clone().applyQuaternion(rotNow);
  const left = {
    fingers: restFR.clone().lerp(fL, reach).lerp(restFR, release).normalize(),
    thumb: restTh.clone().lerp(thL, reach).lerp(restTh, release).normalize(),
    curl: (0.15 + 0.85 * close) * (1 - release),
    grip: jugGrip, along: GRIP.jug.along, off: JUG_R + GRIP.jug.off,
    wristRest: restL, attach: reach * (1 - release),
  };

  /* ── the body ────────────────────────────────────────────────────────── */
  const pose = {};
  const set = (n, x, y, z) => { pose[n] = [x, y, z]; };
  const lean = reach * (1 - lift);                 // bends to the bench, straightens as she lifts
  const look = lift * (1 - present * 0.5);          // looks at the tube in her hand
  set('Hips', 0.06 * lean, 0, 0);
  set('Spine', 0.16 * lean + 0.04 * look, 0, 0);
  set('Spine1', 0.10 * lean + 0.03 * look, 0, 0);
  set('Spine2', 0.06 * lean, 0, 0);
  set('Neck', 0.22 * lean + 0.18 * look - 0.10 * present, -0.10 * look, 0);
  set('Head', 0.26 * lean + 0.22 * look - 0.14 * present, -0.14 * look, 0.05 * look);
  set('RightShoulder', 0, 0, 0.08 * reach + 0.10 * lift);
  set('LeftShoulder', 0, 0, -(0.08 * reach + 0.10 * lift) * (1 - release));
  set('LeftUpLeg', 0.03 * lean, 0, 0.04);
  set('RightUpLeg', 0.02 * lean, 0, -0.04);
  set('LeftLeg', -0.07 * lean, 0, 0);
  set('RightLeg', -0.05 * lean, 0, 0);

  const phase = t < T.reach[1] ? 'reaching' : t < T.close[1] ? 'taking hold'
    : t < T.lift[1] ? 'lifting' : t < T.tilt[1] ? 'tipping the jug' : t < T.fill[1] ? 'pouring'
    : t < T.down[1] ? 'putting the jug down' : t < T.present[1] ? 'showing you' : 'done';

  return {
    pose,
    tube: { pos: tubePos, mouth: tubeMouth },
    jug: { pos: jugPos, tilt: jugTiltNow, lip: lipLocal.clone().applyQuaternion(rotNow).add(jugPos) },
    right, left,
    fill,
    pouring: fill > 0.02 && fill < 0.98,
    held: close > 0.5,
    phase,
    duration: T.end,
  };
}
