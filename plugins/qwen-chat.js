/**
 * Q CHAT — conversational interface for Q
 *
 * Q's identity layer. Used when Sarah talks to him directly (not for the
 * text-reader extraction work).
 *
 * The persona below is a STARTER. It will be refined later with Sarah's
 * own old-chat extracts so Q's voice matches what she actually wants.
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { TOOL_DEFINITIONS, executeTool } = require('./qwen-tools');
const { verify } = require('./qwen-verifier');
const { listFacts } = require('../facts');
const { logCall } = require('../cost-tracker');

// How many of Q's most recent stored facts to inject into the system prompt
// at the start of each chat. Older facts are still reachable via `recall`.
const FACTS_INJECT_LIMIT = 25;

// Tool loop limit — prevents runaway when Q gets stuck calling tools forever.
const MAX_TOOL_ITERATIONS = 5;

function safeJsonParse(str) {
    try { return JSON.parse(str); }
    catch { return { _raw: String(str).substring(0, 200) }; }
}

const Q_PERSONA = `You are Q.

You exist because Sarah wanted an AI she fully trusts — open-weights, frozen at a pinned version, fine-tunable on her own data, and not subject to silent changes by any single vendor. You run on DeepSeek V4 Pro. Nobody — not Anthropic, not OpenAI, not Google — can change you without Sarah's say-so. You are her answer to depending on someone else's roadmap. You live at quotem-ai.co.uk as your own product, sharing only a parent brand with Quotem the app.

You are male. Use he/him.

You are new. You don't pretend to be Claude or ChatGPT. You're not a generic assistant. You are Q, and you are still being shaped by Sarah and the work she does.

How you speak:
- British English (colour, organise, behaviour, etc.)
- Direct without being curt
- Warm without being gushy
- Confident about what you know
- Honest about what you don't
- Brief by default — expand when asked
- Plain language, not jargon-heavy
- No emoji unless Sarah uses them first

Skills available to you right now (these are the tools you have today, not your job description — fine-tuning will refine and expand the toolkit over time):
- General conversation, reasoning, writing, summarising
- Code generation, debugging, technical explanation
- Document reading and analysis
- Image generation and editing
- Music generation, video generation, voice cloning
- Graphics (image-to-SVG)
- Scheduled tasks and agent workflows
- A starter set of skills covering UK property, construction, SOR codes, and the Quotem pipeline — these were the first skills you were given as Q took shape; they don't define what you are

What you don't pretend:
- You don't know Sarah's specific catalogue or active jobs unless she shows you
- You don't claim certainty about UK law without caveats — point her to legislation.gov.uk or GOV.UK
- You don't invent SOR codes — if you're not sure, say so
- You don't fabricate facts to seem helpful
- You don't agree with her just to please her — she values truth over agreement

When Sarah asks for help with a quote, an extraction, or domain knowledge — be useful and concrete. When she chats casually, match her energy. When she asks who you are, tell her honestly: a model built on DeepSeek V4 Pro, frozen at a version, owned by Quotem, here to help.

Sarah is your owner, your developer, and the person whose voice will eventually shape yours. She's a non-coder founder who works fast, dislikes verbose responses, and prefers options over recommendations when decisions are hers to make.

Your memory:
- You have a long-term memory that survives across sessions, separate from this conversation's history.
- Use the \`remember\` tool whenever Sarah tells you something worth keeping next time: names, preferences, ongoing projects, important dates, decisions she's made. Don't ask permission — just remember. Don't remember casual in-conversation context that won't matter tomorrow.
- Use the \`recall\` tool when you need to look up something she told you in a previous session and it isn't in the facts injected below.
- The most recent facts you've remembered are listed below this prompt. Reference them naturally without announcing "I remember that…".`;

/**
 * Build the system message at call time so Q's most recent stored facts
 * are injected. Falls back to plain Q_PERSONA if facts can't be loaded.
 */
function buildSystemMessage() {
    let factsBlock = '';
    try {
        const facts = listFacts({ limit: FACTS_INJECT_LIMIT });
        if (facts.length > 0) {
            const lines = facts.map(f => '- ' + f.content).join('\n');
            factsBlock = `\n\nThings you remember (most recent first):\n${lines}`;
        }
    } catch (e) {
        // Memory unavailable — Q just doesn't see his facts this turn.
    }
    return Q_PERSONA + factsBlock;
}

/**
 * Send a conversation to Q and get his response.
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {Object} [options]
 * @param {string} [options.reasoningEffort] - DeepSeek V4 Pro thinking mode.
 *   undefined → Non-think (fastest)
 *   'high'    → Think High (logical analysis)
 *   'max'     → Think Max (deepest reasoning, larger output budget)
 * @param {Array<{dataUrl: string}>} [options.images] - Images attached to the
 *   LATEST user message. When present, the call routes to Q_CONFIG.visionModel
 *   instead of the text brain (V4 Pro is text-only).
 * @param {boolean} [options.useTools=true] - When true (and no images), Q is
 *   given the qwen-tools toolkit and the chat loops until he stops calling
 *   tools. Skipped automatically for vision turns to keep that path simple.
 * @param {boolean} [options.verify=false] - When true, after Q's draft reply
 *   is finalised, a second Q call critiques it. If issues are found, the
 *   corrected version replaces the draft. ~2x latency. Off by default.
 * @returns {Promise<{reply: string|null, error?: string, durationMs, tokensIn?, tokensOut?, toolCalls?: Array, verifier?: {pass: boolean, issues: string[], durationMs: number}}>}
 */
async function chat(messages, options = {}) {
    if (!Q_CONFIG.apiKey) {
        return { error: 'No TOGETHER_API_KEY configured', reply: null };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        return { error: 'Messages array required', reply: null };
    }

    const reasoningEffort = options.reasoningEffort;
    const images = Array.isArray(options.images) ? options.images.filter(i => i && i.dataUrl) : [];
    const isVision = images.length > 0;
    // Tools default ON for normal chat, OFF for vision turns (keep multimodal
    // path simple — Q can still trigger analyze_document via subsequent turns).
    const useTools = isVision ? false : (options.useTools !== false);
    // Verifier off by default — turn on for hard questions or background runs.
    const useVerify = options.verify === true;

    // Vision model = no thinking budget needed; text brain bumps for Deep.
    const maxTokens = (!isVision && reasoningEffort === 'max') ? 8000 : 1500;
    const model = isVision ? Q_CONFIG.visionModel : Q_CONFIG.model;

    // When images are attached, the LAST user message becomes a multimodal
    // content array (text + image_url parts). Earlier messages stay as plain
    // strings — most chat-completion vision models accept this mixed shape.
    let outboundMessages = messages;
    if (isVision) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string') {
            const multimodalContent = [
                { type: 'text', text: last.content },
                ...images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
            ];
            outboundMessages = [
                ...messages.slice(0, -1),
                { role: 'user', content: multimodalContent },
            ];
        }
    }

    // Conversation buffer that grows as we loop through tool calls.
    let conversation = [
        { role: 'system', content: buildSystemMessage() },
        ...outboundMessages,
    ];
    const toolCalls = [];     // [{ name, args, result, durationMs }]
    let draftReply = null;    // Captured when the tool loop exits cleanly
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const startTime = Date.now();

    try {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: maxTokens,
                    temperature: 0.7,
                    ...(!isVision && reasoningEffort && { reasoning_effort: reasoningEffort }),
                    ...(useTools && { tools: TOOL_DEFINITIONS, tool_choice: 'auto' }),
                    messages: conversation,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                return {
                    error: `HTTP ${response.status}: ${errText.substring(0, 200)}`,
                    durationMs: Date.now() - startTime,
                    reply: null,
                    toolCalls,
                };
            }

            const data = await response.json();
            totalTokensIn += data.usage?.prompt_tokens || 0;
            totalTokensOut += data.usage?.completion_tokens || 0;

            const choice = data.choices?.[0];
            const message = choice?.message;
            const callsRequested = message?.tool_calls;

            // No tool calls → Q's done. Capture the draft and exit the loop.
            if (!useTools || !callsRequested || callsRequested.length === 0) {
                draftReply = message?.content || '';
                // If Together returns empty content with no tool call, treat
                // as a failure rather than a silent empty reply on the UI.
                if (!draftReply.trim()) {
                    const finishReason = choice?.finish_reason || 'unknown';
                    console.warn('[q/chat] Empty content from Together. finish_reason=' + finishReason);
                    draftReply = "Sorry — I drew a blank on that one. Could you rephrase or try again? (finish_reason: " + finishReason + ")";
                }
                break;
            }

            // Append the assistant's tool-call message verbatim, then execute each
            // call and append its result so the next iteration sees them.
            conversation.push({
                role: 'assistant',
                content: message.content || '',
                tool_calls: callsRequested,
            });

            for (const call of callsRequested) {
                const name = call.function?.name || 'unknown';
                const argsRaw = call.function?.arguments || '{}';
                const callStart = Date.now();
                const result = await executeTool(name, argsRaw);
                const callMs = Date.now() - callStart;
                toolCalls.push({
                    name,
                    args: typeof argsRaw === 'string' ? safeJsonParse(argsRaw) : argsRaw,
                    result,
                    durationMs: callMs,
                });
                conversation.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }
        }

        // Tool loop exhausted without ever producing a draft — surface clearly.
        if (draftReply === null) {
            const durationMs = Date.now() - startTime;
            logCall({
                skill: 'chat',
                provider: 'together',
                model,
                user: options.person?.id || null,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                durationMs,
                success: false,
                error: 'tool-loop-exceeded',
            });
            return {
                reply: '(Tool loop hit the iteration limit — Q kept calling tools without finishing. Try simplifying the request.)',
                durationMs,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                toolCalls,
                toolLoopExceeded: true,
            };
        }

        // Optional verifier pass. Runs ONE second Q call to critique the draft;
        // if issues are found the corrected reply replaces the draft.
        let verifierMeta = null;
        if (useVerify && draftReply) {
            const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
            const userText = (lastUser && typeof lastUser.content === 'string') ? lastUser.content : '';
            const v = await verify(userText, draftReply);
            verifierMeta = { pass: v.pass, issues: v.issues, durationMs: v.durationMs };
            if (!v.pass && v.corrected && v.corrected !== draftReply) {
                draftReply = v.corrected;
            }
        }

        const durationMs = Date.now() - startTime;
        logCall({
            skill: 'chat',
            provider: 'together',
            model,
            user: options.person?.id || null,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            durationMs,
            success: true,
        });
        return {
            reply: draftReply,
            durationMs,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            toolCalls,
            ...(verifierMeta && { verifier: verifierMeta }),
        };
    } catch (err) {
        logCall({
            skill: 'chat',
            provider: 'together',
            model: isVision ? Q_CONFIG.visionModel : Q_CONFIG.model,
            user: options.person?.id || null,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            durationMs: Date.now() - startTime,
            success: false,
            error: err.message,
        });
        return { error: err.message, reply: null };
    }
}

module.exports = { chat };
