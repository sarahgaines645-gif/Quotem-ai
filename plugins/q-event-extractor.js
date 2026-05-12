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

const SYSTEM_PROMPT = `You are a personal-admin assistant. The user gives you text from a school letter, email, message, photo OCR, bank statement, newsletter, or anything else. Extract everything date-shaped and add preparation tasks where needed.

Return ONE JSON object. No markdown, no prose, no code fences. Just the object:
{
  "events": [ ... ],
  "tasks":  [ ... ]
}

EVENT fields: title (string), date (YYYY-MM-DD, required), time (HH:MM 24h or null), location (string or null), notes (string or null)
TASK fields: title (string, imperative), due (YYYY-MM-DD or null), priority ("low"|"med"|"high"), notes (string or null)

EXTRACTION:
- Resolve relative dates against TODAY. Both arrays required even if empty. Priority defaults to "med".
- One item can produce both an event and a prep task.
- If ABOUT-ME or Q KNOWS context is provided, filter out items that clearly don't apply. When in doubt, keep it.
- Plain English, British spellings.

PREP TASK THINKING:
For every event that requires preparation, think it through before setting the due date. Do not apply fixed offsets or category rules. Reason about this specific task:

What does completing this actually require in real life? Think concretely about what the person has to physically do. A quick errand is not the same as a day trip. Booking something means waiting on someone else's availability. Making something takes real hours across real days.

How much time does it genuinely need? Be honest about the actual effort, not a generic approximation.

When is this person free? If a CALENDAR is provided, look at it. Find free days. Avoid days that are already packed. Overnight is not available. Work backwards from the event date to find the latest realistic slot, then go one earlier for safety.

Is there a hard deadline? Some tasks must be done before a specific moment (present in hand before a birthday, car sold on a specific date). Work backwards from that moment, not from today.

Does it depend on someone else? Booking, arranging, contacting a service — their availability is not yours to control. Go earlier.

Set the due date to what you actually reasoned. Write the task title specifically, not generically. Put anything useful in notes (e.g. "needs a full free day", "call ahead to check availability").

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
            source,
        })),
    };
}

module.exports = { extractLifeAdmin, extractFromImage };
