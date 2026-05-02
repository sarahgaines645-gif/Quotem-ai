/**
 * Q TOOLS — capability layer Q calls during chat.
 *
 * Four core tools that turn Q from a brain into a brain with hands:
 *   - web_search       → live web search via Brave Search API (independent index, not Google/Bing)
 *   - calculator       → accurate arithmetic (LLMs are bad at maths)
 *   - current_datetime → timezone-aware time/date
 *   - analyze_document → vision via Qwen2.5-VL on Together AI (Q is text-only, this is his eyes)
 *
 * Format: OpenAI-compatible function-calling. Together AI's API accepts the same
 * tool definitions and tool_call response shape as OpenAI.
 *
 * Wiring: qwen-chat.js passes TOOL_DEFINITIONS to the chat endpoint, then loops:
 * if the response contains tool_calls, execute via executeTool(name, args), push
 * the result back as a tool message, and continue until Q answers without calling.
 *
 * Per Crown Plan caveat: V4 Pro's function calling is reportedly weaker than Qwen
 * (~81.5% vs 96.5%). We force tool_choice: "auto" and validate JSON args before
 * executing — bad calls get a structured error back, not a crash.
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { addFact, searchFacts, listFacts } = require('../facts');
const { createDocx } = require('./doc-creator');

// ─────────────────────────────────────────────────────────────
//  TOOL DEFINITIONS — OpenAI function-calling schema
// ─────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the live web for current information via Google. Use this for news, facts, prices, or anything that may have changed since your training. Returns organic results plus (when available) a direct answer and knowledge-graph snippet.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query — natural language, like a Google search.',
                    },
                    count: {
                        type: 'integer',
                        description: 'Number of results to return (1-10). Default 5.',
                        minimum: 1,
                        maximum: 10,
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'calculator',
            description: 'Evaluate a maths expression accurately. Use this whenever you need to compute numbers — LLMs are bad at arithmetic. Supports +, -, *, /, %, parentheses, decimals, and "X% of Y" phrasing.',
            parameters: {
                type: 'object',
                properties: {
                    expression: {
                        type: 'string',
                        description: 'The maths expression. Examples: "17.5% of 4283.50", "(120 + 80) * 1.2", "1234.56 / 7".',
                    },
                },
                required: ['expression'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'current_datetime',
            description: 'Get the current date and time in any timezone. Use this if you need to know what time it is now — never guess the date.',
            parameters: {
                type: 'object',
                properties: {
                    timezone: {
                        type: 'string',
                        description: 'IANA timezone name (e.g. "Europe/London", "Asia/Tokyo", "America/New_York"). Default "Europe/London".',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'remember',
            description: 'Save a fact to your long-term memory. Use this whenever the user tells you something worth keeping across sessions: their name or other people\'s names, preferences, ongoing projects, important dates, decisions made, things they explicitly ask you to remember. Stored facts persist across conversations and are visible to you next time. Don\'t use for in-conversation context (current chat history covers that).',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The fact in plain English, written from your perspective. Examples: "Sarah\'s dad is called Brian (nickname Barney)", "Sarah prefers concise replies over verbose ones", "Sarah is building a custom AI called Q on DeepSeek V4 Pro".',
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional short tags for grouping (e.g. ["preference"], ["family"], ["project:quotem"]). Up to 10.',
                    },
                },
                required: ['content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'recall',
            description: 'Search your long-term memory for facts relevant to a topic. Use this when you need to look up something the user told you in a previous session. Returns a list of stored facts. If you call with no query, returns the most recent 20 facts.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Substring/keyword search across stored facts and tags. Optional — leave empty to see recent facts.',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Max facts to return (1–50). Default 10.',
                        minimum: 1,
                        maximum: 50,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_document',
            description: 'Write a Word (.docx) document on the user\'s behalf and return a download link. Use this whenever the user asks for a letter, complaint, formal email, contract, brief, or any other writing they\'ll want to save or send. Compose the full body yourself in the `content` field — the user will see it as a real Word file. Don\'t use this for short replies or notes; just write those in chat.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Title shown at the top of the document and used to name the file. Plain text, e.g. "Cover letter for the council".',
                    },
                    content: {
                        type: 'string',
                        description: 'Full body of the document in plain text. Use blank lines between paragraphs. Single newlines become line breaks within a paragraph.',
                    },
                },
                required: ['title', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'analyze_document',
            description: 'Read a document or image — extract text, identify fillable form fields with bounding boxes, answer questions about content. Use this whenever the user uploads or refers to a PDF, image, or document. Returns structured JSON with extracted text and (if relevant) form field locations.',
            parameters: {
                type: 'object',
                properties: {
                    image_url: {
                        type: 'string',
                        description: 'URL of the image/document, OR a data URL (data:image/png;base64,...).',
                    },
                    question: {
                        type: 'string',
                        description: 'What the user wants to know about the document. Examples: "find all the fillable text boxes and their labels", "extract the text content", "what is this form for?".',
                    },
                },
                required: ['image_url', 'question'],
            },
        },
    },
];

// ─────────────────────────────────────────────────────────────
//  TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────

/**
 * web_search — Google search via SerpAPI. Same SERP_API_KEY Quotem already
 * uses for its other web-search surfaces. Free tier: 250 searches/month.
 *
 * Returns the answer box and knowledge graph snippet alongside the organic
 * results when SerpAPI surfaces them — Q can use those directly without
 * needing to read all the result snippets.
 */
async function webSearch({ query, count = 5 }) {
    const apiKey = process.env.SERP_API_KEY;
    if (!apiKey) {
        return { error: 'SERP_API_KEY not configured' };
    }
    if (!query || typeof query !== 'string') {
        return { error: 'Query string required' };
    }
    const safeCount = Math.min(Math.max(parseInt(count) || 5, 1), 10);
    const params = new URLSearchParams({
        q: query,
        num: String(safeCount),
        gl: 'uk',
        hl: 'en',
        api_key: apiKey,
    });
    const url = `https://serpapi.com/search.json?${params.toString()}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errText = await response.text();
            return { error: `SerpAPI HTTP ${response.status}: ${errText.substring(0, 200)}` };
        }
        const data = await response.json();
        const results = (data.organic_results || []).slice(0, safeCount).map(r => ({
            title: r.title,
            url: r.link,
            snippet: r.snippet,
        }));
        // Direct-answer surfaces — Q can use these without parsing result snippets.
        const answerBox = data.answer_box;
        const directAnswer = answerBox
            ? (answerBox.answer || answerBox.snippet || answerBox.result || null)
            : null;
        const knowledgeGraph = data.knowledge_graph
            ? (data.knowledge_graph.description || data.knowledge_graph.snippet || null)
            : null;
        return {
            query,
            results,
            count: results.length,
            ...(directAnswer && { direct_answer: directAnswer }),
            ...(knowledgeGraph && { knowledge_graph: knowledgeGraph }),
        };
    } catch (err) {
        return { error: err.message };
    }
}

/**
 * calculator — safe arithmetic eval with "X% of Y" handling.
 * Validates input is math-only before evaluating.
 */
function calculator({ expression }) {
    if (!expression || typeof expression !== 'string') {
        return { error: 'Expression string required' };
    }
    let expr = expression.trim();

    // Handle "X% of Y" → (X/100)*Y
    const percentOfMatch = expr.match(/^([\d.]+)\s*%\s*of\s*([\d.()+\-*/\s]+)$/i);
    if (percentOfMatch) {
        const pct = parseFloat(percentOfMatch[1]);
        const ofExpr = percentOfMatch[2];
        expr = `(${pct} / 100) * (${ofExpr})`;
    }

    // Reject anything that isn't safe arithmetic
    if (!/^[0-9+\-*/().,\s%]+$/.test(expr)) {
        return { error: 'Expression contains characters not allowed in calculator. Allowed: digits, + - * / % ( ) . , and whitespace.' };
    }

    try {
        // Evaluate in an isolated function scope. Input is regex-validated above
        // so eval surface is reduced to pure arithmetic — no identifiers, no calls.
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + expr + ')')();
        if (typeof result !== 'number' || !Number.isFinite(result)) {
            return { error: 'Result is not a finite number' };
        }
        return { expression, result };
    } catch (err) {
        return { error: `Could not evaluate: ${err.message}` };
    }
}

/**
 * current_datetime — timezone-aware time/date. Uses Intl.
 */
function currentDatetime({ timezone = 'Europe/London' } = {}) {
    try {
        const now = new Date();
        const options = {
            timeZone: timezone,
            year: 'numeric', month: 'long', day: 'numeric',
            weekday: 'long',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
            timeZoneName: 'short',
        };
        const formatted = new Intl.DateTimeFormat('en-GB', options).format(now);
        return {
            timezone,
            iso: now.toISOString(),
            formatted,
            unix_seconds: Math.floor(now.getTime() / 1000),
        };
    } catch (err) {
        return { error: `Invalid timezone "${timezone}": ${err.message}` };
    }
}

/**
 * analyze_document — vision via Qwen2.5-VL-72B on Together AI.
 * Q is text-only, so this is his eyes. Same Together API key as Q himself.
 *
 * For form-field detection, we prompt the vision model to return structured JSON
 * with bounding boxes. Together's Qwen-VL outputs normalised 0-1000 coordinates.
 */
async function analyzeDocument({ image_url, question }) {
    if (!Q_CONFIG.apiKey) {
        return { error: 'TOGETHER_API_KEY not configured' };
    }
    if (!image_url || !question) {
        return { error: 'Both image_url and question are required' };
    }

    // System prompt steered for form-field detection when the question asks for it.
    const isFormQuestion = /\b(field|box|fillable|form|input|textbox|signature|checkbox)\b/i.test(question);
    const systemPrompt = isFormQuestion
        ? `You are a document-analysis vision model. Identify all fillable form fields in the image. For each field return: label (the nearby text label), type (text_field/checkbox/signature/date/number), and bounding box as {x, y, width, height} in normalised 0-1000 coordinates. Return ONLY valid JSON in the shape: {"summary":"...","fields":[{"label":"...","type":"...","x":0,"y":0,"width":0,"height":0}, ...]}`
        : `You are a document-analysis vision model. Read the image and answer the user's question accurately. If the document contains text, extract the relevant text. Be concise and factual.`;

    try {
        const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'Qwen/Qwen2.5-VL-72B-Instruct',
                max_tokens: 2000,
                temperature: 0.0,
                messages: [
                    { role: 'system', content: systemPrompt },
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: image_url } },
                            { type: 'text', text: question },
                        ],
                    },
                ],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            return { error: `Vision model HTTP ${response.status}: ${errText.substring(0, 200)}` };
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        // For form-detection prompts, try to parse JSON. Fall back to raw text.
        if (isFormQuestion) {
            const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            try {
                const parsed = JSON.parse(cleaned);
                return { question, ...parsed };
            } catch {
                // Couldn't parse — return raw + note
                return { question, raw_response: content, parse_error: 'Vision model did not return valid JSON' };
            }
        }

        return { question, answer: content };
    } catch (err) {
        return { error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────
//  DISPATCHER
// ─────────────────────────────────────────────────────────────

/**
 * Execute a tool by name with its arguments. Always returns an object —
 * never throws. Errors are returned as { error: '...' } so Q sees them.
 */
async function executeTool(name, argsRaw, personId) {
    let args = argsRaw;
    if (typeof argsRaw === 'string') {
        try { args = JSON.parse(argsRaw); }
        catch (e) {
            return { error: `Could not parse tool arguments as JSON: ${e.message}`, raw: argsRaw.substring(0, 200) };
        }
    }
    if (!args || typeof args !== 'object') {
        return { error: 'Tool arguments must be an object' };
    }

    switch (name) {
        case 'web_search':       return await webSearch(args);
        case 'calculator':       return calculator(args);
        case 'current_datetime': return currentDatetime(args);
        case 'analyze_document': return await analyzeDocument(args);
        case 'create_document':  return await createDocument(args);
        case 'remember':         return remember(args, personId);
        case 'recall':           return recall(args, personId);
        default:                 return { error: `Unknown tool: "${name}"` };
    }
}

/**
 * create_document — generate a .docx file and return a download link.
 * Q embeds the link in his reply so the user can click and save the file.
 */
async function createDocument({ title, content } = {}) {
    if (!title || typeof title !== 'string') return { error: 'title (string) is required' };
    if (!content || typeof content !== 'string') return { error: 'content (string) is required' };
    try {
        const result = await createDocx({ title, content });
        return {
            ok: true,
            filename: result.filename,
            sizeBytes: result.sizeBytes,
            downloadUrl: '/download/' + result.token,
            instruction_for_q: 'Tell the user the document is ready and give them this exact markdown link to download it: [Download ' + result.filename + '](' + '/download/' + result.token + '). Mention briefly what you put in the document, but do NOT paste the full body — they\'ll get it in the file.',
        };
    } catch (e) {
        return { error: e.message || 'Could not create document.' };
    }
}

/**
 * remember — write a fact to Q's persistent memory.
 */
function remember({ content, tags = [] } = {}, personId) {
    if (!content || typeof content !== 'string') {
        return { error: 'content (string) is required' };
    }
    return addFact({ content, tags, source: 'chat' }, personId);
}

/**
 * recall — search Q's persistent memory.
 */
function recall({ query = '', limit = 10 } = {}, personId) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
    const facts = (query && query.trim())
        ? searchFacts(query, { limit: safeLimit }, personId)
        : listFacts({ limit: safeLimit }, personId);
    return {
        query: query || null,
        count: facts.length,
        facts: facts.map(f => ({
            id: f.id,
            content: f.content,
            tags: f.tags,
            createdAt: f.createdAt,
        })),
    };
}

// Pick the tools Q is allowed to call THIS turn. Persona alone wasn't enough
// to stop Q from running web_search uninvited (250 calls in two days from
// silent searches). The structural fix: only put web_search (and other
// expensive tools) into the tool list when the user message clearly asks.
//
// Default = remember + recall (cheap, useful for memory). Everything else is
// gated behind explicit triggers in the user's message.
const ALWAYS_ON = new Set(['remember', 'recall']);

const TRIGGERS = {
    web_search: [
        /\blook( it)? up\b/i,
        /\bsearch( for| the web| online)?\b/i,
        /\bgoogle (it|that|this|for)\b/i,
        /\bfind (me |online|on the web)\b/i,
        /\bwhat'?s (the latest|new on)\b/i,
        /\bup-?to-?date\b/i,
        /\bonline\b/i,
    ],
    calculator: [
        /\bcalculate\b/i,
        /\bwork out\b/i,
        /\bmaths?\b/i,
        // Three or more digits next to an arithmetic operator
        /\d+\s*[+\-*/x×÷]\s*\d+/,
    ],
    current_datetime: [
        /\bwhat time\b/i,
        /\bwhat'?s the time\b/i,
        /\btime( zone| now)\b/i,
    ],
    analyze_document: [
        /\b(read|analy[sz]e|extract|summari[sz]e) (this|the|that|my|the file|the document|the pdf|attached)\b/i,
    ],
    create_document: [
        /\b(create|make|write|generate|draft|build) (a|me a|me)? ?(document|doc|file|pdf|word|letter)\b/i,
        /\bsave (this|that|it) (as a|to a)? ?(document|doc|file|pdf|word)\b/i,
    ],
};

function selectActiveTools(userMessage) {
    const msg = String(userMessage || '');
    return TOOL_DEFINITIONS.filter(t => {
        const name = t.function?.name;
        if (!name) return false;
        if (ALWAYS_ON.has(name)) return true;
        const triggers = TRIGGERS[name];
        if (!triggers) return false;
        return triggers.some(rx => rx.test(msg));
    });
}

module.exports = { TOOL_DEFINITIONS, executeTool, analyzeDocument, selectActiveTools };
