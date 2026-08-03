'use strict';

/**
 * Q TRAVEL — live hotel prices, flight prices, and route day-of-week schedules.
 *
 * Three capabilities, one plugin, one key:
 *   searchHotels()   → live availability + price for a destination or a named
 *                      hotel, for real dates and a real room configuration.
 *   searchFlights()  → live flight prices between two airports on a date.
 *                      The supplier sits behind a tiny adapter (FLIGHT_ADAPTERS)
 *                      so it can be swapped without touching the tool.
 *   flightSchedule() → which airlines fly a route and ON WHICH DAYS OF THE WEEK.
 *                      This is the one that saves a trip: a route that only runs
 *                      Tuesdays and Saturdays looks perfectly bookable right up
 *                      until you try to come home.
 *
 * KEYS — environment only, never hardcoded, never logged, never returned:
 *   RAPIDAPI_KEY              (required — the one key all three suppliers use)
 *   RAPIDAPI_HOTELS_HOST      (optional override, default booking-com15.p.rapidapi.com)
 *   RAPIDAPI_FLIGHTS_HOST     (optional override, only used when provider=skyscanner)
 *   RAPIDAPI_SCHEDULE_HOST    (optional override, default aerodatabox.p.rapidapi.com)
 *   TRAVEL_FLIGHT_PROVIDER    (optional, 'booking' (default) | 'skyscanner')
 *
 * Subscriptions needed on the one RapidAPI key:
 *   booking-com15  — powers BOTH search_hotels and search_flights. Required.
 *   aerodatabox    — only for flight_schedule. Optional; that tool reports
 *                    itself as unavailable without it rather than failing.
 *   sky-scrapper   — only if you switch TRAVEL_FLIGHT_PROVIDER=skyscanner.
 * Env is read INSIDE each call, not at require time, so adding the key in the
 * Railway panel takes effect on the next message without a redeploy.
 *
 * HONESTY RULES BAKED IN (Sarah's firmest rule — nothing invented):
 *   · Every field returned is copied out of the supplier's response. Missing
 *     data comes back as null, never as a guess.
 *   · Prices ALWAYS carry their currency — the hotel supplier mixes currencies
 *     across results, so a bare number is a lie. Each result has its own
 *     price.currency, and the top level lists every currency seen.
 *   · Zero results returns count: 0 and an instruction telling Q to say so
 *     plainly rather than fill the gap from memory.
 *   · No supplier is ever named in a user-facing string (house rule) — errors
 *     say "the travel service", the same way street_view does.
 *
 * UK PACKAGE HOLIDAYS: Jet2, TUI, loveholidays and On the Beach have NO public
 * API. Nothing here can price a package. Flight + hotel priced separately is
 * the honest answer, and Q must say that rather than invent a package price.
 */

const { logCall } = require('../cost-tracker');

// ─────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────

const DEFAULT_HOTELS_HOST   = 'booking-com15.p.rapidapi.com';
const DEFAULT_FLIGHTS_HOST  = 'sky-scrapper.p.rapidapi.com';
const DEFAULT_SCHEDULE_HOST = 'aerodatabox.p.rapidapi.com';

const REQUEST_TIMEOUT_MS = 25000;   // live travel searches are slow (3-8s is normal)
const MAX_RESULTS_CAP    = 20;      // results are JSON.stringify'd into Q's prompt — keep them small
const MAX_SCHEDULE_DAYS  = 7;       // one full week = every weekly pattern, and caps the call count
const SCHEDULE_CALL_CAP  = 16;      // hard ceiling on metered calls for one schedule lookup

// The missing-key reply. Same shape and same manners as street_view: a clear
// error field for the loop, plus an instruction telling Q exactly what to say —
// no provider names, no crash, carry on with the rest of the answer.
function notEnabled(what) {
    return {
        error: 'travel search not enabled',
        instruction_for_q: `The ${what} lookup isn't switched on yet (it needs a key adding on the tools-and-keys page). Tell the user plainly, don't name any provider, and carry on with the rest of what they asked. Do NOT invent prices, hotels, flights or availability to fill the gap — say you couldn't check.`,
    };
}

const NEVER_INVENT = 'Everything above came from the live service. Do NOT add hotels, flights, times, prices or availability that are not in this result, and do NOT convert a price into another currency without saying you have done so.';

// ─────────────────────────────────────────────────────────────
//  SMALL HELPERS
// ─────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isDateString(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/** 'YYYY-MM-DD' → epoch ms at UTC midnight. Avoids local-timezone drift. */
function dateToUtc(s) {
    const [y, m, d] = String(s).trim().split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function addDays(dateStr, n) {
    const t = dateToUtc(dateStr) + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
    return WEEKDAYS[new Date(dateToUtc(dateStr)).getUTCDay()];
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function cleanCode(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

/** Distinct, order-preserving. */
function uniq(list) {
    return Array.from(new Set(list.filter(v => v != null && v !== '')));
}

/**
 * One metered HTTP call to a RapidAPI host.
 *
 * The key goes in a header and NOWHERE else — it is never logged, never put in
 * a URL we log, and never returned to Q. Failures come back as a plain object,
 * never a throw, so a dead supplier can't take a chat turn down.
 */
async function rapidGet(host, path, params, { skill, user } = {}) {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) return { failed: true, reason: 'no_key' };

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === '') continue;
        qs.append(k, String(v));
    }
    const url = `https://${host}/${String(path).replace(/^\/+/, '')}${qs.toString() ? `?${qs}` : ''}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();
    try {
        const res = await fetch(url, {
            headers: {
                'X-RapidAPI-Key': apiKey,
                'X-RapidAPI-Host': host,
                'Accept': 'application/json',
            },
            signal: controller.signal,
        });
        const durationMs = Date.now() - started;
        // Every paid call gets logged (README: any plugin hitting a paid endpoint
        // wires cost-tracker). Model = the host so /admin/costs shows which
        // travel service is being hit. No key, no query string, no user data.
        try {
            logCall({
                skill: skill || 'travel', provider: 'rapidapi', model: host,
                user: user || null, durationMs, success: res.ok,
                error: res.ok ? null : `HTTP ${res.status}`,
            });
        } catch (e) { /* cost logging must never break a lookup */ }

        if (res.status === 204) return { failed: false, status: 204, data: null };
        if (!res.ok) {
            console.warn(`[q-travel] ${host}${String(path).startsWith('/') ? '' : '/'}${path} → HTTP ${res.status}`);
            return { failed: true, reason: res.status === 403 ? 'not_subscribed' : (res.status === 429 ? 'rate_limited' : 'http'), status: res.status };
        }
        const data = await res.json().catch(() => null);
        return { failed: false, status: res.status, data };
    } catch (err) {
        clearTimeout(timer);
        const aborted = err.name === 'AbortError';
        console.warn(`[q-travel] ${host} request failed: ${aborted ? 'timeout' : err.message}`);
        try {
            logCall({
                skill: skill || 'travel', provider: 'rapidapi', model: host,
                user: user || null, durationMs: Date.now() - started,
                success: false, error: aborted ? 'timeout' : 'network',
            });
        } catch (e) { /* ignore */ }
        return { failed: true, reason: aborted ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

/** Turn a rapidGet failure into Q-safe wording. Never names a supplier. */
function failureReply(fail, what) {
    if (fail.reason === 'no_key') return notEnabled(what);
    if (fail.reason === 'not_subscribed') {
        return {
            error: 'travel search not enabled',
            instruction_for_q: `The ${what} lookup isn't switched on yet — the account isn't subscribed to that service. Tell the user plainly, don't name any provider, and do NOT make up prices or availability.`,
        };
    }
    if (fail.reason === 'rate_limited') {
        return {
            error: 'travel search busy',
            instruction_for_q: `The ${what} lookup has hit its usage limit for now. Tell the user plainly (no provider names), offer to try again shortly, and do NOT answer from memory as if you had checked.`,
        };
    }
    return {
        error: 'travel search unavailable',
        instruction_for_q: `The ${what} lookup didn't come back${fail.reason === 'timeout' ? ' (it timed out)' : ''}. Tell the user plainly, offer to retry, and do NOT invent results.`,
    };
}

// ─────────────────────────────────────────────────────────────
//  HOTELS — live availability + price
// ─────────────────────────────────────────────────────────────

function hotelsHost() {
    return process.env.RAPIDAPI_HOTELS_HOST || DEFAULT_HOTELS_HOST;
}

/**
 * Pull a price object out of a hotel result. The supplier has moved this field
 * between two places across versions, so both are read. Currency travels WITH
 * the number — results in one search can be in different currencies.
 */
function readHotelPrice(h) {
    const bd = h?.property?.priceBreakdown || h?.priceBreakdown || null;
    const gp = bd?.grossPrice || bd?.grossAmount || bd?.grossAmountPerNight || null;
    if (!gp) return null;
    const amount = gp.value ?? gp.amount ?? gp.amountRounded ?? null;
    const currency = gp.currency || gp.currency_code || gp.currencyCode || null;
    if (amount == null) return null;
    return {
        amount: Number(amount),
        currency: currency || null,
        // Honest label: the supplier returns the total for the stay for the
        // rooms requested. If it ever omits the currency we say so rather than
        // assume pounds.
        note: currency ? null : 'currency not supplied by the service',
    };
}

/**
 * Resolve a place or hotel name into the id the search endpoint needs.
 * Returns { dest_id, search_type, name } or a failure object.
 */
async function resolveDestination(query, preferHotel, user) {
    const r = await rapidGet(hotelsHost(), 'api/v1/hotels/searchDestination', { query }, { skill: 'travel-hotels', user });
    if (r.failed) return { fail: r };
    const list = Array.isArray(r.data?.data) ? r.data.data : [];
    if (!list.length) return { none: true };
    const isHotel = d => /hotel/i.test(String(d.search_type || d.dest_type || ''));
    const pick = preferHotel ? (list.find(isHotel) || list[0]) : (list.find(d => !isHotel(d)) || list[0]);
    return {
        dest_id: pick.dest_id ?? pick.destId ?? null,
        search_type: pick.search_type || pick.dest_type || null,
        name: pick.label || pick.name || query,
        country: pick.country || null,
        matched_as: isHotel(pick) ? 'hotel' : (pick.dest_type || pick.search_type || 'place'),
    };
}

/**
 * search_hotels — live availability and prices.
 *
 * @param {object} a
 * @param {string} [a.destination]    city / area / region to search
 * @param {string} [a.hotel_name]     a specific hotel by name (used instead of destination)
 * @param {string} a.check_in         YYYY-MM-DD
 * @param {string} a.check_out        YYYY-MM-DD
 * @param {number} [a.rooms=1]
 * @param {number} [a.adults=2]       adults IN TOTAL across the rooms
 * @param {number[]|string} [a.children_ages]  ages of children, e.g. [4,9]
 * @param {string} [a.currency]       ISO code to price in, e.g. GBP
 * @param {number} [a.max_results=8]
 */
async function searchHotels(a = {}, personEmail) {
    if (!process.env.RAPIDAPI_KEY) return notEnabled('hotel');

    const destination = String(a.destination || '').trim();
    const hotelName   = String(a.hotel_name || '').trim();
    const query = hotelName || destination;
    if (!query) {
        return { error: 'missing destination', instruction_for_q: 'Ask the user WHERE they want to stay (a place, or the name of a hotel) before searching.' };
    }
    if (!isDateString(a.check_in) || !isDateString(a.check_out)) {
        return { error: 'missing dates', instruction_for_q: 'Ask the user for the check-in and check-out dates (as real calendar dates) — a hotel price cannot be looked up without them. Do not guess dates.' };
    }
    if (dateToUtc(a.check_out) <= dateToUtc(a.check_in)) {
        return { error: 'bad dates', instruction_for_q: 'The check-out date is not after the check-in date. Ask the user to confirm the dates.' };
    }

    const rooms  = clampInt(a.rooms, 1, 8, 1);
    const adults = clampInt(a.adults, 1, 30, 2);
    const childAges = Array.isArray(a.children_ages)
        ? a.children_ages.map(n => clampInt(n, 0, 17, null)).filter(n => n !== null)
        : String(a.children_ages || '').split(',').map(s => clampInt(s, 0, 17, null)).filter(n => n !== null);
    const maxResults = clampInt(a.max_results, 1, MAX_RESULTS_CAP, 8);
    const currency = /^[A-Za-z]{3}$/.test(String(a.currency || '')) ? String(a.currency).toUpperCase() : 'GBP';

    // 1. Resolve the place (or the named hotel) into an id.
    const dest = await resolveDestination(query, !!hotelName, personEmail);
    if (dest.fail) return failureReply(dest.fail, 'hotel');
    if (dest.none || !dest.dest_id) {
        return {
            query, results: [], count: 0,
            instruction_for_q: `Nothing matched "${query}" in the hotel service. Say plainly that you couldn't find that place/hotel and ask them to confirm the name or try a nearby town. Do NOT invent hotels.`,
        };
    }

    // 2. Live availability + prices for those exact dates and that room set-up.
    const r = await rapidGet(hotelsHost(), 'api/v1/hotels/searchHotels', {
        dest_id: dest.dest_id,
        search_type: dest.search_type || 'CITY',
        arrival_date: a.check_in.trim(),
        departure_date: a.check_out.trim(),
        adults,
        children_age: childAges.length ? childAges.join(',') : undefined,
        room_qty: rooms,
        page_number: 1,
        currency_code: currency,
        languagecode: 'en-gb',
        units: 'metric',
    }, { skill: 'travel-hotels', user: personEmail });
    if (r.failed) return failureReply(r, 'hotel');

    const raw = r.data?.data?.hotels || r.data?.data?.result || [];
    const hotels = (Array.isArray(raw) ? raw : []).slice(0, maxResults).map(h => {
        const p = h?.property || h || {};
        const price = readHotelPrice(h);
        return {
            name: p.name || h.hotel_name || null,
            hotel_id: h.hotel_id ?? p.id ?? null,
            price,                                   // { amount, currency } — never a bare number
            review_score: p.reviewScore ?? p.review_score ?? null,
            review_count: p.reviewCount ?? p.review_count ?? null,
            stars: p.propertyClass ?? p.class ?? null,
            check_in: p.checkinDate || a.check_in,
            check_out: p.checkoutDate || a.check_out,
        };
    }).filter(h => h.name);

    const currencies = uniq(hotels.map(h => h.price?.currency));
    const nights = Math.round((dateToUtc(a.check_out) - dateToUtc(a.check_in)) / 86400000);

    if (!hotels.length) {
        console.log(`[q-travel] search_hotels: 0 available for "${query}" ${a.check_in}→${a.check_out}`);
        return {
            searched: { place: dest.name, matched_as: dest.matched_as, check_in: a.check_in, check_out: a.check_out, nights, rooms, adults, children: childAges.length },
            results: [], count: 0,
            instruction_for_q: 'The service returned NO available hotels for those dates and that room set-up. Say exactly that — nothing available came back — and offer to try different dates, a nearby place, or fewer rooms. Do NOT invent hotels or prices.',
        };
    }

    console.log(`[q-travel] search_hotels OK: ${hotels.length} result(s) for "${query}" ${a.check_in}→${a.check_out}`);
    return {
        searched: { place: dest.name, matched_as: dest.matched_as, check_in: a.check_in, check_out: a.check_out, nights, rooms, adults, children: childAges.length },
        requested_currency: currency,
        currencies_returned: currencies,
        results: hotels,
        count: hotels.length,
        instruction_for_q: `Live prices for ${nights} night(s), ${rooms} room(s), ${adults} adult(s)${childAges.length ? `, ${childAges.length} child(ren)` : ''}. ALWAYS state each price WITH its currency${currencies.length > 1 ? ' — the results came back in more than one currency, so never total them up as if they matched' : ''}. The price is what the service quoted for the whole stay as searched. ${NEVER_INVENT}`,
    };
}

// ─────────────────────────────────────────────────────────────
//  FLIGHTS — price search, supplier behind an adapter
// ─────────────────────────────────────────────────────────────

function flightsHost() {
    return process.env.RAPIDAPI_FLIGHTS_HOST || DEFAULT_FLIGHTS_HOST;
}

/**
 * The flight supplier is the part most likely to be swapped (they change, get
 * retired, or get too expensive). Each adapter takes the SAME normalised args
 * and returns the SAME normalised shape, so search_flights never changes:
 *
 *   in : { from, to, date, return_date, adults, children, cabin, currency, max }
 *   out: { results: [ { price: {amount, currency, display}, airlines: [],
 *                       legs: [ { from, to, depart, arrive, stops, duration_minutes } ] } ] }
 *          or { fail } / { none: true }
 */
const FLIGHT_ADAPTERS = {
    // Sky Scrapper (Skyscanner data) — two steps: resolve each airport to its
    // skyId + entityId, then search.
    skyscanner: async function skyscannerAdapter(q, user) {
        const host = flightsHost();
        async function resolve(code) {
            const r = await rapidGet(host, 'api/v1/flights/searchAirport', { query: code, locale: 'en-GB' }, { skill: 'travel-flights', user });
            if (r.failed) return { fail: r };
            const list = Array.isArray(r.data?.data) ? r.data.data : [];
            if (!list.length) return { none: true };
            // Prefer an exact IATA match; the endpoint also returns cities.
            const exact = list.find(i => cleanCode(i.skyId || i.navigation?.relevantFlightParams?.skyId) === cleanCode(code)) || list[0];
            const nav = exact.navigation?.relevantFlightParams || {};
            return {
                skyId: exact.skyId || nav.skyId || null,
                entityId: exact.entityId || nav.entityId || exact.navigation?.entityId || null,
                label: exact.presentation?.title || nav.localizedName || code,
            };
        }
        const origin = await resolve(q.from);
        if (origin.fail) return { fail: origin.fail };
        const dest = await resolve(q.to);
        if (dest.fail) return { fail: dest.fail };
        if (origin.none || dest.none || !origin.skyId || !dest.skyId) return { none: true, why: 'airport_not_found' };

        const r = await rapidGet(host, 'api/v1/flights/searchFlights', {
            originSkyId: origin.skyId,
            destinationSkyId: dest.skyId,
            originEntityId: origin.entityId,
            destinationEntityId: dest.entityId,
            date: q.date,
            returnDate: q.return_date || undefined,
            adults: q.adults,
            children: q.children || undefined,
            cabinClass: q.cabin,
            currency: q.currency,
            market: 'en-GB',
            countryCode: 'GB',
            sortBy: 'best',
        }, { skill: 'travel-flights', user });
        if (r.failed) return { fail: r };

        const itineraries = r.data?.data?.itineraries || r.data?.itineraries || [];
        const results = (Array.isArray(itineraries) ? itineraries : []).slice(0, q.max).map(it => {
            const legs = (it.legs || []).map(l => ({
                from: l.origin?.displayCode || l.origin?.id || null,
                to: l.destination?.displayCode || l.destination?.id || null,
                depart: l.departure || null,
                arrive: l.arrival || null,
                stops: l.stopCount ?? null,
                duration_minutes: l.durationInMinutes ?? null,
                airlines: uniq((l.carriers?.marketing || []).map(c => c.name)),
            }));
            const amount = it.price?.raw ?? null;
            return {
                price: amount == null ? null : {
                    amount: Number(amount),
                    currency: q.currency,
                    display: it.price?.formatted || null,
                },
                airlines: uniq(legs.flatMap(l => l.airlines)),
                legs: legs.map(({ airlines, ...rest }) => rest),
            };
        }).filter(x => x.price);
        return { results, resolved: { from: origin.label, to: dest.label } };
    },

    // Booking.com flights — same key and same account as the hotel search, so
    // it needs no extra subscription. Kept as the swap-in alternative; select
    // it with TRAVEL_FLIGHT_PROVIDER=booking.
    booking: async function bookingFlightsAdapter(q, user) {
        const host = hotelsHost();
        async function resolve(code) {
            const r = await rapidGet(host, 'api/v1/flights/searchDestination', { query: code }, { skill: 'travel-flights', user });
            if (r.failed) return { fail: r };
            const list = Array.isArray(r.data?.data) ? r.data.data : [];
            if (!list.length) return { none: true };
            const exact = list.find(i => /AIRPORT/i.test(String(i.type || '')) && cleanCode(i.code || i.id) === cleanCode(code)) || list[0];
            return { id: exact.id || null, label: exact.name || exact.cityName || code };
        }
        const origin = await resolve(q.from);
        if (origin.fail) return { fail: origin.fail };
        const dest = await resolve(q.to);
        if (dest.fail) return { fail: dest.fail };
        if (origin.none || dest.none || !origin.id || !dest.id) return { none: true, why: 'airport_not_found' };

        const r = await rapidGet(host, 'api/v1/flights/searchFlights', {
            fromId: origin.id,
            toId: dest.id,
            departDate: q.date,
            returnDate: q.return_date || undefined,
            adults: q.adults,
            children: q.children || undefined,
            cabinClass: String(q.cabin || 'economy').toUpperCase(),
            currency_code: q.currency,
            sort: 'BEST',
            pageNo: 1,
        }, { skill: 'travel-flights', user });
        if (r.failed) return { fail: r };

        const offers = r.data?.data?.flightOffers || r.data?.flightOffers || [];
        const results = (Array.isArray(offers) ? offers : []).slice(0, q.max).map(o => {
            const total = o.priceBreakdown?.total || o.travellerPrices?.[0]?.travellerPriceBreakdown?.total || null;
            // Booking splits money into whole units + nanos (billionths).
            const amount = total ? Number(total.units || 0) + Number(total.nanos || 0) / 1e9 : null;
            const segments = (o.segments || []).map(s => ({
                from: s.departureAirport?.code || null,
                to: s.arrivalAirport?.code || null,
                depart: s.departureTime || null,
                arrive: s.arrivalTime || null,
                stops: Array.isArray(s.legs) ? Math.max(s.legs.length - 1, 0) : null,
                duration_minutes: s.totalTime ? Math.round(Number(s.totalTime) / 60) : null,
                airlines: uniq((s.legs || []).flatMap(l => (l.carriersData || []).map(c => c.name))),
            }));
            return {
                price: amount == null ? null : {
                    amount: Number(amount.toFixed(2)),
                    currency: total.currencyCode || q.currency,
                    display: null,
                },
                airlines: uniq(segments.flatMap(s => s.airlines)),
                legs: segments.map(({ airlines, ...rest }) => rest),
            };
        }).filter(x => x.price);
        return { results, resolved: { from: origin.label, to: dest.label } };
    },
};

function activeFlightProvider() {
    // Default to Booking.com flights: it rides the SAME booking-com15 subscription
    // as search_hotels, so one subscription powers both. Verified live against
    // LGW->ACE (Aug 2026) — endpoints, params and the units+nanos price shape all
    // confirmed against a real payload. sky-scrapper needs its own subscription
    // and 403s without one; select it with TRAVEL_FLIGHT_PROVIDER=skyscanner.
    const want = String(process.env.TRAVEL_FLIGHT_PROVIDER || 'booking').toLowerCase();
    return FLIGHT_ADAPTERS[want] ? want : 'booking';
}

/**
 * search_flights — live prices between two airports.
 *
 * @param {object} a
 * @param {string} a.from            origin IATA, e.g. LGW
 * @param {string} a.to              destination IATA, e.g. AGP
 * @param {string} a.date            outbound date YYYY-MM-DD
 * @param {string} [a.return_date]   return date YYYY-MM-DD (omit for one way)
 * @param {number} [a.adults=1]
 * @param {number} [a.children=0]
 * @param {string} [a.cabin='economy']
 * @param {string} [a.currency='GBP']
 * @param {number} [a.max_results=6]
 */
async function searchFlights(a = {}, personEmail) {
    if (!process.env.RAPIDAPI_KEY) return notEnabled('flight price');

    const from = cleanCode(a.from);
    const to   = cleanCode(a.to);
    if (!from || !to) {
        return { error: 'missing airports', instruction_for_q: 'Ask the user which airports they are flying FROM and TO (airport codes or city names) before searching. Do not guess.' };
    }
    if (!isDateString(a.date)) {
        return { error: 'missing date', instruction_for_q: 'Ask the user for the outbound date as a real calendar date. Do not guess a date.' };
    }
    if (a.return_date && !isDateString(a.return_date)) {
        return { error: 'bad return date', instruction_for_q: 'The return date is not a valid calendar date. Ask the user to confirm it.' };
    }

    const q = {
        from, to,
        date: a.date.trim(),
        return_date: a.return_date ? a.return_date.trim() : null,
        adults: clampInt(a.adults, 1, 9, 1),
        children: clampInt(a.children, 0, 8, 0),
        cabin: ['economy', 'premium_economy', 'business', 'first'].includes(String(a.cabin || '').toLowerCase())
            ? String(a.cabin).toLowerCase() : 'economy',
        currency: /^[A-Za-z]{3}$/.test(String(a.currency || '')) ? String(a.currency).toUpperCase() : 'GBP',
        max: clampInt(a.max_results, 1, MAX_RESULTS_CAP, 6),
    };

    const providerName = activeFlightProvider();
    let out;
    try {
        out = await FLIGHT_ADAPTERS[providerName](q, personEmail);
    } catch (err) {
        console.warn(`[q-travel] flight adapter "${providerName}" threw: ${err.message}`);
        return { error: 'travel search unavailable', instruction_for_q: 'The flight lookup hit a problem. Tell the user plainly (no provider names), offer to retry, and do NOT invent flights or prices.' };
    }
    if (out.fail) return failureReply(out.fail, 'flight price');
    if (out.none) {
        return {
            searched: { from, to, date: q.date, return_date: q.return_date }, results: [], count: 0,
            instruction_for_q: out.why === 'airport_not_found'
                ? 'Those airport codes could not be matched. Say so and ask the user to confirm the airports. Do NOT invent flights.'
                : 'Nothing came back for that route and date. Say exactly that and offer nearby dates or a different airport. Do NOT invent flights or prices.',
        };
    }

    const results = out.results || [];
    if (!results.length) {
        console.log(`[q-travel] search_flights: 0 offers ${from}→${to} ${q.date}`);
        return {
            searched: { from, to, date: q.date, return_date: q.return_date, adults: q.adults, children: q.children, cabin: q.cabin },
            results: [], count: 0,
            instruction_for_q: 'The service returned NO flight offers for that route and date. Say exactly that — nothing came back — and offer to try another date or a nearby airport. Do NOT fill the gap from memory.',
        };
    }

    console.log(`[q-travel] search_flights OK: ${results.length} offer(s) ${from}→${to} ${q.date}`);
    return {
        searched: { from, to, date: q.date, return_date: q.return_date, adults: q.adults, children: q.children, cabin: q.cabin },
        resolved: out.resolved || null,
        currency: q.currency,
        results,
        count: results.length,
        instruction_for_q: `Live flight prices${q.return_date ? ' (return trip)' : ' (one way)'} for ${q.adults} adult(s)${q.children ? ` and ${q.children} child(ren)` : ''}. Quote every price WITH its currency, and say these are live fares that move. If the user is comparing against a UK package holiday (Jet2, TUI, loveholidays, On the Beach), tell them plainly that those operators publish no API, so this is flight-only and the hotel has to be priced separately with search_hotels — a package price cannot be looked up. ${NEVER_INVENT}`,
    };
}

// ─────────────────────────────────────────────────────────────
//  ROUTE SCHEDULE — which airlines, and WHICH DAYS OF THE WEEK
// ─────────────────────────────────────────────────────────────

function scheduleHost() {
    return process.env.RAPIDAPI_SCHEDULE_HOST || DEFAULT_SCHEDULE_HOST;
}

/**
 * Read the destination code out of a route-stats record. The field is an
 * object on the current API and a bare string on older responses.
 */
function routeDestinationCode(dest) {
    if (!dest) return null;
    if (typeof dest === 'string') return cleanCode(dest);
    return cleanCode(dest.iata || dest.icao || dest.code || dest.name || '');
}

/**
 * flight_schedule — which airlines fly from→to, and on which days of the week.
 *
 * How it actually works (no magic, no guessing):
 *   1. One call for the origin airport's route statistics. That says whether
 *      the destination is served at all, which airlines operate it, and the
 *      average flights per day over the previous 7 days.
 *   2. Then it walks a real calendar window (up to 7 days, two 12-hour reads
 *      per day because the schedule endpoint won't return more than 12 hours at
 *      a time) and collects the ACTUAL scheduled departures to that airport.
 *      The days of the week come out of those real departures — they are not
 *      inferred from an average and never invented.
 *
 * The result always states the exact window that was scanned, so "no flights
 * found" can never be dressed up as "the route doesn't exist".
 *
 * @param {object} a
 * @param {string} a.from          origin airport IATA (e.g. LGW)
 * @param {string} a.to            destination airport IATA (e.g. AGP)
 * @param {string} [a.start_date]  first day of the window, YYYY-MM-DD (default today)
 * @param {number} [a.days=7]      how many days to walk (1-7)
 */
async function flightSchedule(a = {}, personEmail) {
    if (!process.env.RAPIDAPI_KEY) return notEnabled('flight schedule');

    const from = cleanCode(a.from);
    const to   = cleanCode(a.to);
    if (!from || !to) {
        return { error: 'missing airports', instruction_for_q: 'Ask the user which two airports the route is between (IATA codes preferred). Do not guess.' };
    }
    if (a.start_date && !isDateString(a.start_date)) {
        return { error: 'bad date', instruction_for_q: 'The start date is not a valid calendar date. Ask the user to confirm it.' };
    }
    const startDate = isDateString(a.start_date) ? a.start_date.trim() : todayIso();
    const days = clampInt(a.days, 1, MAX_SCHEDULE_DAYS, MAX_SCHEDULE_DAYS);
    const codeType = from.length === 4 ? 'icao' : 'iata';
    const host = scheduleHost();

    // ── Step 1: does this route exist at all, and who flies it?
    const statsRes = await rapidGet(host, `airports/${codeType}/${from}/stats/routes/daily`, {}, { skill: 'travel-schedule', user: personEmail });
    if (statsRes.failed) return failureReply(statsRes, 'flight schedule');

    const routes = Array.isArray(statsRes.data?.routes) ? statsRes.data.routes : [];
    const match = routes.find(r => routeDestinationCode(r.destination) === to) || null;
    const routeStats = match ? {
        average_daily_flights: match.averageDailyFlights ?? null,
        operators: uniq((match.operators || []).map(o => (typeof o === 'string' ? o : (o?.name || null)))),
        source: 'the previous 7 days of movements at the origin airport',
    } : null;

    // ── Step 2: walk the real calendar and collect actual scheduled departures.
    const departures = [];
    let callsMade = 1;
    let windowsRead = 0;
    let windowFailed = null;
    for (let d = 0; d < days; d++) {
        const day = addDays(startDate, d);
        for (const [t0, t1] of [['00:00', '12:00'], ['12:00', '23:59']]) {
            if (callsMade >= SCHEDULE_CALL_CAP) break;
            const r = await rapidGet(host, `flights/airports/${codeType}/${from}/${day}T${t0}/${day}T${t1}`, {
                direction: 'Departure',
                withLeg: false,
                withCancelled: false,
                withCodeshared: false,
                withCargo: false,
                withPrivate: false,
                withLocation: false,
            }, { skill: 'travel-schedule', user: personEmail });
            callsMade++;
            if (r.failed) { windowFailed = r; continue; }
            windowsRead++;
            const list = Array.isArray(r.data?.departures) ? r.data.departures : [];
            for (const f of list) {
                const mv = f.movement || f.arrival || null;
                const apt = mv?.airport || {};
                const code = codeType === 'icao' ? cleanCode(apt.icao) : cleanCode(apt.iata);
                if (code !== to) continue;
                const local = mv?.scheduledTime?.local || mv?.scheduledTime?.utc || null;
                departures.push({
                    date: day,
                    weekday: weekdayOf(day),
                    flight_number: f.number || null,
                    airline: f.airline?.name || null,
                    departs_local: local,
                    arrives_local: null,
                });
            }
        }
    }

    // Everything below is derived ONLY from departures actually returned above.
    const daysOfWeek = uniq(departures.map(f => f.weekday));
    const byAirline = {};
    for (const f of departures) {
        const key = f.airline || 'Unknown airline';
        if (!byAirline[key]) byAirline[key] = { airline: key, days_of_week: [], flight_numbers: [], departures: 0 };
        byAirline[key].departures++;
        if (!byAirline[key].days_of_week.includes(f.weekday)) byAirline[key].days_of_week.push(f.weekday);
        if (f.flight_number && !byAirline[key].flight_numbers.includes(f.flight_number)) byAirline[key].flight_numbers.push(f.flight_number);
    }

    const windowLabel = `${startDate} to ${addDays(startDate, days - 1)}`;
    const base = {
        route: { from, to },
        window: { start_date: startDate, end_date: addDays(startDate, days - 1), days_scanned: days, windows_read: windowsRead },
        route_known: !!match,
        route_stats: routeStats,
        days_of_week: daysOfWeek,
        by_airline: Object.values(byAirline),
        departures_found: departures.length,
        departures: departures.slice(0, 40),   // the raw evidence, capped for prompt size
    };

    if (!departures.length) {
        console.log(`[q-travel] flight_schedule: 0 departures ${from}→${to} over ${windowLabel}`);
        return {
            ...base,
            instruction_for_q: match
                ? `No departures ${from}→${to} were found in the window scanned (${windowLabel})${windowsRead === 0 ? ' — and the schedule reads did not come back at all' : ''}. The route DOES appear in the origin airport's recent statistics${routeStats?.operators?.length ? ` (operated by ${routeStats.operators.join(', ')})` : ''}, so say plainly: nothing was scheduled in the days checked, which usually means it runs on other days or seasonally — and offer to check a different week. Do NOT state which days it runs; you do not know from this result.`
                : `Nothing found: ${to} does not appear in the origin airport's recent route statistics, and no departures were found in the window scanned (${windowLabel}). Say plainly that you could not find a direct route${windowsRead === 0 ? ' and that the schedule reads did not come back' : ''}, and suggest checking a connecting route or a nearby airport. Do NOT invent a schedule.`,
        };
    }

    console.log(`[q-travel] flight_schedule OK: ${departures.length} departure(s) ${from}→${to}, days: ${daysOfWeek.join('/')}`);
    return {
        ...base,
        instruction_for_q: `Real scheduled departures ${from}→${to} found in ${windowLabel}. THE DAYS OF THE WEEK ABOVE ARE THE POINT — tell the user exactly which days the route runs (${daysOfWeek.join(', ')}) and which airline flies on which days, because a route that only runs on certain days quietly breaks a trip plan. State the window you checked (${windowLabel}) so they know the basis${windowFailed ? ' and mention that part of the window could not be read, so the picture may be incomplete' : ''}. If they are comparing this with a UK package holiday (Jet2, TUI, loveholidays, On the Beach), say plainly that those operators publish no API — flights and hotels have to be priced separately here, and a package price cannot be looked up. ${NEVER_INVENT}`,
    };
}

module.exports = {
    searchHotels,
    searchFlights,
    flightSchedule,
    // Exposed so a future route/adapter swap doesn't have to reach into the file.
    FLIGHT_ADAPTERS,
    activeFlightProvider,
};
