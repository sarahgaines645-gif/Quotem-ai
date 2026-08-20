'use strict';

/**
 * Q HOME — the house, through one door.
 *
 * Two capabilities:
 *   homeStatus()   → what's on, what's open, how warm it is, what needs a
 *                    battery. Read-only.
 *   homeControl()  → turn something on or off, set a temperature, run a scene.
 *
 * WHY THIS SHAPE
 * Every smart-home brand ships its own API, its own auth and its own outages.
 * Wiring Q to each one directly means a new integration per gadget forever.
 * Home Assistant already speaks to hundreds of brands — Ring included — and
 * exposes ALL of them through one documented REST API. So Q learns one API,
 * and every device Sarah adds at home is something Q can already see, with no
 * new code at this end.
 *
 * KEYS — environment only, never hardcoded, never logged, never returned:
 *   HOME_ASSISTANT_URL    e.g. http://homeassistant.local:8123  (no trailing /api)
 *   HOME_ASSISTANT_TOKEN  a Long-Lived Access Token, made in Home Assistant under
 *                         your profile → Security → Long-lived access tokens
 * Env is read INSIDE each call, so adding them takes effect on the next message
 * without a redeploy.
 *
 * API SHAPE (verified against developers.home-assistant.io/docs/api/rest, 20 Aug 2026):
 *   GET  /api/                      → { message: "API running." }
 *   GET  /api/states                → [{ entity_id, state, attributes, last_changed }]
 *   POST /api/services/<domain>/<service>  body { entity_id }
 *
 * HONESTY RULES BAKED IN (Sarah's firmest rule — nothing invented):
 *   · Every reading is copied from the hub. Q never states a temperature, a
 *     door or an on/off that he has not actually fetched.
 *   · A device the hub reports as 'unavailable' or 'unknown' is reported AS
 *     unavailable — never silently treated as off.
 *   · Nothing is switched without the hub confirming it. A control call returns
 *     what the hub said, not what we hoped.
 *   · No supplier is ever named in a user-facing string (house rule).
 *
 * SAFETY — deliberate, and Sarah's call to change:
 *   Locks, alarm panels and garage doors/blinds are READ-ONLY here. Q can tell
 *   you the front door is unlocked; he cannot unlock it. An AI mis-hearing
 *   "unlock the door" has a much worse failure mode than one mis-hearing
 *   "turn off the lamp", and voice/chat is exactly where mishearing happens.
 *   Widen CONTROLLABLE below if that's wanted — it is one list, on purpose.
 */

const TIMEOUT_MS = 10000;

// Domains Q may switch. Everything else is readable but not controllable.
const CONTROLLABLE = new Set([
    'light', 'switch', 'fan', 'media_player', 'scene', 'script',
    'input_boolean', 'climate', 'humidifier',
]);

// Domains deliberately held back — see the SAFETY note above.
const LOCKED_OUT = new Set(['lock', 'alarm_control_panel', 'cover', 'valve', 'water_heater']);

const FAIL_NOTE = "The house hub did NOT answer. Tell the user plainly that you couldn't reach it just now — do NOT guess what any device is doing, and do NOT answer from memory — and offer to try again.";

const READING_NOTE = "These are live readings copied from the house hub. Report them as they are. A device listed as unavailable is NOT the same as off — say unavailable. Never state a reading for a device that is not in this list.";

function config() {
    const url = (process.env.HOME_ASSISTANT_URL || '').trim().replace(/\/+$/, '');
    const token = (process.env.HOME_ASSISTANT_TOKEN || '').trim();
    return { url, token, ready: !!(url && token) };
}

async function hub(path, options = {}) {
    const { url, token } = config();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url + path, {
            method: options.method || 'GET',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status} on ${path} — ${text.slice(0, 160)}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

const notReady = () => ({
    error: 'house hub not connected',
    instruction_for_q: "The house hub isn't connected yet. Tell the user plainly that you can't see the house, don't name any product, and carry on with the rest of what they asked.",
});

function domainOf(entityId) {
    return String(entityId || '').split('.')[0];
}

function nameOf(entity) {
    return entity?.attributes?.friendly_name || entity?.entity_id || '';
}

/** Rank how well a spoken name matches an entity. 0 = no match. */
function matchScore(query, entity) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return 0;
    const name = nameOf(entity).toLowerCase();
    const id = String(entity.entity_id || '').toLowerCase();
    if (!name && !id) return 0;

    if (name === q) return 100;
    if (id === q || id.split('.')[1] === q.replace(/\s+/g, '_')) return 95;
    if (name.includes(q)) return 70;

    // Every word the user said has to appear somewhere — "kitchen light"
    // must not match "bathroom light".
    const words = q.split(/\s+/).filter(w => w.length > 1);
    if (words.length && words.every(w => name.includes(w) || id.includes(w))) return 50;
    return 0;
}

/**
 * What is the house doing?
 *
 * @param {{search?:string, area?:string, kind?:string}} args
 * @returns {Promise<Object>} never throws
 */
async function homeStatus(args = {}) {
    if (!config().ready) return notReady();

    let states;
    try {
        states = await hub('/api/states');
    } catch (err) {
        console.warn('[q-home] homeStatus FAILED: ' + err.message);
        return { error: 'could not reach the house hub', instruction_for_q: FAIL_NOTE };
    }

    if (!Array.isArray(states)) {
        return { error: 'unexpected answer from the house hub', instruction_for_q: FAIL_NOTE };
    }

    const filter = String(args.search || args.area || '').toLowerCase().trim();
    const kind = String(args.kind || '').toLowerCase().trim();

    const rows = [];
    for (const e of states) {
        const domain = domainOf(e.entity_id);
        // Skip the hub's own bookkeeping entities — noise, not the house.
        if (['persistent_notification', 'zone', 'automation', 'update', 'tts'].includes(domain)) continue;
        if (kind && domain !== kind) continue;
        if (filter && !matchScore(filter, e)) continue;

        const a = e.attributes || {};
        rows.push({
            name: nameOf(e),
            entity_id: e.entity_id,
            kind: domain,
            state: e.state,
            unavailable: e.state === 'unavailable' || e.state === 'unknown',
            unit: a.unit_of_measurement || null,
            temperature: a.current_temperature ?? null,
            battery: typeof a.battery_level === 'number' ? a.battery_level : null,
            changed: e.last_changed || null,
            controllable: CONTROLLABLE.has(domain),
        });
    }

    if (!rows.length) {
        return {
            searched: filter || null,
            results: [],
            count: 0,
            instruction_for_q: filter
                ? "Nothing in the house matches that name. Tell the user you couldn't find it and offer to list what IS there — do NOT invent a device."
                : "The hub answered but listed no devices. Say exactly that; do not invent any.",
        };
    }

    // The things people actually ask about, pulled out so Q leads with them.
    const onNow = rows.filter(r => r.state === 'on' && ['light', 'switch', 'fan'].includes(r.kind)).map(r => r.name);
    const open = rows.filter(r => r.state === 'on' && r.kind === 'binary_sensor'
        && /door|window|garage|gate/i.test(r.name)).map(r => r.name);
    const unlocked = rows.filter(r => r.kind === 'lock' && r.state === 'unlocked').map(r => r.name);
    const lowBattery = rows.filter(r => r.battery !== null && r.battery <= 20)
        .map(r => `${r.name} ${r.battery}%`);
    const unavailable = rows.filter(r => r.unavailable).map(r => r.name);

    console.log(`[q-home] homeStatus OK: ${rows.length} device(s)${filter ? ' matching "' + filter + '"' : ''}`);

    return {
        searched: filter || null,
        count: rows.length,
        headline: {
            on_now: onNow,
            open: open,
            unlocked: unlocked,
            low_battery: lowBattery,
            unavailable: unavailable,
        },
        results: rows.slice(0, 60),
        truncated: rows.length > 60 ? rows.length - 60 : 0,
        instruction_for_q: READING_NOTE,
    };
}

/**
 * Turn something on or off, set a temperature, run a scene.
 *
 * @param {{what:string, action:string, temperature?:number}} args
 * @returns {Promise<Object>} never throws
 */
async function homeControl(args = {}) {
    if (!config().ready) return notReady();

    const what = String(args.what || '').trim();
    const action = String(args.action || '').toLowerCase().trim();
    if (!what) return { error: 'nothing named', instruction_for_q: "Ask the user WHICH device they mean — do not guess." };

    let states;
    try {
        states = await hub('/api/states');
    } catch (err) {
        console.warn('[q-home] homeControl FAILED (lookup): ' + err.message);
        return { error: 'could not reach the house hub', instruction_for_q: FAIL_NOTE };
    }

    const ranked = states
        .map(e => ({ e, score: matchScore(what, e) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!ranked.length) {
        return {
            error: 'no such device',
            asked_for: what,
            instruction_for_q: `Nothing in the house is called "${what}". Tell the user, and offer to list what is there. Do NOT pick something similar and switch it.`,
        };
    }

    // More than one equally good match is a question, not a coin toss.
    const top = ranked[0];
    const tied = ranked.filter(x => x.score === top.score);
    if (tied.length > 1) {
        return {
            needs_choice: true,
            asked_for: what,
            options: tied.slice(0, 6).map(x => nameOf(x.e)),
            instruction_for_q: "More than one device matches. ASK the user which one they meant and do not switch anything until they say.",
        };
    }

    const entity = top.e;
    const domain = domainOf(entity.entity_id);

    if (LOCKED_OUT.has(domain)) {
        return {
            refused: true,
            device: nameOf(entity),
            instruction_for_q: `You can SEE ${nameOf(entity)} but you are not allowed to operate it — locks, alarms, garage doors and blinds are deliberately read-only. Tell the user plainly that this one has to be done in the app or by hand, and say why: it is a safety choice, not a fault.`,
        };
    }

    if (!CONTROLLABLE.has(domain)) {
        return {
            refused: true,
            device: nameOf(entity),
            instruction_for_q: `${nameOf(entity)} is a reading, not a switch — it cannot be turned on or off. Tell the user what it currently says instead: ${entity.state}.`,
        };
    }

    // Work out the service to call.
    let service;
    const body = { entity_id: entity.entity_id };

    if (domain === 'scene' || domain === 'script') {
        service = 'turn_on';
    } else if (action === 'on' || action === 'turn_on' || action === 'start') {
        service = 'turn_on';
    } else if (action === 'off' || action === 'turn_off' || action === 'stop') {
        service = 'turn_off';
    } else if (action === 'toggle') {
        service = 'toggle';
    } else if (domain === 'climate' && args.temperature != null) {
        service = 'set_temperature';
        body.temperature = Number(args.temperature);
    } else {
        return {
            error: 'unclear action',
            device: nameOf(entity),
            instruction_for_q: "Ask the user whether they want it ON or OFF — do not assume.",
        };
    }

    try {
        await hub(`/api/services/${domain}/${service}`, { method: 'POST', body });
    } catch (err) {
        console.warn('[q-home] homeControl FAILED (service): ' + err.message);
        return {
            error: 'the house hub would not do it',
            device: nameOf(entity),
            instruction_for_q: `Tell the user plainly that ${nameOf(entity)} did NOT change — the hub refused or could not be reached. Do not claim it worked.`,
        };
    }

    // Read it back. "The hub accepted the request" is not "the light is on".
    let confirmed = null;
    try {
        const after = await hub('/api/states/' + encodeURIComponent(entity.entity_id));
        confirmed = after?.state ?? null;
    } catch (_) { /* the switch went through; the read-back is a bonus */ }

    console.log(`[q-home] homeControl OK: ${domain}.${service} on ${entity.entity_id} → ${confirmed}`);

    return {
        ok: true,
        device: nameOf(entity),
        entity_id: entity.entity_id,
        did: service.replace('_', ' '),
        state_now: confirmed,
        instruction_for_q: confirmed
            ? `Confirm briefly using state_now, which is what the house reported AFTER the change. If state_now is not what was asked for, say so honestly rather than claiming success.`
            : `The change was accepted but the state could not be read back. Say it has been sent, not that it is definitely done.`,
    };
}

module.exports = { homeStatus, homeControl };
