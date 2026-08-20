'use strict';

/**
 * Q SHOP — find a real thing, on sale right now, with a real price.
 *
 * ONE capability:
 *   searchShop()  → live products from across the open web, each with its
 *                   price, its currency, the shop selling it and a link
 *                   straight to that product's page.
 *
 * Anything a person actually needs, not just trade materials: a kettle, school
 * shoes, printer ink, a birthday present, dog food, a replacement hoover bag,
 * a drill. The same engine that prices a length of copper pipe prices a coat.
 *
 * WHERE THIS CAME FROM
 * The main Quotem app had a hardware price checker wired to a single search
 * supplier on a 250-a-month free plan. The plan ran out in August 2026 and the
 * page started telling people every shop was "not stocked" — when in truth
 * nothing had been checked at all. The fix over there became
 * server/templates/product-search.js. This is the same engine, given to Q, with
 * the trade-store filter taken off so he can look up anything.
 *
 * KEYS — environment only, never hardcoded, never logged, never returned:
 *   BRAVE_SEARCH_KEY  (required; BRAVE_API_KEY also accepted so the same code
 *                      runs on either service)
 * Env is read INSIDE the call, not at require time, so adding the key in the
 * Railway panel takes effect on the next message without a redeploy.
 *
 * HONESTY RULES BAKED IN (Sarah's firmest rule — nothing invented):
 *   · Every field is copied out of the supplier's response. A missing field
 *     comes back null, never a guess. Q never writes a price himself.
 *   · Prices ALWAYS carry their currency. Results can come back in different
 *     currencies, so a bare number is a lie.
 *   · A price is what the shop's page said when the search index last looked.
 *     It can be stale and it is NOT a stock check. The result says so, and Q
 *     is instructed to say so.
 *   · Zero results returns count: 0 and an instruction telling Q to say so
 *     plainly rather than fill the gap from memory.
 *   · No supplier is ever named in a user-facing string (house rule).
 */

const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;

// A broad everyday query ("kettle", "black school shoes") comes back with NO
// products at all, because the pages that rank for it are category pages, not
// product pages. Narrowing to one shop fixes it outright — measured 20 Aug 2026
// on "kettle": 0 products broad, then Argos 8, Amazon 6, John Lewis 5, Currys 4.
// So when the broad search comes up short, sweep a few big general retailers.
// These four between them cover most of what a household actually buys.
const SWEEP_SHOPS = ['argos.co.uk', 'amazon.co.uk', 'johnlewis.com', 'currys.co.uk'];

// Sweep only when the broad search found fewer than this many products.
const SWEEP_BELOW = 3;

// The free plan allows one request a second, so the sweep is spaced out and
// capped. Four extra calls keeps a search under ~5 seconds.
const SWEEP_GAP_MS = 1100;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'size', 'uk', 'new', 'set', 'pack', 'best', 'cheap', 'buy']);

// Colours and sizes describe the thing; they are not the thing. Matching on them
// lets anything through — "black school shoes" matched a wireless mouse, because
// the mouse came in black. Judge relevance on the noun, then let these refine it.
const MODIFIERS = new Set([
    'black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'silver', 'gold',
    'brown', 'pink', 'navy', 'cream', 'beige', 'purple', 'orange', 'yellow',
    'small', 'medium', 'large', 'mini', 'kids', 'girls', 'boys', 'mens', 'womens',
]);

/**
 * Does this product plausibly answer the question that was asked?
 *
 * Only used on SWEEP results. Narrowing to a shop with site: returns that shop's
 * products whether or not they match — searching Currys for "black school shoes
 * size 4" cheerfully offered a Logitech mouse. A broad search is already ranked
 * for the query, so it is left alone; a swept one has to earn its place by
 * sharing at least one real word with what the user asked for.
 */
function relevantTo(query, title) {
    const words = String(query).toLowerCase().match(/[a-z0-9]+/g) || [];
    const meaningful = words.filter(w => w.length >= 3 && !STOPWORDS.has(w));
    // Judge on the nouns. If the query was ONLY colours and sizes there is
    // nothing to judge on, so fall back to the full set rather than bin the lot.
    const nouns = meaningful.filter(w => !MODIFIERS.has(w));
    const judgeOn = nouns.length ? nouns : meaningful;
    if (!judgeOn.length) return true;               // nothing to judge on — keep it
    const t = String(title).toLowerCase();
    const hits = judgeOn.filter(w => t.includes(w)).length;
    // One shared word is too weak on a longer query: "dog food large breed"
    // matched an air fryer, on "food". Two words have to line up when the user
    // gave us two; a one-word request like "kettle" still only needs the one.
    return hits >= Math.min(2, judgeOn.length);
}

const CURRENCY_SYMBOL = { GBP: '£', EUR: '€', USD: '$' };

function shopKey() {
    return process.env.BRAVE_SEARCH_KEY || process.env.BRAVE_API_KEY || null;
}

/**
 * "cordless drill 18v" on its own returns Saudi shops pricing in SAR, even with
 * the country set to GB. Adding "uk" to the phrase fixes it — measured 20 Aug
 * 2026 on that exact query: 0 sterling results before, 2 after. "buy" and
 * "price" were tried too and both made coverage worse, so it is just the word.
 */
function ukBias(query) {
    return /\b(uk|united kingdom|site:)\b/i.test(query) ? query : `${query} uk`;
}

function toNumber(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return isFinite(n) ? n : null;
}

function formatPrice(amount, currency) {
    if (amount == null) return null;
    const sym = CURRENCY_SYMBOL[currency] || '';
    return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency || ''}`.trim();
}

function tidyDomain(host) {
    return String(host || '').replace(/^www\./i, '').toLowerCase();
}

/**
 * A shop the user named ("argos", "screwfix", "amazon") turned into the domain
 * to narrow the search to. Anything not on the list is used as typed, so
 * "toolstation.com" or a shop we've never heard of both still work.
 */
const KNOWN_SHOPS = {
    amazon: 'amazon.co.uk', argos: 'argos.co.uk', 'b&q': 'diy.com', bq: 'diy.com',
    screwfix: 'screwfix.com', toolstation: 'toolstation.com', wickes: 'wickes.co.uk',
    homebase: 'homebase.co.uk', ikea: 'ikea.com', currys: 'currys.co.uk',
    tesco: 'tesco.com', asda: 'asda.com', sainsburys: 'sainsburys.co.uk',
    "sainsbury's": 'sainsburys.co.uk', morrisons: 'morrisons.com', aldi: 'aldi.co.uk',
    lidl: 'lidl.co.uk', boots: 'boots.com', superdrug: 'superdrug.com',
    johnlewis: 'johnlewis.com', 'john lewis': 'johnlewis.com', next: 'next.co.uk',
    dunelm: 'dunelm.com', wilko: 'wilko.com', 'the range': 'therange.co.uk',
    ebay: 'ebay.co.uk', very: 'very.co.uk', ao: 'ao.com', halfords: 'halfords.com',
    'pets at home': 'petsathome.com', 'sports direct': 'sportsdirect.com',
    decathlon: 'decathlon.co.uk', 'toolstation.com': 'toolstation.com',
};

function shopDomain(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    if (KNOWN_SHOPS[n]) return KNOWN_SHOPS[n];
    if (n.includes('.')) return n.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return null;
}

const FAIL_NOTE = "The shop search did NOT return anything. Tell the user plainly you couldn't look it up just now — do NOT invent a product, a shop or a price, and do NOT answer from your own memory as if you had searched — and offer to try again.";

const PRICE_NOTE = "These are real listings with real prices, but a price is what the shop's page said when the search index last looked at it — it can be out of date, and it is NOT a stock check. Say that once, plainly, and give the user the link so they can see the live page. Never add prices in different currencies together. Never quote a price that is not in this result.";

/**
 * One search, turned into product rows. Only results the supplier has actually
 * tagged as a product WITH a price survive — everything else is dropped rather
 * than guessed at. Throws on a failed call; the caller decides what happens.
 */
async function fetchProducts(q, key, fallbackTitle) {
    // Always pull the full 20 and trim afterwards: only some results carry
    // product data, so asking for 5 would often come back with none.
    const url = 'https://api.search.brave.com/res/v1/web/search'
        + `?q=${encodeURIComponent(q)}&count=20&country=gb&search_lang=en`;

    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': key,
        },
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} for "${q}" — ${body.substring(0, 160)}`);
    }
    const data = await response.json();

    const rows = [];
    for (const r of (data?.web?.results || [])) {
        const p = r.product;
        if (!p) continue;

        const offer = Array.isArray(p.offers) && p.offers.length ? p.offers[0] : null;
        const currency = offer?.priceCurrency || 'GBP';
        const amount = toNumber(offer?.price ?? p.price);
        if (amount == null) continue;               // no real price = not a result

        const host = tidyDomain(r.meta_url?.hostname || '');
        rows.push({
            title: p.name || r.title || fallbackTitle,
            shop: r.profile?.name || host,
            domain: host,
            price: { amount, currency, display: formatPrice(amount, currency) },
            link: p.url || offer?.url || r.url || null,
            image: p.thumbnail?.original || p.thumbnail?.src || r.thumbnail?.original || null,
            rating: p.rating?.ratingValue ?? null,
            reviews: p.rating?.reviewCount ?? null,
        });
    }
    return rows;
}

/**
 * Search for something to buy.
 *
 * @param {{query:string, shop?:string, max_results?:number}} args
 * @param {string} [personEmail] — for cost logging by the caller; unused here.
 * @returns {Promise<Object>} never throws
 */
async function searchShop(args = {}, personEmail) {
    const query = String(args.query || '').trim();
    if (!query) {
        return { error: 'No search text given', instruction_for_q: FAIL_NOTE };
    }

    const key = shopKey();
    if (!key) {
        return {
            error: 'shop search unavailable',
            instruction_for_q: "Shop search isn't switched on yet. Tell the user plainly, don't name any provider, and carry on with the rest of what they asked.",
        };
    }

    const count = Math.min(Math.max(parseInt(args.max_results, 10) || DEFAULT_COUNT, 1), MAX_COUNT);

    // A named shop becomes a site: narrow, which reliably returns that shop's
    // own product pages instead of whatever happens to rank.
    const domain = shopDomain(args.shop);
    const q = domain ? `${query} site:${domain}` : ukBias(query);

    let rows;
    try {
        rows = await fetchProducts(q, key, query);
    } catch (err) {
        console.warn('[q-shop] shop_search FAILED: ' + err.message);
        return { error: 'shop search failed', instruction_for_q: FAIL_NOTE };
    }

    // Came up short on a general search? Go and look inside the big shops.
    const sweptShops = [];
    if (!domain && rows.length < SWEEP_BELOW) {
        for (const shopSite of SWEEP_SHOPS) {
            await sleep(SWEEP_GAP_MS);
            try {
                const extra = (await fetchProducts(`${query} site:${shopSite}`, key, query))
                    .filter(r => relevantTo(query, r.title));
                if (extra.length) sweptShops.push(shopSite);
                rows = rows.concat(extra);
            } catch (err) {
                console.warn(`[q-shop] sweep of ${shopSite} failed: ${String(err.message).slice(0, 100)}`);
            }
        }
    }

    // Two shops can list the identical product page — keep one of each link.
    const seen = new Set();
    rows = rows.filter(r => {
        const k = r.link || (r.domain + '|' + r.title);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    // Searching from the UK: if any sterling prices came back, keep only those.
    // A £-shopper has no use for a kettle priced in SAR, and mixing currencies
    // into one cheapest-first list would put nonsense at the top.
    const gbp = rows.filter(r => r.price.currency === 'GBP');
    let results = gbp.length ? gbp : rows;

    results.sort((a, b) => a.price.amount - b.price.amount);
    results = results.slice(0, count);

    if (!results.length) {
        console.warn(`[q-shop] shop_search: 0 products for "${q}"`);
        return {
            query,
            shop: args.shop || null,
            results: [],
            count: 0,
            instruction_for_q: "The search ran but found no products with prices for that. Tell the user you couldn't find it on sale — do NOT fill the gap from your own memory. Suggest they try different words, or name a shop to look in.",
        };
    }

    const currencies = [...new Set(results.map(r => r.price.currency))];
    console.log(`[q-shop] shop_search OK: ${results.length} product(s) for "${q}"`);

    return {
        query,
        shop: args.shop || null,
        searched_uk: true,
        // Named when a plain search found almost nothing and the big shops were
        // checked directly instead. It means these results are from THOSE shops,
        // not from the whole web — say so if the user asks "is that everywhere?".
        widened_to: sweptShops.length ? sweptShops : undefined,
        currencies,
        results,
        count: results.length,
        cheapest: results[0].price.display,
        instruction_for_q: PRICE_NOTE
            + (currencies.length > 1 ? ' NOTE: more than one currency is present in these results — quote each with its own currency and do not compare them as if they were the same money.' : ''),
    };
}

module.exports = { searchShop };
