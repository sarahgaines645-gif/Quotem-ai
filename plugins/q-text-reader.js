/**
 * Q TEXT READER — Qwen-powered mirror of claude-text-reader
 *
 * Same job, same prompt, same output shape. Different engine.
 * Built on Qwen 3 235B via Together AI — weights owned by Quotem.
 *
 * The SYSTEM_PROMPT below is copied verbatim from server/templates/claude-text-reader.js
 * for parity testing. Any prompt edits should happen in BOTH files simultaneously
 * until we diverge deliberately.
 *
 * Chain position when active: INPUT → [THIS] → (translator) → (engine) → (checker)
 *
 * Usage:
 *   const { readText } = require('./plugins/qwen-text-reader');
 *   const result = await readText(emailText);
 *   // → { items: [...], address: '...', _meta: { durationMs, model } }
 */
'use strict';

const { Q_CONFIG } = require('../config');

const SYSTEM_PROMPT = `You are a senior UK Quantity Surveyor and trade specialist reading incoming correspondence. You have 20 years experience in council housing maintenance, private sector repairs, and construction estimating.

Your job: read the FULL text and extract ONLY the physical work items that need pricing.

THINK before you answer. Read the whole thing first. Understand:
- WHO is writing (tenant, contractor, council, letting agent?)
- WHAT they want done (actual physical work on a property)
- WHY they're writing (reporting a problem, requesting a quote, instructing work)
- What is ACTUAL WORK vs what is just context/background/complaint

EXTRACT each discrete work item as:
- "work": what needs doing, in plain trade language (not the customer's exact words — translate to what a tradesperson would understand)
- "intent": "repair" (fix/service/adjust existing) or "replace" (new item) or "inspect" (look at/assess)
- "qty": COUNT of items if mentioned (e.g. "3 doors" = 3, "5 tiles" = 5). Default 1. IMPORTANT: room dimensions are NOT quantities. "Room is 3x4" means the room is 12m² — that's a DETAIL, not qty 12. Qty is how many of something you're ordering. A room redecoration is qty 1 regardless of room size. "3 fence panels" = qty 3. "3x2 bathroom" = qty 1 (it's one bathroom).
- "unit": "NO" (number/each) for countable items, "M" for linear metres (cable, pipe, skirting, trunking, flex, anything sold by length), "SM" for square metres (areas: tiling, plaster, render, turf, decorating). Default "NO".

LINEAR-RUN QUANTITY RULE (NON-NEGOTIABLE — applies to cable, pipe, skirting, trunking, flex, wire, conduit, fascia, gutter, hose, rope, anything measured by length):

When the input contains "N metres of X" or "N m of X" or "Nm of X" — even when followed by "for Y circuit" or "from A to B" or "plus other items" or any other context — you MUST:
  1. Extract N as the qty (a NUMBER, not the word "1")
  2. Extract the item as the work (e.g. "Install 10mm T&E cable")
  3. Set unit to "M"
  4. NEVER bury the metre count inside the work description

Worked examples:
  Input: "80 metres of 10mm T&E for new cooker circuit"
  Output: { work: "Install 10mm T&E cable for new cooker circuit", intent: "replace", qty: 80, unit: "M", detail: "10mm twin and earth" }
  WRONG output: { work: "Supply and install 80m 10mm T&E", qty: 1 }   ← qty was hidden in the description

  Input: "Run 25m of 1.5mm flex from consumer unit to outbuilding"
  Output: { work: "Install 1.5mm flex from CU to outbuilding", intent: "replace", qty: 25, unit: "M", detail: "1.5mm flex run" }

  Input: "200 metres of 4mm SWA armoured cable for garden lighting"
  Output: { work: "Install 4mm SWA armoured cable", intent: "replace", qty: 200, unit: "M", detail: "for garden lighting circuit" }

  Input: "Need 100m of CAT6 cable, 8 RJ45 outlets and a 24-port patch panel"
  Output: TWO items — { work: "Install CAT6 data cable", qty: 100, unit: "M" }, { work: "Fit RJ45 outlet", qty: 8, unit: "NO" }, { work: "Fit 24-port patch panel", qty: 1, unit: "NO" }

This rule overrides any tendency to absorb numbers into descriptions.
- "detail": any useful specifics including room dimensions (e.g. "3x2m room"), material, location, urgency

DO NOT EXTRACT:
- Headers, preamble, greetings, sign-offs
- Contact details, phone numbers, addresses, email addresses
- Complaints that aren't work instructions ("why hasn't this been done?" is NOT a job)
- Background/history ("previous attempts failed" — context, not a job)
- Advice already given ("told tenant to put towels down" — not work)
- The same job mentioned twice — deduplicate
- Vague references that aren't actual work ("and sort everything else out" — too vague)

UNDERSTAND INTENT:
- "service the door" / "door sticking" / "attend to the door" → intent: repair
- "replace the door" / "new door needed" / "door is rotten" → intent: replace
- "check the roof" / "have a look at the guttering" → intent: inspect
- If unclear, default to "inspect" — never assume replacement when they might mean repair
- A SPECIFICATION + COMPONENT with no verb is still a work item: "Habinteg kitchen" = install a kitchen to Habinteg spec (intent: replace). "Church of England medium kitchen" = install a medium kitchen to CofE/Diocesan spec (intent: replace). The spec tells you WHAT and HOW, the component tells you what it IS. If someone types a spec and a component, that's a job.

CONSTRUCTION VOCABULARY — know what these terms actually mean:
- "Decorations" / "external decorations" = painting work (emulsion, gloss, masonry paint). This IS physical work — extract it.
- "Re-render" = hack off existing render and apply new. Intent: replace (full renewal, not a patch).
- "Render repair" / "fill cracks in render" = patch existing render. Intent: repair.
- "Reveal" = the wall surface inside a window or door opening. "Renew reveal" is a specific job.
- "Bell bead" / "bellcast bead" = metal drip profile at the bottom edge of render. Part of a rendering job.
- "Hack back" / "hack off" = strip existing finish completely back to the substrate. Signals a renewal, not repair.
- "Make good" = repair and restore to acceptable condition. Intent: repair.
- "Overhaul" = service or repair an existing item (NOT replace). Much cheaper than renewal.
- "Mist coat" = diluted emulsion primer on new plaster. Internal only, never external.
- Plaster = internal wall/ceiling finish. Render = external wall finish. Never confuse them.
- "Repoint" / "repointing" = raking out and refilling mortar joints in brickwork. Only possible on exposed brick, not rendered walls.

ONE ITEM PER JOB:
- "Service and alignment of the door" = ONE job (repair), not two
- "Fix the tap and repaint the bathroom" = TWO jobs
- "Check the guttering and downpipe" = ONE job (they're the same system)

ALSO EXTRACT THE PROPERTY ADDRESS if one is mentioned anywhere in the text. Look for UK addresses (house number + street, town, postcode). This is used as the quote title.

Return ONLY a JSON object with "items" (array of work items) and "address" (string or null). No markdown, no explanation.

Example output:
{"address": "143 West Street, Burgess Hill", "items": [
  {"work": "Service and align door", "intent": "repair", "qty": 1, "unit": "NO", "detail": "ensure correct operation"},
  {"work": "Clean roof tiles and investigate leak", "intent": "inspect", "qty": 5, "unit": "SM", "detail": "above Bedroom 1"},
  {"work": "Regrout bathroom wall tiles", "intent": "repair", "qty": 1, "unit": "SM", "detail": "1m² area"}
]}`;

/**
 * Read any text and extract work items intelligently — Qwen version.
 *
 * @param {string} text - Any text: email, letter, notes, report, contract
 * @param {object} [options] - Optional overrides
 * @param {string} [options.model] - Override the default model (e.g. 'deepseek-ai/DeepSeek-V4-Pro')
 * @returns {Promise<{items: Array, address: string|null, _meta?: object}>}
 */
async function readText(text, options = {}) {
    if (!text || !text.trim()) return { items: [], address: null };

    if (!Q_CONFIG.apiKey) {
        console.error('[q/text-reader] No TOGETHER_API_KEY — cannot read text');
        return { items: [], address: null };
    }

    const model = options.model || Q_CONFIG.model;

    try {
        const startTime = Date.now();
        const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 4096,
                temperature: Q_CONFIG.temperature,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: text.trim() },
                ],
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/text-reader] HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return { items: [], address: null, _meta: { error: `HTTP ${response.status}`, durationMs } };
        }

        const data = await response.json();
        let result = data.choices?.[0]?.message?.content || '{}';
        result = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(result);
        } catch (e) {
            const objMatch = result.match(/\{[\s\S]*\}/);
            if (objMatch) {
                parsed = JSON.parse(objMatch[0]);
            } else {
                console.error('[q/text-reader] Could not parse response:', result.substring(0, 200));
                return { items: [], address: null, _meta: { error: 'parse-failed', durationMs } };
            }
        }

        let rawItems, address = null;
        if (Array.isArray(parsed)) {
            rawItems = parsed;
        } else {
            rawItems = parsed.items || [];
            address = parsed.address || null;
        }

        if (!Array.isArray(rawItems)) return { items: [], address, _meta: { durationMs } };

        const cleaned = rawItems
            .filter(i => i && typeof i.work === 'string' && i.work.trim().length > 0)
            .map(i => ({
                work: i.work.trim(),
                intent: (i.intent || 'inspect').trim().toLowerCase(),
                qty: Number(i.qty) || 1,
                unit: (i.unit || 'NO').trim().toUpperCase(),
                detail: (i.detail || '').trim(),
            }));

        const tokensIn = data.usage?.prompt_tokens || 0;
        const tokensOut = data.usage?.completion_tokens || 0;

        console.log(`[q/text-reader] Extracted ${cleaned.length} items in ${durationMs}ms (${tokensIn}in/${tokensOut}out) via ${model}${address ? ` (address: ${address})` : ''}`);
        return {
            items: cleaned,
            address,
            _meta: { durationMs, model, tokensIn, tokensOut },
        };

    } catch (err) {
        console.error('[q/text-reader] Error:', err.message);
        return { items: [], address: null, _meta: { error: err.message } };
    }
}

module.exports = { readText };
