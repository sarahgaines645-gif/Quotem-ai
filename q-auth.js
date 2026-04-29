/**
 * Q's sign-in widget — email + password.
 *
 * On any page that loads /q-auth.js: if the qsess cookie is missing
 * or rejected by the server, a full-screen sign-in overlay appears.
 * Submitting valid credentials sets the cookie and reloads the page.
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
                #q-signin-card p {
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
                #q-signin-card button {
                    width: 100%; padding: 14px;
                    border: none; cursor: pointer;
                    background: #e8e8e8; color: #1a1a1a;
                    box-shadow: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
                    border-radius: 14px; font-size: 15px;
                    font-weight: 600; font-family: inherit;
                    margin-top: 24px;
                    transition: box-shadow 0.1s;
                }
                #q-signin-card button:hover { box-shadow: 4px 4px 10px #ababab, -3px -3px 8px #ffffff; }
                #q-signin-card button:active,
                #q-signin-card button:disabled {
                    box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff;
                }
                #q-signin-card button:disabled { cursor: wait; opacity: 0.7; }
                #q-signin-card .err {
                    color: #e91e63; font-size: 13px; margin-top: 12px;
                    min-height: 18px;
                }
            </style>
            <div id="q-signin-card">
                <h1>Q<span class="dot">.</span></h1>
                <p>Sign in</p>
                <label for="q-email">Email</label>
                <input id="q-email" type="email" autocomplete="email"
                    autocapitalize="off" autocorrect="off" spellcheck="false"
                    inputmode="email" autofocus />
                <label for="q-pwd">Password</label>
                <div id="q-pwd-wrap">
                    <input id="q-pwd" type="password" autocomplete="current-password"
                        autocapitalize="off" autocorrect="off" spellcheck="false" />
                    <button type="button" id="q-pwd-eye" aria-label="Show password" title="Show / hide password">
                        <svg id="q-pwd-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
                <button id="q-submit">Sign in</button>
                <div class="err" id="q-err"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const email = overlay.querySelector('#q-email');
        const pwd = overlay.querySelector('#q-pwd');
        const submit = overlay.querySelector('#q-submit');
        const err = overlay.querySelector('#q-err');
        const eye = overlay.querySelector('#q-pwd-eye');

        async function handle() {
            err.textContent = '';
            // Trim BOTH email and password — iOS autofill / autocomplete on
            // mobile commonly inserts a trailing space, which broke sign-in
            // on phone (server bcrypt compare fails). Real passwords with
            // intentional whitespace are vanishingly rare.
            const e = (email.value || '').trim();
            const p = (pwd.value || '').trim();
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
                    location.reload();
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
        [email, pwd].forEach(input => {
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
