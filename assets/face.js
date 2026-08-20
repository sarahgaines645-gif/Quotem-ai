/* THE FACE — blinking, looking, and expression, driven by morph targets.
 *
 * ⚠️ A MIXAMO CHARACTER CANNOT DO THIS. Measured on both of ours: Michelle has
 * 0 morph targets, and Claire ships separate mouth/brow/eye MESHES with 0
 * morphs and 0 face bones — the geometry is there and nothing can move it.
 * Faces need blendshapes, and the free source that has them AND the exact bone
 * names the rest of this code uses is Ready Player Me (verified: 13/13 of our
 * required bones, 40 finger bones, plus LeftEye/RightEye).
 *
 * So this file is written to be tolerant: it finds whatever the character
 * happens to have, under whatever naming, and drives what it finds. A rig with
 * no morphs at all still works — the face just does not move, and `has()` says
 * so rather than the page pretending.
 *
 * Naming in the wild differs. ARKit is the common one ("jawOpen", "eyeBlinkLeft"),
 * but exporters prefix and case them differently, so every lookup is fuzzy.
 */

/* what we want, and the names it goes by */
/* Three naming worlds, one table. ARKit is what Ready Player Me and most
   game pipelines use; VRM/VRoid uses its own "Fcl_" shape names plus a set of
   preset expressions. Whichever a character turns up with, we drive it. */
const WANTED = {
  blinkL:  ['eyeBlinkLeft', 'eyeBlink_L', 'blink_left', 'Blink_Left',
            'Fcl_EYE_Close_L', 'blinkLeft'],
  blinkR:  ['eyeBlinkRight', 'eyeBlink_R', 'blink_right', 'Blink_Right',
            'Fcl_EYE_Close_R', 'blinkRight'],
  blink:   ['Fcl_EYE_Close', 'blink', 'eyesClosed'],          // both eyes at once
  jaw:     ['jawOpen', 'jaw_open', 'mouthOpen', 'viseme_aa',
            'Fcl_MTH_A', 'aa', 'A'],
  smileL:  ['mouthSmileLeft', 'mouthSmile_L', 'mouthSmile', 'smile'],
  smileR:  ['mouthSmileRight', 'mouthSmile_R', 'mouthSmile', 'smile'],
  smile:   ['Fcl_ALL_Joy', 'Fcl_MTH_Joy', 'happy', 'Fcl_ALL_Fun', 'relaxed'],
  browUp:  ['browInnerUp', 'browsUp', 'brow_up', 'browInnerUpLeft',
            'Fcl_BRW_Surprised', 'surprised'],
  browDnL: ['browDownLeft', 'browDown_L', 'browsDown', 'Fcl_BRW_Angry'],
  browDnR: ['browDownRight', 'browDown_R', 'browsDown', 'Fcl_BRW_Angry'],
  squintL: ['eyeSquintLeft', 'eyeSquint_L', 'Fcl_EYE_Joy_L'],
  squintR: ['eyeSquintRight', 'eyeSquint_R', 'Fcl_EYE_Joy_R'],
  lookDL:  ['eyeLookDownLeft', 'Fcl_EYE_Down'], lookDR: ['eyeLookDownRight'],
  lookUL:  ['eyeLookUpLeft', 'Fcl_EYE_Up'],     lookUR: ['eyeLookUpRight'],
};

/* Names arrive decorated: a VRM exports "Face_Blendshape.Fcl_EYE_Close",
   other tools prefix or case them differently. Compare on the bare name. */
const norm = (s) => String(s).split('.').pop().toLowerCase().replace(/[^a-z]/g, '');

/* ── THE FALLBACK: MOVE THE FEATURES THEMSELVES ─────────────────────────────
 *
 * Most stylised characters — every Mixamo one — have NO blendshapes, but they
 * DO build the face out of separate little meshes: a mouth, a pair of brows, a
 * pair of eyes, each weighted entirely to the Head bone. Claire's are 264, 324
 * and 612 vertices. That is small enough to reshape every frame, so we can give
 * her expressions she was never rigged for: raise the brows, narrow the eyes,
 * open the jaw, pull the mouth corners into a smile.
 *
 * It is not a substitute for a real facial rig — the lips on the BODY mesh do
 * not move with it — but on a cartoon face the features are what read, and this
 * turns a mask into somebody. Nothing is baked: we keep the original vertices
 * and rewrite from them, so it is exact and cannot drift.
 */
class GeoFeature {
  constructor(mesh, kind) {
    this.mesh = mesh; this.kind = kind;
    const p = mesh.geometry.attributes.position;
    this.pos = p;
    this.base = new Float32Array(p.array);          // the untouched original
    // the feature's own centre and size, so displacements scale to the face
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < p.count; i++) {
      const x = this.base[i * 3], y = this.base[i * 3 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    this.cx = (minX + maxX) / 2; this.cy = (minY + maxY) / 2;
    this.w = Math.max(1e-6, maxX - minX); this.h = Math.max(1e-6, maxY - minY);
  }
  /* rewrite every vertex from the original using `fn(x,y,z,out)` */
  apply(fn) {
    const a = this.pos.array, b = this.base, n = this.pos.count;
    const o = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      o[0] = b[j]; o[1] = b[j + 1]; o[2] = b[j + 2];
      fn(b[j], b[j + 1], b[j + 2], o);
      a[j] = o[0]; a[j + 1] = o[1]; a[j + 2] = o[2];
    }
    this.pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
  reset() { this.pos.array.set(this.base); this.pos.needsUpdate = true; }
}

export class Face {
  /* `root` is the loaded character; `bones` the map from grip.js boneMap(). */
  constructor(root, bones) {
    this.meshes = [];
    this.map = {};                 // want -> [{mesh, index}]
    this.bones = bones || {};
    root.traverse((o) => { if (o.morphTargetDictionary && o.morphTargetInfluences) this.meshes.push(o); });

    const index = [];              // every morph on every mesh, normalised
    this.meshes.forEach((m) => {
      Object.keys(m.morphTargetDictionary).forEach((name) => {
        index.push({ mesh: m, i: m.morphTargetDictionary[name], name, key: norm(name) });
      });
    });
    this.all = index.map((e) => e.name);

    for (const want in WANTED) {
      const hits = [];
      for (const candidate of WANTED[want]) {
        const k = norm(candidate);
        /* Exact first, then ENDS-WITH. Real exports number and prefix their
           shapes — Rocketbox ships "blendShape1.AK_09_EyeBlinkLeft" and
           "AA_VI_10_aa" — so an exact compare finds nothing at all on a
           character with a perfectly good 175-shape facial rig. */
        index.forEach((e) => { if (e.key === k) hits.push(e); });
        if (!hits.length) index.forEach((e) => { if (e.key.length > k.length && e.key.endsWith(k)) hits.push(e); });
        if (hits.length) break;                       // first naming that matches wins
      }
      if (hits.length) this.map[want] = hits;
    }
    /* No blendshapes? Then find the features and move them instead. */
    this.geo = {};
    if (!Object.keys(this.map).length) {
      root.traverse((o) => {
        if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        const n = norm(o.name);
        if (/body|hair|tooth|teeth|tongue/.test(n)) return;      // the body carries the whole head; leave it
        if (/brow/.test(n) && !this.geo.brows) this.geo.brows = new GeoFeature(o, 'brows');
        else if (/eye/.test(n) && !this.geo.eyes) this.geo.eyes = new GeoFeature(o, 'eyes');
        else if (/mouth|lip|jaw/.test(n) && !this.geo.mouth) this.geo.mouth = new GeoFeature(o, 'mouth');
      });
    }
    this.t = 0;
    this.nextBlink = 1.5;
    this.state = { jaw: 0, smile: 0, brow: 0, concentrate: 0, blink: 0 };
  }

  /* how the face is being driven, so the page can say so honestly */
  get mode() {
    if (Object.keys(this.map).length) return 'blendshapes';
    if (Object.keys(this.geo).length) return 'features';
    return 'none';
  }

  /* ── drive the feature meshes (no blendshapes needed) ── */
  applyGeo() {
    const s = this.state;
    const B = this.geo.brows, E = this.geo.eyes, M = this.geo.mouth;

    if (B) {
      /* brows lift as a pair, and the INNER ends lift further when she is
         pleased or surprised; both drop and pinch inwards when concentrating */
      const lift = s.brow * B.h * 0.28 - s.concentrate * B.h * 0.22;
      B.apply((x, y, z, o) => {
        const inner = 1 - Math.min(1, Math.abs(x - B.cx) / (B.w * 0.5));   // 1 at the nose, 0 at the temple
        o[1] = y + lift + s.brow * inner * B.h * 0.15 - s.concentrate * inner * B.h * 0.14;
      });
    }
    if (E) {
      /* a blink squashes the eyes onto their own centre line; concentrating
         narrows them a little without closing them */
      const shut = Math.min(1, s.blink + s.concentrate * 0.28);
      E.apply((x, y, z, o) => { o[1] = E.cy + (y - E.cy) * (1 - shut * 0.94); });
    }
    if (M) {
      /* the jaw drops the lower half of the mouth; a smile lifts the CORNERS,
         which is the bit that actually reads as a smile.
         ⚠️ Sizes are FRACTIONS OF THE FEATURE, and they must stay small. The
         first pass used 1.4x the mouth's own height for a full jaw drop — on
         Claire that is 16.8 units on a 12-unit mouth, i.e. her jaw through her
         chest. Measured and cut to 0.35, which is about 4cm on a 1.7m person:
         a real open mouth, not a scream. */
      M.apply((x, y, z, o) => {
        const lower = y < M.cy ? Math.min(1, (M.cy - y) / (M.h * 0.5)) : 0;
        const corner = Math.min(1, Math.abs(x - M.cx) / (M.w * 0.5));
        o[1] = y - lower * s.jaw * M.h * 0.35 + corner * s.smile * M.h * 0.18;
        o[0] = M.cx + (x - M.cx) * (1 + s.smile * 0.06 - s.jaw * 0.03);
      });
    }
  }

  has(want) { return !!this.map[want]; }
  get available() { return Object.keys(this.map); }
  get morphCount() { return this.all.length; }

  set(want, v) {
    const hits = this.map[want];
    if (!hits) return false;
    const x = v < 0 ? 0 : v > 1 ? 1 : v;
    hits.forEach((h) => { h.mesh.morphTargetInfluences[h.i] = x; });
    return true;
  }

  /* EYES follow a point, when the rig has eye bones (RPM does).
     Small angles only — eyes that swivel too far read as possessed. */
  lookAt(target) {
    const L = this.bones.LeftEye, R = this.bones.RightEye;
    if (!L || !R || !target) return false;
    [L, R].forEach((eye) => {
      eye.updateWorldMatrix(true, false);
      eye.lookAt(target);                 // three.js aims it in world space for us
      /* CLAMP. An eye bone that can rotate freely will happily point backwards
         through the skull when the target is off to one side, and the character
         instantly reads as possessed. Twenty degrees is as far as a real eye
         travels before the head starts turning instead. */
      const lim = 0.35;
      eye.rotation.x = Math.max(-lim, Math.min(lim, eye.rotation.x));
      eye.rotation.y = Math.max(-lim, Math.min(lim, eye.rotation.y));
      eye.rotation.z = 0;
    });
    return true;
  }

  /* ALIVE — the involuntary stuff. Without blinking a face reads as a mask,
     and it costs nothing: a blink is 120ms, every 2-6 seconds, not on a timer
     you can count. */
  update(dt, mood) {
    this.t += dt;
    const s = this.state;

    /* blinking, on its own clock */
    s.blink = 0;
    if (this.t >= this.nextBlink) {
      const into = this.t - this.nextBlink;
      const BLINK = 0.13;
      if (into < BLINK) s.blink = Math.sin((into / BLINK) * Math.PI);   // open -> shut -> open
      else this.nextBlink = this.t + 2 + Math.abs((Math.sin(this.t * 12.9898) * 43758.5453) % 1) * 4;
    }
    /* ease towards the mood rather than snapping — a face that changes
       expression between one frame and the next reads as a glitch */
    if (mood) {
      const k = Math.min(1, dt * 6);
      if (mood.smile != null) s.smile += (mood.smile - s.smile) * k;
      if (mood.jaw != null) s.jaw += (mood.jaw - s.jaw) * k;
      if (mood.brow != null) s.brow += (mood.brow - s.brow) * k;
      if (mood.concentrate != null) s.concentrate += (mood.concentrate - s.concentrate) * k;
    }

    if (this.mode === 'blendshapes') {
      this.set('blinkL', s.blink); this.set('blinkR', s.blink); this.set('blink', s.blink);
      this.set('smileL', s.smile); this.set('smileR', s.smile); this.set('smile', s.smile);
      this.set('jaw', s.jaw);
      this.set('browUp', s.brow);
      this.set('browDnL', s.concentrate * 0.5); this.set('browDnR', s.concentrate * 0.5);
      this.set('squintL', s.concentrate * 0.3); this.set('squintR', s.concentrate * 0.3);
    } else if (this.mode === 'features') {
      this.applyGeo();
    }
  }

  /* a mouth that moves while she explains something — not lip sync, just the
     jaw riding a syllable rhythm, which reads as talking at this distance */
  talk(on, t) {
    if (this.mode === 'none') return false;
    this.state.jaw = on ? Math.max(0, Math.sin(t * 11) * 0.35 + Math.sin(t * 6.3) * 0.15) : 0;
    return true;
  }

  report() {
    return {
      mode: this.mode,
      morphs: this.morphCount, driving: this.available,
      features: Object.keys(this.geo).map((k) => k + '(' + this.geo[k].pos.count + ')'),
      hasEyes: !!(this.bones.LeftEye && this.bones.RightEye),
      state: Object.assign({}, this.state),
      names: this.all.slice(0, 60),
    };
  }
}
