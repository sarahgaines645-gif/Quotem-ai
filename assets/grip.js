/* GRIP — making a hand actually HOLD a thing.
 *
 * IK puts the wrist at a point. That is not holding: the hand arrives as a
 * flat open palm at whatever roll the forearm happened to give it, and a prop
 * "in the hand" is a prop floating next to a wrist. Three things turn that
 * into a grip, all written on Mixamo bone names so they work on any character:
 *
 *   1. the WRIST is oriented — fingers pointing one way, thumb another, so the
 *      palm faces the prop;
 *   2. the FINGERS curl round it;
 *   3. the PROP is placed in the palm from those same directions — wrist +
 *      a little along the fingers + a little off the palm — so hand and prop
 *      agree by construction, not by eye.
 *
 * ⚠️ PROPS ARE NEVER PARENTED TO A BONE. A child of a bone lives in that bone's
 * space — Michelle's is centimetres under a 0.01 root, so a 20cm tube parented
 * to her hand came out 2.6mm tall: "she picks it up" and it vanished. The prop
 * stays in the scene and is POSITIONED each frame from the hand's world pose.
 * Nothing can shrink, nothing can tear, and it works on a rig of any scale.
 *
 * MEASURED on Michelle's rest pose (and it is the Mixamo convention):
 *   hand local +Y = along the fingers          (child bones sit at +Y)
 *   hand local +Z = out of the PALM            (points down in a T-pose)
 *   hand local ±X = the thumb side             (+X right hand, -X left — read
 *                                               off Thumb1.position, not assumed)
 * Fingers curl towards the palm = positive rotation about the finger bone's X.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _e = new THREE.Euler();

/* which way the thumb sits in hand space: +1 or -1 along local X */
export function thumbSign(bones, side) {
  const t = bones[side + 'HandThumb1'];
  return t && t.position.x < 0 ? -1 : 1;
}

/* Point the hand: fingers along `fingerDir`, thumb roughly along `thumbDir`
   (both world vectors; thumbDir is only a hint and is squared up). Call AFTER
   the IK, because the IK reads the hand's position and leaves its rotation. */
export function setHandOrientation(bones, side, fingerDir, thumbDir) {
  const hand = bones[side + 'Hand'];
  if (!hand) return false;
  const s = thumbSign(bones, side);
  _y.copy(fingerDir).normalize();                         // local +Y
  _x.copy(thumbDir).addScaledVector(_y, -_y.dot(thumbDir)).normalize();  // thumb, squared to fingers
  if (_x.lengthSq() < 1e-8) _x.set(0, 1, 0).addScaledVector(_y, -_y.y).normalize();
  _x.multiplyScalar(s);                                   // local +X (the thumb is on -X for the left)
  _z.crossVectors(_x, _y);                                // local +Z = palm, right-handed frame
  _m.makeBasis(_x, _y, _z);
  _q.setFromRotationMatrix(_m);                           // world rotation
  if (hand.parent) { hand.parent.getWorldQuaternion(_pq); _pq.invert(); _q.premultiply(_pq); }
  hand.quaternion.copy(_q);
  hand.updateMatrixWorld(true);
  return true;
}

/* Curl the fingers by `amount` 0..1 on top of each finger bone's rest pose.
   `restQ` is the map of rest quaternions the pages already keep. */
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const CURL = [1.05, 1.35, 0.85];                          // knuckle, middle, tip (radians at amount 1)
export function curlFingers(bones, restQ, side, amount) {
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  FINGERS.forEach((f) => {
    for (let i = 1; i <= 3; i++) {
      const b = bones[side + 'Hand' + f + i];
      if (!b || !restQ[b.name.replace(/^mixamorig:?/, '')]) continue;
      _e.set(CURL[i - 1] * a, 0, 0, 'XYZ');
      _q.setFromEuler(_e);
      b.quaternion.copy(restQ[b.name.replace(/^mixamorig:?/, '')]).multiply(_q);
    }
  });
  /* the thumb closes ACROSS the grip: +X folds it towards the palm, +Z (in the
     thumb-side sense) sweeps it over towards the fingers — measured on
     Michelle: Thumb1 +Z took the tip from x=6.7 to x=2.1 in hand space */
  const s = thumbSign(bones, side);
  [['Thumb1', 0.35, 0.65], ['Thumb2', 0.5, 0], ['Thumb3', 0.4, 0]].forEach(([n, rx, rz]) => {
    const b = bones[side + 'Hand' + n];
    const k = b && b.name.replace(/^mixamorig:?/, '');
    if (!b || !restQ[k]) return;
    _e.set(rx * a, 0, s * rz * a, 'XYZ');
    _q.setFromEuler(_e);
    b.quaternion.copy(restQ[k]).multiply(_q);
  });
}

/* WHERE THE WRIST GOES so that a prop ends up in the palm.
   `propPoint` is the point on the prop the fist closes round (world).
   Returns a new Vector3 = propPoint - fingers*along - palm*off, using the same
   fingerDir/thumbDir the hand will be oriented with, so the two agree. */
export function wristFor(bones, side, propPoint, fingerDir, thumbDir, along = 0.045, off = 0.03) {
  const s = thumbSign(bones, side);
  _y.copy(fingerDir).normalize();
  _x.copy(thumbDir).addScaledVector(_y, -_y.dot(thumbDir)).normalize().multiplyScalar(s);
  _z.crossVectors(_x, _y);                                // palm direction, world
  return new THREE.Vector3().copy(propPoint).addScaledVector(_y, -along).addScaledVector(_z, -off);
}

/* A full grip in one call: IK is done by the caller; this orients the wrist
   and closes the fingers. `amount` 0 = open hand pointed the right way. */
export function grip(bones, restQ, side, fingerDir, thumbDir, amount) {
  setHandOrientation(bones, side, fingerDir, thumbDir);
  curlFingers(bones, restQ, side, amount);
}
