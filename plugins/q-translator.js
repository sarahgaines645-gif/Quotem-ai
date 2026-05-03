/**
 * Q TRANSLATOR — Qwen-powered mirror of claude-translator
 *
 * Same job, same prompt, same output shape. Different engine.
 * Built on Qwen 3 235B via Together AI — weights owned by Quotem.
 *
 * Takes work items from Q's text-reader (or any compatible reader) and
 * translates them into SOR search terms a QS would type into the database.
 *
 * Chain position: Q text-reader → [THIS] → SOR engine (Gemini) → Q checker
 *
 * The SYSTEM_PROMPT below is copied verbatim from
 * server/templates/claude-translator.js for parity testing. Any prompt
 * edits should happen in BOTH files until we deliberately diverge.
 *
 * Reads (data, not code — separation rule respected):
 *   - server/data/sor-facts.json        — SOR database knowledge
 *   - server/data/translation_learnings.json — past corrections to avoid
 *
 * Usage:
 *   const { translateToSOR } = require('./plugins/qwen-translator');
 *   const terms = await translateToSOR([
 *     { work: 'Service and align door', intent: 'repair', detail: 'ensure correct operation' }
 *   ]);
 *   // → ['door ease adjust']
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Q_CONFIG } = require('../config');

// Load SOR facts (data file, not code)
let sorFacts = '';
try {
    const factsPath = path.join(__dirname, '..', '..', 'server', 'data', 'sor-facts.json');
    if (fs.existsSync(factsPath)) {
        const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
        sorFacts = `\n\nSOR DATABASE KNOWLEDGE:\n${facts.keyAnswers}`;
    }
} catch (e) { /* no facts file yet */ }

const SYSTEM_PROMPT = `You are a senior UK Quantity Surveyor with 20 years experience. You are writing search terms for an SOR (Schedule of Rates) database.${sorFacts}

You will receive work items with an intent (repair/replace/inspect). Return the 3-6 word search term a QS would type to find the right item.

THINK LIKE A SURVEYOR:

1. STRIP THE FLUFF — only the PHYSICAL WORK goes to the database. Reasons, explanations, and context are NOT search terms:
   - "to prevent vermin access" → the work is SEAL, not vermin
   - "to stop the cold" → the work is DRAUGHT-PROOF or INSULATE, not cold
   - "to ensure correct operation" → the work is EASE ADJUST, not operation
   - "due to water damage" → the work is whatever you're repairing, not water

2. IDENTIFY THE COMPONENT FIRST — what physical thing are you working on? Door, window, ceiling, fan, tile, roof, pipe. Start with that.

3. THEN THE ACTION — what are you doing to it? Based on intent:
   - repair → ease, adjust, overhaul, make good, reseal, refix, treat, clean
   - replace → renew, install, fit
   - inspect → inspect, survey, investigate

4. THEN THE MATERIAL (only if it matters for the search):
   - If specified, use it
   - If not specified, use the most common for UK social housing: PVCu windows, ply flush internal doors, hardwood external doors, close coupled WC, PVCu gutters, single panel radiator, mixer taps

5. INCLUDE SIZE/QUANTITY if given — "1m² ceiling" should include the scale so the database returns appropriately sized items, not whole-room treatments

6. SENSE CHECK — would a surveyor actually order this? If someone asks for a fire door made from paper, that's not a search term, that's a problem. Flag nonsensical requests by returning "FLAG: [reason]" instead of a search term.

7. TRADE UNDERSTANDING — know what the work actually IS:

DECORATIONS means painting. "External decorations" = external painting (masonry paint, gloss to woodwork). This is a real trade section with real SOR codes. Never strip it as fluff.

MASONRY PAINT vs MASONRY WATERPROOFER — completely different products, different codes. Paint gives colour and finish (decorative). Waterproofer is a clear or near-clear protective sealant (protective). If the customer said "paint the walls", search for masonry PAINT, not waterproofer.

RENDER vs PLASTER — render is external, plaster is internal. Render codes are in the 42xxxx range. Plaster codes are in the 41xxxx range. Never cross internal and external codes.

RE-RENDER = hack off existing render and apply new (RENEW intent — search "render renew" or "render wall"). RENDER REPAIR / CRACK REPAIR = fill and patch (REPAIR intent — search "render repair crack"). The "re-" prefix in construction means do the whole job again, not just touch it up.

REVEAL = the wall return inside a window or door opening. "Renew reveal" is a specific SOR term for replastering or re-rendering these surfaces. It is NOT the whole window.

OVERHAUL vs RENEW — overhaul means service and repair the existing item (tighten, lubricate, adjust, reseal). Renew means rip it out and fit a new one. A door overhaul is around £30-50. A door renewal is £200-500. The price difference is enormous. Match the intent precisely.

SKIM vs TWO-COAT vs HACK-OFF-AND-REPLASTER — three different plastering jobs at roughly 1x, 2x, and 3x the price. Skim is a thin finishing coat on existing. Two-coat is undercoat + skim on a stripped surface. Hack-off means removing the old plaster first (additional work on top of replastering).

PATCH REPAIR vs FULL AREA — patch repairs are priced per item (NR/NO). Full-area work is priced per m² (SM). If the customer describes one crack, search for a patch repair. If they describe an entire wall, search for per-m² rates.

SINK vs BASIN — sink is kitchen (stainless steel, deeper, with drainer). Basin is bathroom (ceramic, wall-mounted or pedestal). These are different SOR sections entirely. Never put a basin in a kitchen or a sink in a bathroom.

KEEP IT SHORT: 3-6 words. Component + action + material. No reasons, no fluff, no explanations.

Return ONLY a JSON array of strings, one per input, same order. No markdown, no explanation.`;

/**
 * Translate work items to SOR search terms — Qwen version.
 *
 * @param {Array<{work: string, intent: string, detail: string}>} items
 * @returns {Promise<string[]>} SOR search terms, same order as input
 */
async function translateToSOR(items) {
    if (!items || items.length === 0) return [];

    if (!Q_CONFIG.apiKey) {
        console.error('[q/translator] No TOGETHER_API_KEY — falling back to work descriptions');
        return items.map(i => i.work);
    }

    const userInput = items.map((it, i) =>
        `${i + 1}. ${JSON.stringify({ work: it.work, intent: it.intent, detail: it.detail })}`
    ).join('\n');

    // Load past learnings (data file, not code) so Q avoids repeating known bad translations
    let learningContext = '';
    try {
        const learningPath = path.join(__dirname, '..', '..', 'server', 'data', 'translation_learnings.json');
        if (fs.existsSync(learningPath)) {
            const learnings = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
            if (Array.isArray(learnings) && learnings.length > 0) {
                const recent = learnings.slice(-30);
                learningContext = '\n\nPAST CORRECTIONS — avoid these bad translations:\n' +
                    recent.map(l => `"${l.input}" → DON'T use "${l.firstTerm}" (Gemini found wrong item: ${l.geminiChose}). USE "${l.correctedTerm}" instead.`).join('\n');
            }
        }
    } catch (e) { /* no learnings yet */ }

    try {
        const startTime = Date.now();
        const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: Q_CONFIG.model,
                max_tokens: 4096,
                temperature: Q_CONFIG.temperature,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT + learningContext },
                    { role: 'user', content: userInput },
                ],
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/translator] HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return items.map(i => i.work);
        }

        const data = await response.json();
        let result = data.choices?.[0]?.message?.content || '[]';
        result = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let terms;
        try {
            // Qwen with response_format json_object may wrap in {"terms": [...]}
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)) terms = parsed;
            else if (Array.isArray(parsed.terms)) terms = parsed.terms;
            else if (Array.isArray(parsed.results)) terms = parsed.results;
            else if (Array.isArray(parsed.translations)) terms = parsed.translations;
            else {
                // Look for any array property
                const firstArray = Object.values(parsed).find(v => Array.isArray(v));
                terms = firstArray || [];
            }
        } catch (e) {
            const match = result.match(/\[[\s\S]*\]/);
            if (match) {
                try { terms = JSON.parse(match[0]); }
                catch (e2) { terms = []; }
            } else {
                console.error('[q/translator] Could not parse response:', result.substring(0, 200));
                return items.map(i => i.work);
            }
        }

        if (!Array.isArray(terms)) return items.map(i => i.work);

        const output = terms
            .map((t, i) => (typeof t === 'string' && t.trim().length > 0) ? t.trim() : (items[i]?.work || ''))
            .slice(0, items.length);

        while (output.length < items.length) output.push(items[output.length]?.work || '');

        const tokensIn = data.usage?.prompt_tokens || 0;
        const tokensOut = data.usage?.completion_tokens || 0;
        console.log(`[q/translator] Translated ${output.length} items in ${durationMs}ms (${tokensIn}in/${tokensOut}out)`);
        return output;

    } catch (err) {
        console.error('[q/translator] Error:', err.message);
        return items.map(i => i.work);
    }
}

module.exports = { translateToSOR };
