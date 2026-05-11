'use strict';

/**
 * Q EVENT EXTRACTOR — local copy of shared-plugins/event-extractor.js.
 *
 * Free text → { events, tasks } via DeepSeek V4 Pro on Together.
 *
 * Mirrors the canonical version at:
 *   c:/Users/sarah/OneDrive/Desktop/shared-plugins/event-extractor.js
 *
 * Reason for the local copy: shared-plugins isn't yet wired as an npm
 * dependency on quotem-ai (see docs/BRIEF-QUOTEM-SHARED-PLUGINS.md). Once
 * the link is in place, drop this file and `require('shared-plugins/
 * event-extractor')` instead. Until then update BOTH files together.
 */

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

const SYSTEM_PROMPT = `You are a personal-admin extractor. The user gives you text from a school letter, email, message, photo OCR, or anything else. Your job is to pull out everything date-shaped.

Return ONE JSON object — no markdown, no prose, no fences:
{
  "events": [ ... ],
  "tasks":  [ ... ]
}

EVENT — something happening AT a specific date (a school trip, an appointment, a parents' evening, a deadline that is also a moment). Fields:
- title (string, short)
- date (string, YYYY-MM-DD, REQUIRED — your best guess if not explicit)
- time (string "HH:MM" 24-hour, or null if not stated)
- location (string, or null)
- notes (string, or null — anything useful that didn't fit)

TASK — something to DO before a date (return a form, pay something, buy supplies). Fields:
- title (string, short, imperative — "Bring PE kit", "Pay £20 trip fee")
- due (string YYYY-MM-DD, or null if no deadline mentioned)
- priority ("low" | "med" | "high")
- notes (string, or null)

RULES:
1. Resolve all dates against TODAY. "Friday" → next Friday. "Next week" → seven days from today. If a year is missing assume the next occurrence.
2. Both arrays are required even if empty.
3. A single line may produce BOTH an event AND a task (e.g. "School trip Friday, return slip by Wednesday" → 1 event + 1 task).
4. Priority defaults to "med". Bump to "high" for words like urgent, today, deadline, last chance. Drop to "low" for "if you have time", "optional".
5. Don't invent items not in the text. If the text has nothing date-shaped, return empty arrays.
6. Plain English, British spellings. No emoji.

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

    const userMessage = `TODAY: ${today}\n\n--- TEXT ---\n${rawText.trim()}\n--- END ---\n\nReturn the JSON object.`;

    let res;
    try {
        res = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            },
            body: JSON.stringify({
                model: Q_CONFIG.model,
                max_tokens: 2000,
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

    raw = cleanModelOutput(raw, 'event-extractor').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

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
 * Vision shortcut — image dataUrl → extracted events/tasks. Pipes through
 * Q_CONFIG.visionModel (currently Kimi K2.5) and uses the same extractor
 * prompt format so the output shape matches `extractLifeAdmin`.
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
                max_tokens: 2000,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `TODAY: ${today}\n\nRead this image and extract everything date-shaped. Return the JSON object.` },
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

    raw = cleanModelOutput(raw, 'event-extractor').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

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
