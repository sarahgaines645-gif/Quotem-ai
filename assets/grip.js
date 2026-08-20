/* GRIP — making a hand actually HOLD a thing.
 *
 * IK puts the wrist at a point. That is not holding: the hand arrives as a
 * flat open palm at whatever roll the forearm happened to give it, and a prop
 * "in the hand" is a prop floating next to a wrist. Three things turn that
 * into a grip, all written on Mixamo bone names so they work on any character:
 *
 *   1. the WRIST is oriented — fingers pointing one way, thumb another, so the
 *      palm faces the prop;
 *   2. the FINGERS close round it — and STOP WHERE THEY TOUCH IT (closeOn), so a
 *      3cm tube gets a tight fist and a 10cm cup an open one;
 *   3. the PROP is placed in the palm from those same directions — wrist +
 *      a little along the fingers + a little off the palm — so hand and prop
 *      agree by construction, not by eye.
 *
 * ⚠️ PROPS ARE NEVER PARENTED TO A BONE. A child of a bone lives in that bone's
 * space — Michelle's is centimetres under a 0.01 root, so a 20cm tube parented
 * to her hand came out 2.6mm tall: "she picks it up" and it vanished. The prop
 * stays in the scene and is POSITIONED each frame from the hand's world pose.
 *
 * ⚠️ THE HAND'S LOCAL AXES ARE MEASURED, NOT ASSUMED. Michelle's hand runs
 * along local +Y with the palm on +Z and the thumb on ±X. Xbot's runs along
 * local -X with the palm on -Y and the thumb on +Z. Both are "Mixamo" rigs.
 * handFrame() reads the finger and thumb bone positions and works out which
 * axis is which — once per rig — and everything below uses that frame.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _ml = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _t = new THREE.Vector3();
const _tip = new THREE.Vector3(), _ax = new THREE.Vector3(), _d = new THREE.Vector3();

const key = (b) => b.name.replace(/^mixamorig\d*:?/, '');
const dominant = (v) => {          // the unit axis (with sign) a vector mostly points along
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(v.x) || 1, 0, 0);
  if (ay >= az) return new THREE.Vector3(0, Math.sign(v.y) || 1, 0);
  return new THREE.Vector3(0, 0, Math.sign(v.z) || 1);
};

/* BUILD THE BONE MAP FROM THE HIERARCHY — NOT FROM `skeleton.bones`.
 *
 * ⚠️ A Mixamo FBX can contain SEVERAL nodes carrying the same bone name, stacked
 * one inside the other. Claire has THREE `mixamorigRightHand`. `skeleton.bones`
 * lists the innermost, which is a childless leaf: rotating it moves nothing at
 * all. Measured on her rig — rotating `RightArm` moved the hand by 0.000m, and
 * "RightArm is an ancestor of RightHand" came back FALSE. Every arm sat in its
 * T-pose while the IK reported success, because the IK was writing to dead ends.
 *
 * The node that actually drives a limb is the one nearest the ROOT, since every
 * duplicate and every child bone hangs beneath it. traverse() is depth-first
 * pre-order, so the first of each name is the shallowest. Skinning still works:
 * the leaves are descendants and come along for the ride.
 *
 * On a rig without duplicates (Michelle, Xbot) this returns exactly what
 * iterating skeleton.bones did.
 */
export function boneMap(root) {
  const bones = {}, restQ = {};
  root.traverse((o) => {
    if (!o.isBone) return;
    const k = o.name.replace(/^mixamorig\d*:?/, '');
    if (!k || bones[k]) return;
    bones[k] = o; restQ[k] = o.quaternion.clone();
  });
  return { bones, restQ };
}

/* THE HAND FRAME, in the hand bone's local space:
     F  = along the fingers        (a finger's child sits along it)
     Tm = the thumb side           (Thumb1 sits off the finger line that way)
     P  = out of the palm          (the smaller part of Thumb1's offset — the
                                    thumb root sits slightly palm-side)
     hand = +1 / -1, the handedness of (F, Tm, P) so a world target can match it
   Cached on the hand bone. */
export function handFrame(bones, side) {
  const hand = bones[side + 'Hand'];
  if (!hand) return null;
  if (hand.userData.frame) return hand.userData.frame;

  /* ⚠️ BUILT FROM WORLD POSITIONS, NEVER FROM `bone.position`.
     A Mixamo FBX can arrive with every bone's LOCAL position set to zero — the
     real transforms baked into matrices on duplicated parent nodes of the same
     name. Reading `child.position` then returns (0,0,0) for everything, the
     frame collapses (Claire came out with "along the fingers" and "thumb side"
     as the SAME axis), and every grip built on it is nonsense. World positions
     are correct on every rig, so they are the only safe source. */
  const wpos = (b) => { b.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld); };
  const toLocal = (v) => {                       // a world DIRECTION into the hand's own space
    const q = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    return v.clone().applyQuaternion(q).normalize();
  };
  const handW = wpos(hand);
  const mid1 = bones[side + 'HandMiddle1'] || bones[side + 'HandIndex1'];
  const idx1 = bones[side + 'HandIndex1'] || bones[side + 'HandMiddle1'];
  const pky1 = bones[side + 'HandPinky1'] || bones[side + 'HandRing1'];
  const th = bones[side + 'HandThumb1'];

  let F, Tm, P;
  /* along the fingers: wrist -> middle knuckle */
  F = mid1 ? dominant(toLocal(wpos(mid1).sub(handW))) : new THREE.Vector3(0, 1, 0);
  /* ACROSS the palm: pinky knuckle -> index knuckle. Two well-separated bones,
     so unlike the thumb they can never collapse onto the finger direction. */
  if (idx1 && pky1 && idx1 !== pky1) {
    const across = toLocal(wpos(idx1).sub(wpos(pky1)));
    across.addScaledVector(F, -across.dot(F));
    Tm = across.lengthSq() > 1e-8 ? dominant(across) : null;
  }
  if (!Tm && th) {                               // fall back to the thumb's offset
    const t = toLocal(wpos(th).sub(handW));
    t.addScaledVector(F, -t.dot(F));
    Tm = t.lengthSq() > 1e-8 ? dominant(t) : null;
  }
  if (!Tm || Math.abs(Tm.dot(F)) > 0.5) {        // still degenerate: any perpendicular will do
    Tm = Math.abs(F.x) > 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  }
  /* out of the palm = the third axis. Sign it by where the thumb actually sits:
     the thumb root leans to the palm side of the knuckle line. */
  P = new THREE.Vector3().crossVectors(F, Tm).normalize();
  P = dominant(P);
  if (th) {
    const t = toLocal(wpos(th).sub(handW));
    if (t.dot(P) < 0) P.multiplyScalar(-1);
  }
  const hand_ = Math.sign(P.dot(new THREE.Vector3().crossVectors(F, Tm))) || 1;
  // curl axis: rotating a finger about it carries F towards P
  const curlAxis = new THREE.Vector3().crossVectors(F, P).normalize();
  // thumb sweep axis (about the palm normal, towards the fingers); the thumb
  // FOLDS towards the palm about the same axis a finger curls about
  const sweepSign = Math.sign(new THREE.Vector3().crossVectors(P, Tm).dot(F)) || 1;
  const frame = { F, Tm, P, hand: hand_, curlAxis, sweepAxis: P.clone().multiplyScalar(sweepSign), foldAxis: curlAxis.clone() };
  hand.userData.frame = frame;
  return frame;
}

/* the world directions a hand will be given: fingers along `fingerDir`, thumb
   roughly along `thumbDir` (squared up), palm derived to match handedness */
function worldBasis(frame, fingerDir, thumbDir) {
  _y.copy(fingerDir).normalize();                                          // world F
  _x.copy(thumbDir).addScaledVector(_y, -_y.dot(thumbDir));                // world Tm, squared to F
  if (_x.lengthSq() < 1e-8) _x.set(0, 1, 0).addScaledVector(_y, -_y.y);
  _x.normalize();
  _z.crossVectors(_y, _x).multiplyScalar(frame.hand);                      // world P, same handedness as local
  return { fw: _y, tw: _x, pw: _z };
}

/* Point the hand. Call AFTER the IK, which reads the hand's position and
   leaves its rotation. */
export function setHandOrientation(bones, side, fingerDir, thumbDir) {
  const hand = bones[side + 'Hand'];
  const fr = handFrame(bones, side);
  if (!hand || !fr) return false;
  const { fw, tw, pw } = worldBasis(fr, fingerDir, thumbDir);
  _m.makeBasis(fw, tw, pw);                 // local-frame axes -> world
  _ml.makeBasis(fr.F, fr.Tm, fr.P);         // local-frame axes -> bone local
  _m.multiply(_ml.clone().transpose());     // bone local -> world
  _q.setFromRotationMatrix(_m);
  if (hand.parent) { hand.parent.getWorldQuaternion(_pq); _pq.invert(); _q.premultiply(_pq); }
  hand.quaternion.copy(_q);
  hand.updateMatrixWorld(true);
  return true;
}

/* HOW LONG THE PALM IS — wrist to the knuckles, in world metres. Measured off
   the rig, so it is right for a child, an adult or a 65-bone robot. */
export function palmLength(bones, side) {
  const hand = bones[side + 'Hand'];
  const knuckle = bones[side + 'HandMiddle1'] || bones[side + 'HandIndex1'];
  if (!hand || !knuckle) return 0.075;
  hand.updateWorldMatrix(true, false); knuckle.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld)
    .distanceTo(new THREE.Vector3().setFromMatrixPosition(knuckle.matrixWorld));
}

/* WHERE THE WRIST GOES so the prop ends up IN THE GRIP.
 *
 * ⚠️ The prop belongs at the KNUCKLES, not against the palm. Put it against the
 * palm — which is what a small `along` does — and the fingers close onto the
 * near FACE of it and stop there: measured on a 10cm cup, 0 of 5 fingertips got
 * past the centre line. It read exactly as Sarah described it: "she doesnt put
 * her hand around the cup". Sitting the prop at the knuckles lets the fingers
 * come round the side, which is what wrapping is.
 *
 * The two numbers are not guesses. Sweeping them over a grid and scoring how
 * many fingertips get past the cylinder's centre line picked the SAME pair for
 * a 16mm tube and a 50mm cup: 0.6 of the palm's length out along the fingers,
 * and 4mm off the palm. At that placement the cup goes from 0/4 fingers round
 * it to 3/4, and the tube holds 4/4. Pass along/off explicitly only to override.
 */
export const GRIP_ALONG = 0.6;        // fraction of the palm's length
export const GRIP_CLEAR = 0.004;      // metres of daylight between palm and surface

export function wristFor(bones, side, propPoint, fingerDir, thumbDir, along = null, off = null, radius = 0.02) {
  const fr = handFrame(bones, side);
  const { fw, pw } = worldBasis(fr, fingerDir, thumbDir);
  const a = along == null ? palmLength(bones, side) * GRIP_ALONG : along;
  const o = off == null ? radius + GRIP_CLEAR : off;
  return new THREE.Vector3().copy(propPoint).addScaledVector(fw, -a).addScaledVector(pw, -o);
}

/* ── closing the fingers ─────────────────────────────────────────────────── */
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const CURL = [1.05, 1.35, 0.85];                          // knuckle, middle, tip (radians at amount 1)
const THUMB_FOLD = [0.35, 0.5, 0.4], THUMB_SWEEP = 0.65;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

function setChainCurl(bones, restQ, side, f, a) {
  const fr = handFrame(bones, side);
  for (let i = 1; i <= 3; i++) {
    const b = bones[side + 'Hand' + f + i];
    if (!b || !restQ[key(b)]) continue;
    if (f === 'Thumb') {
      _qa.setFromAxisAngle(fr.foldAxis, THUMB_FOLD[i - 1] * a);
      if (i === 1) { _qb.setFromAxisAngle(fr.sweepAxis, THUMB_SWEEP * a); _qa.multiply(_qb); }
    } else {
      _qa.setFromAxisAngle(fr.curlAxis, CURL[i - 1] * a);
    }
    b.quaternion.copy(restQ[key(b)]).multiply(_qa);
  }
  const root = bones[side + 'Hand' + f + '1'];
  if (root) root.updateMatrixWorld(true);
}

/* Curl everything by `amount` 0..1 — a plain fist, no prop. */
export function curlFingers(bones, restQ, side, amount) {
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  [...FINGERS, 'Thumb'].forEach((f) => setChainCurl(bones, restQ, side, f, a));
}

/* the fingertip: the '4' end bone if the rig has one, else the last bone
   extended by its own length */
function fingerTip(bones, side, f, out) {
  const fr = handFrame(bones, side);
  const b4 = bones[side + 'Hand' + f + '4'], b3 = bones[side + 'Hand' + f + '3'];
  if (b4) { b4.updateMatrixWorld(true); return out.setFromMatrixPosition(b4.matrixWorld); }
  if (!b3) return null;
  b3.updateMatrixWorld(true);
  /* length measured in WORLD, not from b3.position — see handFrame: some rigs
     carry zero local positions and the transform lives in the matrices. */
  const b2 = bones[side + 'Hand' + f + '2'] || bones[side + 'Hand' + f + '1'];
  b2.updateMatrixWorld(true);
  const seg = new THREE.Vector3().setFromMatrixPosition(b3.matrixWorld)
    .distanceTo(new THREE.Vector3().setFromMatrixPosition(b2.matrixWorld)) || 0.02;
  const scale = new THREE.Vector3().setFromMatrixScale(b3.matrixWorld).x || 1;
  out.copy(fr.F).multiplyScalar(seg / scale).applyMatrix4(b3.matrixWorld);
  return out;
}
function distToAxis(p, axisPoint, axisDir) {
  _d.copy(p).sub(axisPoint);
  const along = _d.dot(axisDir);
  return Math.sqrt(Math.max(0, _d.lengthSq() - along * along));
}

/* CLOSE ON THE THING — each finger closes until its TIP reaches the prop's
   surface (a cylinder: a point on its axis, the axis direction, its radius)
   and no further. Bisection on the curl amount. `maxCurl` caps it, so a hand
   can be SHOWN closing: the fingers stop at the prop or at the cap, whichever
   comes first. Returns the per-finger curls used. */
export function closeOn(bones, restQ, side, axisPoint, axisDir, radius, maxCurl = 1, skin = 0.006) {
  const hand = bones[side + 'Hand'];
  if (!hand) return null;
  hand.updateWorldMatrix(true, false);
  _ax.copy(axisDir).normalize();
  const used = {};

  /* ⚠️ STOP AT PENETRATION, NOT AT FIRST TOUCH.
     Stopping the moment the fingertip reached the surface meant a finger could
     never travel ROUND anything — it grazed the near face and froze. Measured on
     a 10cm cup: every fingertip stopped short of the centre line, which is
     exactly "she doesnt put her hand around the cup". A finger wrapping a
     cylinder rides ALONG the surface at roughly the radius, so contact is not a
     stop condition; going meaningfully INSIDE is. */
  const deepest = (f) => {                     // how far inside the surface the worst joint is
    let worst = 0;
    /* THE THUMB IS JUDGED ON ITS TIP ALONE. Its lower joints sit right against
       the palm by construction, so with the prop resting 4mm off the palm they
       can read as "inside it" before the thumb has moved at all — and the thumb
       then refuses to close on anything. Only the pad actually presses. */
    if (f !== 'Thumb') {
      for (let i = 2; i <= 3; i++) {
        const b = bones[side + 'Hand' + f + i];
        if (!b) continue;
        b.updateMatrixWorld(true);
        _tip.setFromMatrixPosition(b.matrixWorld);
        worst = Math.max(worst, radius - distToAxis(_tip, axisPoint, _ax));
      }
    }
    if (fingerTip(bones, side, f, _tip)) worst = Math.max(worst, radius - distToAxis(_tip, axisPoint, _ax));
    return worst;                              // >0 means inside the prop
  };

  FINGERS.forEach((f) => {
    if (!bones[side + 'Hand' + f + '1']) return;
    let lo = 0, hi = maxCurl;
    setChainCurl(bones, restQ, side, f, hi);
    if (deepest(f) <= skin) { used[f] = +hi.toFixed(2); return; }   // never digs in: close fully
    setChainCurl(bones, restQ, side, f, lo);
    if (deepest(f) > skin) { used[f] = 0; return; }                 // already inside: stay open
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      setChainCurl(bones, restQ, side, f, mid);
      if (deepest(f) > skin) hi = mid; else lo = mid;
    }
    setChainCurl(bones, restQ, side, f, lo);
    used[f] = +lo.toFixed(2);
  });

  /* THE THUMB OPPOSES — it does not wrap.
     Hunting for "first contact" fails on a thin rod: the thumb's arc misses it
     entirely, no contact is ever found, and it closes all the way past the prop
     and out the other side (measured 56mm from a 16mm tube). So the thumb takes
     the curl at which its pad sits NEAREST the surface without digging in —
     which lands it on the near face of a cup and folded onto a tube alike. */
  if (bones[side + 'HandThumb1']) {
    let best = 0, bestErr = Infinity;
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * maxCurl;
      setChainCurl(bones, restQ, side, 'Thumb', a);
      if (!fingerTip(bones, side, 'Thumb', _tip)) break;
      const d = distToAxis(_tip, axisPoint, _ax);
      if (radius - d > skin) break;                    // digging in: everything past here is worse
      const err = Math.abs(d - radius);
      if (err < bestErr) { bestErr = err; best = a; }
    }
    setChainCurl(bones, restQ, side, 'Thumb', best);
    used.Thumb = +best.toFixed(2);
  }
  return used;
}

/* A full grip in one call: IK is done by the caller; this orients the wrist
   and closes the fingers by a plain amount (no prop to stop on). */
export function grip(bones, restQ, side, fingerDir, thumbDir, amount) {
  setHandOrientation(bones, side, fingerDir, thumbDir);
  curlFingers(bones, restQ, side, amount);
}

/* kept for callers that used it */
export function thumbSign(bones, side) { const fr = handFrame(bones, side); return fr ? (fr.Tm.x + fr.Tm.y + fr.Tm.z >= 0 ? 1 : -1) : 1; }
