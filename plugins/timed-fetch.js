'use strict';

/**
 * TIMED FETCH — one AbortController wrapper for every upstream AI call.
 *
 * Why: the 19-May route audit found that only q-finance.js put a timeout on
 * its fetches. Every other Together / Anthropic / Gemini / OpenAI call could
 * hang until Railway's edge proxy killed the socket and the user saw a bare
 * "Server error". This helper is the same AbortController shape q-finance
 * uses, applied everywhere, with ONE change: the timer also covers reading
 * the body (`res.json()` / `res.text()`), so a server that returns headers
 * and then stalls still gets cut off.
 *
 *   const res = await timedFetch(url, init, { timeoutMs: 120000, label: 'writer' });
 *   const data = await res.json();      // covered by the same timer
 *
 * On timeout it throws an Error with `.code === 'UPSTREAM_TIMEOUT'` and a
 * plain-English message ("The writer took longer than 120s and was stopped
 * — try again, or shorten the request.") so routes can surface a real cause
 * instead of a generic 500. Every other fetch error passes through unchanged.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

async function timedFetch(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'upstream' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // If the caller already passed a signal, honour it too.
    if (init && init.signal) {
        const outer = init.signal;
        if (outer.aborted) ctrl.abort();
        else outer.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let res;
    try {
        res = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') throw timeoutError(label, timeoutMs);
        throw e;
    }
    // Wrap the body readers so the SAME timer bounds them. Once the body has
    // been consumed (or errored) the timer is cleared.
    const wrap = (method) => async function () {
        try {
            return await method.call(res);
        } catch (e) {
            if (e && e.name === 'AbortError') throw timeoutError(label, timeoutMs);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    };
    res.json = wrap(res.json);
    res.text = wrap(res.text);
    res.arrayBuffer = wrap(res.arrayBuffer);
    // Streaming callers read res.body directly — they own the timer from here.
    // Expose a release() so they can clear it when the stream ends.
    res.releaseTimer = () => clearTimeout(timer);
    return res;
}

function timeoutError(label, timeoutMs) {
    const secs = timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1);
    const err = new Error(`The ${label} took longer than ${secs}s and was stopped — try again, or shorten the request.`);
    err.code = 'UPSTREAM_TIMEOUT';
    err.status = 504;
    return err;
}

module.exports = { timedFetch, DEFAULT_TIMEOUT_MS };
