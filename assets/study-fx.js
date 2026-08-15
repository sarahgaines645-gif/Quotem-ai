/**
 * STUDY FX — the light show for the revision page (teen mode).
 *
 * Ported faithfully from docs/study-suite-looks/effects.html (the catalogue
 * Sarah picked from, 15 Aug 2026). One rAF loop, two full-viewport canvases
 * (bg UNDER the page, fg OVER everything), one DOM overlay layer, an SVG
 * <defs> block for the filters. Every effect is an "actor" {update, draw}
 * or a DOM timeline; both register with the engine so stopAll() and reduced
 * motion always work. No sound. Nothing loads from the network. Every effect
 * cleans itself up.
 *
 *   StudyFX.init({ card, options, chosen, sign, shake })   selectors/functions
 *   StudyFX.fire(id, opts)        one-shot effect  (opts.target / point / text / streak)
 *   StudyFX.loop(id, params)      start a looping effect (idempotent)
 *   StudyFX.stopLoop(id) / isLooping(id) / setLoopParam(id, key, value)
 *   StudyFX.stopAll()
 *   StudyFX.setReducedMotion(bool | null)   null = follow the OS setting
 *   StudyFX.setEnabled(bool)      false = fire/loop are no-ops (sensible mode)
 *   StudyFX.list()                metadata for every effect (for the picker)
 *
 * Particle counts are capped on small screens / low DPR (perfScale) and cut
 * further under reduced motion.
 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const R = (a, b) => a + Math.random() * (b - a);
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = {
    linear: (t) => t,
    outQuad: (t) => 1 - (1 - t) * (1 - t),
    inQuad: (t) => t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inCubic: (t) => t * t * t,
    inOutQuad: (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: (t) => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1,
    outExpo: (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  };
  const NEON = ['#ff2d95', '#00f0ff', '#b6ff00', '#ffb800', '#a855f7', '#ff5e3a'];
  const NEON_RGB = { '#ff2d95': [255, 45, 149], '#00f0ff': [0, 240, 255], '#b6ff00': [182, 255, 0], '#ffb800': [255, 184, 0], '#a855f7': [168, 85, 247], '#ff5e3a': [255, 94, 58], '#ffffff': [255, 255, 255], '#ff3b5c': [255, 59, 92] };
  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgba(hex, a) { const c = NEON_RGB[hex] || hexToRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  const CSS = `
#fx-bg{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}
#fx-fg{position:fixed;inset:0;width:100%;height:100%;z-index:60;pointer-events:none}
#fx-dom{position:fixed;inset:0;z-index:61;pointer-events:none;overflow:hidden}
#fx-dom > *{pointer-events:none}
#fx-svg{position:absolute;width:0;height:0;overflow:hidden}
.fx-ov-vignette{position:fixed;inset:0;box-shadow:inset 0 0 140px 50px rgba(255,20,70,0.6);opacity:0}
.fx-ov-black{position:fixed;inset:0;background:#000}
.fx-ov-flash{position:fixed;inset:0;background:#fff;opacity:0}
.fx-ov-scan{position:fixed;inset:0;background:repeating-linear-gradient(to bottom,transparent 0 2px,rgba(0,0,0,0.22) 2px 3px)}
.fx-ov-scan::after{content:'';position:absolute;left:0;right:0;height:90px;top:-90px;background:linear-gradient(to bottom,transparent,rgba(255,255,255,0.05),transparent);animation:fx-roll 5s linear infinite}
@keyframes fx-roll{to{transform:translateY(calc(100vh + 180px))}}
.fx-ov-iris{position:fixed;left:0;top:0;width:0;height:0;border-radius:50%;box-shadow:0 0 0 300vmax #000;transform:translate(-50%,-50%)}
.fx-ov-curtain{position:fixed;top:0;bottom:0;width:50.5%;background:linear-gradient(90deg,#0a0a10,#000 40%,#0a0a10);box-shadow:0 0 40px rgba(0,0,0,0.9)}
.fx-ov-curtain.l{left:0;transform:translateX(-101%)}
.fx-ov-curtain.r{right:0;transform:translateX(101%)}
.fx-ov-curtain.l::after,.fx-ov-curtain.r::after{content:'';position:absolute;top:0;bottom:0;width:2px;background:#ff2d95;box-shadow:0 0 12px #ff2d95,0 0 30px #ff2d95}
.fx-ov-curtain.l::after{right:0}.fx-ov-curtain.r::after{left:0}
.fx-big-word{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font-family:'Space Grotesk',system-ui,sans-serif;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;white-space:nowrap;font-size:clamp(34px,9vw,96px);line-height:1;color:#fff}
.fx-slam{text-shadow:0 0 10px #fff,0 0 30px #ff2d95,0 0 60px #ff2d95,3px 0 rgba(0,240,255,0.7),-3px 0 rgba(255,45,149,0.7);font-style:italic}
.fx-slam b{color:#ffb800;text-shadow:0 0 10px #fff,0 0 30px #ffb800,0 0 60px #ffb800;font-size:1.25em}
.fx-stamp{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-12deg);font-family:'Space Grotesk',system-ui,sans-serif;font-size:clamp(30px,7vw,68px);font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#b6ff00;border:5px solid #b6ff00;border-radius:12px;padding:6px 22px;line-height:1;box-shadow:0 0 20px rgba(182,255,0,0.4),inset 0 0 20px rgba(182,255,0,0.15);text-shadow:0 0 12px rgba(182,255,0,0.7);-webkit-mask-image:radial-gradient(circle at 30% 40%,#000 55%,rgba(0,0,0,0.85) 70%,#000 100%);mask-image:radial-gradient(circle at 30% 40%,#000 55%,rgba(0,0,0,0.85) 70%,#000 100%)}
.fx-chrome{background:linear-gradient(100deg,#b8c4d6 0%,#ffffff 18%,#7c8aa3 32%,#ffe6f3 45%,#9ad3ff 55%,#ffffff 68%,#7c8aa3 80%,#f5f7fb 100%);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:fx-chrome 2.2s linear infinite;filter:drop-shadow(0 2px 0 rgba(0,0,0,0.6)) drop-shadow(0 0 18px rgba(0,240,255,0.35))}
@keyframes fx-chrome{to{background-position:-300% 0}}
.fx-holo{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font-family:'Space Grotesk',system-ui,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.3em;text-transform:uppercase;color:rgba(242,242,246,0.62);margin-top:60px}
.fx-trophy{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(0);width:150px;height:150px}
.fx-trophy svg{width:100%;height:100%;overflow:visible}
.fx-trophy .shine{position:absolute;inset:0;border-radius:50%;overflow:hidden}
.fx-trophy .shine::after{content:'';position:absolute;top:-20%;left:-60%;width:40%;height:140%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.75),transparent);transform:skewX(-20deg);animation:fx-shine 1.1s 0.5s ease-in-out 1 both}
@keyframes fx-shine{to{left:130%}}
.fx-stars{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;gap:10px}
.fx-stars svg{width:64px;height:64px;transform:scale(0);overflow:visible}
.fx-lvl{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;font-family:'Space Grotesk',system-ui,sans-serif}
.fx-lvl .l1{font-size:12px;font-weight:700;letter-spacing:0.4em;text-transform:uppercase;color:#ffb800;text-shadow:0 0 10px rgba(255,184,0,0.6)}
.fx-lvl .l2{font-size:clamp(50px,12vw,120px);font-weight:800;line-height:1;color:#fff;text-shadow:0 0 20px #fff,0 0 40px #ffb800,0 0 90px #ffb800}
.fx-spark-dot{position:fixed;font-size:14px;line-height:1}
.fx-neon-word{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font-family:'Space Grotesk',system-ui,sans-serif;font-size:clamp(38px,9vw,92px);font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#fff;text-shadow:0 0 6px #fff,0 0 18px #ff2d95,0 0 42px #ff2d95,0 0 80px #ff2d95;text-align:center;white-space:nowrap}
.fx-wipe-bar{position:fixed;top:0;bottom:0;width:6px;background:#fff;box-shadow:0 0 20px #00f0ff,0 0 60px #00f0ff}
.fx-wipe-fill{position:fixed;top:0;bottom:0;left:0;background:#000}
.fx-ov-slice{position:fixed;background:rgba(255,255,255,0.05);border-top:1px solid rgba(0,240,255,0.5);border-bottom:1px solid rgba(255,45,149,0.5)}
.fx-clone{position:fixed !important;margin:0 !important;pointer-events:none;z-index:62;mix-blend-mode:screen;opacity:0.95;min-height:0 !important}
.fx-clone *{pointer-events:none !important}
.fx-clone.gl-r{filter:url(#fx-red)}
.fx-clone.gl-c{filter:url(#fx-cyan)}
.fx-glitch{animation:fx-glitch-card 0.55s steps(1) both}
.fx-glitch *{text-shadow:2px 0 rgba(255,45,149,0.9),-2px 0 rgba(0,240,255,0.9)}
@keyframes fx-glitch-card{0%{transform:translate(0,0) skewX(0)}10%{transform:translate(-6px,2px) skewX(-4deg)}20%{transform:translate(5px,-3px) skewX(3deg)}30%{transform:translate(-3px,1px) skewX(0)}45%{transform:translate(7px,0) skewX(-6deg)}55%{transform:translate(-4px,3px) skewX(2deg)}70%{transform:translate(2px,-1px) skewX(0)}85%{transform:translate(-1px,0) skewX(1deg)}100%{transform:translate(0,0) skewX(0)}}
.fx-flicker-off{opacity:0.08 !important;text-shadow:none !important;box-shadow:none !important}
.fx-caret{display:inline-block;width:0.55em;height:1em;background:#00f0ff;vertical-align:-0.15em;margin-left:2px;box-shadow:0 0 8px #00f0ff;animation:fx-blink 0.9s steps(1) infinite}
@keyframes fx-blink{50%{opacity:0}}
.fx-gtext{text-shadow:2px 0 rgba(255,45,149,0.8),-2px 0 rgba(0,240,255,0.8)}
.fx-lit{border-color:#ff2d95 !important;box-shadow:0 0 14px rgba(255,45,149,0.55),inset 0 0 14px rgba(255,45,149,0.12) !important}
.fx-dim{transition:filter 0.3s;filter:brightness(0.7)}
.fx-haze{filter:url(#fx-haze)}
.fx-shimmer{position:relative;isolation:isolate}
.fx-shimmer::before{content:'';position:absolute;inset:-3px;border-radius:14px;z-index:-1;background:conic-gradient(#ff2d95,#ffb800,#b6ff00,#00f0ff,#a855f7,#ff2d95);animation:fx-hue 1.1s linear infinite;filter:blur(0.6px)}
.fx-shimmer::after{content:'';position:absolute;inset:0;border-radius:12px;overflow:hidden;z-index:1;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,0.45) 50%,transparent 65%);background-size:250% 100%;animation:fx-sheen 1.1s ease-in-out infinite}
@keyframes fx-hue{to{filter:hue-rotate(360deg) blur(0.6px)}}
@keyframes fx-sheen{0%{background-position:120% 0}100%{background-position:-20% 0}}
.fx-reduced .fx-ov-scan::after{animation:none}
.fx-reduced .fx-shimmer::before,.fx-reduced .fx-shimmer::after,.fx-reduced .fx-chrome{animation-duration:3s}
.fx-reduced .fx-glitch{animation:none}
`;

  const SVG_DEFS = '<defs>'
    + '<filter id="fx-red"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>'
    + '<filter id="fx-cyan"><feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0"/></filter>'
    + '<filter id="fx-haze" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence id="fx-haze-turb" type="fractalNoise" baseFrequency="0.012 0.03" numOctaves="2" seed="3" result="n"/><feDisplacementMap id="fx-haze-disp" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter>'
    + '<filter id="fx-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    + '</defs>';

  // ── ENGINE ────────────────────────────────────────────────────────────────
  const FX = (() => {
    const html = document.documentElement;
    const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedOverride = null;             // null → follow OS
    const reduced = () => reducedOverride === null ? !!(mq && mq.matches) : !!reducedOverride;
    let enabled = true;
    let inited = false;
    let bg = null, fg = null, dom = null;
    const actors = new Set();
    const timers = new Set();
    const cleanups = new Set();
    const loops = new Map();               // id → { stop, params }
    const pointer = { x: -9999, y: -9999, down: false, moved: 0, vx: 0, vy: 0, t: 0 };
    const pointerHooks = new Set(), downHooks = new Set();
    let running = false, last = 0, manual = false;
    const DT_CAP = 0.05;

    // Targets are supplied by the page (functions so they always read the live DOM).
    let targets = {
      card: () => document.querySelector('.paper') || document.body,
      options: () => Array.from(document.querySelectorAll('#qz-options .opt')),
      chosen: () => document.querySelector('#qz-options .opt.wrong, #qz-options .opt.correct'),
      sign: () => document.querySelector('header .brand'),
      shake: () => document.querySelector('.desk'),
      why: () => document.getElementById('qz-why'),
      qtext: () => document.getElementById('qz-text'),
    };

    // Small phones and low-DPR screens get fewer particles.
    function perfScale() {
      const w = window.innerWidth || 1024;
      const dpr = window.devicePixelRatio || 1;
      let s = 1;
      if (w < 600) s *= 0.55; else if (w < 900) s *= 0.8;
      if (dpr < 1.5 && w < 900) s *= 0.85;
      return s;
    }
    // Count helper: full vs reduced, then scaled.
    const N = (full, red) => Math.max(1, Math.round((reduced() ? red : full) * perfScale()));

    function mkLayer(id) {
      const el = document.createElement('canvas'); el.id = id; el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
      const ctx = el.getContext('2d');
      const L = { el, ctx, w: 0, h: 0, dpr: 1 };
      L.resize = () => {
        L.dpr = Math.min(2, window.devicePixelRatio || 1);
        L.w = window.innerWidth; L.h = window.innerHeight;
        el.width = Math.round(L.w * L.dpr); el.height = Math.round(L.h * L.dpr);
        ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      };
      L.resize();
      return L;
    }

    function init(opts) {
      if (opts) targets = Object.assign(targets, opts);
      if (inited) return api;
      inited = true;
      const style = document.createElement('style'); style.id = 'fx-style'; style.textContent = CSS; document.head.appendChild(style);
      bg = mkLayer('fx-bg'); fg = mkLayer('fx-fg');
      dom = document.createElement('div'); dom.id = 'fx-dom'; dom.setAttribute('aria-hidden', 'true'); document.body.appendChild(dom);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'fx-svg'; svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = SVG_DEFS; document.body.appendChild(svg);
      window.addEventListener('resize', () => { bg.resize(); fg.resize(); });
      window.addEventListener('pointermove', (e) => {
        const now = performance.now(); const dt = Math.max(1, now - pointer.t) / 1000;
        pointer.vx = (e.clientX - pointer.x) / dt; pointer.vy = (e.clientY - pointer.y) / dt;
        pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = now; pointer.t = now;
        pointerHooks.forEach((h) => h(e));
      }, { passive: true });
      window.addEventListener('pointerdown', (e) => { pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY; downHooks.forEach((h) => h(e)); }, { passive: true });
      window.addEventListener('pointerup', () => { pointer.down = false; }, { passive: true });
      if (mq && mq.addEventListener) mq.addEventListener('change', syncReducedClass);
      syncReducedClass();
      document.addEventListener('visibilitychange', () => { if (!document.hidden && (actors.size)) ensure(); });
      return api;
    }
    function syncReducedClass() { html.classList.toggle('fx-reduced', reduced()); }

    function loop(now) {
      const dt = Math.min(DT_CAP, (now - last) / 1000) || 0.016; last = now;
      bg.ctx.clearRect(0, 0, bg.w, bg.h); fg.ctx.clearRect(0, 0, fg.w, fg.h);
      for (const a of actors) {
        try {
          a.t = (a.t || 0) + dt;
          a.update(dt, a.t);
          if (a.dead) { actors.delete(a); if (a.onEnd) a.onEnd(); continue; }
          if (a.layer === 'none') continue;
          const ctx = a.layer === 'bg' ? bg.ctx : fg.ctx;
          ctx.save(); a.draw(ctx, a.t); ctx.restore();
        } catch (err) { console.error('[fx actor]', err); (global.__fxErr = global.__fxErr || []).push(String(err && err.stack || err).split('\n').slice(0, 2).join(' | ')); actors.delete(a); }
      }
      if (manual) return;
      if (actors.size && !document.hidden) requestAnimationFrame(loop); else running = false;
    }
    function ensure() { if (!running) { running = true; last = performance.now(); requestAnimationFrame(loop); } }
    function step(n) { manual = true; for (let i = 0; i < n; i++) loop(last + 1000 / 60); manual = false; } // test hook
    function add(a) { a.layer = a.layer || 'fg'; a.t = 0; actors.add(a); ensure(); return a; }
    function later(fn, ms) { const h = setTimeout(() => { timers.delete(h); fn(); }, ms); timers.add(h); return h; }
    function onStop(fn) { cleanups.add(fn); return () => cleanups.delete(fn); }
    function domEl(tag, cls, parent) { const el = document.createElement(tag); if (cls) el.className = cls; (parent || dom).appendChild(el); return el; }
    function stopAll() {
      for (const [, l] of loops) { try { l.stop(); } catch (e) { /* */ } } loops.clear();
      for (const a of actors) { if (a.kill) { try { a.kill(); } catch (e) { /* */ } } } actors.clear();
      for (const h of timers) clearTimeout(h); timers.clear();
      for (const fn of cleanups) { try { fn(); } catch (e) { console.error(e); } } cleanups.clear();
      if (dom) { dom.innerHTML = ''; dom.style.zIndex = ''; }
      document.querySelectorAll('.fx-clone').forEach((c) => c.remove());
      const card = targets.card(); if (card) { card.classList.remove('fx-glitch', 'fx-dim', 'fx-haze'); }
      const sh = targets.shake(); if (sh) sh.style.transform = '';
      (targets.options() || []).forEach((o) => o.classList.remove('fx-lit', 'fx-flicker-off', 'fx-shimmer'));
      const sign = targets.sign(); if (sign) sign.classList.remove('fx-flicker-off');
      if (bg) bg.ctx.clearRect(0, 0, bg.w, bg.h); if (fg) fg.ctx.clearRect(0, 0, fg.w, fg.h);
    }

    // ── geometry helpers ─────────────────────────────────────────────────
    const rect = (el) => el.getBoundingClientRect();
    const cardEl = () => targets.card() || document.body;
    const cardRect = () => rect(cardEl());
    const opts = () => targets.options() || [];
    let explicitTarget = null;
    function chosen() {
      const c = explicitTarget || targets.chosen();
      if (c && c.isConnected) return c;
      const o = opts();
      return o[1] || o[0] || cardEl();
    }
    const chosenRect = () => rect(chosen());
    function cloneCard(extraClass, parent) {
      const card = cardEl(); const r = cardRect(); const c = card.cloneNode(true);
      c.removeAttribute('id'); c.className = card.className + ' fx-clone ' + (extraClass || '');
      c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      c.querySelectorAll('canvas').forEach((n) => n.remove());
      c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
      c.style.transform = ''; c.style.transformOrigin = '0 0';
      (parent || dom).appendChild(c); return c;
    }
    function rr(ctx, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

    // ── registry ───────────────────────────────────────────────────────────
    const defs = []; const groups = [];
    function group(id, title, sub) { groups.push({ id, title, sub }); }
    function def(d) { d.group = d.group || groups[groups.length - 1].id; defs.push(d); return d; }
    const byId = (id) => defs.find((d) => d.id === id);

    const api = {
      init, step, reduced, add, later, onStop, domEl, stopAll, cardRect, cardEl, chosenRect, chosen, opts, cloneCard, rect, rr, pointer, pointerHooks, downHooks, defs, groups, group, def, ensure, actors, N, perfScale,
      get bg() { return bg; }, get fg() { return fg; }, get dom() { return dom; }, targets: () => targets,
      setTargets: (t) => { targets = Object.assign(targets, t); },
      setReducedMotion: (v) => { reducedOverride = (v === null || v === undefined) ? null : !!v; syncReducedClass(); },
      reducedOverride: () => reducedOverride,
      setEnabled: (v) => { enabled = !!v; if (!enabled) stopAll(); },
      isEnabled: () => enabled,
      fire(id, o) {
        if (!inited) init();
        if (!enabled) return false;
        const d = byId(id); if (!d) { console.warn('[fx] no such effect', id); return false; }
        o = o || {};
        explicitTarget = o.target || null;
        try { if (d.kind === 'loop') { api.loop(id, o.params); } else d.fire(o); }
        catch (e) { console.error('[fx]', id, e); (global.__fxErr = global.__fxErr || []).push(id + ': ' + String(e && e.message)); return false; }
        finally { explicitTarget = null; }
        return true;
      },
      loop(id, params) {
        if (!inited) init();
        if (!enabled) return null;
        const d = byId(id); if (!d || d.kind !== 'loop') { console.warn('[fx] no such loop', id); return null; }
        if (loops.has(id)) { if (params) Object.assign(loops.get(id).params, params); return loops.get(id); }
        const p = {}; (d.params || []).forEach((q) => { p[q.key] = q.value; }); Object.assign(p, params || {});
        let stop = null;
        try { stop = d.start(p) || (() => {}); } catch (e) { console.error('[fx loop]', id, e); return null; }
        const entry = { id, params: p, stop: () => { try { stop(); } catch (e) { /* */ } loops.delete(id); } };
        loops.set(id, entry);
        return entry;
      },
      stopLoop(id) { const l = loops.get(id); if (l) l.stop(); },
      isLooping: (id) => loops.has(id),
      loopsRunning: () => Array.from(loops.keys()),
      setLoopParam(id, key, value) { const l = loops.get(id); if (l) l.params[key] = value; },
      list: () => defs.map((d) => ({ id: d.id, name: d.name, group: d.group, purpose: d.purpose, cost: d.cost, kind: d.kind || 'fire', star: !!d.star, phone: d.phone !== false, params: d.params || [] })),
      groups: () => groups.slice(),
      errors: () => (global.__fxErr || []).slice(),
    };
    return api;
  })();

  // ── shared helpers for effects ─────────────────────────────────────────
  function blobPoints(n, r, irr, spikes) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + R(-0.35, 0.35) / n * TAU;
      let rad = r * (1 + R(-irr, irr));
      if (spikes && Math.random() < spikes) rad *= R(1.3, 1.65);
      pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
    }
    return pts;
  }
  function tracePts(ctx, pts, x, y, s) {
    s = s || 1; const n = pts.length;
    ctx.beginPath();
    let px = (pts[0][0] + pts[1][0]) / 2, py = (pts[0][1] + pts[1][1]) / 2;
    ctx.moveTo(x + px * s, y + py * s);
    for (let i = 1; i <= n; i++) {
      const p = pts[i % n], q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(x + p[0] * s, y + p[1] * s, x + (p[0] + q[0]) / 2 * s, y + (p[1] + q[1]) / 2 * s);
    }
    ctx.closePath();
  }
  function glowCircle(ctx, x, y, r, color, a) {
    if (!(r > 0)) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, a)); g.addColorStop(0.5, rgba(color, a * 0.35)); g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function star(ctx, x, y, r, n, inner, rot) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) { const a = rot + (i / (n * 2)) * TAU; const rad = i % 2 ? r * inner : r; ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); }
    ctx.closePath();
  }
  function timeline(steps) { steps.forEach(([ms, fn]) => FX.later(fn, ms)); }
  function tween(dur, fn, easing, onEnd) {
    const a = { layer: 'none', update(dt, t) { const p = clamp(t / dur, 0, 1); fn((easing || ease.outCubic)(p), p); if (p >= 1) a.dead = true; }, draw() {}, onEnd };
    return FX.add(a);
  }
  function makeSplat(x, y, color, o) {
    o = o || {};
    const r = o.r || R(34, 78);
    const main = blobPoints(RI(14, 20), r, 0.22, 0.18);
    const sats = []; const nS = FX.reduced() ? 5 : RI(9, 18);
    for (let i = 0; i < nS; i++) { const a = R(0, TAU), d = R(r * 0.9, r * 2.6); sats.push({ a, d0: r * 0.6, d, rr: R(2, 8), pts: blobPoints(7, 1, 0.3, 0) }); }
    const drips = []; const nD = FX.reduced() ? 1 : RI(2, 4);
    for (let i = 0; i < nD; i++) { const ox = R(-r * 0.7, r * 0.7); drips.push({ ox, oy: Math.sqrt(Math.max(0, r * r - ox * ox)) * 0.7, len: 0, max: R(70, 210), w: R(3, 6.5), speed: R(70, 150), t: R(0.15, 0.6) }); }
    return { x, y, color, r, main, sats, drips, seeds: o.seeds || null, t: 0, life: o.life || 4.2, gloss: o.gloss !== false, dark: o.dark };
  }
  function drawSplat(ctx, s, dt) {
    s.t += dt;
    const app = clamp(s.t / 0.16, 0, 1); const sc = 0.35 + 0.65 * ease.outBack(app);
    const fade = s.t > s.life ? clamp(1 - (s.t - s.life) / 0.9, 0, 1) : 1;
    ctx.globalAlpha = fade;
    ctx.fillStyle = s.color;
    tracePts(ctx, s.main, s.x, s.y, sc); ctx.fill();
    const sp = ease.outCubic(clamp(s.t / 0.22, 0, 1));
    s.sats.forEach((o) => { const d = lerp(o.d0, o.d, sp); tracePts(ctx, o.pts, s.x + Math.cos(o.a) * d, s.y + Math.sin(o.a) * d, o.rr * (0.6 + 0.4 * sp)); ctx.fill(); });
    s.drips.forEach((d) => {
      if (s.t < d.t) return; d.len = Math.min(d.max, d.len + d.speed * dt * Math.max(0.15, 1 - d.len / d.max));
      const x = s.x + d.ox, y0 = s.y + d.oy * sc, y1 = y0 + d.len;
      ctx.lineCap = 'round'; ctx.strokeStyle = s.color;
      ctx.lineWidth = d.w; ctx.beginPath(); ctx.moveTo(x, y0 - 4); ctx.lineTo(x, y0 + d.len * 0.55); ctx.stroke();
      ctx.lineWidth = d.w * 0.6; ctx.beginPath(); ctx.moveTo(x, y0 + d.len * 0.5); ctx.lineTo(x, y1); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y1, d.w * 0.55, 0, TAU); ctx.fill();
    });
    if (s.seeds) { ctx.fillStyle = s.seeds; s.sats.slice(0, 6).forEach((o) => { const d = lerp(o.d0, o.d, sp) * 0.5; ctx.beginPath(); ctx.ellipse(s.x + Math.cos(o.a) * d, s.y + Math.sin(o.a) * d, 4, 2.2, o.a, 0, TAU); ctx.fill(); }); }
    if (s.gloss) { ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.beginPath(); ctx.ellipse(s.x - s.r * 0.3 * sc, s.y - s.r * 0.35 * sc, s.r * 0.35 * sc, s.r * 0.18 * sc, -0.6, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
    return fade <= 0;
  }
  function shakeStage(mag, dur) {
    if (FX.reduced()) return;
    const inner = FX.targets().shake(); if (!inner) return;
    const base = inner.style.transform.replace(/translate\([^)]*\)\s*rotate\([^)]*\)\s*/, '');
    const a = { layer: 'none', update(dt, t) { const p = t / dur; if (p >= 1) { a.dead = true; inner.style.transform = base; return; } const m = mag * (1 - p) * (1 - p); inner.style.transform = 'translate(' + R(-m, m).toFixed(1) + 'px,' + R(-m, m).toFixed(1) + 'px) rotate(' + R(-m * 0.15, m * 0.15).toFixed(2) + 'deg) ' + base; }, draw() {}, kill() { inner.style.transform = base; } };
    FX.add(a);
  }
  function flash(color, peak, dur) {
    const el = FX.domEl('div', 'fx-ov-flash'); el.style.background = color || '#fff';
    tween(dur || 0.35, (e, p) => { el.style.opacity = (p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85) * (peak || 0.8); }, ease.linear, () => el.remove());
    FX.onStop(() => el.remove());
  }
  function centerOf(r) { return [r.left + r.width / 2, r.top + r.height / 2]; }
  function fitFontToRect(el, r) { // keep a big word inside the card on phones
    const max = Math.max(160, r.width - 20);
    if (el.scrollWidth > max) el.style.fontSize = Math.max(22, parseFloat(getComputedStyle(el).fontSize) * max / el.scrollWidth) + 'px';
  }

  /* ═══════════════ GROUP 1 — CORRECT ANSWER ═══════════════ */
  FX.group('correct', 'Correct answer', 'The hit. One of these fires the instant they tap the right option.');

  FX.def({ id: 'paint-splat', name: 'Paint splat', star: true, purpose: 'correct answer - big hit', cost: 'medium', phone: true,
    fire() {
      const cr = FX.cardRect(); const n = FX.reduced() ? 2 : RI(3, 5); const splats = [];
      for (let i = 0; i < n; i++) {
        FX.later(() => { splats.push(makeSplat(R(cr.left - 60, cr.right + 60), R(Math.max(0, cr.top - 40), Math.min(FX.fg.h, cr.bottom + 20)), pick(NEON), { r: R(38, 88) * (FX.perfScale() < 1 ? 0.75 : 1) })); }, i * R(60, 140));
      }
      const a = { _dt: 1 / 60, update(dt, t) { a._dt = dt; if (t > 7) a.dead = true; }, draw(ctx, t) { for (let i = splats.length - 1; i >= 0; i--) if (drawSplat(ctx, splats[i], a._dt)) splats.splice(i, 1); if (t > 0.6 && !splats.length) a.dead = true; } };
      FX.add(a);
    } });

  FX.def({ id: 'ink-drop', name: 'Ink drop & bleed', purpose: 'correct answer - quieter hit', cost: 'medium', phone: true,
    fire() {
      const r = FX.chosenRect(); const x = r.left + r.width * R(0.3, 0.7), y = r.top + r.height / 2;
      const col = pick(['#00f0ff', '#ff2d95', '#a855f7']);
      const n = 24; const rad = []; const noise = []; for (let i = 0; i < n; i++) { rad.push(1); noise.push(R(0.7, 1.3)); }
      const tend = []; for (let i = 0; i < (FX.reduced() ? 4 : 10); i++) { const a = R(0, TAU); tend.push({ a, pts: [[0, 0]], len: 0, max: R(30, 90), da: 0 }); }
      const a = { update(dt, t) {
        for (let i = 0; i < n; i++) { noise[i] += R(-0.08, 0.08) * dt * 6; noise[i] = clamp(noise[i], 0.7, 1.35); }
        tend.forEach((tt) => { if (t < 0.25 || tt.len >= tt.max) return; tt.da += R(-0.9, 0.9) * dt * 6; tt.da *= 0.9; const step = 55 * dt; const last = tt.pts[tt.pts.length - 1]; tt.pts.push([last[0] + Math.cos(tt.a + tt.da) * step, last[1] + Math.sin(tt.a + tt.da) * step]); tt.len += step; });
        if (t > 5.2) a.dead = true; },
        draw(ctx, t) {
          const grow = Math.sqrt(clamp(t / 1.6, 0, 1)) * (FX.reduced() ? 60 : 92); const fade = t > 4 ? 1 - (t - 4) / 1.2 : 1;
          ctx.globalAlpha = fade;
          for (let k = 3; k >= 0; k--) {
            const rr2 = grow * (1 + k * 0.12); ctx.fillStyle = rgba(col, k === 0 ? 0.95 : 0.12);
            ctx.beginPath(); for (let i = 0; i < n; i++) { const an = (i / n) * TAU; const rad2 = rr2 * noise[i]; ctx.lineTo(x + Math.cos(an) * rad2, y + Math.sin(an) * rad2); } ctx.closePath(); ctx.fill();
          }
          ctx.strokeStyle = rgba(col, 0.55); ctx.lineWidth = 1.2; ctx.lineCap = 'round';
          tend.forEach((tt) => { const ox = x + Math.cos(tt.a) * grow * 0.85, oy = y + Math.sin(tt.a) * grow * 0.85; ctx.beginPath(); ctx.moveTo(ox, oy); tt.pts.forEach((p) => ctx.lineTo(ox + p[0], oy + p[1])); ctx.stroke(); });
          if (t < 0.25) { const p = t / 0.25; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y - (1 - p * p) * 140, 7 - p * 3, 0, TAU); ctx.fill(); }
          ctx.globalAlpha = 1;
        } };
      FX.add(a);
    } });

  FX.def({ id: 'confetti', name: 'Confetti cannon', purpose: 'correct answer - classic hit', cost: 'medium', phone: true,
    fire() {
      const W = FX.fg.w, H = FX.fg.h; const P = []; const per = FX.N(110, 35);
      [[0, -0.35], [W, Math.PI + 0.35]].forEach(([x]) => {
        for (let i = 0; i < per; i++) {
          const sp = R(700, 1400);
          const dir = x === 0 ? R(-1.35, -0.75) : R(-2.4, -1.8);
          P.push({ x, y: H + 10, vx: Math.cos(dir) * sp, vy: Math.sin(dir) * sp, w: R(6, 12), h: R(8, 16), rot: R(0, TAU), rv: R(-9, 9), c: pick(NEON.concat(['#ffffff'])), sh: pick(['r', 'r', 'rib', 'c']), ph: R(0, TAU), wf: R(6, 11), spin: R(0, TAU), sv: R(4, 10) });
        }
      });
      const a = { update(dt, t) { let alive = 0; P.forEach((p) => { if (p.y > H + 40) return; alive++; p.vy += 900 * dt; p.vx *= Math.pow(0.35, dt); p.vy *= Math.pow(0.55, dt); p.x += p.vx * dt + Math.sin(t * p.wf + p.ph) * 40 * dt; p.y += p.vy * dt; p.rot += p.rv * dt; p.spin += p.sv * dt; }); if (!alive || t > 7) a.dead = true; },
        draw(ctx) { P.forEach((p) => { if (p.y > H + 40) return; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); const sx = Math.cos(p.spin); ctx.fillStyle = p.c; if (p.sh === 'c') { ctx.beginPath(); ctx.ellipse(0, 0, p.w * 0.5 * Math.abs(sx) + 0.5, p.w * 0.5, 0, 0, TAU); ctx.fill(); } else if (p.sh === 'rib') { ctx.scale(sx || 0.01, 1); ctx.beginPath(); ctx.moveTo(-p.w / 2, -p.h); ctx.quadraticCurveTo(p.w, -p.h / 2, -p.w / 2, 0); ctx.quadraticCurveTo(p.w, p.h / 2, -p.w / 2, p.h); ctx.lineWidth = 3; ctx.strokeStyle = p.c; ctx.stroke(); } else { ctx.scale(sx || 0.01, 1); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.fillStyle = 'rgba(0,0,0,0.18)'; if (sx < 0) ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); } ctx.restore(); }); } };
      FX.add(a);
    } });

  FX.def({ id: 'fireworks', name: 'Fireworks', purpose: 'correct answer - streak milestone / end of run', cost: 'medium', phone: true,
    fire() {
      const W = FX.fg.w, H = FX.fg.h; const rockets = [], parts = [], trails = [];
      const n = FX.reduced() ? 2 : RI(3, 5);
      for (let i = 0; i < n; i++) FX.later(() => rockets.push({ x: R(W * 0.15, W * 0.85), y: H + 6, vx: R(-40, 40), vy: -R(H * 0.95, H * 1.35), c: pick(NEON), ring: Math.random() < 0.35 }), i * R(120, 320));
      function burst(r) { const m = FX.N(90, 40); for (let i = 0; i < m; i++) { const a = R(0, TAU), sp = r.ring ? R(230, 260) : R(40, 320); parts.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, c: Math.random() < 0.2 ? '#ffffff' : r.c, life: R(1.1, 2.1), t: 0, tw: R(8, 16) }); } }
      const a = { update(dt, t) {
        for (let i = rockets.length - 1; i >= 0; i--) { const r = rockets[i]; r.vy += 500 * dt; r.x += r.vx * dt; r.y += r.vy * dt; trails.push({ x: r.x, y: r.y, t: 0, c: r.c }); if (r.vy > -60) { burst(r); rockets.splice(i, 1); } }
        for (let i = trails.length - 1; i >= 0; i--) { trails[i].t += dt; if (trails[i].t > 0.4) trails.splice(i, 1); }
        for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.t += dt; p.vy += 220 * dt; p.vx *= Math.pow(0.25, dt); p.vy *= Math.pow(0.4, dt); p.x += p.vx * dt; p.y += p.vy * dt; if (p.t > p.life) parts.splice(i, 1); }
        if (t > 1 && !rockets.length && !parts.length) a.dead = true; if (t > 9) a.dead = true; },
        draw(ctx) { ctx.globalCompositeOperation = 'lighter';
          trails.forEach((s) => { ctx.fillStyle = rgba(s.c, 0.6 * (1 - s.t / 0.4)); ctx.beginPath(); ctx.arc(s.x, s.y, 2.5 * (1 - s.t / 0.4), 0, TAU); ctx.fill(); });
          rockets.forEach((r) => { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r.x, r.y, 2.5, 0, TAU); ctx.fill(); });
          parts.forEach((p) => { const k = 1 - p.t / p.life; const tw = k < 0.5 ? (0.55 + 0.45 * Math.sin(p.t * p.tw)) : 1; ctx.strokeStyle = rgba(p.c, k * tw); ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke(); if (k > 0.6) glowCircle(ctx, p.x, p.y, 8, p.c, 0.35 * k); });
        } };
      FX.add(a);
    } });

  FX.def({ id: 'sparks', name: 'Spark shower from the answer', purpose: 'correct answer - small hit', cost: 'light', phone: true,
    fire() {
      const r = FX.chosenRect(); const P = []; const n = FX.N(90, 30);
      for (let i = 0; i < n; i++) { const x = R(r.left, r.right); const up = Math.random() < 0.7; P.push({ x, y: up ? r.top : r.bottom, vx: R(-260, 260), vy: up ? -R(160, 620) : R(60, 260), life: R(0.5, 1.2), t: 0, w: R(1, 2.4) }); }
      const a = { update(dt, t) { P.forEach((p) => { p.t += dt; p.vy += 1300 * dt; p.vx *= Math.pow(0.5, dt); p.x += p.vx * dt; p.y += p.vy * dt; }); if (t > 1.4) a.dead = true; },
        draw(ctx) { ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; P.forEach((p) => { const k = 1 - p.t / p.life; if (k <= 0) return; ctx.strokeStyle = k > 0.6 ? 'rgba(255,255,255,' + k + ')' : rgba('#ffb800', k); ctx.lineWidth = p.w; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke(); }); } };
      FX.add(a);
    } });

  FX.def({ id: 'coins', name: 'Coin & gem shower', purpose: 'correct answer - XP moment', cost: 'medium', phone: true,
    fire() {
      const cr = FX.cardRect(); const floor = Math.min(FX.fg.h - 6, cr.bottom + 20); const P = []; const n = FX.N(34, 14);
      for (let i = 0; i < n; i++) FX.later(() => P.push({ x: R(cr.left - 30, cr.right + 30), y: Math.max(-20, cr.top - 60), vx: R(-70, 70), vy: R(0, 120), r: R(7, 12), gem: Math.random() < 0.3, ph: R(0, TAU), sv: R(6, 14), rot: R(0, TAU), rv: R(-5, 5), b: 0, c: pick(['#00f0ff', '#ff2d95', '#a855f7']), t: 0 }), i * R(20, 60));
      const a = { update(dt, t) { P.forEach((p) => { p.t += dt; p.vy += 1500 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.ph += p.sv * dt; p.rot += p.rv * dt; if (p.y + p.r > floor && p.vy > 0) { p.y = floor - p.r; p.vy = -p.vy * 0.45; p.vx *= 0.7; p.sv *= 0.7; p.rv *= 0.6; p.b++; if (Math.abs(p.vy) < 60) { p.vy = 0; p.rest = true; } } }); if (t > 5.5) a.dead = true; },
        draw(ctx, t) { const fade = t > 4.4 ? 1 - (t - 4.4) / 1.1 : 1; ctx.globalAlpha = fade; P.forEach((p) => { ctx.save(); ctx.translate(p.x, p.y);
          if (p.gem) { ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.shadowColor = p.c; ctx.shadowBlur = 10; ctx.beginPath(); ctx.moveTo(0, -p.r * 1.2); ctx.lineTo(p.r * 0.9, -p.r * 0.3); ctx.lineTo(p.r * 0.55, p.r); ctx.lineTo(-p.r * 0.55, p.r); ctx.lineTo(-p.r * 0.9, -p.r * 0.3); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.moveTo(-p.r * 0.4, -p.r * 0.35); ctx.lineTo(0, -p.r * 0.95); ctx.lineTo(p.r * 0.35, -p.r * 0.35); ctx.closePath(); ctx.fill(); }
          else { const sx = Math.abs(Math.cos(p.ph)); const g = ctx.createLinearGradient(-p.r, -p.r, p.r, p.r); g.addColorStop(0, '#fff2a8'); g.addColorStop(0.5, '#ffb800'); g.addColorStop(1, '#a86a00'); ctx.fillStyle = g; ctx.shadowColor = '#ffb800'; ctx.shadowBlur = 8; ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1.2, p.r * sx), p.r, 0, 0, TAU); ctx.fill(); ctx.shadowBlur = 0; if (sx > 0.35) { ctx.fillStyle = 'rgba(120,70,0,0.55)'; ctx.beginPath(); ctx.ellipse(0, 0, p.r * sx * 0.62, p.r * 0.62, 0, 0, TAU); ctx.fill(); ctx.fillStyle = '#ffe9a0'; ctx.font = 'bold ' + (p.r * 1.1) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.save(); ctx.scale(sx, 1); ctx.fillText('£', 0, 1); ctx.restore(); } }
          ctx.restore(); }); ctx.globalAlpha = 1; } };
      FX.add(a);
    } });

  FX.def({ id: 'shimmer', name: 'Rainbow shimmer on the option', purpose: 'correct answer - tiny, cheap', cost: 'light', phone: true,
    fire() { const o = FX.chosen(); if (!o) return; o.classList.add('fx-shimmer'); const un = FX.onStop(() => o.classList.remove('fx-shimmer')); FX.later(() => { o.classList.remove('fx-shimmer'); un(); }, 2600); } });

  FX.def({ id: 'sunburst', name: 'Level-up sunburst', star: true, purpose: 'level-up - big', cost: 'medium', phone: true,
    fire(o) {
      const cr = FX.cardRect(); const [cx, cy] = centerOf(cr); const RAD = Math.max(FX.fg.w, FX.fg.h);
      const el = FX.domEl('div', 'fx-lvl'); el.innerHTML = '<div class="l1"></div><div class="l2"></div>';
      el.querySelector('.l1').textContent = (o && o.label) || 'Level up'; el.querySelector('.l2').textContent = String((o && o.text) || (o && o.streak) || '');
      el.style.left = cx + 'px'; el.style.top = cy + 'px'; el.style.opacity = '0';
      const a = { update(dt, t) { if (t > 2.6) a.dead = true; const p = clamp(t / 0.55, 0, 1); const s = ease.outBack(p) * (t > 2 ? 1 + (t - 2) * 0.4 : 1); el.style.opacity = t > 2 ? String(1 - (t - 2) / 0.6) : String(p); el.style.transform = 'translate(-50%,-50%) scale(' + s.toFixed(3) + ')'; },
        draw(ctx, t) { const p = ease.outCubic(clamp(t / 0.6, 0, 1)); const fade = t > 1.9 ? 1 - (t - 1.9) / 0.7 : 1; ctx.globalCompositeOperation = 'lighter'; ctx.translate(cx, cy); ctx.rotate(t * 0.35); const nR = 22; for (let i = 0; i < nR; i++) { const a0 = (i / nR) * TAU, w = TAU / nR * 0.5; const g = ctx.createLinearGradient(0, 0, Math.cos(a0) * RAD, Math.sin(a0) * RAD); g.addColorStop(0, rgba('#ffb800', 0.55 * fade)); g.addColorStop(0.5, rgba('#ff2d95', 0.18 * fade)); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, RAD * p, a0 - w / 2, a0 + w / 2); ctx.closePath(); ctx.fill(); } ctx.rotate(-t * 0.35); glowCircle(ctx, 0, 0, 220 * p, '#ffb800', 0.55 * fade); },
        onEnd() { el.remove(); } };
      FX.add(a); FX.onStop(() => el.remove());
    } });

  FX.def({ id: 'trophy', name: 'Trophy / badge pop with shine', purpose: 'level-up - mastery badge', cost: 'light', phone: true,
    fire() {
      const cr = FX.cardRect(); const [cx, cy] = centerOf(cr);
      const el = FX.domEl('div', 'fx-trophy'); el.style.left = cx + 'px'; el.style.top = cy + 'px';
      el.innerHTML = '<svg viewBox="0 0 100 100"><defs><linearGradient id="fx-tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1b0"/><stop offset=".45" stop-color="#ffb800"/><stop offset="1" stop-color="#b8760a"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="#0e0e15" stroke="url(#fx-tg)" stroke-width="4" filter="url(#fx-glow)"/><circle cx="50" cy="50" r="38" fill="none" stroke="#ffb800" stroke-width="1" stroke-dasharray="3 4" opacity=".7"/><path d="M32 30h36v8a18 18 0 0 1-36 0z" fill="url(#fx-tg)"/><path d="M32 33h-8a8 8 0 0 0 8 12M68 33h8a8 8 0 0 1-8 12" fill="none" stroke="#ffb800" stroke-width="3" stroke-linecap="round"/><rect x="45" y="55" width="10" height="9" fill="#ffb800"/><rect x="38" y="64" width="24" height="6" rx="1" fill="url(#fx-tg)"/><path d="M50 36l3 6 6 .5-4.5 4 1.5 6-6-3.5-6 3.5 1.5-6-4.5-4 6-.5z" fill="#fff"/></svg><div class="shine"></div>';
      tween(0.7, (e) => { el.style.transform = 'translate(-50%,-50%) scale(' + e.toFixed(3) + ')'; }, ease.outBack);
      for (let i = 0; i < 6; i++) FX.later(() => { const d = FX.domEl('div', 'fx-spark-dot'); d.textContent = '✦'; d.style.color = pick(['#fff', '#ffb800', '#00f0ff']); const an = R(0, TAU), dist = R(70, 120); d.style.left = (cx + Math.cos(an) * 40) + 'px'; d.style.top = (cy + Math.sin(an) * 40) + 'px'; tween(0.6, (e, p) => { d.style.transform = 'translate(' + (Math.cos(an) * dist * e - 4) + 'px,' + (Math.sin(an) * dist * e - 4) + 'px) scale(' + (1.4 - p) + ') rotate(' + (p * 180) + 'deg)'; d.style.opacity = String(1 - p); }, ease.outCubic, () => d.remove()); }, 250 + i * 60);
      FX.later(() => tween(0.35, (e) => { el.style.transform = 'translate(-50%,-50%) scale(' + (1 - e) + ')'; el.style.opacity = String(1 - e); }, ease.inCubic, () => el.remove()), 2300);
      FX.onStop(() => el.remove());
    } });

  FX.def({ id: 'combo-slam', name: '"COMBO xN" kinetic text slam', star: true, purpose: 'streak - every few in a row', cost: 'light', phone: true,
    fire(o) {
      const el = FX.domEl('div', 'fx-big-word fx-slam'); const n = (o && o.streak) || 5; el.innerHTML = 'Combo <b></b>'; el.querySelector('b').textContent = 'x' + n;
      const cr = FX.cardRect(); const [cx, cy] = centerOf(cr); el.style.left = cx + 'px'; el.style.top = cy + 'px'; fitFontToRect(el, cr);
      const rings = [];
      tween(0.22, (e, p) => { const s = 4 - 3 * e; el.style.transform = 'translate(-50%,-50%) scale(' + s.toFixed(3) + ') rotate(' + (-6 + 6 * e) + 'deg)'; el.style.opacity = String(Math.min(1, p * 3)); }, ease.inCubic, () => {
        shakeStage(9, 0.35); rings.push({ t: 0 }); FX.later(() => rings.push({ t: 0 }), 90);
        tween(0.9, (e) => { el.style.transform = 'translate(-50%,-50%) scale(' + (1 + 0.06 * Math.sin(e * 14) * (1 - e)) + ') rotate(0deg)'; }, ease.linear, () => tween(0.3, (e) => { el.style.transform = 'translate(-50%,-50%) scale(' + (1 + e * 0.6) + ')'; el.style.letterSpacing = (0.02 + e * 0.3) + 'em'; el.style.opacity = String(1 - e); }, ease.inCubic, () => el.remove()));
      });
      const a = { update(dt, t) { rings.forEach((r) => r.t += dt); if (t > 1.6) a.dead = true; }, draw(ctx) { rings.forEach((r) => { const k = clamp(r.t / 0.6, 0, 1); if (k >= 1) return; ctx.strokeStyle = rgba('#ff2d95', 1 - k); ctx.lineWidth = 6 * (1 - k) + 1; ctx.beginPath(); ctx.arc(cx, cy, 30 + ease.outCubic(k) * 380, 0, TAU); ctx.stroke(); }); } };
      FX.add(a); FX.onStop(() => el.remove());
    } });

  FX.def({ id: 'stamp', name: '"CORRECT" rubber stamp', purpose: 'correct answer - quick, dry, satisfying', cost: 'light', phone: true,
    fire(o) {
      const el = FX.domEl('div', 'fx-stamp'); el.textContent = (o && o.text) || pick(['Correct', 'Nailed it', 'Yes', 'Bang on']); const cr = FX.cardRect(); const cx = cr.left + cr.width / 2, cy = cr.top + cr.height * 0.42; el.style.left = cx + 'px'; el.style.top = cy + 'px';
      tween(0.16, (e) => { el.style.transform = 'translate(-50%,-50%) rotate(-12deg) scale(' + (2.2 - 1.2 * e) + ')'; el.style.opacity = String(0.2 + 0.8 * e); }, ease.inCubic, () => {
        shakeStage(4, 0.2);
        const P = []; for (let i = 0; i < 18; i++) { const an = R(0, TAU); P.push({ x: cx, y: cy, vx: Math.cos(an) * R(80, 260), vy: Math.sin(an) * R(80, 260) - 60, t: 0 }); }
        const a = { update(dt, t) { P.forEach((p) => { p.t += dt; p.vy += 300 * dt; p.vx *= Math.pow(0.1, dt); p.vy *= Math.pow(0.1, dt); p.x += p.vx * dt; p.y += p.vy * dt; }); if (t > 0.7) a.dead = true; }, draw(ctx, t) { P.forEach((p) => { ctx.fillStyle = 'rgba(200,200,220,' + (0.5 * (1 - t / 0.7)) + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, 3 + t * 8, 0, TAU); ctx.fill(); }); } };
        FX.add(a);
        tween(0.4, (e) => { el.style.transform = 'translate(-50%,-50%) rotate(-12deg) scale(' + (1 + 0.08 * (1 - e) * Math.sin(e * 12)) + ')'; }, ease.linear);
      });
      FX.later(() => tween(0.25, (e) => { el.style.opacity = String(1 - e); }, ease.linear, () => el.remove()), 1600);
      FX.onStop(() => el.remove());
    } });

  FX.def({ id: 'sonar', name: 'Sonar rings from the answer', purpose: 'correct answer - minimal', cost: 'light', phone: true,
    fire() {
      const r = FX.chosenRect(); const rings = []; for (let i = 0; i < 3; i++) FX.later(() => rings.push({ t: 0 }), i * 140);
      const a = { update(dt, t) { rings.forEach((g) => g.t += dt); if (t > 1.6) a.dead = true; }, draw(ctx) { rings.forEach((g) => { const k = clamp(g.t / 0.9, 0, 1); if (k >= 1) return; const grow = ease.outCubic(k) * 60; ctx.strokeStyle = rgba('#b6ff00', 1 - k); ctx.lineWidth = 3 - 2 * k; ctx.shadowColor = '#b6ff00'; ctx.shadowBlur = 12; FX.rr(ctx, r.left - grow, r.top - grow, r.width + grow * 2, r.height + grow * 2, 10 + grow); ctx.stroke(); }); } };
      FX.add(a);
    } });

  FX.def({ id: 'stars', name: 'Three-star rating pop', purpose: 'level-up / topic mastered', cost: 'light', phone: true,
    fire() {
      const cr = FX.cardRect(); const el = FX.domEl('div', 'fx-stars'); el.style.left = (cr.left + cr.width / 2) + 'px'; el.style.top = (cr.top + cr.height / 2) + 'px';
      for (let i = 0; i < 3; i++) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 100 100'); s.innerHTML = '<polygon points="50,6 61,38 95,38 68,58 78,92 50,72 22,92 32,58 5,38 39,38" fill="#ffb800" stroke="#fff1b0" stroke-width="3" stroke-linejoin="round" filter="url(#fx-glow)"/>'; el.appendChild(s); FX.later(() => tween(0.75, (e) => { s.style.transform = 'scale(' + e.toFixed(3) + ') rotate(' + ((1 - e) * -40) + 'deg)'; }, ease.outElastic), 200 + i * 260); }
      FX.later(() => { for (let i = 0; i < 8; i++) { const d = FX.domEl('div', 'fx-spark-dot'); d.textContent = '✦'; d.style.color = '#fff'; const an = R(0, TAU); const r = FX.rect(el.lastChild); const x = r.left + r.width / 2, y = r.top + r.height / 2; d.style.left = x + 'px'; d.style.top = y + 'px'; tween(0.6, (e, p) => { d.style.transform = 'translate(' + (Math.cos(an) * 60 * e) + 'px,' + (Math.sin(an) * 60 * e) + 'px) scale(' + (1 - p) + ')'; }, ease.outCubic, () => d.remove()); } }, 950);
      FX.later(() => tween(0.3, (e) => { el.style.opacity = String(1 - e); }, ease.linear, () => el.remove()), 2400);
      FX.onStop(() => el.remove());
    } });

  /* ═══════════════ GROUP 2 — WRONG ANSWER ═══════════════ */
  FX.group('wrong', 'Wrong answer', 'The miss. Stings for half a second and gets out of the way of the WHY line.');

  FX.def({ id: 'tomato', name: 'Tomato splat', star: true, purpose: 'wrong answer - funny hit', cost: 'medium', phone: true,
    fire() {
      const r = FX.chosenRect(); const tx = r.left + r.width * R(0.35, 0.65), ty = r.top + r.height / 2; const H = FX.fg.h; const sx = R(FX.fg.w * 0.2, FX.fg.w * 0.8);
      let splat = null; const seedsFly = [];
      const a = { update(dt, t) { if (t >= 0.28 && !splat) { splat = makeSplat(tx, ty, '#e8262e', { r: R(48, 66) * (FX.perfScale() < 1 ? 0.8 : 1), seeds: '#f2df8a', life: 3.4 }); shakeStage(6, 0.3); for (let i = 0; i < 10; i++) { const an = R(0, TAU); seedsFly.push({ x: tx, y: ty, vx: Math.cos(an) * R(150, 400), vy: Math.sin(an) * R(150, 400) - 100, t: 0, a: R(0, TAU) }); } } seedsFly.forEach((s) => { s.t += dt; s.vy += 900 * dt; s.x += s.vx * dt; s.y += s.vy * dt; }); if (t > 6) a.dead = true; },
        draw(ctx, t) {
          if (!splat) { const p = ease.inQuad(t / 0.28); const x = lerp(sx, tx, p), y = lerp(H + 40, ty, p) - Math.sin(p * Math.PI) * 60; const s = 8 + p * 30; ctx.fillStyle = '#e8262e'; ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.arc(x - s * 0.3, y - s * 0.3, s * 0.3, 0, TAU); ctx.fill(); ctx.strokeStyle = '#3ca23c'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x - s * 0.3, y - s * 1.35); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.4, y - s * 1.3); ctx.stroke(); }
          else { if (drawSplat(ctx, splat, 1 / 60) && a.t > 4) a.dead = true; ctx.fillStyle = '#f2df8a'; seedsFly.forEach((s) => { if (s.t > 0.9) return; ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.a + s.t * 6); ctx.beginPath(); ctx.ellipse(0, 0, 4, 2.2, 0, 0, TAU); ctx.fill(); ctx.restore(); }); }
        } };
      FX.add(a);
    } });

  FX.def({ id: 'shatter', name: 'Glass shatter / screen crack', star: true, purpose: 'wrong answer - dramatic', cost: 'medium', phone: true,
    fire(o) {
      const r = FX.chosenRect(); const cx = o && o.point ? o.point.x : r.left + r.width * 0.5, cy = o && o.point ? o.point.y : r.top + r.height / 2;
      const nRay = FX.reduced() ? 8 : RI(11, 15); const rings = 5; const rays = [];
      for (let i = 0; i < nRay; i++) { const base = (i / nRay) * TAU + R(-0.15, 0.15); const pts = [[cx, cy]]; let d = 0, ang = base; for (let k = 0; k < rings; k++) { d += R(28, 70) * (k === 0 ? 0.6 : 1); ang = base + R(-0.35, 0.35); pts.push([cx + Math.cos(ang) * d, cy + Math.sin(ang) * d]); } rays.push(pts); }
      const shards = []; for (let i = 0; i < nRay; i++) { const A = rays[i], B = rays[(i + 1) % nRay]; for (let k = 0; k < rings; k++) { const poly = [A[k], A[k + 1], B[k + 1], B[k]]; const mx = (A[k][0] + B[k + 1][0]) / 2, my = (A[k][1] + B[k + 1][1]) / 2; shards.push({ poly: poly.map((p) => [p[0] - mx, p[1] - my]), x: mx, y: my, vx: R(-40, 40), vy: R(-30, 30), rot: 0, rv: R(-3, 3), delay: R(0.55, 0.9) + k * 0.05, alpha: R(0.08, 0.22) }); } }
      const card = FX.cardEl(); card.classList.add('fx-dim'); const un = FX.onStop(() => card.classList.remove('fx-dim'));
      const a = { update(dt, t) { if (t > 0.5) shards.forEach((s) => { if (t < s.delay) return; s.vy += 1400 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.rv * dt; }); if (t > 2.4) { a.dead = true; } },
        draw(ctx, t) {
          const prog = clamp(t / 0.28, 0, 1); ctx.lineJoin = 'round';
          rays.forEach((pts, i) => { const kmax = prog * (rings + 1.2) - (i % 3) * 0.4; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k <= rings; k++) { if (k > kmax) { const p0 = pts[k - 1], p1 = pts[k]; const f = clamp(kmax - (k - 1), 0, 1); if (f > 0) ctx.lineTo(lerp(p0[0], p1[0], f), lerp(p0[1], p1[1], f)); break; } ctx.lineTo(pts[k][0], pts[k][1]); } ctx.strokeStyle = 'rgba(0,240,255,0.35)'; ctx.lineWidth = 4; ctx.stroke(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2; ctx.stroke(); });
          if (prog >= 1) for (let k = 1; k <= rings; k++) { ctx.beginPath(); rays.forEach((pts, i) => { const p = pts[Math.min(k, rings)]; if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }); ctx.closePath(); ctx.strokeStyle = 'rgba(255,255,255,' + (0.7 - k * 0.1) + ')'; ctx.lineWidth = 1; ctx.stroke(); }
          if (t > 0.5) shards.forEach((s) => { if (t < s.delay) return; const k = clamp((t - s.delay) / 1.4, 0, 1); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot); ctx.beginPath(); s.poly.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fillStyle = 'rgba(160,240,255,' + (s.alpha * (1 - k)) + ')'; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,' + (0.6 * (1 - k)) + ')'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore(); });
          if (t < 0.2) glowCircle(ctx, cx, cy, 90, '#ffffff', 0.5 * (1 - t / 0.2));
        }, onEnd() { card.classList.remove('fx-dim'); un(); } };
      FX.add(a); shakeStage(7, 0.3);
    } });

  FX.def({ id: 'glitch', name: 'Glitch / RGB-split jolt', star: true, purpose: 'wrong answer - digital sting', cost: 'medium', phone: true,
    fire() {
      const card = FX.cardEl(); card.classList.add('fx-glitch');
      // clones go on <body>, not the overlay layer: mix-blend-mode only blends inside its own stacking context
      const r = FX.reduced() ? null : FX.cloneCard('gl-r', document.body), c = FX.reduced() ? null : FX.cloneCard('gl-c', document.body);
      const cr = FX.cardRect(); const slices = []; for (let i = 0; i < 5; i++) slices.push(FX.domEl('div', 'fx-ov-slice'));
      let n = 0; const iv = setInterval(() => {
        n++; const dx = R(-7, 7), dy = R(-2, 2);
        if (r) { r.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; r.style.clipPath = 'inset(' + R(0, 60) + '% 0 ' + R(0, 60) + '% 0)'; }
        if (c) { c.style.transform = 'translate(' + (-dx) + 'px,' + (-dy) + 'px)'; c.style.clipPath = 'inset(' + R(0, 60) + '% 0 ' + R(0, 60) + '% 0)'; }
        slices.forEach((s) => { const y = R(cr.top, cr.bottom), h = R(4, 22); s.style.left = (cr.left + R(-20, 10)) + 'px'; s.style.width = (cr.width + R(0, 30)) + 'px'; s.style.top = y + 'px'; s.style.height = h + 'px'; s.style.opacity = Math.random() < 0.6 ? '1' : '0'; });
        if (n > 9) { clearInterval(iv); cleanup(); }
      }, 55);
      function cleanup() { clearInterval(iv); if (r) r.remove(); if (c) c.remove(); slices.forEach((s) => s.remove()); card.classList.remove('fx-glitch'); }
      FX.onStop(cleanup);
    } });

  FX.def({ id: 'shake', name: 'Screen shake', purpose: 'wrong answer - the basic', cost: 'light', phone: true,
    fire() { shakeStage(12, 0.45); if (FX.reduced()) flash('#ff3b5c', 0.25, 0.3); } });

  FX.def({ id: 'vignette', name: 'Red flash vignette', purpose: 'wrong answer - quiet sting', cost: 'light', phone: true,
    fire() { const el = FX.domEl('div', 'fx-ov-vignette'); tween(1.1, (e, p) => { const k = p < 0.08 ? p / 0.08 : p < 0.35 ? 1 - (p - 0.08) / 0.27 : p < 0.45 ? (p - 0.35) / 0.1 : 1 - (p - 0.45) / 0.55; el.style.opacity = String(clamp(k, 0, 1)); }, ease.linear, () => el.remove()); FX.onStop(() => el.remove()); } });

  FX.def({ id: 'smoke', name: 'Smoke puff', purpose: 'wrong answer - gone up in smoke', cost: 'medium', phone: true,
    fire() {
      const r = FX.chosenRect(); const P = []; for (let i = 0; i < FX.N(26, 10); i++) P.push({ x: R(r.left + 20, r.right - 20), y: r.top + r.height / 2, vx: R(-30, 30), vy: R(-70, -20), r: R(10, 22), t: 0, life: R(1.6, 2.6), ph: R(0, TAU), g: R(0.35, 0.6) });
      const a = { update(dt, t) { P.forEach((p) => { p.t += dt; p.vy -= 25 * dt; p.x += (p.vx + Math.sin(t * 2 + p.ph) * 25) * dt; p.y += p.vy * dt; p.r += 26 * dt; }); if (t > 2.8) a.dead = true; }, draw(ctx) { P.forEach((p) => { const k = 1 - p.t / p.life; if (k <= 0) return; const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r); const c = Math.round(120 + 80 * p.g); g.addColorStop(0, 'rgba(' + c + ',' + c + ',' + (c + 15) + ',' + (0.35 * k) + ')'); g.addColorStop(1, 'rgba(' + c + ',' + c + ',' + (c + 15) + ',0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); }); } };
      FX.add(a);
    } });

  FX.def({ id: 'buzzer-x', name: 'Buzzer X strike', purpose: 'wrong answer - game-show', cost: 'light', phone: true,
    fire() {
      const r = FX.chosenRect();
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 100 100'); s.setAttribute('preserveAspectRatio', 'none'); s.style.cssText = 'position:fixed;left:' + (r.left - 6) + 'px;top:' + (r.top - 6) + 'px;width:' + (r.width + 12) + 'px;height:' + (r.height + 12) + 'px;overflow:visible';
      s.innerHTML = '<line x1="8" y1="8" x2="92" y2="92" stroke="#ff3b5c" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke" filter="url(#fx-glow)" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/><line x1="92" y1="8" x2="8" y2="92" stroke="#ff3b5c" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke" filter="url(#fx-glow)" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/>';
      FX.dom.appendChild(s); const [l1, l2] = s.querySelectorAll('line');
      tween(0.18, (e) => l1.setAttribute('stroke-dashoffset', String(1 - e)), ease.outQuad, () => tween(0.18, (e) => l2.setAttribute('stroke-dashoffset', String(1 - e)), ease.outQuad, () => { shakeStage(4, 0.25); FX.later(() => tween(0.25, (e) => { s.style.opacity = String(1 - e); }, ease.linear, () => s.remove()), 700); }));
      FX.onStop(() => s.remove());
    } });

  FX.def({ id: 'static', name: 'TV static burst', purpose: 'wrong answer - signal lost', cost: 'medium', phone: true,
    fire() {
      const cw = 160, ch = 90; const off = document.createElement('canvas'); off.width = cw; off.height = ch; const octx = off.getContext('2d'); const img = octx.createImageData(cw, ch); const d = img.data;
      const cr = FX.cardRect();
      const a = { update(dt, t) { if (t > 0.5) a.dead = true; }, draw(ctx, t) { for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; } octx.putImageData(img, 0, 0); const k = t < 0.3 ? 0.85 : 0.85 * (1 - (t - 0.3) / 0.2); ctx.globalAlpha = k; ctx.imageSmoothingEnabled = false; ctx.drawImage(off, cr.left, cr.top, cr.width, cr.height); const ty = cr.top + ((t * 900) % (cr.height + 60)) - 30; ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(cr.left, ty, cr.width, 22); ctx.globalAlpha = 1; } };
      FX.add(a);
    } });

  /* ═══════════════ GROUP 3 — STREAK / MOMENTUM ═══════════════ */
  FX.group('streak', 'Streak & momentum', 'Things that grow with a run and stay while it lasts.');

  FX.def({ id: 'flame-border', name: 'Neon flame border (grows with streak)', star: true, purpose: 'streak - lives while the run is alive', cost: 'medium', phone: true, kind: 'loop',
    params: [{ key: 'streak', label: 'streak', min: 1, max: 10, step: 1, value: 4 }],
    start(p) {
      const P = []; let acc = 0;
      const a = { layer: 'fg', update(dt) {
        const cr = FX.cardRect(); const s = clamp(((p.streak || 1) - 1) / 9, 0, 1); const rate = ((FX.reduced() ? 40 : 90) + s * 220) * FX.perfScale(); acc += rate * dt;
        const climb = cr.height * (0.15 + 0.85 * s);
        while (acc > 1) { acc--; const side = Math.random(); let x, y; if (side < 0.55) { x = R(cr.left, cr.right); y = cr.bottom + 4; } else if (side < 0.78) { x = cr.left - 2; y = R(cr.bottom - climb, cr.bottom); } else { x = cr.right + 2; y = R(cr.bottom - climb, cr.bottom); } P.push({ x, y, vx: R(-20, 20), vy: -R(60, 140) - s * 120, r: R(6, 12) + s * 8, t: 0, life: R(0.5, 0.9) + s * 0.4, ph: R(0, TAU) }); }
        for (let i = P.length - 1; i >= 0; i--) { const q = P[i]; q.t += dt; q.x += (q.vx + Math.sin(q.t * 9 + q.ph) * 30) * dt; q.y += q.vy * dt; q.r *= Math.pow(0.35, dt); if (q.t > q.life) P.splice(i, 1); } },
        draw(ctx) { ctx.globalCompositeOperation = 'lighter'; P.forEach((q) => { const k = 1 - q.t / q.life; const c = k > 0.55 ? '#ffb800' : k > 0.3 ? '#ff2d95' : '#a855f7'; glowCircle(ctx, q.x, q.y, q.r * (0.5 + 0.5 * k) + 1, c, 0.6 * k); if (k > 0.85) glowCircle(ctx, q.x, q.y, q.r * 0.35, '#ffffff', 0.5 * (k - 0.85) / 0.15); }); } };
      FX.add(a); return () => { a.dead = true; };
    } });

  FX.def({ id: 'lightning', name: 'Lightning bolt / electric arc', purpose: 'streak - x3 x5 hits, or the Exam Room unlock', cost: 'light', phone: true,
    fire() {
      const cr = FX.cardRect(); const bolts = [];
      function seg(x1, y1, x2, y2, disp, depth, out) { if (depth === 0) { out.push([x1, y1, x2, y2]); return; } const mx = (x1 + x2) / 2 + R(-disp, disp), my = (y1 + y2) / 2 + R(-disp, disp); seg(x1, y1, mx, my, disp / 2, depth - 1, out); seg(mx, my, x2, y2, disp / 2, depth - 1, out); if (depth > 3 && Math.random() < 0.35) { const dx = mx - x1, dy = my - y1; const bx = mx + dx * 0.55 + R(-30, 30), by = my + dy * 0.55 + R(-30, 30); const br = []; seg(mx, my, bx, by, disp / 2.5, depth - 2, br); out.push({ branch: br }); } }
      function make() { const out = []; const fromTop = Math.random() < 0.5; const x1 = fromTop ? R(cr.left, cr.left + cr.width * 0.3) : cr.left - 20, y1 = fromTop ? cr.top - 30 : R(cr.top, cr.top + cr.height * 0.4); const x2 = fromTop ? R(cr.right - cr.width * 0.3, cr.right) : cr.right + 20, y2 = fromTop ? cr.bottom + 20 : R(cr.bottom - cr.height * 0.4, cr.bottom); seg(x1, y1, x2, y2, 90, 7, out); return out; }
      bolts.push(make());
      const alphaSeq = [1, 0.25, 1, 0.55, 0.1, 0.9, 0.5, 0.15, 0];
      const a = { update(dt, t) { if (t > 0.42) a.dead = true; if (t > 0.09 && bolts.length === 1) bolts.push(make()); if (t > 0.2 && bolts.length === 2) bolts.push(make()); },
        draw(ctx, t) { const idx = Math.min(alphaSeq.length - 1, Math.floor(t / 0.42 * alphaSeq.length)); const al = alphaSeq[idx]; const b = bolts[bolts.length - 1]; ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          function drawSet(set, wMul) { [[10, rgba('#00f0ff', 0.25 * al)], [4, rgba('#00f0ff', 0.7 * al)], [1.6, 'rgba(255,255,255,' + al + ')']].forEach(([w, col]) => { ctx.strokeStyle = col; ctx.lineWidth = w * wMul; ctx.beginPath(); set.forEach((s) => { if (s.branch) return; ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }); ctx.stroke(); }); set.forEach((s) => { if (s.branch) drawSet(s.branch, wMul * 0.5); }); }
          drawSet(b, 1); if (t < 0.12) { ctx.fillStyle = 'rgba(200,245,255,' + (0.35 * (1 - t / 0.12)) + ')'; ctx.fillRect(0, 0, FX.fg.w, FX.fg.h); } } };
      FX.add(a);
    } });

  FX.def({ id: 'laser', name: 'Laser sweep', purpose: 'streak - scanning the card on a new question', cost: 'light', phone: true,
    fire() {
      const cr = FX.cardRect(); const col = pick(['#ff2d95', '#00f0ff', '#b6ff00']);
      const a = { update(dt, t) { if (t > 1.1) a.dead = true; }, draw(ctx, t) { const p = ease.inOutQuad(clamp(t / 0.55, 0, 1)); const x = lerp(cr.left - 20, cr.right + 20, p); ctx.globalCompositeOperation = 'lighter'; ctx.save(); ctx.beginPath(); ctx.rect(cr.left - 30, cr.top - 30, cr.width + 60, cr.height + 60); ctx.clip();
        const fade = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.55;
        const trail = ctx.createLinearGradient(x - 160, 0, x, 0); trail.addColorStop(0, rgba(col, 0)); trail.addColorStop(1, rgba(col, 0.28 * fade)); ctx.fillStyle = trail; ctx.fillRect(x - 160, cr.top - 30, 160, cr.height + 60);
        if (t < 0.55) { const g = ctx.createLinearGradient(x - 40, 0, x + 40, 0); g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, 0.75)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.fillRect(x - 40, cr.top - 30, 80, cr.height + 60); ctx.fillStyle = '#fff'; ctx.fillRect(x - 1, cr.top - 30, 2, cr.height + 60); for (let i = 0; i < 12; i++) { ctx.fillStyle = rgba(col, R(0.2, 0.7)); ctx.fillRect(x + R(-30, 5), R(cr.top, cr.bottom), R(4, 30), 1); } }
        ctx.restore(); } };
      FX.add(a);
    } });

  FX.def({ id: 'haze', name: 'Heat shimmer over the card', purpose: 'streak - on fire while the streak is hot', cost: 'heavy', phone: false, kind: 'loop',
    start() { if (FX.reduced()) return () => {}; const card = FX.cardEl(); const turb = document.getElementById('fx-haze-turb'), disp = document.getElementById('fx-haze-disp'); card.classList.add('fx-haze'); let ph = 0; const a = { layer: 'none', update(dt) { ph += dt; turb.setAttribute('baseFrequency', (0.012 + Math.sin(ph * 0.7) * 0.004).toFixed(4) + ' ' + (0.03 + Math.cos(ph * 0.5) * 0.008).toFixed(4)); turb.setAttribute('seed', String(Math.floor(ph * 6) % 100)); disp.setAttribute('scale', String(6 + Math.sin(ph * 2) * 2)); }, draw() {}, kill() { card.classList.remove('fx-haze'); disp.setAttribute('scale', '0'); } }; FX.add(a); return () => { a.dead = true; a.kill(); }; } });

  FX.def({ id: 'marquee', name: 'Arcade marquee chase lights', purpose: 'streak / idle - cabinet feel around the card', cost: 'light', phone: true, kind: 'loop',
    start() { let step = 0, acc = 0; const a = { update(dt) { acc += dt; if (acc > 0.09) { acc = 0; step++; } }, draw(ctx) { const cr = FX.cardRect(); const pad = 10, sp = 16; const pts = []; for (let x = cr.left - pad; x <= cr.right + pad; x += sp) pts.push([x, cr.top - pad]); for (let y = cr.top - pad + sp; y <= cr.bottom + pad; y += sp) pts.push([cr.right + pad, y]); for (let x = cr.right + pad - sp; x >= cr.left - pad; x -= sp) pts.push([x, cr.bottom + pad]); for (let y = cr.bottom + pad - sp; y > cr.top - pad; y -= sp) pts.push([cr.left - pad, y]); pts.forEach((p, i) => { const lit = (i + step) % 3 === 0; ctx.fillStyle = lit ? '#fff' : 'rgba(255,184,0,0.18)'; if (lit) { ctx.shadowColor = '#ffb800'; ctx.shadowBlur = 12; } else ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(p[0], p[1], lit ? 3 : 2, 0, TAU); ctx.fill(); }); ctx.shadowBlur = 0; } }; FX.add(a); return () => { a.dead = true; }; } });

  /* ═══════════════ GROUP 4 — NEON, TEXT & THE POWER-ON ═══════════════ */
  FX.group('neon', 'Neon & text', 'The sign-shop stuff. Flicker curves, tube tracing, kinetic type — and the power-on.');

  FX.def({ id: 'power-on', name: 'Blackout + neon power-on', star: true, purpose: 'exam-room unlock / teen-mode switch / session start', cost: 'medium', phone: true,
    fire() {
      // the black must cover the WHOLE page (the tube card and popup sit above the normal overlay)
      const domLayer = FX.dom; const prevZ = domLayer.style.zIndex; domLayer.style.zIndex = '9000';
      const black = FX.domEl('div', 'fx-ov-black'); black.style.transition = 'none'; const cr = FX.cardRect(); const opts = FX.opts(); const sign = FX.targets().sign();
      const clean = [() => black.remove(), () => opts.forEach((o) => o.classList.remove('fx-lit')), () => { if (sign) sign.classList.remove('fx-flicker-off'); }, () => { domLayer.style.zIndex = prevZ; }];
      FX.onStop(() => clean.forEach((f) => f()));
      // 1) hard cut to black; a faint hum-glow breathes on the overlay
      const glow = { t: 0 }; const a = { update(dt, t) { glow.t = t; if (t > 4.6) { a.dead = true; domLayer.style.zIndex = prevZ; } }, draw(ctx, t) { if (t < 1.4) { const k = 0.06 + 0.05 * Math.sin(t * 5); const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2; glowCircle(ctx, cx, cy, Math.max(cr.width, cr.height) * 0.9, '#ff2d95', k); } if (t > 2.55 && t < 3.6) { const k = (t - 2.55) / 1.05; glowCircle(ctx, cr.left + cr.width / 2, cr.top + cr.height / 2, Math.max(FX.fg.w, FX.fg.h) * 0.6 * ease.outCubic(k), '#ff2d95', 0.22 * (1 - k)); } } };
      FX.add(a);
      // 2) the tube outline traces on, ON TOP of the black
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const pad = 3; s.style.cssText = 'position:fixed;left:' + (cr.left - pad) + 'px;top:' + (cr.top - pad) + 'px;width:' + (cr.width + pad * 2) + 'px;height:' + (cr.height + pad * 2) + 'px;overflow:visible'; s.setAttribute('viewBox', '0 0 ' + (cr.width + pad * 2) + ' ' + (cr.height + pad * 2));
      const per = 2 * (cr.width + cr.height); s.innerHTML = '<rect x="1.5" y="1.5" width="' + (cr.width + pad * 2 - 3) + '" height="' + (cr.height + pad * 2 - 3) + '" rx="13" fill="none" stroke="#ff2d95" stroke-width="2.5" filter="url(#fx-glow)" stroke-dasharray="' + per + '" stroke-dashoffset="' + per + '"/><rect x="1.5" y="1.5" width="' + (cr.width + pad * 2 - 3) + '" height="' + (cr.height + pad * 2 - 3) + '" rx="13" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="26 ' + per + '" stroke-dashoffset="' + per + '"/>';
      FX.dom.appendChild(s); clean.push(() => s.remove()); const [tubeR, headR] = s.querySelectorAll('rect');
      const flickerSeq = [1, 0.15, 1, 0.3, 0.9, 0.05, 1, 0.5, 1];
      const fast = FX.reduced() ? 0.6 : 1;
      timeline([
        [500 * fast, () => tween(1.0 * fast, (e) => { tubeR.setAttribute('stroke-dashoffset', String(per * (1 - e))); headR.setAttribute('stroke-dashoffset', String(per * (1 - e) - 26)); }, ease.inOutQuad, () => headR.remove())],
        [1450 * fast, () => { let i = 0; const iv = setInterval(() => { tubeR.style.opacity = String(flickerSeq[i]); i++; if (i >= flickerSeq.length) clearInterval(iv); }, 70); clean.push(() => clearInterval(iv)); }],
        // 3) reveal the page underneath with a flicker of the black overlay
        [2100 * fast, () => { const seq = [0.85, 1, 0.5, 0.9, 0.2, 0.6, 0.05, 0.3, 0]; let i = 0; const iv = setInterval(() => { black.style.opacity = String(seq[i]); i++; if (i >= seq.length) { clearInterval(iv); black.remove(); } }, 60); clean.push(() => clearInterval(iv)); }],
        // 4) options light one at a time with a buzz
        [2450 * fast, () => opts.forEach((o, i) => FX.later(() => { o.classList.add('fx-lit'); o.classList.add('fx-flicker-off'); FX.later(() => o.classList.remove('fx-flicker-off'), 60); FX.later(() => { o.classList.add('fx-flicker-off'); FX.later(() => o.classList.remove('fx-flicker-off'), 40); }, 130); }, i * 140))],
        // 5) fluorescent clunk: white flash, ambient bloom, sign flickers on
        [2550 * fast, () => { flash('#fff', 0.55, 0.16); if (sign) { sign.classList.add('fx-flicker-off'); const seq = [0, 1, 0, 0, 1, 0, 1, 1]; let i = 0; const iv = setInterval(() => { sign.classList.toggle('fx-flicker-off', !seq[i]); i++; if (i >= seq.length) { clearInterval(iv); sign.classList.remove('fx-flicker-off'); } }, 55); clean.push(() => clearInterval(iv)); } }],
        [3300 * fast, () => tween(0.6, (e) => { s.style.opacity = String(1 - e); }, ease.linear, () => s.remove())],
        [3400 * fast, () => { opts.forEach((o) => o.classList.remove('fx-lit')); domLayer.style.zIndex = prevZ; }],
      ]);
    } });

  FX.def({ id: 'neon-flicker', name: 'Neon sign flicker-on', purpose: 'text - any neon label / the CORRECT word', cost: 'light', phone: true,
    fire(o) {
      const cr = FX.cardRect(); const el = FX.domEl('div', 'fx-neon-word'); el.textContent = (o && o.text) || pick(['Correct', 'On fire', 'Exam room open']); el.style.left = (cr.left + cr.width / 2) + 'px'; el.style.top = (cr.top + cr.height / 2) + 'px'; el.style.opacity = '0'; fitFontToRect(el, cr);
      const sign = FX.targets().sign(); const seq = [0.9, 0.1, 0.7, 0.05, 1, 0.3, 1, 0.9, 0.2, 1, 1, 1, 0.6, 1, 1, 1];
      let i = 0; const iv = setInterval(() => { const v = seq[i]; el.style.opacity = String(v); el.style.textShadow = v > 0.5 ? '' : 'none'; if (sign) sign.classList.toggle('fx-flicker-off', v < 0.5); i++; if (i >= seq.length) { clearInterval(iv); if (sign) sign.classList.remove('fx-flicker-off'); FX.later(() => tween(0.4, (e) => { el.style.opacity = String(1 - e); }, ease.linear, () => el.remove()), 1300); } }, 65);
      FX.onStop(() => { clearInterval(iv); el.remove(); if (sign) sign.classList.remove('fx-flicker-off'); });
    } });

  FX.def({ id: 'neon-trace', name: 'Neon tube outline traces the card', purpose: 'transition - new question / focus', cost: 'light', phone: true,
    fire() {
      const cr = FX.cardRect(); const pad = 4; const col = pick(['#00f0ff', '#ff2d95', '#b6ff00']);
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.style.cssText = 'position:fixed;left:' + (cr.left - pad) + 'px;top:' + (cr.top - pad) + 'px;width:' + (cr.width + pad * 2) + 'px;height:' + (cr.height + pad * 2) + 'px;overflow:visible'; s.setAttribute('viewBox', '0 0 ' + (cr.width + pad * 2) + ' ' + (cr.height + pad * 2));
      const per = 2 * (cr.width + cr.height); s.innerHTML = '<rect x="1.5" y="1.5" width="' + (cr.width + pad * 2 - 3) + '" height="' + (cr.height + pad * 2 - 3) + '" rx="14" fill="none" stroke="' + col + '" stroke-width="2.5" filter="url(#fx-glow)" stroke-dasharray="' + per + '" stroke-dashoffset="' + per + '"/><rect x="1.5" y="1.5" width="' + (cr.width + pad * 2 - 3) + '" height="' + (cr.height + pad * 2 - 3) + '" rx="14" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="30 ' + per + '" stroke-dashoffset="' + per + '"/>';
      FX.dom.appendChild(s); const [tubeR, headR] = s.querySelectorAll('rect');
      tween(0.9, (e) => { tubeR.setAttribute('stroke-dashoffset', String(per * (1 - e))); headR.setAttribute('stroke-dashoffset', String(per * (1 - e) - 30)); }, ease.inOutQuad, () => { headR.remove(); tween(1.4, (e, p) => { tubeR.style.opacity = String(0.7 + 0.3 * Math.sin(p * 9)); }, ease.linear, () => tween(0.4, (e) => { s.style.opacity = String(1 - e); }, ease.linear, () => s.remove())); });
      FX.onStop(() => s.remove());
    } });

  FX.def({ id: 'typewriter', name: 'Typewriter + cursor on the WHY line', purpose: 'text - the teaching line arrives like it is being written', cost: 'light', phone: true,
    fire() { const el = FX.targets().why(); if (!el) return; const full = el.textContent; el.textContent = ''; const caret = document.createElement('span'); caret.className = 'fx-caret'; el.appendChild(caret); let i = 0; let h; const un = FX.onStop(() => { clearTimeout(h); el.textContent = full; }); (function step() { if (i >= full.length) { FX.later(() => { caret.remove(); un(); }, 900); return; } const ch = full[i++]; caret.before(document.createTextNode(ch)); h = setTimeout(step, /[.,;—]/.test(ch) ? R(160, 260) : R(16, 44)); })(); } });

  FX.def({ id: 'glitch-text', name: 'Glitch text resolve', purpose: 'text - the question de-scrambles onto the card', cost: 'light', phone: true,
    fire() { const el = FX.targets().qtext(); if (!el) return; const full = el.textContent; const glyphs = '#%&@?!<>/\\|=+*░▒▓█ΔΣΩ0123456789'; el.classList.add('fx-gtext'); const un = FX.onStop(() => { el.textContent = full; el.classList.remove('fx-gtext'); }); tween(0.95, (e) => { const n = Math.floor(e * full.length); let out = ''; for (let i = 0; i < full.length; i++) { const c = full[i]; out += i < n || c === ' ' ? c : (Math.random() < 0.85 ? glyphs[Math.floor(Math.random() * glyphs.length)] : c); } el.textContent = out; }, ease.linear, () => { el.textContent = full; el.classList.remove('fx-gtext'); un(); }); } });

  FX.def({ id: 'chrome-text', name: 'Chrome / holo text', purpose: 'text - FLAWLESS / grade reveal', cost: 'light', phone: true,
    fire(o) { const cr = FX.cardRect(); const el = FX.domEl('div', 'fx-big-word fx-chrome'); el.textContent = (o && o.text) || pick(['Flawless', 'Grade 9', 'Full marks']); el.style.left = (cr.left + cr.width / 2) + 'px'; el.style.top = (cr.top + cr.height / 2) + 'px'; fitFontToRect(el, cr); const sub = FX.domEl('div', 'fx-holo'); sub.textContent = (o && o.sub) || 'topic mastered'; sub.style.left = el.style.left; sub.style.top = el.style.top; tween(0.5, (e) => { el.style.transform = 'translate(-50%,-50%) translateY(' + (40 * (1 - e)) + 'px) scale(' + (0.7 + 0.3 * e) + ')'; el.style.opacity = String(e); sub.style.opacity = String(e); }, ease.outBack); FX.later(() => tween(0.4, (e) => { el.style.opacity = String(1 - e); sub.style.opacity = String(1 - e); el.style.transform = 'translate(-50%,-50%) translateY(' + (-30 * e) + 'px)'; }, ease.inCubic, () => { el.remove(); sub.remove(); }), 2100); FX.onStop(() => { el.remove(); sub.remove(); }); } });

  FX.def({ id: 'scoreboard', name: 'Score counter roll-up', purpose: 'text - end-of-run score reveal', cost: 'light', phone: true,
    fire(o) { const cr = FX.cardRect(); const el = FX.domEl('div', 'fx-big-word'); el.style.left = (cr.left + cr.width / 2) + 'px'; el.style.top = (cr.top + cr.height / 2) + 'px'; el.style.fontVariantNumeric = 'tabular-nums'; el.style.color = '#fff'; el.style.textShadow = '0 0 12px #00f0ff, 0 0 30px rgba(0,240,255,0.6)'; const target = (o && o.value) || RI(1200, 4800); tween(1.4, (e, p) => { el.textContent = Math.round(target * e).toLocaleString('en-GB'); el.style.transform = 'translate(-50%,-50%) scale(' + (p >= 1 ? 1 : 0.9 + 0.1 * e) + ')'; }, ease.outExpo, () => tween(0.4, (e) => { el.style.transform = 'translate(-50%,-50%) scale(' + (1 + 0.25 * Math.sin(e * Math.PI)) + ')'; }, ease.linear, () => FX.later(() => tween(0.3, (e) => { el.style.opacity = String(1 - e); }, ease.linear, () => el.remove()), 900))); FX.onStop(() => el.remove()); } });

  /* ═══════════════ GROUP 5 — TRANSITIONS ═══════════════ */
  FX.group('transition', 'Transitions', 'Between questions, into the Exam Room, into teen mode. Short.');

  FX.def({ id: 'iris', name: 'Iris close / open', purpose: 'transition - into the Exam Room', cost: 'light', phone: true,
    fire(o) { const cr = FX.cardRect(); const x = o && o.point ? o.point.x : cr.left + cr.width / 2, y = o && o.point ? o.point.y : cr.top + cr.height / 2; const el = FX.domEl('div', 'fx-ov-iris'); el.style.left = x + 'px'; el.style.top = y + 'px'; const big = Math.max(FX.fg.w, FX.fg.h) * 2.2; tween(0.55, (e) => { const d = big * (1 - e); el.style.width = d + 'px'; el.style.height = d + 'px'; }, ease.inOutQuad, () => FX.later(() => tween(0.55, (e) => { const d = big * e; el.style.width = d + 'px'; el.style.height = d + 'px'; }, ease.inOutQuad, () => el.remove()), 250)); FX.onStop(() => el.remove()); } });

  FX.def({ id: 'curtain', name: 'Neon curtain', purpose: 'transition - new topic', cost: 'light', phone: true,
    fire() { const l = FX.domEl('div', 'fx-ov-curtain l'), r = FX.domEl('div', 'fx-ov-curtain r'); tween(0.5, (e) => { l.style.transform = 'translateX(' + (-101 * (1 - e)) + '%)'; r.style.transform = 'translateX(' + (101 * (1 - e)) + '%)'; }, ease.inOutQuad, () => FX.later(() => tween(0.5, (e) => { l.style.transform = 'translateX(' + (-101 * e) + '%)'; r.style.transform = 'translateX(' + (101 * e) + '%)'; }, ease.inOutQuad, () => { l.remove(); r.remove(); }), 300)); FX.onStop(() => { l.remove(); r.remove(); }); } });

  FX.def({ id: 'pixel', name: 'Pixel dissolve', purpose: 'transition - retro cut', cost: 'light', phone: true,
    fire() { const W = FX.fg.w, H = FX.fg.h; const cs = W < 600 ? 22 : 30; const cols = Math.ceil(W / cs), rows = Math.ceil(H / cs); const order = []; for (let i = 0; i < cols * rows; i++) order.push(i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } const Nn = order.length; const a = { update(dt, t) { if (t > 1.7) a.dead = true; }, draw(ctx, t) { let k; if (t < 0.6) k = ease.inQuad(t / 0.6); else if (t < 1.0) k = 1; else k = 1 - ease.outQuad((t - 1.0) / 0.7); const n = Math.floor(k * Nn); for (let i = 0; i < n; i++) { const idx = order[i]; const x = (idx % cols) * cs, y = Math.floor(idx / cols) * cs; const fresh = t < 0.6 && i > n - cols * 1.5; ctx.fillStyle = fresh ? pick(['#ff2d95', '#00f0ff', '#000', '#000']) : '#000'; ctx.fillRect(x, y, cs + 0.5, cs + 0.5); } } }; FX.add(a); } });

  FX.def({ id: 'wipe', name: 'Neon wipe', purpose: 'transition - next question', cost: 'light', phone: true,
    fire() { const fill = FX.domEl('div', 'fx-wipe-fill'), bar = FX.domEl('div', 'fx-wipe-bar'); const W = FX.fg.w; tween(0.45, (e) => { fill.style.width = (W * e) + 'px'; bar.style.left = (W * e - 3) + 'px'; }, ease.inOutQuad, () => FX.later(() => tween(0.45, (e) => { fill.style.left = (W * e) + 'px'; fill.style.width = (W * (1 - e)) + 'px'; bar.style.left = (W * e - 3) + 'px'; }, ease.inOutQuad, () => { fill.remove(); bar.remove(); }), 220)); FX.onStop(() => { fill.remove(); bar.remove(); }); } });

  /* ═══════════════ GROUP 6 — AMBIENT (loops) ═══════════════ */
  FX.group('ambient', 'Ambient (loop)', 'Idle life on the desk. Run one, maybe two.');

  FX.def({ id: 'flies', name: 'Flies buzzing over the desktop', star: true, purpose: 'idle ambience - the one she asked for', cost: 'medium', phone: true, kind: 'loop',
    params: [{ key: 'count', label: 'flies', min: 1, max: 14, step: 1, value: 7 }],
    start(p) {
      const W = () => FX.fg.w, H = () => FX.fg.h; const flies = [];
      function spawn() { return { x: R(0, W()), y: R(0, H()), vx: R(-80, 80), vy: R(-80, 80), hd: 0, tx: 0, ty: 0, tt: 0, state: 'fly', st: R(2, 6), alt: 1, wing: 0, flee: 0, dart: 0, land: null, walk: 0, size: R(1.05, 1.5), twitch: 0 }; }
      function newTarget(f) { const cr = FX.cardRect(); const nearCard = Math.random() < 0.6; f.tx = nearCard ? R(cr.left - 80, cr.right + 80) : R(20, W() - 20); f.ty = nearCard ? R(cr.top - 60, cr.bottom + 60) : R(20, H() - 20); f.tt = R(0.35, 1.4); }
      const a = { update(dt, t) {
        const want = Math.max(1, Math.round((FX.reduced() ? Math.min(3, p.count) : p.count) * (FX.perfScale() < 1 ? 0.6 : 1))); while (flies.length < want) { const f = spawn(); newTarget(f); flies.push(f); } while (flies.length > want) flies.pop();
        const px = FX.pointer.x, py = FX.pointer.y; const speedMul = FX.reduced() ? 0.5 : 1;
        flies.forEach((f) => {
          f.wing += dt * 60;
          const dx = f.x - px, dy = f.y - py; const d2 = dx * dx + dy * dy;
          if (d2 < 120 * 120) { const d = Math.sqrt(d2) || 1; const k = (1 - d / 120); f.flee = 0.7; if (f.state !== 'fly') { f.state = 'fly'; f.st = R(2, 6); f.alt = 0.2; } f.vx += (dx / d) * 2600 * k * dt; f.vy += (dy / d) * 2600 * k * dt; }
          f.flee = Math.max(0, f.flee - dt);
          if (f.state === 'fly') {
            f.tt -= dt; f.st -= dt; if (f.tt <= 0) newTarget(f);
            if (f.st <= 0 && Math.random() < 0.02) { const cr = FX.cardRect(); f.land = Math.random() < 0.7 ? [R(cr.left + 20, cr.right - 20), R(cr.top + 10, cr.bottom - 10)] : [R(40, W() - 40), R(40, H() - 40)]; f.state = 'approach'; }
            const tx = f.tx - f.x, ty = f.ty - f.y; const dist = Math.hypot(tx, ty) || 1;
            const sp = (f.flee > 0 ? 420 : f.dart > 0 ? 380 : 170) * speedMul;
            const wantX = (tx / dist) * sp, wantY = (ty / dist) * sp;
            f.vx += (wantX - f.vx) * 4 * dt; f.vy += (wantY - f.vy) * 4 * dt;
            const perp = Math.sin(t * 23 + f.size * 40) * 260 + R(-1, 1) * 900;
            f.vx += (-ty / dist) * perp * dt; f.vy += (tx / dist) * perp * dt;
            if (Math.random() < dt * 1.2) { f.vx += R(-260, 260); f.vy += R(-260, 260); }
            if (f.dart <= 0 && Math.random() < dt * 0.25) f.dart = R(0.15, 0.35); f.dart -= dt;
            f.alt = Math.min(1, f.alt + dt * 1.5);
          } else if (f.state === 'approach') {
            const tx = f.land[0] - f.x, ty = f.land[1] - f.y; const dist = Math.hypot(tx, ty) || 1;
            const sp = clamp(dist * 3, 20, 220) * speedMul; f.vx += ((tx / dist) * sp - f.vx) * 6 * dt; f.vy += ((ty / dist) * sp - f.vy) * 6 * dt; f.alt = clamp(dist / 120, 0, 1);
            if (dist < 4) { f.state = 'rest'; f.vx = f.vy = 0; f.st = R(0.8, 3); f.alt = 0; }
          } else {
            f.st -= dt; f.twitch -= dt; if (f.twitch <= 0 && Math.random() < dt * 3) { f.twitch = 0.15; f.hd += R(-0.6, 0.6); } if (Math.random() < dt * 0.8) { f.walk = 0.25; } if (f.walk > 0) { f.walk -= dt; f.x += Math.cos(f.hd) * 14 * dt; f.y += Math.sin(f.hd) * 14 * dt; }
            if (f.st <= 0) { f.state = 'fly'; f.st = R(2, 6); f.vx = Math.cos(f.hd) * 120; f.vy = Math.sin(f.hd) * 120 - 40; f.alt = 0.1; newTarget(f); }
          }
          if (f.state !== 'rest') { const v = Math.hypot(f.vx, f.vy); const maxV = f.flee > 0 ? 620 : 420; if (v > maxV) { f.vx *= maxV / v; f.vy *= maxV / v; } f.x += f.vx * dt; f.y += f.vy * dt; if (v > 5) { const want = Math.atan2(f.vy, f.vx); let dh = want - f.hd; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); f.hd += dh * Math.min(1, 14 * dt); } }
          if (f.x < -20) f.x = W() + 20; if (f.x > W() + 20) f.x = -20; if (f.y < -20) f.y = H() + 20; if (f.y > H() + 20) f.y = -20;
        }); },
        draw(ctx) {
          flies.forEach((f) => {
            const s = f.size; const flying = f.state !== 'rest';
            const alt = f.alt; ctx.fillStyle = 'rgba(0,0,0,' + (0.55 - alt * 0.3) + ')'; ctx.beginPath(); ctx.ellipse(f.x + 6 * alt + 2, f.y + 14 * alt + 3, (5 + 4 * alt) * s, (2.6 + 2 * alt) * s, f.hd, 0, TAU); ctx.fill();
            ctx.save(); ctx.translate(f.x, f.y - alt * 6); ctx.rotate(f.hd); ctx.scale(s, s);
            if (flying) { const w = Math.sin(f.wing) > 0 ? 1 : -1; ctx.fillStyle = 'rgba(200,225,255,0.5)'; ctx.beginPath(); ctx.ellipse(-2, -4.5, 6.5, 2.4, -0.55 * w - 0.25, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(-2, 4.5, 6.5, 2.4, 0.55 * w + 0.25, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(200,225,255,0.22)'; ctx.beginPath(); ctx.ellipse(-2, -4.5, 6.5, 2.4, 0.55 * w - 0.25, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(-2, 4.5, 6.5, 2.4, -0.55 * w + 0.25, 0, TAU); ctx.fill(); }
            else { ctx.fillStyle = 'rgba(200,225,255,0.4)'; ctx.beginPath(); ctx.ellipse(-4, -1.2, 6.5, 2.2, 0.08, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(-4, 1.2, 6.5, 2.2, -0.08, 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(30,30,36,0.9)'; ctx.lineWidth = 0.7; for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(i * 1.5, 0); ctx.lineTo(i * 1.5 + 1, 4.5); ctx.moveTo(i * 1.5, 0); ctx.lineTo(i * 1.5 + 1, -4.5); ctx.stroke(); } }
            ctx.fillStyle = '#22272e'; ctx.beginPath(); ctx.ellipse(-2.5, 0, 4.2, 2.4, 0, 0, TAU); ctx.fill();
            ctx.strokeStyle = 'rgba(255,45,149,0.7)'; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.ellipse(-2.5, 0, 4.2, 2.4, 0, Math.PI * 1.05, Math.PI * 1.75); ctx.stroke(); ctx.strokeStyle = 'rgba(0,240,255,0.55)'; ctx.beginPath(); ctx.ellipse(-2.5, 0, 4.2, 2.4, 0, Math.PI * 0.2, Math.PI * 0.85); ctx.stroke();
            ctx.fillStyle = '#2c333b'; ctx.beginPath(); ctx.ellipse(1.5, 0, 2.6, 2.3, 0, 0, TAU); ctx.fill();
            ctx.fillStyle = 'rgba(120,230,190,0.5)'; ctx.beginPath(); ctx.ellipse(-3, -0.8, 2.2, 0.8, 0, 0, TAU); ctx.fill();
            ctx.fillStyle = '#b3262a'; ctx.beginPath(); ctx.arc(4.2, -0.9, 0.9, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.arc(4.2, 0.9, 0.9, 0, TAU); ctx.fill();
            ctx.restore();
          });
        } };
      FX.add(a); return () => { a.dead = true; };
    } });

  FX.def({ id: 'fireflies', name: 'Fireflies', purpose: 'idle ambience - calm', cost: 'light', phone: true, kind: 'loop',
    start() { const P = []; const n = FX.N(38, 14); for (let i = 0; i < n; i++) P.push({ x: R(0, FX.bg.w), y: R(0, FX.bg.h), a: R(0, TAU), sp: R(8, 26), ph: R(0, TAU), per: R(1.5, 4), c: Math.random() < 0.7 ? '#b6ff00' : '#00f0ff', r: R(2, 4) }); const a = { layer: 'bg', update(dt) { P.forEach((p) => { p.a += R(-1, 1) * dt * 2; p.x += Math.cos(p.a) * p.sp * dt; p.y += Math.sin(p.a) * p.sp * dt; if (p.x < 0) p.x = FX.bg.w; if (p.x > FX.bg.w) p.x = 0; if (p.y < 0) p.y = FX.bg.h; if (p.y > FX.bg.h) p.y = 0; }); }, draw(ctx, t) { ctx.globalCompositeOperation = 'lighter'; P.forEach((p) => { const k = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(t / p.per * TAU + p.ph), 3); glowCircle(ctx, p.x, p.y, p.r * 6, p.c, 0.55 * k); ctx.fillStyle = rgba(p.c, k); ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.5, 0, TAU); ctx.fill(); }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'dust', name: 'Floating dust motes', purpose: 'idle ambience - barely there', cost: 'light', phone: true, kind: 'loop',
    start() { const P = []; const n = FX.N(80, 30); for (let i = 0; i < n; i++) { const z = Math.random(); P.push({ x: R(0, FX.bg.w), y: R(0, FX.bg.h), z, r: 0.6 + z * 2.6, al: 0.12 + (1 - z) * 0.35, vx: R(-6, 6), vy: R(-4, 4), ph: R(0, TAU) }); } const a = { layer: 'bg', update(dt, t) { const breeze = Math.sin(t * 0.3) * 6; P.forEach((p) => { p.x += (p.vx + breeze) * dt * (0.5 + p.z); p.y += (p.vy + Math.sin(t + p.ph) * 3) * dt; if (p.x < -5) p.x = FX.bg.w + 5; if (p.x > FX.bg.w + 5) p.x = -5; if (p.y < -5) p.y = FX.bg.h + 5; if (p.y > FX.bg.h + 5) p.y = -5; }); }, draw(ctx) { P.forEach((p) => { if (p.z > 0.6) { glowCircle(ctx, p.x, p.y, p.r * 2.2, '#ffffff', p.al * 0.6); } else { ctx.fillStyle = 'rgba(255,255,255,' + p.al + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); } }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'matrix', name: 'Matrix rain', purpose: 'idle ambience - loud', cost: 'medium', phone: true, kind: 'loop',
    start() { const off = document.createElement('canvas'); const octx = off.getContext('2d'); let cols = 0, drops = [], fs = 16; function size() { off.width = FX.bg.w; off.height = FX.bg.h; fs = FX.bg.w < 600 ? 13 : 16; cols = Math.ceil(off.width / fs); drops = []; for (let i = 0; i < cols; i++) drops.push({ y: R(-40, 0), sp: R(8, 22) }); octx.fillStyle = '#000'; octx.fillRect(0, 0, off.width, off.height); } size(); const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789QREVISE'; let acc = 0; const a = { layer: 'bg', update(dt) { if (off.width !== FX.bg.w || off.height !== FX.bg.h) size(); acc += dt; const step = FX.reduced() ? 0.11 : 0.055; while (acc > step) { acc -= step; octx.fillStyle = 'rgba(0,0,0,0.12)'; octx.fillRect(0, 0, off.width, off.height); octx.font = fs + 'px monospace'; drops.forEach((d, i) => { const ch = chars[Math.floor(Math.random() * chars.length)]; const x = i * fs, y = d.y * fs; octx.fillStyle = 'rgba(0,240,255,0.85)'; octx.fillText(ch, x, y - fs); octx.fillStyle = '#e8ffff'; octx.fillText(ch, x, y); d.y += 1; if (y > off.height && Math.random() > 0.975) d.y = 0; }); } }, draw(ctx) { ctx.globalAlpha = 0.75; ctx.drawImage(off, 0, 0, FX.bg.w, FX.bg.h); ctx.globalAlpha = 1; } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'digital-snow', name: 'Digital rain / snow', purpose: 'idle ambience - softer than matrix', cost: 'light', phone: true, kind: 'loop',
    start() { const P = []; const n = FX.N(110, 40); for (let i = 0; i < n; i++) P.push({ x: R(0, FX.bg.w), y: R(-FX.bg.h, FX.bg.h), s: pick([3, 4, 6]), sp: R(25, 80), ph: R(0, TAU), g: Math.random() < 0.25 ? pick(['0', '1']) : null, c: Math.random() < 0.85 ? '#ffffff' : '#00f0ff' }); const a = { layer: 'bg', update(dt, t) { P.forEach((p) => { p.y += p.sp * dt * (p.s / 4); p.x += Math.sin(t * 1.3 + p.ph) * 12 * dt; if (p.y > FX.bg.h + 10) { p.y = -10; p.x = R(0, FX.bg.w); } }); }, draw(ctx) { ctx.font = '10px monospace'; P.forEach((p) => { ctx.fillStyle = rgba(p.c, 0.25 + p.s * 0.08); if (p.g) ctx.fillText(p.g, p.x, p.y); else ctx.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s); }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'aurora', name: 'Aurora wash', purpose: 'idle ambience - calm, colour', cost: 'medium', phone: true, kind: 'loop',
    start() { const bands = [{ c: '#00f0ff', y: 0.28, amp: 0.08, f: 0.9, sp: 0.12, h: 0.32 }, { c: '#b6ff00', y: 0.34, amp: 0.06, f: 1.6, sp: -0.09, h: 0.28 }, { c: '#a855f7', y: 0.22, amp: 0.1, f: 1.2, sp: 0.07, h: 0.4 }]; const a = { layer: 'bg', update() {}, draw(ctx, t) { const W = FX.bg.w, H = FX.bg.h; const sw = W < 600 ? 18 : 24; ctx.globalCompositeOperation = 'lighter'; bands.forEach((b, bi) => { for (let x = 0; x < W + sw; x += sw) { const u = x / W; const yy = H * (b.y + Math.sin(u * b.f * TAU + t * b.sp * TAU + bi) * b.amp + Math.sin(u * b.f * 2.7 * TAU - t * b.sp * 1.7 * TAU) * b.amp * 0.4); const hh = H * b.h * (0.8 + 0.2 * Math.sin(u * 5 + t * 0.4 + bi)); const g = ctx.createLinearGradient(0, yy - hh * 0.3, 0, yy + hh); g.addColorStop(0, rgba(b.c, 0)); g.addColorStop(0.35, rgba(b.c, 0.16)); g.addColorStop(1, rgba(b.c, 0)); ctx.fillStyle = g; ctx.fillRect(x - sw / 2, yy - hh * 0.3, sw + 1, hh * 1.3); } }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'starfield', name: 'Starfield / warp', purpose: 'idle ambience - loading / next level', cost: 'light', phone: true, kind: 'loop',
    params: [{ key: 'warp', label: 'warp', min: 1, max: 10, step: 1, value: 3 }],
    start(p) { const Nn = FX.N(260, 120); const S = []; for (let i = 0; i < Nn; i++) S.push({ x: R(-1, 1), y: R(-1, 1), z: R(0.05, 1), pz: 0 }); const a = { layer: 'bg', update(dt) { const sp = (0.15 + (p.warp || 3) * 0.12) * (FX.reduced() ? 0.4 : 1); S.forEach((s) => { s.pz = s.z; s.z -= sp * dt; if (s.z <= 0.02) { s.x = R(-1, 1); s.y = R(-1, 1); s.z = 1; s.pz = 1; } }); }, draw(ctx) { const W = FX.bg.w, H = FX.bg.h; const cx = W / 2, cy = H / 2, F = Math.max(W, H) * 0.5; ctx.lineCap = 'round'; S.forEach((s) => { const x = cx + s.x / s.z * F, y = cy + s.y / s.z * F; const px = cx + s.x / s.pz * F, py = cy + s.y / s.pz * F; if (x < 0 || x > W || y < 0 || y > H) return; const k = 1 - s.z; ctx.strokeStyle = 'rgba(255,255,255,' + (0.25 + 0.7 * k) + ')'; ctx.lineWidth = 0.6 + k * 2.2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke(); }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'bubbles', name: 'Bubbles', purpose: 'idle ambience - playful', cost: 'light', phone: true, kind: 'loop',
    start() { const B = []; const pops = []; let acc = 0; const a = { update(dt, t) { acc += dt; if (acc > (FX.reduced() ? 0.5 : 0.22) && B.length < 30 * FX.perfScale()) { acc = 0; B.push({ x: R(0, FX.fg.w), y: FX.fg.h + 20, r: R(6, 22), sp: R(30, 70), ph: R(0, TAU), popY: R(FX.fg.h * 0.1, FX.fg.h * 0.55) }); } for (let i = B.length - 1; i >= 0; i--) { const b = B[i]; b.y -= b.sp * dt; b.x += Math.sin(t * 2 + b.ph) * 18 * dt; if (b.y < b.popY) { pops.push({ x: b.x, y: b.y, r: b.r, t: 0 }); B.splice(i, 1); } } for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 0.35) pops.splice(i, 1); } }, draw(ctx) { B.forEach((b) => { ctx.strokeStyle = 'rgba(180,240,255,0.55)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.stroke(); const g = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, 0, b.x, b.y, b.r); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(0.7, 'rgba(0,240,255,0.04)'); g.addColorStop(1, 'rgba(255,45,149,0.12)'); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.72, -2.4, -1.6); ctx.stroke(); }); pops.forEach((p) => { const k = p.t / 0.35; ctx.strokeStyle = 'rgba(200,245,255,' + (1 - k) + ')'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + k * 0.6), 0, TAU); ctx.stroke(); for (let i = 0; i < 6; i++) { const an = i / 6 * TAU; ctx.beginPath(); ctx.arc(p.x + Math.cos(an) * p.r * (1 + k), p.y + Math.sin(an) * p.r * (1 + k), 1.2, 0, TAU); ctx.stroke(); } }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'embers', name: 'Embers rising', purpose: 'idle ambience - warm, or under a hot streak', cost: 'light', phone: true, kind: 'loop',
    start() { const P = []; let acc = 0; const a = { update(dt, t) { acc += dt; const rate = (FX.reduced() ? 8 : 26) * FX.perfScale(); while (acc > 1 / rate) { acc -= 1 / rate; P.push({ x: R(0, FX.fg.w), y: FX.fg.h + 5, vx: R(-15, 15), vy: -R(40, 110), r: R(1.2, 3.2), t: 0, life: R(2.5, 5), ph: R(0, TAU) }); } for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; p.t += dt; p.x += (p.vx + Math.sin(t * 1.7 + p.ph) * 22 + Math.sin(t * 5 + p.ph * 3) * 8) * dt; p.y += p.vy * dt; if (p.t > p.life || p.y < -10) P.splice(i, 1); } }, draw(ctx, t) { ctx.globalCompositeOperation = 'lighter'; P.forEach((p) => { const k = 1 - p.t / p.life; const fl = 0.7 + 0.3 * Math.sin(t * 20 + p.ph); const c = k > 0.6 ? '#ffb800' : k > 0.3 ? '#ff5e3a' : '#ff2d95'; glowCircle(ctx, p.x, p.y, p.r * 4, c, 0.5 * k * fl); ctx.fillStyle = 'rgba(255,240,200,' + (k * fl) + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.7, 0, TAU); ctx.fill(); }); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'scanlines', name: 'CRT scanline pass (subtle)', purpose: 'idle ambience - texture toggle', cost: 'light', phone: true, kind: 'loop',
    start() { const el = FX.domEl('div', 'fx-ov-scan'); return () => el.remove(); } });

  FX.def({ id: 'synth-grid', name: 'Synth grid floor', purpose: 'idle ambience - retro-future under the desk', cost: 'light', phone: true, kind: 'loop',
    start() { const a = { layer: 'bg', update() {}, draw(ctx, t) { const W = FX.bg.w, H = FX.bg.h; const hy = H * 0.62; const g = ctx.createLinearGradient(0, hy - 80, 0, hy + 10); g.addColorStop(0, 'rgba(255,45,149,0)'); g.addColorStop(1, 'rgba(255,45,149,0.28)'); ctx.fillStyle = g; ctx.fillRect(0, hy - 80, W, 90); ctx.strokeStyle = 'rgba(255,45,149,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); for (let i = -14; i <= 14; i++) { const x = W / 2 + i * W * 0.09; ctx.moveTo(W / 2 + i * 12, hy); ctx.lineTo(W / 2 + (x - W / 2) * 4, H); } ctx.stroke(); const speed = FX.reduced() ? 0.15 : 0.5; for (let k = 0; k < 14; k++) { const u = ((k / 14) + (t * speed) % 1) % 1; const y = hy + Math.pow(u, 2.2) * (H - hy); ctx.strokeStyle = 'rgba(255,45,149,' + (0.15 + u * 0.6) + ')'; ctx.lineWidth = 0.6 + u * 1.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } ctx.strokeStyle = 'rgba(0,240,255,0.7)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke(); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'rain-glass', name: 'Rain on the glass', purpose: 'idle ambience - moody', cost: 'medium', phone: true, kind: 'loop',
    start() { const D = []; const trail = []; let acc = 0; const a = { update(dt) { acc += dt; if (acc > (FX.reduced() ? 0.5 : 0.18) && D.length < 40 * FX.perfScale()) { acc = 0; D.push({ x: R(0, FX.fg.w), y: R(-20, 0), r: R(2.5, 6), v: 0, stick: R(0.2, 1.2) }); } for (let i = D.length - 1; i >= 0; i--) { const d = D[i]; d.stick -= dt; if (d.stick <= 0) { d.v = Math.min(d.v + 900 * dt, 220 + d.r * 40); if (Math.random() < dt * 2) d.stick = R(0.1, 0.5); } else d.v = Math.max(0, d.v - 500 * dt); d.y += d.v * dt; d.x += Math.sin(d.y * 0.05) * 6 * dt; if (d.v > 30 && Math.random() < dt * 20) trail.push({ x: d.x + R(-1, 1), y: d.y - d.r, r: d.r * R(0.25, 0.5), t: 0 }); if (d.y > FX.fg.h + 10) D.splice(i, 1); } for (let i = trail.length - 1; i >= 0; i--) { trail[i].t += dt; if (trail[i].t > 4) trail.splice(i, 1); } }, draw(ctx) { trail.forEach((tr) => { ctx.fillStyle = 'rgba(200,230,255,' + (0.35 * (1 - tr.t / 4)) + ')'; ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.r, 0, TAU); ctx.fill(); }); D.forEach((d) => { const g = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, 0, d.x, d.y, d.r); g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.6, 'rgba(180,220,255,0.18)'); g.addColorStop(1, 'rgba(0,240,255,0.32)'); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r, d.r * (1 + Math.min(0.6, d.v / 400)), 0, 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 0.7, -2.6, -1.4); ctx.stroke(); }); } }; FX.add(a); return () => { a.dead = true; }; } });

  /* ═══════════════ GROUP 7 — CURSOR / FINGER ═══════════════ */
  FX.group('cursor', 'Cursor & finger', 'Follows the pointer (mouse) or the finger while dragging.');

  FX.def({ id: 'comet', name: 'Cursor comet trail', purpose: 'cursor - always-on candidate', cost: 'light', phone: true, kind: 'loop',
    start() { const Hh = []; const a = { update(dt) { const p = FX.pointer; if (p.x > -100 && (Hh.length === 0 || Hh[Hh.length - 1].x !== p.x || Hh[Hh.length - 1].y !== p.y)) Hh.push({ x: p.x, y: p.y, t: 0 }); for (let i = Hh.length - 1; i >= 0; i--) { Hh[i].t += dt; if (Hh[i].t > 0.45) Hh.splice(i, 1); } }, draw(ctx) { if (Hh.length < 2) return; ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; for (let i = 1; i < Hh.length; i++) { const k = 1 - Hh[i].t / 0.45; ctx.strokeStyle = rgba('#00f0ff', k * 0.9); ctx.lineWidth = 1 + k * 7; ctx.beginPath(); ctx.moveTo(Hh[i - 1].x, Hh[i - 1].y); ctx.lineTo(Hh[i].x, Hh[i].y); ctx.stroke(); } const h = Hh[Hh.length - 1]; glowCircle(ctx, h.x, h.y, 22, '#00f0ff', 0.7); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(h.x, h.y, 3, 0, TAU); ctx.fill(); } }; FX.add(a); return () => { a.dead = true; }; } });

  FX.def({ id: 'sparkle-trail', name: 'Sparkle trail', purpose: 'cursor - Duolingo-ish', cost: 'light', phone: true, kind: 'loop',
    start() { const S = []; const hook = () => { if (FX.reduced() && Math.random() < 0.6) return; for (let i = 0; i < 2; i++) S.push({ x: FX.pointer.x + R(-8, 8), y: FX.pointer.y + R(-8, 8), vx: R(-40, 40) - FX.pointer.vx * 0.05, vy: R(-60, 10) - FX.pointer.vy * 0.05, r: R(3, 8), rot: R(0, TAU), rv: R(-4, 4), t: 0, life: R(0.5, 0.9), c: pick(['#ffffff', '#ffb800', '#ff2d95', '#00f0ff']) }); }; FX.pointerHooks.add(hook); const a = { update(dt) { for (let i = S.length - 1; i >= 0; i--) { const s = S[i]; s.t += dt; s.vy += 120 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.rv * dt; if (s.t > s.life) S.splice(i, 1); } }, draw(ctx) { ctx.globalCompositeOperation = 'lighter'; S.forEach((s) => { const k = 1 - s.t / s.life; ctx.fillStyle = rgba(s.c, k); star(ctx, s.x, s.y, s.r * k + 0.5, 4, 0.35, s.rot); ctx.fill(); }); }, kill() { FX.pointerHooks.delete(hook); } }; FX.add(a); return () => { a.dead = true; FX.pointerHooks.delete(hook); }; } });

  FX.def({ id: 'ripple', name: 'Tap ripple', purpose: 'cursor - every tap, anywhere', cost: 'light', phone: true, kind: 'loop',
    start() { const Rg = []; const hook = (e) => Rg.push({ x: e.clientX, y: e.clientY, t: 0, dots: Array.from({ length: 8 }, (_, i) => i / 8 * TAU + R(-0.2, 0.2)) }); FX.downHooks.add(hook); const a = { update(dt) { for (let i = Rg.length - 1; i >= 0; i--) { Rg[i].t += dt; if (Rg[i].t > 0.6) Rg.splice(i, 1); } }, draw(ctx) { Rg.forEach((r) => { const k = r.t / 0.6; ctx.strokeStyle = rgba('#ff2d95', 1 - k); ctx.lineWidth = 2.5 * (1 - k) + 0.5; ctx.beginPath(); ctx.arc(r.x, r.y, 6 + ease.outCubic(k) * 60, 0, TAU); ctx.stroke(); ctx.fillStyle = rgba('#ffffff', 1 - k); r.dots.forEach((an) => { const d = 10 + ease.outCubic(k) * 46; ctx.beginPath(); ctx.arc(r.x + Math.cos(an) * d, r.y + Math.sin(an) * d, 2 * (1 - k) + 0.3, 0, TAU); ctx.fill(); }); }); }, kill() { FX.downHooks.delete(hook); } }; FX.add(a); return () => { a.dead = true; FX.downHooks.delete(hook); }; } });

  global.StudyFX = FX;
})(window);
