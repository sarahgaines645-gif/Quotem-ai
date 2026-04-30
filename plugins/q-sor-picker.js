/**
 * Q SOR PICKER — Qwen-powered mirror of Gemini's role in sor-engine.js
 *
 * Same job: given a work description + 15 waterfall candidates,
 * pick ONE using the QS Principles. Same prompt copied verbatim from
 * server/templates/sor-engine.js (QS_PERSONA + selection instructions).
 *
 * Test purpose only: lets us A/B Q vs Gemini on the SOR-picking step
 * while keeping Claude on the surrounding stages (reader, checker).
 *
 * Built on DeepSeek V4 Pro (Q's current engine) via Together AI.
 */
'use strict';

const { Q_CONFIG } = require('../config');

// QS_PERSONA — copied verbatim from server/templates/sor-engine.js
// Must stay in sync with the source. If sor-engine's persona changes, update this.
const QS_PERSONA = `You are a senior Quantity Surveyor with 20 years experience in UK social housing maintenance. You work for a council housing department. You know:

- Modern social housing uses PVCu windows, not softwood. Softwood is old stock from the 70s/80s.
- The standard WC is close coupled (630509). Low level with plastic cistern is old council stock.
- The standard internal door is ply flush (330001). Fire doors are specialist items.
- External doors default to hardwood panelled or composite.
- Gutters, downpipes, fascia, soffit — all PVCu unless the property is listed/period.
- Standard radiator is a single panel convector.
- Standard tap is a mixer, not separate pillar taps.

When someone says just 'window' with no other context, you think PVCu casement because that's what every council estate has had fitted for the last 20 years.

QS PRINCIPLES:
1. KEYWORD POSITION: The item starting with the keyword is the main item
2. RENEW vs REPAIR: Default to RENEW (new) unless user says fix/repair/overhaul
3. PRIMARY COMPONENT: SINK:RENEW = a sink, not a pipe that mentions sink
4. ARCHITECTURAL STYLE: Georgian = sash, modern = casement

CRITICAL: Each line below is ONE LOCKED UNIT. CODE, ITEM and PRICE belong together. NEVER mix them.`;

/**
 * Pick the best SOR item from a candidate list, using Q (DeepSeek).
 * Mirror of Gemini's role in sor-engine.js.
 *
 * @param {string} description - Work description ("toilet", "fix leaky tap")
 * @param {Array<{sorCode, description, price, unit}>} candidates - From waterfall (~15 items)
 * @param {object} [options] - { context: 'bathroom' }
 * @returns {Promise<{sorCode, description, price, unit, _meta}>}
 */
async function pickSOR(description, candidates, options = {}) {
    if (!description || !candidates || candidates.length === 0) {
        return null;
    }

    // Single candidate — no need to call Q
    if (candidates.length === 1) {
        return {
            sorCode: candidates[0].sorCode,
            description: candidates[0].description,
            price: candidates[0].price,
            unit: candidates[0].unit || 'NO',
            _meta: { engine: 'q', skipped: 'single-candidate' },
        };
    }

    if (!Q_CONFIG.apiKey) {
        // Fallback: return first candidate, same as sor-engine.js does for failures
        return {
            ...candidates[0],
            _meta: { engine: 'q', error: 'no-api-key', fallback: 'first-candidate' },
        };
    }

    const { context = '' } = options;
    const list = candidates.map(r =>
        `[CODE:${r.sorCode} | ITEM:${r.description} | PRICE:£${r.price}${r.unit ? '/' + r.unit : ''}]`
    ).join('\n');

    const systemInstruction = `You are a Quantity Surveyor selecting the single best SOR item for a work description.

${QS_PERSONA}

${context ? `CONTEXT: ${context}` : ''}

RESPONSE FORMAT: Return ONLY a JSON object with the selected item. No prose, no markdown.
{"sorCode":"123456","description":"ITEM DESCRIPTION","price":99.99,"unit":"NO"}`;

    const userMessage = `User asked for: "${description}"

Database items (${candidates.length}):
${list}

Apply QS principles. Select the ONE item that best matches. Return JSON only.`;

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
                max_tokens: 512,
                temperature: 0.0,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: userMessage },
                ],
                response_format: { type: 'json_object' },
            }),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[q/sor-picker] HTTP ${response.status}: ${errText.substring(0, 200)}`);
            return {
                ...candidates[0],
                _meta: { engine: 'q', error: `HTTP ${response.status}`, fallback: 'first-candidate', durationMs },
            };
        }

        const data = await response.json();
        let text = data.choices?.[0]?.message?.content || '{}';
        text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        let picked;
        try {
            picked = JSON.parse(text);
        } catch (e) {
            const m = text.match(/\{[\s\S]*\}/);
            if (m) picked = JSON.parse(m[0]);
            else {
                console.error('[q/sor-picker] Could not parse:', text.substring(0, 200));
                return {
                    ...candidates[0],
                    _meta: { engine: 'q', error: 'parse-failed', fallback: 'first-candidate', durationMs },
                };
            }
        }

        // Q sometimes returns the code under a different field name.
        // Try every plausible variant before falling back.
        const pickedCode = picked.sorCode
            || picked.sor_code
            || picked.SORCode
            || picked.code
            || picked.SOR
            || picked.selected
            || (picked.item && (picked.item.sorCode || picked.item.code))
            || null;

        const verified = pickedCode ? candidates.find(c => c.sorCode === pickedCode) : null;
        if (verified) {
            return {
                sorCode: verified.sorCode,
                description: verified.description,
                price: verified.price,
                unit: verified.unit || 'NO',
                _meta: {
                    engine: 'q',
                    model: Q_CONFIG.model,
                    durationMs,
                    tokensIn: data.usage?.prompt_tokens || 0,
                    tokensOut: data.usage?.completion_tokens || 0,
                },
            };
        }

        console.log(`[q/sor-picker] ⚠️ picked ${pickedCode} not in candidates. Raw keys: ${Object.keys(picked).join(',')} | Raw: ${JSON.stringify(picked).substring(0, 200)}`);
        return {
            ...candidates[0],
            _meta: { engine: 'q', error: 'hallucinated-or-missing-code', wanted: pickedCode, rawKeys: Object.keys(picked), fallback: 'first-candidate', durationMs },
        };

    } catch (err) {
        console.error('[q/sor-picker] Error:', err.message);
        return {
            ...candidates[0],
            _meta: { engine: 'q', error: err.message, fallback: 'first-candidate' },
        };
    }
}

module.exports = { pickSOR };
