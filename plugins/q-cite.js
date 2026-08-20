/**
 * Q CITE — accurate sources for a claim, Harvard in code, never invented.
 *
 * Sarah, 15 Aug 2026 (23:40): "Put your cursor at the end of a sentence and
 * press AUTO CITE: it finds a list of citations you can use; press one and it
 * puts it in as a Harvard ref. This has to be ACCURATE."
 *
 *   findSources({ claimSentence, subject, level, uploadedSources, max, extractMeta })
 *     → { candidates: [...], searched: { uploads, openalex, crossref }, note }
 *   Each candidate: { id, title, authors:[{family, given}], year, type, journal,
 *     volume, issue, pages, publisher, place, doi, url, citedBy, fromUpload,
 *     sourceName, snippet, inText, reference, warnings[] }
 *
 * Order and rules:
 *   1. UPLOADED SOURCES FIRST — matched by content (the claim's key words found
 *      in the source text; the best-matching sentence returned as `snippet`).
 *      Bibliographic details come from the source's own front matter / reference
 *      line: heuristics first (year, DOI, "by …" line, title line); when they
 *      cannot find author + year, an optional `extractMeta(source)` (a small
 *      structured model read of the first page — cached by the caller) fills
 *      what the TEXT states, null otherwise. Nothing is guessed.
 *   2. Then REAL PUBLISHED WORK from a real index: OpenAlex
 *      (https://api.openalex.org/works?search=… free, no key; polite `mailto`
 *      from OPENALEX_MAILTO when set), CrossRef as the fallback. Only verified
 *      metadata (title, authors, year, venue/publisher, DOI) is returned;
 *      retracted works and works with no author or year are dropped.
 *   3. HARVARD is formatted in code from the metadata (author–date in-text:
 *      "(Armstrong and Brown, 2019)"; reference list per Cite Them Right):
 *      never a model-written reference.
 *   4. Results cached per query (24h, in memory). Every index call is counted
 *      through logUsage (kind 'lookup', free) so the cost meter sees the volume.
 *   5. Nothing found → { candidates: [] } and a plain `note` — the caller says
 *      so and offers the References tool. Never a fabricated source.
 *
 * Subject-neutral by design: the query is the sentence's own words (+ the
 * brief's subject when the sentence is short); law, nursing, history, GCSE
 * English, engineering, business… all go through the same two indexes.
 *
 * `deps.fetchJson(url)` is overridable so tests run with a canned index.
 */
'use strict';

const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');

const OPENALEX = 'https://api.openalex.org/works';
const CROSSREF = 'https://api.crossref.org/works';
const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();   // key → { at, result }

const STOP = new Set(('a an the and or but if so as of to in on at by for from with without into onto over under about above below between among ' +
    'is are was were be been being am do does did done have has had having will would shall should can could may might must ' +
    'this that these those it its they them their there here where when which who whom whose what why how than then thus ' +
    'i me my we our you your he him his she her not no nor very more most much many some any each every all both few such ' +
    'also just only even still yet however therefore because while although though since until because also often usually ' +
    'one two three first second new old same other another own out up down off again further once').split(/\s+/));

const deps = {
    async fetchJson(url, { headers } = {}) {
        const res = await timedFetch(url, { headers: { accept: 'application/json', ...(headers || {}) } }, { timeoutMs: 15000, label: 'cite' });
        if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
        return res.json();
    },
};

// ── Query words: the sentence's own terms, no stopwords, no numbers alone ──
function keywords(text, max = 10) {
    const seen = new Set(); const out = [];
    for (const w of String(text || '').toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9\-\s]/g, ' ').split(/\s+/)) {
        const t = w.replace(/^-+|-+$/g, '');
        if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t) || seen.has(t)) continue;
        seen.add(t); out.push(t);
        if (out.length >= max) break;
    }
    return out;
}
// Words that carry no topic — they match anything in a 250m-work index.
const WEAK = new Set(('staff people person company companies work works working job jobs good bad better best help ' +
    'helps need needs use uses used thing things way ways time times year years give gives given take takes lot ' +
    'part parts side sides show shows say says come comes let lets make makes made get gets').split(' '));

// Measured against the live OpenAlex index, 16 Aug. The whole sentence as a
// bag of words is the worst possible query: "flexible benefits schemes let
// staff choose the perks that suit them" returned forestry, the gig economy
// and a paper on airway syndrome in pugs — all real, all verified, all
// useless, and a wrong citation is the first thing a marker circles.
//
// What works is quoting the concept the student names at the FRONT of the
// sentence ("total reward", "flexible benefits") and dropping the filler
// after it. Same sentence, that query: "The Impact of Flexible Benefits Plan
// on Organisational Commitment and Intention to Quit". The subject is
// deliberately NOT appended — it swamps the topic and returns generic field
// surveys ("A Systematic Review of Human Resource Management Systems").
function buildQuery(claimSentence, subject, hint, exclude) {
    // Sarah, 16 Aug: "This is a classic example of the Equity Theory (Kang et
    // al., 2010)" found nothing, because the first two content words are
    // "classic example". A student frames before they name the thing, so the
    // concept is rarely at the front. Two better signals, tried first:
    //
    //  - A capitalised phrase mid-sentence is almost always the term. She
    //    wrote "Equity Theory" with capitals; students do that with the idea
    //    they have been taught.
    //  - A phrase ending in a concept noun — theory, model, effect, doctrine —
    //    is the term wherever it sits in the sentence.
    //
    // Any citation already in the sentence is stripped first: "(Kang et al.,
    // 2010)" would otherwise put an author's surname into the search.
    let cleaned = String(claimSentence || '').replace(/\([^)]*\d{4}[a-z]?\)/g, ' ').replace(/\s+/g, ' ').trim();
    // THE CASE STUDY'S OWN NAME IS NOT A SEARCH TERM. "There is already a
    // shortage at Portstride" put a fictional company into an academic index
    // (Sarah, 17 Aug: "why do I only have the choice for weak citations") — it
    // matches nothing, so the search fell back to shortage / gap / grow and
    // answered with infrastructure economics, New Zealand water engineers and
    // the global chip shortage. The names of the things in HER case come out
    // before the query is built.
    for (const name of (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean)) {
        const n = String(name).trim();
        if (n.length < 3) continue;
        const target = n.toLowerCase();
        let i = cleaned.toLowerCase().indexOf(target);
        while (i >= 0) {
            cleaned = cleaned.slice(0, i) + ' ' + cleaned.slice(i + n.length);
            i = cleaned.toLowerCase().indexOf(target, i);
        }
    }
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Measured on the live index: the named concept ON ITS OWN is the best
    // query there is. "Equity Theory" returns "Equity: theory and research"
    // and "What Should Be Done with Equity Theory?". The same phrase padded
    // with the rest of her sentence — "classic example favoured" — returns
    // children's judgments of resource distribution and the evolution of
    // fairness by partner choice. Her framing words are noise to an index, so
    // once the concept is named, nothing else goes in. Relevance filtering and
    // the field sort below do the narrowing instead.
    const named = namedConcept(cleaned);
    if (named) return '"' + named + '"';
    // THE IDEA THIS PART IS SUPPOSED TO NAME. Sarah, 17 Aug: "why do I only
    // have the choice for weak citations" — her sentence was "there is already
    // a shortage at Portstride so this gap will grow", whose only content
    // words are shortage / gap / grow / problem. Those are real words in every
    // field on earth, so the index answered with a 1999 infrastructure paper,
    // New Zealand water engineers and the global chip shortage: all real, all
    // useless. When she has not named a concept, the plan's expected term for
    // this part is the concept, and it goes in first.
    const hinted = String(hint || '').replace(/\s+/g, ' ').trim();
    if (hinted && hinted.split(' ').length <= 6) return '"' + hinted + '"';
    const kw = keywords(cleaned, 12);
    const strong = kw.filter(w => !WEAK.has(w));
    // GENERIC ON ITS OWN IS NOT A QUERY. With nothing but everyday nouns, the
    // field is the only thing that makes the search mean anything — the
    // opposite of the named-concept case, where the subject swamps the topic.
    // "already", "very", "quite" — framing words that survive keywords();
    //  the test is whether anything SUBJECT-BEARING is left, not whether every
    //  single word is on the list.
    const bearing = strong.filter(w => !GENERIC.has(w) && !FRAMING.has(w));
    const generic = strong.length && !bearing.length;
    if (generic && subject) {
        const subjWords = keywords(subject, 3);
        if (subjWords.length) return strong.slice(0, 3).concat(subjWords).join(' ');
    }
    if (strong.length < 2) {
        const fallback = strong.concat(kw.filter(w => !strong.includes(w))).slice(0, 5);
        if (fallback.length < 4 && subject) for (const w of keywords(subject, 4)) if (!fallback.includes(w)) fallback.push(w);
        return fallback.join(' ');
    }
    // Quote the phrase AS WRITTEN, not the two keywords glued together:
    // keywords() drops "of", which would turn "the doctrine of precedent" into
    // "doctrine precedent" — a phrase that appears in no paper on earth, and
    // the law fixture came back empty. Take the span of the original sentence
    // from the first strong word to the second, and only quote it if it is
    // still short enough to be a real term.
    const span = phraseSpan(cleaned, strong[0], strong[1]);
    // "doctrine of precedent" is a term. "Photosynthesis lets plants" is a
    // sentence fragment, and quoting it asks the index for something nobody
    // ever wrote. Only join the two words when what sits between them is a
    // connector; otherwise quote the concept on its own.
    const phrase = span && isTermSpan(span) ? '"' + span + '"' : '"' + strong[0] + '"';
    return (phrase + ' ' + strong.slice(1, 5).filter(w => !phrase.includes(w)).join(' ')).trim();
}
// The named idea in a sentence: a capitalised phrase that isn't the opening
// word, or a phrase ending in a concept noun. Subject-neutral — "Equity
// Theory", "the doctrine of precedent", "the Bolam test", "the Krebs cycle".
const CONCEPT_NOUNS = ['theory', 'theories', 'model', 'models', 'effect', 'effects', 'principle', 'principles',
    'framework', 'frameworks', 'doctrine', 'hypothesis', 'cycle', 'law', 'act', 'test', 'rule', 'method',
    'approach', 'syndrome', 'process', 'system', 'strategy', 'bias', 'paradox', 'equation'];
function namedConcept(sentence) {
    const s = String(sentence || '').trim();
    if (!s) return '';
    const words = s.split(/\s+/);
    // A run of capitalised words that does not start the sentence.
    let run = [];
    const runs = [];
    for (let i = 0; i < words.length; i++) {
        const raw = words[i].replace(/[^\w'-]/g, '');
        const isCap = /^[A-Z][a-z'-]{1,}$/.test(raw);
        if (isCap && i > 0) run.push(raw);
        else { if (run.length >= 2) runs.push(run.join(' ')); run = []; }
    }
    if (run.length >= 2) runs.push(run.join(' '));
    if (runs.length) return runs.sort((a, b) => b.split(' ').length - a.split(' ').length)[0];
    // A phrase ending in a concept noun: take it and the word before it.
    const low = words.map(w => w.replace(/[^\w'-]/g, '').toLowerCase());
    for (let i = low.length - 1; i > 0; i--) {
        if (!CONCEPT_NOUNS.includes(low[i])) continue;
        const before = low[i - 1];
        if (!before || STOP.has(before) || WEAK.has(before)) continue;
        return words.slice(i - 1, i + 1).join(' ').replace(/[^\w\s'-]/g, '').trim();
    }
    return '';
}
// Framing words a student writes around the point (they are not the point).
const FRAMING = new Set(('already still also just really very quite often always never sometimes many much more '
    + 'most less least often lots plenty perhaps maybe clearly obviously simply generally usually').split(' '));
// Words that name a situation, not a subject: alone they match every field.
const GENERIC = new Set(('shortage shortages gap gaps problem problems issue issues challenge challenges '
    + 'increase increases increasing rising rise grow growth growing fall falling decline declining change '
    + 'changes impact impacts effect effects cost costs benefit benefits risk risks number numbers level '
    + 'levels rate rates result results situation situations trend trends demand supply pressure pressures').split(' '));
const CONNECTORS = new Set(['of', 'in', 'on', 'for', 'and', 'the', 'a', 'to', 'by', 'at', 'with', 'from']);
function isTermSpan(span) {
    const words = span.split(' ');
    if (words.length > 4) return false;
    return words.slice(1, -1).every(w => CONNECTORS.has(w.toLowerCase()));
}
function phraseSpan(sentence, first, second) {
    const s = String(sentence || '');
    const low = s.toLowerCase();
    const a = low.indexOf(first);
    if (a < 0) return '';
    const b = low.indexOf(second, a + first.length);
    if (b < 0) return '';
    return s.slice(a, b + second.length).replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Is this work actually ABOUT the sentence? An index result that shares no
// word with what the student wrote is the pugs paper. Uploads are exempt —
// they were matched on the student's own source text already.
// This is a CHEAP first pass, not a relevance judgement, and it must stay
// generous. Sarah, 17 Aug: Auto cite offered "Choking under pressure: Multiple
// routes to skill failure" (sports psychology) against a sentence about AI
// taking away the skill set needed to do a job — one shared word, "skill".
// Tightening this to two shared words was tried and REVERTED: measured against
// the same sentence it also drops "Automation, algorithmic management and the
// deskilling of warehouse work", because the student's other keywords ("take",
// "away", "needed", "perform") are framing words that never appear in an
// academic title. Word overlap cannot tell relevance from coincidence here.
// The real gate is the semantic one — judgeCiteCandidates can now answer
// `none`, and /writer/cite drops those before she ever sees them.
function isRelevant(work, kw) {
    const want = kw.filter(w => w.length > 3 && !WEAK.has(w));
    if (!want.length) return true;
    const hay = ((work && work.title) || '') + ' ' + ((work && (work.journal || work.publisher)) || '');
    const low = hay.toLowerCase();
    return want.some(w => low.includes(w));
}

// ── Names ─────────────────────────────────────────────────────────────────
function splitDisplayName(name) {
    const s = String(name || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (s.includes(',')) { const [family, given] = s.split(',').map(x => x.trim()); return { family, given: given || '' }; }
    const parts = s.split(' ');
    if (parts.length === 1) return { family: parts[0], given: '' };
    // "van der Berg" style particles stay with the family name
    let i = parts.length - 1; while (i > 0 && /^(van|von|de|der|den|del|della|di|da|le|la|du|dos|das)$/i.test(parts[i - 1])) i--;
    return { family: parts.slice(i).join(' '), given: parts.slice(0, i).join(' ') };
}
function initials(given) {
    return String(given || '').replace(/[.]/g, ' ').split(/[\s\-]+/).filter(Boolean).map(x => x[0].toUpperCase() + '.').join('');
}
function authorList(authors) {
    return (Array.isArray(authors) ? authors : []).map(a => typeof a === 'string' ? splitDisplayName(a) : (a && a.family ? { family: String(a.family).trim(), given: String(a.given || '').trim() } : (a && a.name ? splitDisplayName(a.name) : null))).filter(a => a && a.family);
}
function joinNames(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
function shortTitle(title) { const words = String(title || '').split(/\s+/).filter(Boolean); return words.slice(0, 4).join(' ') + (words.length > 4 ? '…' : ''); }

// ── Harvard (Cite Them Right) — from metadata only ────────────────────────
function harvardInText(meta) {
    const as = authorList(meta && meta.authors);
    const year = meta && meta.year ? String(meta.year) : 'n.d.';
    if (!as.length) return '(' + (meta && meta.title ? shortTitle(meta.title) : 'Unknown') + ', ' + year + ')';
    if (as.length === 1) return '(' + as[0].family + ', ' + year + ')';
    if (as.length === 2) return '(' + as[0].family + ' and ' + as[1].family + ', ' + year + ')';
    return '(' + as[0].family + ' et al., ' + year + ')';
}
function refAuthors(as) {
    return joinNames(as.map(a => a.family + (initials(a.given) ? ', ' + initials(a.given) : '')));
}
function tidyTitle(t) { return String(t || '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, ''); }
function accessedToday() { const d = new Date(); return d.getDate() + ' ' + d.toLocaleString('en-GB', { month: 'long' }) + ' ' + d.getFullYear(); }
function harvardReference(meta) {
    const as = authorList(meta && meta.authors);
    const year = meta && meta.year ? String(meta.year) : 'n.d.';
    const title = tidyTitle(meta && meta.title);
    const type = String((meta && meta.type) || 'other');
    const who = as.length ? refAuthors(as) : '';
    const head = who ? who + ' (' + year + ') ' : title + ' (' + year + ')';
    let out;
    if (type === 'article') {
        const vol = meta.volume ? String(meta.volume) : '';
        const iss = meta.issue ? '(' + meta.issue + ')' : '';
        const pages = meta.pages ? ', pp. ' + String(meta.pages).replace(/-/g, '–') : '';
        out = head + (who ? "'" + title + "'" : '') + (meta.journal ? ', ' + tidyTitle(meta.journal) : '') + (vol || iss ? ', ' + vol + iss : '') + pages + '.';
        if (meta.doi) out += ' Available at: https://doi.org/' + String(meta.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') + '.';
    } else if (type === 'chapter') {
        const eds = authorList(meta.editors);
        out = head + (who ? "'" + title + "'" : '') + (meta.book ? ', in ' + (eds.length ? refAuthors(eds) + (eds.length > 1 ? ' (eds.) ' : ' (ed.) ') : '') + tidyTitle(meta.book) : '') + '.' + (meta.place || meta.publisher ? ' ' + [meta.place, meta.publisher].filter(Boolean).join(': ') + (meta.pages ? ', pp. ' + String(meta.pages).replace(/-/g, '–') : '') + '.' : '');
    } else if (type === 'book' || type === 'report') {
        out = head + (who ? title : '') + '.' + (meta.edition && !/^1(st)?$/.test(String(meta.edition)) ? ' ' + meta.edition + ' edn.' : '') + (meta.place || meta.publisher ? ' ' + [meta.place, meta.publisher].filter(Boolean).join(': ') + '.' : '');
        if (!meta.publisher && meta.doi) out += ' Available at: https://doi.org/' + String(meta.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') + '.';
    } else if (type === 'web') {
        out = head + (who ? title : '') + '.' + (meta.url ? ' Available at: ' + meta.url + ' (Accessed: ' + accessedToday() + ').' : '');
    } else {
        out = head + (who ? title : '') + '.' + (meta.publisher ? ' ' + [meta.place, meta.publisher].filter(Boolean).join(': ') + '.' : '') + (meta.doi ? ' Available at: https://doi.org/' + String(meta.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') + '.' : (meta.url ? ' Available at: ' + meta.url + ' (Accessed: ' + accessedToday() + ').' : ''));
    }
    return out.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
}
function warningsFor(meta) {
    const w = [];
    if (!authorList(meta.authors).length) w.push('no author found — check who wrote it');
    if (!meta.year) w.push('no year found');
    if (meta.fromUpload && !meta.publisher && !meta.journal && !meta.doi) w.push('publisher / journal not stated in the document');
    return w;
}
function finish(meta) {
    return { ...meta, inText: harvardInText(meta), reference: harvardReference(meta), warnings: warningsFor(meta) };
}

// ── Uploaded sources: match by content; details from the front matter ─────
function sentencesIn(text) { return String(text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["'”’)\]]*|[^.!?]+$/g) || []; }
// A source is offered when the claim's own words are found in it (a real
// content overlap); a thin claim (few key words) also lets a source in on the
// essay's SUBJECT words, ranked below content matches — the student picks,
// and the snippet shows where the source says it.
function matchUpload(source, kw, subjKw) {
    const text = String(source.text || ''); const low = text.toLowerCase();
    if (!text || !kw.length) return null;
    const hits = kw.filter(k => low.includes(k));
    const subjHits = (Array.isArray(subjKw) ? subjKw : []).filter(k => low.includes(k));
    const need = kw.length >= 6 ? 2 : 1;
    if (hits.length < need && !(subjHits.length >= 2 && kw.length <= 5)) return null;
    // Best sentence: the one carrying most of the key words — from the body,
    // past the front matter (title / author lines), when the body has a hit.
    let best = '', bestN = 0;
    const body = text.length > 600 ? text.slice(300, 120000) : text.slice(0, 120000);
    for (const s of sentencesIn(body).concat(text.length > 600 ? sentencesIn(text.slice(0, 300)) : [])) {
        const l = s.toLowerCase(); let n = 0; for (const k of kw) if (l.includes(k)) n++;
        if (n > bestN) { bestN = n; best = s.trim(); }
        if (n === kw.length) break;
    }
    return { score: hits.length / kw.length + 0.1 * subjHits.length, hits: hits.length, snippet: best.length > 220 ? best.slice(0, 217) + '…' : best };
}
// Front-matter heuristics — only what the text states.
function metaFromText(source) {
    const name = String(source.name || 'document');
    const head = String(source.text || '').slice(0, 4000);
    const lines = head.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const meta = { title: null, authors: [], year: null, type: 'other', journal: null, volume: null, issue: null, pages: null, publisher: null, place: null, doi: null, url: null };
    const doi = head.match(/\b10\.\d{4,9}\/[^\s"<>]+/); if (doi) meta.doi = doi[0].replace(/[.,;)]+$/, '');
    const yr = head.match(/\b(19[5-9]\d|20[0-4]\d)\b/); if (yr) meta.year = yr[1];
    for (const l of lines.slice(0, 40)) {
        let m = l.match(/^(?:by|author[s]?)[:\s]+(.{3,120})$/i);
        if (m) { meta.authors = m[1].split(/,|\band\b|&/).map(x => x.trim()).filter(x => /^[A-Z][A-Za-z'’\-]+(\s+[A-Z][A-Za-z'’.\-]*)*$/.test(x)).map(splitDisplayName).filter(Boolean); if (meta.authors.length) break; }
        // "Armstrong, M. and Brown, D. (2019)" reference-line style
        m = l.match(/^((?:[A-Z][A-Za-z'’\-]+,\s*[A-Z]\.(?:\s?[A-Z]\.)*(?:,?\s*(?:and|&)?\s*)?)+)\s*\((\d{4})\)/);
        if (m) { meta.authors = m[1].split(/\s*(?:,\s*)?(?:and|&)\s*|,\s*(?=[A-Z][a-z])/).map(x => x.trim()).filter(Boolean).map(splitDisplayName).filter(Boolean); meta.year = m[2]; break; }
    }
    // Title: the first substantial line that is not the author line / a header code.
    const title = lines.find(l => l.length >= 8 && l.length <= 200 && !/^(by|author|abstract|contents|introduction|page|chapter)\b/i.test(l) && !/^\d+$/.test(l) && !/^(https?:|www\.)/i.test(l) && !meta.authors.some(a => l.includes(a.family)));
    meta.title = title || name.replace(/\.[a-z0-9]+$/i, '').replace(/[._-]+/g, ' ').trim();
    if (/journal|vol\.|volume\s+\d/i.test(head)) meta.type = 'article';
    return meta;
}
function mergeMeta(base, extra) {
    if (!extra || typeof extra !== 'object') return base;
    const out = { ...base };
    for (const k of ['title', 'year', 'type', 'journal', 'volume', 'issue', 'pages', 'publisher', 'place', 'doi', 'url']) if (!out[k] && extra[k]) out[k] = String(extra[k]);
    const as = authorList(extra.authors); if (as.length && !authorList(out.authors).length) out.authors = as;
    return out;
}
// The schema for the optional model read of a source's front matter (the
// caller runs it with the accurate brain and caches it per source).
const SOURCE_META_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['found', 'title', 'authors', 'year', 'type', 'journal', 'volume', 'issue', 'pages', 'publisher', 'place', 'doi', 'url'],
    properties: {
        found: { type: 'boolean', description: 'true only when the text itself states at least an author or organisation AND a year.' },
        title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        authors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['family', 'given'], properties: { family: { type: 'string' }, given: { type: 'string' } } }, description: 'Only the people or organisation the text names as its authors. Empty if none stated.' },
        year: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The publication year the text states, else null. Never guess.' },
        type: { type: 'string', enum: ['article', 'book', 'chapter', 'report', 'web', 'other'] },
        journal: { anyOf: [{ type: 'string' }, { type: 'null' }] }, volume: { anyOf: [{ type: 'string' }, { type: 'null' }] }, issue: { anyOf: [{ type: 'string' }, { type: 'null' }] }, pages: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        publisher: { anyOf: [{ type: 'string' }, { type: 'null' }] }, place: { anyOf: [{ type: 'string' }, { type: 'null' }] }, doi: { anyOf: [{ type: 'string' }, { type: 'null' }] }, url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
};
const SOURCE_META_PROMPT = 'You read ONLY the front matter / title page / reference line of a document a student uploaded and return the bibliographic details the TEXT ITSELF states — title, the named authors or organisation, year, publisher or journal, place, DOI, URL. Anything the text does not state is null. Never guess, never complete from your own knowledge, never invent a year or a publisher. found = true only when at least an author (or organisation) and a year are stated.';

async function uploadCandidates(uploadedSources, kw, subjKw, extractMeta, max) {
    const out = [];
    for (const src of (Array.isArray(uploadedSources) ? uploadedSources : [])) {
        const m = matchUpload(src, kw, subjKw); if (!m) continue;
        let meta = metaFromText(src);
        if ((!authorList(meta.authors).length || !meta.year) && typeof extractMeta === 'function') {
            try { const extra = await extractMeta(src); if (extra && (extra.found || extra.title || (extra.authors && extra.authors.length))) meta = mergeMeta(meta, extra); } catch (_) { /* heuristics stand */ }
        }
        out.push(finish({ ...meta, id: 'upload:' + src.name, fromUpload: true, sourceName: src.name, snippet: m.snippet, score: m.score, citedBy: null }));
    }
    return out.sort((a, b) => b.score - a.score).slice(0, max);
}

// WHAT THE SOURCE ACTUALLY SAYS. Sarah, 16 Aug, looking at "(Kang et al.,
// 2010)" sitting on the end of her own sentence: "isn't it supposed to
// actually quote them?" A paraphrase with an author-date citation is correct
// Harvard and usually better than quoting — but a citation attached to a claim
// nobody has read is the thing a marker probes, and she had no way to know
// whether Kang et al. supports her point or contradicts it.
//
// OpenAlex ships the abstract as an inverted index (word → the positions it
// appears at), so it has to be put back into order before a human can read it.
// This is the source's own words, from the index, not written by anyone here.
function abstractOf(w) {
    const inv = w && w.abstract_inverted_index;
    if (!inv || typeof inv !== 'object') return null;
    const words = [];
    for (const word of Object.keys(inv)) {
        const at = inv[word];
        if (!Array.isArray(at)) continue;
        for (const i of at) if (Number.isInteger(i) && i >= 0 && i < 4000) words[i] = word;
    }
    const text = words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < 40) return null;
    // The index carries bad abstracts. Hatfield's "Equity: theory and
    // research" came back with "Chapter 1 Thinking About American Politics
    // Chapter 2 Political Culture…" — another book's contents page entirely.
    // Showing that to a student as "what they actually say" is worse than
    // showing nothing, so two sanity checks: a contents page is not an
    // abstract, and an abstract that shares no real word with its own title
    // is not this work's abstract.
    if ((text.match(/\bChapter\s+\d+/gi) || []).length >= 3) return null;
    if ((text.match(/\bPart\s+(one|two|three|[IVX]+|\d+)\b/gi) || []).length >= 3) return null;
    const titleWords = String(w.display_name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length > 4 && !STOP.has(x));
    if (titleWords.length) {
        const low = text.toLowerCase();
        if (!titleWords.some(x => low.includes(x))) return null;
    }
    return text.length > 420 ? text.slice(0, 417).replace(/\s+\S*$/, '') + '…' : text;
}

// ── OpenAlex → metadata ───────────────────────────────────────────────────
function fromOpenAlex(w) {
    if (!w || w.is_retracted) return null;
    const authors = (w.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean).map(splitDisplayName).filter(Boolean);
    const year = w.publication_year ? String(w.publication_year) : null;
    if (!authors.length || !year || !w.display_name) return null;
    const loc = w.primary_location || {}; const src = loc.source || {};
    const t = String(w.type || '');
    const type = t === 'article' ? 'article' : t === 'book' ? 'book' : t === 'book-chapter' ? 'chapter' : t === 'report' ? 'report' : 'other';
    const b = w.biblio || {};
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null;
    return {
        id: w.id || ('openalex:' + doi), title: w.display_name, authors, year, type,
        journal: type === 'article' ? (src.display_name || null) : null,
        volume: b.volume || null, issue: b.issue || null, pages: b.first_page && b.last_page ? b.first_page + '–' + b.last_page : (b.first_page || null),
        publisher: type !== 'article' ? (src.host_organization_name || src.display_name || null) : null, place: null,
        doi, url: loc.landing_page_url || (doi ? 'https://doi.org/' + doi : null),
        citedBy: Number(w.cited_by_count) || 0, fromUpload: false, sourceName: null, snippet: abstractOf(w), index: 'openalex',
        // What the work is ABOUT, in OpenAlex's own words - the thing that tells
        // a real Herzberg from a coincidental one (Sarah, 20 Aug).
        fields: (w.topics || []).flatMap(t => [t && t.display_name, t && t.subfield && t.subfield.display_name, t && t.field && t.field.display_name, t && t.domain && t.domain.display_name]).filter(Boolean),
    };
}
async function searchOpenAlex(query, max) {
    const mailto = process.env.OPENALEX_MAILTO ? '&mailto=' + encodeURIComponent(process.env.OPENALEX_MAILTO) : '';
    const url = OPENALEX + '?search=' + encodeURIComponent(query) + '&per-page=' + Math.min(25, max * 3) + '&filter=is_retracted:false,type:article|book|book-chapter|report&select=id,display_name,publication_year,authorships,primary_location,doi,type,cited_by_count,biblio,is_retracted,abstract_inverted_index,topics' + mailto;
    const started = Date.now();
    try {
        const d = await deps.fetchJson(url);
        logUsage({ skill: 'cite', provider: 'openalex', model: 'works.search', started, kind: 'lookup', tokensIn: 0, tokensOut: 0 });
        return (d && Array.isArray(d.results) ? d.results : []).map(fromOpenAlex).filter(Boolean).slice(0, max);
    } catch (e) {
        logUsage({ skill: 'cite', provider: 'openalex', model: 'works.search', started, kind: 'lookup', success: false, error: String(e && e.message || e).slice(0, 80), tokensIn: 0, tokensOut: 0 });
        throw e;
    }
}
// ── CrossRef → metadata ───────────────────────────────────────────────────
function fromCrossref(w) {
    if (!w) return null;
    const authors = (w.author || []).map(a => a.family ? { family: a.family, given: a.given || '' } : (a.name ? splitDisplayName(a.name) : null)).filter(Boolean);
    const parts = w.issued && w.issued['date-parts'] && w.issued['date-parts'][0];
    const year = parts && parts[0] ? String(parts[0]) : null;
    const title = Array.isArray(w.title) ? w.title[0] : w.title;
    if (!authors.length || !year || !title) return null;
    const t = String(w.type || '');
    const type = t === 'journal-article' ? 'article' : t === 'book' || t === 'monograph' ? 'book' : t === 'book-chapter' ? 'chapter' : t === 'report' ? 'report' : 'other';
    const container = Array.isArray(w['container-title']) ? w['container-title'][0] : w['container-title'];
    return {
        id: 'crossref:' + w.DOI, title, authors, year, type,
        journal: type === 'article' ? (container || null) : null, book: type === 'chapter' ? (container || null) : null,
        volume: w.volume || null, issue: w.issue || null, pages: w.page ? String(w.page).replace(/-/g, '–') : null,
        publisher: type !== 'article' ? (w.publisher || null) : null, place: null,
        doi: w.DOI || null, url: w.URL || (w.DOI ? 'https://doi.org/' + w.DOI : null),
        citedBy: Number(w['is-referenced-by-count']) || 0, fromUpload: false, sourceName: null, snippet: null, index: 'crossref',
    };
}
async function searchCrossref(query, max) {
    const mailto = process.env.OPENALEX_MAILTO ? '&mailto=' + encodeURIComponent(process.env.OPENALEX_MAILTO) : '';
    const url = CROSSREF + '?query.bibliographic=' + encodeURIComponent(query) + '&rows=' + Math.min(20, max * 3) + '&select=DOI,title,author,issued,container-title,publisher,type,volume,issue,page,URL,is-referenced-by-count' + mailto;
    const started = Date.now();
    try {
        const d = await deps.fetchJson(url);
        logUsage({ skill: 'cite', provider: 'crossref', model: 'works.query', started, kind: 'lookup', tokensIn: 0, tokensOut: 0 });
        return (d && d.message && Array.isArray(d.message.items) ? d.message.items : []).map(fromCrossref).filter(Boolean).slice(0, max);
    } catch (e) {
        logUsage({ skill: 'cite', provider: 'crossref', model: 'works.query', started, kind: 'lookup', success: false, error: String(e && e.message || e).slice(0, 80), tokensIn: 0, tokensOut: 0 });
        throw e;
    }
}

// ── THE CITE GUARD (Sarah, 19 Aug: "my sister said Q's making docs up that
// don't exist") ───────────────────────────────────────────────────────────
// Q's chat is model text: when he names "Guest (1998)" from his own head
// nothing had checked it. These two functions find every citation-shaped
// mention in a reply — Surname (Year), Surname and Surname (Year), Surname et
// al. (Year), (Surname, Year), Surname, A. (Year), a DOI — and look each one
// up on OpenAlex (CrossRef behind it): found = a record with that surname
// among the authors and that year (±1 for online-first vs print). Nothing is
// rewritten; the route says plainly which ones it could not find.
const MENTION_STOP = new Set(['act', 'bill', 'parliament', 'section', 'chapter', 'figure', 'table', 'question', 'part', 'unit', 'cipd', 'level', 'in', 'the', 'see', 'and', 'since', 'by', 'from', 'of', 'at', 'on', 'for', 'with', 'to', 'as', 'or', 'but', 'if', 'so', 'no', 'yes', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'spring', 'summer', 'autumn', 'winter', 'q1', 'q2', 'q3', 'q4', 'lo1', 'lo2', 'lo3', 'lo4', 'ac', 'lo', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'r1', 'r2', 'r3', 'r4', 'r5', 'references', 'bibliography', 'word', 'words', 'brief', 'essay', 'draft', 'deadline', 'submission', 'assessment', 'assignment', 'regulations', 'regulation', 'directive', 'convention', 'treaty', 'case', 'v', 'vs', 'r', 'ltd', 'plc', 'uk', 'gov', 'ons', 'nhs', 'bbc', 'acas', 'tuc', 'who', 'eu', 'un']);
const SURNAME = "[A-Z][A-Za-z'’\\-]{1,30}";
const MENTION_RXS = [
    // Guest (1998) · Guest and Conway (2002) · Rousseau et al. (1995) · Guest, D. E. (1998)
    new RegExp('\\b(' + SURNAME + ')(?:,\\s*(?:[A-Z]\\.\\s*){1,3})?(?:\\s+(?:and|&)\\s+(' + SURNAME + ')|\\s+et al\\.?)?\\s*\\(\\s*((?:19|20)\\d{2})[a-z]?\\s*\\)', 'g'),
    // (Guest, 1998) · (Guest and Conway, 2002) · (Rousseau et al., 1995) · (Guest, 1998; Conway, 2002)
    new RegExp('[(;]\\s*(' + SURNAME + ')(?:\\s+(?:and|&)\\s+(' + SURNAME + ')|\\s+et al\\.?)?\\s*,\\s*((?:19|20)\\d{2})[a-z]?\\s*(?=[);,])', 'g'),
];
const DOI_RX = /\b10\.\d{4,9}\/[^\s"']+/g;
function findMentions(text) {
    const s = String(text || '');
    const out = new Map();
    for (const rx of MENTION_RXS) {
        rx.lastIndex = 0; let m;
        while ((m = rx.exec(s))) {
            const a = m[1], b = m[2] || '', year = m[3];
            if (MENTION_STOP.has(a.toLowerCase()) || (b && MENTION_STOP.has(b.toLowerCase()))) continue;
            const key = (a + (b ? ' and ' + b : '') + ' ' + year).toLowerCase();
            if (!out.has(key)) out.set(key, { mention: m[0].replace(/^[(;]\s*/, '').trim(), surname: a, second: b, year, at: m.index, doi: null });
        }
    }
    DOI_RX.lastIndex = 0; let d;
    while ((d = DOI_RX.exec(s))) { let doi = d[0].replace(/[.,;:]+$/, ''); while (/[)\]]$/.test(doi) && (doi.split(/[)\]]/).length > doi.split(/[(\[]/).length)) doi = doi.slice(0, -1); const key = 'doi:' + doi.toLowerCase(); if (!out.has(key)) out.set(key, { mention: doi, surname: '', second: '', year: '', at: d.index, doi }); }
    return Array.from(out.values());
}
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
// IS THIS WORK EVEN ABOUT THE SAME THING? (Sarah, 20 Aug: an invented name that
// happens to share a surname and a year with a real paper came back as "weak"
// with that paper's title attached - "Thistlewood (2019)" matched a study of
// the sterile insect technique.) Compared on 6-letter stems so her "motivators"
// meets OpenAlex's "Motivation", which plain containment misses.
function subjectWords(subject) {
    return String(subject || '').split(/[^A-Za-z]+/).filter(w => w.length >= 3 && !SUBJ_STOP.has(w.toLowerCase()));
}
const SUBJ_STOP = new Set(['and', 'the', 'for', 'with', 'his', 'her', 'its', 'level', 'diploma', 'certificate', 'award', 'unit', 'module', 'assignment', 'course', 'studies', 'study', 'introduction', 'advanced', 'foundation', 'part', 'one', 'two', 'three']);
function sharesSubject(hay, words) {
    const h = fold(hay);
    if (!h) return false;
    return (words || []).some(w => { const f = fold(w); return f.length > 3 && h.includes(f.slice(0, Math.min(6, f.length))); });
}
function contextWords(text, at, n) {
    // The mention's OWN sentence: from the previous sentence end to the next.
    // A window of characters picked up the neighbouring mentions' words and
    // called Conway and Briner (2005) "not on this topic" for a sentence about
    // the psychological contract.
    const s = String(text || '');
    let lo = at; while (lo > 0 && !/[.!?\n]/.test(s[lo - 1])) lo--;
    let hi = at; while (hi < s.length && !/[.!?\n]/.test(s[hi])) hi++;
    const sent = s.slice(lo, hi).replace(/\b[A-Z][A-Za-z'’\-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]+|\s+et al\.?)?\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)/g, ' ').replace(/\((?:[^()]*?,\s*(?:19|20)\d{2}[a-z]?)\)/g, ' ');
    const words = keywords(sent, n);
    return words.length ? words : keywords(s.slice(Math.max(0, at - 160), Math.min(s.length, at + 160)), n);
}
// The indexes are asked the way an index can answer: AUTHOR NAME + YEAR RANGE
// as filters (OpenAlex raw_author_name.search + publication dates; CrossRef
// query.author + from/until-pub-date), the sentence's topic words as the free
// search. "Guest 1998" as free text matches nothing — author names are not in
// the full-text index (that is how the first version called Guest (1998) and
// Rousseau (1995) invented — 19 Aug).
async function openAlexByAuthorYear(surname, year, kw, max) {
    const mailto = process.env.OPENALEX_MAILTO ? '&mailto=' + encodeURIComponent(process.env.OPENALEX_MAILTO) : '';
    const y = Number(year);
    const filter = 'is_retracted:false,raw_author_name.search:' + encodeURIComponent(surname) + ',from_publication_date:' + (y - 1) + '-01-01,to_publication_date:' + (y + 1) + '-12-31';
    const url = OPENALEX + '?filter=' + filter + (kw ? '&search=' + encodeURIComponent(kw) : '') + '&per-page=' + Math.min(25, max) + '&select=id,display_name,publication_year,authorships,primary_location,doi,type,cited_by_count,biblio,is_retracted,abstract_inverted_index,topics' + mailto;
    const started = Date.now();
    try {
        const d = await deps.fetchJson(url);
        logUsage({ skill: 'cite', provider: 'openalex', model: 'works.author-year', started, kind: 'lookup', tokensIn: 0, tokensOut: 0 });
        return (d && Array.isArray(d.results) ? d.results : []).map(fromOpenAlex).filter(Boolean);
    } catch (e) {
        logUsage({ skill: 'cite', provider: 'openalex', model: 'works.author-year', started, kind: 'lookup', success: false, error: String(e && e.message || e).slice(0, 80), tokensIn: 0, tokensOut: 0 });
        return [];
    }
}
async function crossrefByAuthorYear(surname, year, kw, max) {
    const mailto = process.env.OPENALEX_MAILTO ? '&mailto=' + encodeURIComponent(process.env.OPENALEX_MAILTO) : '';
    const y = Number(year);
    const url = CROSSREF + '?query.author=' + encodeURIComponent(surname) + (kw ? '&query.bibliographic=' + encodeURIComponent(kw) : '') + '&filter=from-pub-date:' + (y - 1) + ',until-pub-date:' + (y + 1) + '&rows=' + Math.min(20, max) + '&select=DOI,title,author,issued,container-title,publisher,type,volume,issue,page,URL,is-referenced-by-count' + mailto;
    const started = Date.now();
    try {
        const d = await deps.fetchJson(url);
        logUsage({ skill: 'cite', provider: 'crossref', model: 'works.author-year', started, kind: 'lookup', tokensIn: 0, tokensOut: 0 });
        return (d && d.message && Array.isArray(d.message.items) ? d.message.items : []).map(fromCrossref).filter(Boolean);
    } catch (e) {
        logUsage({ skill: 'cite', provider: 'crossref', model: 'works.author-year', started, kind: 'lookup', success: false, error: String(e && e.message || e).slice(0, 80), tokensIn: 0, tokensOut: 0 });
        return [];
    }
}
async function verifyMention(m, text, subject) {
    const t0 = Date.now();
    try {
        if (m.doi) {
            try { const w = await deps.fetchJson('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(m.doi)); const r = fromOpenAlex(w); if (r) return { ...m, found: true, strength: 'strong', title: r.title, year: r.year, authors: r.authors.map(a => a.family), doi: r.doi || m.doi, url: r.url || ('https://doi.org/' + m.doi), journal: r.journal || null, type: r.type || null, ms: Date.now() - t0 }; } catch (_) {}
            try { const ws = await searchCrossref(m.doi, 1); const r = ws[0]; if (r && String(r.doi || '').toLowerCase() === m.doi.toLowerCase()) return { ...m, found: true, strength: 'strong', title: r.title, year: r.year, authors: r.authors.map(a => a.family), doi: r.doi, url: r.url || ('https://doi.org/' + r.doi), journal: r.journal || null, type: r.type || null, ms: Date.now() - t0 }; } catch (_) {}
            return { ...m, found: false, ms: Date.now() - t0 };
        }
        const y = Number(m.year);
        const okRec = r => r && (r.authors || []).some(a => fold(a.family) === fold(m.surname)) && Math.abs(Number(r.year) - y) <= 1
            && (!m.second || (r.authors || []).some(a => fold(a.family) === fold(m.second)));
        // A hit that shares a topic word with the sentence is the work he meant;
        // one that only matches surname + year is SOME paper by SOME Wang in 2021
        // — reported as weak, not found, so a common surname cannot launder an
        // invented title.
        const kwList = contextWords(text, m.at, 6).filter(k => fold(k) !== fold(m.surname) && k.length > 3);
        const subjWords = subjectWords(subject);
        const kw = kwList.join(' ');
        // The topic words are matched against the WORK, not the journal it sat
        // in. With the journal in the haystack, "Herzberg (1959) ... hygiene
        // factors" confidently matched a 1957/58 German influenza paper that
        // happened to be published in a hygiene journal, and reported it STRONG
        // (measured, 20 Aug). A journal title says nothing about the work.
        const onTopic = r => { const hay = fold((r.title || '') + ' ' + (r.snippet || '')); return !kwList.length || kwList.some(k => hay.includes(fold(k))); };
        // THE LINK COMES BACK TOO (Sarah, 20 Aug: "my sister doesnt trust it and
        // cant check it"). A title alone cannot be checked; a DOI or a landing
        // page can be opened in one press. fromOpenAlex/fromCrossref already
        // carry doi + url - they were simply being dropped here.
        const pack = (hit, strength) => ({ ...m, found: true, strength, title: hit.title, year: hit.year,
            authors: hit.authors.map(a => a.family), doi: hit.doi || null,
            url: hit.url || (hit.doi ? 'https://doi.org/' + hit.doi : null),
            journal: hit.journal || null, type: hit.type || null, ms: Date.now() - t0 });
        let weak = null;
        // OpenAlex: author + year, topic words; then author + year alone.
        for (const q of [kw, '']) {
            const ws = await openAlexByAuthorYear(m.surname, m.year, q, 12);
            const strong = ws.find(r => okRec(r) && onTopic(r)); if (strong) return pack(strong, 'strong');
            if (!weak) weak = ws.find(okRec) || null;
            if (!q) break;
        }
        // CrossRef the same way.
        for (const q of [kw, '']) {
            const cs = await crossrefByAuthorYear(m.surname, m.year, q, 12);
            const strong = cs.find(r => okRec(r) && onTopic(r)); if (strong) return pack(strong, 'strong');
            if (!weak) weak = cs.find(okRec) || null;
            if (!q) break;
        }
        if (weak) {
            // Surname + year alone is a coincidence, not a citation. If the work
            // is not even in the same subject as her sentence, say so and name
            // it as the near miss it is - never hand her its title as if it were
            // the source she meant.
            const about = [weak.title, weak.snippet, (weak.fields || []).join(' ')].filter(Boolean).join(' ');
            // A CLASSIC CITED FOR ITS MODEL rarely shares surface words with the
            // sentence applying it. Sarah's live case, 20 Aug: "Hackman and
            // Oldham (1976) show automation strips out skill" — the right paper
            // is "Motivation through the design of work", which says nothing
            // about automation, so the sentence test threw the correct source
            // away. The ASSIGNMENT'S subject is the fair yardstick: that paper
            // sits in Organizational Behavior and Human Resource Management; a
            // study of the sterile insect technique does not.
            if (sharesSubject(about, kwList) || sharesSubject(about, subjWords)) return pack(weak, 'weak');
            return { ...m, found: false, ms: Date.now() - t0,
                nearMiss: { title: weak.title, year: weak.year, authors: (weak.authors || []).map(a => a.family),
                    about: (weak.fields || []).slice(0, 2).join(', ') || null, url: weak.url || (weak.doi ? 'https://doi.org/' + weak.doi : null) } };
        }
        return { ...m, found: false, ms: Date.now() - t0 };
    } catch (e) { return { ...m, found: null, error: String(e && e.message || e).slice(0, 80), ms: Date.now() - t0 }; }
}
/**
 * verifyMentions(text, { exemptText, max, timeoutMs }) → { checked: [...], unverified: [...], exempt: [...] }
 * exemptText: the student's own words (their page, their message, their uploads,
 * the brief) — a source THEY brought is theirs to discuss, not his to have invented.
 */
async function verifyMentions(text, { exemptText = '', max = 6, timeoutMs = 9000, subject = '' } = {}) {
    const all = findMentions(text);
    const ex = String(exemptText || '');
    const exFold = fold(ex);
    const isExempt = m => {
        if (!ex) return false;
        if (m.doi) return ex.toLowerCase().includes(m.doi.toLowerCase());
        // surname and year within 120 characters of each other in her own text
        const rx = new RegExp(m.surname.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '[\\s\\S]{0,120}?' + m.year + '|' + m.year + '[\\s\\S]{0,120}?' + m.surname.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
        return rx.test(ex) || (exFold.includes(fold(m.surname)) && ex.includes(m.year) && fold(m.surname).length >= 6);
    };
    const exempt = all.filter(isExempt);
    const todo = all.filter(m => !isExempt(m)).slice(0, max);
    if (!todo.length) return { checked: [], unverified: [], exempt, skipped: Math.max(0, all.length - exempt.length - todo.length) };
    const timer = new Promise(res => setTimeout(() => res('timeout'), timeoutMs));
    const results = await Promise.race([Promise.all(todo.map(m => verifyMention(m, text, subject))), timer]);
    if (results === 'timeout') return { checked: [], unverified: [], exempt, timedOut: true, skipped: todo.length };
    return { checked: results, unverified: results.filter(r => r.found === false), weak: results.filter(r => r.found === true && r.strength === 'weak'), exempt, skipped: Math.max(0, all.length - exempt.length - todo.length) };
}

// ── WEBSITES (Sarah, 19 Aug: "there should be a list and they should be able
// to choose between urls etc… apparently auto isn't producing websites") ──
// A Level 3 law essay is backed by legislation.gov.uk and parliament.uk, not
// journals. Brave web search (the same key Q's web_search uses), the page's
// organisation from its domain, the year from the URL / the page date /
// the snippet (else n.d.), Harvard for a web page built in code. Social
// media and essay mills never come back as sources.
const WEB_BLOCK = /(^|\.)(facebook|twitter|x|instagram|tiktok|pinterest|youtube|reddit|quora|linkedin|ukessays|studocu|coursehero|bartleby|gradesfixer|scribd|ivypanda|studymode|essaysauce|lawteacher|lawaspect|markedbyteachers|studentshare|edubirdie|papersowl|123helpme|brainly|chegg|answers|wikihow|slideshare|prezi|amazon|ebay)\.(com|co\.uk|net|org|io|me)$/i;
const ORG_BY_HOST = [
    [/(^|\.)legislation\.gov\.uk$/i, 'legislation.gov.uk'], [/(^|\.)parliament\.uk$/i, 'UK Parliament'], [/(^|\.)gov\.uk$/i, 'GOV.UK'], [/(^|\.)gov\.scot$/i, 'Scottish Government'], [/(^|\.)gov\.wales$/i, 'Welsh Government'],
    [/(^|\.)nhs\.uk$/i, 'NHS'], [/(^|\.)ons\.gov\.uk$/i, 'Office for National Statistics'], [/(^|\.)bbc\.(co\.uk|com)$/i, 'BBC'], [/(^|\.)acas\.org\.uk$/i, 'Acas'], [/(^|\.)cipd\.(org|co\.uk)$/i, 'CIPD'], [/(^|\.)tuc\.org\.uk$/i, 'TUC'],
    [/(^|\.)judiciary\.uk$/i, 'Courts and Tribunals Judiciary'], [/(^|\.)supremecourt\.uk$/i, 'UK Supreme Court'], [/(^|\.)bailii\.org$/i, 'BAILII'], [/(^|\.)lawsociety\.org\.uk$/i, 'The Law Society'], [/(^|\.)citizensadvice\.org\.uk$/i, 'Citizens Advice'],
    [/(^|\.)hse\.gov\.uk$/i, 'Health and Safety Executive'], [/(^|\.)equalityhumanrights\.com$/i, 'Equality and Human Rights Commission'], [/(^|\.)who\.int$/i, 'World Health Organization'], [/(^|\.)un\.org$/i, 'United Nations'], [/(^|\.)europa\.eu$/i, 'European Union'],
    [/(^|\.)britannica\.com$/i, 'Encyclopaedia Britannica'], [/(^|\.)wikipedia\.org$/i, 'Wikipedia'], [/(^|\.)theguardian\.com$/i, 'The Guardian'], [/(^|\.)ft\.com$/i, 'Financial Times'], [/(^|\.)economist\.com$/i, 'The Economist'], [/(^|\.)hbr\.org$/i, 'Harvard Business Review'],
    [/(^|\.)ox\.ac\.uk$/i, 'University of Oxford'], [/(^|\.)cam\.ac\.uk$/i, 'University of Cambridge'], [/(^|\.)lse\.ac\.uk$/i, 'London School of Economics'], [/(^|\.)open\.ac\.uk$/i, 'The Open University'],
];
function orgFromHost(host) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    for (const [rx, name] of ORG_BY_HOST) if (rx.test(h)) return name;
    if (/\.ac\.uk$/.test(h)) { const u = h.replace(/\.ac\.uk$/, '').split('.').pop(); return u.charAt(0).toUpperCase() + u.slice(1) + ' University'; }
    const core = h.replace(/\.(co\.uk|org\.uk|gov\.uk|ac\.uk|com|org|net|io|uk|edu|info|co)$/i, '').split('.').pop() || h;
    return core.length <= 4 ? core.toUpperCase() : core.charAt(0).toUpperCase() + core.slice(1);
}
function yearFromWeb(r) {
    const u = String(r.url || ''); const m1 = u.match(/(?:^|[\/\-_])((?:19|20)\d{2})(?:[\/\-_]|$)/); if (m1) return m1[1];
    const pa = String(r.page_age || r.age || ''); const m2 = pa.match(/(?:19|20)\d{2}/); if (m2) return m2[0];
    const t = String(r.title || '') + ' ' + String(r.description || ''); const m3 = t.match(/\b((?:19|20)\d{2})\b/); if (m3) return m3[1];
    return null;
}
async function searchWebSources(query, max = 5) {
    const apiKey = process.env.BRAVE_SEARCH_KEY;
    if (!apiKey || !query) return [];
    const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + Math.min(20, max * 3) + '&country=gb&search_lang=en';
    const started = Date.now();
    try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey } });
        if (!res.ok) { logUsage({ skill: 'cite', provider: 'brave', model: 'web.search', started, kind: 'lookup', success: false, error: 'HTTP ' + res.status, tokensIn: 0, tokensOut: 0 }); return []; }
        const data = await res.json();
        logUsage({ skill: 'cite', provider: 'brave', model: 'web.search', started, kind: 'lookup', tokensIn: 0, tokensOut: 0 });
        const seen = new Set(); const out = [];
        for (const r of ((data.web && data.web.results) || [])) {
            let host = ''; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
            if (!host || WEB_BLOCK.test(host) || seen.has(host + '|' + r.url)) continue;
            seen.add(host + '|' + r.url);
            const known = ORG_BY_HOST.find(([rx]) => rx.test(host));
            const org = known ? known[1] : ((r.profile && String(r.profile.name || '').trim()) || (r.meta_url && String(r.meta_url.hostname || '').replace(/^www\./, '')) || orgFromHost(host));
            const title = String(r.title || '').replace(/\s*[|\-–—]\s*[^|\-–—]{0,40}$/, '').trim() || String(r.title || '');
            out.push({ id: 'web:' + r.url, title, authors: [{ family: org, given: '' }], year: yearFromWeb(r), type: 'web', url: r.url, host, org,
                journal: null, publisher: org, volume: null, issue: null, pages: null, doi: null, citedBy: 0, fromUpload: false, sourceName: null, snippet: String(r.description || '').slice(0, 300), index: 'web' });
            if (out.length >= max) break;
        }
        return out;
    } catch (e) { logUsage({ skill: 'cite', provider: 'brave', model: 'web.search', started, kind: 'lookup', success: false, error: String(e && e.message || e).slice(0, 80), tokensIn: 0, tokensOut: 0 }); return []; }
}

/**
 * findSources — uploads first, then the indexes. Never invents.
 */
async function findSources({ claimSentence, subject, level, uploadedSources, max = 5, webMax = 5, extractMeta, hint, exclude } = {}) {
    const claim = String(claimSentence || '').replace(/\s+/g, ' ').trim();
    if (!claim) return { candidates: [], searched: { uploads: 0, openalex: false, crossref: false, web: false }, note: 'Put the cursor at the end of the sentence you want to back up.' };
    const kw = keywords(claim, 12);
    const query = buildQuery(claim, subject, hint, exclude);
    const searched = { uploads: 0, openalex: false, crossref: false, web: false };
    // Websites in parallel with the indexes: the claim's words + her hint, and
    // the subject (which helps a web engine and swamps an academic one).
    const webQuery = [hint, query.replace(/"/g, ''), keywords(subject, 3).join(' ')].filter(Boolean).join(' ').trim();
    const webP = webMax > 0 && webQuery ? searchWebSources(webQuery, webMax).then(list => { searched.web = true; return list; }).catch(() => []) : Promise.resolve([]);
    const ups = await uploadCandidates(uploadedSources, kw, keywords(subject, 6), extractMeta, max);
    searched.uploads = ups.length;
    let pub = [];
    const room = Math.max(0, max - ups.length);
    if (room && query) {
        const key = 'q:' + query.toLowerCase();
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_MS) { pub = hit.result.list.slice(0, room); Object.assign(searched, hit.result.searched); }
        else {
            let list = []; const s2 = { openalex: false, crossref: false };
            try { list = await searchOpenAlex(query, max); s2.openalex = true; } catch (_) { list = []; }
            // A quoted phrase is precise, and precision can find nothing at
            // all. Never let that be the end of it — fall back to the plain
            // words before giving up on the sentence.
            if (!list.length && /"/.test(query)) {
                try { list = await searchOpenAlex(query.replace(/"/g, ''), max); s2.openalex = true; } catch (_) { list = []; }
            }
            if (!list.length) { try { list = await searchCrossref(query.replace(/"/g, ''), max); s2.crossref = true; } catch (_) { list = []; } }
            cache.set(key, { at: Date.now(), result: { list, searched: s2 } });
            pub = list.slice(0, room); Object.assign(searched, s2);
        }
    }
    // Real but not relevant is still wrong. Drop anything the sentence has no
    // word in common with rather than offer it as a citation.
    // Prefer her own field. "Equity Theory" is studied in romantic
    // relationships as well as in pay, and both are real equity-theory papers
    // — but only one of them backs a sentence about bonuses. The subject never
    // goes into the QUERY (it swamps the topic); it sorts what came back.
    const subjWords = keywords(subject, 5).filter(w => w.length > 3);
    const inField = (w) => {
        if (!subjWords.length) return 0;
        const hay = ((w.title || '') + ' ' + (w.journal || w.publisher || '') + ' ' + (w.snippet || '')).toLowerCase();
        return subjWords.filter(s => hay.includes(s)).length;
    };
    const onTopic = pub.filter(w => isRelevant(w, kw))
        .map(w => ({ w, field: inField(w) }))
        .sort((a, b) => b.field - a.field)
        .map(x => x.w);
    const web = await webP;   // the engine matched these words; the judge says how well each backs the sentence
    const candidates = ups.concat(onTopic.map(finish)).concat(web.map(finish));
    let note = '';
    if (!candidates.length) note = searched.openalex || searched.crossref ? 'I could not find a source I can verify for that sentence — try the References tool, or upload the source you have in mind.' : 'The source index did not answer just now — try again in a moment, or use the References tool.';
    return { candidates, query, searched, note };
}

module.exports = {
    findSources, harvardInText, harvardReference, keywords, buildQuery, splitDisplayName, initials,
    metaFromText, matchUpload, fromOpenAlex, fromCrossref, searchOpenAlex, searchCrossref,
    findMentions, verifyMentions, searchWebSources, orgFromHost,
    SOURCE_META_SCHEMA, SOURCE_META_PROMPT, deps, _cache: cache,
};
