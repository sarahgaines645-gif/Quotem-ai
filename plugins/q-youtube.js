/**
 * Q YOUTUBE — one teaching video for a concept, from the YouTube Data API v3.
 *
 * Sarah, 15 Aug 2026: "So we can have videos open in the teaching suite. It
 * needs to open on its own raised movable card." This plugin finds ONE good
 * explainer for a query and returns what a page needs to embed it:
 *   searchTeachingVideo({ query, level, subject }) → { videoId, title, channel, url, embedUrl } | null
 *
 * Rules:
 * - Key from process.env.YOUTUBE_API_KEY (Railway → Variables — never in the
 *   repo). No key → returns null (the page falls back to a plain search
 *   link). Any API failure → null. NEVER an error to the user.
 * - Channel-first ranking: a short allowlist of good UK teaching channels for
 *   the level (BBC Bitesize, Cognito, FreeScienceLessons, Mr Bruff, Tutor2u,
 *   CIPD / HR explainers…) beats a general result; then general results.
 * - safeSearch strict, videoEmbeddable true, short videos first (revision).
 * - Results cached in memory per query for 24h (the free quota is 10,000
 *   units/day; a search costs 100). Every call is counted through logUsage
 *   (kind 'youtube', free) so the cost meter shows the volume.
 * - Reusable by the writer and the revision suite: same function, two routes.
 */
'use strict';

const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');

const API = 'https://www.googleapis.com/youtube/v3/search';
const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();   // key → { at, result }

// Good UK teaching channels by level. Names are matched case-insensitively
// against the API's channelTitle (a channel-id allowlist would need a lookup
// call per channel — names are enough to rank, and cost nothing).
const CHANNELS = {
    common: ['BBC Bitesize', 'BBC Teach', 'Khan Academy', 'TED-Ed', 'Crash Course', 'The Open University', 'OpenLearn'],
    gcse: ['Cognito', 'FreeScienceLessons', 'Mr Bruff', 'Primrose Kitten', 'Science with Hazel', 'Corbettmaths', 'Maths Genie', 'HegartyMaths', 'Sparx Maths', 'Physics Online', 'Mr Salles Teaches English', 'The GCSE Maths Tutor', 'Miss Adams Maths', 'GCSEPod', 'History Bombs', 'Mr Everything English'],
    alevel: ['Tutor2u', 'tutor2u', 'Snap Revise', 'SnapRevise', 'Physics Online', 'A Level Biology', 'Chemistry Student', 'Allery Chemistry', 'MathsWatch', 'ExamSolutions', 'TLMaths', 'Bertie Bumble', 'EconplusDal', 'Ollie Lovell'],
    university: ['CIPD', 'ACAS', 'HRD Connect', 'Tutor2u', 'tutor2u', 'The Open University', 'OpenLearn', 'Harvard Business Review', 'London Business School', 'MIT OpenCourseWare', 'Warwick Business School', 'CIPD Learning', 'People Management'],
};
function channelsFor(level) {
    const l = String(level || '').toLowerCase();
    if (/university|degree|cipd|level ?[5-7]|adult|masters?/.test(l)) return CHANNELS.university.concat(CHANNELS.common);
    if (/a-?level|a level|year ?1[23]|sixth|btec|level ?3/.test(l)) return CHANNELS.alevel.concat(CHANNELS.common);
    if (/gcse|year ?(7|8|9|10|11)|ks[34]|secondary/.test(l)) return CHANNELS.gcse.concat(CHANNELS.common);
    return CHANNELS.common.concat(CHANNELS.gcse, CHANNELS.alevel, CHANNELS.university);
}
function hasKey() { return !!process.env.YOUTUBE_API_KEY; }
function cacheKey(query, level, subject) { return [String(query || '').trim().toLowerCase(), String(level || '').toLowerCase(), String(subject || '').toLowerCase()].join('|'); }

// The pieces a page needs. embedUrl uses the privacy-enhanced host.
function shape(item) {
    const id = item && item.id && item.id.videoId;
    if (!id) return null;
    const sn = item.snippet || {};
    return {
        videoId: id,
        title: String(sn.title || '').trim(),
        channel: String(sn.channelTitle || '').trim(),
        url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id),
        embedUrl: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?rel=0&modestbranding=1',
        publishedAt: sn.publishedAt || null,
    };
}

async function callSearch(params, key) {
    const qs = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '10', safeSearch: 'strict', videoEmbeddable: 'true', relevanceLanguage: 'en', regionCode: 'GB', key, ...params });
    const started = Date.now();
    const res = await timedFetch(API + '?' + qs.toString(), { method: 'GET' }, { label: 'youtube', timeoutMs: 15000 });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        logUsage({ skill: 'video', provider: 'youtube', model: 'search.list', started, success: false, error: 'HTTP ' + res.status, kind: 'youtube' });
        throw new Error('YouTube search ' + res.status + ': ' + text.slice(0, 160));
    }
    const data = await res.json();
    logUsage({ skill: 'video', provider: 'youtube', model: 'search.list', started, kind: 'youtube', tokensIn: 0, tokensOut: 0 });
    return Array.isArray(data.items) ? data.items : [];
}

/**
 * searchTeachingVideo — ONE video for the concept, channel-first, short-first.
 * Returns null (never throws) when there is no key, no result, or the API fails.
 */
async function searchTeachingVideo({ query, level, subject } = {}) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) return null;
    if (!hasKey()) return null;
    const key = cacheKey(q, level, subject);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
    let result = null;
    try {
        const apiKey = process.env.YOUTUBE_API_KEY;
        const good = channelsFor(level).map(c => c.toLowerCase());
        const rank = (items) => items.map(shape).filter(Boolean).map(v => {
            const ch = v.channel.toLowerCase();
            const idx = good.findIndex(g => ch === g || ch.includes(g));
            return { v, score: idx >= 0 ? 100 - idx : 0 };
        });
        // Pass 1: short explainers (revision-length), general query + subject.
        const qq = subject && !q.toLowerCase().includes(String(subject).toLowerCase()) ? q + ' ' + subject : q;
        let ranked = rank(await callSearch({ q: qq + ' explained', videoDuration: 'short' }, apiKey));
        // Pass 2 (only if nothing from a known channel): any length.
        if (!ranked.some(r => r.score > 0)) {
            const more = rank(await callSearch({ q: qq }, apiKey));
            ranked = ranked.concat(more.filter(m => !ranked.some(r => r.v.videoId === m.v.videoId)));
        }
        ranked.sort((a, b) => b.score - a.score);
        result = ranked.length ? ranked[0].v : null;
    } catch (e) {
        console.warn('[q-youtube] ' + (e && e.message));
        result = null;
    }
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 2000) { const first = cache.keys().next().value; cache.delete(first); }
    return result;
}

function cacheStats() { return { entries: cache.size, hasKey: hasKey() }; }

module.exports = { searchTeachingVideo, hasKey, channelsFor, cacheStats, CHANNELS };
