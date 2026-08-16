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
function buildQuery(claimSentence, subject) {
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
    const cleaned = String(claimSentence || '').replace(/\([^)]*\d{4}[a-z]?\)/g, ' ').replace(/\s+/g, ' ').trim();
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
    const kw = keywords(cleaned, 12);
    const strong = kw.filter(w => !WEAK.has(w));
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
    const span = phraseSpan(claimSentence, strong[0], strong[1]);
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
    };
}
async function searchOpenAlex(query, max) {
    const mailto = process.env.OPENALEX_MAILTO ? '&mailto=' + encodeURIComponent(process.env.OPENALEX_MAILTO) : '';
    const url = OPENALEX + '?search=' + encodeURIComponent(query) + '&per-page=' + Math.min(25, max * 3) + '&filter=is_retracted:false,type:article|book|book-chapter|report&select=id,display_name,publication_year,authorships,primary_location,doi,type,cited_by_count,biblio,is_retracted,abstract_inverted_index' + mailto;
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

/**
 * findSources — uploads first, then the indexes. Never invents.
 */
async function findSources({ claimSentence, subject, level, uploadedSources, max = 5, extractMeta } = {}) {
    const claim = String(claimSentence || '').replace(/\s+/g, ' ').trim();
    if (!claim) return { candidates: [], searched: { uploads: 0, openalex: false, crossref: false }, note: 'Put the cursor at the end of the sentence you want to back up.' };
    const kw = keywords(claim, 12);
    const query = buildQuery(claim, subject);
    const searched = { uploads: 0, openalex: false, crossref: false };
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
    const candidates = ups.concat(onTopic.map(finish));
    let note = '';
    if (!candidates.length) note = searched.openalex || searched.crossref ? 'I could not find a source I can verify for that sentence — try the References tool, or upload the source you have in mind.' : 'The source index did not answer just now — try again in a moment, or use the References tool.';
    return { candidates, query, searched, note };
}

module.exports = {
    findSources, harvardInText, harvardReference, keywords, buildQuery, splitDisplayName, initials,
    metaFromText, matchUpload, fromOpenAlex, fromCrossref, searchOpenAlex, searchCrossref,
    SOURCE_META_SCHEMA, SOURCE_META_PROMPT, deps, _cache: cache,
};
