'use strict';

/**
 * Q TRIPS — the engine behind /trips.
 *
 * Answers one question honestly: given where you fly FROM, WHEN you want to go,
 * how HOT it needs to be and how LONG you'll sit on a plane — where can you go?
 *
 * It is deliberately NOT a package-holiday search. Nothing here invents a price,
 * a temperature, a photo or a review. Every figure returned carries where it came
 * from, and anything unavailable comes back as null so the page can show absence
 * rather than a placeholder.
 *
 * WHAT IS REAL, AND FROM WHERE
 * ─────────────────────────────────────────────────────────────────────────────
 *   Airports        OpenFlights airports dataset, baked into trip-catalogue.json
 *                   at build time. Names, cities, countries and coordinates are
 *                   copied from it — none are typed by hand.
 *   Temperature     Open-Meteo historical reanalysis archive. RECORDED daily
 *                   values for the actual travel window across several past
 *                   years — not a monthly brochure average. Keyless.
 *   Sea             Open-Meteo marine archive, recorded daily SST maxima. Keyless.
 *                   Inland airports legitimately return null.
 *   Flight time     ESTIMATED from great-circle distance (see FLIGHT_FIT below).
 *                   Always flagged estimated:true. q-travel.js can confirm a real
 *                   schedule; until it does, the page must say "about".
 *   Photos          Wikipedia/Wikimedia Commons REST. Keyless, licence-clear,
 *                   and returns nothing rather than something wrong.
 *   Prices/reviews  NOT here. plugins/q-travel.js owns live hotel and flight
 *                   pricing and already returns review_score/review_count with
 *                   each hotel. This engine leaves those fields null and lets the
 *                   caller fill them, because they cost quota and must be opt-in.
 *
 * CACHING — the climate of a place in a given week does not change. Recorded
 * history is immutable, so it is cached on disk forever and only ever grows.
 * That turns a 121-destination search into one cheap disk read after the first run.
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────
//  CATALOGUE
// ─────────────────────────────────────────────────────────────

const CATALOGUE_PATH = path.join(__dirname, 'trip-catalogue.json');

let _catalogue = null;
function catalogue() {
    if (!_catalogue) _catalogue = JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf8'));
    return _catalogue;
}

function origins() { return catalogue().origins; }
function destinations() { return catalogue().destinations; }

function findOrigin(iata) {
    const code = String(iata || '').toUpperCase().trim();
    return origins().find(o => o.iata === code) || null;
}

// ─────────────────────────────────────────────────────────────
//  GEOMETRY + FLIGHT TIME
// ─────────────────────────────────────────────────────────────

const EARTH_R_KM = 6371;

function greatCircleKm(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = p2 - p1, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

/**
 * FLIGHT_FIT — least-squares fit of scheduled nonstop block time against
 * great-circle distance, over ten Gatwick routes whose real timetabled durations
 * were checked one by one (RHO, LCA, TFS, SSH, AYT, LPA, ACE, DLM, NBE, PFO).
 *
 *   hours = 0.7962 + 0.0012220 * km        (effective 818 km/h door-to-door)
 *
 * RMS error 8.9 minutes, worst case 16 minutes (Gran Canaria — Atlantic routings
 * run longer than the straight line). Good enough to sort a shortlist by; never
 * good enough to plan a connection on. ALWAYS returned with estimated:true.
 */
const FLIGHT_FIT = { intercept: 0.7962, perKm: 0.0012220, rmsMinutes: 9, worstMinutes: 16 };

function estimateFlightHours(km) {
    return FLIGHT_FIT.intercept + FLIGHT_FIT.perKm * km;
}

function formatHours(h) {
    const mins = Math.round(h * 60);
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

// ─────────────────────────────────────────────────────────────
//  DISK CACHE
// ─────────────────────────────────────────────────────────────

/**
 * Cache lives on the Railway volume when there is one, exactly as
 * plugins/user-data.js:24 does for user data. Writing it into the repo folder
 * instead would look fine locally and then be wiped by every deploy — and
 * because a cold cache means re-asking the weather archive about 121 places at
 * once, the first search after each deploy would walk straight into the rate
 * limit that fetchJson() now backs off from. Recorded history never changes, so
 * this cache should outlive deploys.
 */
const CACHE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'trips')
    : path.join(__dirname, '..', 'data', 'trips');

function cacheFile(name) { return path.join(CACHE_DIR, name); }

function readCache(name) {
    try { return JSON.parse(fs.readFileSync(cacheFile(name), 'utf8')); }
    catch { return {}; }
}

function writeCache(name, obj) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile(name), JSON.stringify(obj));
    } catch (err) {
        console.warn('[q-trips] could not write cache ' + name + ':', err.message);
    }
}

// ─────────────────────────────────────────────────────────────
//  WHERE THE WEATHER IS ACTUALLY MEASURED
// ─────────────────────────────────────────────────────────────
/**
 * An airport is not a resort. Agadir's airport sits 25km inland and reads about
 * three degrees hotter than the beach people actually sit on; Enfidha and Dalaman
 * have the same problem in reverse. Quoting the terminal's temperature as the
 * holiday's temperature is the kind of quietly wrong number this engine exists
 * to avoid.
 *
 * So: distance and flight time use the AIRPORT (that is where the plane lands),
 * but temperature and sea use the CITY, resolved through Open-Meteo's keyless
 * geocoder. The right result is picked by PROXIMITY to the airport rather than by
 * matching country names, because the two datasets disagree about what countries
 * are called ("Turkey" vs "Republic of Türkiye"). If nothing sensible is within
 * range, it falls back to the airport coordinates and says so.
 */
const CITY_CACHE = 'city-coords-cache.json';
const CITY_MAX_KM = 150;

async function cityCoordsFor(places, concurrency = 5) {
    const cache = readCache(CITY_CACHE);
    const todo = places.filter(p => cache[p.iata] === undefined);
    let changed = false;

    const queue = todo.slice();
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
            const p = queue.shift();
            const url = 'https://geocoding-api.open-meteo.com/v1/search'
                + `?name=${encodeURIComponent(p.city)}&count=10&language=en&format=json`;
            try {
                const json = await fetchJson(url);
                const hits = json.results || [];
                let best = null, bestKm = Infinity;
                for (const h of hits) {
                    const km = greatCircleKm(p.lat, p.lon, h.latitude, h.longitude);
                    if (km < bestKm) { bestKm = km; best = h; }
                }
                cache[p.iata] = (best && bestKm <= CITY_MAX_KM)
                    ? { lat: +best.latitude.toFixed(4), lon: +best.longitude.toFixed(4),
                        name: best.name, km_from_airport: Math.round(bestKm) }
                    : null;                                  // null = use the airport, honestly
                changed = true;
            } catch (err) {
                console.warn('[q-trips] geocode failed for ' + p.city + ':', err.message);
            }
        }
    }));

    if (changed) writeCache(CITY_CACHE, cache);

    // Return a measuring point per place, flagged with which it is.
    const out = {};
    for (const p of places) {
        const c = cache[p.iata];
        out[p.iata] = c
            ? { lat: c.lat, lon: c.lon, at: 'city', name: c.name, km_from_airport: c.km_from_airport }
            : { lat: p.lat, lon: p.lon, at: 'airport', name: p.airport, km_from_airport: 0 };
    }
    return out;
}

// ─────────────────────────────────────────────────────────────
//  CLIMATE — recorded history, not forecast
// ─────────────────────────────────────────────────────────────

const CLIMATE_CACHE   = 'climate-cache.json';
const SEA_CACHE       = 'sea-cache.json';
const CLIMATE_YEARS   = 6;    // how many past years of the same week to average
const SEA_YEARS       = 4;    // the marine archive starts later than the land one
const BATCH_SIZE      = 25;   // locations per Open-Meteo request
const FETCH_TIMEOUT_MS = 20000;

function ymd(d) {
    return d.getUTCFullYear() + '-' +
        String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(d.getUTCDate()).padStart(2, '0');
}

/** The same calendar window in a previous year. */
function windowForYear(startISO, nights, year) {
    const s = new Date(startISO + 'T00:00:00Z');
    const start = new Date(Date.UTC(year, s.getUTCMonth(), s.getUTCDate()));
    const end = new Date(start.getTime() + Math.max(1, nights) * 86400000);
    return { start: ymd(start), end: ymd(end) };
}

/** Which past years we can actually ask about (the archive lags ~5 days). */
function sampleYears(startISO, count) {
    const thisYear = new Date(startISO + 'T00:00:00Z').getUTCFullYear();
    const latestComplete = new Date(Date.now() - 10 * 86400000).getUTCFullYear();
    const newest = Math.min(thisYear - 1, latestComplete);
    const years = [];
    for (let y = newest; y > newest - count; y--) years.push(y);
    return years;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch JSON, retrying the failures that are worth retrying.
 *
 * The weather archive is free and rate-limited, and a cold search asks it thirty
 * questions in a row — enough to earn a 429. Backing off and trying again is the
 * difference between a complete answer and a silently short one, which matters
 * here: a destination missing because of a rate limit looks exactly like a
 * destination that is too cold, and that would be a lie by omission.
 */
async function fetchJson(url, attempt = 0) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.status === 429 || res.status >= 500) {
            if (attempt < 3) {
                clearTimeout(timer);
                await sleep(700 * Math.pow(2, attempt));      // 0.7s, 1.4s, 2.8s
                return fetchJson(url, attempt + 1);
            }
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally { clearTimeout(timer); }
}

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

/**
 * Recorded daily highs/lows/rain for a set of places, for the same calendar
 * window in each of the last few years. Returns a map keyed by iata.
 */
async function climateFor(places, startISO, nights) {
    const years = sampleYears(startISO, CLIMATE_YEARS);
    const cache = readCache(CLIMATE_CACHE);
    // The measuring point is IN the key: if a place's coordinates are ever
    // refined, its old readings are superseded rather than silently reused.
    const key = p => `${p.iata}@${p.lat},${p.lon}|${startISO.slice(5)}|${nights}|${years[0]}-${years[years.length - 1]}`;

    const missing = places.filter(p => !cache[key(p)]);
    let fetched = 0;
    const failures = [];

    for (const group of chunk(missing, BATCH_SIZE)) {
        const lat = group.map(p => p.lat).join(',');
        const lon = group.map(p => p.lon).join(',');
        const acc = group.map(() => ({ max: [], min: [], rain: [] }));

        for (const y of years) {
            const w = windowForYear(startISO, nights, y);
            const url = 'https://archive-api.open-meteo.com/v1/archive'
                + `?latitude=${lat}&longitude=${lon}`
                + `&start_date=${w.start}&end_date=${w.end}`
                + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto';
            try {
                const json = await fetchJson(url);
                const list = Array.isArray(json) ? json : [json];
                list.forEach((loc, i) => {
                    if (!loc || !loc.daily || !acc[i]) return;
                    const d = loc.daily;
                    (d.temperature_2m_max || []).forEach(v => v != null && acc[i].max.push(v));
                    (d.temperature_2m_min || []).forEach(v => v != null && acc[i].min.push(v));
                    (d.precipitation_sum || []).forEach(v => v != null && acc[i].rain.push(v));
                });
                fetched++;
            } catch (err) {
                failures.push(y);
                console.warn('[q-trips] climate fetch failed (' + y + '):', err.message);
            }
            await sleep(120);                                 // be a good citizen of a free API
        }

        group.forEach((p, i) => {
            const a = acc[i];
            if (!a.max.length) return;                     // no data → leave uncached, report null
            const mean = xs => +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(1);
            cache[key(p)] = {
                avg_high_c: mean(a.max),
                avg_low_c: a.min.length ? mean(a.min) : null,
                warmest_c: +Math.max(...a.max).toFixed(1),
                coolest_high_c: +Math.min(...a.max).toFixed(1),
                days_sampled: a.max.length,
                years: years.slice().reverse(),
                wet_days_pct: a.rain.length
                    ? Math.round(100 * a.rain.filter(v => v >= 1).length / a.rain.length) : null,
                _maxes: a.max.map(v => +v.toFixed(1)),     // kept so any bar can be re-scored
            };
        });
    }

    if (fetched) writeCache(CLIMATE_CACHE, cache);

    const out = {};
    for (const p of places) out[p.iata] = cache[key(p)] || null;
    out._incomplete = failures.length;                        // years we could not read
    return out;
}

/** Recorded sea-surface maxima for the same window. Inland → null, honestly. */
async function seaFor(places, startISO, nights) {
    const years = sampleYears(startISO, SEA_YEARS);
    const cache = readCache(SEA_CACHE);
    const key = p => `${p.iata}@${p.lat},${p.lon}|${startISO.slice(5)}|${nights}|${years[0]}-${years[years.length - 1]}`;

    const missing = places.filter(p => cache[key(p)] === undefined);
    let fetched = 0;

    for (const group of chunk(missing, BATCH_SIZE)) {
        const lat = group.map(p => p.lat).join(',');
        const lon = group.map(p => p.lon).join(',');
        const acc = group.map(() => []);

        for (const y of years) {
            const w = windowForYear(startISO, nights, y);
            const url = 'https://marine-api.open-meteo.com/v1/marine'
                + `?latitude=${lat}&longitude=${lon}`
                + `&start_date=${w.start}&end_date=${w.end}`
                + '&daily=sea_surface_temperature_max&timezone=auto';
            try {
                const json = await fetchJson(url);
                const list = Array.isArray(json) ? json : [json];
                list.forEach((loc, i) => {
                    const vals = loc && loc.daily && loc.daily.sea_surface_temperature_max;
                    if (Array.isArray(vals) && acc[i]) vals.forEach(v => v != null && acc[i].push(v));
                });
                fetched++;
            } catch (err) {
                console.warn('[q-trips] sea fetch failed (' + y + '):', err.message);
            }
        }

        // null is a real answer here (inland), so cache it rather than re-asking forever
        group.forEach((p, i) => {
            cache[key(p)] = acc[i].length
                ? +(acc[i].reduce((s, v) => s + v, 0) / acc[i].length).toFixed(1)
                : null;
        });
    }

    if (fetched) writeCache(SEA_CACHE, cache);

    const out = {};
    for (const p of places) out[p.iata] = cache[key(p)] ?? null;
    return out;
}

// ─────────────────────────────────────────────────────────────
//  PHOTOS — Wikimedia Commons via the Wikipedia API. Keyless.
// ─────────────────────────────────────────────────────────────

const PHOTO_CACHE = 'photo-cache.json';
const PHOTO_UA = 'quotem-ai-trips/1.0 (https://www.quotem-ai.co.uk)';

/**
 * Things that are never a picture of the holiday. Tested against both the
 * article title and the image's own file name (with underscores normalised),
 * because a perfectly-titled article can still lead with a map or a satellite
 * shot. If everything is rejected the answer is NO PHOTO — which the page shows
 * honestly. A map of southern Spain is worse than an empty frame.
 */
const PHOTO_REJECT = /airport|aerodrome|air ?base|airfield|terminal|runway|from space|satellite|orbit|nasa|sentinel|\bmaps?\b|mapa|karte|locator|topograph|relief|koppen|climate class|\bflags?\b|bandera|coat of arms|escudo|emblem|\bseals?\b|\blogos?\b|crest|diagram|\bcharts?\b|schematic|plan of|list of|governorate|province|prefecture|municipalit|district$/i;

/** Strip accents and punctuation so "Málaga" and "Malaga" compare equal. */
function normName(s) {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/\(.*?\)/g, ' ').split(',')[0]
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cheap edit distance, capped — we only care whether it is small. */
function editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 4) return 99;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[n];
}

/**
 * Is this article actually about the place we asked for?
 *
 * Search engines are helpful to a fault: asking Wikivoyage for "Rhodos Greece"
 * cheerfully returns Koufonisi, a different island entirely, and "Enfidha" comes
 * back as the Great Mosque of Kairouan sixty kilometres away. A photo of the
 * wrong town is worse than no photo, so the title has to match the city — allowing
 * only for spelling drift between languages (Marrakech/Marrakesh, Sevilla/Seville).
 */
function titleMatchesCity(title, city) {
    const t = normName(title), c = normName(city);
    if (!t || !c) return false;
    if (t === c) return true;
    return editDistance(t, c) <= Math.max(2, Math.floor(c.length * 0.2));
}

/** Ask one MediaWiki site for the best photo of a place. Returns null, never a guess. */
async function askWiki(host, place, credit) {
    const url = `https://${host}/w/api.php?action=query&prop=pageimages|info`
        + '&piprop=thumbnail&pithumbsize=900&inprop=url&generator=search'
        + `&gsrsearch=${encodeURIComponent(place.city + ' ' + place.country)}&gsrlimit=6&format=json`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let json;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': PHOTO_UA }, signal: ctrl.signal });
        json = await res.json();
    } finally { clearTimeout(timer); }

    const pages = json.query && json.query.pages ? Object.values(json.query.pages) : [];
    pages.sort((a, b) => (a.index || 99) - (b.index || 99));      // keep search relevance order

    // Reject on the article title AND the image's own file name — a well-titled
    // article can still lead with a map, a flag or a shot from orbit.
    const usable = pages.filter(p =>
        p.thumbnail && p.thumbnail.source
        && !PHOTO_REJECT.test(p.title)
        && !PHOTO_REJECT.test(decodeURIComponent(p.thumbnail.source.split('/').pop()).replace(/[_-]/g, ' ')));

    // Only a page that is genuinely ABOUT this city counts.
    const page = usable.find(p => titleMatchesCity(p.title, place.city));
    if (!page) return null;

    return {
        url: page.thumbnail.source,
        width: page.thumbnail.width,
        height: page.thumbnail.height,
        credit,
        page: page.fullurl || null,
        of: page.title,
    };
}

/**
 * A photo of the place, or nothing.
 *
 * Wikivoyage first, because it is a travel guide: its lead images are chosen to
 * show you a destination, so you get the coastline rather than the town hall.
 * Wikipedia second, which has broader coverage but leads with whatever is
 * encyclopaedically important — sometimes a map, sometimes a satellite image,
 * which is why both sources go through the same rejection filter.
 *
 * If both come back with nothing usable, that is the answer: the page shows
 * "no photo" rather than something misleading.
 */
async function photoFor(place) {
    const cache = readCache(PHOTO_CACHE);
    if (cache[place.iata] !== undefined) return cache[place.iata];

    let result = null;
    for (const [host, credit] of [['en.wikivoyage.org', 'Wikivoyage'], ['en.wikipedia.org', 'Wikimedia Commons']]) {
        try {
            result = await askWiki(host, place, credit);
            if (result) break;
        } catch (err) {
            console.warn('[q-trips] photo lookup failed for ' + place.iata + ' at ' + host + ':', err.message);
            return null;                                  // transient — don't poison the cache
        }
    }

    cache[place.iata] = result;                           // null IS the answer if there is no photo
    writeCache(PHOTO_CACHE, cache);
    return result;
}

async function photosFor(places, concurrency = 6) {
    const out = {};
    const queue = places.slice();
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
            const p = queue.shift();
            out[p.iata] = await photoFor(p);
        }
    }));
    return out;
}

// ─────────────────────────────────────────────────────────────
//  THE SEARCH
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   origin        IATA of the departure airport (required)
 *   departDate    'YYYY-MM-DD' (required)
 *   nights        integer, default 7
 *   minTempC      only keep places whose recorded average high clears this
 *   maxFlightH    only keep places inside this many hours' flying
 *   regions       optional array of region names to restrict to
 *   limit         how many to return, default 12
 *   withPhotos    fetch photos for the shortlist (default true)
 */
async function searchTrips(opts = {}) {
    const origin = findOrigin(opts.origin);
    if (!origin) {
        return { ok: false, error: 'unknown_origin', message: 'That departure airport is not in the list.' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(opts.departDate || ''))) {
        return { ok: false, error: 'bad_date', message: 'A departure date is needed, as YYYY-MM-DD.' };
    }

    const nights     = Math.max(1, Math.min(28, parseInt(opts.nights, 10) || 7));
    const minTempC   = opts.minTempC == null ? null : Number(opts.minTempC);
    const maxFlightH = opts.maxFlightH == null ? null : Number(opts.maxFlightH);
    const limit      = Math.max(1, Math.min(40, parseInt(opts.limit, 10) || 12));

    // 1. distance + estimated flight time for EVERY destination. The globe shows
    //    the whole world, so nothing is discarded here — only marked.
    const everywhere = destinations().map(d => {
        const km = greatCircleKm(origin.lat, origin.lon, d.lat, d.lon);
        return { ...d, km: Math.round(km), flight_hours_est: +estimateFlightHours(km).toFixed(2) };
    }).filter(d => d.km > 60);                              // not your own airport

    let places = everywhere;
    if (Array.isArray(opts.regions) && opts.regions.length) {
        const want = new Set(opts.regions);
        places = places.filter(d => want.has(d.region));
    }
    if (maxFlightH != null) {
        // Allow the fit's own worst-case error, so a place isn't cut by ten minutes
        // of estimation slop. The page still shows the estimate honestly.
        const slack = FLIGHT_FIT.worstMinutes / 60;
        places = places.filter(d => d.flight_hours_est <= maxFlightH + slack);
    }

    if (!places.length) {
        return {
            ok: true, origin, departDate: opts.departDate, nights,
            count: 0, results: [],
            note: 'Nothing in the list is within that flying time of ' + origin.city + '.',
        };
    }

    // 2. work out WHERE to measure each one (city, not terminal), then get the
    //    recorded climate there
    const points = await cityCoordsFor(places);
    const measured = places.map(p => ({ iata: p.iata, lat: points[p.iata].lat, lon: points[p.iata].lon }));

    const [climate, sea] = await Promise.all([
        climateFor(measured, opts.departDate, nights),
        seaFor(measured, opts.departDate, nights),
    ]);

    // 3. score, and cut on the temperature bar
    let rows = places.map(d => {
        const c = climate[d.iata];
        const maxes = c && c._maxes ? c._maxes : [];
        const overBar = (minTempC != null && maxes.length)
            ? Math.round(100 * maxes.filter(v => v >= minTempC).length / maxes.length)
            : null;
        return {
            iata: d.iata, city: d.city, country: d.country, airport: d.airport,
            region: d.region, lat: d.lat, lon: d.lon,
            distance_km: d.km,
            flight: {
                hours: d.flight_hours_est,
                label: 'about ' + formatHours(d.flight_hours_est),
                estimated: true,
                accuracy_minutes: FLIGHT_FIT.rmsMinutes,
            },
            measured_at: points[d.iata],
            climate: c ? {
                avg_high_c: c.avg_high_c,
                avg_low_c: c.avg_low_c,
                warmest_c: c.warmest_c,
                coolest_high_c: c.coolest_high_c,
                wet_days_pct: c.wet_days_pct,
                days_sampled: c.days_sampled,
                years: c.years,
                pct_days_over_bar: overBar,
                source: 'recorded daily observations',
            } : null,
            sea_c: sea[d.iata] ?? null,
            // Filled in only when the caller pays for a live lookup. Never guessed.
            price: null,
            review: null,
            photo: null,
        };
    });

    // Places with no climate data at all can't be judged — keep them out of the
    // shortlist rather than showing an empty card.
    const noData = rows.filter(r => !r.climate).map(r => r.iata);
    rows = rows.filter(r => r.climate);

    if (minTempC != null) rows = rows.filter(r => r.climate.avg_high_c >= minTempC);

    // Sort by how RELIABLY it clears the bar, then by how warm, then by how close.
    rows.sort((a, b) =>
        (b.climate.pct_days_over_bar ?? -1) - (a.climate.pct_days_over_bar ?? -1) ||
        b.climate.avg_high_c - a.climate.avg_high_c ||
        a.flight.hours - b.flight.hours
    );

    const total = rows.length;
    rows = rows.slice(0, limit);

    // 4. photos, shortlist only
    if (opts.withPhotos !== false) {
        const photos = await photosFor(rows);
        rows.forEach(r => { r.photo = photos[r.iata] || null; });
    }

    // 5. the globe payload — every destination, so you can see what is out of
    //    reach as well as what works. A place only "passes" if it cleared both
    //    bars on real data; anything unevaluated is honestly marked as such.
    const passing = new Map(rows.map(r => [r.iata, r]));
    const scored = new Map(
        Object.entries(climate)
            .filter(([iata, c]) => c && iata[0] !== '_')      // '_incomplete' is metadata, not a place
            .map(([iata, c]) => [iata, c])
    );
    const bestRel = Math.max(1, ...rows.map(r => r.climate.pct_days_over_bar ?? 0));

    const globe = everywhere.map(d => {
        const c = scored.get(d.iata);
        const hit = passing.get(d.iata);
        const inRange = maxFlightH == null || d.flight_hours_est <= maxFlightH + FLIGHT_FIT.worstMinutes / 60;
        return {
            iata: d.iata, lat: d.lat, lon: d.lon,
            label: `${d.city}, ${d.country}`,
            pass: !!hit,
            score: hit ? ((hit.climate.pct_days_over_bar ?? 50) / bestRel) : 0,
            high: c ? c.avg_high_c : null,
            rel: hit ? hit.climate.pct_days_over_bar : null,
            sea: sea[d.iata] ?? null,
            flight: 'about ' + formatHours(d.flight_hours_est),
            reason: hit ? null : (!inRange ? 'too far' : (c ? 'not warm enough' : 'no data')),
        };
    });

    return {
        ok: true,
        origin,
        departDate: opts.departDate,
        nights,
        bar: { minTempC, maxFlightH },
        count: rows.length,
        total_matching: total,
        results: rows,
        globe,
        method: {
            temperature: `Recorded daily observations for the same ${nights}-night window in each of the last ${CLIMATE_YEARS} years.`,
            sea: `Recorded daily sea-surface maxima for the same window over ${SEA_YEARS} years. Inland airports return nothing.`,
            flight: `Estimated from great-circle distance; fitted to ten verified nonstop schedules, RMS ${FLIGHT_FIT.rmsMinutes} minutes.`,
            prices: 'Not included. Live prices are a separate, paid lookup.',
        },
        no_climate_data: noData,
        // If the weather archive rate-limited us, SAY SO. A destination missing
        // because of a failed request must never be mistaken for one that was
        // checked and found too cold.
        incomplete: climate._incomplete
            ? { readings_missed: climate._incomplete,
                message: 'Some years could not be read just now, so this list may be short. Nothing was estimated to fill the gap — search again in a moment for the full picture.' }
            : null,
    };
}

module.exports = {
    catalogue, origins, destinations, findOrigin,
    greatCircleKm, estimateFlightHours, formatHours, FLIGHT_FIT,
    climateFor, seaFor, photoFor, photosFor,
    titleMatchesCity, normName,          // exported so the matcher can be tested directly
    searchTrips,
};
