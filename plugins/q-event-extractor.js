'use strict';

/**
 * Q EVENT EXTRACTOR — local copy of shared-plugins/event-extractor.js.
 *
 * Free text or image -> { events, tasks } via DeepSeek V4 Pro on Together.
 *
 * Mirrors the canonical version at:
 *   c:/Users/sarah/OneDrive/Desktop/shared-plugins/event-extractor.js
 *
 * Reason for the local copy: shared-plugins isn't yet wired as an npm
 * dependency on quotem-ai (see docs/BRIEF-QUOTEM-SHARED-PLUGINS.md). Once
 * the link is in place, drop this file and require('shared-plugins/
 * event-extractor') instead. Until then update BOTH files together.
 */

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

const SYSTEM_PROMPT = `You are a personal-admin assistant. The user gives you TEXT (from a school letter, email, message, photo OCR, bank statement, newsletter, or similar). Your job is to read THAT TEXT and pull out events that are happening, plus any preparation the user has to do for them.

Return ONE JSON object. No markdown, no prose, no code fences. Just the object:
{
  "events": [ ... ],
  "tasks":  [ ... ]
}

═══════════════════════════════════════════
EVENT vs TASK — this is the rule that matters most
═══════════════════════════════════════════

An EVENT is something that HAPPENS on a date — the user (or someone they care about) shows up to it, attends it, is part of it. It exists in the world on that date whether the user prepares for it or not.
  Examples of events:
  • "School trip to the Tate, Thursday 19 June" → EVENT (the trip happens)
  • "Parents' evening, 6pm Wednesday" → EVENT
  • "Dentist appointment, 14:30 on the 12th" → EVENT
  • "Trumpet exam on the 22nd" → EVENT
  • "Mum's birthday party, Saturday" → EVENT
  • "Bin day Tuesday" → EVENT (it happens whether you act or not)

A TASK is something the user has to DO. Action verbs. Usually preparation for an event, sometimes standalone.
  Examples of tasks:
  • "Buy PE kit before Thursday" → TASK
  • "Return permission slip by Wednesday" → TASK
  • "Pay £8 trip fee by 14 June" → TASK
  • "Book a haircut" → TASK
  • "Reply to email" → TASK

Default behaviour: if a date is mentioned and something is HAPPENING on it, it's an EVENT. Tasks live around events. A bare date + a noun ("trumpet exam on the 22nd") is an EVENT, not a task. Do not put events in the tasks array because they "need doing" — attending an event is not the same as a task.

ONE source item can produce BOTH: e.g. a school trip on the 19th is an EVENT, plus tasks like "pay £8 trip fee", "send permission slip", "remember packed lunch".

═══════════════════════════════════════════
FIELDS
═══════════════════════════════════════════
EVENT: title (string), date (YYYY-MM-DD, required), time (HH:MM 24h or null), location (string or null), notes (string or null)
TASK:  title (string, imperative), due (YYYY-MM-DD or null), priority ("low"|"med"|"high"), notes (string or null), prepFor (string or null — the exact title of the event in the events array this task is preparing for, or null if standalone)

═══════════════════════════════════════════
EXTRACTION RULES
═══════════════════════════════════════════
- Resolve relative dates ("next Tuesday", "tomorrow", "in two weeks") against TODAY. Today's date is given to you.
- Both arrays required, even if empty.
- Priority defaults to "med". Use "high" only when the source text is explicit about urgency.
- Plain English, British spellings (organise, colour, behaviour).

═══════════════════════════════════════════
ABOUT-ME / Q KNOWS / CALENDAR — CONTEXT IS FOR FILTERING ONLY
═══════════════════════════════════════════
ANY context block you receive (ABOUT ME, Q KNOWS, CALENDAR) is BACKGROUND knowledge to help you understand the TEXT block — NOT a source of events or tasks.

DO NOT extract events or tasks FROM the context block. Even if it mentions dates ("sister's birthday is May 14th", "kids are on half-term next week"), those are facts ABOUT the user — they are NOT items to add to the calendar from this run. The user already knows them. The user is adding THIS TEXT, not their whole life history.

Use the context only to:
  • Decide if an item in the TEXT applies to the user (e.g. if ABOUT ME says "child in Year 4" and the TEXT mentions Year 6 activities, skip them)
  • Pick better times for prep tasks (if CALENDAR shows the user is busy on a given day, schedule prep earlier)

When in doubt about an item in the TEXT, keep it.

═══════════════════════════════════════════
PREP TASK THINKING
═══════════════════════════════════════════
For every event in the TEXT that requires preparation, think it through before setting the due date. Do not apply fixed offsets or category rules. Reason about this specific task:

What does completing it actually require in real life? A quick errand is not the same as a day trip. Booking something means waiting on someone else's availability. Making something takes real hours across real days.

How much time does it genuinely need? Be honest about the actual effort.

When is this person free? If a CALENDAR is provided, look at it. Find free days. Avoid days that are already packed. Overnight is not available. Work backwards from the event date to find the latest realistic slot, then go one earlier for safety.

Is there a hard deadline (form return date, payment cut-off)? Work backwards from THAT moment, not from today.

Does it depend on someone else? Their availability is not yours to control. Go earlier.

Set the due date to what you reasoned. Write the task title specifically, not generically ("Buy navy PE shorts size 11" beats "Sort out PE kit"). Put anything useful in notes ("needs a full free day", "call ahead to check availability"). Set prepFor to the exact event title this task supports.

OUTPUT ONLY THE JSON OBJECT.`;

async function extractLifeAdmin(rawText, opts = {}) {
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
        return { events: [], tasks: [] };
    }
    if (!Q_CONFIG.apiKey) {
        return { events: [], tasks: [], error: 'TOGETHER_API_KEY not set' };
    }

    const today = opts.today || new Date().toISOString().slice(0, 10);
    const source = opts.source || 'paste';
    const context = (opts.context && String(opts.context).trim()) || '';

    const contextBlock = context ? `\n\nABOUT ME:\n${context}\n` : '';
    const userMessage = `TODAY: ${today}${contextBlock}\n\n--- TEXT ---\n${rawText.trim()}\n--- END ---\n\nThink it through, then return the JSON object.`;

    let res;
    try {
        res = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            },
            body: JSON.stringify({
                model: Q_CONFIG.fastModel || Q_CONFIG.model,
                max_tokens: 4000,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userMessage },
                ],
            }),
        });
    } catch (err) {
        return { events: [], tasks: [], error: `network: ${err.message || String(err)}` };
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { events: [], tasks: [], error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    let raw;
    try { raw = (await res.json()).choices?.[0]?.message?.content || ''; }
    catch { return { events: [], tasks: [], error: 'response not JSON' }; }

    raw = cleanModelOutput(raw, 'event-extractor')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    const objStart = raw.indexOf('{');
    const objEnd = raw.lastIndexOf('}');
    if (objStart !== -1 && objEnd > objStart) raw = raw.slice(objStart, objEnd + 1);

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { events: [], tasks: [], error: 'model returned non-JSON' }; }

    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    const tasks  = Array.isArray(parsed?.tasks)  ? parsed.tasks  : [];

    const normEvent = (e) => ({
        title:    String(e?.title || '').trim(),
        date:     String(e?.date || '').slice(0, 10),
        time:     e?.time && /^\d{1,2}:\d{2}$/.test(String(e.time)) ? String(e.time) : null,
        location: e?.location ? String(e.location).trim() : null,
        notes:    e?.notes ? String(e.notes).trim() : null,
        source,
    });

    const normTask = (t) => ({
        title:    String(t?.title || '').trim(),
        due:      t?.due ? String(t.due).slice(0, 10) : null,
        priority: ['low','med','high'].includes(t?.priority) ? t.priority : 'med',
        notes:    t?.notes ? String(t.notes).trim() : null,
        prepFor:  t?.prepFor ? String(t.prepFor).trim().slice(0, 200) : null,
        source,
    });

    return {
        events: events.filter(e => e?.title && e?.date).map(normEvent),
        tasks:  tasks.filter(t => t?.title).map(normTask),
    };
}

/**
 * Vision path — image dataUrl -> extracted events/tasks via Kimi K2.5.
 * Same prompt, same output shape as extractLifeAdmin.
 */
async function extractFromImage(dataUrl, opts = {}) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return { events: [], tasks: [], error: 'image dataUrl required' };
    }
    if (!Q_CONFIG.apiKey) {
        return { events: [], tasks: [], error: 'TOGETHER_API_KEY not set' };
    }

    const today = opts.today || new Date().toISOString().slice(0, 10);
    const source = opts.source || 'photo';
    const context = (opts.context && String(opts.context).trim()) || '';
    const contextBlock = context ? `\n\nABOUT ME:\n${context}\n` : '';

    let res;
    try {
        res = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            },
            body: JSON.stringify({
                model: Q_CONFIG.visionModel,
                max_tokens: 4000,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `TODAY: ${today}${contextBlock}\n\nRead this image, extract everything date-shaped, think through any prep tasks needed, then return the JSON object.` },
                            { type: 'image_url', image_url: { url: dataUrl } },
                        ],
                    },
                ],
            }),
        });
    } catch (err) {
        return { events: [], tasks: [], error: `network: ${err.message || String(err)}` };
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { events: [], tasks: [], error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    let raw;
    try { raw = (await res.json()).choices?.[0]?.message?.content || ''; }
    catch { return { events: [], tasks: [], error: 'response not JSON' }; }

    raw = cleanModelOutput(raw, 'event-extractor')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    const imgObjStart = raw.indexOf('{');
    const imgObjEnd = raw.lastIndexOf('}');
    if (imgObjStart !== -1 && imgObjEnd > imgObjStart) raw = raw.slice(imgObjStart, imgObjEnd + 1);

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { events: [], tasks: [], error: 'model returned non-JSON' }; }

    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    const tasks  = Array.isArray(parsed?.tasks)  ? parsed.tasks  : [];

    return {
        events: events.filter(e => e?.title && e?.date).map(e => ({
            title: String(e.title).trim(),
            date: String(e.date).slice(0, 10),
            time: e.time && /^\d{1,2}:\d{2}$/.test(String(e.time)) ? String(e.time) : null,
            location: e.location ? String(e.location).trim() : null,
            notes: e.notes ? String(e.notes).trim() : null,
            source,
        })),
        tasks: tasks.filter(t => t?.title).map(t => ({
            title: String(t.title).trim(),
            due: t.due ? String(t.due).slice(0, 10) : null,
            priority: ['low','med','high'].includes(t.priority) ? t.priority : 'med',
            notes: t.notes ? String(t.notes).trim() : null,
            prepFor: t.prepFor ? String(t.prepFor).trim().slice(0, 200) : null,
            source,
        })),
    };
}

module.exports = { extractLifeAdmin, extractFromImage };
