'use strict';

/**
 * Q LIFE — per-user calendar events + to-do tasks.
 *
 * Powers the /life page (school dates, appointments, deadlines, errands)
 * and Q's chat tools (add_event / list_events / add_task / complete_task).
 *
 * Files (per user):
 *   ${VOLUME}/users/{slug}/life/calendar.json   — array of events
 *   ${VOLUME}/users/{slug}/life/tasks.json      — array of tasks
 *
 * Event schema:
 *   { id, title, date (YYYY-MM-DD), time (HH:MM|null), location, notes,
 *     source, color, createdAt }
 *
 * Task schema:
 *   { id, title, due (YYYY-MM-DD|null), priority ('low'|'med'|'high'),
 *     notes, source, color, done, doneAt, createdAt }
 *
 * `color` is one of the 7 swatches from the feature tracker (or null).
 * Validation is light — anything not in the palette gets stored as null.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataPath } = require('./user-data');

const TAG_COLOURS = ['#a78bfa', '#2ecc71', '#f39c12', '#e74c3c', '#95a5a6', '#f87171', '#fbbf24'];

function lifeDir(email) { return userDataPath(email, 'life'); }
function calendarFile(email) { return path.join(lifeDir(email), 'calendar.json'); }
function tasksFile(email) { return path.join(lifeDir(email), 'tasks.json'); }

function ensureDir(email) {
    fs.mkdirSync(lifeDir(email), { recursive: true });
}

function readArr(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        const raw = fs.readFileSync(filePath, 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function writeArr(filePath, arr) {
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
}

function newId() {
    return crypto.randomBytes(6).toString('hex');
}

function normalDate(d) {
    if (!d) return null;
    const s = String(d).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normalTime(t) {
    if (!t) return null;
    const s = String(t).trim();
    return /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, '0') : null;
}

function normalColor(c) {
    return TAG_COLOURS.includes(c) ? c : null;
}

// ── Events ──────────────────────────────────────────────────────────────

function listEvents(ownerEmail, { from, to } = {}) {
    if (!ownerEmail) return [];
    ensureDir(ownerEmail);
    let events = readArr(calendarFile(ownerEmail));
    if (from) events = events.filter(e => e.date >= from);
    if (to)   events = events.filter(e => e.date <= to);
    return events.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.time || '00:00') < (b.time || '00:00') ? -1 : 1;
    });
}

function addEvent(payload, ownerEmail) {
    if (!ownerEmail) throw new Error('ownerEmail required');
    const title = String(payload?.title || '').trim();
    const date = normalDate(payload?.date);
    if (!title) throw new Error('title required');
    if (!date)  throw new Error('date required (YYYY-MM-DD)');
    ensureDir(ownerEmail);
    const event = {
        id: newId(),
        title,
        date,
        time: normalTime(payload?.time),
        location: payload?.location ? String(payload.location).trim() : null,
        notes: payload?.notes ? String(payload.notes).trim() : null,
        source: payload?.source ? String(payload.source).slice(0, 32) : 'manual',
        color: normalColor(payload?.color),
        createdAt: new Date().toISOString(),
    };
    const events = readArr(calendarFile(ownerEmail));
    events.push(event);
    writeArr(calendarFile(ownerEmail), events);
    return event;
}

function updateEvent(id, patch, ownerEmail) {
    if (!ownerEmail || !id) return null;
    const events = readArr(calendarFile(ownerEmail));
    const idx = events.findIndex(e => e.id === id);
    if (idx === -1) return null;
    const cur = events[idx];
    const next = { ...cur };
    if ('title' in patch)    next.title = String(patch.title || '').trim() || cur.title;
    if ('date' in patch)     next.date = normalDate(patch.date) || cur.date;
    if ('time' in patch)     next.time = patch.time === null ? null : (normalTime(patch.time) || cur.time);
    if ('location' in patch) next.location = patch.location ? String(patch.location).trim() : null;
    if ('notes' in patch)    next.notes = patch.notes ? String(patch.notes).trim() : null;
    if ('color' in patch)    next.color = normalColor(patch.color);
    events[idx] = next;
    writeArr(calendarFile(ownerEmail), events);
    return next;
}

function deleteEvent(id, ownerEmail) {
    if (!ownerEmail || !id) return false;
    const events = readArr(calendarFile(ownerEmail));
    const next = events.filter(e => e.id !== id);
    if (next.length === events.length) return false;
    writeArr(calendarFile(ownerEmail), next);
    return true;
}

// ── Tasks ───────────────────────────────────────────────────────────────

function listTasks(ownerEmail, { status } = {}) {
    if (!ownerEmail) return [];
    ensureDir(ownerEmail);
    let tasks = readArr(tasksFile(ownerEmail));
    if (status === 'open') tasks = tasks.filter(t => !t.done);
    if (status === 'done') tasks = tasks.filter(t => t.done);
    return tasks.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        const ad = a.due || '9999-12-31';
        const bd = b.due || '9999-12-31';
        if (ad !== bd) return ad < bd ? -1 : 1;
        const pr = { high: 0, med: 1, low: 2 };
        return (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1);
    });
}

function addTask(payload, ownerEmail) {
    if (!ownerEmail) throw new Error('ownerEmail required');
    const title = String(payload?.title || '').trim();
    if (!title) throw new Error('title required');
    ensureDir(ownerEmail);
    const task = {
        id: newId(),
        title,
        due: normalDate(payload?.due),
        priority: ['low', 'med', 'high'].includes(payload?.priority) ? payload.priority : 'med',
        notes: payload?.notes ? String(payload.notes).trim() : null,
        source: payload?.source ? String(payload.source).slice(0, 32) : 'manual',
        color: normalColor(payload?.color),
        done: false,
        doneAt: null,
        createdAt: new Date().toISOString(),
    };
    const tasks = readArr(tasksFile(ownerEmail));
    tasks.push(task);
    writeArr(tasksFile(ownerEmail), tasks);
    return task;
}

function updateTask(id, patch, ownerEmail) {
    if (!ownerEmail || !id) return null;
    const tasks = readArr(tasksFile(ownerEmail));
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const cur = tasks[idx];
    const next = { ...cur };
    if ('title' in patch)    next.title = String(patch.title || '').trim() || cur.title;
    if ('due' in patch)      next.due = patch.due === null ? null : (normalDate(patch.due) || cur.due);
    if ('priority' in patch && ['low', 'med', 'high'].includes(patch.priority)) next.priority = patch.priority;
    if ('notes' in patch)    next.notes = patch.notes ? String(patch.notes).trim() : null;
    if ('color' in patch)    next.color = normalColor(patch.color);
    if ('done' in patch) {
        next.done = !!patch.done;
        next.doneAt = next.done ? new Date().toISOString() : null;
    }
    tasks[idx] = next;
    writeArr(tasksFile(ownerEmail), tasks);
    return next;
}

function deleteTask(id, ownerEmail) {
    if (!ownerEmail || !id) return false;
    const tasks = readArr(tasksFile(ownerEmail));
    const next = tasks.filter(t => t.id !== id);
    if (next.length === tasks.length) return false;
    writeArr(tasksFile(ownerEmail), next);
    return true;
}

// ── Batch add (used by intake confirm) ──────────────────────────────────

function addBatch({ events = [], tasks = [] } = {}, ownerEmail) {
    const addedEvents = events.map(e => {
        try { return addEvent(e, ownerEmail); } catch { return null; }
    }).filter(Boolean);
    const addedTasks = tasks.map(t => {
        try { return addTask(t, ownerEmail); } catch { return null; }
    }).filter(Boolean);
    return { events: addedEvents, tasks: addedTasks };
}

module.exports = {
    TAG_COLOURS,
    listEvents, addEvent, updateEvent, deleteEvent,
    listTasks, addTask, updateTask, deleteTask,
    addBatch,
};
