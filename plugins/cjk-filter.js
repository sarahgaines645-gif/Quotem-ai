/**
 * CJK output filter — strips Chinese, Japanese, and Korean characters from
 * model responses. Surgical: only blocks well-defined CJK Unicode ranges,
 * leaves all other characters (English, numbers, punctuation, currency,
 * accents, emoji) untouched.
 *
 * Ranges blocked:
 *   U+1100-U+11FF   Hangul Jamo
 *   U+3000-U+303F   CJK Symbols and Punctuation
 *   U+3040-U+309F   Hiragana
 *   U+30A0-U+30FF   Katakana
 *   U+3400-U+4DBF   CJK Unified Ideographs Extension A
 *   U+4E00-U+9FFF   CJK Unified Ideographs (main)
 *   U+AC00-U+D7AF   Hangul Syllables
 *   U+F900-U+FAFF   CJK Compatibility Ideographs
 *   U+FF00-U+FFEF   Halfwidth and Fullwidth Forms
 *   U+20000+        Extension B and beyond (surrogate pair range)
 *
 * Why: DeepSeek V3/V4 occasionally leak training-data CJK under load or on
 * meta questions. Selling to UK gov, can't have CJK characters appearing in
 * customer-visible output. This is the unfakeable backstop — runs on every
 * model response regardless of model, prompt, or load conditions.
 */
'use strict';

const CJK_PATTERN = '[\\u1100-\\u11FF\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF00-\\uFFEF]|[\\uD840-\\uD87F][\\uDC00-\\uDFFF]';

function containsCJK(text) {
  if (typeof text !== 'string' || !text) return false;
  return new RegExp(CJK_PATTERN).test(text);
}

function stripCJK(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(new RegExp(CJK_PATTERN, 'g'), '');
}

/**
 * Strip CJK from a model response and log if anything was removed.
 * Use this at the boundary where a Together AI response.content becomes
 * something the rest of the app sees.
 *
 * @param {string} text - The raw model output
 * @param {string} [label] - Short label for the log line (e.g. 'translator', 'chat')
 * @returns {string} - The cleaned text (identical to input if nothing was stripped)
 */
function cleanModelOutput(text, label) {
  if (typeof text !== 'string' || !text) return text;
  if (!containsCJK(text)) return text;
  const cleaned = stripCJK(text);
  const removed = text.length - cleaned.length;
  const tag = label ? `[cjk-filter:${label}]` : '[cjk-filter]';
  console.warn(`${tag} stripped ${removed} CJK char(s) from model output`);
  return cleaned;
}

module.exports = { containsCJK, stripCJK, cleanModelOutput, CJK_PATTERN };
