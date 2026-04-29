/**
 * Q's sign-in widget.
 *
 * Drop a single <script src="/q-auth.js"></script> tag near the top of
 * any Q page. On first visit (no qkey cookie), it prompts for the access
 * key Sarah issued and stores it as a cookie. All subsequent /chat,
 * /code, /agent, etc. fetches inherit the cookie automatically — no
 * per-fetch header changes needed.
 *
 * Day-one UI: window.prompt(). Replace with a proper sign-in modal when
 * the marketing landing page is built.
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

    // Expose a sign-out helper any page can call
    window.qSignOut = function () {
        clearKeyCookie();
        location.reload();
    };

    // Expose a manual sign-in helper any page can call
    window.qSignIn = function () {
        const k = prompt('Q\'s access key (Sarah will have given you this):');
        if (k && k.trim()) {
            setKeyCookie(k.trim());
            location.reload();
        }
    };

    if (!hasKeyCookie()) {
        // Defer until DOM is ready so the prompt doesn't block parsing
        const ask = () => window.qSignIn();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ask, { once: true });
        } else {
            ask();
        }
    }
})();
