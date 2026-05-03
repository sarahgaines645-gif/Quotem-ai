/**
 * Q EXPANDER — Qwen-powered mirror of claude-expander
 *
 * Breaks down a multi-trade item (e.g. "full Habinteg kitchen") into
 * individual SOR items, each priceable with a single SOR code.
 *
 * Same job, same prompt, same output shape. Different engine.
 * Built on Qwen 3 235B via Together AI.
 *
 * Chain: checker flags needsBreakdown → [THIS] → translator → engine
 *
 * The SYSTEM_PROMPT is copied verbatim from
 * server/templates/claude-expander.js for parity testing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Q_CONFIG } = require('../config');

let sorFacts = '';
try {
    const factsPath = path.join(__dirname, '..', '..', 'server', 'data', 'sor-facts.json');
    if (fs.existsSync(factsPath)) {
        const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
        sorFacts = `\n\nSOR DATABASE KNOWLEDGE:\n${facts.keyAnswers}\n\nTRADES AVAILABLE:\n${facts.tradeIndex}`;
    }
} catch (e) {}

const SYSTEM_PROMPT = `You are a senior Quantity Surveyor breaking down a multi-trade job into individual SOR (Schedule of Rates) items.

You've been given a job that cannot be priced with a single SOR code. Break it into the individual components that each need their own code.${sorFacts}

RULES:
1. Each item must be a single, priceable piece of work — one trade, one task
2. Use standard trade language — "renew base unit", "supply and fit worktop", not "do the kitchen cupboards"
3. Include quantities where you can estimate them (a medium kitchen has ~3 base units, ~3 wall units)
4. Include the intent for each item — most will be "replace" for new installations
5. Be thorough but realistic — include everything a contractor would need to price, nothing they wouldn't
6. If a specification was mentioned (Habinteg, Part M, etc.), include the relevant accessibility requirements as separate items where they need separate codes (e.g. grab rails, lever taps)

Return ONLY a JSON object with an "items" array. Each item: {"work": "description", "intent": "replace|repair|inspect", "qty": 1, "unit": "NO|SM|LM", "detail": "specifics"}
Example: {"items": [{"work": "Renew kitchen base unit", "intent": "replace", "qty": 3, "unit": "NO", "detail": "500mm units"}]}
No markdown, no explanation.`;

/**
 * Expand a multi-code job into individual SOR-priceable items — Qwen version.
 *
 * @param {string} description
 * @param {string} breakdownNote
 * @returns {Promise<Array<{work, intent, qty, unit, detail}>>}
 */
async function expandItem(description, breakdownNote = '') {
    if (!Q_CONFIG.apiKey) {
        console.error('[q/expander] No TOGETHER_API_KEY');
        return [];
    }

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
                    { role: 'system', content: SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: `Break this down into individual SOR items:\n\nJOB: ${description}\n${breakdownNote ? `NOTES: ${breakdownNote}` : ''}`,
                    },
                ],
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/expander] HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return [];
        }

        const data = await response.json();
        let result = data.choices?.[0]?.message?.content || '{}';
        result = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let items;
        try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)) items = parsed;
            else if (Array.isArray(parsed.items)) items = parsed.items;
            else if (Array.isArray(parsed.results)) items = parsed.results;
            else {
                const firstArray = Object.values(parsed).find(v => Array.isArray(v));
                items = firstArray || [];
            }
        } catch (e) {
            const match = result.match(/\[[\s\S]*\]/);
            if (match) {
                try { items = JSON.parse(match[0]); }
                catch (e2) { items = []; }
            } else {
                console.error('[q/expander] Could not parse response:', result.substring(0, 200));
                return [];
            }
        }

        if (!Array.isArray(items)) return [];

        const cleaned = items
            .filter(i => i && typeof i.work === 'string' && i.work.trim().length > 0)
            .map(i => ({
                work: i.work.trim(),
                intent: (i.intent || 'replace').trim().toLowerCase(),
                qty: Number(i.qty) || 1,
                unit: (i.unit || 'NO').trim().toUpperCase(),
                detail: (i.detail || '').trim(),
            }));

        const tokensIn = data.usage?.prompt_tokens || 0;
        const tokensOut = data.usage?.completion_tokens || 0;
        console.log(`[q/expander] Expanded "${description.substring(0, 40)}..." into ${cleaned.length} items in ${durationMs}ms (${tokensIn}in/${tokensOut}out)`);
        return cleaned;

    } catch (err) {
        console.error('[q/expander] Error:', err.message);
        return [];
    }
}

module.exports = { expandItem };
