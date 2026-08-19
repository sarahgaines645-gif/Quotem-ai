/* TWO-BONE INVERSE KINEMATICS.
 *
 * The whole reason this file exists: authoring an arm by typing joint angles is
 * guessing. You cannot say "her hand is on the test tube" in angles — you can
 * only try numbers and look. Move the tube 5cm and every number is wrong again.
 *
 * IK inverts the question. You give it a POINT IN THE WORLD and it computes the
 * shoulder and elbow rotations that put the wrist there. The target is then a
 * thing you can see, drag, or attach to a prop, and the arm follows it.
 *
 * This is the analytic two-bone solution (law of cosines), not an iterative
 * solver: it is exact, costs nothing, and cannot wobble or fail to converge.
 *
 *   solveTwoBone(upper, lower, endEffector, targetWorld, poleWorld)
 *
 * `upper`/`lower` are the two bones (e.g. LeftArm, LeftForeArm), `endEffector`
 * is the bone at the end (LeftHand) used to measure the lower bone's length,
 * and `pole` is a hint for which way the elbow should point — without it the
 * elbow can rotate anywhere on a circle and will pick somewhere unpleasant.
 */
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _t = new THREE.Vector3(), _p = new THREE.Vector3();
const _dir = new THREE.Vector3(), _from = new THREE.Vector3(), _to = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _wq = new THREE.Quaternion();
const _axis = new THREE.Vector3(), _proj = new THREE.Vector3(), _perp = new THREE.Vector3();

const worldPos = (o, v) => { o.updateWorldMatrix(true, false); return v.setFromMatrixPosition(o.matrixWorld); };

/* Point a bone so that `childWorld` ends up on the line towards `targetWorld`.
   Done as a world-space delta rotation converted back into the bone's local
   space, which is the only way that survives arbitrary bind orientations —
   and rigs in the wild have every orientation you can imagine. */
function aim(bone, childWorld, targetWorld) {
  worldPos(bone, _a);
  _from.copy(childWorld).sub(_a);
  _to.copy(targetWorld).sub(_a);
  if (_from.lengthSq() < 1e-12 || _to.lengthSq() < 1e-12) return;
  _from.normalize(); _to.normalize();
  _q.setFromUnitVectors(_from, _to);                    // the delta, in world space

  bone.getWorldQuaternion(_wq);
  _wq.premultiply(_q);                                  // where the bone should end up, in world
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_pq);
    _pq.invert();
    bone.quaternion.copy(_pq.multiply(_wq));            // convert world -> local
  } else {
    bone.quaternion.copy(_wq);
  }
  bone.updateMatrixWorld(true);
}

export function solveTwoBone(upper, lower, end, targetWorld, poleWorld) {
  if (!upper || !lower || !end) return false;

  worldPos(upper, _a);                                   // shoulder
  worldPos(lower, _b);                                   // elbow
  worldPos(end, _c);                                     // wrist

  const L1 = _a.distanceTo(_b);
  const L2 = _b.distanceTo(_c);
  if (L1 < 1e-6 || L2 < 1e-6) return false;

  _t.copy(targetWorld);
  let dist = _a.distanceTo(_t);

  /* OUT OF REACH IS NOT AN ERROR. If the target is further than the arm is
     long, the arm straightens and points at it — which is what a person does,
     and is far better than the solver throwing up its hands or snapping. */
  const maxReach = (L1 + L2) * 0.999;
  const minReach = Math.abs(L1 - L2) * 1.001 + 1e-5;
  if (dist > maxReach) {
    _t.sub(_a).setLength(maxReach).add(_a);
    dist = maxReach;
  } else if (dist < minReach) {
    _t.sub(_a).setLength(minReach).add(_a);
    dist = minReach;
  }

  // law of cosines: how far along the line the elbow sits, and how far off it
  const cos = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
  const along = Math.max(-1, Math.min(1, cos)) * L1;
  const off = Math.sqrt(Math.max(0, L1 * L1 - along * along));

  _dir.copy(_t).sub(_a).normalize();

  /* The pole decides which way the elbow breaks. Project it off the shoulder-
     to-target line to get a clean perpendicular; if it happens to be parallel
     (a straight-down pole with a straight-down target, say) fall back to the
     elbow's current direction so the arm keeps the shape it already had. */
  _p.copy(poleWorld || _b).sub(_a);
  _proj.copy(_dir).multiplyScalar(_p.dot(_dir));
  _perp.copy(_p).sub(_proj);
  if (_perp.lengthSq() < 1e-10) {
    _perp.copy(_b).sub(_a);
    _proj.copy(_dir).multiplyScalar(_perp.dot(_dir));
    _perp.sub(_proj);
    if (_perp.lengthSq() < 1e-10) _perp.set(0, 0, 1);
  }
  _perp.normalize();

  // where the elbow must be
  const elbow = _axis.copy(_a).addScaledVector(_dir, along).addScaledVector(_perp, off);

  aim(upper, _b, elbow);          // point the upper arm at the elbow
  worldPos(lower, _b);            // the elbow has moved; re-read it
  worldPos(end, _c);
  aim(lower, _c, _t);             // point the forearm at the target
  return true;
}

/* Convenience for a Mixamo-named skeleton. `bones` is the map of stripped
   names (Hips, LeftArm, …) that the pages already build. */
export function reachHand(bones, side, targetWorld, poleWorld) {
  return solveTwoBone(bones[side + 'Arm'], bones[side + 'ForeArm'], bones[side + 'Hand'], targetWorld, poleWorld);
}
