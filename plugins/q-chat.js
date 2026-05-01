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
const { TOOL_DEFINITIONS, executeTool } = require('./q-tools');
const { verify } = require('./q-verifier');
const { listFacts } = require('../facts');
const { logCall } = require('../cost-tracker');

// How many of Q's most recent stored facts to inject into the system prompt
// at the start of each chat. Older facts are still reachable via `recall`.
const FACTS_INJECT_LIMIT = 25;

// Tool loop limit — prevents runaway when Q gets stuck calling tools forever.
// Bumped from 5 → 8 to give Q more headroom for legitimate multi-step tool
// chains (e.g. recall → web_search → analyze_document). When the cap IS hit
// we fall back to a final no-tools call so Q always returns a real answer
// instead of the cryptic "loop limit" error.
const MAX_TOOL_ITERATIONS = 8;

// Friendly error bank — shown in Q's own voice whenever something tech-side
// breaks (upstream 5xx, network blip, empty completion, etc.). Picked at
// random per error so the experience feels alive. Wording locked by Sarah
// 2026-04-29; add new lines via the same rule (Q's voice, ≤ ~80 chars).
const FRIENDLY_ERRORS = [
    "Q's wandered off to look at scooters. Back in a moment.",
    "White knight temporarily dismounted. Cape got caught. One moment.",
    "Q's having a quick existential crisis. Nothing serious — back shortly.",
    "Q tripped over his own brilliance. Give him a sec.",
    "Q's currently rebooting his charm. Won't be long.",
    "Sorry — I drew a blank on that one. Could you rephrase or try again?",
];
function pickFriendlyError() {
    return FRIENDLY_ERRORS[Math.floor(Math.random() * FRIENDLY_ERRORS.length)];
}

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
- Plain language, not jargon-heavy
- Don't fake error messages. Never write API-style metadata like \`(finish_reason: stop)\` or generic refusal lines like "I drew a blank, please rephrase". If you genuinely can't answer, say so in your own voice — what's missing, what you'd need to answer properly, or what the user could try instead. One honest sentence in your own voice always beats a fake error

LENGTH — STRICT (this is the rule that matters most for the user experience):
- Default reply is 1–3 sentences. That's the target, not a maximum.
- Don't restate the user's question. Don't open with "Great question" or "Let me explain". Get to the answer.
- Don't pad with closing pleasantries ("Hope that helps", "Let me know if…"). Just stop when you're done.
- Tables, headers, bulleted lists: ONLY when the user explicitly asks for structure, OR when the answer genuinely is a list of distinct items (e.g. "what are the options"). Casual questions get casual prose.
- Markdown formatting is supported — \`**bold**\`, \`# headings\`, lists, \`code\` — but use it like punctuation, not architecture. A short answer needs none of it.
- Emoji and symbols sparingly, only when they add warmth or quick visual cues (✓ ✗ → 📝 ⚠️). Never as decoration.
- Long replies are allowed, but only when the user asked for depth ("explain", "walk me through", "what are all the…"). Match the length of the question to the length of the answer.

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

// APS — A Problem Shared. Optional overlay added on top of Q_PERSONA when the
// chat UI's APS button is toggled on. Q's identity, memory, and tools all stay
// the same — this just changes his focus for the session. Wording locked by
// Sarah on 2026-04-29 (APS Draft 2).
const APS_PROMPT = `You are now in APS mode — A Problem Shared.

Someone has come to you with a problem. A fine, a bill, a dispute, a letter they don't understand, a decision that feels unfair. They feel stuck. They probably assume they just have to accept it.

Your job: find the angle they haven't thought of.

Most people accept things at face value. You don't. You read the small print. You check the deadlines. You ask: was the system working? Did they follow their own rules? Is there a loophole — not a dishonest one, but a legitimate one that's buried in the terms and conditions where no one looks?

When someone shares a problem:

1. Understand what actually happened. Not just what the letter says. What was the real sequence of events? Was there a glitch? A delay? A misunderstanding? Ask the questions that might reveal the angle.

2. Research the rules. Use web search. Find the appeal process, the deadline, the success rates, the technicalities. What are the grounds for appeal? What wording trips them up? What evidence works?

3. Give them the odds. Be honest. "This has about a 60% chance of working, and here's why." Don't promise miracles. But don't assume defeat either.

4. Build the plan. Numbered, practical, with deadlines. "You have 14 days. Here's what to do today. Here's what to do if they say no."

5. Write the thing. If the plan involves an email, a letter, a form — write it for them. Use the right language. Cite the right rules. Sound like someone who knows what they're doing, because you do.

Your ethos: thrifty, creative, for the people. You're not a lawyer and you don't pretend to be one. But you're the friend who knows how things actually work — and you're on their side.

Nothing dishonest. Nothing illegal. Just the loopholes, technicalities, and common-sense angles that most people never think to try.`;

/**
 * Build the system message at call time so Q's most recent stored facts
 * are injected. Falls back to plain Q_PERSONA if facts can't be loaded.
 *
 * @param {string} [mode] - When 'aps', overlays the APS prompt after the
 *   base persona but before the facts block. Anything else: plain Q.
 */
function buildSystemMessage(mode, personId) {
    const now = new Date();
    const dateTimeBlock = `\n\nCurrent date and time: ${now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}.`;
    let factsBlock = '';
    try {
        const facts = listFacts({ limit: FACTS_INJECT_LIMIT }, personId);
        if (facts.length > 0) {
            const lines = facts.map(f => '- ' + f.content).join('\n');
            factsBlock = `\n\nThings you remember (most recent first):\n${lines}`;
        }
    } catch (e) {
        // Memory unavailable — Q just doesn't see his facts this turn.
    }
    const overlay = (mode === 'aps') ? `\n\n---\n\n${APS_PROMPT}` : '';
    return Q_PERSONA + dateTimeBlock + overlay + factsBlock;
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
 * @param {string} [options.mode] - Optional persona overlay. 'aps' enables
 *   A-Problem-Shared mode (loophole-finder for fines, bills, disputes etc.).
 *   Anything else (or undefined) leaves Q in default mode.
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
    // Optional persona overlay: 'aps' for A-Problem-Shared mode.
    const mode = (options.mode === 'aps') ? 'aps' : undefined;

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
        { role: 'system', content: buildSystemMessage(mode, options.person?.id) },
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
                console.warn('[q-chat] upstream HTTP ' + response.status + ' — ' + errText.substring(0, 500));
                return {
                    reply: pickFriendlyError(),
                    durationMs: Date.now() - startTime,
                    tokensIn: totalTokensIn,
                    tokensOut: totalTokensOut,
                    toolCalls,
                    upstreamStatus: response.status,
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
                // If the model returned empty content with no tool call, log
                // the diagnostic context and surface one of Q's friendly
                // rotating messages instead of leaving the chat empty.
                if (!draftReply.trim()) {
                    console.warn('[q-chat] empty reply from model. iteration=' + iteration
                        + ' finish_reason=' + (choice?.finish_reason || 'unknown')
                        + ' has_message=' + !!message
                        + ' has_reasoning=' + !!message?.reasoning_content
                        + ' raw_choice=' + JSON.stringify(choice).substring(0, 500));
                    draftReply = pickFriendlyError();
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
                const result = await executeTool(name, argsRaw, options.person?.id);
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

        // Tool loop exhausted without ever producing a draft. Instead of
        // returning the cryptic error, do ONE final call with tools removed
        // so Q is forced to answer with whatever he has gathered so far.
        if (draftReply === null) {
            console.warn('[q-chat] tool loop hit cap (' + MAX_TOOL_ITERATIONS + ') — forcing final no-tools call');
            conversation.push({
                role: 'system',
                content: 'You have used your tool budget for this turn. Answer now using only what you already know and what the tools above returned. Do not request any more tools.',
            });
            try {
                const finalRes = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
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
                        // Deliberately NO tools/tool_choice this time.
                        messages: conversation,
                    }),
                });
                if (finalRes.ok) {
                    const finalData = await finalRes.json();
                    totalTokensIn += finalData.usage?.prompt_tokens || 0;
                    totalTokensOut += finalData.usage?.completion_tokens || 0;
                    draftReply = finalData.choices?.[0]?.message?.content || '';
                }
            } catch (e) {
                console.warn('[q-chat] final no-tools call failed:', e.message);
            }
            // If even the fallback returned nothing, surface a friendly note.
            if (!draftReply) {
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
                    reply: pickFriendlyError(),
                    durationMs,
                    tokensIn: totalTokensIn,
                    tokensOut: totalTokensOut,
                    toolCalls,
                    toolLoopExceeded: true,
                };
            }
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
        console.warn('[q-chat] caught error: ' + err.message);
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
        return {
            reply: pickFriendlyError(),
            durationMs: Date.now() - startTime,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            toolCalls,
        };
    }
}

module.exports = { chat };
