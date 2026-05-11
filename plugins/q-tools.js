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

const fs = require('fs');
const path = require('path');
const { Q_CONFIG } = require('../config');
const { addFact, searchFacts, listFacts } = require('../facts');
const { createDocx, stashFile } = require('./doc-creator');
const { cleanModelOutput } = require('./cjk-filter');
const docEditor = require('./q-doc-editor');
const qImageGen = require('./q-image-gen');
const qGraphics = require('./q-graphics');
const qMusic = require('./q-music');
const qVideo = require('./q-video');
const { speakAsVoice } = require('./q-voice-clone');
const qLife = require('./q-life');

// Q's voice — every user has their own override. The bundled default is a
// shared fallback (it's just the stock voice and is identical for everyone).
// Personal overrides live under userDataPath(email, 'q-voice/override.wav')
// so one user can never replace another user's voice.
const { userDataPath } = require('./user-data');
const Q_VOICE_DEFAULT = path.join(__dirname, '..', 'assets', 'voice-candidates', 'q-current.mp3');

function _userOverridePath(personEmail) {
    return userDataPath(personEmail, 'q-voice/override.wav');
}

/**
 * Load the user's Q voice — their personal override if they've saved one,
 * else the bundled default. Loaded fresh each call so a save takes effect
 * on the next message without a restart.
 */
function loadQVoiceFor(personEmail) {
    if (personEmail) {
        try {
            const p = _userOverridePath(personEmail);
            if (fs.existsSync(p)) {
                return { buffer: fs.readFileSync(p), mimeType: 'audio/wav', source: 'override' };
            }
        } catch (e) {
            console.warn('[q-tools] override read failed for ' + personEmail + ': ' + e.message);
        }
    }
    try {
        return { buffer: fs.readFileSync(Q_VOICE_DEFAULT), mimeType: 'audio/mpeg', source: 'default' };
    } catch (e) {
        return { buffer: null, mimeType: '', source: 'none' };
    }
}

function setQVoiceFromBuffer(audioBuffer, personEmail) {
    if (!personEmail) return { error: 'Cannot save voice without a signed-in user.' };
    if (!audioBuffer || !audioBuffer.length) return { error: 'Empty audio buffer.' };
    const p = _userOverridePath(personEmail);
    fs.writeFileSync(p, audioBuffer);
    return { ok: true, bytes: audioBuffer.length, source: 'override' };
}

function clearQVoice(personEmail) {
    if (!personEmail) return { error: 'Cannot reset voice without a signed-in user.' };
    try { fs.unlinkSync(_userOverridePath(personEmail)); } catch { /* didn't exist */ }
    return { ok: true, source: 'default' };
}

function getQVoiceStatus(personEmail) {
    const v = loadQVoiceFor(personEmail);
    return {
        source: v.source,            // 'override' | 'default' | 'none'
        bytes: v.buffer ? v.buffer.length : 0,
    };
}

// ─────────────────────────────────────────────────────────────
//  TOOL DEFINITIONS — OpenAI function-calling schema
// ─────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the live web for current information. Use this for news, facts, prices, or anything that may have changed since your training. Returns the most relevant results from across the web.',
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

    // ─── DOC EDITOR TOOLS ──────────────────────────────────────
    // These act on the user's currently-open Word doc (uploaded via the
    // doc-editor page). Each call modifies the doc in place; the UI
    // re-renders the preview after every successful tool call. Always call
    // read_doc first so you know the current paragraph indices.

    {
        type: 'function',
        function: {
            name: 'read_doc',
            description: 'List every paragraph in the user\'s current Word doc with its index, text, and style. Call this BEFORE any edit so you know the current layout — indices shift after deletes and moves, so re-read whenever the doc changes.',
            parameters: {
                type: 'object',
                properties: {
                    refresh: { type: 'boolean', description: 'Always pass true. (Tool needs at least one parameter for the model to call it cleanly.)' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'replace_text',
            description: 'Find a phrase in the doc and swap it for another. Set paragraph_index to scope the replace to one paragraph; leave it null to replace everywhere.',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', description: 'The exact text to find.' },
                    replacement: { type: 'string', description: 'The text to put in its place.' },
                    paragraph_index: { type: ['integer', 'null'], description: 'Optional. Replace only inside this paragraph. Null/omit = replace everywhere.' },
                },
                required: ['target', 'replacement'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_paragraph',
            description: 'Remove a paragraph from the doc by its index. Indices shift after — call read_doc again before the next edit.',
            parameters: {
                type: 'object',
                properties: { index: { type: 'integer', description: 'Index of the paragraph to delete (0-based).' } },
                required: ['index'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'insert_paragraph',
            description: 'Add a new paragraph after a given index. Use after_index = -1 to insert at the very top of the doc.',
            parameters: {
                type: 'object',
                properties: {
                    after_index: { type: 'integer', description: 'Insert AFTER this paragraph index. Use -1 for top of doc.' },
                    text: { type: 'string', description: 'Text content of the new paragraph.' },
                    style: { type: 'string', description: 'Optional style: Heading1, Heading2, Heading3, Title, Normal.', enum: ['Heading1', 'Heading2', 'Heading3', 'Title', 'Normal'] },
                },
                required: ['after_index', 'text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'move_paragraph',
            description: 'Move a paragraph from one position to another. Both indices refer to the doc as it is BEFORE the move.',
            parameters: {
                type: 'object',
                properties: {
                    from_index: { type: 'integer', description: 'Current position of the paragraph.' },
                    to_index: { type: 'integer', description: 'Target position.' },
                },
                required: ['from_index', 'to_index'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'merge_paragraph',
            description: 'CRITICAL TOOL for fixing form-filler output. Take the text from one paragraph and inline it into another paragraph. The source paragraph is removed; its text becomes part of the target. Use this when a filled value is stranded on its own line and needs to sit next to its label. Position controls where in the target the source text lands: "start", "end" (default), or a literal phrase from the target after which to slot the source in.',
            parameters: {
                type: 'object',
                properties: {
                    source_index: { type: 'integer', description: 'Paragraph whose text gets pulled.' },
                    target_index: { type: 'integer', description: 'Paragraph that receives the text inline.' },
                    position: { type: 'string', description: '"start", "end", or a literal phrase from the target paragraph (insert immediately after that phrase). Default "end".' },
                },
                required: ['source_index', 'target_index'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'format_paragraph',
            description: 'Apply formatting to a paragraph: heading style, alignment, or bold/italic/underline.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'integer', description: 'Paragraph index.' },
                    style: {
                        type: 'string',
                        description: 'One of: Heading1, Heading2, Heading3, Title, Normal (paragraph style); left, center, right, justify (alignment); bold, italic, underline (run formatting on every run in the paragraph).',
                    },
                },
                required: ['index', 'style'],
            },
        },
    },

    // ─── CREATIVE STACK TOOLS ──────────────────────────────────
    // Generate images, vectors, music, video. Each saves the result to a
    // temporary download URL Q embeds in his reply as a markdown link/image.
    // First call after idle has a ~5–10s GPU cold-start; warm calls are quick.

    {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Draw an image from a description. Use this when the user asks for a picture, illustration, hero shot, banner, or any visual asset. Returns a download link Q can embed in his reply as a markdown image so it shows inline.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'What to draw. Describe scene, subject, style. Specific beats vague.' },
                    width:  { type: 'integer', description: 'Width in pixels. Default 1024. Range 512–2048.' },
                    height: { type: 'integer', description: 'Height in pixels. Default 1024. Range 512–2048.' },
                    negative_prompt: { type: 'string', description: 'Optional things to avoid in the image.' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'vectorise_image',
            description: 'Convert a raster image (PNG/JPG) into a clean SVG vector. Use this for logos, icons, line art, or anywhere the user wants something scalable / editable. Returns a download link to the SVG.',
            parameters: {
                type: 'object',
                properties: {
                    image_url: { type: 'string', description: 'URL or data URL of the raster image to vectorise.' },
                },
                required: ['image_url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'generate_music',
            description: 'Compose a music track from a description. Use this when the user asks for a song, music, tune, jingle, hold music, or background track for a video. Returns a download link to the audio file.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'What kind of music — genre, instruments, mood, tempo, vocals or instrumental.' },
                    duration_seconds: { type: 'integer', description: 'Length of the track in seconds. Default 30, max 240.' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'generate_video',
            description: 'Generate a short video clip from a description. Use this when the user asks for a video, clip, demo reel, or animation. Returns a download link to the MP4. Larger model — first call from cold can take 20+ seconds.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'What the clip should show — subject, action, style, camera movement.' },
                    duration_seconds: { type: 'integer', description: 'Clip length in seconds. Default 5, max 10.' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'speak_as_q',
            description: 'Narrate a text passage in Q\'s own voice. Use this when the user asks Q to "say that out loud", "narrate this in your voice", "read it aloud", or wants an audio version of a script for a video. Returns a download link to the audio file Q should embed in his reply.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The text to speak. Keep it under ~500 chars per call for snappy results.' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'save_situation',
            description: 'Create a new Thread (folder) for an ongoing situation. The `content` you pass is the CASE SUMMARY / ANALYSIS — Parties, Timeline, Key Facts, Gaps, etc. — and gets stored as a Note on the Thread, NOT as an email. To save the actual back-and-forth emails as proper email cards on the Thread, follow up with one or more `add_email_to_thread` calls (one per email). Returns a /thread/{id} URL.',
            parameters: {
                type: 'object',
                properties: {
                    title:   { type: 'string', description: 'Short descriptive Thread name, e.g. "Council Tax dispute — Sarah Gaines" or "Tom\'s 30th party".' },
                    summary: { type: 'string', description: 'One-line summary — the elevator pitch.' },
                    content: { type: 'string', description: 'Case summary / analysis (Parties, Timeline, Key Facts, Gaps). Markdown is fine. Stored as a Note on the Thread, NOT as an email. Pass the actual emails separately via add_email_to_thread.' },
                },
                required: ['title', 'summary'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_email_to_thread',
            description: 'Add an actual email (received or sent) to an existing Thread as its own card on the timeline. Use this for every real email in the back-and-forth — your 8 May reply to Jenny, Jenny\'s 27 Apr message, the council\'s auto-acknowledgment, etc. — one call per email. The Thread page renders each as a collapsible card with date / from→to / response-time pill. Call this after save_situation when you have the actual email chain.',
            parameters: {
                type: 'object',
                properties: {
                    threadId: { type: 'string', description: 'The Thread id (slug) returned by save_situation, or from list_threads.' },
                    type:     { type: 'string', enum: ['in', 'out'], description: '"in" if the user received this email, "out" if they sent it.' },
                    from:     { type: 'string', description: 'Sender name (and email if known). E.g. "Jenny Wills (Senior Caseworker, MP Zöe Franklin)".' },
                    to:       { type: 'string', description: 'Recipient name. E.g. "Sarah" or "Guildford Borough Council".' },
                    date:     { type: 'string', description: 'When the email was sent — natural format like "27 Apr 2026" or "8 May 2026 14:30".' },
                    subject:  { type: 'string', description: 'Email subject line if known.' },
                    body:     { type: 'string', description: 'The email body verbatim. Plain text is fine.' },
                },
                required: ['threadId', 'type', 'body'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_note_to_thread',
            description: 'Add a free-form note to an existing Thread. Use this for anything that\'s not an email or a file: case analysis updates, research findings, important phone-call summaries, "what they said when I rang them", procedural deadlines you\'ve worked out. Notes show in their own section on the Thread page.',
            parameters: {
                type: 'object',
                properties: {
                    threadId: { type: 'string', description: 'The Thread id.' },
                    content:  { type: 'string', description: 'The note content. Markdown is fine.' },
                    kind:     { type: 'string', description: 'Optional category — e.g. "research", "phone-call", "deadline", "case-summary". Defaults to "note".' },
                },
                required: ['threadId', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_threads',
            description: 'List all of Sarah\'s saved Threads (situations / cases). Use this whenever she references something you might have a Thread for — "the landlord thing", "that complaint with X", "what happened with the boiler" — so you can match her words to a real Thread and pull its details with read_thread. Returns: array of {id, title, summary, status, updatedAt, emailCount}.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_thread',
            description: 'Read the full contents of one Thread — all emails, all prior chat with Q on this case, status, notes. Use this AFTER list_threads when you\'ve identified the Thread Sarah is asking about. Once read, you have the whole case in context and can speak about it confidently. Returns the complete Thread object.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The Thread id from list_threads.' },
                },
                required: ['id'],
            },
        },
    },
    // ── Life admin: calendar + tasks ──────────────────────────────
    {
        type: 'function',
        function: {
            name: 'add_event',
            description: 'Add a dated event (appointment, school trip, meeting, deadline-as-a-moment) to the user\'s calendar on the /life page. Returns the created event.',
            parameters: {
                type: 'object',
                properties: {
                    title:    { type: 'string', description: 'Short event title.' },
                    date:     { type: 'string', description: 'Date as YYYY-MM-DD.' },
                    time:     { type: 'string', description: 'Time as HH:MM 24h, optional.' },
                    location: { type: 'string', description: 'Where, optional.' },
                    notes:    { type: 'string', description: 'Extra info, optional.' },
                },
                required: ['title', 'date'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_events',
            description: 'List upcoming events on the user\'s calendar. Optionally filter by date range (YYYY-MM-DD). Use this when the user asks "what\'s on this week", "do I have anything Friday", "what\'s coming up".',
            parameters: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Earliest date YYYY-MM-DD, optional.' },
                    to:   { type: 'string', description: 'Latest date YYYY-MM-DD, optional.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_task',
            description: 'Add a to-do task to the user\'s task list on the /life page. Use this for "remind me to…", "I need to…", or anything actionable with no specific time.',
            parameters: {
                type: 'object',
                properties: {
                    title:    { type: 'string', description: 'Short imperative title — "Bring PE kit", "Pay the trip fee".' },
                    due:      { type: 'string', description: 'Due date YYYY-MM-DD, optional.' },
                    priority: { type: 'string', enum: ['low', 'med', 'high'], description: 'Priority. Default med.' },
                    notes:    { type: 'string', description: 'Extra info, optional.' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_tasks',
            description: 'List the user\'s tasks. Optionally filter by status (open or done). Default returns open tasks.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['open', 'done'], description: 'Filter. Default open.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'complete_task',
            description: 'Tick a task as done. Use this when the user says "I did X", "done with Y", "tick off Z". The id comes from list_tasks.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Task id from list_tasks.' },
                },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_life_context',
            description: 'Append a fact about the user or their household to their saved "About you" context on /life. The context is read every time Q extracts events/tasks from a photo or paste, so it lets him filter to what\'s relevant. ONLY call this AFTER explicitly asking the user and getting a yes. Phrase the ask warmly and name the benefit — e.g. "Can I remember [X] about you? It means [concrete benefit]. Yes or no?" — never call this tool silently.',
            parameters: {
                type: 'object',
                properties: {
                    addition: { type: 'string', description: 'The new fact to append. Short, declarative, third-person where natural ("Daughter in Year 9 at Park High"; "Works Mon–Thu"; "Nut allergy in the house"). One fact per call.' },
                },
                required: ['addition'],
            },
        },
    },
];

// ─────────────────────────────────────────────────────────────
//  TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────

/**
 * web_search — Brave Search API. 2,000 free/month, independent index.
 * Requires: BRAVE_SEARCH_KEY from api.search.brave.com
 */
async function webSearch({ query, count = 5 }) {
    const apiKey = process.env.BRAVE_SEARCH_KEY;
    if (!apiKey) {
        return { error: 'BRAVE_SEARCH_KEY not configured' };
    }
    if (!query || typeof query !== 'string') {
        return { error: 'Query string required' };
    }
    const safeCount = Math.min(Math.max(parseInt(count) || 5, 1), 10);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${safeCount}&country=gb&search_lang=en`;
    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': apiKey,
            },
        });
        if (!response.ok) {
            const errText = await response.text();
            return { error: `Brave Search HTTP ${response.status}: ${errText.substring(0, 200)}` };
        }
        const data = await response.json();
        const results = (data.web?.results || []).slice(0, safeCount).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
        }));
        return { query, results, count: results.length };
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
                model: Q_CONFIG.visionModel,
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
        const content = cleanModelOutput(data.choices?.[0]?.message?.content || '', 'analyze-document');

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
async function executeTool(name, argsRaw, personId, personEmail) {
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
        case 'create_document':  return await createDocument(args, personEmail);
        case 'remember':         return remember(args, personId);
        case 'recall':           return recall(args, personId);
        // Doc-editor tools — operate on the user's current uploaded doc
        case 'read_doc':          return docEditTool(personId, () => docEditor.readDoc(getDoc(personId)), { keepBytes: true });
        case 'replace_text':      return docEditTool(personId, (b) => docEditor.replaceText(b, args.target, args.replacement, args.paragraph_index ?? null));
        case 'delete_paragraph':  return docEditTool(personId, (b) => docEditor.deleteParagraph(b, args.index));
        case 'insert_paragraph':  return docEditTool(personId, (b) => docEditor.insertParagraph(b, args.after_index, args.text, args.style || 'Normal'));
        case 'move_paragraph':    return docEditTool(personId, (b) => docEditor.moveParagraph(b, args.from_index, args.to_index));
        case 'merge_paragraph':   return docEditTool(personId, (b) => docEditor.mergeParagraph(b, args.source_index, args.target_index, args.position || 'end'));
        case 'format_paragraph':  return docEditTool(personId, (b) => docEditor.formatParagraph(b, args.index, args.style));
        // Creative stack — image, vector, music, video, voice
        case 'generate_image':    return await generateImageTool(args, personEmail);
        case 'vectorise_image':   return await vectoriseImageTool(args, personEmail);
        case 'generate_music':    return await generateMusicTool(args, personEmail);
        case 'generate_video':    return await generateVideoTool(args, personEmail);
        case 'speak_as_q':        return await speakAsQTool(args, personEmail);
        case 'save_situation':       return saveSituation(args, personEmail);
        case 'list_threads':         return listThreadsTool(personEmail);
        case 'read_thread':          return readThreadTool(args, personEmail);
        case 'add_email_to_thread':  return addEmailToThreadTool(args, personEmail);
        case 'add_note_to_thread':   return addNoteToThreadTool(args, personEmail);
        // Life — calendar + tasks
        case 'add_event':            return addEventTool(args, personEmail);
        case 'list_events':          return listEventsTool(args, personEmail);
        case 'add_task':             return addTaskTool(args, personEmail);
        case 'list_tasks':           return listTasksTool(args, personEmail);
        case 'complete_task':        return completeTaskTool(args, personEmail);
        case 'update_life_context':  return updateLifeContextTool(args, personEmail);
        default:                 return { error: `Unknown tool: "${name}"` };
    }
}

/**
 * Helper for doc-editor tools — fetches the current doc, runs the operation,
 * stores the result back in the session, and returns a summary including the
 * fresh paragraph list so Q sees the new state.
 */
function getDoc(personId) {
    const session = docEditor.getSession(personId);
    if (!session || !session.bytes) {
        throw new Error('No document open. Ask the user to upload a .docx on the doc-editor page first.');
    }
    return session.bytes;
}

function docEditTool(personId, op, opts = {}) {
    try {
        const bytes = getDoc(personId);
        const result = op(bytes);
        if (opts.keepBytes) {
            return { ok: true, paragraphs: trimParagraphs(result) };
        }
        if (result && result.bytes) {
            docEditor.setSession(personId, { bytes: result.bytes });
        }
        return {
            ok: true,
            paragraphs: trimParagraphs(docEditor.readDoc(result.bytes)),
            ...(result.replacements !== undefined ? { replacements: result.replacements } : {}),
        };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Keep tool results compact — long paragraphs blow the context window
 * (NRLA-style forms can be 100+ paragraphs with full sentences each).
 * Q gets the index + first 100 chars; if he needs more he can replace_text
 * targeting the prefix he can see.
 */
function trimParagraphs(paragraphs) {
    if (!Array.isArray(paragraphs)) return paragraphs;
    return paragraphs.map(p => ({
        index: p.index,
        style: p.style,
        text: p.text && p.text.length > 120 ? p.text.slice(0, 117) + '…' : (p.text || ''),
    }));
}

/**
 * create_document — generate a .docx file and return a download link.
 * Q embeds the link in his reply so the user can click and save the file.
 */
async function createDocument({ title, content } = {}, personEmail) {
    if (!title || typeof title !== 'string') return { error: 'title (string) is required' };
    if (!content || typeof content !== 'string') return { error: 'content (string) is required' };
    if (!personEmail) return { error: 'Cannot create a document without a signed-in user.' };
    try {
        const result = await createDocx({ title, content }, personEmail);
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

// ─── Creative tool implementations ─────────────────────────────
// Each calls its plugin, stashes the result via stashFile, returns a
// download URL Q embeds in his reply. Errors are surfaced as { error: ... }
// so Q can tell the user what went wrong instead of failing silently.

async function generateImageTool({ prompt, width, height, negative_prompt } = {}, personEmail) {
    if (!prompt || typeof prompt !== 'string') return { error: 'prompt (string) is required' };
    if (!personEmail) return { error: 'Cannot generate without a signed-in user.' };
    try {
        const result = await qImageGen.generateImage(prompt, {
            width, height, negativePrompt: negative_prompt,
        });
        if (result.error || !result.image) {
            return { error: result.error || 'Image generation returned nothing.' };
        }
        const stashed = stashFile(result.image, 'png', prompt, personEmail);
        const url = '/download/' + stashed.token;
        return {
            ok: true,
            filename: stashed.filename,
            sizeBytes: stashed.sizeBytes,
            durationMs: result.durationMs,
            downloadUrl: url,
            instruction_for_q: `Embed this in your reply as inline markdown so the user sees the image: ![${prompt.slice(0, 60)}](${url}). Add one short sentence about it. Do NOT describe the image in detail — they can see it.`,
        };
    } catch (e) {
        return { error: e.message || 'Image generation failed.' };
    }
}

async function vectoriseImageTool({ image_url } = {}, personEmail) {
    if (!image_url || typeof image_url !== 'string') return { error: 'image_url (string) is required' };
    if (!personEmail) return { error: 'Cannot generate without a signed-in user.' };
    try {
        const result = await qGraphics.vectoriseImage(image_url);
        if (result.error || !result.svg) {
            return { error: result.error || 'Vectorise returned nothing.' };
        }
        const buf = Buffer.isBuffer(result.svg) ? result.svg : Buffer.from(String(result.svg), 'utf8');
        const stashed = stashFile(buf, 'svg', 'vector', personEmail);
        const url = '/download/' + stashed.token;
        return {
            ok: true,
            filename: stashed.filename,
            downloadUrl: url,
            instruction_for_q: `Tell the user the SVG is ready with a markdown link: [Download ${stashed.filename}](${url}). One short sentence.`,
        };
    } catch (e) {
        return { error: e.message || 'Vectorise failed.' };
    }
}

async function generateMusicTool({ prompt, duration_seconds } = {}, personEmail) {
    if (!prompt || typeof prompt !== 'string') return { error: 'prompt (string) is required' };
    if (!personEmail) return { error: 'Cannot generate without a signed-in user.' };
    try {
        const dur = Math.min(Math.max(parseInt(duration_seconds) || 30, 5), 240);
        const result = await qMusic.generateMusic(prompt, { duration: dur });
        if (result.error || !result.audio) {
            return { error: result.error || 'Music generation returned nothing.' };
        }
        const ext = (result.mimeType && result.mimeType.includes('mp3')) ? 'mp3' : 'wav';
        const stashed = stashFile(result.audio, ext, prompt, personEmail);
        const url = '/download/' + stashed.token;
        return {
            ok: true,
            filename: stashed.filename,
            durationMs: result.durationMs,
            downloadUrl: url,
            instruction_for_q: `Tell the user the track is ready with a markdown link: [Listen / download ${stashed.filename}](${url}). One short sentence about the vibe.`,
        };
    } catch (e) {
        return { error: e.message || 'Music generation failed.' };
    }
}

async function generateVideoTool({ prompt, duration_seconds } = {}, personEmail) {
    if (!prompt || typeof prompt !== 'string') return { error: 'prompt (string) is required' };
    if (!personEmail) return { error: 'Cannot generate without a signed-in user.' };
    try {
        const dur = Math.min(Math.max(parseInt(duration_seconds) || 5, 1), 10);
        const result = await qVideo.generateVideo(prompt, { duration: dur });
        if (result.error || !result.video) {
            return { error: result.error || 'Video generation returned nothing.' };
        }
        const stashed = stashFile(result.video, 'mp4', prompt, personEmail);
        const url = '/download/' + stashed.token;
        return {
            ok: true,
            filename: stashed.filename,
            durationMs: result.durationMs,
            downloadUrl: url,
            instruction_for_q: `Tell the user the clip is ready and give a markdown link: [Watch / download ${stashed.filename}](${url}). One short sentence on what they'll see.`,
        };
    } catch (e) {
        return { error: e.message || 'Video generation failed.' };
    }
}

async function speakAsQTool({ text } = {}, personEmail) {
    if (!text || typeof text !== 'string') return { error: 'text (string) is required' };
    const voice = loadQVoiceFor(personEmail);
    if (!voice.buffer) return { error: "Q's voice reference isn't loaded — assets/voice-candidates/q-current.mp3 missing." };
    try {
        const result = await speakAsVoice(text, voice.buffer, voice.mimeType, {});
        if (result.error || !result.audio) {
            return { error: result.error || 'Voice generation returned nothing.' };
        }
        const stashed = stashFile(result.audio, 'wav', 'q-narration', personEmail);
        const url = '/download/' + stashed.token;
        return {
            ok: true,
            filename: stashed.filename,
            downloadUrl: url,
            instruction_for_q: `Tell the user the narration is ready with a markdown link: [Listen / download ${stashed.filename}](${url}). One short sentence about what you said.`,
        };
    } catch (e) {
        return { error: e.message || 'Voice generation failed.' };
    }
}

/**
 * save_situation — create a Thread (a folder for one ongoing situation) on
 * the Railway volume. Sarah can view all her threads at /threads and continue
 * working on any one at /thread/{id}.
 */
const qThreads = require('./q-threads');
function saveSituation({ title, summary, content } = {}, personEmail) {
    if (!title || typeof title !== 'string') return { error: 'title (string) is required' };
    if (!personEmail) return { error: 'Cannot save without a signed-in user.' };
    try {
        const thread = qThreads.createThread({ title, summary: summary || '', content: content || '', ownerEmail: personEmail });
        const url = `/thread/${thread.id}`;
        return {
            ok: true,
            title: thread.title,
            id: thread.id,
            url,
            instruction_for_q: `Tell Sarah the situation is saved. Give her a markdown link to open it: [${thread.title}](${url}). Briefly confirm what's in it (1 sentence) so she knows it captured the right thing, then propose the next concrete move on the case.`,
        };
    } catch (e) {
        return { error: 'Could not save situation: ' + e.message };
    }
}

/**
 * list_threads — return a compact list of all of Sarah's saved Threads
 * so Q can match her words to a real saved situation.
 */
function listThreadsTool(personEmail) {
    if (!personEmail) return { error: 'Cannot list threads without a signed-in user.' };
    try {
        const threads = qThreads.listThreads(personEmail);
        return {
            count: threads.length,
            threads: threads.map(t => ({
                id: t.id,
                title: t.title,
                summary: t.summary,
                status: t.status,
                updatedAt: t.updatedAt,
                emailCount: (t.emails || []).length,
            })),
            instruction_for_q: threads.length === 0
                ? 'No saved threads yet. If Sarah is asking about a situation that should be saved, offer to save it with save_situation.'
                : 'Match Sarah\'s words to one of these threads. If you find the one she means, call read_thread next to load the full content. If unsure between two, ask which.',
        };
    } catch (e) {
        return { error: e.message || 'Failed to list threads' };
    }
}

/**
 * read_thread — load one Thread's full contents (emails, chat history, notes)
 * so Q can speak about the case knowledgeably.
 */
function readThreadTool({ id } = {}, personEmail) {
    if (!id || typeof id !== 'string') return { error: 'id (string) is required' };
    if (!personEmail) return { error: 'Cannot read a thread without a signed-in user.' };
    const t = qThreads.readThread(id, personEmail);
    if (!t) return { error: 'Thread not found: ' + id };
    return {
        id: t.id,
        title: t.title,
        summary: t.summary,
        status: t.status,
        emails: t.emails || [],
        chatHistory: t.chatHistory || [],
        notes: t.notes || [],
        instruction_for_q: 'You now have the full case. Reference it confidently in your reply — name the parties, dates, what was said. Always end with the next concrete move.',
    };
}

/**
 * add_email_to_thread — append a real email card to an existing Thread.
 */
function addEmailToThreadTool({ threadId, type, from, to, date, subject, body } = {}, personEmail) {
    if (!threadId) return { error: 'threadId is required' };
    if (!body) return { error: 'body is required' };
    if (!personEmail) return { error: 'Cannot mutate a thread without a signed-in user.' };
    // Ownership check — only the owner can append to a Thread.
    const owned = qThreads.readThread(threadId, personEmail);
    if (!owned) return { error: 'Thread not found: ' + threadId };
    const updated = qThreads.addEmail(threadId, { type, from, to, date, subject, body }, personEmail);
    if (!updated) return { error: 'Thread not found: ' + threadId };
    return {
        ok: true,
        threadId: updated.id,
        emailCount: (updated.emails || []).length,
        instruction_for_q: 'Email added to the Thread. Tell Sarah briefly what was added (who/when), then continue.',
    };
}

/**
 * add_note_to_thread — append a free-form note to an existing Thread.
 */
function addNoteToThreadTool({ threadId, content, kind } = {}, personEmail) {
    if (!threadId) return { error: 'threadId is required' };
    if (!content) return { error: 'content is required' };
    if (!personEmail) return { error: 'Cannot mutate a thread without a signed-in user.' };
    const owned = qThreads.readThread(threadId, personEmail);
    if (!owned) return { error: 'Thread not found: ' + threadId };
    const updated = qThreads.addNote(threadId, { content, kind }, personEmail);
    if (!updated) return { error: 'Thread not found: ' + threadId };
    return {
        ok: true,
        threadId: updated.id,
        noteCount: (updated.notes || []).length,
        instruction_for_q: 'Note saved on the Thread. Brief confirmation, then move on.',
    };
}

// ── Life — calendar + tasks ─────────────────────────────────────────────

function addEventTool({ title, date, time, location, notes } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot add an event without a signed-in user.' };
    if (!title) return { error: 'title is required' };
    if (!date)  return { error: 'date is required (YYYY-MM-DD)' };
    try {
        const event = qLife.addEvent({ title, date, time, location, notes, source: 'chat' }, personEmail);
        return {
            ok: true,
            event,
            instruction_for_q: 'Event saved to the calendar. One short line confirming it (title + date). Don\'t repeat the whole thing back.',
        };
    } catch (e) { return { error: e.message }; }
}

function listEventsTool({ from, to } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot list events without a signed-in user.' };
    const events = qLife.listEvents(personEmail, { from, to });
    return {
        count: events.length,
        events,
        instruction_for_q: events.length === 0
            ? 'Nothing on the calendar in that range. Say so plainly.'
            : 'Summarise what\'s coming up. Use date + title; mention time + location only where they help.',
    };
}

function addTaskTool({ title, due, priority, notes } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot add a task without a signed-in user.' };
    if (!title) return { error: 'title is required' };
    try {
        const task = qLife.addTask({ title, due, priority, notes, source: 'chat' }, personEmail);
        return {
            ok: true,
            task,
            instruction_for_q: 'Task added. One short confirming line — title (and due date if there is one).',
        };
    } catch (e) { return { error: e.message }; }
}

function listTasksTool({ status } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot list tasks without a signed-in user.' };
    const tasks = qLife.listTasks(personEmail, { status: status || 'open' });
    return {
        count: tasks.length,
        tasks,
        instruction_for_q: tasks.length === 0
            ? 'No open tasks. Say so plainly.'
            : 'Summarise the open tasks. Lead with anything overdue or due soon.',
    };
}

function completeTaskTool({ id } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot complete a task without a signed-in user.' };
    if (!id) return { error: 'id is required (use list_tasks first)' };
    const updated = qLife.updateTask(id, { done: true }, personEmail);
    if (!updated) return { error: 'Task not found: ' + id };
    return {
        ok: true,
        task: updated,
        instruction_for_q: 'Task ticked off. Brief warm acknowledgement, no fuss.',
    };
}

function updateLifeContextTool({ addition } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot update life context without a signed-in user.' };
    const fact = String(addition || '').trim();
    if (!fact) return { error: 'addition (string) is required' };
    const existing = qLife.getContext(personEmail) || '';
    const stamp = new Date().toISOString().slice(0, 10);
    const line = `- ${fact} (${stamp})`;
    const next = existing.trim() ? `${existing.trim()}\n${line}\n` : `${line}\n`;
    qLife.setContext(next, personEmail);
    return {
        ok: true,
        addition: fact,
        instruction_for_q: 'Saved. One short warm confirmation in your own voice — don\'t parrot the fact back verbatim.',
    };
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
const ALWAYS_ON = new Set([
    'remember', 'recall',
    // Threads/situations are core memory across surfaces — Q gets these on
    // every turn so he can correlate to a saved case whenever Sarah refers
    // to one (anywhere — main chat, email writer, inside a Thread).
    'list_threads', 'read_thread', 'save_situation',
    'add_email_to_thread', 'add_note_to_thread',
    // Life calendar + tasks — common life-admin asks ("what's on Friday",
    // "remind me to bring the form") need these without ceremony.
    'add_event', 'list_events', 'add_task', 'list_tasks', 'complete_task',
    // Q can volunteer to remember household facts (kids' year groups, work
    // patterns, allergies) that bias what counts as "relevant" on /life.
    // Tool description requires Q to ASK first — never silent.
    'update_life_context',
]);

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
    generate_image: [
        /\b(draw|generate|create|make|paint|render|design) [^.?!]{0,40}\b(image|picture|photo|illustration|hero|banner|poster|graphic|visual|artwork)\b/i,
        /\bshow me (a|an) (image|picture|illustration)\b/i,
        /\b(picture|image) of\b/i,
    ],
    vectorise_image: [
        /\b(vector(ise|ize)?|svg|trace|convert .* to (svg|vector))\b/i,
    ],
    generate_music: [
        /\b(compose|generate|make|write|create) [^.?!]{0,40}\b(music|song|tune|jingle|track|score|backing track|hold music)\b/i,
    ],
    generate_video: [
        /\b(generate|make|create|render|produce) [^.?!]{0,40}\b(video|clip|reel|animation)\b/i,
    ],
    speak_as_q: [
        /\b(say (that|this)|speak (that|this|it)|narrate|read (that|it|this) aloud|in your (own )?voice|out loud)\b/i,
    ],
    // Doc-editor tools — fire when the user is talking about editing the
    // document on screen. The doc-editor page also passes a flag that
    // unconditionally enables these (see selectActiveTools below).
    read_doc:         [/\b(read|show|list|what'?s in)\b.*\b(doc|document|paragraph)/i],
    replace_text:     [/\b(replace|swap|change)\b.*\b(text|word|phrase|to)/i],
    delete_paragraph: [/\b(delete|remove|drop|get rid of)\b.*\b(paragraph|line|that)/i],
    insert_paragraph: [/\b(add|insert|put in)\b.*\b(paragraph|line|new)/i],
    move_paragraph:   [/\b(move|relocate|shift)\b.*\b(paragraph|line|to)/i],
    merge_paragraph:  [/\b(merge|combine|inline|join|put on (the|that) line|same line|stranded|bring (it|that) up)/i],
    format_paragraph: [/\b(bold|italic|underline|heading|centre|center|left|right|justify|format)/i],
};

// Tools that should always be available when the user has a doc open in
// the editor — set via ?docEditor=1 on the chat call from doc-editor.html.
const DOC_EDITOR_TOOLS = new Set([
    'read_doc', 'replace_text', 'delete_paragraph', 'insert_paragraph',
    'move_paragraph', 'merge_paragraph', 'format_paragraph',
]);

function selectActiveTools(userMessage, options = {}) {
    const msg = String(userMessage || '');
    return TOOL_DEFINITIONS.filter(t => {
        const name = t.function?.name;
        if (!name) return false;
        if (ALWAYS_ON.has(name)) return true;
        // Doc-editor page: all doc-editor tools always on
        if (options.docEditor && DOC_EDITOR_TOOLS.has(name)) return true;
        const triggers = TRIGGERS[name];
        if (!triggers) return false;
        return triggers.some(rx => rx.test(msg));
    });
}

module.exports = {
    TOOL_DEFINITIONS,
    executeTool,
    analyzeDocument,
    selectActiveTools,
    // Q voice override controls — used by /q-voice/* routes
    setQVoiceFromBuffer,
    clearQVoice,
    getQVoiceStatus,
};
