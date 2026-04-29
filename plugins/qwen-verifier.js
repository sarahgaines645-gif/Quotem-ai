/**
 * Q VERIFIER — silent self-check after Q drafts a reply.
 *
 * Generalises the SOR-checker pattern (q-lab/plugins/qwen-checker.js was the
 * specific case for SOR results) into a reusable wrapper that can vet ANY
 * generation against the user's actual question.
 *
 * Flow:
 *   user message + Q's draft reply
 *     → second Q call with strict-reviewer system prompt
 *     → JSON { pass, issues, corrected }
 *   if pass: return the draft as-is
 *   if fail: return the rewritten "corrected" version that fixes the issues
 *
 * Use case: chat.html has a "Check" toggle. When on, every Q reply runs
 * through here before being shown. ~2x latency, but for hard or important
 * questions (and for any background-job context where no human's watching),
 * the catch rate is worth it.
 *
 * Failure modes are handled defensively — if the verifier itself fails for
 * any reason (HTTP error, bad JSON, missing API key), we return pass=true
 * with the original draft so the user still gets an answer.
 */
'use strict';

const { Q_CONFIG } = require('../config');

const VERIFIER_SYSTEM = `You are a strict quality reviewer. Given a user's question and an AI's draft reply, find any way the draft fails to meet the user's actual need.

Look for:
- Missed requirements or constraints stated in the question
- Factual errors or unsupported claims
- Logical gaps or contradictions
- Format mismatches (asked for a list, got prose; asked for code, got explanation)
- Hedging when a direct answer was wanted, or vice versa
- Things the question implied but the draft ignored
- Stale dates, wrong currencies, wrong units

Return JSON only, in this exact shape:
{
  "pass": boolean,
  "issues": [string],
  "corrected": string
}

Rules:
- "pass" is true ONLY if the draft genuinely answers the question well. A draft that is 90% right but missed one explicit requirement is a fail.
- "issues" is empty when pass is true; otherwise list each concrete problem.
- "corrected" must be a complete rewritten reply when pass is false. The corrected reply MUST visibly fix every issue you listed — don't just acknowledge issues, fix them. If pass is true, copy the original draft into "corrected" verbatim.
- Be strict. The user is relying on you to catch what they wouldn't notice.`;

/**
 * Run a verification pass on a draft reply.
 *
 * @param {string} userMessage - What the user asked.
 * @param {string} draftReply - Q's first attempt at answering.
 * @returns {Promise<{pass: boolean, issues: string[], corrected: string, durationMs: number, error?: string}>}
 */
async function verify(userMessage, draftReply) {
    const startTime = Date.now();
    const safeFallback = {
        pass: true,
        issues: [],
        corrected: draftReply,
        durationMs: 0,
    };

    if (!Q_CONFIG.apiKey) {
        return { ...safeFallback, error: 'TOGETHER_API_KEY not configured', durationMs: Date.now() - startTime };
    }
    if (!userMessage || !draftReply) {
        return { ...safeFallback, durationMs: Date.now() - startTime };
    }

    const reviewPrompt = `USER QUESTION:
${userMessage}

DRAFT REPLY:
${draftReply}

Review the draft against the user question and return JSON.`;

    try {
        const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: Q_CONFIG.model,
                max_tokens: 2500,
                temperature: 0.0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: VERIFIER_SYSTEM },
                    { role: 'user', content: reviewPrompt },
                ],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            return {
                ...safeFallback,
                error: `Verifier HTTP ${response.status}: ${errText.substring(0, 200)}`,
                durationMs: Date.now() - startTime,
            };
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '{}';

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            return {
                ...safeFallback,
                error: 'Verifier returned non-JSON output',
                durationMs: Date.now() - startTime,
            };
        }

        const pass = parsed.pass === true;
        const issues = Array.isArray(parsed.issues)
            ? parsed.issues.filter(i => typeof i === 'string').slice(0, 20)
            : [];
        // If the verifier says fail but didn't supply a usable correction, fall
        // back to the original draft — better the un-corrected answer than nothing.
        const corrected = (typeof parsed.corrected === 'string' && parsed.corrected.trim())
            ? parsed.corrected
            : draftReply;

        return {
            pass,
            issues,
            corrected,
            durationMs: Date.now() - startTime,
        };
    } catch (err) {
        return {
            ...safeFallback,
            error: err.message,
            durationMs: Date.now() - startTime,
        };
    }
}

module.exports = { verify };
