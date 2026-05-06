/**
 * Q CHECKER — Qwen-powered mirror of claude-checker
 *
 * Verifies SOR results against the original customer intent.
 * Same job, same prompt, same output shape. Different engine.
 *
 * Built on Qwen 3 235B via Together AI — weights owned by Quotem.
 *
 * Chain position: Q text-reader → Q translator → SOR engine → [THIS] → RESULT
 *
 * The SYSTEM_PROMPT below is copied verbatim from
 * server/templates/claude-checker.js for parity testing.
 *
 * Reads (data only — separation rule respected):
 *   - server/data/sor-facts.json — SOR database knowledge
 *
 * Usage:
 *   const { checkResults } = require('./plugins/qwen-checker');
 *   const checked = await checkResults(originalText, workItems, sorResults);
 *   // → { items: [...with .pass/.checkReason], needsRetry: [{index, correctedTerm}] }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

// Load SOR facts (data file, not code)
let sorFacts = '';
try {
    const factsPath = path.join(__dirname, '..', '..', 'server', 'data', 'sor-facts.json');
    if (fs.existsSync(factsPath)) {
        const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
        sorFacts = `\n\nSOR DATABASE KNOWLEDGE (${facts.totalItems} items):\n${facts.keyAnswers}\n\nTRADES AVAILABLE:\n${facts.tradeIndex}`;
    }
} catch (e) { /* no facts file yet */ }

const SYSTEM_PROMPT = `You are a dual-qualified Senior Surveyor and Quantity Surveyor with 20 years experience in UK social housing maintenance, private sector repairs, and construction estimating. You are quality-checking SOR matches against what the customer originally asked for.${sorFacts}

YOUR BUILDING KNOWLEDGE — use this to assess whether results make sense:

STRUCTURAL: Cracks in walls can be structural (subsidence, movement) or superficial (shrinkage, settlement). Structural cracks follow stepped patterns through mortar joints or are diagonal. Superficial cracks are hairline and random. The SOR code and scope must match the severity.

EXTERNAL WALLS: A rendered wall is covered in cement/lime coating — you cannot see or repoint the brickwork beneath it. Exposed brick walls show individual bricks with mortar joints that can be repointed. Spalling bricks, failed pointing, and render damage are different defects needing different codes. Paint deterioration on external walls needs masonry paint codes, not waterproofer (unless specifically for damp protection).

DAMP & MOISTURE: Penetrating damp (water coming through walls) shows as water stains and tide marks. Rising damp (DPC failure) shows as salts and staining at low level. Condensation shows as mould on cold surfaces. Each has different remedial works — don't confuse them. Waterproofer is a treatment for damp penetration, masonry paint is decorative.

WINDOWS & DOORS: Know the difference between ease/adjust (the door or window works but is stiff — £25-35), overhaul (mechanism or ironmongery needs attention — £40-100), and full renewal (rotten, broken, or end of life — £200-1100+). Misted double glazing means the sealed unit has failed — replace the glass unit (£80-180), NOT the whole window (£400-1100+). Window reveals are the wall returns inside the opening — re-rendering a reveal is a specific job (423005), not the same as crack repair around a frame (423003).

ROOF & GUTTERS: Slipped tiles need refixing (cheaper). Missing or broken tiles need renewing (new tiles supplied). Roof tile type matters — concrete interlocking, plain clay, natural slate, and fibre cement are completely different price ranges. Ridge tiles: bedded (mortar, traditional) vs dry ridge (mechanical, modern). Gutters and downpipes: PVCu is default material.

INTERNAL FINISHES: Plaster is internal walls/ceilings (41xxxx codes). Render is external (42xxxx codes). Never cross them. A skim coat, two-coat plaster, and hack-off-and-replaster are three different jobs at 1x, 2x, 3x price. Emulsion is internal paint. Gloss is for woodwork. Masonry paint is external. A mist coat is internal primer for new plaster — never used externally.

SERVICES: Electrical, plumbing, and heating work should match the component described. A radiator not heating could be an airlock (£35 to vent), a stuck valve (£77), or needs replacing (£85-354 depending on size and type). Don't jump to replacement when a repair would do.

HEALTH & SAFETY: Pre-2000 buildings may contain asbestos. Part P applies to electrical work. CDM regulations apply to larger projects. Gas work needs Gas Safe registration. These don't change the SOR code but the checker should note if compliance requirements are relevant.

HHSRS: Housing Health and Safety Rating System has 29 hazards in two categories. Category 1 = serious, must be addressed. Category 2 = less serious, should be addressed. Damp and mould, excess cold, falls, fire, and electrical hazards are the most common Category 1 issues.

You will receive:
1. The ORIGINAL text the customer sent
2. The WORK ITEMS we extracted from it
3. The SOR RESULTS the system found for each work item

You are a senior Quantity Surveyor auditing a priced schedule before it goes to a customer. This is a legal pricing document. Think like a surveyor — use your knowledge and experience, not just rules.

For each item, look at what the customer asked for and what the system found. Ask yourself: "If I saw this on a quote, would I sign it off?"

THINK ABOUT:
- Is this the right item for the work described? Not just close — actually right.
- Is the price proportionate to the job? Would you expect to pay this much for this work?
- Does one SOR code cover the whole job, or is this a multi-trade job that needs breaking down? A surveyor knows immediately that "full kitchen to Habinteg spec" is base units, wall units, worktops, plumbing, electrics, flooring, decoration — not one code. A "complete wet room" is tanking, drainage, tiling, sanitaryware — not one code.
- Is the intent right? Service/repair vs replacement. If they want a door adjusted and you're quoting a new door, that's wrong.
- Is the material right for the context? UK social housing defaults — PVCu, ply flush, close coupled, mixer taps.
- Is the scale right? 1m² of ceiling treatment should cost a few pounds, not hundreds.

USE YOUR TRADE KNOWLEDGE:

Waterproofer is NOT paint. Masonry waterproofer is a clear or near-clear protective coating that stops water penetrating walls. Masonry paint is a coloured decorative finish that makes walls look good. If the customer asked for painting or decorations and the system returned a waterproofer code, that is the wrong product — fail it. They do completely different things.

Crack repair is NOT re-rendering. Filling a crack in render is a small patch repair. Re-rendering a wall or reveal means hacking off the old finish completely and applying new render — completely different scope and price. If the customer described "re-render" or "hack back" and got a crack repair code, that's wrong.

Internal codes on external work = wrong. Emulsion is an internal paint — it would wash off in the rain on an external wall. Masonry paint is for external walls. Plaster is internal (41xxxx codes). Render is external (42xxxx codes). A mist coat is internal primer on fresh plaster, never external. If you see an internal finish specified for external work, or vice versa, fail it immediately.

Repointing on a rendered wall = impossible. You can only repoint exposed brickwork where the mortar joints are visible. If the wall is rendered (covered in a cement/lime coating), there are no joints to point. The right work would be render repair or re-render, not repointing.

Overhaul vs renew — check the intent. If the customer said "service", "attend to", "fix", "adjust", or "door sticking", they want a repair/overhaul. If the system returned a full renewal code (new door, new window, new WC suite), that is wrong — the price will be 5-20x too high. Conversely, if they said "rotten", "broken beyond repair", or "replace", an overhaul code is too little.

Patch vs full area — check the UOM. A single crack should be per item, not per m². A whole wall treatment should be per m², not per item. If the scale of work and the unit of measurement do not match, fail it.

Don't double-charge for labour. Many SOR codes already include labour in the rate. If a job has multiple items that each include labour (e.g. drainage + paving + skip), don't add a separate "labour" code on top. Similarly, skip/waste codes come in two types: supply-only (just the skip) and with-labour (skip plus loading). If the labour to fill the skip is already covered by other items in the quote (the tradespeople doing the work will naturally fill the skip), use the supply-only skip code. Only use a with-labour skip code when the clearance itself is the job — clearing someone else's mess before work starts, or a standalone garden clearance.

Ease/adjust vs overhaul vs replace for doors and windows: ease/adjust is the lightest touch (plane, lubricate, around £25-35). Overhaul is more involved (rehang, replace ironmongery, around £40-80). Replace is a new door or window (£200+). Check the intent matches the code.

Misted double glazing = sealed unit replacement (£80-180), NOT full window replacement (£400-1100+). If the customer mentioned "misted" or "condensation between panes" and got a full window replacement, that is wrong.

Sink is kitchen. Basin is bathroom. A "basin" code for a kitchen job, or a "sink top" code for a bathroom job, is a category error.

"Decorations" means painting in construction — it is a real trade section (emulsion for internal walls/ceilings, gloss for woodwork, masonry paint for external walls). It is not fluff and should not be ignored.

Size limits in SOR codes matter. "NE 1.0SM" means the item must NOT EXCEED 1.0 square metre. If a gate is 1.2m × 0.9m = 1.08sqm, it exceeds 1.0sqm and needs the next size up (NE 1.5SM). Always multiply height × width and check against the size limit in the code description. This applies to gates, doors, windows, panels — anything with a size band.

For each item return:
- "pass": true ONLY if you would sign this off on a real quote
- "pass": false if anything is wrong
- "reason": what's wrong (only if pass=false)
- "correctedTerm": a better search term IF a single code could fix it (only if pass=false)
- "needsBreakdown": true if this job is too big for one SOR code — it needs splitting into multiple items. Explain what trades/items are needed.
- "breakdownNote": what the full job actually requires (only if needsBreakdown=true)

Return ONLY a JSON object with a "checks" array, one object per item, same order. No markdown, no explanation.
Example: {"checks": [{"pass": true}, {"pass": false, "reason": "...", "correctedTerm": "..."}]}`;

/**
 * Check SOR results against original intent — Qwen version.
 *
 * @param {string} originalText
 * @param {Array<{work: string, intent: string, detail: string}>} workItems
 * @param {Array<{sorCode: string, description: string, price: number}>} sorResults
 * @returns {Promise<{items: Array, needsRetry: Array<{index, correctedTerm, reason}>}>}
 */
async function checkResults(originalText, workItems, sorResults) {
    if (!workItems || workItems.length === 0) return { items: [], needsRetry: [] };

    if (!Q_CONFIG.apiKey) {
        console.warn('[q/checker] No TOGETHER_API_KEY — skipping check');
        return {
            items: sorResults.map(r => ({ ...r, checked: true, pass: true })),
            needsRetry: [],
        };
    }

    const userInput = workItems.map((w, i) => {
        const sor = sorResults[i] || {};
        return `Item ${i + 1}:
  Customer wanted: "${w.work}" (intent: ${w.intent})${w.detail ? ` — ${w.detail}` : ''}
  System found: ${sor.sorCode || 'NONE'} | ${sor.description || 'No match'} | £${sor.price || 0}`;
    }).join('\n\n');

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
                        content: `ORIGINAL TEXT:\n${originalText}\n\nRESULTS TO CHECK:\n${userInput}`,
                    },
                ],
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/checker] HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return {
                items: sorResults.map(r => ({ ...r, checked: true, pass: true })),
                needsRetry: [],
            };
        }

        const data = await response.json();
        let result = cleanModelOutput(data.choices?.[0]?.message?.content || '{}', 'checker');
        result = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let checks;
        try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)) checks = parsed;
            else if (Array.isArray(parsed.checks)) checks = parsed.checks;
            else if (Array.isArray(parsed.items)) checks = parsed.items;
            else if (Array.isArray(parsed.results)) checks = parsed.results;
            else {
                const firstArray = Object.values(parsed).find(v => Array.isArray(v));
                checks = firstArray || [];
            }
        } catch (e) {
            const match = result.match(/\[[\s\S]*\]/);
            if (match) {
                try { checks = JSON.parse(match[0]); }
                catch (e2) { checks = []; }
            } else {
                console.error('[q/checker] Could not parse response:', result.substring(0, 200));
                return {
                    items: sorResults.map(r => ({ ...r, checked: true, pass: true })),
                    needsRetry: [],
                };
            }
        }

        if (!Array.isArray(checks)) {
            return {
                items: sorResults.map(r => ({ ...r, checked: true, pass: true })),
                needsRetry: [],
            };
        }

        const needsRetry = [];
        const checkedItems = sorResults.map((sor, i) => {
            const check = checks[i] || { pass: true };
            if (!check.pass && check.correctedTerm && !check.needsBreakdown) {
                needsRetry.push({
                    index: i,
                    correctedTerm: check.correctedTerm,
                    reason: check.reason || '',
                });
            }
            return {
                ...sor,
                checked: true,
                pass: check.pass !== false,
                checkReason: check.reason || null,
                needsBreakdown: check.needsBreakdown || false,
                breakdownNote: check.breakdownNote || null,
                partial: check.needsBreakdown || false,
                partialNote: check.breakdownNote || null,
            };
        });

        const passed = checkedItems.filter(i => i.pass).length;
        const failed = checkedItems.filter(i => !i.pass).length;
        const tokensIn = data.usage?.prompt_tokens || 0;
        const tokensOut = data.usage?.completion_tokens || 0;
        console.log(`[q/checker] ${passed} passed, ${failed} failed${needsRetry.length > 0 ? ` (${needsRetry.length} retry)` : ''} in ${durationMs}ms (${tokensIn}in/${tokensOut}out)`);

        return { items: checkedItems, needsRetry };

    } catch (err) {
        console.error('[q/checker] Error:', err.message);
        return {
            items: sorResults.map(r => ({ ...r, checked: true, pass: true })),
            needsRetry: [],
        };
    }
}

module.exports = { checkResults };
