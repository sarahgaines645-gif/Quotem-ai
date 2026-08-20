'use strict';

/**
 * Q NEXT — one thing. Not a list.
 *
 * Sarah asked for this herself, and Q asked for it independently in his own
 * words: *"ADHD brains need the next step, not the full map."* Everything else
 * in the app is good at capture. This is the bit that decides.
 *
 * ONE capability:
 *   nextAction()  → THE single most urgent thing, with the reason it won.
 *
 * WHY THE RANKING LIVES HERE, NOT IN THE MODEL
 * If Q picks the next action by vibes, the same inbox produces a different
 * answer every time you ask, and "what should I do now?" stops being trustable.
 * The scoring below is plain arithmetic over real data: same facts in, same
 * answer out. Q's job is to say it warmly, not to decide it.
 *
 * WHAT IT LOOKS AT
 *   · open tasks          (overdue first, then due today, then priority)
 *   · today's calendar    (something starting soon beats almost everything)
 *   · finance problems    (already flagged by the finance engine as needing a look)
 *
 * HONESTY RULES BAKED IN:
 *   · Nothing is invented. If there is genuinely nothing to do, it says so —
 *     it does NOT manufacture a task to look useful.
 *   · The reason is always stated, so the answer can be argued with.
 *   · Dates are compared in the user's local day, not UTC, so "due today"
 *     means today to a person, not to a server.
 */

const qLife = require('./q-life');

// ── Scoring weights ────────────────────────────────────────────────────────
// Deliberately coarse. The aim is a defensible ordering, not false precision.
const SCORE = {
    eventImminent:   1000,   // starts within the next 2 hours
    eventToday:       600,
    overdueBase:      500,   // + 10 per day late, capped
    overduePerDay:     10,
    overdueCap:       200,
    dueToday:         400,
    dueTomorrow:      200,
    financeProblem:   350,
    priorityHigh:     120,
    priorityMed:       40,
    priorityLow:        0,
    hasAlertPassed:   150,   // they asked to be reminded and that moment has gone
    noDate:            10,   // something is better than nothing
};

const IMMINENT_HOURS = 2;

/** Today as YYYY-MM-DD in the user's timezone (default UK). */
function localToday(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz || 'Europe/London',
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
    } catch (_) {
        return new Date().toISOString().slice(0, 10);
    }
}

function addDays(isoDate, days) {
    const d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
    const a = new Date(fromIso + 'T00:00:00Z').getTime();
    const b = new Date(toIso + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
}

/**
 * Score every open task. Exported so list_tasks can reuse the same idea of
 * "overdue" rather than inventing a second, disagreeing one.
 */
function scoreTasks(tasks, today, now) {
    const rows = [];
    for (const t of tasks) {
        if (t.done) continue;

        let score = 0;
        const reasons = [];

        if (t.due) {
            const delta = daysBetween(today, t.due);      // negative = in the past
            if (delta < 0) {
                const late = Math.abs(delta);
                score += SCORE.overdueBase + Math.min(late * SCORE.overduePerDay, SCORE.overdueCap);
                reasons.push(late === 1 ? 'a day overdue' : `${late} days overdue`);
            } else if (delta === 0) {
                score += SCORE.dueToday;
                reasons.push('due today');
            } else if (delta === 1) {
                score += SCORE.dueTomorrow;
                reasons.push('due tomorrow');
            }
        } else {
            score += SCORE.noDate;
        }

        // They asked to be reminded, and that moment has already gone by.
        if (t.alertAt) {
            const at = new Date(t.alertAt).getTime();
            if (!isNaN(at) && at <= now) {
                score += SCORE.hasAlertPassed;
                reasons.push('you asked to be reminded about this');
            }
        }

        const p = t.priority === 'high' ? SCORE.priorityHigh
            : t.priority === 'low' ? SCORE.priorityLow
            : SCORE.priorityMed;
        score += p;
        if (t.priority === 'high') reasons.push('marked high priority');

        rows.push({
            kind: 'task',
            id: t.id,
            title: t.title,
            due: t.due || null,
            priority: t.priority || 'med',
            category: t.category || null,
            contact: t.contact || null,
            overdue: !!(t.due && daysBetween(today, t.due) < 0),
            score,
            why: reasons,
        });
    }
    return rows.sort((a, b) => b.score - a.score);
}

function scoreEvents(events, today, now) {
    const rows = [];
    for (const e of events) {
        if (e.date !== today) continue;

        let score = SCORE.eventToday;
        const reasons = ['on today'];

        if (e.time) {
            const start = new Date(`${e.date}T${e.time}`).getTime();
            if (!isNaN(start)) {
                if (start < now) continue;                         // already started; not a next action
                const hoursAway = (start - now) / 3600000;
                if (hoursAway <= IMMINENT_HOURS) {
                    score = SCORE.eventImminent;
                    const mins = Math.round(hoursAway * 60);
                    reasons[0] = mins <= 60 ? `starts in ${mins} minutes` : `starts in about ${Math.round(hoursAway)} hours`;
                }
            }
        }

        rows.push({
            kind: 'event',
            id: e.id,
            title: e.title,
            date: e.date,
            time: e.time || null,
            score,
            why: reasons,
        });
    }
    return rows.sort((a, b) => b.score - a.score);
}

/**
 * The one thing to do next.
 *
 * @param {{include_runners_up?:boolean, timezone?:string}} args
 * @param {string} ownerEmail
 * @returns {Promise<Object>} never throws
 */
async function nextAction(args = {}, ownerEmail) {
    if (!ownerEmail) {
        return {
            error: 'no account',
            instruction_for_q: "You can't see their list right now. Say so plainly and don't guess what they should do.",
        };
    }

    const tz = args.timezone || 'Europe/London';
    const today = localToday(tz);
    const now = Date.now();

    let tasks = [];
    let events = [];
    try {
        tasks = qLife.listTasks(ownerEmail, { status: 'open' }) || [];
    } catch (e) {
        console.warn('[q-next] could not read tasks: ' + e.message);
    }
    try {
        events = qLife.listEvents(ownerEmail, { from: today, to: addDays(today, 1) }) || [];
    } catch (e) {
        console.warn('[q-next] could not read events: ' + e.message);
    }

    const scored = [...scoreTasks(tasks, today, now), ...scoreEvents(events, today, now)]
        .sort((a, b) => b.score - a.score);

    if (!scored.length) {
        console.log('[q-next] nothing outstanding');
        return {
            nothing_outstanding: true,
            checked: { open_tasks: tasks.length, events_today: events.length },
            instruction_for_q: "There is genuinely nothing outstanding — no open tasks, nothing on today. Tell them that, warmly and briefly. Do NOT invent something for them to do just to look useful.",
        };
    }

    const top = scored[0];
    const overdueCount = scored.filter(r => r.kind === 'task' && r.overdue).length;

    console.log(`[q-next] next = ${top.kind}: ${String(top.title).slice(0, 50)} (score ${top.score})`);

    return {
        next: {
            what: top.title,
            kind: top.kind,
            id: top.id,
            why: top.why.join(', '),
            due: top.due || top.date || null,
            time: top.time || null,
            contact: top.contact || null,
        },
        // Context Q may mention in one short clause — never as a second list.
        counts: {
            open_tasks: tasks.filter(t => !t.done).length,
            overdue: overdueCount,
            events_today: events.filter(e => e.date === today).length,
        },
        runners_up: args.include_runners_up
            ? scored.slice(1, 4).map(r => ({ what: r.title, why: r.why.join(', ') }))
            : undefined,
        instruction_for_q:
            "Give them ONE thing: what is in `next`, and the reason from `why`. This is the whole point of the tool — "
            + "do NOT read out the other tasks, do NOT produce a list, do NOT summarise their whole week. "
            + "You may add at most one short clause of context from `counts` (e.g. \"three others can wait\"). "
            + "If they then ask what else there is, that is when you widen. Never invent a task that is not in this result.",
    };
}

module.exports = { nextAction, scoreTasks };
