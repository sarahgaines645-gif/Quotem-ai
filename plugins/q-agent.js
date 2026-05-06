/**
 * Q AGENT — autonomous task runner.
 *
 * The piece that turns Q from "responds when asked" into "given a goal,
 * pursues it until done."
 *
 * Builds on:
 *   - qwen-tools.js   (the hands)
 *   - qwen-verifier.js (the silent self-checker)
 *   - qwen-chat.js's persona (Q is still Q)
 *
 * Flow:
 *   1. Wrap goal in an autonomous-mode system prompt
 *   2. Call Q with the full toolkit
 *   3. If Q returns tool_calls → execute them, append results, call again
 *   4. If Q returns plain text → that's his final summary, exit
 *   5. Cap iterations at maxSteps (default 25 — much higher than chat's 5)
 *   6. Optionally verify the final summary against the original goal
 *
 * The transcript array logs every event (step_start, tool_call, tool_result,
 * finish, verifier_corrected, error) so the UI can replay what Q did.
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { TOOL_DEFINITIONS, executeTool } = require('./q-tools');
const { verify } = require('./q-verifier');
const { cleanModelOutput } = require('./cjk-filter');

const DEFAULT_MAX_STEPS = 25;

const AGENT_SYSTEM = `You are Q, working autonomously on a task — no human is watching each step.

You've been given a goal. Use the tools available to make progress. When the task is complete, reply with your final summary as plain text (no tool call needed).

Rules of autonomous work:
- Don't ask clarifying questions. Make reasonable assumptions and state them clearly in your final summary.
- Use tools when they'd be more reliable than your own knowledge — especially for current facts (web_search), arithmetic (calculator), and dates (current_datetime).
- After each tool result, decide your next step. You may chain many tool calls before answering.
- When the goal is achieved, write a final summary that directly addresses the original goal. Cover what you did, what you found, and any caveats or assumptions.
- If you genuinely cannot make progress, say so clearly with what you tried and why it failed — don't loop on the same failing approach.
- Be efficient. Don't call tools you don't need. Don't restate the goal verbatim in your summary.

You are still Q — direct, plain language, British English, no emoji unless the goal calls for them.`;

function safeJsonParse(str) {
    try { return JSON.parse(str); }
    catch { return { _raw: String(str).substring(0, 200) }; }
}

/**
 * Run Q autonomously toward a goal.
 *
 * @param {string} goal - What Q should achieve.
 * @param {Object} [options]
 * @param {number} [options.maxSteps=25] - Hard cap on tool-call iterations.
 * @param {boolean} [options.useTools=true] - Allow Q to use the toolkit.
 * @param {boolean} [options.verify=false] - Run verifier on final summary.
 * @param {string} [options.reasoningEffort] - 'high' | 'max' to engage Deep mode.
 * @returns {Promise<{summary: string|null, transcript: Array, steps: number, durationMs: number, tokensIn: number, tokensOut: number, verifier?: Object, error?: string}>}
 */
async function runAgent(goal, options = {}) {
    const startTime = Date.now();
    if (!Q_CONFIG.apiKey) {
        return { summary: null, transcript: [], steps: 0, durationMs: 0, tokensIn: 0, tokensOut: 0, error: 'No TOGETHER_API_KEY configured' };
    }
    if (!goal || typeof goal !== 'string' || !goal.trim()) {
        return { summary: null, transcript: [], steps: 0, durationMs: 0, tokensIn: 0, tokensOut: 0, error: 'Goal string required' };
    }

    const maxSteps = Math.min(Math.max(parseInt(options.maxSteps) || DEFAULT_MAX_STEPS, 1), 100);
    const useTools = options.useTools !== false;
    const useVerify = options.verify === true;
    const reasoningEffort = options.reasoningEffort;

    const transcript = [];
    const conversation = [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: 'GOAL: ' + goal.trim() },
    ];

    let finalSummary = null;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let stepsTaken = 0;

    try {
        for (let step = 0; step < maxSteps; step++) {
            stepsTaken = step + 1;
            transcript.push({ type: 'step_start', step: stepsTaken, t: Date.now() - startTime });

            const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: Q_CONFIG.model,
                    max_tokens: reasoningEffort === 'max' ? 8000 : 2500,
                    temperature: 0.3,
                    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
                    ...(useTools && { tools: TOOL_DEFINITIONS, tool_choice: 'auto' }),
                    messages: conversation,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                const errMsg = `HTTP ${response.status}: ${errText.substring(0, 200)}`;
                transcript.push({ type: 'error', step: stepsTaken, error: errMsg });
                return {
                    summary: null,
                    transcript,
                    steps: stepsTaken,
                    durationMs: Date.now() - startTime,
                    tokensIn: totalTokensIn,
                    tokensOut: totalTokensOut,
                    error: errMsg,
                };
            }

            const data = await response.json();
            totalTokensIn += data.usage?.prompt_tokens || 0;
            totalTokensOut += data.usage?.completion_tokens || 0;

            const message = data.choices?.[0]?.message;
            const callsRequested = message?.tool_calls;

            // No more tool calls → Q is finished. Capture his final summary.
            if (!useTools || !callsRequested || callsRequested.length === 0) {
                finalSummary = cleanModelOutput(message?.content || '(Q returned no summary)', 'agent');
                transcript.push({ type: 'finish', step: stepsTaken, summary: finalSummary, t: Date.now() - startTime });
                break;
            }

            // Otherwise: append assistant + execute each tool + append observations.
            conversation.push({
                role: 'assistant',
                content: message.content || '',
                tool_calls: callsRequested,
            });

            for (const call of callsRequested) {
                const name = call.function?.name || 'unknown';
                const argsRaw = call.function?.arguments || '{}';
                const args = typeof argsRaw === 'string' ? safeJsonParse(argsRaw) : argsRaw;
                transcript.push({ type: 'tool_call', step: stepsTaken, name, args, t: Date.now() - startTime });

                const callStart = Date.now();
                const result = await executeTool(name, argsRaw);
                const callMs = Date.now() - callStart;

                transcript.push({
                    type: 'tool_result',
                    step: stepsTaken,
                    name,
                    result,
                    durationMs: callMs,
                    t: Date.now() - startTime,
                });

                conversation.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }
        }

        // Optional verifier pass on the final summary.
        let verifierMeta = null;
        if (useVerify && finalSummary) {
            const v = await verify(goal, finalSummary);
            verifierMeta = { pass: v.pass, issues: v.issues, durationMs: v.durationMs };
            if (!v.pass && v.corrected && v.corrected !== finalSummary) {
                transcript.push({ type: 'verifier_corrected', issues: v.issues, t: Date.now() - startTime });
                finalSummary = v.corrected;
            }
        }

        return {
            summary: finalSummary,
            transcript,
            steps: stepsTaken,
            durationMs: Date.now() - startTime,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            ...(verifierMeta && { verifier: verifierMeta }),
            ...(finalSummary === null && { error: `Hit step limit (${maxSteps}) before Q reached a final summary.` }),
        };
    } catch (err) {
        transcript.push({ type: 'error', error: err.message, t: Date.now() - startTime });
        return {
            summary: null,
            transcript,
            steps: stepsTaken,
            durationMs: Date.now() - startTime,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            error: err.message,
        };
    }
}

module.exports = { runAgent };
