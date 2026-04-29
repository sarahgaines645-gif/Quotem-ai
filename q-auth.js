/**
 * Q's sign-in widget.
 *
 * On first visit (no qkey cookie), injects a full-screen sign-in overlay
 * asking for the access key Sarah issued. Stores the key as a cookie on
 * submit. All /chat, /code, /agent fetches inherit the cookie.
 *
 * The earlier window.prompt() approach was getting blocked by browsers
 * on initial page load (no user interaction yet). A proper DOM overlay
 * always renders.
 */
(function () {
    function hasKeyCookie() {
        return document.cookie.split(/;\s*/).some(c => c.startsWith('qkey='));
    }
    function setKeyCookie(key) {
        document.cookie = 'qkey=' + encodeURIComponent(key) + '; path=/; max-age=31536000; SameSite=Lax';
    }
    function clearKeyCookie() {
        document.cookie = 'qkey=; path=/; max-age=0';
    }

    window.qSignOut = function () { clearKeyCookie(); location.reload(); };

    function buildOverlay() {
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
                #q-signin-card input {
                    width: 100%; padding: 14px 18px;
                    border: none; outline: none;
                    background: #e8e8e8;
                    box-shadow: inset 5px 5px 14px #ababab, inset -4px -4px 10px #ffffff;
                    border-radius: 14px; font-size: 15px;
                    font-family: monospace; color: #1a1a1a;
                    margin-bottom: 16px;
                }
                #q-signin-card button {
                    width: 100%; padding: 14px;
                    border: none; cursor: pointer;
                    background: #e8e8e8; color: #1a1a1a;
                    box-shadow: 6px 6px 16px #ababab, -5px -5px 12px #ffffff;
                    border-radius: 14px; font-size: 15px;
                    font-weight: 600; font-family: inherit;
                    transition: box-shadow 0.1s;
                }
                #q-signin-card button:hover { box-shadow: 4px 4px 10px #ababab, -3px -3px 8px #ffffff; }
                #q-signin-card button:active { box-shadow: inset 3px 3px 8px #ababab, inset -2px -2px 6px #ffffff; }
                #q-signin-card .err {
                    color: #e91e63; font-size: 13px; margin-top: 12px;
                    min-height: 18px;
                }
            </style>
            <div id="q-signin-card">
                <h1>Q<span class="dot">.</span></h1>
                <p>Enter the access key Sarah issued you</p>
                <input id="q-key-input" type="password" placeholder="Access key" autocomplete="off" autofocus />
                <button id="q-key-submit">Sign in</button>
                <div class="err" id="q-key-err"></div>
            </div>
        `;
        return overlay;
    }

    function show() {
        const overlay = buildOverlay();
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#q-key-input');
        const submit = overlay.querySelector('#q-key-submit');
        const err = overlay.querySelector('#q-key-err');
        const handle = () => {
            const k = (input.value || '').trim();
            if (!k) { err.textContent = 'Paste the key, then Sign in.'; return; }
            setKeyCookie(k);
            // Verify by hitting an authed endpoint before reloading
            fetch('/chat-history', { credentials: 'include' })
                .then(r => {
                    if (r.status === 401) {
                        clearKeyCookie();
                        err.textContent = 'Q does not recognise that key.';
                        input.value = '';
                        input.focus();
                    } else {
                        location.reload();
                    }
                })
                .catch(() => {
                    err.textContent = 'Network error — try again.';
                });
        };
        submit.addEventListener('click', handle);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') handle(); });
        // Make sure the input gets focus even if autofocus is ignored
        setTimeout(() => input.focus(), 100);
    }

    window.qSignIn = function () {
        // Manual sign-in trigger (call from console)
        if (!document.getElementById('q-signin-overlay')) show();
    };

    if (!hasKeyCookie()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', show, { once: true });
        } else {
            show();
        }
    }
})();
