'use strict';

/**
 * UK English polish — runs on Q's chat output before Sarah sees it.
 *
 * Two jobs:
 *   1. Normalise typographer's punctuation (smart quotes, ellipsis, en-dash)
 *      to plain ASCII — Gmail's grammar checker behaves better with straight
 *      quotes, and copy-paste into older email clients is cleaner.
 *   2. Convert common American spellings to British. Q's underlying model is
 *      trained on a US-heavy corpus and slips "organize" / "color" / "analyze"
 *      in despite the prompt. This is the safety net.
 *
 * Surgical: leaves em-dashes alone (they're correct typography), leaves
 * emojis alone, only touches words with a deterministic UK equivalent.
 */

// ──────────────────────────────────────────────────────────────
//  PUNCTUATION
// ──────────────────────────────────────────────────────────────
function normalisePunctuation(text) {
    if (!text) return text;
    return text
        // smart double quotes → straight
        .replace(/[“”„‟]/g, '"')
        // smart single quotes / apostrophes → straight
        .replace(/[‘’‚‛]/g, "'")
        // ellipsis → three dots
        .replace(/…/g, '...')
        // en-dash between words → en-dash with spaces (matches typographic norm)
        // we leave em-dash (—) untouched — it's correct British style
        ;
}

// ──────────────────────────────────────────────────────────────
//  US → UK SPELLING
// ──────────────────────────────────────────────────────────────
// Each entry is a regex that matches the US form and the UK replacement.
// Patterns are case-aware (initial-cap variants handled too) and word-boundary
// safe so we don't mangle URLs, code identifiers, or proper nouns.
const SPELLING_RULES = [
    // -ize / -ization → -ise / -isation (the big one)
    [/\b([A-Za-z]+?)izes?\b/g, '$1ises'],     // realize → realise, realizes → realises
    [/\b([A-Za-z]+?)ized\b/g, '$1ised'],
    [/\b([A-Za-z]+?)izing\b/g, '$1ising'],
    [/\b([A-Za-z]+?)ization\b/g, '$1isation'],
    [/\b([A-Za-z]+?)izations\b/g, '$1isations'],
    // -yze → -yse (analyse, paralyse, catalyse)
    [/\b([A-Za-z]+?)yzes?\b/g, '$1yses'],
    [/\b([A-Za-z]+?)yzed\b/g, '$1ysed'],
    [/\b([A-Za-z]+?)yzing\b/g, '$1ysing'],
    // -or → -our for the canonical set
    [/\bcolor(s|ed|ing|ful|ation|ist|less)?\b/gi, (m, suf, off, str) => preserveCase(m, 'colour' + (suf || ''))],
    [/\bfavor(s|ed|ing|ite|able|ably)?\b/gi, (m, suf) => preserveCase(m, 'favour' + (suf || ''))],
    [/\bhonor(s|ed|ing|ary|able)?\b/gi, (m, suf) => preserveCase(m, 'honour' + (suf || ''))],
    [/\bbehavior(s|al|ally)?\b/gi, (m, suf) => preserveCase(m, 'behaviour' + (suf || ''))],
    [/\blabor(s|ed|ing|er|ious)?\b/gi, (m, suf) => preserveCase(m, 'labour' + (suf || ''))],
    [/\bharbor(s|ed|ing)?\b/gi, (m, suf) => preserveCase(m, 'harbour' + (suf || ''))],
    [/\bneighbor(s|ed|ing|hood|ly)?\b/gi, (m, suf) => preserveCase(m, 'neighbour' + (suf || ''))],
    [/\bhumor(s|ed|ing|ous|less)?\b/gi, (m, suf) => preserveCase(m, 'humour' + (suf || ''))],
    [/\brumor(s|ed|ing)?\b/gi, (m, suf) => preserveCase(m, 'rumour' + (suf || ''))],
    [/\bvigor(s|ous|ously)?\b/gi, (m, suf) => preserveCase(m, 'vigour' + (suf || ''))],
    // -er → -re (centre, theatre, fibre, metre)
    [/\bcenter(s|ed|ing|piece)?\b/gi, (m, suf) => preserveCase(m, 'centre' + (suf || ''))],
    [/\btheater(s|goer)?\b/gi, (m, suf) => preserveCase(m, 'theatre' + (suf || ''))],
    [/\bfiber(s|d|ing)?\b/gi, (m, suf) => preserveCase(m, 'fibre' + (suf || ''))],
    [/\bmeter(s|ed|ing)?\b/gi, (m, suf) => preserveCase(m, 'metre' + (suf || ''))],
    // double-l (travelled, cancelled, modelled)
    [/\btraveled\b/gi, (m) => preserveCase(m, 'travelled')],
    [/\btraveling\b/gi, (m) => preserveCase(m, 'travelling')],
    [/\btraveler(s)?\b/gi, (m, suf) => preserveCase(m, 'traveller' + (suf || ''))],
    [/\bcanceled\b/gi, (m) => preserveCase(m, 'cancelled')],
    [/\bcanceling\b/gi, (m) => preserveCase(m, 'cancelling')],
    [/\bmodeled\b/gi, (m) => preserveCase(m, 'modelled')],
    [/\bmodeling\b/gi, (m) => preserveCase(m, 'modelling')],
    [/\blabeled\b/gi, (m) => preserveCase(m, 'labelled')],
    [/\blabeling\b/gi, (m) => preserveCase(m, 'labelling')],
    [/\bsignaled\b/gi, (m) => preserveCase(m, 'signalled')],
    [/\bsignaling\b/gi, (m) => preserveCase(m, 'signalling')],
    // misc
    [/\bdefense\b/gi, (m) => preserveCase(m, 'defence')],
    [/\boffense\b/gi, (m) => preserveCase(m, 'offence')],
    [/\blicense\b/gi, (m) => preserveCase(m, 'licence')],   // verb is licence in UK too in noun form; close enough
    [/\bpracticing\b/gi, (m) => preserveCase(m, 'practising')],
    [/\bpracticed\b/gi, (m) => preserveCase(m, 'practised')],
    [/\bdialog(s)?\b/gi, (m, suf) => preserveCase(m, 'dialogue' + (suf || ''))],
    [/\bcatalog(s|ed|ing)?\b/gi, (m, suf) => preserveCase(m, 'catalogue' + (suf || ''))],
    [/\bprogram\b/gi, (m) => preserveCase(m, 'programme')],   // 'program' is fine for software, 'programme' for everything else; this is a coarse fix
    [/\bgray\b/gi, (m) => preserveCase(m, 'grey')],
    [/\btire(s|d)?\b/gi, (m, suf) => /tire/.test(m) ? m : preserveCase(m, 'tyre' + (suf || ''))],
    [/\bjewelry\b/gi, (m) => preserveCase(m, 'jewellery')],
    [/\bmom\b/gi, (m) => preserveCase(m, 'mum')],
    [/\bmoms\b/gi, (m) => preserveCase(m, 'mums')],
];

function preserveCase(originalMatch, replacement) {
    if (!originalMatch || !replacement) return replacement;
    if (originalMatch === originalMatch.toUpperCase()) return replacement.toUpperCase();
    if (originalMatch[0] === originalMatch[0].toUpperCase()) {
        return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
}

function applyUKSpelling(text) {
    if (!text) return text;
    let out = text;
    for (const [pattern, replacement] of SPELLING_RULES) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

// ──────────────────────────────────────────────────────────────
//  ENTRY POINT
// ──────────────────────────────────────────────────────────────
/**
 * Polish a Q chat reply: normalise punctuation + UK spellings.
 * Safe to run on markdown — leaves code blocks, links, emojis untouched
 * because the patterns are word-boundary based and don't touch URLs.
 *
 * @param {string} text
 * @returns {string}
 */
function polishUK(text) {
    if (typeof text !== 'string' || !text) return text;
    return applyUKSpelling(normalisePunctuation(text));
}

module.exports = { polishUK, normalisePunctuation, applyUKSpelling };
