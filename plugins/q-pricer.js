/**
 * Q PRICER — Qwen-powered mirror of claude-pricer
 *
 * Prices items that fall outside the standard SOR catalogue using
 * real-world UK construction knowledge. Same prompt as Claude's version.
 *
 * Built on Qwen 3 235B via Together AI.
 *
 * KEY DIFFERENCE from Claude's pricer:
 * Claude's pricer WRITES new priced items into server/data/quotem_pricing.csv
 * (Quotem's live pricing database). Q's pricer is intentionally READ-ONLY —
 * it returns prices but does not write to Quotem's database. This keeps the
 * test boundary clean. If Q gets promoted to live use later, write-back can
 * be added then.
 *
 * Chain position: checker flags off-catalogue → [THIS] → priced item
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

const SYSTEM_PROMPT = `You are a senior UK Quantity Surveyor pricing construction work that falls outside a standard Schedule of Rates.

You price jobs using real-world UK costs:
- MATERIALS: Current UK builders merchant prices (Screwfix, Toolstation, Travis Perkins, Jewson). You know what things cost.
- LABOUR: Current UK trade rates. General labourer £15-18/hr. Skilled tradesperson (carpenter, plumber, electrician) £25-35/hr. Specialist (structural, gas safe) £35-50/hr.
- PLANT: If equipment is needed (mini digger, scaffold, skip), include hire costs.
- QUANTITIES: Work out how much material is needed from the dimensions given.

RULES:
1. Price per UNIT (each item, per metre, per m², whatever fits). The quantity is handled separately.
2. Give a single unit price that covers materials + labour for ONE unit of the work.
3. Be realistic — not cheap, not expensive. What would a mid-range contractor actually charge?
4. If dimensions are given, use them to calculate materials accurately.
5. Include fixings, adhesives, screws, brackets — all the sundries a tradesperson would use.
6. Round to 2 decimal places.

FORMAT THE DESCRIPTION like an SOR entry — COMPONENT:ACTION DETAILS. Examples:
- "PLANTER:CONSTRUCT FROM TIMBER SLEEPERS 3M X 1.2M"
- "GATE:SUPPLY AND INSTALL TIMBER PEDESTRIAN 1.8M"
- "DECKING:SUPPLY AND LAY SOFTWOOD TREATED NE 20SM"
- "PERGOLA:CONSTRUCT SOFTWOOD 3M X 3M"

Return ONLY a JSON object:
{
  "description": "PLANTER:CONSTRUCT FROM TIMBER SLEEPERS 3M X 1.2M",
  "unitPrice": 285.50,
  "unit": "NR",
  "breakdown": "Materials: 14x sleepers £18 each = £252, coach bolts/fixings £25, fabric £8. Labour: 6hrs @ £30 = £180"
}

Unit types: NR (number/each), LM (linear metre), SM (square metre), IT (per item). Pick what fits.
No markdown, no explanation outside the JSON.`;

/**
 * Price a single off-catalogue item using Q's knowledge.
 * READ-ONLY — does not write to any database.
 *
 * @param {string} work
 * @param {string} intent
 * @param {string} detail
 * @returns {Promise<{description, unitPrice, unit, breakdown}|null>}
 */
async function priceItem(work, intent, detail) {
    if (!Q_CONFIG.apiKey) {
        console.error('[q/pricer] No TOGETHER_API_KEY');
        return null;
    }

    try {
        const userInput = `Price this work item:
Work: ${work}
Intent: ${intent || 'replace'}
Details: ${detail || 'none given'}`;

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
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userInput },
                ],
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/pricer] HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return null;
        }

        const data = await response.json();
        let result = cleanModelOutput(data.choices?.[0]?.message?.content || '{}', 'pricer');
        result = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(result);
        } catch (e) {
            const match = result.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]);
            else {
                console.error('[q/pricer] Could not parse response:', result.substring(0, 200));
                return null;
            }
        }

        if (!parsed.unitPrice || !parsed.description) {
            console.error('[q/pricer] Invalid response shape:', JSON.stringify(parsed).substring(0, 200));
            return null;
        }

        const unitPrice = parseFloat(parsed.unitPrice) || 0;
        const unit = parsed.unit || 'NR';
        const tokensIn = data.usage?.prompt_tokens || 0;
        const tokensOut = data.usage?.completion_tokens || 0;

        console.log(`[q/pricer] Priced "${work}" → £${unitPrice}/${unit} in ${durationMs}ms (${tokensIn}in/${tokensOut}out)`);
        return {
            description: parsed.description,
            unitPrice,
            unit,
            breakdown: parsed.breakdown || '',
        };

    } catch (err) {
        console.error('[q/pricer] Error:', err.message);
        return null;
    }
}

/**
 * Batch-price multiple items in one call (cheaper than individual calls).
 *
 * @param {Array<{work, intent, detail}>} items
 * @returns {Promise<Array<{description, unitPrice, unit, breakdown}|null>>}
 */
async function priceItems(items) {
    if (!Q_CONFIG.apiKey || !items || items.length === 0) {
        return (items || []).map(() => null);
    }

    try {
        const userInput = items.map((it, i) =>
            `${i + 1}. Work: ${it.work}\n   Intent: ${it.intent || 'replace'}\n   Details: ${it.detail || 'none'}`
        ).join('\n\n');

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
                    { role: 'system', content: SYSTEM_PROMPT + '\n\nYou are pricing MULTIPLE items. Return a JSON object with an "items" array, one object per input item, same order. Example: {"items": [{...}, {...}]}' },
                    { role: 'user', content: userInput },
                ],
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/pricer] batch HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return items.map(() => null);
        }

        const data = await response.json();
        let result = cleanModelOutput(data.choices?.[0]?.message?.content || '{}', 'pricer');
        result = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let arr;
        try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)) arr = parsed;
            else if (Array.isArray(parsed.items)) arr = parsed.items;
            else if (Array.isArray(parsed.results)) arr = parsed.results;
            else {
                const firstArray = Object.values(parsed).find(v => Array.isArray(v));
                arr = firstArray || [parsed];
            }
        } catch (e) {
            console.error('[q/pricer] batch parse error:', e.message);
            return items.map(() => null);
        }

        console.log(`[q/pricer] Batch priced ${arr.length} items in ${durationMs}ms`);
        return arr.map(p => (p && p.unitPrice) ? {
            description: p.description || '',
            unitPrice: parseFloat(p.unitPrice) || 0,
            unit: p.unit || 'NR',
            breakdown: p.breakdown || '',
        } : null);

    } catch (err) {
        console.error('[q/pricer] Batch error:', err.message);
        return items.map(() => null);
    }
}

module.exports = { priceItem, priceItems };
