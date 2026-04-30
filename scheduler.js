/**
 * q-lab/scheduler.js — Q's job scheduler
 *
 * Lets Q run agent jobs on a recurring schedule or webhook trigger, with no
 * human present. The piece that turns Q from "chat that responds when asked"
 * into "worker that fires on his own."
 *
 * Trigger shapes supported (kept narrow on purpose — full cron is overkill for v1):
 *   { type: 'every',   minutes: 60 }                       — every N minutes
 *   { type: 'daily',   hour: 9, minute: 0 }                — every day at HH:MM (server tz)
 *   { type: 'weekly',  day: 'mon', hour: 9, minute: 0 }    — every Mon at HH:MM
 *   { type: 'once',    runAt: '2026-05-01T09:00:00Z' }     — one-time, then disables
 *   { type: 'webhook', token: '<secret>' }                 — fires only via POST
 *
 * Storage: q-lab/data/q-jobs.json (or Railway volume in production).
 * Worker: setInterval(60s) — checks each job, fires due ones in background.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runAgent } = require('./plugins/q-agent');

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : null);

const Q_DATA_DIR = VOLUME_DIR
    ? path.join(VOLUME_DIR, 'q-memory')
    : path.join(__dirname, 'data');

const JOBS_FILE = path.join(Q_DATA_DIR, 'q-jobs.json');

try {
    fs.mkdirSync(Q_DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[q/scheduler] could not create data dir:', e.message);
}

const POLL_MS = 60 * 1000;            // worker tick
const MAX_RUN_HISTORY = 10;            // last-N runs kept per job
const MAX_JOBS = 100;
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

let workerHandle = null;

// ─── Storage ──────────────────────────────────────────────────────────────

function loadJobs() {
    try {
        if (!fs.existsSync(JOBS_FILE)) return [];
        const data = fs.readFileSync(JOBS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[q/scheduler] load error:', e.message);
        return [];
    }
}

function saveJobs(jobs) {
    try {
        fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[q/scheduler] save error:', e.message);
        return false;
    }
}

function newJobId() {
    return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function newWebhookToken() {
    return crypto.randomBytes(16).toString('hex');
}

// ─── Trigger validation ───────────────────────────────────────────────────

function normaliseTrigger(t) {
    if (!t || typeof t !== 'object') return { error: 'trigger object required' };
    switch (t.type) {
        case 'every': {
            const minutes = parseInt(t.minutes);
            if (!Number.isFinite(minutes) || minutes < 1) return { error: 'every: minutes must be a positive integer' };
            return { trigger: { type: 'every', minutes } };
        }
        case 'daily': {
            const hour = parseInt(t.hour);
            const minute = parseInt(t.minute) || 0;
            if (!Number.isFinite(hour) || hour < 0 || hour > 23) return { error: 'daily: hour 0-23 required' };
            if (minute < 0 || minute > 59) return { error: 'daily: minute 0-59' };
            return { trigger: { type: 'daily', hour, minute } };
        }
        case 'weekly': {
            const day = String(t.day || '').toLowerCase().slice(0, 3);
            const hour = parseInt(t.hour);
            const minute = parseInt(t.minute) || 0;
            if (!(day in DAY_INDEX)) return { error: 'weekly: day must be sun/mon/tue/wed/thu/fri/sat' };
            if (!Number.isFinite(hour) || hour < 0 || hour > 23) return { error: 'weekly: hour 0-23 required' };
            if (minute < 0 || minute > 59) return { error: 'weekly: minute 0-59' };
            return { trigger: { type: 'weekly', day, hour, minute } };
        }
        case 'once': {
            const runAt = String(t.runAt || '');
            const ts = Date.parse(runAt);
            if (!Number.isFinite(ts)) return { error: 'once: runAt must be a valid ISO timestamp' };
            return { trigger: { type: 'once', runAt: new Date(ts).toISOString() } };
        }
        case 'webhook': {
            return { trigger: { type: 'webhook', token: newWebhookToken() } };
        }
        default:
            return { error: 'trigger.type must be one of: every | daily | weekly | once | webhook' };
    }
}

// ─── Due-now logic ────────────────────────────────────────────────────────

function isDue(job, now = new Date(), graceMs = POLL_MS) {
    if (!job.enabled) return false;
    const t = job.trigger || {};
    const lastRunMs = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
    switch (t.type) {
        case 'every': {
            const intervalMs = t.minutes * 60 * 1000;
            return (now.getTime() - lastRunMs) >= intervalMs;
        }
        case 'daily': {
            // Fire when server clock crosses HH:MM; suppress if we already
            // fired today.
            const h = now.getHours();
            const m = now.getMinutes();
            if (h !== t.hour || m !== t.minute) return false;
            const lastRun = lastRunMs ? new Date(lastRunMs) : null;
            return !lastRun || lastRun.toDateString() !== now.toDateString();
        }
        case 'weekly': {
            const expectedDay = DAY_INDEX[t.day];
            if (now.getDay() !== expectedDay) return false;
            if (now.getHours() !== t.hour || now.getMinutes() !== t.minute) return false;
            const lastRun = lastRunMs ? new Date(lastRunMs) : null;
            return !lastRun || lastRun.toDateString() !== now.toDateString();
        }
        case 'once': {
            if (lastRunMs) return false; // already fired
            const target = Date.parse(t.runAt);
            return Number.isFinite(target) && now.getTime() >= target;
        }
        case 'webhook':
            return false; // webhook never auto-fires
        default:
            return false;
    }
}

// ─── Run + record ─────────────────────────────────────────────────────────

async function runJobNow(job, { source = 'scheduler' } = {}) {
    const startedAt = new Date().toISOString();
    let result;
    try {
        result = await runAgent(job.goal, job.agentOptions || {});
    } catch (err) {
        result = { error: err.message };
    }
    const finishedAt = new Date().toISOString();

    // Persist a run record on the job. Keep only the last MAX_RUN_HISTORY.
    const jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === job.id);
    if (idx === -1) return result; // job was deleted while running — drop record

    const record = {
        startedAt,
        finishedAt,
        source,
        ok: !result.error && !!result.summary,
        summary: result.summary ? String(result.summary).substring(0, 2000) : null,
        steps: result.steps || 0,
        durationMs: result.durationMs || 0,
        tokensIn: result.tokensIn || 0,
        tokensOut: result.tokensOut || 0,
        error: result.error || null,
        verifier: result.verifier || null,
    };

    jobs[idx].lastRunAt = startedAt;
    jobs[idx].runCount = (jobs[idx].runCount || 0) + 1;
    jobs[idx].history = [record, ...(jobs[idx].history || [])].slice(0, MAX_RUN_HISTORY);

    // One-time jobs disable themselves after a run.
    if (jobs[idx].trigger && jobs[idx].trigger.type === 'once') {
        jobs[idx].enabled = false;
    }
    saveJobs(jobs);
    return result;
}

// ─── Worker ───────────────────────────────────────────────────────────────

function workerTick() {
    const now = new Date();
    const jobs = loadJobs();
    for (const job of jobs) {
        if (!isDue(job, now)) continue;
        // Fire and forget — the run records itself when complete.
        runJobNow(job, { source: 'scheduler' }).catch(err => {
            console.error('[q/scheduler] job', job.id, 'crashed:', err.message);
        });
    }
}

function startScheduler() {
    if (workerHandle) return; // idempotent
    workerHandle = setInterval(workerTick, POLL_MS);
    console.log('[q/scheduler] worker started — polling every', POLL_MS / 1000, 'sec');
}

function stopScheduler() {
    if (workerHandle) clearInterval(workerHandle);
    workerHandle = null;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────

function createJob({ name, goal, trigger, agentOptions = {}, enabled = true }) {
    if (!name || typeof name !== 'string') return { error: 'name required' };
    if (!goal || typeof goal !== 'string') return { error: 'goal required' };
    const t = normaliseTrigger(trigger);
    if (t.error) return t;

    const jobs = loadJobs();
    if (jobs.length >= MAX_JOBS) return { error: `Job cap reached (${MAX_JOBS})` };

    const job = {
        id: newJobId(),
        name: name.trim().substring(0, 120),
        goal: goal.trim(),
        trigger: t.trigger,
        agentOptions: {
            verify: agentOptions.verify === true,
            maxSteps: parseInt(agentOptions.maxSteps) || undefined,
            reasoningEffort: ['high', 'max'].includes(agentOptions.reasoningEffort) ? agentOptions.reasoningEffort : undefined,
        },
        enabled: enabled !== false,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        runCount: 0,
        history: [],
    };
    jobs.push(job);
    saveJobs(jobs);
    return { ok: true, job };
}

function listJobs() {
    return loadJobs();
}

function getJob(id) {
    return loadJobs().find(j => j.id === id) || null;
}

function patchJob(id, patch) {
    const jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === id);
    if (idx === -1) return { error: 'Job not found' };
    if (typeof patch.enabled === 'boolean') jobs[idx].enabled = patch.enabled;
    if (typeof patch.name === 'string' && patch.name.trim()) jobs[idx].name = patch.name.trim().substring(0, 120);
    if (typeof patch.goal === 'string' && patch.goal.trim()) jobs[idx].goal = patch.goal.trim();
    if (patch.trigger) {
        const t = normaliseTrigger(patch.trigger);
        if (t.error) return t;
        jobs[idx].trigger = t.trigger;
    }
    saveJobs(jobs);
    return { ok: true, job: jobs[idx] };
}

function deleteJob(id) {
    const jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === id);
    if (idx === -1) return { error: 'Job not found' };
    const removed = jobs.splice(idx, 1)[0];
    saveJobs(jobs);
    return { ok: true, removed };
}

function findJobByWebhookToken(token) {
    if (!token) return null;
    return loadJobs().find(j => j.trigger && j.trigger.type === 'webhook' && j.trigger.token === token) || null;
}

function getJobsPath() {
    return JOBS_FILE;
}

module.exports = {
    createJob,
    listJobs,
    getJob,
    patchJob,
    deleteJob,
    runJobNow,
    findJobByWebhookToken,
    startScheduler,
    stopScheduler,
    getJobsPath,
};
