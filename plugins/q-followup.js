'use strict';

/**
 * Q FOLLOW-UP — the difference between a list and a push.
 *
 * Q's own words, 20 Aug 2026: *"I save things and they die in a list. Without
 * this, every task I save is a wish."* He could already save a task and already
 * ping a phone. What he could not do was find out, later, that the thing never
 * happened — and say so.
 *
 * Two halves:
 *   scheduleFollowup()  → set the moment to chase, and the words to chase with.
 *   pendingChases()     → what has come due and NOT been dealt with, handed to
 *                         Q at the top of his next conversation so he raises it
 *                         himself instead of waiting to be asked.
 *
 * HOW THE LOOP ACTUALLY CLOSES
 *   1. schedule_followup stamps alertAt + chase on the task.
 *   2. alert-scheduler.js (already running, every 60s) sees alertAt pass. It
 *      pushes to her phone as before — and now ALSO drops a chase here.
 *   3. The next time she opens a chat, the chat route reads pendingChases()
 *      and puts them in Q's system context. He opens with the chase.
 *   4. Ticking the task off clears its chase. So does Q raising it twice —
 *      see the nagging rule below.
 *
 * THE NAGGING RULE (deliberate)
 *   A chase is raised at most MAX_RAISES times and then retires itself. An
 *   assistant that brings up the same unsent email every single time you open
 *   a chat is not a help, it is a nag, and she will stop reading him. If it
 *   still matters after that, it is still on the task list where it belongs.
 *
 * HONESTY RULES BAKED IN:
 *   · A chase only ever repeats what the task says. Nothing is invented.
 *   · A chase for a task that has since been completed or deleted is dropped
 *     silently — Q must never chase something already done.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataPath } = require('./user-data');

// How many times one chase may be put in front of her before it retires.
const MAX_RAISES = 3;

function chaseFile(email) {
    return userDataPath(email, 'life/chases.json');
}

function readChases(email) {
    try {
        const p = chaseFile(email);
        if (!fs.existsSync(p)) return [];
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

function writeChases(email, arr) {
    try {
        const p = chaseFile(email);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.warn('[q-followup] could not write chases: ' + e.message);
        return false;
    }
}

/**
 * Record that a follow-up has come due. Called by alert-scheduler when it
 * fires, NOT by Q. Idempotent per task: a task already waiting to be chased
 * does not stack up a second entry.
 */
function addChase(email, { taskId, title, message }) {
    if (!email || !title) return null;
    const arr = readChases(email);
    if (arr.some(c => c.taskId && c.taskId === taskId && !c.done)) return null;

    const chase = {
        id: crypto.randomBytes(6).toString('hex'),
        taskId: taskId || null,
        title: String(title).slice(0, 200),
        message: String(message || '').slice(0, 400),
        dueAt: new Date().toISOString(),
        raises: 0,
        done: false,
    };
    arr.push(chase);
    writeChases(email, arr);
    console.log(`[q-followup] chase queued: "${chase.title.slice(0, 60)}"`);
    return chase;
}

/**
 * What Q should raise, right now. Reading them COUNTS as raising them — that
 * is what stops the same chase reappearing forever.
 *
 * @param {string} email
 * @param {{peek?:boolean}} [opts] - peek: look without counting a raise.
 * @returns {Array<{title:string, message:string, taskId:string|null, dueAt:string}>}
 */
function pendingChases(email, opts = {}) {
    if (!email) return [];
    const arr = readChases(email);
    const live = arr.filter(c => !c.done && c.raises < MAX_RAISES);
    if (!live.length) return [];

    if (!opts.peek) {
        for (const c of live) {
            c.raises += 1;
            if (c.raises >= MAX_RAISES) c.done = true;   // said its piece; retire
        }
        writeChases(email, arr);
    }

    return live.map(c => ({
        title: c.title,
        message: c.message,
        taskId: c.taskId,
        dueAt: c.dueAt,
    }));
}

/** Drop the chase for a task — it got done, or it got deleted. */
function clearChaseForTask(email, taskId) {
    if (!email || !taskId) return false;
    const arr = readChases(email);
    let changed = false;
    for (const c of arr) {
        if (c.taskId === taskId && !c.done) { c.done = true; changed = true; }
    }
    if (changed) writeChases(email, arr);
    return changed;
}

/**
 * Build the block that goes into Q's system context. Returns '' when there is
 * nothing to chase, so the caller can append it unconditionally.
 */
function chaseContextBlock(email) {
    const chases = pendingChases(email);
    if (!chases.length) return '';

    const lines = chases.map(c => {
        const when = c.dueAt ? c.dueAt.slice(0, 16).replace('T', ' ') : '';
        return `  · "${c.title}"${when ? ` — came due ${when}` : ''}${c.message ? `\n    Chase with: ${c.message}` : ''}`;
    }).join('\n');

    return '\n\n--- STILL NOT DONE — RAISE THIS YOURSELF, FIRST ---\n'
        + 'These were set to be chased and the moment has passed. Bring the FIRST one up at the\n'
        + 'top of your reply, in your own words, and offer to do it now. Do not wait to be asked,\n'
        + 'do not bury it under whatever they opened with, and do not list them all — one is a\n'
        + 'nudge, four is a telling-off. If they say it is done, say you will tick it off and\n'
        + 'call complete_task. Never claim something happened that you have not been told about.\n'
        + lines
        + '\n--- END ---';
}

/**
 * Set (or move) the moment a task gets chased.
 *
 * @param {{task_id?:string, what?:string, when:string, chase?:string}} args
 * @param {string} ownerEmail
 */
function scheduleFollowup(args = {}, ownerEmail) {
    if (!ownerEmail) {
        return { error: 'no account', instruction_for_q: "You can't set a reminder without them being signed in. Say so plainly." };
    }

    const qLife = require('./q-life');
    const when = String(args.when || '').trim();
    if (!when) {
        return { error: 'no time given', instruction_for_q: 'Ask WHEN they want chasing about it. Do not pick a time yourself.' };
    }

    const at = new Date(when);
    if (isNaN(at.getTime())) {
        return { error: 'bad time', instruction_for_q: `"${when}" is not a date you can use. Work out the real date and time and try again — do not guess.` };
    }

    const chase = String(args.chase || '').trim();

    // Existing task, or a brand new one to hang the follow-up on.
    let task = null;
    const wanted = String(args.task_id || '').trim();
    const open = qLife.listTasks(ownerEmail, { status: 'open' }) || [];

    if (wanted) {
        task = open.find(t => t.id === wanted) || null;
    }
    if (!task && args.what) {
        const needle = String(args.what).toLowerCase().trim();
        const hits = open.filter(t => String(t.title || '').toLowerCase().includes(needle));
        if (hits.length === 1) task = hits[0];
        else if (hits.length > 1) {
            return {
                needs_choice: true,
                options: hits.slice(0, 6).map(t => ({ id: t.id, title: t.title })),
                instruction_for_q: 'More than one task matches. ASK which one they mean before setting anything.',
            };
        }
    }

    try {
        if (task) {
            // Re-arming: q-life.updateTask clears alertedAt when alertAt changes,
            // so a rescheduled task fires again rather than staying silent.
            qLife.updateTask(task.id, { alertAt: at.toISOString(), chase }, ownerEmail);
            clearChaseForTask(ownerEmail, task.id);
        } else {
            const title = String(args.what || '').trim();
            if (!title) {
                return { error: 'nothing to chase', instruction_for_q: 'Ask WHAT they want chasing about.' };
            }
            task = qLife.addTask({ title, alertAt: at.toISOString(), chase }, ownerEmail);
        }
    } catch (e) {
        console.warn('[q-followup] scheduleFollowup failed: ' + e.message);
        return { error: 'could not set it', instruction_for_q: 'Tell them plainly it did not save, and offer to try again.' };
    }

    console.log(`[q-followup] follow-up set: "${task.title.slice(0, 50)}" at ${at.toISOString()}`);

    return {
        ok: true,
        task_id: task.id,
        what: task.title,
        chase_at: at.toISOString(),
        chase_message: chase || null,
        instruction_for_q: 'Confirm in one line: what you will chase, and when. Say plainly that if it is not done by then you WILL bring it up — that promise is the point of it. Do not restate their whole task list.',
    };
}

module.exports = {
    scheduleFollowup,
    addChase,
    pendingChases,
    clearChaseForTask,
    chaseContextBlock,
    MAX_RAISES,
};
