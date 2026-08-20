/* ONE SET OF BONE NAMES, WHATEVER THE CHARACTER CAME FROM.
 *
 * Everything else in the lab — the IK, the grip, the commands — is written
 * against Mixamo's names (Hips, RightArm, RightForeArm, RightHand,
 * RightHandIndex1 …). That is fine until you want a character from somewhere
 * that does not use them, and the good sources do not:
 *
 *   Mixamo   mixamorig:RightHand      (and mixamorig1:, mixamorig2: …)
 *   RPM      RightHand                (already ours — verified 13/13)
 *   VRM      J_Bip_R_Hand             (VRoid, and anything VRM-based)
 *
 * So this file is the translator. Give it the loaded scene — and, for a VRM,
 * the glTF json — and it hands back the same `{bones, restQ}` map the rest of
 * the code already expects.
 *
 * ⚠️ For a VRM we do NOT guess from names. A VRM carries a HUMANOID TABLE in
 * its own extension that states outright which node is the left hand, which is
 * the right index proximal, and so on — 54 of them in the sample. Reading the
 * table is exact; guessing from "J_Bip_L_Index1" is not. Names are only the
 * fallback for files that have no table.
 */

/* VRM humanoid bone -> our name. VRM's finger joints are
   proximal/intermediate/distal, which are Mixamo's 1/2/3. */
export const VRM_TO_STD = (() => {
  const m = {
    hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2',
    neck: 'Neck', head: 'Head', leftEye: 'LeftEye', rightEye: 'RightEye', jaw: 'Jaw',
  };
  ['left', 'right'].forEach((side) => {
    const S = side === 'left' ? 'Left' : 'Right';
    m[side + 'Shoulder'] = S + 'Shoulder';
    m[side + 'UpperArm'] = S + 'Arm';
    m[side + 'LowerArm'] = S + 'ForeArm';
    m[side + 'Hand'] = S + 'Hand';
    m[side + 'UpperLeg'] = S + 'UpLeg';
    m[side + 'LowerLeg'] = S + 'Leg';
    m[side + 'Foot'] = S + 'Foot';
    m[side + 'Toes'] = S + 'ToeBase';
    /* fingers. VRM calls the little finger "little"; Mixamo calls it Pinky.
       The thumb's first joint is "metacarpal" in VRM, "Thumb1" in Mixamo. */
    const fingers = { index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Pinky' };
    for (const vf in fingers) {
      m[side + cap(vf) + 'Proximal'] = S + 'Hand' + fingers[vf] + '1';
      m[side + cap(vf) + 'Intermediate'] = S + 'Hand' + fingers[vf] + '2';
      m[side + cap(vf) + 'Distal'] = S + 'Hand' + fingers[vf] + '3';
    }
    m[side + 'ThumbMetacarpal'] = S + 'HandThumb1';
    m[side + 'ThumbProximal'] = S + 'HandThumb2';
    m[side + 'ThumbDistal'] = S + 'HandThumb3';
    // VRM 0.x spelled the thumb joints differently
    m[side + 'ThumbProximal_0x'] = S + 'HandThumb1';
  });
  return m;
})();
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* 3ds Max BIPED -> our names. This is what Microsoft Rocketbox ships (115
   MIT-licensed, professionally rigged adults, including a woman in medical
   scrubs and four business women — and 175 facial blendshapes each).
   Biped numbers its fingers instead of naming them: Finger0/01/02 is the
   THUMB, then Finger1x index, 2x middle, 3x ring, 4x little. */
export const BIPED_TO_STD = (() => {
  const m = { Bip01_Pelvis: 'Hips', Bip01_Spine: 'Spine', Bip01_Spine1: 'Spine1', Bip01_Spine2: 'Spine2',
              Bip01_Neck: 'Neck', Bip01_Head: 'Head', Bip01_LEye: 'LeftEye', Bip01_REye: 'RightEye',
              Bip01_MJaw: 'Jaw' };
  [['L', 'Left'], ['R', 'Right']].forEach(([b, S]) => {
    m['Bip01_' + b + '_Clavicle'] = S + 'Shoulder';
    m['Bip01_' + b + '_UpperArm'] = S + 'Arm';
    m['Bip01_' + b + '_Forearm'] = S + 'ForeArm';
    m['Bip01_' + b + '_Hand'] = S + 'Hand';
    m['Bip01_' + b + '_Thigh'] = S + 'UpLeg';
    m['Bip01_' + b + '_Calf'] = S + 'Leg';
    m['Bip01_' + b + '_Foot'] = S + 'Foot';
    const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
    fingers.forEach((name, fi) => {
      m['Bip01_' + b + '_Finger' + fi] = S + 'Hand' + name + '1';
      m['Bip01_' + b + '_Finger' + fi + '1'] = S + 'Hand' + name + '2';
      m['Bip01_' + b + '_Finger' + fi + '2'] = S + 'Hand' + name + '3';
    });
  });
  return m;
})();

/* the VRM humanoid table, in either spelling of the spec */
function vrmHumanBones(json) {
  const ext = (json && json.extensions) || {};
  const vrm = ext.VRMC_vrm || ext.VRM;
  const hb = vrm && vrm.humanoid && vrm.humanoid.humanBones;
  if (!hb) return null;
  const out = {};
  if (Array.isArray(hb)) hb.forEach((e) => { if (e && e.bone && e.node != null) out[e.bone] = e.node; });   // VRM 0.x
  else for (const bone in hb) { const n = hb[bone] && hb[bone].node; if (n != null) out[bone] = n; }        // VRM 1.0
  return Object.keys(out).length ? out : null;
}

/* Strip the vendor prefix Mixamo puts on everything. Handles the numbered
   variants a re-uploaded rig picks up (mixamorig1:, mixamorig2:) and the
   colon-less form three.js produces from FBX. */
export const stripPrefix = (n) => String(n).replace(/^mixamorig\d*:?/, '');

/* THE ONE ENTRY POINT.
   `root`  the loaded scene
   `json`  the glTF json when there is one (gltf.parser.json) — VRM only
   Returns { bones, restQ, source } */
export function mapRig(root, json) {
  const byNodeIndex = vrmHumanBones(json);
  if (byNodeIndex && json && json.nodes) {
    /* Resolve node INDEX -> the actual Object3D. glTF node order is not the
       traversal order, so match on the node's name, which the loader keeps. */
    const wanted = {};
    for (const vrmBone in byNodeIndex) {
      const std = VRM_TO_STD[vrmBone];
      const node = json.nodes[byNodeIndex[vrmBone]];
      if (std && node && node.name) wanted[node.name] = std;
    }
    const bones = {}, restQ = {};
    root.traverse((o) => {
      const std = wanted[o.name];
      if (!std || bones[std]) return;
      bones[std] = o; restQ[std] = o.quaternion.clone();
    });
    if (bones.Hips && bones.RightHand) return { bones, restQ, source: 'vrm-humanoid' };
  }

  /* BIPED (3ds Max / Rocketbox): a fixed table, matched on the bare node name. */
  {
    const bones = {}, restQ = {};
    root.traverse((o) => {
      if (!o.isBone) return;
      const std = BIPED_TO_STD[o.name];
      if (!std || bones[std]) return;
      bones[std] = o; restQ[std] = o.quaternion.clone();
    });
    if (bones.Hips && bones.RightHand && bones.RightArm) return { bones, restQ, source: 'biped' };
  }

  /* NO TABLE: fall back to names. Shallowest wins — see grip.js boneMap for
     why (stacked duplicate nodes, where the inner one drives nothing). */
  const bones = {}, restQ = {};
  root.traverse((o) => {
    if (!o.isBone) return;
    const k = stripPrefix(o.name);
    if (!k || bones[k]) return;
    bones[k] = o; restQ[k] = o.quaternion.clone();
  });
  return { bones, restQ, source: 'names' };
}

/* What the lab actually needs to drive a character. Used to tell the user
   plainly what is missing rather than failing silently. */
export const REQUIRED = ['Hips', 'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand'];
export function missingFrom(bones) { return REQUIRED.filter((n) => !bones[n]); }
