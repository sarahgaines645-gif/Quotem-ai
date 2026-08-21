'use strict';

/**
 * Q TRIP BOARD — the holidays you have actually found, kept.
 *
 * /trips could tell you where was warm and then forgot it the moment you
 * reloaded. This is the other half: a board of real holidays — the ones you
 * found on somebody's website at eleven at night — with what they cost, who
 * is selling them, what is good and bad about each, and what everyone you are
 * going with has said about them.
 *
 * THREE WAYS A HOLIDAY GETS ON THE BOARD
 *   'screenshot' — you screenshot a listing and drop it on the page. readShot()
 *                  puts a vision model on it and fills the card in.
 *   'search'     — you keep one of the destinations the climate search found.
 *   'manual'     — you type it in.
 *
 * ⚠️ NOTHING HERE INVENTS A PRICE. A field the screenshot did not actually
 * show comes back null and the card renders nothing for it — never a plausible
 * number, never "from £599". A made-up price on a holiday card is a lie that
 * costs someone a booking, and Sarah's rule on this is absolute. The vision
 * prompt says so four different ways because vision models love to fill a gap.
 *
 * STORAGE — per user, via user-data.js, exactly like every other store here:
 *   userDataPath(owner, 'trips/board.json')
 * so one person's board is physically unable to read another's.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not fetch the page behind the screenshot. The screenshot is what
 *   she saw; the link is kept so she can go back to it herself. Fetching would
 *   mean this server visiting arbitrary URLs on her behalf, and whatever that
 *   page shows hours later is not the deal she was looking at anyway.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataPath } = require('./user-data');
const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');
const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');

const MAX_ON_BOARD = 60;

// ─────────────────────────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────────────────────────

function boardFile(owner) { return userDataPath(owner, 'trips/board.json'); }

function readBoard(owner) {
    try {
        const raw = fs.readFileSync(boardFile(owner), 'utf8');
        const j = JSON.parse(raw);
        return Array.isArray(j) ? j : [];
    } catch { return []; }
}

function writeBoard(owner, list) {
    const file = boardFile(owner);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename. A half-written board reads as corrupt JSON and comes
    // back as an empty board, which looks exactly like "everything I saved is
    // gone" to the person it happened to.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
    return list;
}

// ─────────────────────────────────────────────────────────────
//  THE SHAPE OF A HOLIDAY
// ─────────────────────────────────────────────────────────────

const S = (v, n) => {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, n) : '';
};
/**
 * A number, or null. Never a default — a missing price is not £0.
 *
 * ⚠️ Strip the currency symbols and commas FIRST, then insist on having seen
 * an actual digit. Without that last check "not a number" strips to "" and
 * Number("") is 0 — so a card's price silently became £0, which reads on the
 * screen as a free holiday.
 */
const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const cleaned = String(v).replace(/[^0-9.\-]/g, '');
    if (!/[0-9]/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
};
/** A real YYYY-MM-DD, or null. Anything else is not a date. */
const isoOrNull = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    // Rejects 2026-02-31 and friends, which JS would otherwise roll forward.
    return (d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) ? m[0] : null;
};
const listOf = (v, n, len) => Array.isArray(v)
    ? v.slice(0, n).map(x => S(x, len)).filter(Boolean)
    : [];

/**
 * PATCHING MUST NOT DESTROY WHAT IT CANNOT PARSE.
 *
 * A PATCH carrying startDate "2026-02-31" used to null the perfectly good date
 * already on the card. Three different meanings have to stay separate:
 *   field absent          -> leave it exactly as it was
 *   field null or ''      -> she is clearing it on purpose
 *   field present, unparseable -> keep the old value. Garbage arriving from a
 *                            half-typed box is not an instruction to forget.
 */
function keepUnless(incoming, previous, parse) {
    if (incoming === undefined) return previous ?? null;
    if (incoming === null || incoming === '') return null;     // cleared on purpose
    const parsed = parse(incoming);
    return parsed === null ? (previous ?? null) : parsed;
}

const SOURCES = new Set(['screenshot', 'search', 'manual']);

/**
 * Normalise on the way in AND on the way out, so a record written by an older
 * version of this file still reads correctly.
 */
function normalise(h, existing) {
    const now = new Date().toISOString();
    const prev = existing || {};
    return {
        id: prev.id || crypto.randomBytes(8).toString('hex'),

        title: S(h.title, 140) || prev.title || 'Untitled',
        place: S(h.place, 120) || prev.place || '',
        country: S(h.country, 80) || prev.country || '',

        // Money. null means "the listing did not say", and the card shows
        // nothing rather than a zero.
        price: keepUnless(h.price, prev.price, numOrNull),
        currency: S(h.currency, 8) || prev.currency || '',
        priceBasis: S(h.priceBasis, 80) || prev.priceBasis || '',   // "per person", "total for 4"

        // `dates` is what the listing PRINTED, kept verbatim. startDate/endDate
        // are real dates and only ever get set because she set them — nothing
        // reaches her calendar off the back of a guess at "5-12 Oct".
        dates: S(h.dates, 120) || prev.dates || '',
        startDate: keepUnless(h.startDate, prev.startDate, isoOrNull),
        endDate: keepUnless(h.endDate, prev.endDate, isoOrNull),
        calendarEventId: S(h.calendarEventId, 40) || prev.calendarEventId || '',
        nights: keepUnless(h.nights, prev.nights, numOrNull),
        boardBasis: S(h.boardBasis, 60) || prev.boardBasis || '',   // "all inclusive"

        company: S(h.company, 100) || prev.company || '',
        companyDomain: S(h.companyDomain, 120) || prev.companyDomain || '',
        logo: S(h.logo, 400) || prev.logo || '',

        link: /^https?:\/\//i.test(String(h.link || '')) ? S(h.link, 800) : (prev.link || ''),
        image: S(h.image, 400) || prev.image || '',          // a stored screenshot id
        rating: keepUnless(h.rating, prev.rating, numOrNull),
        reviewCount: keepUnless(h.reviewCount, prev.reviewCount, numOrNull),

        pros: h.pros !== undefined ? listOf(h.pros, 8, 160) : (prev.pros || []),
        cons: h.cons !== undefined ? listOf(h.cons, 8, 160) : (prev.cons || []),
        notes: h.notes !== undefined ? S(h.notes, 2000) : (prev.notes || ''),

        source: SOURCES.has(h.source) ? h.source : (prev.source || 'manual'),
        foundAt: prev.foundAt || S(h.foundAt, 40) || now,
        updatedAt: now,

        // Set when this holiday goes out on a linkmail, so the replies can be
        // read back onto this exact card.
        linkmailToken: S(h.linkmailToken, 64) || prev.linkmailToken || '',
    };
}

// ─────────────────────────────────────────────────────────────
//  THE BOARD
// ─────────────────────────────────────────────────────────────

function list(owner) {
    if (!owner) return [];
    return readBoard(owner).map(h => normalise(h, h));
}

function get(id, owner) {
    return list(owner).find(h => h.id === id) || null;
}

function save(holiday, owner) {
    if (!owner) throw new Error('owner required');
    const board = readBoard(owner);
    if (board.length >= MAX_ON_BOARD) {
        throw new Error(`The board holds ${MAX_ON_BOARD} holidays. Take one off before adding another.`);
    }
    const rec = normalise(holiday || {});
    board.unshift(rec);
    writeBoard(owner, board);
    return rec;
}

function update(id, patch, owner) {
    if (!owner) throw new Error('owner required');
    const board = readBoard(owner);
    const i = board.findIndex(h => h.id === id);
    if (i === -1) return null;
    board[i] = normalise({ ...patch, id }, board[i]);
    board[i].id = id;
    writeBoard(owner, board);
    return board[i];
}

function remove(id, owner) {
    if (!owner) throw new Error('owner required');
    const board = readBoard(owner);
    const next = board.filter(h => h.id !== id);
    if (next.length === board.length) return false;
    writeBoard(owner, next);
    return true;
}

// ─────────────────────────────────────────────────────────────
//  READING A SCREENSHOT
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️ THIS PROMPT IS LOAD-BEARING. A vision model asked for a price will
 * produce one whether or not the picture contains one — and "from £599 pp"
 * on a card she then sends to her family is a straight lie. Every instruction
 * below that looks repetitive is there because the failure it prevents is
 * worse than the repetition.
 */
const SHOT_PROMPT = `You are reading a screenshot of a holiday or hotel listing that someone has taken from a travel website.

Return ONLY a JSON object, no prose, no markdown fence, in exactly this shape:

{
  "title": "the name of the hotel, resort or package as printed",
  "place": "the resort, town or area",
  "country": "the country",
  "price": 649,
  "currency": "GBP",
  "priceBasis": "per person | total | per night — copy how the page words it",
  "dates": "the dates or departure date as printed",
  "nights": 7,
  "boardBasis": "all inclusive | half board | room only | self catering",
  "company": "the travel company or website selling it",
  "companyDomain": "their web domain if it is visible, e.g. jet2holidays.com",
  "rating": 4.5,
  "reviewCount": 1284,
  "pros": ["short factual points in favour, taken from what the page shows"],
  "cons": ["short factual points against, taken from what the page shows"]
}

RULES ABOUT WHAT YOU MAY WRITE — these matter more than completeness:

1. EVERY value must be something you can actually SEE in this image. If the
   image does not show it, the value is null. Not a guess, not a typical value,
   not an average, not an inference from the brand. null.
2. NEVER invent a price. If no price is visible, "price" is null and
   "currency" is null. A wrong price on this card costs someone real money.
3. Copy numbers digit for digit. Do not round £1,349 to £1,350, do not convert
   currencies, do not turn "per person" into a total or a total into per person.
4. "pros" and "cons" must come from what the listing itself shows — a pool, the
   distance to the beach, "no airport transfer included", a low review score.
   Do not write general travel advice. Do not write anything you cannot point
   at in the picture. If there is nothing to say, return an empty array.
5. If the image is not a holiday listing at all, return
   {"notAListing": true, "sawInstead": "one short line saying what it is"}.

Return the JSON and nothing else.`;

/**
 * readShot(dataUrl) → the fields above, with null wherever the picture was
 * silent. Never throws for a bad read; returns { error } so the page can say
 * so plainly and let her type it in instead.
 */
async function readShot(dataUrl, owner) {
    if (!Q_CONFIG.apiKey) return { error: 'The screenshot reader is not configured on this server.' };
    if (!dataUrl || typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) {
        return { error: 'That did not arrive as an image.' };
    }

    const started = Date.now();
    let data;
    try {
        const res = await timedFetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: Q_CONFIG.visionModel,
                max_tokens: 1200,
                temperature: 0.0,          // reading, not composing
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: dataUrl } },
                        { type: 'text', text: SHOT_PROMPT },
                    ],
                }],
            }),
        }, { label: 'holiday screenshot' });

        if (!res.ok) {
            logUsage({ skill: 'trip-screenshot', provider: 'together', model: Q_CONFIG.visionModel, started, user: owner, success: false, error: `HTTP ${res.status}` });
            return { error: `Could not read that screenshot (${res.status}).` };
        }
        data = await res.json();
        logUsage({ skill: 'trip-screenshot', provider: 'together', model: Q_CONFIG.visionModel, data, started, user: owner });
    } catch (e) {
        logUsage({ skill: 'trip-screenshot', provider: 'together', model: Q_CONFIG.visionModel, started, user: owner, success: false, error: e.message });
        return { error: 'Could not reach the screenshot reader just now.' };
    }

    const msg = data.choices?.[0]?.message || {};
    // Thinking-mode quirk on Together: the answer sometimes lands in
    // reasoning_content with content empty. Same fallback as q-tools.js:1965.
    const raw = (msg.content && msg.content.trim())
        ? msg.content
        : (msg.reasoning_content || msg.reasoning || '');
    const text = cleanModelOutput(raw, 'trip-screenshot');

    const parsed = parseJson(text);
    if (!parsed) return { error: 'That screenshot did not read as a holiday listing.' };
    if (parsed.notAListing) {
        return { notAListing: true, sawInstead: S(parsed.sawInstead, 200) };
    }

    return {
        title: S(parsed.title, 140),
        place: S(parsed.place, 120),
        country: S(parsed.country, 80),
        price: numOrNull(parsed.price),
        currency: S(parsed.currency, 8),
        priceBasis: S(parsed.priceBasis, 80),
        dates: S(parsed.dates, 120),
        nights: numOrNull(parsed.nights),
        boardBasis: S(parsed.boardBasis, 60),
        company: S(parsed.company, 100),
        companyDomain: S(parsed.companyDomain, 120),
        rating: numOrNull(parsed.rating),
        reviewCount: numOrNull(parsed.reviewCount),
        pros: listOf(parsed.pros, 8, 160),
        cons: listOf(parsed.cons, 8, 160),
        source: 'screenshot',
    };
}

/** Models fence their JSON about half the time, and sometimes chat around it. */
function parseJson(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch { /* fall through */ }
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a !== -1 && b > a) {
        try { return JSON.parse(cleaned.slice(a, b + 1)); } catch { /* give up */ }
    }
    return null;
}


// ─────────────────────────────────────────────────────────────
//  READING THE PRINTED DATES
// ─────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * suggestDates("5-12 Oct 2026") -> { start: '2026-10-05', end: '2026-10-12' }
 *
 * ⚠️ A SUGGESTION, AND ONLY EVER A SUGGESTION. It goes into the two date boxes
 * on the card where she can see it and change it. Nothing is written to her
 * calendar until she presses the button, because a holiday marked on the wrong
 * week is worse than no holiday marked at all. Returns null the moment it is
 * not certain — an ambiguous string is not a date.
 */
function suggestDates(text, nights) {
    const t = String(text || '').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
    if (!t.trim()) return null;

    const monthNum = (name) => {
        const i = MONTHS.indexOf(String(name).slice(0, 3));
        return i === -1 ? null : i + 1;
    };
    const pad = (n) => String(n).padStart(2, '0');
    const make = (y, m, d) => isoOrNull(`${y}-${pad(m)}-${pad(d)}`);

    // "5-12 oct 2026" / "5 - 12 october 2026"
    let m = /\b(\d{1,2})\s*[-–to]+\s*(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})\b/.exec(t);
    if (m) {
        const mo = monthNum(m[3]);
        if (mo) {
            const start = make(m[4], mo, m[1]), end = make(m[4], mo, m[2]);
            if (start && end && end > start) return { start, end };
        }
    }

    // "5 oct 2026 - 12 oct 2026", including across a month or year boundary
    m = /\b(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})\s*[-–to]+\s*(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})\b/.exec(t);
    if (m) {
        const a = monthNum(m[2]), b = monthNum(m[5]);
        if (a && b) {
            const start = make(m[3], a, m[1]), end = make(m[6], b, m[4]);
            if (start && end && end > start) return { start, end };
        }
    }

    // A single departure date, with the length of stay to close it.
    m = /\b(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})\b/.exec(t);
    if (m) {
        const mo = monthNum(m[2]);
        const n = numOrNull(nights);
        if (mo) {
            const start = make(m[3], mo, m[1]);
            if (start && n && n > 0 && n < 60) {
                const d = new Date(start + 'T00:00:00Z');
                d.setUTCDate(d.getUTCDate() + n);
                return { start, end: d.toISOString().slice(0, 10) };
            }
            if (start) return { start, end: null };
        }
    }

    // ISO, as a travel site sometimes prints it.
    m = /\b(\d{4}-\d{2}-\d{2})\b[^\d]{1,6}\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
    if (m) {
        const start = isoOrNull(m[1]), end = isoOrNull(m[2]);
        if (start && end && end > start) return { start, end };
    }

    return null;
}

module.exports = {
    list, get, save, update, remove,
    readShot,
    suggestDates,
    normalise,
    MAX_ON_BOARD,
};
