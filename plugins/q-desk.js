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

    const page = String(args.page || '').trim().toLowerCase();
    if (!page) {
        return { error: 'no page given', instruction_for_q: 'Ask WHICH page they mean — chat, writer, life, finance, email.' };
    }

    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 60);

    let all = [];
    try {
        all = require('../memory').loadMemory(personId) || [];
    } catch (e) {
        console.warn('[q-desk] memory unreadable: ' + e.message);
        return { error: 'history unreadable', instruction_for_q: "You couldn't read that page's history. Say so — do NOT reconstruct it from memory." };
    }

    const onPage = all.filter(m => String(m.surface || '').toLowerCase() === page);

    if (!onPage.length) {
        const pages = [...new Set(all.map(m => m.surface).filter(Boolean))];
        return {
            page,
            messages: [],
            count: 0,
            pages_that_do_exist: pages,
            instruction_for_q: `There is no history on a page called "${page}". Tell them, and say which pages you CAN see (in pages_that_do_exist). Do not invent a conversation.`,
        };
    }

    const messages = onPage.slice(-limit).map(m => ({
        when: m.timestamp ? String(m.timestamp).slice(0, 16).replace('T', ' ') : null,
        who: m.role === 'user' ? 'them' : 'you',
        said: String(m.content || '').slice(0, 1200),
    }));

    console.log(`[q-desk] read ${messages.length} message(s) from the ${page} page`);

    return {
        page,
        messages,
        count: messages.length,
        total_on_page: onPage.length,
        instruction_for_q:
            'This is the real history from that page. Use it to answer, and say plainly that you looked it up. '
            + 'Do not carry on that page\'s conversation here — refer to it. Quote only what is actually written above.',
    };
}

module.exports = { checkDrafts, findContact, readPageHistory };
