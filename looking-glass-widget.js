/**
 * q-lab/looking-glass-widget.js
 *
 * Self-contained vanilla JS port of LookingGlass.jsx for the Q lab UI.
 * Drop the script tag onto a page and a launcher button appears.
 *
 * Click launcher → asks for screen capture permission → shows a draggable,
 * resizable circular lens that magnifies whatever is underneath in real time.
 */
(function () {
    if (window.qLookingGlass) return;
    console.log('[lookingGlass] widget loading…');

    const css = `
        .lg-launcher {
            position: fixed; right: 20px; bottom: 78px; z-index: 9990;
            width: 44px; height: 44px; border-radius: 50%;
            background: var(--q-bg, #1a1a1a); color: var(--q-text, #eee);
            border: none; cursor: pointer; font-size: 20px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.3);
            display: flex; align-items: center; justify-content: center;
        }
        .lg-launcher:hover { transform: scale(1.05); }
        .lg-lens-wrap { position: fixed; pointer-events: none; z-index: 9997; }
        .lg-lens {
            position: absolute; inset: 0; border-radius: 50%;
            box-shadow: 0 0 0 2px rgba(255,255,255,0.2), 0 18px 40px rgba(0,0,0,0.4);
            cursor: grab; pointer-events: auto;
            overflow: hidden; background: #000;
        }
        .lg-lens.square { border-radius: 18px; }
        .lg-lens.dragging { cursor: grabbing; }
        .lg-resize {
            position: absolute; right: -6px; bottom: -6px; width: 22px; height: 22px;
            border-radius: 50%; background: #333; color: #fff;
            cursor: nwse-resize; pointer-events: auto;
            display: flex; align-items: center; justify-content: center; font-size: 12px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        }
        .lg-zoom-canvas { width: 100%; height: 100%; display: block; }
        .lg-toolbar {
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(20,20,20,0.92); color: #eee; padding: 8px 12px;
            border-radius: 24px; display: flex; gap: 10px; align-items: center;
            font-family: system-ui, sans-serif; font-size: 13px; z-index: 9998;
            box-shadow: 0 6px 20px rgba(0,0,0,0.4);
        }
        .lg-btn {
            background: #333; color: #fff; border: none; padding: 6px 12px;
            border-radius: 16px; cursor: pointer; font-size: 12px;
        }
        .lg-btn:hover { background: #444; }
        .lg-btn.danger { background: #6b2020; }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    let stream = null;
    let video = null;
    let active = false;
    let shape = 'circle';
    let zoom = 2;
    let lens = { x: window.innerWidth / 2 - 90, y: window.innerHeight / 2 - 90, width: 180, height: 180 };
    let drag = null;
    let lensWrap, lensEl, canvas, ctx, toolbar;

    async function start() {
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' }, audio: false,
            });
        } catch (err) {
            console.warn('[lookingGlass] capture cancelled or denied:', err.message);
            return;
        }
        video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true; video.playsInline = true;
        await video.play();
        active = true;
        render();
        loop();
        stream.getVideoTracks()[0].addEventListener('ended', stop);
    }

    function stop() {
        active = false;
        if (stream) stream.getTracks().forEach(t => t.stop());
        stream = null; video = null;
        if (lensWrap && lensWrap.parentNode) lensWrap.parentNode.removeChild(lensWrap);
        if (toolbar && toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
        lensWrap = lensEl = canvas = ctx = toolbar = null;
    }

    function render() {
        lensWrap = document.createElement('div');
        lensWrap.className = 'lg-lens-wrap';
        applyLensWrap();

        lensEl = document.createElement('div');
        lensEl.className = 'lg-lens' + (shape === 'square' ? ' square' : '');

        canvas = document.createElement('canvas');
        canvas.className = 'lg-zoom-canvas';
        canvas.width = 360; canvas.height = 360;
        ctx = canvas.getContext('2d');
        lensEl.appendChild(canvas);

        const resize = document.createElement('div');
        resize.className = 'lg-resize';
        resize.textContent = '⤡';
        resize.title = 'Drag to resize';
        resize.addEventListener('mousedown', beginDrag('resize'));

        lensEl.addEventListener('mousedown', beginDrag('move'));
        lensEl.addEventListener('wheel', (e) => {
            e.preventDefault();
            zoom = Math.max(1, Math.min(8, zoom + (e.deltaY < 0 ? 0.25 : -0.25)));
        });

        lensWrap.appendChild(lensEl);
        lensWrap.appendChild(resize);
        document.body.appendChild(lensWrap);

        toolbar = document.createElement('div');
        toolbar.className = 'lg-toolbar';
        toolbar.innerHTML = `
            <span>Looking Glass</span>
            <button class="lg-btn" data-act="shape">${shape === 'circle' ? '◯ Circle' : '▢ Square'}</button>
            <button class="lg-btn" data-act="zoom-out">−</button>
            <span data-zoom>${zoom.toFixed(2)}×</span>
            <button class="lg-btn" data-act="zoom-in">+</button>
            <button class="lg-btn danger" data-act="close">✕ Close</button>
        `;
        toolbar.addEventListener('click', (e) => {
            const act = e.target.dataset.act;
            if (act === 'shape') {
                shape = shape === 'circle' ? 'square' : 'circle';
                lensEl.classList.toggle('square', shape === 'square');
                e.target.textContent = shape === 'circle' ? '◯ Circle' : '▢ Square';
            } else if (act === 'zoom-in') zoom = Math.min(8, zoom + 0.25);
            else if (act === 'zoom-out') zoom = Math.max(1, zoom - 0.25);
            else if (act === 'close') stop();
            const z = toolbar.querySelector('[data-zoom]');
            if (z) z.textContent = zoom.toFixed(2) + '×';
        });
        document.body.appendChild(toolbar);

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', endDrag);
    }

    function applyLensWrap() {
        if (!lensWrap) return;
        lensWrap.style.left = lens.x + 'px';
        lensWrap.style.top = lens.y + 'px';
        lensWrap.style.width = lens.width + 'px';
        lensWrap.style.height = lens.height + 'px';
    }

    function beginDrag(mode) {
        return (e) => {
            e.preventDefault();
            drag = { mode, startX: e.clientX, startY: e.clientY,
                     origX: lens.x, origY: lens.y, origW: lens.width, origH: lens.height };
            if (lensEl) lensEl.classList.add('dragging');
        };
    }

    function onMove(e) {
        if (!drag) return;
        const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
        if (drag.mode === 'move') {
            lens.x = drag.origX + dx;
            lens.y = drag.origY + dy;
        } else if (drag.mode === 'resize') {
            lens.width = Math.max(80, drag.origW + dx);
            lens.height = Math.max(80, drag.origH + dy);
        }
        applyLensWrap();
    }

    function endDrag() {
        drag = null;
        if (lensEl) lensEl.classList.remove('dragging');
    }

    function loop() {
        if (!active) return;
        if (video && video.readyState >= 2 && ctx) {
            const vw = video.videoWidth, vh = video.videoHeight;
            const sw = window.innerWidth, sh = window.innerHeight;
            const sx = (lens.x + lens.width / 2) * (vw / sw);
            const sy = (lens.y + lens.height / 2) * (vh / sh);
            const cropW = (lens.width / zoom) * (vw / sw);
            const cropH = (lens.height / zoom) * (vh / sh);
            try {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(
                    video,
                    sx - cropW / 2, sy - cropH / 2, cropW, cropH,
                    0, 0, canvas.width, canvas.height
                );
            } catch (_) { /* ignore frame errors */ }
        }
        requestAnimationFrame(loop);
    }

    const launcher = document.createElement('button');
    launcher.className = 'lg-launcher';
    launcher.title = 'Looking Glass';
    launcher.textContent = '🔍';
    launcher.addEventListener('click', () => {
        if (active) stop(); else start();
    });
    document.body.appendChild(launcher);

    window.qLookingGlass = { start, stop };
})();
