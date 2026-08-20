'use strict';

/**
 * Q DESK — the three things Q could not see about his own work.
 *
 * From Q's own list of gaps, 20 Aug 2026. Each one is the same complaint in a
 * different place: he does the work, and then loses sight of it.
 *
 *   checkDrafts()      → which emails he wrote are STILL sitting unsent.
 *                        *"I drafted the Harrow Health email — if Sarah never
 *                        sends it, I have no way of knowing."*
 *   findContact()      → who actually deals with a thing, from her own past
 *                        emails and case files. *"I'm drafting to a generic
 *                        inbox and hoping."*
 *   readPageHistory()  → the full recent history of one page, on demand,
 *                        instead of only the truncated digest he gets injected.
 *
 * HONESTY RULES BAKED IN:
 *   · Every address returned was really seen somewhere, and the result says
 *     WHERE. Q never guesses an address, and an invented one could send a
 *     private letter to a stranger.
 *   · An empty result is returned as empty, with an instruction telling Q to
 *     say so rather than fill the gap from memory.
 *   · Nothing here writes anything. All three are read-only.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// How much conversation comes back around a search hit. A question and its
// answer are usually one or two turns apart, so a few either side catches the
// exchange without dragging half the day in with it.
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 4;
const MAX_THREADS = 5;

/** Today in the user's local day, not UTC — "today" has to mean today to them. */
function localDay(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(d);
    } catch (_) {
        return d.toISOString().slice(0, 10);
    }
}

/**
 * Turn `on` / `from` / `to` into a plain [start, end] pair of ISO strings.
 * Accepts a date ("2026-08-19"), a datetime ("2026-08-19T09:00"), or the two
 * words people actually say — "today" and "yesterday". Returns nulls when no
 * window was asked for, so the caller can skip filtering entirely.
 */
function resolveWindow(args = {}) {
    const asDate = (v) => {
        // Keep the ORIGINAL case. Lowercasing turned "2026-08-20T09:00" into
        // "...t09:00", and timestamps are compared as strings, so every window
        // with a time in it silently matched nothing. Only the keyword check
        // needs to be case-insensitive.
        const s = String(v || '').trim();
        if (!s) return null;
        const k = s.toLowerCase();
        if (k === 'today') return localDay(0);
        if (k === 'yesterday') return localDay(-1);
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
        return null;
    };

    const on = asDate(args.on);
    if (on) return { from: on.slice(0, 10) + 'T00:00', to: on.slice(0, 10) + 'T23:59:59', label: on.slice(0, 10) };

    const rawFrom = asDate(args.from);
    const rawTo = asDate(args.to);
    if (!rawFrom && !rawTo) return { from: null, to: null, label: null };

    // A bare date means the whole of that day at whichever end it sits.
    const from = rawFrom ? (rawFrom.length === 10 ? rawFrom + 'T00:00' : rawFrom) : null;
    const to = rawTo ? (rawTo.length === 10 ? rawTo + 'T23:59:59' : rawTo) : null;
    return { from, to, label: [from, to].filter(Boolean).map(x => x.replace('T', ' ')).join(' → ') };
}

// Addresses that are never a useful answer to "who do I contact".
const JUNK_ADDRESS = /^(no-?reply|do-?not-?reply|donotreply|bounce|mailer-daemon|postmaster|notifications?)@/i;

function tidyAddress(a) {
    return String(a || '').trim().replace(/[.,;:>)\]]+$/, '').toLowerCase();
}

function ageInDays(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
}

// ── 1. Drafts that never went ─────────────────────────────────────────────
/**
 * Anything still in the Outbox is, by definition, unsent — sending removes the
 * item (q-email-accounts.sendFromOutbox → removeFromOutbox). So the Outbox IS
 * the "not done yet" list, and Q can finally chase his own drafts.
 *
 * @param {{older_than_days?:number}} args
 * @param {string} ownerEmail
 */
function checkDrafts(args = {}, ownerEmail) {
    if (!ownerEmail) {
        return { error: 'no account', instruction_for_q: "You can't see their outbox right now. Say so plainly." };
    }

    let outbox = [];
    try {
        outbox = require('./q-email-accounts').getOutbox(ownerEmail) || [];
    } catch (e) {
        console.warn('[q-desk] outbox unreadable: ' + e.message);
        return { error: 'outbox unreadable', instruction_for_q: "You couldn't check the outbox just now. Say so — do NOT claim an email was or wasn't sent." };
    }

    const minAge = Number(args.older_than_days) || 0;

    const drafts = outbox.map(d => ({
        draft_id: d.id,
        to: d.to || null,
        subject: d.subject || '(no subject)',
        written: d.createdAt || null,
        days_waiting: ageInDays(d.createdAt),
        has_attachments: Array.isArray(d.attachments) && d.attachments.length > 0,
    })).filter(d => (d.days_waiting == null ? true : d.days_waiting >= minAge));

    drafts.sort((a, b) => (b.days_waiting ?? 0) - (a.days_waiting ?? 0));

    if (!drafts.length) {
        return {
            unsent: [],
            count: 0,
            instruction_for_q: 'Nothing is sitting unsent — every draft you wrote has been sent or cleared. Say that in one line. Do NOT invent a pending email.',
        };
    }

    console.log(`[q-desk] ${drafts.length} unsent draft(s) for ${ownerEmail}`);

    return {
        unsent: drafts.slice(0, 20),
        count: drafts.length,
        instruction_for_q:
            'These emails you drafted are STILL UNSENT — they are sitting in the Outbox waiting for her. '
            + 'Raise the oldest one, by subject, and say how long it has been waiting. Offer to send it now. '
            + 'One is a nudge, a list is a telling-off — mention how many others there are in a short clause, do not enumerate them. '
            + 'You cannot send it yourself without her saying so.',
    };
}

// ── 2. Who actually deals with this ───────────────────────────────────────
/**
 * Search what she has ALREADY got — past drafts and saved case files — for a
 * real address connected to a name or an organisation. This never invents an
 * address and never guesses a format like firstname.lastname@.
 *
 * @param {{who:string}} args
 * @param {string} ownerEmail
 */
async function findContact(args = {}, ownerEmail) {
    const who = String(args.who || '').trim();
    if (!who) {
        return { error: 'no name given', instruction_for_q: 'Ask WHO or which organisation they mean.' };
    }
    if (!ownerEmail) {
        return { error: 'no account', instruction_for_q: "You can't search their records right now. Say so plainly." };
    }

    const needle = who.toLowerCase();
    const words = needle.split(/\s+/).filter(w => w.length > 2);
    const hits = new Map();       // address → { address, where[], context }

    const record = (address, where, context) => {
        const a = tidyAddress(address);
        if (!a || JUNK_ADDRESS.test(a)) return;
        if (!hits.has(a)) hits.set(a, { address: a, where: [], context: '' });
        const h = hits.get(a);
        if (!h.where.includes(where)) h.where.push(where);
        if (!h.context && context) h.context = String(context).slice(0, 140);
    };

    // Does this blob mention who we're looking for?
    const mentions = (text) => {
        const t = String(text || '').toLowerCase();
        if (!t) return false;
        if (t.includes(needle)) return true;
        return words.length > 0 && words.every(w => t.includes(w));
    };

    // (a) Past drafts — she has written to them before.
    try {
        const outbox = require('./q-email-accounts').getOutbox(ownerEmail) || [];
        for (const d of outbox) {
            const blob = `${d.to || ''} ${d.subject || ''} ${d.body || ''}`;
            if (!mentions(blob)) continue;
            if (d.to) record(d.to, 'an email you drafted before', d.subject);
            for (const m of (String(d.body || '').match(EMAIL_RE) || [])) record(m, 'the body of a draft you wrote', d.subject);
        }
    } catch (e) {
        console.warn('[q-desk] outbox scan failed: ' + e.message);
    }

    // (b) Case files — emails and notes filed onto a thread.
    try {
        const qThreads = require('./q-threads');
        const threads = qThreads.listThreads(ownerEmail) || [];
        for (const t of threads.slice(0, 40)) {
            let full = null;
            try { full = qThreads.readThread(t.id ?? t, ownerEmail); } catch (_) { continue; }
            if (!full) continue;
            const blob = JSON.stringify(full);
            if (!mentions(blob)) continue;
            const title = full.title || t.title || 'a saved case';
            for (const m of (blob.match(EMAIL_RE) || [])) record(m, `the "${title}" case file`, title);
        }
    } catch (e) {
        console.warn('[q-desk] thread scan failed: ' + e.message);
    }

    // (c) Recent inbox — they may have written to her.
    try {
        const acc = require('./q-email-accounts');
        const inbox = await acc.listInbox(ownerEmail, { limit: 40 });
        for (const m of (inbox || [])) {
            const blob = `${m.from || ''} ${m.subject || ''} ${m.snippet || ''}`;
            if (!mentions(blob)) continue;
            for (const a of (String(m.from || '').match(EMAIL_RE) || [])) record(a, 'an email they sent you', m.subject);
        }
    } catch (_) {
        // No connected inbox, or it refused. Not an error — the other two
        // sources still answer, and we must not fail the whole lookup for it.
    }

    const found = [...hits.values()];

    if (!found.length) {
        console.log(`[q-desk] no contact found for "${who}"`);
        return {
            searched_for: who,
            contacts: [],
            count: 0,
            instruction_for_q:
                `You have NO real address for "${who}" anywhere in their drafts, case files or recent inbox. `
                + 'Say exactly that. Do NOT invent an address, do NOT guess a format like firstname.lastname@, '
                + 'and do NOT quietly draft to a general enquiries inbox as if it were the right person. '
                + 'Ask them who it should go to, or offer to look the organisation up on the web.',
        };
    }

    console.log(`[q-desk] ${found.length} address(es) for "${who}"`);

    return {
        searched_for: who,
        contacts: found.slice(0, 8),
        count: found.length,
        instruction_for_q:
            'Every address here was really found in their own records, and "where" says exactly where. '
            + 'Say which one you would use and why it is the one. If more than one looks plausible, ASK — '
            + 'sending a private letter to the wrong address cannot be undone. Never use an address that is not in this list.',
    };
}

// ── 3. What was said on another page ──────────────────────────────────────
/**
 * The injected cross-page digest is a summary and gets truncated. This pulls
 * the real recent history of one page when Q needs the detail.
 *
 * @param {{page:string, limit?:number}} args
 * @param {string|number} personId
 */
function readPageHistory(args = {}, personId) {
    if (!personId) {
        return { error: 'no account', instruction_for_q: "You can't read back their other pages right now. Say so plainly." };
    }

    // `page` is OPTIONAL on purpose (fixed 20 Aug 2026). It used to be required,
    // which made the tool useless in the exact situation it exists for: Q told
    // Sarah he had never given her advice about her kitchen tap, she pasted his
    // own words back, and he could not go and look because he did not know WHICH
    // page it had been on. Nobody asking "do you remember my tap?" knows that
    // either. With no page given we search everything.
    const page = String(args.page || '').trim().toLowerCase();
    const search = String(args.search || '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 60);

    // WHEN, as well as WHAT (20 Aug 2026 — Sarah asked whether he could search
    // by date as well as by word). Plenty of what people ask has no keyword in
    // it at all: "what did we talk about this morning" gives you nothing to
    // search FOR, only a when. `on` covers a whole day; from/to take a date or
    // a full datetime, so "this morning" is just from 00:00 to 12:00.
    const when = resolveWindow(args);

    let all = [];
    try {
        all = require('../memory').loadMemory(personId) || [];
    } catch (e) {
        console.warn('[q-desk] memory unreadable: ' + e.message);
        return { error: 'history unreadable', instruction_for_q: "You couldn't read their history. Say so — do NOT reconstruct it from memory." };
    }

    const pagesThatExist = [...new Set(all.map(m => m.surface).filter(Boolean))];

    let rows = page
        ? all.filter(m => String(m.surface || '').toLowerCase() === page)
        : all;

    // Narrow to the asked-for window before anything else, so a search inside a
    // day searches that day and a bare date returns the day itself.
    if (when.from || when.to) {
        rows = rows.filter(m => {
            const t = String(m.timestamp || '');
            if (!t) return false;
            if (when.from && t < when.from) return false;
            if (when.to && t > when.to) return false;
            return true;
        });
        if (!rows.length) {
            return {
                page: page || 'all pages',
                window: when.label,
                searched_for: search || null,
                messages: [], count: 0, pages_that_do_exist: pagesThatExist,
                instruction_for_q: `Nothing is saved from ${when.label}${page ? ' on the ' + page + ' page' : ''}. Say plainly that you looked and there is nothing recorded for then — do NOT deny the conversation happened, and offer to look on a different day or search for a word instead.`,
            };
        }
    }

    if (page && !rows.length) {
        return {
            page, messages: [], count: 0, pages_that_do_exist: pagesThatExist,
            instruction_for_q: `There is no history on a page called "${page}". Tell them, and say which pages you CAN see. Do not invent a conversation.`,
        };
    }

    // Searching beats recency: the thing they are asking about is usually old,
    // which is precisely why it fell out of the window Q gets shown.
    //
    // AND A HIT COMES BACK WITH ITS CONVERSATION, not on its own (Sarah, 20 Aug:
    // "that would show the thread"). Searching "tap" matches the line where she
    // said the word — which is usually HER question, not his answer, because his
    // answer talks about aerators and limescale. A lone matching line is a
    // fragment; he needs the exchange around it to actually know what was said.
    let threads = null;
    if (search) {
        const words = search.split(/\s+/).filter(w => w.length > 2);
        const isHit = (m) => {
            const t = String(m.content || '').toLowerCase();
            return t.includes(search) || (words.length > 0 && words.every(w => t.includes(w)));
        };

        const hitIdx = [];
        rows.forEach((m, i) => { if (isHit(m)) hitIdx.push(i); });

        if (hitIdx.length) {
            // Widen each hit into a window, then merge windows that touch so one
            // back-and-forth comes back as ONE thread instead of three fragments.
            const spans = [];
            for (const i of hitIdx) {
                const from = Math.max(0, i - CONTEXT_BEFORE);
                const to = Math.min(rows.length - 1, i + CONTEXT_AFTER);
                const last = spans[spans.length - 1];
                if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
                else spans.push({ from, to });
            }
            threads = spans.slice(0, MAX_THREADS).map(s => rows.slice(s.from, s.to + 1));
        }
        rows = hitIdx.map(i => rows[i]);
    }

    if (!rows.length) {
        return {
            page: page || 'all pages',
            searched_for: search || null,
            messages: [], count: 0, pages_that_do_exist: pagesThatExist,
            instruction_for_q: search
                ? `Nothing in ANY of their saved history mentions "${search}". Say plainly that you have looked and cannot find it — do NOT flatly deny it happened, because history older than the window is trimmed. Ask them roughly when it was, or to paste it.`
                : 'There is no saved history to read. Say so plainly.',
        };
    }

    const asLine = (m) => ({
        when: m.timestamp ? String(m.timestamp).slice(0, 16).replace('T', ' ') : null,
        page: m.surface || null,
        who: m.role === 'user' ? 'them' : 'you',
        said: String(m.content || '').slice(0, 1200),
    });

    // A search hands back conversations; a plain read hands back the recent tail.
    if (search && threads) {
        const conversations = threads.map(t => ({
            page: t[0].surface || null,
            when: t[0].timestamp ? String(t[0].timestamp).slice(0, 16).replace('T', ' ') : null,
            messages: t.map(asLine),
        }));
        const shown = conversations.reduce((n, c) => n + c.messages.length, 0);

        console.log(`[q-desk] history: ${rows.length} hit(s) → ${conversations.length} conversation(s), ${shown} message(s), for "${search}"`);

        return {
            searched_for: search,
            page: page || 'all pages',
            conversations,
            matches: rows.length,
            count: shown,
            pages_that_do_exist: pagesThatExist,
            instruction_for_q:
                'You WENT AND LOOKED, and this is what was really said — each conversation shows the exchange around the match, with the page and the date. '
                + 'Answer from it and say plainly that you found it. If one of these is you saying something you had just denied saying, own it in one line and move on: '
                + 'you are only ever shown the recent part of a conversation, and you have now been back through the record. '
                + 'Quote only what is actually written here — do not smooth it into what you think you would have said.',
        };
    }

    // A date window with no search word: give the START of that period, not the
    // end. "What did we talk about this morning" wants the morning from the
    // beginning; the tail is the bit they can already see.
    const messages = (when.from || when.to) ? rows.slice(0, limit).map(asLine) : rows.slice(-limit).map(asLine);

    console.log(`[q-desk] history: ${messages.length} message(s)${page ? ' from ' + page : ' across all pages'}${when.label ? ' within ' + when.label : ''}`);

    return {
        page: page || 'all pages',
        window: when.label,
        searched_for: search || null,
        messages,
        count: messages.length,
        total_on_page: rows.length,
        pages_that_do_exist: pagesThatExist,
        instruction_for_q:
            'This is their REAL saved history — each entry says which page and when. Use it to answer and say plainly that you went and looked. '
            + 'Quote only what is actually written above.',
    };
}

module.exports = { checkDrafts, findContact, readPageHistory };
