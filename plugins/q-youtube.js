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
// The key. Sarah, 16 Aug: the general Google Cloud key already in Railway
// (GOOGLE_PLACES_KEY) reaches the YouTube Data API perfectly well — it is the
// restricted AI Studio key that comes back blocked. So accept the general keys
// as a fallback rather than sitting silent because one specific name is
// missing. Same order street_view already uses.
function apiKey() {
    return process.env.YOUTUBE_API_KEY || process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_MAPS_KEY || '';
}
function hasKey() { return !!apiKey(); }

// The words a video has to actually contain to be about the thing. Word
// boundaries matter more than anything here: "step" matching "Stepping" is
// exactly how a fitness vlog ended up teaching pay progression.
const TOPIC_STOP = new Set('the a an and or of in on for to is are was were be with from what how why explain explained explaining introduction basics guide tutorial gcse alevel level revision lesson'.split(' '));
function topicTerms(query) {
    const words = String(query || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
        .map(w => w.trim()).filter(w => w.length >= 3 && !TOPIC_STOP.has(w));
    const seen = new Set();
    const out = [];
    for (const w of words) {
        if (seen.has(w)) continue;
        seen.add(w);
        out.push(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|es|ing|ed)?\\b', 'i'));
        if (out.length >= 6) break;
    }
    return out;
}
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
        const auth = apiKey();
        const good = channelsFor(level).map(c => c.toLowerCase());
        const terms = topicTerms(q);
        // Sarah, 16 Aug: asked to teach her about pay progression, Q played
        // "DAY 85 -- Stepping UP Strong!" from a fitness vlog. The search had
        // matched "step". A video that is not about the concept teaches
        // nothing and costs her trust, so a candidate has to actually name the
        // topic — on WORD boundaries, because "step" must not match
        // "Stepping". Matching more of the topic ranks higher; matching none
        // is dropped outright, and dropping everything is fine: the caller
        // falls back to a plain search link, which is honest.
        const rank = (items) => items.map(shape).filter(Boolean).map(v => {
            const ch = v.channel.toLowerCase();
            const idx = good.findIndex(g => ch === g || ch.includes(g));
            const hits = terms.filter(t => t.test(v.title) || t.test(v.channel)).length;
            return { v, hits, score: (idx >= 0 ? 100 - idx : 0) + hits * 40 };
        }).filter(r => !terms.length || r.hits > 0);
        // Pass 1: short explainers (revision-length), general query + subject.
        const qq = subject && !q.toLowerCase().includes(String(subject).toLowerCase()) ? q + ' ' + subject : q;
        let ranked = rank(await callSearch({ q: qq + ' explained', videoDuration: 'short' }, auth));
        // Pass 2: nothing from a known channel, or the short pass found
        // nothing on topic at all — try again without the length limit.
        if (!ranked.some(r => r.score >= 100) || !ranked.length) {
            const more = rank(await callSearch({ q: qq }, auth));
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

module.exports = { searchTeachingVideo, hasKey, channelsFor, cacheStats, topicTerms, CHANNELS };
