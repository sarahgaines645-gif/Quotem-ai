'use strict';
/**
 * q-logos — small brand marks for the finance page (banks + merchants).
 *
 * ONE thing: a statement name ("GREGGS PLC LONDON", "NatWest") → a small
 * logo image, or "none". Nothing else.
 *
 * PRIVACY — why this is a server plugin and not an <img> to a logo CDN:
 * an <img src="https://some-logo-host/greggs.co.uk"> from the browser tells
 * that host, per user and per page view, every shop on the statement, tied
 * to the user's IP. Here the browser only ever asks Q's own server. Q's
 * server asks the upstream once per brand, ever, from Q's IP, and keeps
 * the bytes on disk — so the upstream sees "someone once wanted the Greggs
 * logo", never "this person shops at Greggs". Negatives are cached too.
 *
 * Sources, in order:
 *   1. img.logo.dev — only if LOGO_DEV_KEY is set (free tier needs a
 *      "Logos provided by Logo.dev" credit on the page; paid removes it).
 *   2. Google's favicon service — no key. Returns a generic globe for an
 *      unknown domain, so that globe is fingerprinted once and treated as
 *      "none".
 *
 * Name → domain: a UK map of banks + the shops that fill a statement, then
 * a conservative guess ({firstword}.co.uk / .com) that only survives if the
 * upstream actually has a real logo for it.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { timedFetch } = require('./timed-fetch');

const CACHE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'logo-cache')
    : path.join(__dirname, '..', 'data', 'logo-cache');
const INDEX_FILE   = path.join(CACHE_DIR, 'index.json');
const NEG_TTL_MS   = 14 * 24 * 60 * 60 * 1000;   // retry a miss after a fortnight
const FETCH_MS     = 5000;
const SIZE         = 64;                          // fetched size; shown at 16–24px
const MAX_INFLIGHT = 6;                           // polite to the upstream

// ── Bank slugs (mirror of q-finance BANK_FINGERPRINTS) → domain ────────
const BANK_DOMAINS = {
    monzo: 'monzo.com', starling: 'starlingbank.com', halifax: 'halifax.co.uk',
    bankofscot: 'bankofscotland.co.uk', lloyds: 'lloydsbank.com', barclaycard: 'barclaycard.co.uk',
    barclays: 'barclays.co.uk', firstdirect: 'firstdirect.com', hsbc: 'hsbc.co.uk',
    natwest: 'natwest.com', rbs: 'rbs.co.uk', santander: 'santander.co.uk',
    nationwide: 'nationwide.co.uk', tsb: 'tsb.co.uk', coop: 'co-operativebank.co.uk',
    metro: 'metrobankonline.co.uk', virgin: 'virginmoney.com', revolut: 'revolut.com',
    chase: 'chase.co.uk', monument: 'monument.co', kroo: 'kroo.com', zopa: 'zopa.com',
    marcus: 'marcus.co.uk', tide: 'tide.co', mettle: 'mettle.co.uk', wise: 'wise.com',
    anna: 'anna.money', countingup: 'countingup.com', cashplus: 'cashplus.com',
    zempler: 'zemplerbank.com', allica: 'allica.bank', oaknorth: 'oaknorth.co.uk',
    shawbrook: 'shawbrook.co.uk', aldermore: 'aldermore.co.uk', unitytrust: 'unity.co.uk',
    handelsbank: 'handelsbanken.co.uk', cynergy: 'cynergybank.co.uk', triodos: 'triodos.co.uk',
    recognise: 'recognisebank.co.uk', gbbank: 'gbbank.co.uk', atom: 'atombank.co.uk',
    paypal: 'paypal.com', amex: 'americanexpress.com', capitalone: 'capitalone.co.uk',
    vanquis: 'vanquis.co.uk', mbna: 'mbna.co.uk', tescobank: 'tescobank.com',
    sainsburys: 'sainsburysbank.co.uk', postoffice: 'postoffice.co.uk', newday: 'newday.co.uk',
    jaja: 'jajafinance.com', zable: 'zable.co.uk', johnlewis: 'johnlewisfinance.com',
};

// ── Merchant aliases → domain. Keys are lower-case, alphanumeric+space,
// matched as a whole-word prefix of the cleaned statement name. Longer
// aliases win, so "tesco bank" beats "tesco".
const MERCHANT_DOMAINS = {
    // supermarkets & shops
    'tesco': 'tesco.com', 'sainsburys': 'sainsburys.co.uk', 'sainsbury': 'sainsburys.co.uk',
    'asda': 'asda.com', 'morrisons': 'morrisons.com', 'aldi': 'aldi.co.uk', 'lidl': 'lidl.co.uk',
    'waitrose': 'waitrose.com', 'iceland': 'iceland.co.uk', 'coop': 'coop.co.uk', 'co op': 'coop.co.uk',
    'marks spencer': 'marksandspencer.com', 'm s': 'marksandspencer.com', 'ms simply food': 'marksandspencer.com',
    'boots': 'boots.com', 'superdrug': 'superdrug.com', 'argos': 'argos.co.uk', 'b q': 'diy.com', 'bq': 'diy.com',
    'screwfix': 'screwfix.com', 'toolstation': 'toolstation.com', 'wickes': 'wickes.co.uk',
    'homebase': 'homebase.co.uk', 'ikea': 'ikea.com', 'currys': 'currys.co.uk', 'john lewis': 'johnlewis.com',
    'next': 'next.co.uk', 'primark': 'primark.com', 'h m': 'hm.com', 'zara': 'zara.com', 'tk maxx': 'tkmaxx.com',
    'sports direct': 'sportsdirect.com', 'jd sports': 'jdsports.co.uk', 'the range': 'therange.co.uk',
    'b m': 'bmstores.co.uk', 'home bargains': 'homebargains.co.uk', 'poundland': 'poundland.co.uk',
    'wilko': 'wilko.com', 'dunelm': 'dunelm.com', 'halfords': 'halfords.com', 'pets at home': 'petsathome.com',
    'wh smith': 'whsmith.co.uk', 'whsmith': 'whsmith.co.uk', 'waterstones': 'waterstones.com',
    'smyths': 'smythstoys.com', 'matalan': 'matalan.co.uk', 'new look': 'newlook.com', 'card factory': 'cardfactory.co.uk',
    'amazon': 'amazon.co.uk', 'amznmktplace': 'amazon.co.uk', 'amzn': 'amazon.co.uk', 'amazon prime': 'amazon.co.uk',
    'ebay': 'ebay.co.uk', 'etsy': 'etsy.com', 'vinted': 'vinted.co.uk', 'temu': 'temu.com', 'shein': 'shein.co.uk',
    'apple': 'apple.com', 'apple com bill': 'apple.com', 'itunes': 'apple.com', 'google': 'google.com',
    'microsoft': 'microsoft.com', 'playstation': 'playstation.com', 'nintendo': 'nintendo.co.uk', 'steam': 'steampowered.com',
    // food & coffee
    'greggs': 'greggs.co.uk', 'starbucks': 'starbucks.co.uk', 'costa': 'costa.co.uk', 'costa coffee': 'costa.co.uk',
    'caffe nero': 'caffenero.com', 'pret': 'pret.co.uk', 'pret a manger': 'pret.co.uk', 'mcdonalds': 'mcdonalds.com',
    'mcdonald s': 'mcdonalds.com', 'burger king': 'burgerking.co.uk', 'kfc': 'kfc.co.uk', 'subway': 'subway.com',
    'dominos': 'dominos.co.uk', 'domino s': 'dominos.co.uk', 'papa johns': 'papajohns.co.uk', 'pizza hut': 'pizzahut.co.uk',
    'nandos': 'nandos.co.uk', 'nando s': 'nandos.co.uk', 'wetherspoon': 'jdwetherspoon.com', 'j d wetherspoon': 'jdwetherspoon.com',
    'deliveroo': 'deliveroo.co.uk', 'just eat': 'just-eat.co.uk', 'justeat': 'just-eat.co.uk', 'uber eats': 'ubereats.com',
    'ubereats': 'ubereats.com', 'uber': 'uber.com', 'bolt': 'bolt.eu', 'toby carvery': 'tobycarvery.co.uk',
    'harvester': 'harvester.co.uk', 'wagamama': 'wagamama.com', 'five guys': 'fiveguys.co.uk', 
    'tim hortons': 'timhortons.co.uk', 'krispy kreme': 'krispykreme.co.uk', 'itsu': 'itsu.com', 'wasabi': 'wasabi.uk.com',
    // fuel & travel
    'shell': 'shell.co.uk', 'bp': 'bp.com', 'esso': 'esso.co.uk', 'texaco': 'texaco.co.uk', 'tesco pfs': 'tesco.com',
    'sainsburys pfs': 'sainsburys.co.uk', 'asda pfs': 'asda.com', 'morrisons pfs': 'morrisons.com',
    'gulf': 'gulfretail.co.uk', 'jet2': 'jet2.com', 'tfl': 'tfl.gov.uk', 'tfl travel': 'tfl.gov.uk', 'transport for london': 'tfl.gov.uk',
    'trainline': 'thetrainline.com', 'national rail': 'nationalrail.co.uk', 'national express': 'nationalexpress.com',
    'stagecoach': 'stagecoachbus.com', 'arriva': 'arrivabus.co.uk', 'first bus': 'firstbus.co.uk', 'gwr': 'gwr.com',
    'southern': 'southernrailway.com', 'thameslink': 'thameslink.com', 'swr': 'southwesternrailway.com',
    'south western railway': 'southwesternrailway.com', 'lner': 'lner.co.uk', 'avanti': 'avantiwestcoast.co.uk',
    'easyjet': 'easyjet.com', 'ryanair': 'ryanair.com', 'jet2': 'jet2.com', 'british airways': 'britishairways.com',
    'tui': 'tui.co.uk', 'booking com': 'booking.com', 'airbnb': 'airbnb.co.uk', 'premier inn': 'premierinn.com',
    'travelodge': 'travelodge.co.uk', 'ringgo': 'myringgo.co.uk', 'paybyphone': 'paybyphone.co.uk', 'justpark': 'justpark.com',
    'dvla': 'gov.uk', 'ncp': 'ncp.co.uk', 'aa': 'theaa.com', 'the aa': 'theaa.com', 'rac': 'rac.co.uk',
    // bills, phones, energy, water
    'ee': 'ee.co.uk', 'o2': 'o2.co.uk', 'vodafone': 'vodafone.co.uk', 'three': 'three.co.uk', 'giffgaff': 'giffgaff.com',
    'tesco mobile': 'tescomobile.com', 'sky': 'sky.com', 'sky mobile': 'sky.com', 'sky digital': 'sky.com',
    'bt': 'bt.com', 'bt group': 'bt.com', 'virgin media': 'virginmedia.com', 'virgin mobile': 'virginmedia.com',
    'talktalk': 'talktalk.co.uk', 'plusnet': 'plus.net', 'now tv': 'nowtv.com', 'lebara': 'lebara.co.uk',
    'smarty': 'smarty.co.uk', 'voxi': 'voxi.co.uk', 'id mobile': 'idmobile.co.uk', 'octopus energy': 'octopus.energy',
    'octopus': 'octopus.energy', 'british gas': 'britishgas.co.uk', 'eon': 'eonenergy.com', 'e on': 'eonenergy.com',
    'eon next': 'eonnext.com', 'e on next': 'eonnext.com', 'ovo': 'ovoenergy.com', 'ovo energy': 'ovoenergy.com',
    'edf': 'edfenergy.com', 'edf energy': 'edfenergy.com', 'scottish power': 'scottishpower.co.uk', 'scottishpower': 'scottishpower.co.uk',
    'sse': 'sse.co.uk', 'shell energy': 'shellenergy.co.uk', 'utilita': 'utilita.co.uk', 'utility warehouse': 'uw.co.uk',
    'so energy': 'so.energy', 'bulb': 'bulb.co.uk', 'thames water': 'thameswater.co.uk', 'anglian water': 'anglianwater.co.uk',
    'severn trent': 'stwater.co.uk', 'southern water': 'southernwater.co.uk', 'south east water': 'southeastwater.co.uk',
    'yorkshire water': 'yorkshirewater.com', 'united utilities': 'unitedutilities.com', 'welsh water': 'dwrcymru.com',
    'wessex water': 'wessexwater.co.uk', 'affinity water': 'affinitywater.co.uk', 'tv licence': 'tvlicensing.co.uk',
    'tv licensing': 'tvlicensing.co.uk', 'hmrc': 'gov.uk', 'dwp': 'gov.uk', 'gov uk': 'gov.uk',
    // subscriptions & money
    'netflix': 'netflix.com', 'spotify': 'spotify.com', 'disney plus': 'disneyplus.com', 'disney': 'disneyplus.com',
    'prime video': 'primevideo.com', 'youtube': 'youtube.com', 'audible': 'audible.co.uk', 'kindle': 'amazon.co.uk',
    'apple music': 'apple.com', 'icloud': 'apple.com', 'dropbox': 'dropbox.com', 'adobe': 'adobe.com', 'canva': 'canva.com',
    'openai': 'openai.com', 'chatgpt': 'openai.com', 'anthropic': 'anthropic.com', 'claude ai': 'anthropic.com',
    'github': 'github.com', 'railway': 'railway.app', 'netlify': 'netlify.com', 'ionos': 'ionos.co.uk', 'godaddy': 'godaddy.com',
    'puregym': 'puregym.com', 'the gym': 'thegymgroup.com', 'david lloyd': 'davidlloyd.co.uk', 'nuffield': 'nuffieldhealth.com',
    'klarna': 'klarna.com', 'clearpay': 'clearpay.co.uk', 'paypal': 'paypal.com', 'sumup': 'sumup.com', 'zettle': 'zettle.com',
    'square': 'squareup.com', 'stripe': 'stripe.com', 'wise': 'wise.com', 'revolut': 'revolut.com', 'monzo': 'monzo.com',
    'starling': 'starlingbank.com', 'natwest': 'natwest.com', 'barclays': 'barclays.co.uk', 'lloyds': 'lloydsbank.com',
    'halifax': 'halifax.co.uk', 'hsbc': 'hsbc.co.uk', 'santander': 'santander.co.uk', 'nationwide': 'nationwide.co.uk',
    'tsb': 'tsb.co.uk', 'admiral': 'admiral.com', 'aviva': 'aviva.co.uk', 'direct line': 'directline.com',
    'churchill': 'churchill.com', 'hastings': 'hastingsdirect.com', 'lv': 'lv.com', 'compare the market': 'comparethemarket.com',
    'experian': 'experian.co.uk', 'clearscore': 'clearscore.com', 'creditkarma': 'creditkarma.co.uk',
    'national lottery': 'national-lottery.co.uk', 'camelot': 'national-lottery.co.uk', 'post office': 'postoffice.co.uk',
    'royal mail': 'royalmail.com', 'evri': 'evri.com', 'dpd': 'dpd.co.uk', 'parcelforce': 'parcelforce.com',
    'specsavers': 'specsavers.co.uk', 'vision express': 'visionexpress.com', 'lloyds pharmacy': 'lloydspharmacy.com',
    'nhs': 'nhs.uk', 'bupa': 'bupa.co.uk', 'vitality': 'vitality.co.uk', 'cineworld': 'cineworld.co.uk', 'odeon': 'odeon.co.uk',
    'vue': 'myvue.com', 'ticketmaster': 'ticketmaster.co.uk',
};

// Ordered longest-first so multi-word aliases win.
const ALIASES = Object.keys(MERCHANT_DOMAINS).sort((a, b) => b.length - a.length);

// Statement furniture that isn't part of the brand name.
const NOISE_PREFIX = /^(?:card payment to|card payment|payment to|direct debit to|direct debit|standing order to|standing order|faster payment to|faster payments|contactless payment|contactless|purchase|dd|so|fpo|fpi|bgc|chq|pos|vis|deb|cr|dr|tfr)\s+/i;
// Payment processors that prefix the real shop: "SQ *CORNER CAFE", "PAYPAL *NETFLIX".
const PROCESSOR_PREFIX = /^(?:sp|sq|iz|pp|paypal|google|zettle|sumup|square)\s*[*_]\s*/i;
const NOISE_WORDS  = new Set(['ltd', 'limited', 'plc', 'uk', 'gb', 'gbr', 'the', 'and', 'of', 'inc', 'llc', 'co', 'store', 'stores',
    'online', 'internet', 'www', 'com', 'couk', 'card', 'payment', 'purchase', 'contactless', 'london', 'ref', 'visa', 'debit', 'mastercard']);

function cleanName(raw) {
    let s = String(raw || '').toLowerCase().replace(/[\u2019']/g, '');
    s = s.replace(NOISE_PREFIX, '').replace(PROCESSOR_PREFIX, '');
    s = s.replace(/[*#|_\/\,.:;()\[\]{}"&+=-]+/g, ' ');
    // Drop reference tokens (letters+digits, 6+ chars — "jet2" and "o2" survive) and pure numbers.
    s = s.split(/\s+/).filter(w => w && !/^\d+$/.test(w) && !(w.length >= 6 && /\d/.test(w))).join(' ');
    return s.replace(/\s+/g, ' ').trim();
}

/** Statement name → { domain, key } or null when nothing sensible can be guessed. */
function guessDomain(raw) {
    const s = cleanName(raw);
    if (!s) return null;
    const padded = ' ' + s + ' ';
    for (const a of ALIASES) {
        // Whole-word prefix ("greggs plc" ⊃ "greggs"). Long aliases may also
        // sit mid-string ("dd octopus energy"); short ones must lead, so
        // "three" or "next" inside an unrelated name never light up.
        if (padded.startsWith(' ' + a + ' ') || (a.length >= 6 && padded.includes(' ' + a + ' '))) {
            return { domain: MERCHANT_DOMAINS[a], key: a.replace(/\s+/g, '') };
        }
    }
    // Unknown name. Only a SINGLE brand-shaped token gets a guessed domain
    // ("wagamama" → wagamama.co.uk / .com) and only survives if the upstream
    // really has a logo for it. Two-plus words ("J SMITH", "THE CORNER
    // CAFE", "COUNCIL TAX") get the monogram — a wrong logo is worse than none.
    const words = s.split(' ').filter(w => !NOISE_WORDS.has(w));
    if (words.length !== 1 || !/^[a-z]{5,}$/.test(words[0])) return null;
    const w = words[0];
    return { domain: null, key: w, candidates: [w + '.co.uk', w + '.com'] };
}

// ── Cache ─────────────────────────────────────────────────────────────
let _index = null;
function loadIndex() {
    if (_index) return _index;
    try { _index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) || {}; }
    catch { _index = {}; }
    return _index;
}
let _saveTimer = null;
function saveIndexSoon() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            fs.writeFileSync(INDEX_FILE, JSON.stringify(_index));
        } catch (e) { console.warn('[q-logos] index save failed:', e.message); }
    }, 500);
}

// ── Upstream ──────────────────────────────────────────────────────────
let _inflight = 0;
const _queue = [];
function slot() {
    return new Promise(res => {
        const go = () => { _inflight++; res(() => { _inflight--; const n = _queue.shift(); if (n) n(); }); };
        if (_inflight < MAX_INFLIGHT) go(); else _queue.push(go);
    });
}

const _pending = new Map();   // domain -> Promise<{buf,mime}|null>

let _googleDefaultHash = null;
async function googleDefaultHash() {
    if (_googleDefaultHash) return _googleDefaultHash;
    const r = await fetchBytes(`https://www.google.com/s2/favicons?domain=no-such-brand-q-${SIZE}.invalid&sz=${SIZE}`);
    _googleDefaultHash = r ? sha1(r.buf) : 'unknown';
    return _googleDefaultHash;
}
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

async function fetchBytes(url) {
    try {
        const r = await timedFetch(url, { redirect: 'follow' }, { timeoutMs: FETCH_MS, label: 'logo' });
        if (!r.ok) return null;
        const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
        if (!/^image\//.test(mime)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 120 || buf.length > 400_000) return null;
        return { buf, mime };
    } catch { return null; }
}

async function fetchDomainLogo(domain) {
    const key = process.env.LOGO_DEV_KEY;
    if (key) {
        const r = await fetchBytes(`https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(key)}&size=${SIZE}&format=png&fallback=404`);
        if (r) return r;
    }
    const g = await fetchBytes(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${SIZE}`);
    if (!g) return null;
    if (sha1(g.buf) === await googleDefaultHash()) return null;   // the "unknown site" globe
    return g;
}

function fetchDomainLogoOnce(domain) {
    if (_pending.has(domain)) return _pending.get(domain);
    const p = (async () => {
        const release = await slot();
        try { return await fetchDomainLogo(domain); } finally { release(); }
    })().finally(() => _pending.delete(domain));
    _pending.set(domain, p);
    return p;
}

function extOf(mime) { return mime === 'image/svg+xml' ? 'svg' : mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon' ? 'ico' : 'png'; }

/**
 * @param {{ name?: string, bank?: string }} q
 * @returns {Promise<{buf:Buffer, mime:string}|null>}
 */
async function getLogo({ name, bank } = {}) {
    let key, candidates;
    if (bank && BANK_DOMAINS[String(bank).toLowerCase()]) {
        key = 'bank:' + String(bank).toLowerCase();
        candidates = [BANK_DOMAINS[String(bank).toLowerCase()]];
    } else {
        const g = guessDomain(name);
        if (!g) return null;
        key = 'm:' + g.key;
        candidates = g.domain ? [g.domain] : g.candidates;
    }
    const idx = loadIndex();
    const hit = idx[key];
    if (hit) {
        if (hit.file) {
            try { return { buf: fs.readFileSync(path.join(CACHE_DIR, hit.file)), mime: hit.mime }; }
            catch { /* file gone — refetch below */ }
        } else if (Date.now() - (hit.at || 0) < NEG_TTL_MS) {
            return null;
        }
    }
    for (const domain of candidates) {
        const r = await fetchDomainLogoOnce(domain);
        if (r) {
            const file = key.replace(/[^a-z0-9]/gi, '_') + '.' + extOf(r.mime);
            try {
                fs.mkdirSync(CACHE_DIR, { recursive: true });
                fs.writeFileSync(path.join(CACHE_DIR, file), r.buf);
            } catch (e) { console.warn('[q-logos] cache write failed:', e.message); }
            idx[key] = { domain, file, mime: r.mime, at: Date.now() };
            saveIndexSoon();
            return r;
        }
    }
    idx[key] = { at: Date.now() };
    saveIndexSoon();
    return null;
}

module.exports = { getLogo, guessDomain, cleanName, BANK_DOMAINS, MERCHANT_DOMAINS };
