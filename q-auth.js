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
                    display: flex; align-items: center; justify-content: center;
                    font-family: 'Space Grotesk', system-ui, sans-serif;
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
                /* Hide the name field in sign-in mode */
                #q-signin-overlay[data-mode="signin"] .q-signup-only { display: none; }
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
                    inputmode="email" autofocus />

                <label for="q-pwd">Password</label>
                <div id="q-pwd-wrap">
                    <input id="q-pwd" type="password"
                        autocomplete="current-password"
                        autocapitalize="off" autocorrect="off" spellcheck="false" />
                    <button type="button" id="q-pwd-eye" aria-label="Show password" title="Show / hide password">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>

                <button class="q-submit" id="q-submit">Sign in</button>
                <div class="err" id="q-err"></div>

                <div class="q-mode-toggle" id="q-mode-toggle">
                    <span class="signin-prompt">New to Q? <a data-mode="signup">Create an account</a></span>
                    <span class="signup-prompt">Already have an account? <a data-mode="signin">Sign in</a></span>
                </div>
            </div>
        `;
        // Default mode: sign in (returning users)
        overlay.dataset.mode = 'signin';
        document.body.appendChild(overlay);

        const card = overlay.querySelector('#q-signin-card');
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

        function setMode(m) {
            const next = (m === 'signup') ? 'signup' : 'signin';
            overlay.dataset.mode = next;
            err.textContent = '';
            if (next === 'signup') {
                modeLabel.textContent = 'Create an account';
                submit.textContent = 'Sign up';
                pwd.setAttribute('autocomplete', 'new-password');
                signinPrompt.style.display = 'none';
                signupPrompt.style.display = '';
                setTimeout(() => name.focus(), 0);
            } else {
                modeLabel.textContent = 'Sign in';
                submit.textContent = 'Sign in';
                pwd.setAttribute('autocomplete', 'current-password');
                signinPrompt.style.display = '';
                signupPrompt.style.display = 'none';
                setTimeout(() => email.focus(), 0);
            }
        }
        setMode('signin');

        modeToggle.addEventListener('click', (ev) => {
            const link = ev.target.closest('[data-mode]');
            if (!link) return;
            ev.preventDefault();
            setMode(link.dataset.mode);
        });

        async function handle() {
            err.textContent = '';
            const mode = overlay.dataset.mode;
            // Trim BOTH email and password — iOS autofill / autocomplete on
            // mobile commonly inserts a trailing space, which broke sign-in
            // on phone (server bcrypt compare fails). Real passwords with
            // intentional whitespace are vanishingly rare.
            const e = (email.value || '').trim();
            const p = (pwd.value || '').trim();

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
                if (r.ok) { location.reload(); return; }
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
        setTimeout(() => email.focus(), 50);
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
