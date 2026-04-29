/**
 * q-lab/trace-widget.js
 *
 * Shared pipeline trace widget. Injects a floating launcher button + slide-out
 * panel into any lab page. Each lab feature publishes to it via:
 *
 *   window.qLabTrace.show({
 *     feature: 'Quote Builder',
 *     input: '...',
 *     stages: [{ name, engine, input, output, durationMs, error? }, ...],
 *     final: [...],
 *     totalMs: 2034,
 *   });
 *
 * Last trace persists in localStorage so it's still visible after navigation
 * and across tabs of the same lab session.
 *
 * Self-contained: no external CSS, no other deps. Drop the script tag onto a
 * page and the widget appears.
 *
 * Lab-only — never include on live customer-facing pages.
 */
(function () {
    if (window.qLabTrace) return; // already loaded
    console.log('[qLabTrace] widget loading…');

    const STORAGE_KEY = 'qLabTrace.lastResult';

    // ── INJECT CSS ──────────────────────────────────────────────────
    const css = `
.qlt-launcher {
  position: fixed; bottom: 24px; right: 24px;
  width: 56px; height: 56px;
  border-radius: 50%;
  background: #e91e63;
  box-shadow: 0 4px 16px rgba(233,30,99,0.45), 0 2px 6px rgba(0,0,0,0.2);
  border: none; cursor: pointer; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.18s ease;
  font-family: 'Space Grotesk', -apple-system, sans-serif;
}
.qlt-launcher:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(233,30,99,0.5), 0 3px 8px rgba(0,0,0,0.2); }
.qlt-launcher:active { transform: translateY(0); }
.qlt-launcher svg { width: 24px; height: 24px; color: #ffffff; }
.qlt-launcher .qlt-badge {
  position: absolute; top: -4px; right: -4px;
  background: #1a1a1a; color: white;
  font-size: 10px; font-weight: 700;
  border-radius: 10px; padding: 2px 6px;
  min-width: 18px; text-align: center;
  box-shadow: 0 2px 4px rgba(233,30,99,0.35);
  font-family: 'Space Grotesk', -apple-system, sans-serif;
}

.qlt-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 520px; max-width: 92vw;
  background: #e8e8e8;
  box-shadow: -16px 0 40px rgba(0,0,0,0.18);
  z-index: 1001;
  transform: translateX(100%);
  transition: transform 0.28s cubic-bezier(0.2, 0, 0.2, 1);
  display: flex; flex-direction: column;
  font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
  color: #1a1a1a;
}
.qlt-panel.qlt-open { transform: translateX(0); }
.qlt-header {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  flex-shrink: 0;
}
.qlt-header h2 { font-size: 14px; font-weight: 700; letter-spacing: 0.02em; margin: 0; }
.qlt-header .qlt-sub { font-size: 11px; color: rgba(0,0,0,0.42); margin-left: auto; }
.qlt-close {
  border: none; background: #e8e8e8;
  width: 30px; height: 30px;
  border-radius: 50%; cursor: pointer;
  box-shadow: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
  display: inline-flex; align-items: center; justify-content: center;
  color: rgba(0,0,0,0.42); font-size: 16px;
}
.qlt-close:hover { color: #e91e63; }
.qlt-close:active { box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff; }
.qlt-summary {
  display: flex; gap: 8px; flex-wrap: wrap;
  padding: 12px 20px 0;
  font-size: 12px; color: rgba(0,0,0,0.42);
}
.qlt-summary .qlt-pill {
  padding: 4px 10px; border-radius: 8px;
  box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
  background: #e8e8e8;
}
.qlt-body {
  flex: 1; overflow-y: auto;
  padding: 14px 20px 20px;
  display: flex; flex-direction: column; gap: 12px;
}
.qlt-stage {
  background: #e8e8e8; border-radius: 14px;
  box-shadow: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
  overflow: hidden;
}
.qlt-stage-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; cursor: pointer; user-select: none;
}
.qlt-stage-num {
  width: 22px; height: 22px; border-radius: 50%;
  background: #e8e8e8;
  box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: rgba(0,0,0,0.42);
  flex-shrink: 0;
}
.qlt-stage-name { font-weight: 600; font-size: 13px; flex-shrink: 0; }
.qlt-stage-engine { font-size: 10px; color: rgba(0,0,0,0.42); margin-left: 4px; }
.qlt-stage-meta { font-size: 10px; color: rgba(0,0,0,0.26); margin-left: auto; flex-shrink: 0; }
.qlt-error-pill {
  margin-left: 6px; font-size: 9px; font-weight: 700;
  padding: 2px 6px; border-radius: 4px;
  background: rgba(198,40,40,0.12); color: #c62828;
  text-transform: uppercase; letter-spacing: 0.05em;
}
.qlt-stage-body {
  padding: 0 14px 14px 14px;
  border-top: 1px solid rgba(0,0,0,0.06);
  display: none;
}
.qlt-stage.qlt-open .qlt-stage-body { display: block; }
.qlt-section { margin-top: 10px; }
.qlt-section-label {
  font-size: 10px; font-weight: 700;
  color: rgba(0,0,0,0.42);
  text-transform: uppercase; letter-spacing: 0.08em;
  margin-bottom: 6px;
}
.qlt-code {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 11px; line-height: 1.5;
  background: #e8e8e8;
  box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto; max-height: 240px;
  color: #1a1a1a;
  white-space: pre-wrap; word-break: break-word;
  margin: 0;
}
.qlt-empty {
  padding: 30px 14px; text-align: center;
  color: rgba(0,0,0,0.26); font-size: 13px;
}
.qlt-running {
  padding: 30px 14px; text-align: center;
  color: rgba(0,0,0,0.42); font-size: 13px;
}
`;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    // ── INJECT MARKUP ───────────────────────────────────────────────
    const launcher = document.createElement('button');
    launcher.className = 'qlt-launcher';
    launcher.title = 'Open pipeline trace';
    launcher.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2"></rect>
        <line x1="7" y1="9" x2="17" y2="9"></line>
        <line x1="7" y1="13" x2="14" y2="13"></line>
        <line x1="7" y1="17" x2="11" y2="17"></line>
      </svg>
      <span class="qlt-badge" style="display:none;">0</span>
    `;
    document.body.appendChild(launcher);

    const panel = document.createElement('aside');
    panel.className = 'qlt-panel';
    panel.innerHTML = `
      <div class="qlt-header">
        <h2>Pipeline trace</h2>
        <span class="qlt-sub" id="qlt-feature">No run yet</span>
        <button class="qlt-close" title="Close">×</button>
      </div>
      <div class="qlt-summary" id="qlt-summary"></div>
      <div class="qlt-body" id="qlt-body">
        <div class="qlt-empty">Run a function on this page (or any lab page) — every stage will appear here.</div>
      </div>
    `;
    document.body.appendChild(panel);

    const badge = launcher.querySelector('.qlt-badge');
    const closeBtn = panel.querySelector('.qlt-close');
    const featureEl = panel.querySelector('#qlt-feature');
    const summaryEl = panel.querySelector('#qlt-summary');
    const bodyEl = panel.querySelector('#qlt-body');

    launcher.addEventListener('click', () => {
        panel.classList.add('qlt-open');
        badge.style.display = 'none';
    });
    closeBtn.addEventListener('click', () => panel.classList.remove('qlt-open'));

    // ── HELPERS ─────────────────────────────────────────────────────
    function escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function fmtJson(obj) {
        if (obj == null) return '(null)';
        try { return JSON.stringify(obj, null, 2); } catch (e) { return String(obj); }
    }

    function render(result) {
        if (!result) {
            bodyEl.innerHTML = '<div class="qlt-empty">Run a function on this page (or any lab page) — every stage will appear here.</div>';
            summaryEl.innerHTML = '';
            featureEl.textContent = 'No run yet';
            return;
        }

        featureEl.textContent = result.feature
            ? `${result.feature}${result.timestamp ? ' · ' + new Date(result.timestamp).toLocaleTimeString() : ''}`
            : 'Last run';

        const summaryBits = [
            `<span class="qlt-pill">${result.stages?.length || 0} stages</span>`,
            `<span class="qlt-pill">${result.totalMs ?? '?'}ms total</span>`,
        ];
        if (Array.isArray(result.final)) summaryBits.push(`<span class="qlt-pill">${result.final.length} priced items</span>`);
        if (result.fatal) summaryBits.push(`<span class="qlt-pill" style="color:#c62828">FATAL: ${escape(result.fatal)}</span>`);
        if (result.note) summaryBits.push(`<span class="qlt-pill" style="color:#c77700">${escape(result.note)}</span>`);
        summaryEl.innerHTML = summaryBits.join('');

        bodyEl.innerHTML = '';
        const stages = result.stages || [];
        if (stages.length === 0) {
            bodyEl.innerHTML = '<div class="qlt-empty">No stages emitted.</div>';
            return;
        }

        // Show input as a synthetic stage 0 if provided
        if (result.input != null) {
            const inputDiv = document.createElement('div');
            inputDiv.className = 'qlt-stage qlt-open';
            inputDiv.innerHTML = `
                <div class="qlt-stage-head">
                  <span class="qlt-stage-num">0</span>
                  <span class="qlt-stage-name">Input</span>
                  <span class="qlt-stage-engine">· user-supplied</span>
                </div>
                <div class="qlt-stage-body">
                  <div class="qlt-section">
                    <div class="qlt-section-label">Original brief</div>
                    <pre class="qlt-code">${escape(typeof result.input === 'string' ? result.input : fmtJson(result.input))}</pre>
                  </div>
                </div>
            `;
            inputDiv.querySelector('.qlt-stage-head').addEventListener('click', () => inputDiv.classList.toggle('qlt-open'));
            bodyEl.appendChild(inputDiv);
        }

        stages.forEach((stage, i) => {
            const div = document.createElement('div');
            div.className = 'qlt-stage';
            const errorPill = stage.error ? `<span class="qlt-error-pill">error</span>` : '';
            div.innerHTML = `
                <div class="qlt-stage-head">
                  <span class="qlt-stage-num">${i + 1}</span>
                  <span class="qlt-stage-name">${escape(stage.name)}</span>
                  <span class="qlt-stage-engine">· ${escape(stage.engine)}</span>${errorPill}
                  <span class="qlt-stage-meta">${stage.durationMs ?? '?'}ms</span>
                </div>
                <div class="qlt-stage-body">
                  <div class="qlt-section">
                    <div class="qlt-section-label">Input (what this stage was given)</div>
                    <pre class="qlt-code">${escape(fmtJson(stage.input))}</pre>
                  </div>
                  <div class="qlt-section">
                    <div class="qlt-section-label">Output (what this stage returned)</div>
                    <pre class="qlt-code">${escape(fmtJson(stage.output))}</pre>
                  </div>
                  ${stage.error ? `
                  <div class="qlt-section">
                    <div class="qlt-section-label">Error</div>
                    <pre class="qlt-code" style="color:#c62828">${escape(stage.error)}</pre>
                  </div>` : ''}
                </div>
            `;
            div.querySelector('.qlt-stage-head').addEventListener('click', () => div.classList.toggle('qlt-open'));
            bodyEl.appendChild(div);
        });

        // Auto-open the first stage
        const first = bodyEl.querySelector('.qlt-stage:not(.qlt-open)');
        if (first) first.classList.add('qlt-open');

        // Badge if panel is closed
        if (!panel.classList.contains('qlt-open')) {
            badge.textContent = stages.length;
            badge.style.display = '';
        }
    }

    function showRunning(featureName) {
        featureEl.textContent = `${featureName || 'Running'}…`;
        bodyEl.innerHTML = '<div class="qlt-running">Pipeline running — stages will appear when complete.</div>';
        summaryEl.innerHTML = '';
    }

    console.log('[qLabTrace] launcher mounted — pink circle bottom-right');

    // Restore last trace on load
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) render(JSON.parse(stored));
    } catch (e) { /* ignore */ }

    // Cross-tab sync — when another lab tab updates the trace, refresh ours
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY && e.newValue) {
            try { render(JSON.parse(e.newValue)); } catch (err) { /* ignore */ }
        }
    });

    // ── PUBLIC API ──────────────────────────────────────────────────
    window.qLabTrace = {
        /**
         * Show a completed trace.
         * @param {object} result - { feature, input, stages, final, totalMs, fatal?, note? }
         */
        show(result) {
            const enriched = { ...result, timestamp: Date.now() };
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(enriched)); }
            catch (e) { /* localStorage may be full or blocked — render anyway */ }
            render(enriched);
        },
        /**
         * Indicate a pipeline has started (clears the stage list, shows running state).
         * Call this before kicking off the backend run.
         */
        running(featureName) { showRunning(featureName); },
        /**
         * Open the panel programmatically.
         */
        open() { panel.classList.add('qlt-open'); badge.style.display = 'none'; },
        /**
         * Close the panel.
         */
        close() { panel.classList.remove('qlt-open'); },
        /**
         * Clear the stored trace.
         */
        clear() {
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
            render(null);
        },
    };
})();
