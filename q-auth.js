/**
 * Q's sign-in / sign-up widget — email + password.
 *
 * On any page that loads /q-auth.js: if the qsess cookie is missing
 * or rejected by the server, a full-screen overlay appears.
 * Two modes: sign in (default, returning users) or sign up (new users).
 * Submitting valid credentials sets the cookie and reloads the page.
 *
 * Sign-up takes name + email + password (no invite code, no admin
 * approval — anyone can create an account and start chatting with Q).
 */
(function () {
    function show() {
        if (document.getElementById('q-signin-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'q-signin-overlay';
        overlay.innerHTML = `
            <style>
                #q-signin-overlay {
                    position: fixed; inset: 0; z-index: 99999;
                    background: rgba(232, 232, 232, 0.96);
                    display: flex; align-items: flex-start; justify-content: center;
                    font-family: 'Space Grotesk', system-ui, sans-serif;
                    overflow-y: auto; -webkit-overflow-scrolling: touch;
                    padding: clamp(16px, 8vh, 80px) 16px clamp(120px, 35vh, 320px);
                }
                #q-signin-card {
                    background: #e8e8e8;
                    box-shadow: 10px 10px 28px #ababab, -8px -8px 20px #ffffff;
                    border-radius: 24px;
                    padding: 40px 36px;
                    width: min(420px, 90vw);
                    text-align: center;
                }
                #q-signin-card h1 {
                    font-size: 32px; margin: 0 0 8px;
                    color: #1a1a1a; font-weight: 700;
                }
                #q-signin-card .dot { color: #e91e63; }
                #q-signin-card p.q-mode-label {
                    color: rgba(0,0,0,0.55); margin: 0 0 24px;
                    font-size: 14px;
                }
                #q-signin-card label {
                    display: block; text-align: left;
                    font-size: 12px; font-weight: 500;
                    color: rgba(0,0,0,0.5);
                    text-transform: uppercase; letter-spacing: 0.5px;
                    margin-bottom: 6px; margin-top: 12px;
                }
                #q-signin-card input {
                    width: 100%; padding: 14px 18px;
                    border: none; outline: none;
                    background: #e8e8e8;
                    box-shadow: inset 5px 5px 14px #ababab, inset -4px -4px 10px #ffffff;
                    border-radius: 14px; font-size: 16px;
                    color: #1a1a1a; font-family: inherit;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                }
                /* Eye toggle for password — sit on the right edge of the field */
                #q-pwd-wrap { position: relative; }
                #q-pwd-eye {
                    position: absolute; right: 12px; top: 50%;
                    transform: translateY(-50%);
                    width: 32px; height: 32px;
                    border: none; cursor: pointer;
                    background: transparent;
                    color: rgba(0,0,0,0.45);
                    display: inline-flex; align-items: center; justify-content: center;
                    border-radius: 8px;
                    padding: 0;
                }
                #q-pwd-eye:hover { color: #1a1a1a; }
                #q-pwd-eye svg { width: 18px; height: 18px; }
                #q-pwd { padding-right: 48px; }
                #q-signin-card button.q-submit {
                    width: 100%; padding: 14px;
                    border: none; cursor: pointer;
                    background: #e8e8e8; color: #1a1a1a;
                    box-shadow: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
                    border-radius: 14px; font-size: 15px;
                    font-weight: 600; font-family: inherit;
                    margin-top: 24px;
                    transition: box-shadow 0.1s;
                }
                #q-signin-card button.q-submit:hover { box-shadow: 4px 4px 10px #ababab, -3px -3px 8px #ffffff; }
                #q-signin-card button.q-submit:active,
                #q-signin-card button.q-submit:disabled {
                    box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
                }
                #q-signin-card button.q-submit:disabled { cursor: wait; opacity: 0.7; }
                #q-signin-card .err {
                    color: #e91e63; font-size: 13px; margin-top: 12px;
                    min-height: 18px;
                }
                /* Mode-toggle link at the bottom of the card */
                #q-signin-card .q-mode-toggle {
                    margin-top: 18px;
                    font-size: 13px;
                    color: rgba(0,0,0,0.55);
                }
                #q-signin-card .q-mode-toggle a {
                    color: #e91e63; text-decoration: none; font-weight: 600;
                    cursor: pointer;
                }
                #q-signin-card .q-mode-toggle a:hover { text-decoration: underline; }
                /* Forgot-password link sits just below the password field */
                #q-forgot-link {
                    text-align: right; font-size: 12px;
                    margin-top: 6px; margin-bottom: 4px;
                }
                #q-forgot-link a {
                    color: rgba(0,0,0,0.55);
                    cursor: pointer; text-decoration: none;
                }
                #q-forgot-link a:hover { color: #e91e63; text-decoration: underline; }
                /* Mode-specific show/hide.
                   - .q-signup-only — name field, signup mode only
                   - .q-signin-only — forgot-password link, signin mode only
                   - .q-pwd-block   — password field + label, hidden ONLY in forgot mode
                   The password is visible in BOTH signin and signup modes, so users
                   can actually see what they're typing when creating an account. */
                #q-signin-overlay[data-mode="signin"] .q-signup-only { display: none; }
                #q-signin-overlay[data-mode="signup"] .q-signin-only { display: none; }
                #q-signin-overlay[data-mode="forgot"] .q-signup-only,
                #q-signin-overlay[data-mode="forgot"] .q-signin-only,
                #q-signin-overlay[data-mode="forgot"] .q-pwd-block { display: none; }
                .q-info {
                    color: rgba(0,0,0,0.6); font-size: 13px;
                    margin-top: 14px; line-height: 1.5;
                }
            </style>
            <div id="q-signin-card">
                <h1>Q<span class="dot">.</span></h1>
                <p class="q-mode-label" id="q-mode-label">Sign in</p>

                <div class="q-signup-only">
                    <label for="q-name">Name</label>
                    <input id="q-name" type="text" autocomplete="name"
                        autocapitalize="words" spellcheck="false" />
                </div>

                <label for="q-email">Email</label>
                <input id="q-email" type="email" autocomplete="email"
                    autocapitalize="off" autocorrect="off" spellcheck="false"
                    inputmode="email" />

                <label for="q-pwd" class="q-pwd-block">Password</label>
                <div id="q-pwd-wrap" class="q-pwd-block">
                    <input id="q-pwd" type="password"
                        autocomplete="current-password"
                        autocapitalize="off" autocorrect="off" spellcheck="false" />
                    <button type="button" id="q-pwd-eye" aria-label="Show password" title="Show / hide password">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
                <div id="q-forgot-link" class="q-signin-only"><a data-mode="forgot">Forgot password?</a></div>

                <p class="q-info q-forgot-only" style="display: none;">
                    Enter the email you signed up with. If we have an account for it, we'll send a reset link that's valid for one hour.
                </p>

                <button class="q-submit" id="q-submit">Sign in</button>
                <div class="err" id="q-err"></div>

                <div class="q-mode-toggle" id="q-mode-toggle">
                    <span class="signin-prompt">New to Q? <a data-mode="signup">Create an account</a></span>
                    <span class="signup-prompt">Already have an account? <a data-mode="signin">Sign in</a></span>
                    <span class="forgot-prompt" style="display: none;"><a data-mode="signin">Back to sign in</a></span>
                </div>
            </div>
        `;
        // Default mode: sign in (returning users)
        overlay.dataset.mode = 'signin';
        document.body.appendChild(overlay);

        const card = overlay.querySelector('#q-signin-card');

        // iOS Safari keyboard fix — when the keyboard opens the visual viewport
        // shrinks but the layout viewport doesn't change, so position:fixed
        // elements end up with their touch targets offset from where they look.
        // Translating the card by the keyboard height keeps visual and touch
        // positions aligned. Also scroll the focused input into view within the
        // overlay (the overflow-y:auto on the overlay makes this work).
        if (window.visualViewport) {
            const _vv = window.visualViewport;
            function _onVP() {
                const kbH = Math.max(0, window.innerHeight - _vv.offsetTop - _vv.height);
                card.style.transform = kbH > 60 ? `translateY(-${Math.round(kbH * 0.3)}px)` : '';
            }
            _vv.addEventListener('resize', _onVP);
            _vv.addEventListener('scroll', _onVP);
        }

        const name = overlay.querySelector('#q-name');
        const email = overlay.querySelector('#q-email');
        const pwd = overlay.querySelector('#q-pwd');
        const submit = overlay.querySelector('#q-submit');
        const err = overlay.querySelector('#q-err');
        const eye = overlay.querySelector('#q-pwd-eye');
        const modeLabel = overlay.querySelector('#q-mode-label');
        const modeToggle = overlay.querySelector('#q-mode-toggle');
        const signinPrompt = modeToggle.querySelector('.signin-prompt');
        const signupPrompt = modeToggle.querySelector('.signup-prompt');
        const forgotPrompt = modeToggle.querySelector('.forgot-prompt');
        const forgotInfo = overlay.querySelector('.q-forgot-only');

        function setMode(m) {
            const next = (m === 'signup' || m === 'forgot') ? m : 'signin';
            overlay.dataset.mode = next;
            err.textContent = '';
            // Show all-mode-toggle prompts off by default; we set the right one below.
            signinPrompt.style.display = 'none';
            signupPrompt.style.display = 'none';
            forgotPrompt.style.display = 'none';
            if (forgotInfo) forgotInfo.style.display = (next === 'forgot') ? '' : 'none';
            if (next === 'signup') {
                modeLabel.textContent = 'Create an account';
                submit.textContent = 'Sign up';
                pwd.setAttribute('autocomplete', 'new-password');
                signupPrompt.style.display = '';
            } else if (next === 'forgot') {
                modeLabel.textContent = 'Reset password';
                submit.textContent = 'Send reset link';
                forgotPrompt.style.display = '';
            } else {
                modeLabel.textContent = 'Sign in';
                submit.textContent = 'Sign in';
                pwd.setAttribute('autocomplete', 'current-password');
                signinPrompt.style.display = '';
            }
        }
        setMode('signin');

        // Delegated mode-switching: catches both the bottom toggle links AND
        // the "Forgot password?" link sitting under the password field.
        card.addEventListener('click', (ev) => {
            const link = ev.target.closest('[data-mode]');
            if (!link) return;
            ev.preventDefault();
            setMode(link.dataset.mode);
        });

        async function handle() {
            err.style.color = '';
            err.textContent = '';
            const mode = overlay.dataset.mode;
            // Trim BOTH email and password — iOS autofill / autocomplete on
            // mobile commonly inserts a trailing space, which broke sign-in
            // on phone (server bcrypt compare fails). Real passwords with
            // intentional whitespace are vanishingly rare.
            const e = (email.value || '').trim();
            const p = (pwd.value || '').trim();

            if (mode === 'forgot') {
                if (!e) { err.textContent = 'Enter the email you signed up with.'; return; }
                submit.disabled = true; submit.textContent = 'Sending...';
                try {
                    await fetch('/forgot-password', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: e }),
                    });
                    // Always show the same confirmation — don't leak which emails exist.
                    err.style.color = '#2e7d32';
                    err.textContent = 'If that email is registered, a reset link is on its way. Check your inbox.';
                } catch (_) {
                    err.textContent = 'Network error — try again.';
                } finally {
                    submit.disabled = false; submit.textContent = 'Send reset link';
                }
                return;
            }

            if (mode === 'signup') {
                const n = (name.value || '').trim();
                if (!n) { err.textContent = 'Please enter your name.'; return; }
                if (!e || !p) { err.textContent = 'Email and password required.'; return; }
                if (p.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
                submit.disabled = true; submit.textContent = 'Creating account...';
                try {
                    const r = await fetch('/signup', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: n, email: e, password: p }),
                    });
                    if (r.ok) { location.reload(); return; }
                    const data = await r.json().catch(() => ({}));
                    err.textContent = data.error || 'Sign-up failed.';
                } catch (_) {
                    err.textContent = 'Network error — try again.';
                } finally {
                    submit.disabled = false; submit.textContent = 'Sign up';
                }
                return;
            }

            // Sign-in mode
            if (!e || !p) { err.textContent = 'Email and password required.'; return; }
            submit.disabled = true; submit.textContent = 'Signing in...';
            try {
                const r = await fetch('/login', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: e, password: p }),
                });
                if (r.ok) {
                    // Verify the session cookie actually committed before
                    // navigating away. iOS Safari can race the Set-Cookie /
                    // reload and drop the cookie; "Block All Cookies" silently
                    // does the same. If /whoami still says null, the login
                    // worked server-side but the browser refused to keep the
                    // session — surface that as a real error rather than
                    // looping the user back to the sign-in screen.
                    let sessionLanded = false;
                    try {
                        const check = await fetch('/whoami', { credentials: 'include', cache: 'no-store' });
                        const data = await check.json();
                        sessionLanded = !!(data && data.person);
                    } catch (_) { /* network blip — handled below */ }
                    if (sessionLanded) {
                        location.reload();
                        return;
                    }
                    err.textContent = "Signed in, but your browser didn't keep the session cookie. On iPhone: Settings → Safari → turn OFF \"Block All Cookies\", then try again.";
                    return;
                }
                const data = await r.json().catch(() => ({}));
                err.textContent = data.error || 'Sign in failed.';
            } catch (_) {
                err.textContent = 'Network error — try again.';
            } finally {
                submit.disabled = false; submit.textContent = 'Sign in';
                pwd.focus();
            }
        }

        // Show / hide password — lets the user verify what was actually typed
        // or autofilled. Important on mobile where typos are easy and invisible.
        if (eye) {
            eye.addEventListener('click', () => {
                const showing = pwd.type === 'text';
                pwd.type = showing ? 'password' : 'text';
                eye.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
            });
        }

        submit.addEventListener('click', handle);
        [name, email, pwd].forEach(input => {
            if (!input) return;
            input.addEventListener('keydown', ev => { if (ev.key === 'Enter') handle(); });
        });
    }

    window.qSignIn = show;
    window.qSignOut = function () {
        fetch('/logout', { method: 'POST', credentials: 'include' })
            .finally(() => location.reload());
    };

    function bootCheck() {
        // Hit a cheap authed endpoint. If 401, show sign-in. Otherwise,
        // the cookie is valid — let the page render normally.
        fetch('/whoami', { credentials: 'include' })
            .then(r => r.json())
            .then(d => { if (!d.person) show(); })
            .catch(() => { /* network blip — leave page alone */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootCheck, { once: true });
    } else {
        bootCheck();
    }
})();

/* ─────────────────────────────────────────────────────────────
 * Q PUSH BELL — site-wide notification opt-in.
 *
 * Lives here because /q-auth.js is the one script every page loads,
 * so push gets a single home with zero per-page wiring.
 *
 * Why a bell, not an auto-prompt: browsers throttle/deny
 * Notification.requestPermission() that isn't tied to a user
 * gesture — silently, so the user simply never sees a prompt.
 * This was previously an auto-on-load IIFE in chat.html ONLY;
 * that is the bug this replaces. Permission is now requested on a
 * deliberate bell click, and the bell shows/persists state.
 *
 * Style: STYLE.md tokens, hardcoded (injected code can't assume a
 * page declares the :root vars — same approach as the auth card
 * above). Accent #e91e63 is used ONLY on the small "on" dot — a
 * sanctioned attention indicator — never the button itself.
 * ───────────────────────────────────────────────────────────── */
(function qPushBell() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

    // Push API wants the VAPID key as bytes; a raw base64 string is not
    // reliable across browsers.
    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    const SVG_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

    let btn, reg;

    function injectStyle() {
        if (document.getElementById('q-bell-style')) return;
        const s = document.createElement('style');
        s.id = 'q-bell-style';
        s.textContent = `
          #q-bell {
            position: fixed; top: 14px; right: 14px; z-index: 99990;
            width: 44px; height: 44px; border: none; border-radius: 50%;
            background: #e8e8e8; color: #1a1a1a; padding: 0;
            box-shadow: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
            display: inline-flex; align-items: center; justify-content: center;
            cursor: pointer; transition: box-shadow 0.12s;
            font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
          }
          #q-bell:hover  { box-shadow: 4px 4px 10px #ababab, -3px -3px 8px #ffffff; }
          #q-bell:active { box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff; }
          #q-bell svg { width: 20px; height: 20px; }
          #q-bell.q-bell-blocked { color: rgba(0,0,0,0.30); cursor: default; }
          #q-bell .q-bell-dot {
            position: absolute; top: 8px; right: 8px;
            width: 9px; height: 9px; border-radius: 50%;
            background: #e91e63; display: none;
            box-shadow: 0 0 0 2px #e8e8e8;
          }
          #q-bell.q-bell-on .q-bell-dot { display: block; }
          @media (max-width: 600px) { #q-bell { width: 40px; height: 40px; top: 10px; right: 10px; } }
        `;
        document.head.appendChild(s);
    }

    function setState(state) {
        if (!btn) return;
        btn.classList.remove('q-bell-on', 'q-bell-blocked');
        if (state === 'on') {
            btn.classList.add('q-bell-on');
            btn.title = 'Notifications are on — Q can reach you here.';
        } else if (state === 'blocked') {
            btn.classList.add('q-bell-blocked');
            btn.title = 'Notifications are blocked in your browser. Turn them on in this site’s settings → Notifications → Allow, then reload.';
        } else {
            btn.title = 'Turn on notifications so Q can reach you.';
        }
    }

    function mountBtn() {
        if (document.getElementById('q-bell')) return;
        injectStyle();
        btn = document.createElement('button');
        btn.id = 'q-bell';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Notifications');
        btn.innerHTML = SVG_BELL + '<span class="q-bell-dot"></span>';
        document.body.appendChild(btn);
        btn.addEventListener('click', onClick);
    }

    async function saveSub(sub) {
        return fetch('/push/subscribe', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub),
        });
    }

    async function subscribe() {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            setState(Notification.permission === 'denied' ? 'blocked' : 'off');
            return;
        }
        const keyRes = await fetch('/push/vapid-public-key', { credentials: 'include' });
        if (!keyRes.ok) { setState('off'); return; }
        const { key } = await keyRes.json();
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
        });
        await saveSub(sub);
        setState('on');
    }

    async function onClick() {
        if (Notification.permission === 'denied') { setState('blocked'); return; }
        try {
            const existing = await reg.pushManager.getSubscription();
            if (existing) { await saveSub(existing).catch(() => {}); setState('on'); return; }
            await subscribe();
        } catch (e) {
            console.warn('[Q] bell:', e.name, e.message);
            setState('off');
        }
    }

    async function init() {
        // /push/* is auth-gated — only mount once there's a signed-in user,
        // else the endpoints 401 and the bell is dead UI.
        try {
            const r = await fetch('/whoami', { credentials: 'include', cache: 'no-store' });
            const d = await r.json();
            if (!d || !d.person) return;
        } catch { return; }

        try {
            reg = await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
        } catch (e) {
            console.warn('[Q] sw register failed:', e.message);
            return;
        }
        mountBtn();
        if (Notification.permission === 'denied') { setState('blocked'); return; }
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
            setState('on');
            saveSub(existing).catch(() => {}); // heal server copy after a redeploy
        } else {
            setState('off');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
