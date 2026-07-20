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
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { getBankPath } = require('../memory');

// One in-memory build status per bank key. Lost on restart — harmless,
// because the bank file itself is the durable state and builds are resumable.
const builds = {};

function bankKey(subject, board, level) {
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return [slug(subject) || 'general', slug(board) || 'any', slug(level) || 'any'].join('__');
}

// Stable id from the normalised stem — survives regeneration and dedupes.
function questionId(stem) {
    const norm = String(stem || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
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

function bankSummary(key) {
    const bank = loadBank(key);
    const perTopic = {};
    for (const q of bank.questions) {
        perTopic[q.topicTag] = (perTopic[q.topicTag] || 0) + 1;
    }
    return { key, count: bank.questions.length, perTopic, updatedAt: bank.updatedAt };
}

function buildStatus(key) {
    const b = builds[key];
    return {
        building: !!(b && b.running),
        topicsDone: b ? b.topicsDone : 0,
        topicsTotal: b ? b.topicsTotal : 0,
        currentTopic: b && b.running ? b.currentTopic : null,
        added: b ? b.added : 0,
        lastError: b ? b.lastError : null,
        ...bankSummary(key),
    };
}

// Split a pasted teacher topic list into individual topics.
function splitTopics(topicText) {
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
 */
function startBuild({ subject, board, level, topics, perTopic = 10 }, generateQuiz) {
    const key = bankKey(subject, board, level);
    if (builds[key] && builds[key].running) return { key, started: false, alreadyRunning: true };

    let topicList = Array.isArray(topics) ? topics : splitTopics(topics);
    // No topic list → build 40 core-topic questions in one run (Sarah: "40
    // qs at a time"): four batches, the avoid-list keeps them distinct.
    if (topicList.length === 0) topicList = ['', '', '', ''];

    const job = { running: true, topicsDone: 0, topicsTotal: topicList.length, currentTopic: null, added: 0, lastError: null };
    builds[key] = job;

    (async () => {
        console.log(`[q-bank] build started: ${key} — ${topicList.length} topics × ${perTopic}`);
        for (const topic of topicList) {
            job.currentTopic = topic || '(core topics)';
            try {
                const bank = loadBank(key);
                const have = topic
                    ? bank.questions.filter((q) => q.topicTag && q.topicTag.toLowerCase() === topic.toLowerCase()).length
                    : 0;
                if (topic && have >= perTopic) { job.topicsDone++; continue; } // already stocked — top-up only
                const existingStems = bank.questions.map((q) => q.question.split(/\s+/).slice(0, 10).join(' ')).slice(-40);
                const batch = await generateQuiz({
                    subject, board, level, topic,
                    count: topic ? Math.min(perTopic - have + 1, 12) : 10,
                    avoid: existingStems,
                });
                job.added += addQuestions(key, batch.questions);
            } catch (e) {
                job.lastError = `${topic}: ${e.message}`;
                console.warn(`[q-bank] build error on "${topic}": ${e.message}`);
            }
            job.topicsDone++;
        }
        job.running = false;
        job.currentTopic = null;
        console.log(`[q-bank] build finished: ${key} — ${job.added} new questions (${bankSummary(key).count} total)`);
    })().catch((e) => {
        job.running = false;
        job.lastError = e.message;
        console.error('[q-bank] build crashed: ' + e.message);
    });

    return { key, started: true, topics: topicList.length };
}

module.exports = { bankKey, questionId, loadBank, addQuestions, bankSummary, buildStatus, startBuild, splitTopics };
