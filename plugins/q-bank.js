/**
 * Q BANK — the owned question library.
 *
 * Sarah's design (20 Jul): create all the questions at once, keep every
 * question we've already paid Sonnet to check, serve play from the bank so
 * answering costs nothing, and let students meet the same question again
 * and again until they get it right.
 *
 * Banks are GLOBAL (shared across students) and keyed by subject+board+level.
 * Per-student right/wrong memory lives in each person's progress object on
 * the client side — the bank is just the library.
 *
 * Build jobs run in-process in the background, one at a time per bank,
 * writing to disk after every topic — so a restart mid-build loses nothing
 * and a re-run tops up only what is missing.
 *
 * Phase 3 (15 Aug 2026 — STUDY_SUITE_PHASE1_FINDINGS §2.2 #1-#4):
 *   - topicTag matching is NORMALISED (case / whitespace / punctuation) and
 *     every banked question's tag is SNAPPED to the teacher's list wording,
 *     so "Criminal: causation" and "criminal - causation" are one topic for
 *     top-up, the shelf and mastery.
 *   - startBuild is a real top-up: it is safe to call on every visit. Stocked
 *     topics cost nothing; a no-topic-list bank stops at CORE_TARGET.
 *   - build failures are COUNTED and the last error is kept (sanitised of
 *     vendor names) so the page can show it and offer a retry.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { getBankPath } = require('../memory');

// One in-memory build status per bank key. Lost on restart — harmless,
// because the bank file itself is the durable state and builds are resumable
// (the page re-POSTs /revision/bank/build on every visit; stocked topics skip).
const builds = {};

// A bank with no teacher topic list stops stocking here (Sarah, 6 Aug: 50).
const CORE_TARGET = 50;

function bankKey(subject, board, level) {
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return [slug(subject) || 'general', slug(board) || 'any', slug(level) || 'any'].join('__');
}

// Stable id from the normalised stem — survives regeneration and dedupes.
function questionId(stem) {
    const norm = String(stem || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

// Canonical form of a topic tag for MATCHING only (display keeps the
// teacher's wording): lower-case, letters/digits only, single spaces.
function normTag(tag) {
    return String(tag || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Snap a model-written topicTag onto the teacher's list wording. Exact
// normalised match first; then a containment match either way (a tag of
// "Causation" lands on "Criminal: causation"; "Criminal law — causation and
// remoteness" lands on "Causation"), shortest-distance wins. Unmatched tags
// are kept as written (they still get normalised matching downstream).
function snapTopicTag(tag, topicList) {
    const list = Array.isArray(topicList) ? topicList : splitTopics(topicList);
    if (!list.length) return String(tag || '').trim();
    const t = normTag(tag);
    if (!t) return String(tag || '').trim();
    let best = null, bestScore = Infinity;
    for (const item of list) {
        const n = normTag(item);
        if (!n) continue;
        if (n === t) return item;
        if (n.length >= 4 && t.length >= 4 && (n.includes(t) || t.includes(n))) {
            const score = Math.abs(n.length - t.length);
            if (score < bestScore) { bestScore = score; best = item; }
        }
    }
    return best || String(tag || '').trim();
}

function snapQuestions(questions, topicList) {
    const list = Array.isArray(topicList) ? topicList : splitTopics(topicList);
    if (!list.length) return questions || [];
    return (questions || []).map((q) => (q && q.topicTag ? { ...q, topicTag: snapTopicTag(q.topicTag, list) } : q));
}

// Vendor names never reach a student surface (Sarah's rule). Errors that
// bubble up from the model callers name the provider; rewrite before storing
// or returning them.
function publicError(msg) {
    // one canonical scrubber — lives in q-revision.js (loaded lazily: no cycle at require time)
    return require('./q-revision').publicError(msg);
}

function loadBank(key) {
    try {
        const p = getBankPath(key);
        if (!fs.existsSync(p)) return { key, questions: [], updatedAt: null };
        const bank = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(bank.questions)) bank.questions = [];
        return bank;
    } catch (e) {
        console.warn('[q-bank] load failed for ' + key + ': ' + e.message);
        return { key, questions: [], updatedAt: null };
    }
}

function saveBank(bank) {
    bank.updatedAt = new Date().toISOString();
    fs.writeFileSync(getBankPath(bank.key), JSON.stringify(bank), 'utf8');
}

// Add checked questions, deduped by stem. Returns how many were new.
function addQuestions(key, questions) {
    const bank = loadBank(key);
    const seen = new Set(bank.questions.map((q) => q.id));
    let added = 0;
    for (const q of questions || []) {
        if (!q || !q.question) continue;
        const id = questionId(q.question);
        if (seen.has(id)) continue;
        seen.add(id);
        bank.questions.push({ id, ...q, addedAt: new Date().toISOString() });
        added++;
    }
    if (added > 0) saveBank(bank);
    return added;
}

// How many banked questions carry this topic (normalised match).
function countForTopic(bank, topic) {
    const n = normTag(topic);
    if (!n) return 0;
    return bank.questions.filter((q) => normTag(q.topicTag) === n).length;
}

function bankSummary(key) {
    const bank = loadBank(key);
    const perTopic = {};
    for (const q of bank.questions) {
        const tag = String(q.topicTag || 'General').trim() || 'General';
        perTopic[tag] = (perTopic[tag] || 0) + 1;
    }
    return { key, count: bank.questions.length, perTopic, updatedAt: bank.updatedAt };
}

function buildStatus(key) {
    const b = builds[key];
    return {
        building: !!(b && b.running),
        topicsDone: b ? b.topicsDone : 0,
        topicsTotal: b ? b.topicsTotal : 0,
        topicsSkipped: b ? b.topicsSkipped : 0,
        currentTopic: b && b.running ? b.currentTopic : null,
        added: b ? b.added : 0,
        failed: b ? b.failed : 0,
        lastError: b ? b.lastError : null,
        failedTopics: b ? b.failedTopics.slice(0, 20) : [],
        startedAt: b ? b.startedAt : null,
        finishedAt: b ? b.finishedAt : null,
        ...bankSummary(key),
    };
}

// Split a pasted teacher topic list into individual topics.
function splitTopics(topicText) {
    if (Array.isArray(topicText)) return topicText.map((t) => String(t || '').trim()).filter((t) => t.length > 2);
    return String(topicText || '')
        .split(/[;\n]+/)
        .map((t) => t.replace(/\(.*?very important.*?\)/gi, '').trim())
        .map((t) => t.replace(/^[-•\d.\s]+/, '').trim())
        .filter((t) => t.length > 2);
}

/**
 * Build (or top up) a bank in the background: perTopic checked questions for
 * every topic. Uses the existing Q-writes→Sonnet-checks pipeline, one topic
 * at a time, saving after each — resumable, restart-safe, one build per key.
 * Safe to call on every visit: fully-stocked topics (and a no-list bank at
 * CORE_TARGET) make no AI calls at all.
 */
function startBuild({ subject, board, level, topics, perTopic = 10 }, generateQuiz) {
    const key = bankKey(subject, board, level);
    if (builds[key] && builds[key].running) return { key, started: false, alreadyRunning: true };

    const teacherList = splitTopics(topics);
    let topicList = teacherList.slice();
    // No topic list → stock CORE_TARGET core-topic questions in batches of 10
    // (the avoid-list keeps them distinct). Top-up only what's missing.
    if (topicList.length === 0) {
        const have = loadBank(key).questions.length;
        const batches = Math.max(0, Math.ceil((CORE_TARGET - have) / 10));
        topicList = new Array(batches).fill('');
        if (batches === 0) return { key, started: false, stocked: true, count: have };
    }

    const job = {
        running: true, topicsDone: 0, topicsTotal: topicList.length, topicsSkipped: 0,
        currentTopic: null, added: 0, failed: 0, lastError: null, failedTopics: [],
        startedAt: new Date().toISOString(), finishedAt: null,
    };
    builds[key] = job;

    (async () => {
        console.log(`[q-bank] build started: ${key} — ${topicList.length} topics × ${perTopic}`);
        for (const topic of topicList) {
            job.currentTopic = topic || '(core topics)';
            try {
                const bank = loadBank(key);
                const have = topic ? countForTopic(bank, topic) : 0;
                if (topic && have >= perTopic) { job.topicsDone++; job.topicsSkipped++; continue; } // already stocked — top-up only
                const existingStems = bank.questions.map((q) => q.question.split(/\s+/).slice(0, 10).join(' ')).slice(-40);
                const batch = await generateQuiz({
                    subject, board, level, topic,
                    count: topic ? Math.min(perTopic - have + 1, 12) : 10,
                    avoid: existingStems,
                });
                const snapped = snapQuestions(batch.questions, teacherList);
                job.added += addQuestions(key, snapped);
                if (batch.dropped) console.log(`[q-bank] "${topic || '(core)'}": asked ${batch.asked}, served ${batch.questions.length} (writer dropped ${batch.dropped.writer}, checker dropped ${batch.dropped.checker})`);
            } catch (e) {
                job.failed++;
                job.lastError = publicError(`${topic || 'core topics'}: ${e.message}`);
                job.failedTopics.push(topic || '(core topics)');
                console.warn(`[q-bank] build error on "${topic}": ${e.message}`);
            }
            job.topicsDone++;
        }
        job.running = false;
        job.currentTopic = null;
        job.finishedAt = new Date().toISOString();
        console.log(`[q-bank] build finished: ${key} — ${job.added} new questions, ${job.failed} failed, ${job.topicsSkipped} already stocked (${bankSummary(key).count} total)`);
    })().catch((e) => {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        job.lastError = publicError(e.message);
        console.error('[q-bank] build crashed: ' + e.message);
    });

    return { key, started: true, topics: topicList.length };
}

module.exports = {
    bankKey, questionId, loadBank, addQuestions, bankSummary, buildStatus, startBuild, splitTopics,
    normTag, snapTopicTag, snapQuestions, publicError, CORE_TARGET,
};
