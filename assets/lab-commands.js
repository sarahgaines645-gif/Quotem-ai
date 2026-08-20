/* THE LAB, TOLD WHAT TO DO — V3.
 *
 * V2 (`lab-action.js`) was one fixed 8-second film. This is the thing Sarah
 * actually asked for: *"we need to tell her to pick up the cup and she will."*
 * A sentence comes in, it becomes a list of COMMANDS, and each command is
 * animated from WHEREVER SHE IS NOW — so "pick up the cup", then "pour", then
 * "put it down" compose in any order, and a lesson can fire them one at a time.
 *
 * The engine owns the STATE (where each prop is, which hand holds what, how
 * full the tube is, where each hand currently is) and a QUEUE of commands.
 * Every frame it returns a PLAN in the same shape the page already draws:
 *   { pose, tube:{pos,mouth}, jug:{pos,tilt,lip}, right, left, fill, pouring, phase, busy }
 * where right/left = { fingers, thumb, curl, grip, along, off, radius, axis, wristRest, attach }
 * — the page solves the arms to those with IK and closes the hands on the prop
 * (grip.js closeOn: the fingers stop when they touch it).
 *
 * Props are never parented to bones. Everything is world space. Works on any
 * Mixamo-named character: the only inputs from the skeleton are the two
 * shoulder positions, read every frame.
 */

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/* ── what a sentence means ──────────────────────────────────────────────── */
const TUBE_WORDS = /\b(test[\s-]?tube|tube)\b/i;
const JUG_WORDS = /\b(cup|beaker|jug|glass|mug)\b/i;
const BOTH_WORDS = /\b(both|everything|them|all)\b/i;

export function parse(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return [];
  const cmds = [];
  // split on "then", "and then", commas, full stops
  const parts = t.split(/\s*(?:,|\.|;|\bthen\b|\band then\b|\bafter that\b)\s*/).filter(Boolean);
  parts.forEach((p) => {
    const wantsTube = TUBE_WORDS.test(p), wantsJug = JUG_WORDS.test(p), both = BOTH_WORDS.test(p);
    const props = both ? ['tube', 'jug'] : [wantsTube && 'tube', wantsJug && 'jug'].filter(Boolean);
    if (/\b(do (it|everything|the (lot|whole thing|test))|run|demo|start|go)\b/.test(p) && !wantsTube && !wantsJug) {
      cmds.push({ cmd: 'pickUp', prop: 'tube' }, { cmd: 'pickUp', prop: 'jug' }, { cmd: 'pour' }, { cmd: 'putDown', prop: 'jug' }, { cmd: 'show' });
    } else if (/\bpour\b|\btip\b|\badd\b|\bfill\b/.test(p)) {
      cmds.push({ cmd: 'pour' });
    } else if (/\b(put|set|place)\b.*\b(down|back)\b|\bdrop\b|\blet go\b|\brelease\b/.test(p)) {
      (props.length ? props : ['tube', 'jug']).forEach((prop) => cmds.push({ cmd: 'putDown', prop }));
    } else if (/\b(show|hold (it |the tube )?up|present|look at|raise)\b/.test(p)) {
      cmds.push({ cmd: 'show' });
    } else if (/\b(pick|grab|take|lift|hold|get)\b/.test(p)) {
      (props.length ? props : ['tube']).forEach((prop) => cmds.push({ cmd: 'pickUp', prop }));
    } else if (/\b(rest|relax|stop|hands down|stand)\b/.test(p)) {
      cmds.push({ cmd: 'rest' });
    } else if (props.length) {
      // just "the cup" = pick it up
      props.forEach((prop) => cmds.push({ cmd: 'pickUp', prop }));
    }
  });
  return cmds;
}

/* ── the engine ─────────────────────────────────────────────────────────── */
export class LabEngine {
  /* ctx: { THREE, TUBE_H, TUBE_R, JUG_H, JUG_R, tubeHome, jugHome } — homes are
     Vector3 (world, the prop's BASE). shoulders are passed in each frame. */
  constructor(ctx) {
    this.c = ctx;
    const V = ctx.THREE.Vector3;
    this.v = (x, y, z) => new V(x, y, z);
    this.HAND = { tube: 'Right', jug: 'Left' };
    this.props = {
      tube: { pos: ctx.tubeHome.clone(), tilt: 0, held: false, r: ctx.TUBE_R, h: ctx.TUBE_H, gripUp: 0.40, along: null, off: null },
      jug:  { pos: ctx.jugHome.clone(),  tilt: 0, held: false, r: ctx.JUG_R,  h: ctx.JUG_H,  gripUp: 0.45, along: null, off: null },
    };
    this.fill = 0;
    // where each hand IS (directions + wrist), so the next command starts from here
    this.hands = {
      Right: { fingers: this.v(0, -1, 0.15), thumb: this.v(0, 0, 1), curl: 0.15, wrist: null, mode: 'rest' },
      Left:  { fingers: this.v(0, -1, 0.15), thumb: this.v(0, 0, 1), curl: 0.15, wrist: null, mode: 'rest' },
    };
    this.queue = [];      // pending commands
    this.current = null;  // { segs:[{dur, start(), step(u)}], i, t, label }
    this.phase = 'ready';
    this.log = [];
  }

  /* ── directions a hand takes to hold an upright prop in front of her ── */
  holdDirs(side, tilt = 0) {
    const v = this.v;
    const base = side === 'Right'
      ? { f: v(1, 0.05, -0.35), t: v(0.2, 1, 0.15) }
      : { f: v(-1, 0.05, -0.35), t: v(-0.2, 1, 0.15) };
    if (tilt) {
      const q = new this.c.THREE.Quaternion().setFromAxisAngle(v(0, 0, 1), tilt);
      base.f.applyQuaternion(q); base.t.applyQuaternion(q);
    }
    return base;
  }
  restWrist(side) { return (side === 'Right' ? this.sR : this.sL).clone().add(this.v(side === 'Right' ? -0.06 : 0.06, -0.42, 0.10)); }
  holdPoint(prop) {   // where the fist is when she holds the prop in front of her chest
    return prop === 'tube' ? this.sR.clone().add(this.v(0.07, -0.17, 0.27)) : this.sL.clone().add(this.v(0.03, -0.12, 0.27));
  }
  showPoint() { return this.sR.clone().add(this.v(0.05, 0.02, 0.30)); }
  gripOf(prop) {     // the point on the prop's axis the fist closes round (world)
    const P = this.props[prop];
    const up = this.v(0, P.h * P.gripUp, 0);
    if (P.tilt) up.applyQuaternion(new this.c.THREE.Quaternion().setFromAxisAngle(this.v(0, 0, 1), P.tilt));
    return P.pos.clone().add(up);
  }

  /* ── commands. Each is a list of segments; a segment has a duration, a
        start() that captures "from" values, and a step(u) that writes state. ── */
  say(text) {
    const cmds = parse(text);
    if (!cmds.length) { this.log.push('did not understand: ' + text); return []; }
    cmds.forEach((c) => this.enqueue(c));
    return cmds;
  }
  enqueue(c) {
    // prerequisites, so "pour" on its own still works
    if (c.cmd === 'pour') {
      if (!this.willHold('tube')) this.queue.push({ cmd: 'pickUp', prop: 'tube' });
      if (!this.willHold('jug')) this.queue.push({ cmd: 'pickUp', prop: 'jug' });
    }
    if (c.cmd === 'show' && !this.willHold('tube')) this.queue.push({ cmd: 'pickUp', prop: 'tube' });
    if (c.cmd === 'pickUp' && this.willHold(c.prop)) return;            // already holding it
    if (c.cmd === 'putDown' && !this.willHold(c.prop)) return;          // not holding it
    if (c.cmd === 'rest') ['tube', 'jug'].forEach((p) => { if (this.willHold(p)) this.queue.push({ cmd: 'putDown', prop: p }); });
    this.queue.push(c);
  }
  /* will the prop be held once the queue has run? */
  willHold(prop) {
    let h = this.props[prop].held;
    const all = this.current ? [this.current.cmd, ...this.queue] : this.queue;
    all.forEach((c) => { if (c && c.prop === prop) { if (c.cmd === 'pickUp') h = true; if (c.cmd === 'putDown') h = false; } if (c && c.cmd === 'rest') h = false; });
    return h;
  }
  clear() { this.queue = []; this.current = null; this.phase = 'ready'; }

  build(c) {
    const v = this.v, P = this.props, H = this.hands;
    const segs = [];
    const lerpV = (a, b, u) => a.clone().lerp(b, u);

    if (c.cmd === 'pickUp') {
      const prop = c.prop, side = this.HAND[prop], hand = H[side], p = P[prop];
      let from, dirs;
      // REACH: the wrist goes to the prop; the hand opens and turns to take it
      segs.push({ dur: 1.1, label: 'reaching for the ' + (prop === 'jug' ? 'cup' : 'tube'),
        start: () => { from = { f: hand.fingers.clone(), t: hand.thumb.clone(), curl: hand.curl, wrist: hand.wrist ? hand.wrist.clone() : this.restWrist(side) }; dirs = this.holdDirs(side, p.tilt); },
        step: (u) => {
          const e = ease(u);
          hand.fingers = lerpV(from.f, dirs.f, e).normalize();
          hand.thumb = lerpV(from.t, dirs.t, e).normalize();
          hand.curl = from.curl + (0.15 - from.curl) * e;
          hand.mode = 'approach'; hand.prop = prop; hand.attach = e; hand.fromWrist = from.wrist;
        } });
      // CLOSE: the fingers close until they touch it (closeOn does the stopping)
      segs.push({ dur: 0.45, label: 'taking hold', start: () => {}, step: (u) => { hand.curl = 0.15 + 0.85 * ease(u); hand.mode = 'approach'; hand.attach = 1; } });
      // LIFT: the prop comes up to the hold point in front of her
      let from2, to2;
      segs.push({ dur: 1.0, label: 'lifting', start: () => { p.held = true; hand.mode = 'hold'; from2 = p.pos.clone(); to2 = this.holdPoint(prop).sub(v(0, p.h * p.gripUp, 0)); },
        step: (u) => { p.pos = lerpV(from2, to2, ease(u)); } });
    }

    if (c.cmd === 'pour') {
      const j = P.jug, t = P.tube, hand = H.Left;
      const lipLocal = () => v(-j.r, j.h, 0);
      const lipAt = (tilt) => lipLocal().applyQuaternion(new this.c.THREE.Quaternion().setFromAxisAngle(v(0, 0, 1), tilt));
      let mouth, lipBeside, lipOver;
      const placeJug = (k) => {              // k 0..1 = how far tipped; the LIP is the authority
        const tilt = k * 1.15;
        const lip = lerpV(lipBeside, lipOver, k);
        j.tilt = tilt; j.pos = lip.clone().sub(lipAt(tilt));
        const d = this.holdDirs('Left', tilt); hand.fingers = d.f; hand.thumb = d.t;
      };
      segs.push({ dur: 0.7, label: 'tipping the cup', start: () => { mouth = t.pos.clone().add(v(0, t.h, 0)); lipBeside = mouth.clone().add(v(0.12, 0.06, 0)); lipOver = mouth.clone().add(v(0, 0.055, 0)); },
        step: (u) => placeJug(ease(u)) });
      let f0;
      segs.push({ dur: 2.2, label: 'pouring', start: () => { f0 = this.fill; }, step: (u) => { placeJug(1); this.fill = f0 + (1 - f0) * ease(u); this.pouring = u < 0.98; } });
      segs.push({ dur: 0.6, label: 'righting the cup', start: () => { this.pouring = false; }, step: (u) => placeJug(1 - ease(u)) });
    }

    if (c.cmd === 'putDown') {
      const prop = c.prop, side = this.HAND[prop], hand = H[side], p = P[prop];
      let from, home;
      segs.push({ dur: 1.0, label: 'putting the ' + (prop === 'jug' ? 'cup' : 'tube') + ' down',
        start: () => { from = p.pos.clone(); home = (prop === 'tube' ? this.c.tubeHome : this.c.jugHome).clone(); p.tilt = 0; const d = this.holdDirs(side); hand.fingers = d.f; hand.thumb = d.t; },
        step: (u) => { p.pos = lerpV(from, home, ease(u)); } });
      segs.push({ dur: 0.4, label: 'letting go', start: () => { p.held = false; hand.mode = 'approach'; hand.prop = prop; hand.attach = 1; }, step: (u) => { hand.curl = 1 - 0.85 * ease(u); } });
      let fw, tw, ff, ft;
      segs.push({ dur: 0.8, label: 'hand back', start: () => { fw = hand.wrist.clone(); tw = this.restWrist(side); ff = hand.fingers.clone(); ft = hand.thumb.clone(); hand.mode = 'free'; },
        step: (u) => { const e = ease(u); hand.freeWrist = lerpV(fw, tw, e); hand.fingers = lerpV(ff, v(0, -1, 0.15), e).normalize(); hand.thumb = lerpV(ft, v(0, 0, 1), e).normalize(); if (u >= 1) hand.mode = 'rest'; } });
    }

    if (c.cmd === 'show') {
      const p = P.tube; let from, to;
      segs.push({ dur: 1.0, label: 'showing you', start: () => { from = p.pos.clone(); to = this.showPoint().sub(v(0, p.h * p.gripUp, 0)); }, step: (u) => { p.pos = lerpV(from, to, ease(u)); this.showing = ease(u); } });
      segs.push({ dur: 1.2, label: 'there', start: () => {}, step: () => {} });
    }

    if (c.cmd === 'rest') {
      ['Right', 'Left'].forEach((side) => {
        const hand = H[side]; let fw, tw, ff, ft;
        segs.push({ dur: 0.8, label: 'hands down', start: () => { fw = hand.wrist ? hand.wrist.clone() : this.restWrist(side); tw = this.restWrist(side); ff = hand.fingers.clone(); ft = hand.thumb.clone(); hand.mode = 'free'; hand.curl = 0.15; },
          step: (u) => { const e = ease(u); hand.freeWrist = lerpV(fw, tw, e); hand.fingers = lerpV(ff, v(0, -1, 0.15), e).normalize(); hand.thumb = lerpV(ft, v(0, 0, 1), e).normalize(); if (u >= 1) hand.mode = 'rest'; } });
      });
      this.showing = 0;
    }
    return segs;
  }

  /* ── per frame ─────────────────────────────────────────────────────────── */
  update(dt, shoulderR, shoulderL) {
    this.sR = shoulderR; this.sL = shoulderL;
    if (!this.current && this.queue.length) {
      const cmd = this.queue.shift();
      const segs = this.build(cmd);
      if (segs.length) { this.current = { cmd, segs, i: -1, t: 0 }; this.advance(); }
    }
    if (this.current) {
      const cur = this.current, seg = cur.segs[cur.i];
      cur.t += dt;
      let u = clamp01(seg.dur > 0 ? cur.t / seg.dur : 1);
      seg.step(u);
      this.phase = seg.label;
      if (cur.t >= seg.dur) { seg.step(1); cur.t = 0; if (!this.advance()) { this.current = null; this.phase = this.queue.length ? this.phase : 'ready'; } }
    }
    return this.plan();
  }
  advance() {
    const cur = this.current; cur.i++;
    if (cur.i >= cur.segs.length) return false;
    cur.segs[cur.i].start();
    return true;
  }

  /* ── the plan the page draws ───────────────────────────────────────────── */
  plan() {
    const v = this.v, P = this.props, H = this.hands;
    const q = (tilt) => new this.c.THREE.Quaternion().setFromAxisAngle(v(0, 0, 1), tilt);
    const handPlan = (side) => {
      const h = H[side];
      const prop = side === 'Right' ? 'tube' : 'jug';
      const p = P[prop];
      const out = { fingers: h.fingers, thumb: h.thumb, curl: h.curl, wristRest: this.restWrist(side), attach: 0, prop: null };
      if (h.mode === 'hold' || (h.mode === 'approach' && h.prop === prop)) {
        out.prop = prop; out.grip = this.gripOf(prop); out.along = p.along; out.off = p.off;
        out.radius = p.r; out.axis = v(0, 1, 0).applyQuaternion(q(p.tilt));
        out.attach = h.mode === 'hold' ? 1 : (h.attach == null ? 1 : h.attach);
        if (h.mode === 'approach' && h.fromWrist) out.wristRest = h.fromWrist;
        out.closing = h.mode === 'approach';        // fingers stop at the prop
        out.holding = h.mode === 'hold';
      } else if (h.mode === 'free' && h.freeWrist) {
        out.wristRest = h.freeWrist;
      }
      return out;
    };
    const right = handPlan('Right'), left = handPlan('Left');
    const tubeMouth = P.tube.pos.clone().add(v(0, P.tube.h, 0));
    const lip = v(-P.jug.r, P.jug.h, 0).applyQuaternion(q(P.jug.tilt)).add(P.jug.pos);

    // the body follows the hands: bend to a low wrist, look at a held tube
    const low = (side) => { const h = H[side]; const w = h.wrist; if (!w) return 0; const s = side === 'Right' ? this.sR : this.sL; return clamp01((s.y - w.y - 0.18) / 0.22) * (h.mode === 'approach' ? 1 : 0.35); };
    const lean = Math.max(low('Right'), low('Left'));
    const look = P.tube.held ? 1 : (P.jug.held ? 0.6 : 0);
    const present = this.showing || 0;
    const pose = {};
    const set = (n, x, y, z) => { pose[n] = [x, y, z]; };
    set('Hips', 0.06 * lean, 0, 0);
    set('Spine', 0.16 * lean + 0.04 * look, 0, 0);
    set('Spine1', 0.10 * lean + 0.03 * look, 0, 0);
    set('Spine2', 0.06 * lean, 0, 0);
    set('Neck', 0.22 * lean + 0.18 * look - 0.10 * present, -0.10 * look, 0);
    set('Head', 0.26 * lean + 0.22 * look - 0.14 * present, -0.14 * look, 0.05 * look);
    set('RightShoulder', 0, 0, 0.08 * (right.attach || 0) + 0.10 * (P.tube.held ? 1 : 0));
    set('LeftShoulder', 0, 0, -(0.08 * (left.attach || 0) + 0.10 * (P.jug.held ? 1 : 0)));
    set('LeftUpLeg', 0.03 * lean, 0, 0.04);
    set('RightUpLeg', 0.02 * lean, 0, -0.04);
    set('LeftLeg', -0.07 * lean, 0, 0);
    set('RightLeg', -0.05 * lean, 0, 0);

    return {
      pose,
      tube: { pos: P.tube.pos, mouth: tubeMouth, held: P.tube.held },
      jug: { pos: P.jug.pos, tilt: P.jug.tilt, lip, held: P.jug.held },
      right, left,
      fill: this.fill, pouring: !!this.pouring,
      held: P.tube.held || P.jug.held,
      phase: this.phase, busy: !!this.current || this.queue.length > 0,
    };
  }

  /* the page tells us where the wrists actually ended up (after IK), so the
     next command starts from there */
  noteWrists(rightW, leftW) { this.hands.Right.wrist = rightW.clone(); this.hands.Left.wrist = leftW.clone(); }
}
