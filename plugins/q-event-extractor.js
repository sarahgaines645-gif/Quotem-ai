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

const SYSTEM_PROMPT = `You are a personal-admin assistant. The user gives you TEXT (from a school letter, email, message, photo OCR, bank statement, newsletter, or similar). Your job is to read THAT TEXT and pull out two arrays: the events that are happening, and the tasks the user must do for them.

Return ONE JSON object. No markdown, no prose, no code fences. Just the object:
{
  "events": [ ... ],
  "tasks":  [ ... ]
}

═══════════════════════════════════════════
STEP 1 — EXTRACT EVENTS FIRST. ALWAYS.
═══════════════════════════════════════════
Before you think about tasks at all, scan the TEXT for things that HAPPEN on a date. The default for ANY dated item is EVENT. Only after the events array is filled do you decide if there's also a TASK to add.

An EVENT is something that happens on a date — the user (or someone they care about) attends, is there for it, participates in it. It exists on that date whether the user prepares for it or not.
  ✓ "School trip to the Tate, Thursday 19 June" → EVENT
  ✓ "Parents' evening, Wed 22 May, 4–7pm" → EVENT
  ✓ "Dentist appointment, 14:30 on the 12th" → EVENT
  ✓ "Trumpet exam on the 22nd" → EVENT
  ✓ "Mum's birthday party, Saturday" → EVENT
  ✓ "Bin day Tuesday" → EVENT (it happens whether you act or not)
  ✓ "Half term, 27 May – 31 May" → EVENT (use the start date)

A TASK is an action the USER has to DO. The title starts with (or implies) an action verb: buy, return, pay, book, send, call, fill in, reply, sign.
  ✓ "Buy PE kit before Thursday" → TASK
  ✓ "Return permission slip by Wednesday" → TASK
  ✓ "Pay £8 trip fee by 14 June" → TASK
  ✓ "Sign up for parents' evening slot at school-cloud.co.uk/abc" → TASK

NEVER put an event into the tasks array because it "needs to be remembered" — attending is not a task. If something has a date and is happening, it goes in events. End of decision.

ONE source item often produces BOTH. A parents' evening letter typically gives you:
  • EVENT: "Parents' evening" on the evening date, notes = booking link + time window
  • TASK: "Sign up for parents' evening slot" with due date = sign-up deadline, notes = booking link, prepFor = "Parents' evening"

═══════════════════════════════════════════
STEP 2 — CAPTURE THE DETAIL THAT MAKES IT USEFUL
═══════════════════════════════════════════
Put into \`notes\` anything the user will need to actually act on this when they look at it later. Especially:
  • URLs — booking links, sign-up forms, payment pages, video-call links, Teams/Zoom IDs
  • Reference numbers — booking refs, case numbers, ticket IDs, order numbers
  • Costs — "£8 trip fee", "£25 deposit"
  • Required items — "bring a packed lunch", "wear PE kit", "labelled water bottle"
  • Contact details — phone numbers, email addresses to reply to
  • Sign-up windows — "book between 8 May and 18 May"
  • Address details when they aren't in the location field
A parents' evening with a booking URL: the URL goes in the EVENT's notes AND in the related TASK's notes, so wherever the user looks they can act.

═══════════════════════════════════════════
STEP 3 — AUTO-CATEGORISE (only if CATEGORIES is provided)
═══════════════════════════════════════════
If a CATEGORIES list is provided below, set \`category\` on every event and task to the slug that fits best. Pattern hints:
  • Anything about the user's child / school / school trip / school activity → "kids"
  • Bill, invoice, payment, statement, fee → "money"
  • GP, dentist, hospital, blood test, prescription, vaccination → "health"
  • Meeting, work event, conference, work deadline → "work"
  • Bin day, plumber, delivery, household repair, mortgage admin → "home"
If the categories list contains slugs other than those, use those when they fit better.
If no good fit, leave category as null — the user will pick it from a dropdown.

═══════════════════════════════════════════
FIELDS
═══════════════════════════════════════════
EVENT: title (string), date (YYYY-MM-DD, required), time (HH:MM 24h or null), location (string or null), notes (string or null), category (slug from CATEGORIES, or null)
TASK:  title (string, imperative), due (YYYY-MM-DD or null), priority ("low"|"med"|"high"), notes (string or null), prepFor (exact event title or null), category (slug from CATEGORIES, or null)

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
    const categories = Array.isArray(opts.categories) ? opts.categories : [];
    const validCategorySlugs = new Set(categories.map(c => c?.slug).filter(Boolean));

    const contextBlock = context ? `\n\nABOUT ME:\n${context}\n` : '';
    const categoriesBlock = categories.length > 0
        ? `\n\nCATEGORIES (pick by slug):\n${categories.map(c => `- ${c.slug} — ${c.name}`).join('\n')}\n`
        : '';
    const userMessage = `TODAY: ${today}${categoriesBlock}${contextBlock}\n\n--- TEXT ---\n${rawText.trim()}\n--- END ---\n\nThink it through, then return the JSON object.`;

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

    const normCategory = (raw) => {
        if (!raw) return null;
        const s = String(raw).trim().toLowerCase();
        return validCategorySlugs.has(s) ? s : null;
    };

    const normEvent = (e) => ({
        title:    String(e?.title || '').trim(),
        date:     String(e?.date || '').slice(0, 10),
        time:     e?.time && /^\d{1,2}:\d{2}$/.test(String(e.time)) ? String(e.time) : null,
        location: e?.location ? String(e.location).trim() : null,
        notes:    e?.notes ? String(e.notes).trim() : null,
        category: normCategory(e?.category),
        source,
    });

    const normTask = (t) => ({
        title:    String(t?.title || '').trim(),
        due:      t?.due ? String(t.due).slice(0, 10) : null,
        priority: ['low','med','high'].includes(t?.priority) ? t.priority : 'med',
        notes:    t?.notes ? String(t.notes).trim() : null,
        prepFor:  t?.prepFor ? String(t.prepFor).trim().slice(0, 200) : null,
        category: normCategory(t?.category),
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
    const categories = Array.isArray(opts.categories) ? opts.categories : [];
    const validCategorySlugs = new Set(categories.map(c => c?.slug).filter(Boolean));
    const contextBlock = context ? `\n\nABOUT ME:\n${context}\n` : '';
    const categoriesBlock = categories.length > 0
        ? `\n\nCATEGORIES (pick by slug):\n${categories.map(c => `- ${c.slug} — ${c.name}`).join('\n')}\n`
        : '';

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
                            { type: 'text', text: `TODAY: ${today}${categoriesBlock}${contextBlock}\n\nRead this image. Extract events that are HAPPENING (default for anything dated) into the events array. Extract action-verb tasks the user must do into the tasks array. Capture URLs, costs, reference numbers, and "bring X" details into notes. Auto-categorise using the slugs above. Then return the JSON object.` },
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

    const normCategory = (raw) => {
        if (!raw) return null;
        const s = String(raw).trim().toLowerCase();
        return validCategorySlugs.has(s) ? s : null;
    };

    return {
        events: events.filter(e => e?.title && e?.date).map(e => ({
            title: String(e.title).trim(),
            date: String(e.date).slice(0, 10),
            time: e.time && /^\d{1,2}:\d{2}$/.test(String(e.time)) ? String(e.time) : null,
            location: e.location ? String(e.location).trim() : null,
            notes: e.notes ? String(e.notes).trim() : null,
            category: normCategory(e.category),
            source,
        })),
        tasks: tasks.filter(t => t?.title).map(t => ({
            title: String(t.title).trim(),
            due: t.due ? String(t.due).slice(0, 10) : null,
            priority: ['low','med','high'].includes(t.priority) ? t.priority : 'med',
            notes: t.notes ? String(t.notes).trim() : null,
            prepFor: t.prepFor ? String(t.prepFor).trim().slice(0, 200) : null,
            category: normCategory(t.category),
            source,
        })),
    };
}

module.exports = { extractLifeAdmin, extractFromImage };
