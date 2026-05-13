'use strict';

/**
 * Q LIFE — per-user calendar events + to-do tasks.
 *
 * Powers the /life page (school dates, appointments, deadlines, errands)
 * and Q's chat tools (add_event / list_events / add_task / complete_task).
 *
 * Files (per user):
 *   ${VOLUME}/users/{slug}/life/calendar.json    — array of events
 *   ${VOLUME}/users/{slug}/life/tasks.json       — array of tasks
 *   ${VOLUME}/users/{slug}/life/categories.json  — user's category list
 *
 * Event schema:
 *   { id, title, date (YYYY-MM-DD), time (HH:MM|null), location, notes,
 *     source, color, category, createdAt }
 *
 * Task schema:
 *   { id, title, due (YYYY-MM-DD|null), priority ('low'|'med'|'high'),
 *     notes, source, color, category, done, doneAt, createdAt }
 *
 * `color` is one of the 7 swatches (or null). `category` is a slug like
 * 'work' / 'kids' — when set, the renderer paints the item in the
 * category's colour unless the user picked one explicitly.
 * Validation is light — anything outside the palette / category list
 * gets stored as null.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataPath } = require('./user-data');

const TAG_COLOURS = ['#a78bfa', '#2ecc71', '#f39c12', '#e74c3c', '#95a5a6', '#f87171', '#fbbf24'];

// Starter categories — first time a user opens /life they see these five.
// They can rename, recolour, delete, or add more from the pill row.
const STARTER_CATEGORIES = [
    { slug: 'work',   name: 'Work',   color: '#a78bfa' },
    { slug: 'kids',   name: 'Kids',   color: '#2ecc71' },
    { slug: 'home',   name: 'Home',   color: '#f39c12' },
    { slug: 'health', name: 'Health', color: '#e74c3c' },
    { slug: 'money',  name: 'Money',  color: '#fbbf24' },
];

function lifeDir(email) { return userDataPath(email, 'life'); }
function calendarFile(email) { return path.join(lifeDir(email), 'calendar.json'); }
function tasksFile(email) { return path.join(lifeDir(email), 'tasks.json'); }
function contextFile(email) { return path.join(lifeDir(email), 'context.txt'); }
function categoriesFile(email) { return path.join(lifeDir(email), 'categories.json'); }

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

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
}

function normalCategory(c) {
    if (!c) return null;
    const slug = slugify(c);
    return slug || null;
}

// ── Categories ──────────────────────────────────────────────────────────

function listCategories(ownerEmail) {
    if (!ownerEmail) return STARTER_CATEGORIES.slice();
    ensureDir(ownerEmail);
    const file = categoriesFile(ownerEmail);
    if (!fs.existsSync(file)) {
        writeArr(file, STARTER_CATEGORIES);
        return STARTER_CATEGORIES.slice();
    }
    const arr = readArr(file);
    return Array.isArray(arr) ? arr : STARTER_CATEGORIES.slice();
}

function addCategory(payload, ownerEmail) {
    if (!ownerEmail) throw new Error('ownerEmail required');
    const name = String(payload?.name || '').trim();
    if (!name) throw new Error('name required');
    const slug = slugify(name);
    if (!slug) throw new Error('name must contain at least one letter or digit');
    const color = normalColor(payload?.color) || TAG_COLOURS[0];
    const categories = listCategories(ownerEmail);
    if (categories.some(c => c.slug === slug)) {
        throw new Error('A category with that name already exists.');
    }
    const cat = { slug, name, color };
    categories.push(cat);
    writeArr(categoriesFile(ownerEmail), categories);
    return cat;
}

function deleteCategory(slug, ownerEmail) {
    if (!ownerEmail || !slug) return false;
    const categories = listCategories(ownerEmail);
    const next = categories.filter(c => c.slug !== slug);
    if (next.length === categories.length) return false;
    writeArr(categoriesFile(ownerEmail), next);
    return true;
}

// Resolve a category slug to its colour, or null if unknown.
function colorForCategory(slug, ownerEmail) {
    if (!slug || !ownerEmail) return null;
    const cat = listCategories(ownerEmail).find(c => c.slug === slug);
    return cat ? cat.color : null;
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
    const category = normalCategory(payload?.category);
    const explicit = normalColor(payload?.color);
    const event = {
        id: newId(),
        title,
        date,
        time: normalTime(payload?.time),
        location: payload?.location ? String(payload.location).trim() : null,
        notes: payload?.notes ? String(payload.notes).trim() : null,
        source: payload?.source ? String(payload.source).slice(0, 32) : 'manual',
        color: explicit || colorForCategory(category, ownerEmail),
        category,
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
    if ('category' in patch) {
        next.category = normalCategory(patch.category);
        // If user didn't pick a colour explicitly this turn, follow the category.
        if (!('color' in patch)) {
            next.color = colorForCategory(next.category, ownerEmail);
        }
    }
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
    const category = normalCategory(payload?.category);
    const explicit = normalColor(payload?.color);
    const task = {
        id: newId(),
        title,
        due: normalDate(payload?.due),
        priority: ['low', 'med', 'high'].includes(payload?.priority) ? payload.priority : 'med',
        notes: payload?.notes ? String(payload.notes).trim() : null,
        source: payload?.source ? String(payload.source).slice(0, 32) : 'manual',
        color: explicit || colorForCategory(category, ownerEmail),
        category,
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
    if ('category' in patch) {
        next.category = normalCategory(patch.category);
        if (!('color' in patch)) {
            next.color = colorForCategory(next.category, ownerEmail);
        }
    }
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

// ── Context — free-text "about you" used to filter extracted items ─────

function getContext(ownerEmail) {
    if (!ownerEmail) return '';
    try {
        if (!fs.existsSync(contextFile(ownerEmail))) return '';
        return fs.readFileSync(contextFile(ownerEmail), 'utf8');
    } catch { return ''; }
}

function setContext(text, ownerEmail) {
    if (!ownerEmail) throw new Error('ownerEmail required');
    ensureDir(ownerEmail);
    const safe = String(text || '').slice(0, 4000);
    fs.writeFileSync(contextFile(ownerEmail), safe);
    return safe;
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
    STARTER_CATEGORIES,
    listEvents, addEvent, updateEvent, deleteEvent,
    listTasks, addTask, updateTask, deleteTask,
    listCategories, addCategory, deleteCategory,
    getContext, setContext,
    addBatch,
};
