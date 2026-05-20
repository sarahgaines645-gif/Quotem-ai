'use strict';

/**
 * ALERT SCHEDULER — fires push notifications when a task's alertAt arrives.
 *
 * Runs as a single setInterval in the server process. Every TICK_MS it:
 *   1. Iterates every signed-up person in people.js
 *   2. Reads their tasks.json
 *   3. For each task with alertAt in the past and no alertedAt set:
 *      - Calls q-push.pushToUser
 *      - Stamps alertedAt = now, so we don't fire it again
 *
 * Editing a task's alertAt resets alertedAt to null (see q-life.js
 * updateTask), so users get a new reminder when they reschedule.
 *
 * No external scheduler needed — pure Node interval inside the same
 * process that serves Express. Survives restarts because state is on the
 * volume (alertedAt is persisted), not in-memory.
 */

const fs = require('fs');
const path = require('path');
const { userDataPath } = require('./user-data');
const { pushToUser } = require('./q-push');

// Tick interval. 60s is a sensible balance — alerts fire within a minute
// of their scheduled time, but the I/O cost per tick is small (one read
// per signed-up user).
const TICK_MS = 60 * 1000;

// Don't fire alerts that were scheduled more than this far in the past
// when the server boots (e.g. user set alertAt during downtime). Avoids
// a flood of stale pings after a long outage.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;  // 6 hours

let _tickHandle = null;

function tasksFileFor(email) {
    return userDataPath(email, 'life/tasks.json');
}

function readTasks(email) {
    const p = tasksFileFor(email);
    try {
        if (!fs.existsSync(p)) return null;
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(arr) ? arr : null;
    } catch { return null; }
}

function writeTasks(email, tasks) {
    const p = tasksFileFor(email);
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
}

async function checkUser(email) {
    const tasks = readTasks(email);
    if (!tasks || !tasks.length) return 0;
    const now = Date.now();
    let due = [];
    for (const t of tasks) {
        if (t.done || !t.alertAt || t.alertedAt) continue;
        const when = new Date(t.alertAt).getTime();
        if (isNaN(when) || when > now) continue;
        if (now - when > STALE_AFTER_MS) {
            // Stale — mark alertedAt anyway so it doesn't sit here forever
            t.alertedAt = new Date().toISOString();
            continue;
        }
        due.push(t);
    }
    if (!due.length) {
        // Still write back if we marked any stale ones
        if (tasks.some(t => t.alertAt && t.alertedAt && !t.done)) writeTasks(email, tasks);
        return 0;
    }
    // Send the pushes — pushToUser handles its own VAPID + dead-sub cleanup.
    let sent = 0;
    for (const t of due) {
        try {
            const body = t.notes
                ? `${t.title} — ${String(t.notes).slice(0, 80)}`
                : t.title;
            await pushToUser(email, {
                title: 'Q reminder',
                body,
                url: '/chat',
                icon: '/favicon-192.png',
            });
            t.alertedAt = new Date().toISOString();
            sent++;
        } catch (e) {
            console.warn(`[alert-scheduler] push failed for ${email}/${t.id}:`, e.message);
        }
    }
    writeTasks(email, tasks);
    return sent;
}

async function tick() {
    let peopleMod;
    try { peopleMod = require(path.join(__dirname, '..', 'people.js')); }
    catch (e) { console.warn('[alert-scheduler] people.js not loadable:', e.message); return; }

    const people = peopleMod.listPeople ? peopleMod.listPeople() : [];
    let totalSent = 0;
    for (const p of people) {
        if (!p.email) continue;
        try {
            totalSent += await checkUser(p.email);
        } catch (e) {
            console.warn(`[alert-scheduler] tick error for ${p.email}:`, e.message);
        }
    }
    if (totalSent > 0) {
        console.log(`[alert-scheduler] fired ${totalSent} reminder push(es)`);
    }
}

function start() {
    if (_tickHandle) return;
    // First tick runs after a short delay so server boot completes (people.js
    // bootstrap, VAPID resolution) before we try to use them.
    setTimeout(() => {
        tick().catch(e => console.warn('[alert-scheduler] first tick error:', e.message));
        _tickHandle = setInterval(() => {
            tick().catch(e => console.warn('[alert-scheduler] tick error:', e.message));
        }, TICK_MS);
        console.log(`[alert-scheduler] ✅ started — tick every ${TICK_MS / 1000}s`);
    }, 5000);
}

function stop() {
    if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
}

module.exports = { start, stop, tick, checkUser };
