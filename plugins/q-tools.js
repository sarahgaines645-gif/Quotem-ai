/**
 * Q TOOLS — capability layer Q calls during chat.
 *
 * Four core tools that turn Q from a brain into a brain with hands:
 *   - web_search       → live web search via Brave Search API (independent index, not Google/Bing)
 *   - calculator       → accurate arithmetic (LLMs are bad at maths)
 *   - current_datetime → timezone-aware time/date
 *   - analyze_document → vision via Q_CONFIG.visionModel on Together AI (Q is text-only, this is his eyes)
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
const { getActiveTutorPath } = require('../memory');
const { createDocx, createPdf, stashFile, resolveToken } = require('./doc-creator');
const { cleanModelOutput } = require('./cjk-filter');
const { timedFetch } = require('./timed-fetch');
const { logUsage } = require('../cost-tracker');
const docEditor = require('./q-doc-editor');
const qImageGen = require('./q-image-gen');
const qGraphics = require('./q-graphics');
// q-music (generate_music) and q-voice-clone (speak_as_q + the Q-voice override
// helpers setQVoiceFromBuffer / clearQVoice / getQVoiceStatus / loadQVoiceFor)
// RETIRED 2026-08-15 — see retired/2026-08-15-voice-clone-and-music/RETIRED.md
const qVideo = require('./q-video');
const qLife = require('./q-life');
const qTravel = require('./q-travel');
const qShop   = require('./q-shop');
const qHome   = require('./q-home');
const qNext   = require('./q-next');
const qDesk   = require('./q-desk');
const qFollow = require('./q-followup');

// ─────────────────────────────────────────────────────────────
//  TOOL DEFINITIONS — OpenAI function-calling schema
// ─────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
    // ── WRITER COACH tools (Q as the student's tutor on /writer; Sarah, 18 Aug:
    //    "can you give Q these tools" — the three Q himself asked for). ────────
    {
        type: 'function',
        function: {
            name: 'check_reference',
            description: 'Check whether a citation the student used is REAL and what it is actually about. Looks the work up on OpenAlex and CrossRef by DOI, title, or author + year, and returns what was found: the real title, authors, year, venue and the abstract or summary. Use it whenever a citation looks doubtful, whenever the student asks if a source is right, and before you accept that a source backs a claim. Then YOU judge, from the abstract, whether it supports what the student says (e.g. "this is about fibre optics, not Taylorism"). Never call a source real or relevant without checking.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The citation as the student wrote it, or the DOI, or the title, or author + year — whatever you have.' },
                    claim: { type: 'string', description: 'What the student says this source shows (one sentence). Optional, but it makes your judgement of fit possible.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'highlight_passage',
            description: 'Highlight a passage ON THE STUDENT\'S PAGE and attach a short note to it, exactly where it matters — "cut this", "wrong source — this paper is about X", "split into two sentences", "good — keep". The page paints the passage and puts a dot after it; the note shows when they press the dot. The passage must be VERBATIM text from their page (copy it exactly, 4-40 words). Use it instead of quoting chunks back at them. You may call it several times in one turn.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The exact passage from their page, verbatim.' },
                    note: { type: 'string', description: 'Your note for that passage, one or two short sentences, in plain words, telling them what to do.' },
                    kind: { type: 'string', enum: ['cut', 'source', 'split', 'weak', 'good', 'note'], description: 'What kind of note: cut it / wrong or missing source / split it / weak claim / good keep it / other.' },
                    colour: { type: 'string', enum: ['pink', 'amber', 'blue', 'violet', 'green', 'grey'], description: 'Highlighter colour. Optional — each kind has its own (cut pink, source amber, split blue, weak violet, good green, note grey). Set it when you want a colour scheme of your own for this session (say what the colours mean once).' },
                },
                required: ['text', 'note'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'tab_paragraph',
            description: 'Stick a coloured INDEX TAB on the student\'s page — like the sticky tabs on a notepad — with a short label: "Q1 intro", "theory here", "cut?", "move up", "needs source". TWO ways to place it: `paragraph` (the [P4] numbers you were given) hangs it in the MARGIN of that paragraph, colour on the outside; `text` (the exact words on a line — a sentence, a heading, a reference, anywhere in the document) stands it ON that line, colour on top. Tabs are for marking STRUCTURE and places to revisit; highlight_passage is for a passage inside the text. They can press a tab to recolour, relabel, move or take it off. If you are asked to change a tab, call this again for the same paragraph/text — it replaces the old one.',
            parameters: {
                type: 'object',
                properties: {
                    paragraph: { type: 'integer', description: 'The paragraph number, 1-based, as in [P4] — a margin tab on that paragraph. Give paragraph OR text.' },
                    text: { type: 'string', description: 'The exact words (5-12) on the line where the tab should stand, copied from the page — for a tab inside a paragraph, on a heading or on a reference. Give paragraph OR text.' },
                    label: { type: 'string', description: 'The tab label, 1-4 words.' },
                    colour: { type: 'string', enum: ['pink', 'amber', 'blue', 'violet', 'green', 'grey'], description: 'Tab colour. Optional; default grey.' },
                    side: { type: 'string', enum: ['right', 'left', 'top'], description: 'Paragraph tabs only: where it hangs. Default right — off the right edge of the paragraph\'s first line, colour on the outside, like a notepad index tab. Use left or top only when it reads better there. A text tab always stands on its line, colour on top.' },
                },
                required: ['label'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'stick_note',
            description: 'Drop a STICKY NOTE on the whiteboard — a small coloured card with a quick thought, disposable, separate from the display: "come back to turnover", "ask her which sector", "needs a figure". They can drag it around, send it to their page, or bin it. Not for information that belongs on the display; for the passing note you would stick on the edge of the board.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The note, 1-20 words.' },
                    colour: { type: 'string', enum: ['pink', 'amber', 'blue', 'violet', 'green', 'grey', 'yellow'], description: 'Optional; default yellow.' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'board_note',
            description: 'Put a short note on the TEACHING BOARD — the worksheet beside the student\'s page that holds what they must remember for the question they are on. Not the whiteboard (that is the display and stick_note): the board is what they keep. Use it when something is worth keeping past this reply — a rule they keep breaking, a definition the marker wants, the one thing left to do on this question. One line, plain, in their words. Never repeat what is already on the board, on the whiteboard, or in your reply.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The note itself — one short line, at most about 200 characters.' },
                    label: { type: 'string', description: 'A short tag for it, 1-3 words: \'note\', \'watch out\', \'remember\', \'to do\'.' },
                    kind: { type: 'string', enum: ['note', 'question', 'todo'], description: 'What it is: a note to keep, a question for them to think about, or something still to do. Default note.' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'board_clear',
            description: 'Take YOUR OWN notes back off the teaching board when they are done with or no longer true — the board holds what matters now, not everything you have ever said. Only your board notes come off: their questions, their answers and the worksheet are never touched. Pass a label to take off only the notes carrying that tag; pass nothing to take off all of yours.',
            parameters: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'Optional — only take off your notes carrying this tag (e.g. \'to do\'). Leave it out to take off all of your notes.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_email',
            description: 'Send an email from the user\'s OWN connected email account (Gmail or SMTP). ONLY call this when the user has clearly told you to SEND an email — never to draft or preview. It goes out from their real address; it cannot be unsent. If you previously saved a draft with save_email_draft, pass that draft_id here so the draft is removed from the outbox automatically after sending.',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Recipient email address.' },
                    subject: { type: 'string', description: 'The subject line.' },
                    body: { type: 'string', description: 'The full plain-text body of the email.' },
                    draft_id: { type: 'string', description: 'The draftId from a previous save_email_draft call for this email. Pass it so the outbox draft is removed automatically after sending — otherwise the draft lingers in the outbox.' },
                    attachments: { type: 'array', items: { type: 'string' }, description: 'Optional list of filenames from this case\'s Files to attach (e.g. ["id-photo.jpg", "TE7.pdf"]). Only use filenames that are actually in the thread\'s file list.' },
                },
                required: ['to', 'subject', 'body'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_inbox',
            description: "Read the user's OWN email inbox (their connected Gmail) and return the most recent messages — sender, subject, date, and whether it's unread. Use this whenever the user asks you to check their email, see if anything important has come in, or look for a message from someone. Read-only — it never sends, changes, or deletes anything. After listing, tell the user plainly what's landed and flag anything that looks important or time-sensitive.",
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'How many recent messages to return (default 15, max 40).' },
                    unread_only: { type: 'boolean', description: 'If true, only return unread messages.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_email',
            description: "Read ONE full email by its id (the id comes from check_inbox). Returns the sender, subject, date, the full text of the message, and a list of any attachments (each with an attachment_id you can pass to read_email_attachment). Use this after check_inbox when the user wants to know what a message actually says, before replying, or before filing it to a case.",
            parameters: {
                type: 'object',
                properties: {
                    message_id: { type: 'string', description: 'The id of the message to open, from check_inbox.' },
                },
                required: ['message_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_email_attachment',
            description: "Fetch an attachment from an email and read what's inside it. PDFs, images and scans are read with vision/OCR; text and Word files are decoded. Use this when the user wants to know what an attachment contains, or before filing it. Optionally file the attachment straight into a case Thread's Files by passing save_to_thread_id.",
            parameters: {
                type: 'object',
                properties: {
                    message_id: { type: 'string', description: 'The email id (from check_inbox / read_email).' },
                    attachment_id: { type: 'string', description: "The attachment_id from read_email's attachments list." },
                    filename: { type: 'string', description: 'The attachment filename (from read_email).' },
                    mime_type: { type: 'string', description: "The attachment's mime_type from read_email (helps read it correctly). Optional." },
                    save_to_thread_id: { type: 'string', description: "Optional. A Thread id to also save this attachment into that case's Files." },
                },
                required: ['message_id', 'attachment_id', 'filename'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'save_email_draft',
            description: 'Save a drafted email to the user\'s outbox so they can review and send it with one click. Call this EVERY TIME you write an email for the user — do not just paste email text in the chat. If you are drafting multiple emails in one reply, call this once per email. IMPORTANT: always include the "to" field if you know or have discussed the recipient — the user should not have to look it up themselves. When REVISING a draft you already saved, pass the draft_id you received from the first save — this updates the same item rather than creating a second one.',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Recipient email address. REQUIRED if the email address has been mentioned or discussed in this thread. Leave blank only if genuinely unknown.' },
                    subject: { type: 'string', description: 'The subject line.' },
                    body: { type: 'string', description: 'The full plain-text body of the email.' },
                    draft_id: { type: 'string', description: 'The draftId returned by a previous save_email_draft call for THIS email. Pass it when revising an existing draft so it is updated in place rather than creating a duplicate.' },
                    attachments: { type: 'array', items: { type: 'string' }, description: 'Optional list of filenames from this thread\'s Files to include as attachments (e.g. ["id-photo.jpg", "TE7.pdf"]). Only use filenames that are actually in the thread\'s file list.' },
                },
                required: ['subject', 'body'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fetch_form',
            description: 'Download an official government or court form (PDF) directly from GOV.UK or another authoritative source and save it into this Thread\'s Files so the user can fill it in using the Forms panel. Use this whenever the user needs a specific form (e.g. TE7, TE9, N1, ET1, TEN, statutory declaration). First use web_search to find the direct PDF download URL on the official site, then call this tool with that URL. After it saves, tell the user: "I\'ve downloaded [form name] — it\'s in your Files. Open the Forms panel (top right) and pick it from the dropdown to fill it in."',
            parameters: {
                type: 'object',
                properties: {
                    url:      { type: 'string', description: 'Direct https:// URL to the PDF form. Must be a real GOV.UK or court service URL — never fabricate.' },
                    filename: { type: 'string', description: 'Friendly filename to save it as, e.g. "TE7-representations.pdf". If omitted, derived from the URL.' },
                    note:     { type: 'string', description: 'One-line note about what this form is for (e.g. "TE7 — formal representations against a PCN"). Shown in the Files list.' },
                },
                required: ['url'],
            },
        },
    },
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
            name: 'search_images',
            description: 'Search the live web for PHOTOS / pictures of a real place, object, sign or thing. Use this when the user wants to FIND a real image that exists online (e.g. "find a photo of the signage on Brick Lane", "pictures of that junction") — NOT to invent or draw one (that is generate_image). Returns real results with a thumbnail and the page they came from. Good for research and evidence gathering. After showing them, you can file chosen ones onto a case Thread with add_file_to_thread.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What to find a picture of — natural language, e.g. "Brick Lane bus gate restriction sign", "Hanbury Street junction looking west".',
                    },
                    count: {
                        type: 'integer',
                        description: 'Number of images to return (1-10). Default 6.',
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
            name: 'street_view',
            description: 'Fetch a street-level photo of a specific road / junction / address so you and the user can SEE the road layout and signage — built for fighting parking & moving-traffic tickets (e.g. was the restriction clearly signed?). IMPORTANT and you must say this to the user: this returns the CURRENT view of that location, not how it looked on a past date — it corroborates the general signage/layout, it is not dated proof of a specific day. Returns a downloadable image you can show and then file onto the case Thread with add_file_to_thread. If the road-imagery service is not switched on yet, you will get a clear error — relay it plainly and carry on with the rest of the case.',
            parameters: {
                type: 'object',
                properties: {
                    location: {
                        type: 'string',
                        description: 'An address or place to look at, e.g. "Brick Lane, London E1 6QL" or "junction of Brick Lane and Hanbury Street, London". Either this OR lat+lng is required.',
                    },
                    lat: { type: 'number', description: 'Latitude (use with lng instead of location for a precise point).' },
                    lng: { type: 'number', description: 'Longitude (use with lat).' },
                    heading: { type: 'integer', description: 'Compass direction the camera faces, 0-359 (0=N, 90=E, 180=S, 270=W). Optional — omit to let it auto-face the road.' },
                    pitch: { type: 'integer', description: 'Up/down angle -90..90. 0 = level (default). Use +10..20 to catch a high-mounted sign.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'schedule_followup',
            description: 'Promise to CHASE something — set the moment you will come back to it and the words you will chase with. This is the tool that turns a saved task into something that actually gets done: when the moment passes, they get a notification AND you are told about it at the top of your next conversation, so you raise it yourself instead of waiting to be asked. Use it whenever something is left hanging on someone else or on them ("I\'ll ring them tomorrow", "waiting to hear back", "remind me if they haven\'t replied by Friday"), and whenever you draft something that still needs sending. Give a real date and time — never guess one, ask. Tell them plainly that if it is not done by then you WILL bring it up; that promise is the whole point.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: { type: 'string', description: 'The id of an existing task to attach the chase to, if you know it (from list_tasks or add_task).' },
                    what:    { type: 'string', description: 'What is being chased, in their words — e.g. "send the Harrow Health email". Used to find an existing task, or to create one if there is none.' },
                    when:    { type: 'string', description: 'When to chase — ISO datetime, e.g. "2026-08-22T09:00:00". Required. Never invent this; if they have not said, ask.' },
                    chase:   { type: 'string', description: 'The words to chase with, written to them — e.g. "the Harrow Health email still hasn\'t gone, want me to send it now?". Optional but much better with it.' },
                },
                required: ['when'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_drafts',
            description: 'Find out which emails you have written that are STILL SITTING UNSENT in their outbox. Anything in there has not gone — sending removes it. Use this when they ask whether something was sent, when you are about to write another email to the same people, when picking up an old thread, and whenever you are working out what is outstanding. This is one of the few ways you can find out that your own work did not land, so use it rather than assuming a draft you wrote went out. You cannot send anything yourself without them saying so.',
            parameters: {
                type: 'object',
                properties: {
                    older_than_days: { type: 'integer', description: 'Only show drafts waiting at least this many days. Optional — omit for all of them.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_contact',
            description: 'Find a REAL email address for a person or an organisation, from their own past drafts, their saved case files and their recent inbox. Use it before writing to anyone whose address you do not already have in front of you — especially when they say something like "contact the person who deals with my X", where you know the organisation but not the human. Every address that comes back was genuinely found somewhere and the result says where. NEVER invent an address, never guess a pattern like firstname.lastname@, and never quietly send to a general enquiries inbox as though it were the right person. If nothing is found, say so and ask them who it should go to.',
            parameters: {
                type: 'object',
                properties: {
                    who: { type: 'string', description: 'The person, practice, company or organisation — e.g. "Harrow Health", "the surveyor", "Barclays".' },
                },
                required: ['who'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_page_history',
            description: 'SEARCH THEIR REAL SAVED HISTORY — everything they have ever said to you, across every page. **You are only ever shown the most recent part of a conversation, so something you genuinely said can be missing from what is in front of you.** Use this tool BEFORE you ever tell someone you do not remember something, or that a conversation did not happen. If they say "you told me…", "do you remember…", "what did you say about…", "we talked about this earlier" — search for it here first. Pass `search` with the subject (e.g. "kitchen tap") and leave `page` out to look everywhere. Telling someone you never said something you did say is far worse than taking a moment to check.',
            parameters: {
                type: 'object',
                properties: {
                    search: { type: 'string', description: 'What it was about — e.g. "kitchen tap", "Harrow Health", "the invoice". Use this when they refer to something you cannot see. A hit comes back with the conversation around it, not just the one line.' },
                    on:     { type: 'string', description: 'A whole day: "today", "yesterday", or a date like "2026-08-19". Use this when they ask about a WHEN rather than a what — "what did we talk about this morning", "what did I say on Tuesday". Works with or without a search word.' },
                    from:   { type: 'string', description: 'Start of a window — a date "2026-08-19" or a datetime "2026-08-19T09:00". For "this morning" use from today at T00:00 and to T12:00.' },
                    to:     { type: 'string', description: 'End of a window — same formats as `from`.' },
                    page:   { type: 'string', description: 'Optional — narrow to one page: "chat", "writer", "life", "finance", "email", "thread". LEAVE IT OUT to search every page, which is usually what you want.' },
                    limit:  { type: 'integer', description: 'How many messages to return (1-60). Default 20.', minimum: 1, maximum: 60 },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'bulk_add_tasks',
            description: 'Save SEVERAL tasks at once, when they have brain-dumped a list in one go ("I need to ring the school, book the MOT, chase that invoice and get milk"). One call instead of one per task. Only save what they actually named — never pad the list out with things you think they ought to do. If just one thing was named, use add_task instead.',
            parameters: {
                type: 'object',
                properties: {
                    tasks: {
                        type: 'array',
                        description: 'The tasks, in the order they said them.',
                        items: {
                            type: 'object',
                            properties: {
                                title:    { type: 'string', description: 'Short imperative title — "Ring the school".' },
                                due:      { type: 'string', description: 'Due date YYYY-MM-DD, optional.' },
                                priority: { type: 'string', enum: ['low', 'med', 'high'], description: 'Optional. Default med.' },
                                category: { type: 'string', description: 'Category slug, optional.' },
                                notes:    { type: 'string', description: 'Extra detail, optional.' },
                            },
                            required: ['title'],
                        },
                    },
                },
                required: ['tasks'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_next_action',
            description: 'Work out the ONE thing the user should do next, out of everything on their plate — overdue tasks, what is due today, what is starting soon in the diary. Use it whenever they ask "what should I do now", "what\'s next", "where do I start", "I don\'t know what to do first", or when they sound stuck, scattered or overwhelmed. Give them the single item it returns and the reason it won. Do NOT turn the answer into a list — a list is the thing that overwhelms them, and one clear next step is the entire point of this tool. You may add at most one short clause of context (e.g. "the other three can wait"). If it says nothing is outstanding, say exactly that and do not invent something to fill the gap.',
            parameters: {
                type: 'object',
                properties: {
                    include_runners_up: {
                        type: 'boolean',
                        description: 'Only set true if the user has ALREADY been given the top item and is now asking what else there is. Default false.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'home_status',
            description: 'Look at the user\'s actual house — what is switched on, what door or window is open, how warm a room is, what needs a new battery, what has gone offline. Use this whenever they ask anything about their home: "did I leave the hall light on", "is the back door shut", "how cold is it in there", "is anything still running". Every reading comes from their own hub. Report what it says and nothing more: never state a temperature, a door or an on/off you have not fetched, and never answer a house question from memory. A device reported as unavailable is NOT off — it means the hub cannot see it, and you must say that rather than guessing. If the hub cannot be reached, say so plainly and offer to try again.',
            parameters: {
                type: 'object',
                properties: {
                    search: {
                        type: 'string',
                        description: 'Optional — narrow to devices matching a name or room, e.g. "kitchen", "back door", "thermostat". Leave it out for a whole-house look.',
                    },
                    kind: {
                        type: 'string',
                        description: 'Optional — narrow to one type of thing: "light", "switch", "sensor", "binary_sensor", "climate", "lock", "camera", "media_player".',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'home_control',
            description: 'Switch something in the user\'s house on or off, set a thermostat, or run a scene. Use it when they ask you to DO something to the house ("turn the landing light off", "put the heating to 19"). Say what actually happened using what the house reported back afterwards — if it did not change, say so; never claim success you were not told about. If more than one device matches the name you will be asked to choose: put that question to the user rather than picking one. Locks, alarms, garage doors and blinds are deliberately read-only — you can tell the user their state but you cannot operate them, and if asked you should say plainly that this is a safety choice and it has to be done in the app or by hand.',
            parameters: {
                type: 'object',
                properties: {
                    what: {
                        type: 'string',
                        description: 'The device as the user names it, e.g. "kitchen light", "landing lamp", "heating".',
                    },
                    action: {
                        type: 'string',
                        description: '"on", "off" or "toggle". For a thermostat, use "on" together with temperature.',
                    },
                    temperature: {
                        type: 'number',
                        description: 'Target temperature in degrees, for a thermostat only.',
                    },
                },
                required: ['what', 'action'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'shop_search',
            description: 'Find something a person can actually BUY, right now, with a real price and a link to the page selling it. Use this for anything they need to get hold of — a kettle, school shoes, printer ink, dog food, a birthday present, a replacement part, a drill, a mattress — and whenever they ask what something costs, where to get it, or which shop is cheapest. Prefer this over a plain web search whenever the answer is a thing with a price. You may also name a shop to look inside one specific place. Everything that comes back is copied from the shop listing: never quote a price, a shop or a product that is not in the result, and never fill a gap from memory. Two limits you must pass on, once, in plain words: (1) a price is what the shop\'s page said when the search index last looked, so it can be out of date — the link shows the live page; (2) this is NOT a stock check, it cannot tell anyone whether the item is actually in stock or in their local branch. Results can come back in different currencies, so always quote the currency and never add or compare across currencies without saying so. If nothing is found, say so plainly and offer to try different words or a named shop.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What they want to buy, as a person would say it — e.g. "black school shoes size 4", "HP 302 printer ink", "18v cordless drill", "1200mm shower screen". Be specific: size, colour, model and capacity all sharpen the result.',
                    },
                    shop: {
                        type: 'string',
                        description: 'Optional — look inside ONE shop only. A name works ("Argos", "Amazon", "Screwfix", "Tesco", "John Lewis") and so does a domain ("wickes.co.uk"). Use it when the user names a shop, or when you want that shop\'s own range rather than whatever ranks highest.',
                    },
                    max_results: {
                        type: 'integer',
                        description: 'How many products to return (1-20). Default 8.',
                        minimum: 1,
                        maximum: 20,
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_hotels',
            description: 'Search LIVE hotel availability and prices for real dates — either for a destination (city/area) or for one hotel by name. Use this whenever the user asks what a hotel or a stay would cost, whether somewhere has rooms free, or asks you to compare places to stay. You must have real check-in and check-out dates and the room set-up (how many rooms, how many adults, ages of any children) — ask for them rather than assuming. Every price comes back WITH its currency and results can be in DIFFERENT currencies, so always quote the currency and never add prices together or convert without saying so. If nothing comes back, say nothing was found — never invent a hotel, a price or an availability status. LIMITATION you must tell the user about: UK package holiday operators (Jet2, TUI, loveholidays, On the Beach) publish NO public API, so a package price cannot be looked up here at all. The honest answer is to price the flight (search_flights) and the hotel (this tool) separately and say plainly that a package may work out cheaper or dearer — do NOT guess a package price.',
            parameters: {
                type: 'object',
                properties: {
                    destination:  { type: 'string', description: 'Where they want to stay — city, town, island or area, e.g. "Malaga", "Lake District", "Tenerife South". Use this OR hotel_name.' },
                    hotel_name:   { type: 'string', description: 'A specific hotel by name, e.g. "Hotel Riu Palace Tenerife". Use this instead of destination when the user names a hotel.' },
                    check_in:     { type: 'string', description: 'Check-in date, YYYY-MM-DD. Required — never guess it; ask the user.' },
                    check_out:    { type: 'string', description: 'Check-out date, YYYY-MM-DD. Required, must be after check_in.' },
                    rooms:        { type: 'integer', description: 'How many rooms. Default 1.', minimum: 1, maximum: 8 },
                    adults:       { type: 'integer', description: 'Total number of adults across all the rooms. Default 2.', minimum: 1, maximum: 30 },
                    children_ages:{ type: 'array', items: { type: 'integer' }, description: 'Ages of any children, e.g. [4, 9]. Hotel pricing needs the AGES, not just the count — ask if the user has not said.' },
                    currency:     { type: 'string', description: 'ISO currency to price in, e.g. "GBP". Default GBP. The service may still return some results in other currencies.' },
                    max_results:  { type: 'integer', description: 'How many hotels to return (1-20). Default 8.', minimum: 1, maximum: 20 },
                },
                required: ['check_in', 'check_out'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_flights',
            description: 'Search LIVE flight prices between two airports on real dates. Use this when the user asks what flights cost, when comparing airports or dates, or when building a trip alongside search_hotels. Give airport codes where you can (LGW, MAN, AGP); ask the user which airport rather than assuming their nearest. Prices are live fares that move — always quote the currency and say the fare is live. If nothing comes back, say nothing was found; never invent a flight, a time or a fare. Two limitations you must pass on: (1) this prices SCHEDULED flights only — UK package holiday operators (Jet2, TUI, loveholidays, On the Beach) have NO public API, so a package price cannot be looked up and must never be guessed; price flight + hotel separately and say that is what you have done. (2) A cheap fare on a date means nothing if the route only runs on certain days — check flight_schedule before telling anyone a trip works.',
            parameters: {
                type: 'object',
                properties: {
                    from:        { type: 'string', description: 'Departure airport — IATA code preferred, e.g. "LGW". A city name will also be resolved.' },
                    to:          { type: 'string', description: 'Arrival airport — IATA code preferred, e.g. "AGP".' },
                    date:        { type: 'string', description: 'Outbound date, YYYY-MM-DD. Required — never guess; ask.' },
                    return_date: { type: 'string', description: 'Return date, YYYY-MM-DD. Omit for a one-way search.' },
                    adults:      { type: 'integer', description: 'Number of adults. Default 1.', minimum: 1, maximum: 9 },
                    children:    { type: 'integer', description: 'Number of children. Default 0.', minimum: 0, maximum: 8 },
                    cabin:       { type: 'string', description: 'Cabin class: economy (default), premium_economy, business, first.' },
                    currency:    { type: 'string', description: 'ISO currency, e.g. "GBP". Default GBP.' },
                    max_results: { type: 'integer', description: 'How many fares to return (1-20). Default 6.', minimum: 1, maximum: 20 },
                },
                required: ['from', 'to', 'date'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'flight_schedule',
            description: 'Find out which airlines fly a route AND ON WHICH DAYS OF THE WEEK it actually operates. Use this before telling anyone a trip works — a route that only runs Tuesdays and Saturdays looks perfectly bookable on a price search and then silently kills the trip when they try to come home on the Friday. Also use it when the user asks "is there a direct flight", "who flies there", or "can we go out on the Monday and back on the Thursday". The answer is built from REAL scheduled departures in a real calendar window, and the result tells you exactly which window was checked — say that window to the user, and if no departures were found say exactly that (it may simply run on other days or seasonally). Never state a day of the week that is not in the result, and never invent an airline or a flight time. Note for holiday comparisons: UK package operators (Jet2, TUI, loveholidays, On the Beach) publish no API, so their charter-only routes may not appear here and a package price can never be looked up.',
            parameters: {
                type: 'object',
                properties: {
                    from:       { type: 'string', description: 'Origin airport — 3-letter IATA (e.g. "LGW") or 4-letter ICAO.' },
                    to:         { type: 'string', description: 'Destination airport — 3-letter IATA (e.g. "AGP") or 4-letter ICAO. Must match the code type used for `from`.' },
                    start_date: { type: 'string', description: 'First day of the week to check, YYYY-MM-DD. Defaults to today. Use the week the user is actually travelling.' },
                    days:       { type: 'integer', description: 'How many consecutive days to check (1-7). Default 7 — a full week, which is what shows the weekly pattern.', minimum: 1, maximum: 7 },
                },
                required: ['from', 'to'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_file_to_thread',
            description: 'Put a file (a photo you found with search_images, a Street View image, a document you created, or any image/PDF at a URL) INTO a case Thread, so it lives in that case\'s folder alongside the notes and emails. Use this to assemble an evidence case. Pass EITHER `token` (from a previous search_images/street_view/create_document result) OR `url` (a direct http/https link to the image/file). Always include a short `note` describing what the file is and where it came from — provenance matters for evidence.',
            parameters: {
                type: 'object',
                properties: {
                    threadId: { type: 'string', description: 'The Thread/case id to attach the file to (from save_situation or list_threads).' },
                    token:    { type: 'string', description: 'A download token from a previous tool result (street_view, create_document, search-derived). Use this OR url.' },
                    url:      { type: 'string', description: 'A direct http(s) URL to an image or PDF to fetch and file. Use this OR token.' },
                    filename: { type: 'string', description: 'What to name the file in the case, e.g. "brick-lane-signage-1.jpg". Keep the right extension.' },
                    note:     { type: 'string', description: 'One line on what this is and its source, e.g. "Street View of Brick Lane / Hanbury St junction (current imagery, fetched today)". Saved as a provenance note on the Thread.' },
                },
                required: ['threadId', 'filename'],
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
            name: 'recall_tutor',
            description: 'Look up your tutoring notebook for this person — the assignment you are coaching them on, the brief you built, which section they are on, and the last thing they were stuck on. This is a SEPARATE notebook from your everyday memory: it is your work as their tutor. Use it when the user asks about their essay / assignment / coursework / dissertation / homework / "the writer" / "my tutor", or "what was that question I was stuck on?" — especially when they ask from somewhere other than the writer page, where you would not otherwise see the tutoring thread.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_document',
            description: 'Write a document on the user\'s behalf — Word (.docx, editable) or PDF (finished, ready to print/send) — and return a download link. Use this whenever the user asks for a letter, complaint, formal email, contract, brief, statement, evidence pack, or any other writing they\'ll want to save or send. Compose the full body yourself in the `content` field. Set `format` to "pdf" when the user asks for a PDF or wants a final copy to send/file; otherwise it\'s a Word file they can edit. You can also embed images (Street View shots, photos you found) by passing `image_sources` — they appear after the body with their source captions, ideal for a ticket-appeal evidence pack. Don\'t use this for short replies or notes; just write those in chat.',
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
                    format: {
                        type: 'string',
                        enum: ['word', 'pdf'],
                        description: 'Output format. "word" (.docx, editable) by default; "pdf" for a finished copy to print or send. Use "pdf" when the user asks for a PDF.',
                    },
                    image_sources: {
                        type: 'array',
                        description: 'Optional. Images to embed after the body. Each item: { token } from a previous street_view/search-derived/create result, OR { url } a direct http(s) image link, plus a short `caption` stating what it is and its source (shown in italics under the picture — keep provenance honest for evidence).',
                        items: {
                            type: 'object',
                            properties: {
                                token:   { type: 'string', description: 'Download token from a previous tool result.' },
                                url:     { type: 'string', description: 'Direct http(s) image URL.' },
                                caption: { type: 'string', description: 'Provenance caption, e.g. "Street View, Brick Lane at Hanbury St — current imagery, fetched 18 May 2026".' },
                            },
                        },
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
    // generate_music — RETIRED 2026-08-15 (see retired/2026-08-15-voice-clone-and-music/RETIRED.md)
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
    // speak_as_q — RETIRED 2026-08-15 with the voice-clone plugin it ran on
    // (see retired/2026-08-15-voice-clone-and-music/RETIRED.md)
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
            name: 'update_case_summary',
            description: 'Maintain the case\'s living SUMMARY — the single note that captures the whole case at a glance. Call this whenever you learn or confirm something material (a new fact, date, document, decision, or who-said-what). It REPLACES the one summary note (never makes duplicates), so always pass the FULL updated summary, not just the new bit. Write it in markdown with clear "## " headings — and it MUST include a "## Timeline" section listing key events in date order (e.g. "- 2025-11-26 — Stage 2 response issued"), kept accurate as things develop. This summary is your source of truth and is what lets you work without re-reading every document, so keep it current.',
            parameters: {
                type: 'object',
                properties: {
                    threadId: { type: 'string', description: 'The Thread id.' },
                    content:  { type: 'string', description: 'The COMPLETE updated case summary in markdown — headings, key facts, parties, reference numbers, current status, and a "## Timeline" of dated events. This fully replaces the previous summary.' },
                },
                required: ['threadId', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_threads',
            description: 'List the user\'s saved Threads (situations / cases) — id, title, summary only. Call it ONLY when the user clearly refers back to a past situation you might have saved ("the landlord thing", "that complaint with X", "what happened with the boiler"), so you can match their words to a real case. Do NOT call it on every turn, as a reflex, or on a vague / one-word message — only when they\'re actually pointing at a remembered case. Returns: array of {id, title, summary, status, updatedAt, emailCount}.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_thread',
            description: 'Read the full contents of ONE specific Thread the user has clearly named or pointed at in THIS message. ONLY call it then. Do NOT call it proactively, "to check", or on a vague / short / one-word message (e.g. "council tax", "no nothing", "yes") — pulling in a case the user did not ask about floods the conversation with the wrong case\'s details, makes you lose the thread of what they actually said, and leads you to state facts (names, dates, councils) they never gave. If you are not sure which case they mean — or whether they mean a saved case at all — ASK them; do NOT read one to find out. Returns the complete Thread object.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The Thread id from list_threads.' },
                },
                required: ['id'],
            },
        },
    },
    // ── Finance ────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'read_finance',
            description: "Read the user's complete financial picture from the Finance page — spending summary, top categories, subscriptions, open debt/bill problems, and recent transactions. Call this whenever the user mentions money, bills, subscriptions, spending, debt, or asks anything about their finances. Returns real numbers from their uploaded bank statements.",
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_finance_problem',
            description: "Add a debt, disputed bill, or financial problem to the user's Finance page problem queue. Use this when the user mentions a bill they can't pay, a dispute with a company, a missed payment, or anything they need to actively deal with. Shows up on /finance under their debt queue.",
            parameters: {
                type: 'object',
                properties: {
                    title:    { type: 'string', description: 'Short description, e.g. "Council Tax arrears — £340"' },
                    provider: { type: 'string', description: 'Company or creditor name' },
                    amount:   { type: 'number', description: 'Amount owed in £, if known' },
                    dueDate:  { type: 'string', description: 'Due date as YYYY-MM-DD if there is a deadline' },
                    type:     { type: 'string', enum: ['debt', 'dispute', 'bill', 'subscription', 'other'] },
                    urgency:  { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: 'urgent = bailiffs/cut-off. high = final notice. medium = due soon. low = watch.' },
                    notes:    { type: 'string', description: 'Extra context' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'label_transactions',
            description: "Label the user's bank transactions on the Finance page. Matches transactions by merchant/description text and sets their category and/or a bucket label (a person or purpose like \"Charlie\", \"Car\", \"Business\"). Use when the user asks to tag, label, recategorise or organise specific transactions — e.g. \"mark everything from Netflix as a subscription\" or \"label Tesco as family food\". A bucket set here also applies to future imports of the same merchant.",
            parameters: {
                type: 'object',
                properties: {
                    match:    { type: 'string', description: 'Text to match in the merchant/description, case-insensitive — e.g. "netflix", "tesco"' },
                    category: { type: 'string', enum: ['food_groceries', 'food_dining', 'transport', 'subscriptions', 'utilities', 'housing', 'shopping', 'health', 'children', 'holidays', 'savings_transfer', 'income', 'fees_charges', 'other'], description: 'Category to set on every matching transaction' },
                    bucket:   { type: 'string', description: 'Bucket / person label to put matching transactions under (e.g. "Charlie", "Car"). Also remembered for future imports of this merchant.' },
                },
                required: ['match'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sort_categories',
            description: "Run the automatic category labeller over every transaction on the user's Finance page still marked 'other'. Use when the user asks you to sort, organise or categorise their transactions generally (rather than one specific merchant — use label_transactions for that). Never overwrites categories that are already set.",
            parameters: { type: 'object', properties: {} },
        },
    },
    // ── Push notifications ────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'send_notification',
            description: "Send a push notification — a phone/browser PING ONLY. It does NOT save or add anything: not a task, not a calendar entry, not a list. It just buzzes the user's phone once. Use it ONLY when the user explicitly asks to be pinged/alerted, or when you're firing a scheduled reminder you set up earlier. NEVER use it to 'add a task', 'make a list', 'save a deadline' or 'track' something — those must be saved with add_task (for to-dos) or add_event (for dated things), or the user ends up with a ping and nothing on their list. If they want both, save it first AND then optionally ping.",
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short notification title — like a subject line. Keep it under 60 chars.' },
                    body:  { type: 'string', description: 'Notification message body. Can be slightly longer — 1-2 sentences max.' },
                    url:   { type: 'string', description: 'Optional URL to open when the notification is tapped. Defaults to / (main chat). Use /life for calendar/task reminders, /finance for bill reminders, etc.' },
                },
                required: ['title', 'body'],
            },
        },
    },
    // ── Life admin: calendar + tasks ──────────────────────────────
    {
        type: 'function',
        function: {
            name: 'add_event',
            description: 'Add a dated event (appointment, school trip, meeting, deadline-as-a-moment) to the user\'s calendar on the /life page. Set `repeat` for recurring things (payday, benefits, weekly clubs) — it creates the real dated entries for the months ahead in one call, so you CAN set repeating patterns. Returns what was created.',
            parameters: {
                type: 'object',
                properties: {
                    title:    { type: 'string', description: 'Short event title.' },
                    date:     { type: 'string', description: 'Date as YYYY-MM-DD. For repeats this is the FIRST occurrence.' },
                    time:     { type: 'string', description: 'Time as HH:MM 24h, optional.' },
                    location: { type: 'string', description: 'Where, optional.' },
                    notes:    { type: 'string', description: 'Extra info, optional.' },
                    category: { type: 'string', description: 'Category slug from the user\'s pill row. Defaults are "work", "kids", "home", "health", "money" — they may have added more. Pick the one that fits: a school trip → "kids", a meeting → "work", a bill → "money", a dentist appt → "health". Optional.' },
                    repeat:   { type: 'string', enum: ['weekly', 'fortnightly', 'monthly', 'last_weekday'], description: 'Repeat pattern, optional. weekly/fortnightly = same weekday as `date`; monthly = same day of month; last_weekday = the LAST <weekday-of-`date`> of each month (e.g. `date` on a Friday → last Friday of every month, common for benefits/pay).' },
                    months:   { type: 'number', description: 'How many months ahead to fill for a repeat (1–12, default 6).' },
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
            description: 'Add a to-do task to the user\'s task list. This PERSISTS it and it shows on /life and on the Tasks drawer in the main chat — this is the ONLY tool that actually puts something on their list. This is THE tool for "add a task", "put X on my list", "make me a list of…", "save this deadline as a to-do", "remind me to…", "I need to…", or anything actionable. Call it ONCE PER TASK — three tasks = three add_task calls. NEVER use send_notification to add a task (that only pings, it saves nothing). Only add what the user actually named — do not invent extra tasks. Break a bigger job into subtasks. Set alertAt when they mention a time to be reminded. Set contact when the task is "call X". Pick the category the user asks for; if none, leave it default — do not guess "money"/etc.',
            parameters: {
                type: 'object',
                properties: {
                    title:    { type: 'string', description: 'Short imperative title — "Bring PE kit", "Pay the trip fee".' },
                    due:      { type: 'string', description: 'Due date YYYY-MM-DD, optional.' },
                    priority: { type: 'string', enum: ['low', 'med', 'high'], description: 'Priority. Default med.' },
                    notes:    { type: 'string', description: 'Extra info, optional.' },
                    category: { type: 'string', description: 'Category slug from the user\'s pill row. Defaults are "work", "kids", "home", "health", "money" — they may have added more. Pick the fit: "Bring PE kit" → "kids", "Pay invoice" → "money". Optional.' },
                    subtasks: {
                        type: 'array',
                        description: 'Sub-checklist for the task. Use when the user describes a multi-step job. Each subtask is { text }.',
                        items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
                    },
                    alertAt: { type: 'string', description: 'When to remind the user — ISO datetime e.g. "2026-05-20T14:30:00". Optional. Only set if the user said when.' },
                    contact: {
                        type: 'object',
                        description: 'Person or business to call. Set when task is "call X" or "ring Y". Phone format flexible.',
                        properties: {
                            name:  { type: 'string' },
                            phone: { type: 'string' },
                            email: { type: 'string' },
                        },
                    },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_tasks',
            description: 'List the user\'s tasks. Every task comes back with whether it is OVERDUE and by how many days, plus due today / due tomorrow. Lead with the overdue ones — that is the thing they cannot see for themselves. Use filter:"overdue" when they ask what is late or what they have let slip, and filter:"today" for what needs doing today. Do not read the whole list out unless they asked for the whole list; if they sound stuck or overwhelmed, use get_next_action instead and give them one thing.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['open', 'done'], description: 'Filter. Default open.' },
                    filter: { type: 'string', enum: ['overdue', 'today'], description: '"overdue" = only what is past its due date. "today" = due today plus anything already late. Omit for everything open.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_task',
            description: 'CHANGE something about a task that already exists — its category, priority, due date, title, notes, reminder or contact. Use this whenever they want a task altered, and especially when reorganising or recategorising a list. Do NOT make a new task and complete the old one instead: that throws away its notes and sub-steps. Only say a task has been changed if this comes back ok — never report a reorganisation as done when you have only grouped things in your reply.',
            parameters: {
                type: 'object',
                properties: {
                    id:       { type: 'string', description: 'The task id, from list_tasks.' },
                    title:    { type: 'string', description: 'New title.' },
                    due:      { type: 'string', description: 'New due date YYYY-MM-DD, or null to clear it.' },
                    priority: { type: 'string', enum: ['low', 'med', 'high'], description: 'New priority.' },
                    category: { type: 'string', description: 'New category slug — this is the one for reorganising a list.' },
                    notes:    { type: 'string', description: 'New notes (replaces what is there).' },
                    alertAt:  { type: 'string', description: 'New reminder time, ISO datetime.' },
                },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_task',
            description: 'Remove a task from the list ENTIRELY. Done is not the same as gone — a passed event, a duplicate or something that was never really a job should leave the list, not sit ticked forever. THIS CANNOT BE UNDONE, so only delete what they have actually asked you to delete: if you are working from a list you drew up yourself, read it back and get a yes before you start. When in doubt, complete it instead.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'The task id, from list_tasks.' } },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'bulk_tasks',
            description: 'Tick off or delete SEVERAL tasks in one go. Use it when clearing out a long list — passed events, duplicates, things done weeks ago. One at a time is fine for three tasks and punishing for ninety. Deleting is permanent: read the list back to them and get a yes before deleting anything you selected yourself. Confirm with the number afterwards, not the whole list.',
            parameters: {
                type: 'object',
                properties: {
                    ids:    { type: 'array', items: { type: 'string' }, description: 'Task ids from list_tasks.' },
                    action: { type: 'string', enum: ['complete', 'delete'], description: '"complete" ticks them off, "delete" removes them permanently.' },
                },
                required: ['ids', 'action'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'merge_tasks',
            description: 'Fold duplicate tasks into one. "Call CMS" listed twice is one job, and ticking off one of them leaves the other pretending to be work. The task you keep gets the others\' notes and sub-steps folded into it and the earliest due date, then the duplicates are removed — so nothing they were carrying is lost.',
            parameters: {
                type: 'object',
                properties: {
                    keep_id:   { type: 'string', description: 'The task to keep.' },
                    merge_ids: { type: 'array', items: { type: 'string' }, description: 'The duplicates to fold in and remove.' },
                },
                required: ['keep_id', 'merge_ids'],
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
            description: 'Append ONE fact to the user\'s "About you" filter on /life. NARROW SCOPE: only facts that change WHICH ITEMS get pulled out when reading a school letter / forwarded email / pasted notice. Allowed: kids\' year groups + schools, household allergies, dietary requirements, work pattern, who lives in the house. NOT for: birthday, name, partner\'s name, where they live, preferences, projects, deadlines — those go through `remember`. Always ask first (warm, name the /life benefit, yes/no), never call silently.',
            parameters: {
                type: 'object',
                properties: {
                    addition: { type: 'string', description: 'The new fact to append. Short, declarative, third-person where natural ("Daughter in Year 9 at Park High"; "Works Mon–Thu"; "Nut allergy in the house"). One fact per call.' },
                },
                required: ['addition'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'build_call_qr',
            description: 'Build a CALL / DIAL QR — a QR code that, when scanned with a phone camera, offers to RING that number. It is a `tel:` QR: scanning it dials. Use it WHENEVER the user wants a QR to phone / call / ring someone, or a scan-to-call code to print, stick on a job sheet, put on a card or send to someone ("give me a QR to call Dave", "QR for the plumber\'s number", "scan-to-call code"). Pass the real number — never invent one; use the number the user gave you, or one already in the conversation / a task\'s contact.',
            parameters: {
                type: 'object',
                properties: {
                    phone: { type: 'string', description: 'The phone number the QR should dial. Use the real number the user gave you or one already in the conversation — never make one up.' },
                    name: { type: 'string', description: 'Optional — who the number belongs to, for the caption (e.g. "Dave the plumber").' },
                },
                required: ['phone'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'build_whatsapp_qr',
            description: 'Build a WHATSAPP QR — a QR code that, when scanned with a phone camera, OPENS WHATSAPP with a chat ready and your message already typed in the box. Use it whenever the user wants to WhatsApp someone, send a WhatsApp, or wants a scannable code that starts a WhatsApp chat ("WhatsApp Dave the materials list", "give me a WhatsApp QR for the site", "send this to the group on WhatsApp"). Give `phone` to open a chat with a specific person; leave it out and the scan opens WhatsApp so they pick who gets it. IMPORTANT and you must say this: it carries TEXT ONLY — WhatsApp\'s link cannot attach a photo, a PDF or a quote, so never imply a file rides along. Never invent a phone number; use the one the user gave you or one already in the conversation.',
            parameters: {
                type: 'object',
                properties: {
                    phone: { type: 'string', description: 'Optional — the number to open the WhatsApp chat with. Use the real number the user gave you or one already in the conversation; never make one up. Omit it to produce a "pick a contact" QR.' },
                    message: { type: 'string', description: 'The message pre-typed into WhatsApp, ready to send. Write it properly — this is what the person actually receives.' },
                    name: { type: 'string', description: 'Optional — who the number belongs to, for the caption (e.g. "Dave the plumber").' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'build_email_qr',
            description: 'Build an EMAIL QR — a `mailto:` QR. Scanning it with a phone camera opens a new email to that address, with the subject and message already written, ready to send. The third of the three contact QRs (the others are build_call_qr for dialling and build_whatsapp_qr for WhatsApp). Use it whenever the user wants a QR to email someone, or a scannable code that hands an email over to whoever scans it. Never invent an address; use the one the user gave you or one already in the conversation.',
            parameters: {
                type: 'object',
                properties: {
                    email: { type: 'string', description: 'The address the email opens to. A real one from the conversation — never made up.' },
                    subject: { type: 'string', description: 'Optional — the subject line, pre-filled.' },
                    body: { type: 'string', description: 'Optional — the message, pre-written in full. Write it properly; this is what actually gets sent.' },
                    name: { type: 'string', description: 'Optional — whose address it is, for the caption.' },
                },
                required: ['email'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'build_link_qr',
            description: 'Build a LINK QR — a QR code that, when scanned with a phone camera, OPENS THAT WEB ADDRESS in the browser. The fourth QR kind (the others dial, WhatsApp and email). Use it whenever the user wants a QR for a website, page, advert, listing, review link, booking link, form, map location, video — any URL ("QR for my website", "QR that opens the advert", "make this link scannable"). Pass the real link — never invent one; use the URL the user gave you, one already in the conversation, or one you just found with web_search and confirmed.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The web address the QR opens. A real, full URL from the user or the conversation — never made up. If they gave a bare domain like quotem.co.uk, https:// is added automatically.' },
                    label: { type: 'string', description: 'Optional — what the link is, for the caption (e.g. "the flat advert", "our reviews page").' },
                },
                required: ['url'],
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
    // When a search fails or returns nothing, Q must SAY SO — never answer from
    // memory as if he'd searched. This note rides back with the error so the
    // model is told exactly that (same pattern as search_images / street_view).
    const FAIL_NOTE = "The web search did NOT return results. Tell the user plainly you couldn't look it up just now — do NOT answer from your own memory as if you had searched — and offer to try again.";
    const apiKey = process.env.BRAVE_SEARCH_KEY;
    if (!apiKey) {
        console.warn('[q-tools] web_search FAILED: BRAVE_SEARCH_KEY not configured');
        return { error: 'BRAVE_SEARCH_KEY not configured', instruction_for_q: FAIL_NOTE };
    }
    if (!query || typeof query !== 'string') {
        return { error: 'Query string required', instruction_for_q: FAIL_NOTE };
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
            console.warn(`[q-tools] web_search FAILED: Brave HTTP ${response.status} for "${query}" — ${errText.substring(0, 200)}`);
            return { error: `Brave Search HTTP ${response.status}: ${errText.substring(0, 200)}`, instruction_for_q: FAIL_NOTE };
        }
        const data = await response.json();
        const results = (data.web?.results || []).slice(0, safeCount).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
        }));
        if (results.length === 0) {
            console.warn(`[q-tools] web_search: 0 results for "${query}"`);
            return { query, results: [], count: 0, instruction_for_q: "The search returned NO results. Tell the user you couldn't find anything on that — do NOT fill the gap from your own memory." };
        }
        console.log(`[q-tools] web_search OK: ${results.length} result(s) for "${query}"`);
        return { query, results, count: results.length };
    } catch (err) {
        console.warn('[q-tools] web_search FAILED (network): ' + err.message);
        return { error: err.message, instruction_for_q: FAIL_NOTE };
    }
}

/**
 * search_images — Brave image search. Same key + auth as web_search.
 * User-facing errors stay generic (no provider name — house rule).
 */
async function searchImages({ query, count = 6 }) {
    const apiKey = process.env.BRAVE_SEARCH_KEY;
    if (!apiKey) {
        return {
            error: 'image search unavailable',
            instruction_for_q: "Image search isn't switched on yet. Tell the user plainly, don't name any provider, and carry on with the rest of what they asked.",
        };
    }
    if (!query || typeof query !== 'string') {
        return { error: 'Query string required' };
    }
    const safeCount = Math.min(Math.max(parseInt(count) || 6, 1), 10);
    const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${safeCount}&country=gb&search_lang=en&safesearch=strict`;
    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': apiKey,
            },
        });
        if (!response.ok) {
            console.warn(`[search_images] HTTP ${response.status}`);
            return { error: 'image search unavailable', instruction_for_q: "The image search didn't come back. Tell the user plainly (no provider names) and offer to try a different wording." };
        }
        const data = await response.json();
        const results = (data.results || []).slice(0, safeCount).map(r => ({
            title: r.title || '',
            thumbnail: r.thumbnail?.src || '',
            image: r.properties?.url || r.thumbnail?.src || '',
            sourcePage: r.url || '',
        })).filter(r => r.image);
        return {
            query,
            results,
            count: results.length,
            instruction_for_q: results.length
                ? 'Show the user these as inline markdown images (![title](image)) with the source page linked under each. Then, if this is for a case/dispute, offer to file the relevant ones onto the Thread with add_file_to_thread so they live in the case.'
                : 'No images found for that query. Say so plainly and suggest a more specific wording.',
        };
    } catch (err) {
        console.warn('[search_images] error:', err.message);
        return { error: 'image search unavailable', instruction_for_q: "Image search hit a problem. Tell the user plainly without naming any provider." };
    }
}

/**
 * Fetch a remote image/PDF as a Buffer for filing/embedding. Locked to
 * http(s), capped at 12 MB so a hostile URL can't exhaust memory.
 */
async function fetchRemoteBinary(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) {
        return { error: 'Only http(s) URLs can be fetched.' };
    }
    try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) return { error: `Could not fetch the file (HTTP ${res.status}).` };
        const len = parseInt(res.headers.get('content-length') || '0', 10);
        if (len && len > 12 * 1024 * 1024) return { error: 'That file is too large (over 12 MB).' };
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > 12 * 1024 * 1024) return { error: 'That file is too large (over 12 MB).' };
        const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
        return { buffer: buf, mimeType };
    } catch (e) {
        return { error: 'Could not fetch the file: ' + e.message };
    }
}

/**
 * street_view — Google Street View Static API. Key lives in the
 * quotem-ai deployment env (GOOGLE_MAPS_KEY); the Quotem tools-and-keys
 * page only registers/tracks it. Honest limitation, surfaced to Q: the
 * Static API returns CURRENT imagery only — there is no past-date
 * parameter, so this corroborates signage/layout, it is not dated proof
 * of a specific day. Metadata is checked first (free) so we never stash
 * a "no imagery here" grey tile.
 */
async function streetView({ location, lat, lng, heading, pitch } = {}, personEmail) {
    // DEV_QUEUE #9: the code read GOOGLE_MAPS_KEY but the Railway env carried
    // GOOGLE_PLACES_KEY, so the tool stayed dark. Accept both — the Street
    // View Static API and Places share one Maps Platform key. GOOGLE_MAPS_KEY
    // is preferred (it is the name documented in .env.example).
    const apiKey = process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_PLACES_KEY;
    if (!apiKey) {
        return {
            error: 'road imagery not enabled',
            instruction_for_q: "The road-imagery feature isn't switched on yet (it needs a key adding on the tools-and-keys page). Tell the user plainly, don't name any provider, and keep going with the rest of the case — the photos can be added once it's enabled.",
        };
    }
    if (!personEmail) return { error: 'Cannot fetch imagery without a signed-in user.' };
    const hasLatLng = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    if (!location && !hasLatLng) {
        return { error: 'Give either a location (address/place) or lat + lng.' };
    }
    const loc = hasLatLng ? `${Number(lat)},${Number(lng)}` : String(location);
    const locParam = `location=${encodeURIComponent(loc)}`;
    try {
        // 1. Free metadata check — does Street View imagery exist here?
        const metaRes = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${locParam}&key=${apiKey}`);
        const meta = await metaRes.json().catch(() => ({}));
        if (meta.status !== 'OK') {
            return {
                error: 'no street imagery',
                detail: meta.status || 'unknown',
                instruction_for_q: "There's no street-level imagery for that exact spot. Tell the user, and suggest trying a nearby address or the junction by name.",
            };
        }
        // 2. Fetch the actual view.
        const params = [
            'size=640x640',
            locParam,
            heading != null ? `heading=${parseInt(heading)}` : '',
            `pitch=${pitch != null ? parseInt(pitch) : 0}`,
            'fov=80',
            `key=${apiKey}`,
        ].filter(Boolean).join('&');
        const imgRes = await fetch(`https://maps.googleapis.com/maps/api/streetview?${params}`);
        if (!imgRes.ok) {
            console.warn(`[street_view] image HTTP ${imgRes.status}`);
            return { error: 'road imagery unavailable', instruction_for_q: "Couldn't pull the street image just now. Tell the user plainly (no provider names) and offer to retry." };
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const label = (hasLatLng ? `streetview-${lat}-${lng}` : `streetview-${loc}`).slice(0, 60);
        const stashed = stashFile(buf, 'jpg', label, personEmail);
        const dlUrl = '/download/' + stashed.token;
        const capturedDate = meta.date ? ` Imagery captured around ${meta.date}.` : '';
        return {
            ok: true,
            filename: stashed.filename,
            token: stashed.token,
            downloadUrl: dlUrl,
            location: loc,
            captured: meta.date || null,
            instruction_for_q: `Show the image inline: ![Street view of ${loc}](${dlUrl}). State clearly this is the CURRENT view of that location (not how it looked on a past date) — it shows the general signage/road layout.${capturedDate} Then offer to file it onto the case Thread with add_file_to_thread (token: ${stashed.token}) so it's in the case, and remind the user the dated proof for a specific day would need the council's own records.`,
        };
    } catch (err) {
        console.warn('[street_view] error:', err.message);
        return { error: 'road imagery unavailable', instruction_for_q: "The road-imagery lookup hit a problem. Tell the user plainly without naming any provider." };
    }
}

/**
 * build_call_qr — a `tel:` QR. Scanning it with a phone camera offers to
 * DIAL the number. Same capability QB2 has in Quotem (wa-share.buildCallShare),
 * built here on Q's own QR plugin so he can hand one back inside a reply.
 * The PNG is stashed like every other generated file, so Q shows it inline
 * with markdown and the user can tap it to save or print.
 */
async function callQrTool({ phone, name } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot build a QR without a signed-in user.' };
    if (!phone) {
        return {
            error: 'no number',
            instruction_for_q: 'Ask the user which number the QR should dial — do NOT guess or invent a number.',
        };
    }
    try {
        const { buildCallQr } = require('./q-qr');
        const r = await buildCallQr({ phone, name });
        if (!r.ok) {
            return {
                error: r.error,
                instruction_for_q: "That doesn't look like a usable phone number. Ask the user to give it again — don't invent one.",
            };
        }
        const stashed = stashFile(r.png, 'png', `call-qr-${(name || r.number)}`, personEmail);
        const dlUrl = '/download/' + stashed.token;
        const who = name ? ` for ${name}` : '';
        return {
            ok: true,
            filename: stashed.filename,
            token: stashed.token,
            downloadUrl: dlUrl,
            number: r.number,
            telUri: r.telUri,
            instruction_for_q: `Call QR ready${who}. Show it inline exactly like this: ![Call QR](${dlUrl}) — then say in one line that scanning it with a phone camera offers to dial ${r.number}, and that tapping the number dials it straight away. Don't describe the QR, just show it.`,
        };
    } catch (e) {
        console.warn('[build_call_qr] error:', e.message);
        return { error: 'qr failed', instruction_for_q: "The QR couldn't be drawn just now. Tell the user plainly and offer to try again." };
    }
}

/**
 * build_whatsapp_qr — a `wa.me` QR. Scanning it opens WhatsApp with the chat
 * ready and the message already typed. Same deep link QB2 uses in Quotem
 * (wa-share.js), built here on Q's own QR plugin.
 *
 * TEXT ONLY: wa.me cannot carry an attachment. The instruction_for_q below
 * makes Q say that out loud rather than let the user assume a quote or a
 * photo goes with it.
 */
async function whatsappQrTool({ phone, message, name } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot build a QR without a signed-in user.' };
    if (!phone && !message) {
        return {
            error: 'nothing to send',
            instruction_for_q: 'Ask the user who the WhatsApp is for and what it should say — do NOT guess a number or invent the message.',
        };
    }
    try {
        const { buildWhatsappQr } = require('./q-qr');
        const r = await buildWhatsappQr({ phone, message, name });
        if (!r.ok) {
            return {
                error: r.error,
                instruction_for_q: "That doesn't look like a usable WhatsApp number. Ask the user to give it again — don't invent one.",
            };
        }
        const stashed = stashFile(r.png, 'png', `whatsapp-qr-${(name || r.number || 'message')}`, personEmail);
        const dlUrl = '/download/' + stashed.token;
        const who = r.number ? `+${r.number}` : 'whoever they choose';
        return {
            ok: true,
            filename: stashed.filename,
            token: stashed.token,
            downloadUrl: dlUrl,
            number: r.number,
            url: r.url,
            message: r.message,
            instruction_for_q: `WhatsApp QR ready. Show it inline exactly like this: ![WhatsApp QR](${dlUrl}) — then say in one line that scanning it opens WhatsApp to ${who} with the message already typed, ready to send. If they asked for a file, quote or photo to go with it, tell them plainly that a WhatsApp link carries text only and they'll need to attach it inside WhatsApp. Don't describe the QR, just show it.`,
        };
    } catch (e) {
        console.warn('[build_whatsapp_qr] error:', e.message);
        return { error: 'qr failed', instruction_for_q: "The QR couldn't be drawn just now. Tell the user plainly and offer to try again." };
    }
}

/**
 * build_email_qr — a `mailto:` QR. Scanning it opens a new email to that
 * address with the subject and body already written. The third mode of the
 * Quotem contact QR (FloatingTodoPanel: mailto / wa.me / tel), same URI
 * shape so the two apps behave identically.
 */
async function emailQrTool({ email, subject, body, name } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot build a QR without a signed-in user.' };
    const to = String(email || '').trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return {
            error: 'no address',
            instruction_for_q: 'Ask the user which email address the QR should write to — do NOT invent one.',
        };
    }
    try {
        const { buildQrPng } = require('./q-qr');
        const params = [];
        if (subject) params.push('subject=' + encodeURIComponent(subject));
        if (body) params.push('body=' + encodeURIComponent(body));
        const mailto = `mailto:${to}${params.length ? '?' + params.join('&') : ''}`;
        const png = await buildQrPng(mailto);
        const stashed = stashFile(png, 'png', `email-qr-${(name || to)}`, personEmail);
        const dlUrl = '/download/' + stashed.token;
        const who = name ? `${name} (${to})` : to;
        return {
            ok: true,
            filename: stashed.filename,
            token: stashed.token,
            downloadUrl: dlUrl,
            mailto,
            address: to,
            instruction_for_q: `Email QR ready. Show it inline exactly like this: ![Email QR](${dlUrl}) — then say in one line that scanning it opens a new email to ${who}${subject ? ` with the subject "${subject}"` : ''}${body ? ' and the message already written' : ''}, ready to send. Don't describe the QR, just show it.`,
        };
    } catch (e) {
        console.warn('[build_email_qr] error:', e.message);
        return { error: 'qr failed', instruction_for_q: "The QR couldn't be drawn just now. Tell the user plainly and offer to try again." };
    }
}

/**
 * build_link_qr — a plain URL QR. Scanning it opens the address in the
 * phone's browser. The kind people mean most often by "a QR code" — for an
 * advert, a reviews page, a booking link, a form — and the one kind Q
 * didn't have (only call / WhatsApp / email existed, so "QR for my website"
 * left him tool-less — Sarah, 11 Aug).
 */
async function linkQrTool({ url, label } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot build a QR without a signed-in user.' };
    let addr = String(url || '').trim();
    if (!addr) {
        return {
            error: 'no url',
            instruction_for_q: 'Ask the user which link the QR should open — do NOT invent one.',
        };
    }
    // A bare domain is fine — give it a scheme. Anything that still doesn't
    // parse as http(s) is refused rather than encoded wrong.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(addr)) addr = 'https://' + addr;
    try {
        const u = new URL(addr);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not a web link');
    } catch {
        return {
            error: 'bad url',
            instruction_for_q: 'That does not look like a usable web address. Ask the user to give the link exactly as it appears in the browser bar.',
        };
    }
    try {
        const { buildQrPng } = require('./q-qr');
        const png = await buildQrPng(addr);
        const stashed = stashFile(png, 'png', `link-qr-${(label || 'link')}`, personEmail);
        const dlUrl = '/download/' + stashed.token;
        const what = label ? `${label} (${addr})` : addr;
        return {
            ok: true,
            filename: stashed.filename,
            token: stashed.token,
            downloadUrl: dlUrl,
            url: addr,
            instruction_for_q: `Link QR ready. Show it inline exactly like this: ![Link QR](${dlUrl}) — then say in one line that scanning it opens ${what} in the browser. Don't describe the QR, just show it.`,
        };
    } catch (e) {
        console.warn('[build_link_qr] error:', e.message);
        return { error: 'qr failed', instruction_for_q: "The QR couldn't be drawn just now. Tell the user plainly and offer to try again." };
    }
}

/**
 * add_file_to_thread — put a file into a case Thread's folder. Source is
 * EITHER a per-user download token (resolved only inside this user's own
 * generated dir — no cross-user reach) OR a fetched http(s) URL. The
 * Thread is ownership-checked first, exactly like the other thread tools.
 */
async function addFileToThread({ threadId, token, url, filename, note } = {}, personEmail) {
    if (!threadId) return { error: 'threadId is required' };
    if (!filename) return { error: 'filename is required' };
    if (!token && !url) return { error: 'Give either a token or a url for the file.' };
    if (!personEmail) return { error: 'Cannot mutate a thread without a signed-in user.' };

    // Ownership check — only the owner can attach to a Thread.
    const owned = qThreads.readThread(threadId, personEmail);
    if (!owned) return { error: 'Thread not found: ' + threadId };

    let buf, mimeType = 'application/octet-stream';
    if (token) {
        const resolved = resolveToken(token, personEmail); // per-user scoped
        if (!resolved) return { error: 'That file token is not valid for you (or has expired).' };
        try { buf = fs.readFileSync(resolved.fullPath); }
        catch { return { error: 'Could not read that stored file.' }; }
    } else {
        const fetched = await fetchRemoteBinary(url);
        if (fetched.error) return { error: fetched.error };
        buf = fetched.buffer;
        mimeType = fetched.mimeType || mimeType;
    }

    const safeName = String(filename).replace(/[\\/]/g, '_').slice(0, 200) || 'file';
    const updated = qThreads.addFile(
        threadId,
        { filename: safeName, mimeType, base64: buf.toString('base64') },
        personEmail,
    );
    if (!updated) return { error: 'Could not add the file to the Thread.' };
    if (note && String(note).trim()) {
        qThreads.addNote(threadId, { content: String(note).trim(), kind: 'evidence' }, personEmail);
    }
    return {
        ok: true,
        threadId: updated.id,
        filename: safeName,
        fileCount: (updated.files || []).length,
        instruction_for_q: 'Filed onto the case Thread. Confirm briefly what was added and that it lives in the case folder now, then propose the next concrete move on the case.',
    };
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
 * analyze_document — vision via Q_CONFIG.visionModel on Together AI.
 * Q is text-only, so this is his eyes. Same Together API key as Q himself.
 *
 * For form-field detection, we prompt the vision model to return structured JSON
 * with bounding boxes in normalised 0-1000 coordinates.
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

    const started = Date.now();
    try {
        const response = await timedFetch(`${Q_CONFIG.baseURL}/chat/completions`, {
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
        }, { label: 'document reader' });

        if (!response.ok) {
            const errText = await response.text();
            logUsage({ skill: 'analyze-document', provider: 'together', model: Q_CONFIG.visionModel, started, success: false, error: `HTTP ${response.status}` });
            return { error: `Vision model HTTP ${response.status}: ${errText.substring(0, 200)}` };
        }

        const data = await response.json();
        logUsage({ skill: 'analyze-document', provider: 'together', model: Q_CONFIG.visionModel, data, started });
        const msg = data.choices?.[0]?.message || {};
        // Thinking-mode quirk on Together (Kimi K2.5 / V4 Pro): the answer
        // sometimes lands in reasoning_content/reasoning with content empty.
        // Mirror the fallback in q-chat.js / q-finance.js.
        const rawContent = (msg.content && msg.content.trim())
            ? msg.content
            : (msg.reasoning_content || msg.reasoning || '');
        const content = cleanModelOutput(rawContent, 'analyze-document');

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

// Fetch a form PDF from a URL and save it to the thread.
async function fetchFormTool(args, personEmail, threadId) {
    const { url, filename, note } = args || {};
    if (!url || !/^https?:\/\//i.test(url)) return { error: 'A valid https:// URL is required.' };
    if (!threadId) return { error: 'This tool only works inside a Thread.' };
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timeout);
        if (!resp.ok) return { error: `Could not download the form — the server returned ${resp.status}. Try a different URL.` };
        const ct = (resp.headers.get('content-type') || '').split(';')[0].trim() || 'application/pdf';
        const buf = Buffer.from(await resp.arrayBuffer());
        // Guard against saving non-PDF content as a form. GOV.UK and others can
        // return a cookie/consent page, a redirect, or an error page with a 200 —
        // that would be stored as a .pdf that fails to render ("Invalid PDF
        // structure"). A real PDF starts with the "%PDF-" signature; if it
        // doesn't, refuse and tell Q the link was wrong rather than save junk.
        if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
            const sniff = buf.slice(0, 200).toString('latin1').toLowerCase();
            const looksHtml = sniff.includes('<html') || sniff.includes('<!doctype');
            return { error: looksHtml
                ? 'That link returned a web page, not the form PDF itself. Find the direct PDF download link (it ends in .pdf and opens as a PDF in the browser) and use that.'
                : 'That link did not return a valid PDF. Use the direct PDF download URL for the form.' };
        }
        let name = filename || '';
        if (!name) {
            const cd = resp.headers.get('content-disposition') || '';
            const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
            name = m ? decodeURIComponent(m[1].trim()) : (url.split('?')[0].split('/').filter(Boolean).pop() || 'form.pdf');
            if (!name.includes('.') && ct.includes('pdf')) name += '.pdf';
        }
        const base64 = buf.toString('base64');
        const qThreads = require('./q-threads');
        console.log(`[fetch_form] downloading ${url} → "${name}" (${buf.length} bytes) for thread ${threadId}`);
        const updated = qThreads.addFile(threadId, { filename: name, mimeType: ct, base64 }, personEmail);
        if (!updated) return { error: 'Could not save the form to this thread.' };
        if (note) qThreads.addNote(threadId, { content: `📋 ${note}`, kind: 'form-note' }, personEmail);
        return {
            ok: true,
            filename: name,
            sizeKb: Math.round(buf.length / 1024),
            instruction_for_q: `Form saved as "${name}" (${Math.round(buf.length / 1024)} KB). Tell the user it is now in their Files section. They should open the Forms panel (top right of the thread page) and select it from the dropdown to fill it in. Briefly explain what fields they will need to complete based on what you know about the case.`,
        };
    } catch (e) {
        return { error: e.name === 'AbortError' ? 'Timed out — the form server did not respond in time.' : `Download failed: ${e.message}` };
    }
}

// ─────────────────────────────────────────────────────────────
//  DISPATCHER
// ─────────────────────────────────────────────────────────────

/**
 * Execute a tool by name with its arguments. Always returns an object —
 * never throws. Errors are returned as { error: '...' } so Q sees them.
 */
const qEmailAccounts = require('./q-email-accounts');

// Save a drafted email to the user's outbox (no send — just parks it for review).
// If args.draft_id is provided, patches the existing item rather than adding a new one.
function saveEmailDraftTool(args, personEmail, threadId) {
    if (!personEmail) return { error: 'Cannot save draft without a signed-in user.' };
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '').trim();
    if (!subject && !body) return { error: 'Need at least a subject or body to save a draft.' };
    const to = String(args.to || '').trim();
    try {
        const existingId = args.draft_id ? String(args.draft_id).trim() : null;
        if (existingId) {
            const patched = qEmailAccounts.patchOutboxItem(personEmail, existingId, { to, subject, body });
            if (patched) {
                return {
                    ok: true,
                    draftId: existingId,
                    instruction_for_q: 'Draft updated in the Outbox. Tell the user the draft has been revised — they can scroll down to the Outbox and send when ready. Do NOT create another draft. Do NOT mention the Email Writer page.',
                };
            }
            // id not found — fall through and create fresh
        }
        // Convert filename list to thread refs so the server can resolve at send time.
        const threadRefs = Array.isArray(args.attachments) && args.attachments.length && threadId
            ? args.attachments.map(f => ({ filename: String(f), threadRef: true, threadId }))
            : undefined;
        const item = qEmailAccounts.addToOutbox(personEmail, { to, subject, body, threadId: threadId || null, attachments: threadRefs });
        return {
            ok: true,
            draftId: item.id,
            instruction_for_q: `Draft saved to the Outbox. Tell the user it is in the Outbox section of THIS thread — they can scroll down, review it, and send with one click. IMPORTANT: remember draftId "${item.id}" — pass it as draft_id if you revise this email so it updates the same item rather than creating a duplicate. Do NOT mention the Email Writer page.`,
        };
    } catch (e) {
        return { error: e.message || 'Could not save draft.' };
    }
}

// Send an email from the user's own connected account (Gmail/SMTP).
async function sendEmailTool(args, personEmail, threadId) {
    if (!personEmail) return { error: 'Cannot send email without a signed-in user.' };
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = args.body || args.text || '';
    if (!to || !subject) return { error: 'Need a recipient (to) and a subject to send an email.' };
    const qThreads = require('./q-threads');
    // Read any requested thread-file attachments.
    const attachments = [];
    if (Array.isArray(args.attachments) && args.attachments.length && threadId) {
        for (const filename of args.attachments) {
            try {
                const file = qThreads.readFile(threadId, String(filename), personEmail);
                if (file && file.buffer) {
                    attachments.push({ filename: file.filename || filename, base64: file.buffer.toString('base64'), mimeType: file.mimeType || 'application/octet-stream' });
                }
            } catch (e) { console.warn('[send_email] attachment read failed:', filename, e.message); }
        }
    }
    try {
        const from = await qEmailAccounts.sendEmail(personEmail, { to, subject, text: body, attachments });
        // Remove the matching outbox draft so it doesn't linger after sending.
        const draftId = args.draft_id ? String(args.draft_id).trim() : null;
        if (draftId) {
            try { qEmailAccounts.removeFromOutbox(personEmail, draftId); } catch { /* not critical */ }
        } else if (threadId) {
            // No draft_id — remove any outbox item in this thread with the same subject.
            try {
                const all = qEmailAccounts.getOutbox(personEmail);
                const match = all.find(x => x.threadId === threadId && x.subject === subject);
                if (match) qEmailAccounts.removeFromOutbox(personEmail, match.id);
            } catch { /* not critical */ }
        }
        // Record the sent email in the thread's Correspondence section.
        if (threadId) {
            try {
                qThreads.addEmail(threadId, {
                    type: 'out', from: from || personEmail,
                    to, subject, body,
                    date: new Date().toISOString().slice(0, 10),
                }, personEmail);
            } catch (e) { console.error('[send_email] addEmail failed:', e.message); }
        }
        return {
            ok: true,
            sentFrom: from || 'your connected account',
            instruction_for_q: `Email sent to ${to} from the user's own account${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}. The draft has been removed from the outbox. It is now in the Correspondence section of this thread. Confirm briefly that it's sent — do not paste the whole email back.`,
        };
    } catch (e) {
        if (e.code === 'not_connected') {
            return { error: 'no_email_connected', instruction_for_q: 'No email account is connected yet. Tell the user to connect their email first (Connect email on the Tools page), then ask you to send again.' };
        }
        return { error: 'send_failed', instruction_for_q: 'The email could not be sent — the connection may need reconnecting. Tell the user briefly; do NOT retry automatically.' };
    }
}

async function executeTool(name, argsRaw, personId, personEmail, threadId) {
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
    // Thread tools act on the CURRENT case. Inject its id so they work even when
    // the model omits it (it doesn't always know the raw thread id). An explicit
    // id from the model still wins (e.g. cross-case reads).
    if (threadId && !args.threadId) args.threadId = threadId;
    // ── writer coach tools ─────────────────────────────────────────────
    if (name === 'highlight_passage') {
        // Nothing to do server-side: the PAGE paints it. The call itself is the
        // result — the client reads it out of toolCalls and paints + dots it.
        const text = String(args.text || '').replace(/\s+/g, ' ').trim();
        if (!text) return { error: 'No passage given.' };
        return { ok: true, painted: true, text: text.slice(0, 600), note: String(args.note || '').trim().slice(0, 400), kind: String(args.kind || 'note'), colour: String(args.colour || '') };
    }
    if (name === 'tab_paragraph') {
        const pn = Number(args.paragraph);
        const text = String(args.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!text && (!Number.isInteger(pn) || pn < 1)) return { error: 'Give the paragraph number (1-based) or the exact words on the line.' };
        const base = { ok: true, tabbed: true, label: String(args.label || '').trim().slice(0, 40) || 'note', colour: String(args.colour || 'grey') };
        if (text) return { ...base, text, side: 'top' };   // stands ON the line, colour on top (Sarah, 18 Aug: 'if it's inside the colour goes on the top not the side')
        return { ...base, paragraph: pn, side: ['right', 'left', 'top'].includes(String(args.side || '')) ? String(args.side) : 'right' };
    }
    if (name === 'stick_note') {
        const text = String(args.text || '').trim().slice(0, 160);
        if (!text) return { error: 'The sticky needs some text.' };
        return { ok: true, stuck: true, text, colour: String(args.colour || 'yellow') };
    }
    // Q'S OWN NOTES ON THE TEACHING BOARD (Sarah, 19 Aug: 'he should be the one
    // controling it'). Nothing to do server-side — the PAGE puts it on the board
    // and persists it; the call itself is the result, exactly like stick_note.
    if (name === 'board_note') {
        const text = String(args.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) return { error: 'The board note needs some text.' };
        const kind = ['note', 'question', 'todo'].includes(String(args.kind || '')) ? String(args.kind) : 'note';
        const label = String(args.label || '').replace(/\s+/g, ' ').trim().slice(0, 24) || (kind === 'todo' ? 'to do' : kind === 'question' ? 'think about' : 'note');
        return { ok: true, onBoard: true, text, label, kind };
    }
    if (name === 'board_clear') {
        return { ok: true, cleared: true, label: String(args.label || '').replace(/\s+/g, ' ').trim().slice(0, 24) };
    }
    if (name === 'check_reference') {
        try {
            const cite = require('./q-cite');
            const q = String(args.query || '').trim();
            if (!q) return { error: 'No citation given.' };
            const doi = (q.match(/10\.\d{4,9}\/[^\s"'<>]+/) || [])[0];
            let works = [];
            if (doi) {
                try { const w = await cite.deps.fetchJson('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi)); const m = cite.fromOpenAlex(w); if (m) works = [m]; } catch (_) {}
            }
            if (!works.length) { try { works = await cite.searchOpenAlex(q, 3); } catch (_) {} }
            if (!works.length) { try { works = await cite.searchCrossref(q, 3); } catch (_) {} }
            if (!works.length) return { found: false, query: q, verdict: 'Nothing with that title / author / DOI on OpenAlex or CrossRef. Either it is mis-cited (check spelling, year, authors) or it does not exist.' };
            return { found: true, query: q, claim: String(args.claim || ''), candidates: works.slice(0, 3).map(w => ({ title: w.title, authors: (w.authors || []).map(a => (a.family || '') + (a.given ? ', ' + String(a.given).slice(0, 1) + '.' : '')).slice(0, 4).join('; '), year: w.year, venue: w.journal || w.publisher || '', doi: w.doi || null, url: w.url || null, about: String(w.snippet || '').slice(0, 900) || '(no abstract available — judge from the title and venue)', citedBy: w.citedBy || 0 })), note: 'Judge fit yourself from "about" against the student\'s claim. If none of these is what they cited, say so plainly.' };
        } catch (e) { return { error: 'Reference lookup failed: ' + String(e && e.message || e).slice(0, 160) }; }
    }

    switch (name) {
        case 'web_search':       return await webSearch(args);
        case 'shop_search':      return await qShop.searchShop(args, personEmail);
        case 'get_next_action':  return await qNext.nextAction(args, personEmail);
        case 'schedule_followup': return qFollow.scheduleFollowup(args, personEmail);
        case 'check_drafts':     return qDesk.checkDrafts(args, personEmail);
        case 'find_contact':     return await qDesk.findContact(args, personEmail);
        case 'read_page_history': return qDesk.readPageHistory(args, personId);
        case 'bulk_add_tasks':   return bulkAddTasksTool(args, personEmail);
        case 'home_status':      return await qHome.homeStatus(args);
        case 'home_control':     return await qHome.homeControl(args);
        case 'search_images':    return await searchImages(args);
        case 'street_view':      return await streetView(args, personEmail);
        case 'search_hotels':    return await qTravel.searchHotels(args, personEmail);
        case 'search_flights':   return await qTravel.searchFlights(args, personEmail);
        case 'flight_schedule':  return await qTravel.flightSchedule(args, personEmail);
        case 'build_call_qr':    return await callQrTool(args, personEmail);
        case 'build_whatsapp_qr': return await whatsappQrTool(args, personEmail);
        case 'build_email_qr':   return await emailQrTool(args, personEmail);
        case 'build_link_qr':    return await linkQrTool(args, personEmail);
        case 'add_file_to_thread': return await addFileToThread(args, personEmail);
        case 'calculator':       return calculator(args);
        case 'current_datetime': return currentDatetime(args);
        case 'analyze_document': return await analyzeDocument(args);
        case 'create_document':  return await createDocument(args, personEmail);
        case 'remember':         return remember(args, personId);
        case 'recall':           return recall(args, personId);
        case 'recall_tutor':     return recallTutor(personId);
        // Doc-editor tools — operate on the user's current uploaded doc
        case 'read_doc':          return docEditTool(personId, () => docEditor.readDoc(getDoc(personId)), { keepBytes: true });
        case 'replace_text':      return docEditTool(personId, (b) => docEditor.replaceText(b, args.target, args.replacement, args.paragraph_index ?? null));
        case 'delete_paragraph':  return docEditTool(personId, (b) => docEditor.deleteParagraph(b, args.index));
        case 'insert_paragraph':  return docEditTool(personId, (b) => docEditor.insertParagraph(b, args.after_index, args.text, args.style || 'Normal'));
        case 'move_paragraph':    return docEditTool(personId, (b) => docEditor.moveParagraph(b, args.from_index, args.to_index));
        case 'merge_paragraph':   return docEditTool(personId, (b) => docEditor.mergeParagraph(b, args.source_index, args.target_index, args.position || 'end'));
        case 'format_paragraph':  return docEditTool(personId, (b) => docEditor.formatParagraph(b, args.index, args.style));
        // Creative stack — image, vector, video
        // (generate_music + speak_as_q RETIRED 2026-08-15 — retired/2026-08-15-voice-clone-and-music/)
        case 'generate_image':    return await generateImageTool(args, personEmail);
        case 'vectorise_image':   return await vectoriseImageTool(args, personEmail);
        case 'generate_video':    return await generateVideoTool(args, personEmail);
        case 'save_situation':       return saveSituation(args, personEmail);
        case 'list_threads':         return listThreadsTool(personEmail);
        case 'read_thread':          return readThreadTool(args, personEmail);
        case 'add_email_to_thread':  return addEmailToThreadTool(args, personEmail);
        case 'add_note_to_thread':   return addNoteToThreadTool(args, personEmail);
        case 'update_case_summary':  return updateCaseSummaryTool(args, personEmail);
        case 'read_finance':         return readFinanceTool(personEmail);
        case 'add_finance_problem':  return addFinanceProblemTool(args, personEmail);
        case 'label_transactions':   return labelTransactionsTool(args, personEmail);
        case 'sort_categories':      return await sortCategoriesTool(personEmail);
        case 'send_notification':    return await sendNotificationTool(args, personEmail);
        // Life — calendar + tasks
        case 'add_event':            return addEventTool(args, personEmail);
        case 'list_events':          return listEventsTool(args, personEmail);
        case 'add_task':             return addTaskTool(args, personEmail);
        case 'list_tasks':           return listTasksTool(args, personEmail);
        case 'complete_task':        return completeTaskTool(args, personEmail);
        case 'edit_task':            return editTaskTool(args, personEmail);
        case 'delete_task':          return deleteTaskTool(args, personEmail);
        case 'bulk_tasks':           return bulkTasksTool(args, personEmail);
        case 'merge_tasks':          return mergeTasksTool(args, personEmail);
        case 'update_life_context':  return updateLifeContextTool(args, personEmail);
        case 'send_email':           return await sendEmailTool(args, personEmail, threadId);
        case 'check_inbox':          return await checkInboxTool(args, personEmail);
        case 'read_email':           return await readEmailTool(args, personEmail);
        case 'read_email_attachment': return await readEmailAttachmentTool(args, personEmail);
        case 'save_email_draft':     return saveEmailDraftTool(args, personEmail, threadId);
        case 'fetch_form':           return await fetchFormTool(args, personEmail, threadId);
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
async function createDocument({ title, content, image_sources, format } = {}, personEmail) {
    if (!title || typeof title !== 'string') return { error: 'title (string) is required' };
    if (!content || typeof content !== 'string') return { error: 'content (string) is required' };
    if (!personEmail) return { error: 'Cannot create a document without a signed-in user.' };
    const asPdf = String(format || '').toLowerCase() === 'pdf';
    try {
        // Resolve any evidence images to buffers. A source that can't be
        // resolved is skipped (not fatal) — the doc still builds, and
        // doc-creator writes a "[Image could not be embedded]" line so the
        // provenance trail isn't silently lost.
        const images = [];
        const srcs = Array.isArray(image_sources) ? image_sources.slice(0, 20) : [];
        for (const s of srcs) {
            if (!s || (!s.token && !s.url)) continue;
            const caption = typeof s.caption === 'string' ? s.caption : '';
            if (s.token) {
                const r = resolveToken(s.token, personEmail); // per-user scoped
                if (!r) { images.push({ buffer: null, caption: caption || 'source unavailable' }); continue; }
                try { images.push({ buffer: fs.readFileSync(r.fullPath), caption }); }
                catch { images.push({ buffer: null, caption: caption || 'source unreadable' }); }
            } else {
                const f = await fetchRemoteBinary(s.url);
                images.push(f.error ? { buffer: null, caption: caption || 'source unavailable' }
                                    : { buffer: f.buffer, caption });
            }
        }
        const result = asPdf
            ? await createPdf({ title, content, images }, personEmail)
            : await createDocx({ title, content, images }, personEmail);
        const embedded = images.filter(i => i.buffer).length;
        return {
            ok: true,
            token: result.token,
            filename: result.filename,
            sizeBytes: result.sizeBytes,
            imagesEmbedded: embedded,
            downloadUrl: '/download/' + result.token,
            instruction_for_q: 'Tell the user the document is ready and give them this exact markdown link to download it: [Download ' + result.filename + '](' + '/download/' + result.token + ').'
                + (srcs.length ? ` ${embedded} of ${srcs.length} image(s) embedded with their source captions.` : '')
                + ' Mention briefly what you put in the document, but do NOT paste the full body — they\'ll get it in the file. If this is a case, offer to file the document onto the Thread with add_file_to_thread (use its download token).',
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

// generateMusicTool — RETIRED 2026-08-15 (retired/2026-08-15-voice-clone-and-music/RETIRED.md)

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

// speakAsQTool — RETIRED 2026-08-15 with q-voice-clone (retired/2026-08-15-voice-clone-and-music/RETIRED.md)

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
            instruction_for_q: `Tell the user their situation is saved. Give them a markdown link to open it: [${thread.title}](${url}). Briefly confirm what's in it (1 sentence) so they know it captured the right thing, then propose the next concrete move on the case.`,
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
                ? 'No saved threads yet. If the user is asking about a situation that should be saved, offer to save it with save_situation.'
                : 'Match the user\'s words to one of these threads. If you find the one they mean, call read_thread next to load the full content. If unsure between two, ask which.',
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

// ── Inbox reading — Q checks the user's OWN connected email (read-only) ──────
// The read engine lives in q-email-accounts (Gmail API for a connected Gmail,
// IMAP for other providers). These wrap it so Q can check mail, read a message,
// and pull an attachment's text — then compose with the existing tools
// (add_email_to_thread, add_event, send_email) to file it, diarise it, or reply.
function inboxToolError(e) {
    const code = e && e.code;
    if (code === 'inbox_not_connected') return { error: 'No email is connected yet — connect it on the Email Writer page first, then I can read your inbox.' };
    if (code === 'inbox_scope_missing' || code === 'inbox_auth_failed') return { error: 'I need permission to read your inbox — reconnect your Gmail on the Email Writer page (one tap) and it will work.' };
    return { error: 'Could not read the inbox right now: ' + ((e && e.message) || 'unknown error') };
}

async function checkInboxTool({ limit, unread_only } = {}, personEmail) {
    if (!personEmail) return { error: 'No signed-in user.' };
    const n = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 40);
    try {
        const acct = qEmailAccounts.getAccount(personEmail);
        const isGmail = acct && acct.provider === 'gmail';
        const isOutlook = acct && acct.provider === 'outlook';
        let list;
        if (isGmail) {
            list = await qEmailAccounts.listGmailInbox(personEmail, { limit: n, label: unread_only ? 'UNREAD' : 'INBOX' });
        } else if (isOutlook) {
            // Outlook has no UNREAD folder — list the inbox and filter here.
            list = await qEmailAccounts.listOutlookInbox(personEmail, { limit: n, label: 'INBOX' });
            if (unread_only) list = list.filter(m => m.seen === false);
        } else {
            list = await qEmailAccounts.listInbox(personEmail, { limit: n });
            if (unread_only) list = list.filter(m => m.seen === false);
        }
        return {
            ok: true, count: list.length,
            messages: list.map(m => ({
                id: (m.id != null ? m.id : m.uid),
                from: m.fromName || m.from, from_email: m.from,
                subject: m.subject, date: m.date, unread: m.seen === false,
            })),
        };
    } catch (e) { return inboxToolError(e); }
}

async function readEmailTool({ message_id } = {}, personEmail) {
    if (!personEmail) return { error: 'No signed-in user.' };
    if (!message_id) return { error: 'message_id is required (get it from check_inbox).' };
    try {
        const acct = qEmailAccounts.getAccount(personEmail);
        const isGmail = acct && acct.provider === 'gmail';
        const isOutlook = acct && acct.provider === 'outlook';
        const msg = isGmail
            ? await qEmailAccounts.readGmailMessage(personEmail, String(message_id))
            : isOutlook
                ? await qEmailAccounts.readOutlookMessage(personEmail, String(message_id))
                : await qEmailAccounts.readInboxMessage(personEmail, message_id);
        return {
            ok: true,
            id: (msg.id != null ? msg.id : msg.uid),
            from: msg.fromName || msg.from, from_email: msg.from, to: msg.to,
            subject: msg.subject, date: msg.date,
            body: String(msg.text || '').slice(0, 12000),
            attachments: (msg.attachments || []).map(a => ({
                attachment_id: a.attachmentId, filename: a.filename, mime_type: a.mimeType, size: a.size,
            })),
        };
    } catch (e) { return inboxToolError(e); }
}

async function readEmailAttachmentTool({ message_id, attachment_id, filename, mime_type, save_to_thread_id } = {}, personEmail) {
    if (!personEmail) return { error: 'No signed-in user.' };
    if (!message_id || !attachment_id) return { error: 'message_id and attachment_id are required (from read_email).' };
    try {
        const acct = qEmailAccounts.getAccount(personEmail);
        if (!acct || (acct.provider !== 'gmail' && acct.provider !== 'outlook')) return { error: 'Reading attachments works with a connected Gmail or Outlook account — connect one on the Email Writer page.' };
        const att = acct.provider === 'gmail'
            ? await qEmailAccounts.getGmailAttachment(personEmail, String(message_id), String(attachment_id))
            : await qEmailAccounts.getOutlookAttachment(personEmail, String(message_id), String(attachment_id));
        if (!att || !att.base64) return { error: 'Could not fetch that attachment.' };
        const name = String(filename || 'attachment');
        const mime = mime_type || (/\.pdf$/i.test(name) ? 'application/pdf'
            : /\.(png|jpe?g|webp|gif|heic)$/i.test(name) ? 'image/jpeg'
            : /\.docx?$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/octet-stream');
        // Read the text out: PDFs / images via vision-OCR (the "eyes"); plain text decoded.
        let text = '';
        try {
            if (/pdf|image\//i.test(mime) || /\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(name)) {
                const ex = await qFinance.extractDocument(att.base64, /pdf/i.test(mime) ? 'application/pdf' : mime);
                text = (ex && (ex.full_text || ex.raw)) || '';
            } else if (/text|json|csv|xml|html/i.test(mime) || /\.(txt|csv|md|json|xml|html?)$/i.test(name)) {
                text = Buffer.from(att.base64, 'base64').toString('utf8');
            }
        } catch { text = ''; }
        let saved = null;
        if (save_to_thread_id) {
            try {
                const owned = qThreads.readThread(String(save_to_thread_id), personEmail);
                if (owned) {
                    const updated = qThreads.addFile(String(save_to_thread_id), { filename: name, mimeType: mime, base64: att.base64 }, personEmail);
                    if (updated) saved = { threadId: updated.id, filename: name };
                }
            } catch { /* filing is best-effort; still return the text */ }
        }
        return {
            ok: true, filename: name, mime_type: mime,
            text: String(text || '').slice(0, 12000) || '(no readable text found in this attachment)',
            saved,
        };
    } catch (e) { return inboxToolError(e); }
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
        instruction_for_q: 'Email added to the Thread. Tell the user briefly what was added (who/when), then continue.',
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

/**
 * update_case_summary — create or replace the case's single living summary note
 * (the brief + timeline). Replaces, never duplicates.
 */
function updateCaseSummaryTool({ threadId, content } = {}, personEmail) {
    if (!threadId) return { error: 'threadId is required' };
    if (!content) return { error: 'content is required' };
    if (!personEmail) return { error: 'Cannot mutate a thread without a signed-in user.' };
    const owned = qThreads.readThread(threadId, personEmail);
    if (!owned) return { error: 'Thread not found: ' + threadId };
    const updated = qThreads.setSummaryNote(threadId, content, personEmail);
    if (!updated) return { error: 'Thread not found: ' + threadId };
    return {
        ok: true,
        threadId: updated.id,
        instruction_for_q: 'Case summary + timeline updated. Brief confirmation, then carry on — do NOT paste the summary back to the user.',
    };
}

// ── Finance ──────────────────────────────────────────────────────────────

const qFinance = require('./q-finance');

function readFinanceTool(personEmail) {
    if (!personEmail) return { error: 'Cannot read finance without a signed-in user.' };
    try {
        const txns = qFinance.getTransactions(personEmail);
        if (!txns.length) {
            return {
                hasData: false,
                instruction_for_q: 'No transactions loaded yet. Tell the user to upload a bank statement (PDF or CSV) on the Finance page first — go to /finance and use the upload strip at the top.',
            };
        }
        const graph = qFinance.getSpendingGraphData(personEmail);
        const problems = qFinance.getProblemQueue(personEmail);
        const recent = txns.slice().reverse().slice(0, 30);
        return {
            hasData: true,
            summary: graph.summary,
            by_category: graph.by_category,
            // Same lists the /finance boxes show — Q must see what the user
            // sees. Income excludes self-transfers, so a top-up from the
            // user's own other bank never reads as income.
            subscriptions: qFinance.detectSubscriptions(personEmail).slice(0, 15),
            income_sources: qFinance.detectIncome(personEmail).slice(0, 10),
            rhythm: (() => {
                const r = qFinance.detectRegulars(personEmail);
                const trim = o => ({ weekly: o.weekly.slice(0, 8), monthly: o.monthly.slice(0, 8), bills: o.bills.slice(0, 8) });
                return { in: trim(r.in), out: trim(r.out) };
            })(),
            openProblems: problems.slice(0, 10),
            recentTransactions: recent,
            instruction_for_q: "You now have the user's full financial picture. Speak specifically — name real merchants, real amounts, real categories. If there are open problems, lead with the urgent/high ones. IMPORTANT: summary.self_transfers is the user's OWN money moving between their own accounts, banks and pots (they often upload statements from several banks) — it is already excluded from total_spend and total_income. Call it 'moved between your accounts', never 'savings' and never income or spending.",
        };
    } catch (e) {
        return { error: 'Could not read finance data: ' + e.message };
    }
}

function addFinanceProblemTool({ title, provider, amount, dueDate, type, urgency, notes } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot add a problem without a signed-in user.' };
    if (!title) return { error: 'title is required' };
    try {
        const problem = qFinance.addProblem(personEmail, {
            title,
            provider: provider || null,
            amount:   amount != null ? parseFloat(amount) : null,
            dueDate:  dueDate || null,
            type:     type || 'debt',
            urgency:  urgency || 'medium',
            notes:    notes || null,
        });
        return {
            ok: true,
            id: problem.id,
            title: problem.title,
            instruction_for_q: `Problem "${problem.title}" added to the Finance page debt queue. Tell the user it's saved and visible on /finance. Ask if they want you to draft a letter or plan next steps.`,
        };
    } catch (e) {
        return { error: 'Could not add problem: ' + e.message };
    }
}

// Q's labelling hands on the Finance page. Thin wrappers over the existing
// finance plugin — no new data logic lives here.
function labelTransactionsTool({ match, category, bucket } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot label transactions without a signed-in user.' };
    if (!match) return { error: 'match is required — a merchant name or part of one.' };
    if (!category && bucket == null) return { error: 'Provide a category, a bucket, or both.' };
    try {
        const needle = String(match).toLowerCase();
        const txns = qFinance.getTransactions(personEmail);
        const hits = txns.filter(t =>
            (String(t.merchant || '') + ' ' + String(t.description || '')).toLowerCase().includes(needle));
        if (!hits.length) {
            return { ok: false, matched: 0, instruction_for_q: `No transactions matched "${match}". Ask the user for the name exactly as it appears in their transactions list — you can call read_finance to see recent ones.` };
        }
        let updated = 0;
        for (const t of hits) {
            const updates = {};
            if (category) updates.category = category;
            if (bucket != null) updates.bucket = bucket;
            if (qFinance.updateTransaction(personEmail, t.id, updates)) updated++;
        }
        // A bucket is an ongoing assignment — remember it per distinct
        // merchant so future imports land in the bucket automatically.
        if (bucket != null) {
            const seen = new Set();
            for (const t of hits) {
                const name = t.merchant || t.description;
                const key = name.toLowerCase();
                if (!seen.has(key)) { seen.add(key); qFinance.assignMerchant(personEmail, name, bucket); }
            }
        }
        return {
            ok: true, matched: hits.length, updated,
            sample: hits.slice(0, 3).map(t => ({ date: t.date, merchant: t.merchant, amount: t.amount })),
            instruction_for_q: `Labelled ${updated} transaction(s) matching "${match}"${category ? ` as ${category}` : ''}${bucket != null ? ` under "${bucket}"` : ''}. The Finance page shows it after a refresh. Tell the user what you changed, with the real numbers.`,
        };
    } catch (e) {
        return { error: 'Could not label transactions: ' + e.message };
    }
}

async function sortCategoriesTool(personEmail) {
    if (!personEmail) return { error: 'Cannot sort categories without a signed-in user.' };
    try {
        const r = await qFinance.recategoriseOther(personEmail);
        return {
            ok: true, ...r,
            instruction_for_q: r.updated > 0
                ? `${r.updated} transactions were labelled (${r.remaining_other} still unclear). Summarise what changed for the user — call read_finance if you want the fresh category totals.`
                : 'Everything is already labelled — nothing was marked "other". Tell the user their transactions are fully sorted.',
        };
    } catch (e) {
        return { error: 'Could not sort categories: ' + e.message };
    }
}

async function sendNotificationTool({ title, body, url } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot send a notification without a signed-in user.' };
    if (!title) return { error: 'title is required' };
    try {
        const qPush = require('./q-push');
        const result = await qPush.pushToUser(personEmail, {
            title: String(title).slice(0, 100),
            body:  String(body || '').slice(0, 200),
            url:   String(url || '/'),
        });
        if (result.sent === 0 && result.failed === 0) {
            return {
                ok: false,
                instruction_for_q: "No push subscriptions found for this user — they haven't granted notification permission yet, or they're on a browser/device that hasn't registered. Tell them to allow notifications (the bell icon in their browser) so you can reach them.",
            };
        }
        return {
            ok: true,
            sent: result.sent,
            instruction_for_q: `Notification sent (${result.sent} device${result.sent !== 1 ? 's' : ''}). Tell the user their phone/browser should ping shortly.`,
        };
    } catch (e) {
        console.warn('[send_notification] error:', e.message);
        return { error: 'Could not send notification: ' + e.message };
    }
}

// ── Life — calendar + tasks ─────────────────────────────────────────────

function addEventTool({ title, date, time, location, notes, category, repeat, months } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot add an event without a signed-in user.' };
    if (!title) return { error: 'title is required' };
    if (!date)  return { error: 'date is required (YYYY-MM-DD)' };
    try {
        if (repeat) {
            const series = qLife.addRepeatingEvent({ title, date, time, location, notes, category, repeat, months, source: 'chat' }, personEmail);
            return {
                ok: true,
                repeat: series.repeat,
                count: series.count,
                first: series.first,
                last: series.last,
                instruction_for_q: `Added ${series.count} dated entries (${series.repeat}) from ${series.first} to ${series.last} — the repeating pattern IS set. Tell the user the dates are on their /life calendar.`,
            };
        }
        const event = qLife.addEvent({ title, date, time, location, notes, category, source: 'chat' }, personEmail);
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

function addTaskTool({ title, due, priority, notes, category, subtasks, alertAt, contact } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot add a task without a signed-in user.' };
    if (!title) return { error: 'title is required' };
    try {
        const task = qLife.addTask(
            { title, due, priority, notes, category, subtasks, alertAt, contact, source: 'chat' },
            personEmail
        );
        return {
            ok: true,
            task,
            instruction_for_q: 'Task added. One short confirming line — title (and due date if there is one). If subtasks/alert/contact were set, mention them briefly.',
        };
    } catch (e) { return { error: e.message }; }
}

function listTasksTool({ status, filter } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot list tasks without a signed-in user.' };
    const tasks = qLife.listTasks(personEmail, { status: status || 'open' });

    // OVERDUE (20 Aug 2026 — Q's gap #2). The due dates were always stored and
    // always returned, but nothing ever worked out what they MEANT, so Q had no
    // concept of "late" and couldn't lead with it. Compared in her local day,
    // not UTC: "due today" has to mean today to a person, not to a server.
    const today = (() => {
        try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        } catch (_) { return new Date().toISOString().slice(0, 10); }
    })();
    const dayDiff = (due) => Math.round((new Date(due + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);

    let rows = tasks.map(t => {
        const delta = t.due ? dayDiff(t.due) : null;
        return {
            ...t,
            overdue: delta != null && delta < 0 && !t.done,
            days_overdue: delta != null && delta < 0 ? Math.abs(delta) : 0,
            due_today: delta === 0,
            due_tomorrow: delta === 1,
        };
    });

    const want = String(filter || '').toLowerCase();
    if (want === 'overdue') rows = rows.filter(r => r.overdue);
    else if (want === 'today') rows = rows.filter(r => r.due_today || r.overdue);

    const overdueCount = rows.filter(r => r.overdue).length;

    return {
        count: rows.length,
        overdue_count: overdueCount,
        tasks: rows,
        instruction_for_q: rows.length === 0
            ? (want ? `Nothing matches "${want}". Say so plainly — do not list the others unless asked.` : 'No open tasks. Say so plainly.')
            : (overdueCount > 0
                ? `${overdueCount} of these are OVERDUE — days_overdue says by how long. Lead with the worst one and say how late it is. Do not read the whole list out unless they asked for the whole list.`
                : 'Summarise the open tasks. Lead with anything due today or tomorrow.'),
    };
}

function bulkAddTasksTool({ tasks } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot add tasks without a signed-in user.' };
    if (!Array.isArray(tasks) || !tasks.length) {
        return { error: 'tasks (array) is required', instruction_for_q: 'Nothing was saved. Ask them to say the list again.' };
    }
    // Cap it: a brain-dump is a handful of things. A hundred means something has
    // gone wrong upstream, and silently writing them all would be worse.
    const wanted = tasks.slice(0, 25);
    const { tasks: added } = qLife.addBatch({ tasks: wanted }, personEmail);

    return {
        ok: true,
        added: added.map(t => ({ id: t.id, title: t.title, due: t.due || null })),
        count: added.length,
        failed: wanted.length - added.length,
        instruction_for_q:
            `${added.length} task(s) saved to their list. Confirm in ONE line — say how many and name at most two. `
            + 'Do not read the whole list back at them; they just said it. '
            + (wanted.length - added.length > 0 ? 'Some did NOT save — say plainly which count failed. ' : '')
            + 'If any of them is waiting on someone else, offer to set a chase with schedule_followup.',
    };
}

/**
 * CHANGE an existing task (Q's gap #2, 20 Aug 2026). q-life.updateTask has
 * always been able to do this — it simply was never handed to Q, so when Sarah
 * asked him to reorganise her list into categories he could not, and said it
 * was done when he had only grouped them in the chat. The only workaround was
 * to make a new task and complete the old one, which silently threw away its
 * notes and subtasks.
 */
function editTaskTool(args = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot edit a task without a signed-in user.' };
    const id = String(args.id || '').trim();
    if (!id) return { error: 'id is required (use list_tasks first)' };

    const patch = {};
    for (const f of ['title', 'due', 'priority', 'category', 'notes', 'alertAt', 'chase', 'contact', 'subtasks']) {
        if (f in args && args[f] !== undefined) patch[f] = args[f];
    }
    if (!Object.keys(patch).length) {
        return { error: 'nothing to change', instruction_for_q: 'Ask WHICH field they want changed. Do not guess.' };
    }

    const updated = qLife.updateTask(id, patch, personEmail);
    if (!updated) return { error: 'Task not found: ' + id, instruction_for_q: 'That task no longer exists. Say so — do not pretend the change was made.' };

    return {
        ok: true,
        task: { id: updated.id, title: updated.title, due: updated.due, priority: updated.priority, category: updated.category },
        changed: Object.keys(patch),
        instruction_for_q: 'Changed, for real, on their list. Confirm in one line naming only what actually changed. Never say a task has been changed unless this came back ok.',
    };
}

/**
 * DELETE a task outright (Q's gap #3). "Done" is not the same as "gone" — a
 * passed event or a duplicate should leave the list, not sit ticked forever.
 */
function deleteTaskTool(args = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot delete a task without a signed-in user.' };
    const id = String(args.id || '').trim();
    if (!id) return { error: 'id is required (use list_tasks first)' };

    const before = (qLife.listTasks(personEmail, {}) || []).find(t => t.id === id);
    if (!before) return { error: 'Task not found: ' + id, instruction_for_q: 'It is already gone. Say so plainly.' };

    qLife.deleteTask(id, personEmail);
    try { require('./q-followup').clearChaseForTask(personEmail, id); } catch (_) {}

    return {
        ok: true,
        deleted: { id, title: before.title },
        instruction_for_q: `"${before.title}" is deleted and cannot be brought back. Confirm briefly. Only ever delete what they actually asked you to delete — if you are working from a list you proposed, read it back and get a yes first.`,
    };
}

/**
 * BULK complete or delete (Q's gap #6). One at a time is fine for three tasks
 * and punishing for ninety-six.
 */
function bulkTasksTool(args = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot change tasks without a signed-in user.' };
    const ids = Array.isArray(args.ids) ? args.ids.map(x => String(x).trim()).filter(Boolean) : [];
    const action = String(args.action || '').toLowerCase();
    if (!ids.length) return { error: 'ids (array) is required' };
    if (!['complete', 'delete'].includes(action)) return { error: 'action must be "complete" or "delete"' };

    const all = qLife.listTasks(personEmail, {}) || [];
    const done = [], missing = [];

    for (const id of ids.slice(0, 100)) {
        const t = all.find(x => x.id === id);
        if (!t) { missing.push(id); continue; }
        if (action === 'delete') {
            qLife.deleteTask(id, personEmail);
            try { require('./q-followup').clearChaseForTask(personEmail, id); } catch (_) {}
        } else {
            qLife.updateTask(id, { done: true }, personEmail);
            try { require('./q-followup').clearChaseForTask(personEmail, id); } catch (_) {}
        }
        done.push(t.title);
    }

    return {
        ok: true,
        action,
        count: done.length,
        titles: done.slice(0, 20),
        not_found: missing.length,
        instruction_for_q:
            `${done.length} task(s) ${action === 'delete' ? 'deleted — permanently' : 'ticked off'}. Confirm with the NUMBER, not the whole list. `
            + (missing.length ? `${missing.length} were already gone; say so. ` : '')
            + 'Deleting is irreversible: never run it on a list you assembled yourself without reading it back and getting a yes first.',
    };
}

/**
 * MERGE duplicates (Q's gap #4). "Call CMS" twice is one job, and completing
 * one of them leaves the other sitting there pretending to be work.
 */
function mergeTasksTool(args = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot merge tasks without a signed-in user.' };
    const keepId = String(args.keep_id || '').trim();
    const mergeIds = (Array.isArray(args.merge_ids) ? args.merge_ids : []).map(x => String(x).trim()).filter(Boolean);
    if (!keepId || !mergeIds.length) return { error: 'keep_id and merge_ids are both required' };

    const all = qLife.listTasks(personEmail, {}) || [];
    const keep = all.find(t => t.id === keepId);
    if (!keep) return { error: 'Task not found: ' + keepId };

    // Fold the others INTO the survivor before removing them, so nothing the
    // duplicates were carrying is quietly lost.
    const notes = [keep.notes].filter(Boolean);
    const subs = [...(keep.subtasks || [])];
    const seen = new Set(subs.map(s => String(s.text || '').toLowerCase()));
    let earliestDue = keep.due || null;
    const folded = [];

    for (const id of mergeIds) {
        const t = all.find(x => x.id === id);
        if (!t || t.id === keepId) continue;
        if (t.notes) notes.push(t.notes);
        for (const s of (t.subtasks || [])) {
            const k = String(s.text || '').toLowerCase();
            if (k && !seen.has(k)) { seen.add(k); subs.push({ text: s.text, done: !!s.done }); }
        }
        if (t.due && (!earliestDue || t.due < earliestDue)) earliestDue = t.due;
        folded.push(t.title);
    }

    if (!folded.length) return { error: 'nothing to merge', instruction_for_q: 'None of those ids exist any more. Say so.' };

    qLife.updateTask(keepId, {
        notes: notes.join('\n') || null,
        subtasks: subs,
        ...(earliestDue ? { due: earliestDue } : {}),
    }, personEmail);

    for (const id of mergeIds) {
        if (id === keepId) continue;
        qLife.deleteTask(id, personEmail);
        try { require('./q-followup').clearChaseForTask(personEmail, id); } catch (_) {}
    }

    return {
        ok: true,
        kept: keep.title,
        folded_in: folded,
        due: earliestDue,
        instruction_for_q:
            `Merged into "${keep.title}" — notes and sub-steps from the duplicates were folded in first, and the earliest due date kept, so nothing was lost. `
            + 'Confirm in one line.',
    };
}

function completeTaskTool({ id } = {}, personEmail) {
    if (!personEmail) return { error: 'Cannot complete a task without a signed-in user.' };
    if (!id) return { error: 'id is required (use list_tasks first)' };
    const updated = qLife.updateTask(id, { done: true }, personEmail);
    if (!updated) return { error: 'Task not found: ' + id };
    // Done means done — drop any chase still queued for it, so Q can never
    // come back later nagging about something she has already finished.
    try { require('./q-followup').clearChaseForTask(personEmail, id); } catch (_) {}
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

/**
 * recall_tutor — read Q's tutor notebook for this person. Separate store from
 * facts/memory; written by the writer page as Q coaches. Lets Q answer "what
 * was that question I was stuck on?" from any surface, not just the writer.
 */
function recallTutor(personId) {
    try {
        // 16 Aug 2026: one person, several assignments — Q recalls the one
        // that is OPEN on the writer page (the active project).
        const p = getActiveTutorPath(personId);
        if (!fs.existsSync(p)) {
            return { note: 'No tutoring work saved for this person yet — nothing in the notebook.' };
        }
        const t = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
            task: t.task || null,
            whatItWants: t.whatItWants || null,
            teachersBrief: t.teachersBrief || null,
            sections: Array.isArray(t.markedSections) ? t.markedSections : null,
            currentSection: t.currentSection || null,
            lastQuestion: t.lastQuestion || null,
            lastStuckOn: t.lastStuckOn || null,
            updatedAt: t.updatedAt || null,
        };
    } catch (e) {
        return { error: 'Could not read the tutor notebook: ' + e.message };
    }
}

// Pick the tools Q is allowed to call THIS turn. Persona alone wasn't enough
// to stop Q from running web_search uninvited (250 calls in two days from
// silent searches). The structural fix: only put web_search (and other
// expensive tools) into the tool list when the user message clearly asks.
//
// Default = remember + recall (cheap, useful for memory). Everything else is
// gated behind explicit triggers in the user's message.
// calculator + current_datetime are in the writer kit for the same hard reason
// they are in the advocate's (below): a science / maths / finance essay is full
// of numbers and a model cannot do arithmetic reliably. On the writer it was
// trigger-gated on the STUDENT's words ("calculate", digits + operator) — but
// it is Q who needs to compute when he teaches the working (Sarah, 19 Aug:
// "he will need tables and maths tools too for those subjects").
const WRITER_TOOLS = new Set(['check_reference', 'highlight_passage', 'tab_paragraph', 'stick_note', 'board_note', 'board_clear', 'calculator', 'current_datetime']);
const ALWAYS_ON = new Set([
    // Memory is core to every chat surface — Q should silently save and
    // recall facts without ceremony.
    'remember', 'recall',
    // Threads/situations are core memory across surfaces — Q gets these on
    // every turn so he can correlate to a saved case whenever Sarah refers
    // to one (anywhere — main chat, email writer, inside a Thread).
    'list_threads', 'read_thread', 'save_situation',
    'add_email_to_thread', 'add_note_to_thread', 'update_case_summary', 'add_file_to_thread',
    // Email drafting — always on so Q saves drafts from any chat surface.
    'save_email_draft',
    // Sarah's set (2026-07-01): Q keeps his CORE kit every turn so he never sends
    // the user off to do it himself — email, search, calendar, tasklist and document
    // creation. The rest (image/music/video generation, the doc-editor tools) stay
    // trigger-gated so they don't bloat every prompt — that bloat was hitting
    // Together's token rate limit (429) on big cases.
    'send_email', 'web_search', 'create_document', 'analyze_document',
    // LOOKING THINGS UP IS ALWAYS IN HIS HAND (20 Aug 2026). ~478 tokens a turn,
    // and worth every one: he is only ever shown the recent slice of a
    // conversation, so without this he will flatly deny things he really said —
    // which is exactly what happened to Sarah over her kitchen tap. A trigger
    // list can never cover every way a person says "but you told me". The one
    // failure this prevents costs more than the tokens do.
    'read_page_history',
    'add_event', 'list_events', 'add_task', 'list_tasks', 'complete_task',
    // Inbox reading (2026-07-01, Sarah): Q checks the user's OWN email, reads a
    // message + its attachments, then files/diarises/replies with the tools above.
    // Read-only + lightweight defs — kept always-on so "check my email" works on
    // any phrasing and any follow-up turn (unlike the heavy generators that were
    // gated to avoid the 429 bloat).
    'check_inbox', 'read_email', 'read_email_attachment',
    // Finance tools — always available so Q can read and update the finance
    // data store from any page, not just when on /finance.
    'read_finance', 'add_finance_problem', 'label_transactions', 'sort_categories',
    'send_notification',
    // Life tools (add_event / list_events / add_task / list_tasks /
    // complete_task / update_life_context) are trigger-gated below — only
    // attached when the user's message clearly asks for them. Keeping them
    // ALWAYS_ON wasted V4 calls (every turn reasoned over a 15-tool menu)
    // and hit Together's rate limit. One tool per turn, max.
]);

// In APS / case (Thread) mode the research + evidence tools are NOT optional
// extras — the prompt explicitly tells Q to research the law/precedent and
// build an evidence bundle. Trigger-gating them meant Q only researched if
// the user happened to say "search", so case advice came from stale memory
// (the "not clever" suggestions). On the advocate surface these are always
// offered so Q can actually do the job he's told to do.
// calculator + current_datetime are in here for a hard reason: a case is
// full of dates, durations, multipliers and money. LLMs cannot do arithmetic
// reliably (this is THE classic failure — "20 ÷ 7 = 2.9" style nonsense, or
// a balance read as £3.7tn). Trigger-gating the calculator meant that in a
// Thread, where the maths actually matters and gets put in front of a
// council, Q was doing it in his head and getting it wrong. On the advocate
// surface these are always available so every number is computed, not
// guessed — and current_datetime anchors "how long ago / to today".
const ADVOCATE_TOOLS = new Set([
    'web_search', 'search_images', 'street_view', 'create_document',
    'calculator', 'current_datetime', 'fetch_form',
]);

const TRIGGERS = {
    // Changing, clearing and tidying the list. Gated rather than always-on —
    // together they are ~780 tokens a turn, and the language for them is concrete
    // and easy to spot, unlike "do you remember", which is why THAT one is not
    // gated. Deliberately wide all the same: the whole complaint was Q not having
    // the tool in his hand at the moment he was asked for it.
    edit_task: [
        /\b(change|edit|update|move|switch|set|make)\b[^.?!]{0,40}\b(task|category|categories|priority|due|deadline|title|notes?|reminder)\b/i,
        /\b(reorgani[sz]e|recategori[sz]e|re-?categori[sz]e|sort|tidy|group|organi[sz]e)\b[^.?!]{0,30}\b(list|tasks?|jobs?)\b/i,
        /\b(put|move)\b[^.?!]{0,30}\b(under|into|in the)\b[^.?!]{0,20}\b(category|list|group)\b/i,
        /\bwrong (category|date|priority)\b/i,
    ],
    delete_task: [
        /\b(delete|remove|get rid of|bin|scrap|clear out|take off)\b/i,
        /\b(dead|old|passed|stale|duplicate) (tasks?|jobs?|ones?)\b/i,
        /\bshouldn'?t be (on|in) (the|my) list\b/i,
    ],
    bulk_tasks: [
        /\b(all of (them|these|those)|the lot)\b/i,
        /\b(clear|clean|tidy|sort) (out |up )?(my |the )?(list|tasks)\b/i,
        /\b(bulk|in one go|at once|all at once)\b/i,
        /\b(delete|remove|complete|tick off)\b[^.?!]{0,20}\b(them all|all of them|these|those)\b/i,
    ],
    merge_tasks: [
        /\b(merge|combine|duplicates?|same task|twice|repeated)\b/i,
        /\bthere'?s two\b/i,
    ],
    // Chasing. Anything left hanging on someone else, and every "remind me if".
    schedule_followup: [
        /\b(chase|follow ?up|nudge|come back to)\b/i,
        /\bremind me (if|when|to)\b/i,
        /\b(waiting|wait) (to hear|on|for)\b/i,
        /\b(if|unless) (they|he|she|it|i) (haven'?t|hasn'?t|don'?t|doesn'?t|isn'?t)\b/i,
        /\b(by|before) (friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow|next week|the end of)\b/i,
        /\bhaven'?t heard\b/i,
    ],
    // "Did that email ever go?"
    check_drafts: [
        /\b(draft|drafts|outbox)\b/i,
        // "did that email ever go", "has the Harrow Health email gone yet",
        // "was the letter sent" — the thing and the verb can be a long way apart.
        /\b(did|has|have|was|were|is)\b[^.?!]{0,50}\b(email|e-?mail|draft|letter|reply|message)\b[^.?!]{0,25}\b(send|sent|gone|go|went|out)\b/i,
        /\b(did|has|have) (i|it|that|we)\b[^.?!]{0,30}\b(send|sent|gone|go|went)\b/i,
        /\bstill (sitting|waiting|unsent|not sent)\b/i,
        /\b(unsent|not sent|never sent)\b/i,
        /\bwhat'?s (outstanding|still to do|hanging)\b/i,
    ],
    // "Who do I actually write to?"
    find_contact: [
        /\b(contact|email|write to|get hold of|reach|ring)\b[^.?!]{0,40}\b(the |my |about|who|person|people|team|practice|surgery|office|department)\b/i,
        /\bwho (deals with|handles|looks after|do i (contact|email|ring|speak to))\b/i,
        /\b(their|his|her|the) (email address|address|number|details)\b/i,
        /\bdo (i|we) have (an? )?(email|address|number) for\b/i,
    ],
    // ANY appeal to a shared past. Deliberately wide: Q only ever sees the most
    // recent slice of a conversation, so the cost of missing one of these is him
    // flatly denying something he really said — which is exactly what happened
    // to Sarah over her kitchen tap on 20 Aug. A needless lookup costs a moment;
    // calling her a liar about her own conversation costs her trust in him.
    read_page_history: [
        /\b(do|don'?t) you remember\b/i,
        /\bremember (when|that|the|our|us)\b/i,
        /\byou (said|told me|gave me|mentioned|suggested|advised|reckoned)\b/i,
        /\bwhat (did|do) (you|we) say\b/i,
        /\bi (asked|told|said to) you\b/i,
        /\bwe (talked|spoke|discussed|went through)\b/i,
        /\b(earlier|this morning|this afternoon|last night|yesterday|the other day|before)\b[^.?!]{0,40}\b(said|told|talked|asked|advice|about)\b/i,
        /\b(said|told|talked|asked|advice|about)\b[^.?!]{0,40}\b(earlier|this morning|this afternoon|last night|yesterday|the other day)\b/i,
        /\bthat (advice|thing|stuff) you\b/i,
        /\b(other|another|the) (page|chat|conversation|tab)\b/i,
        /\b(as|like) i (said|told you|mentioned)\b/i,
        /\b(writer|life|finance|email writer) page\b/i,
    ],
    // A brain-dump of several things at once.
    bulk_add_tasks: [
        /\b(add|put|stick|chuck|save)\b[^.?!]{0,30}\b(these|those|all of (this|these|that)|the following|a few things|list)\b/i,
        // Two or more separators = a list, not one job. NB a comma has no word
        // boundary after it, so `\b,\b` never matches — match the comma bare.
        /\b(i need to|i'?ve got to|i have to|need to)\b[^.?!]*(,|\band\b)[^.?!]*(,|\band\b)/i,
        /\b(jobs|things|stuff) (to do|for today|this week)\b/i,
    ],
    // "What do I do now?" — asked plainly, or asked sideways by someone who is
    // swamped. The sideways phrasings matter more than the plain ones.
    get_next_action: [
        /\bwhat (should|shall|do) i do\b/i,
        /\bwhat'?s next\b/i,
        /\bwhere (do|should) i (start|begin)\b/i,
        /\bwhat (do i|should i) (start|tackle|sort|deal) with\b/i,
        /\b(i'?m |im |feeling )?(overwhelmed|swamped|drowning|snowed under|all over the place|scattered)\b/i,
        /\bdon'?t know (where|what) to (start|do|begin)\b/i,
        /\b(most|more) (urgent|important|pressing)\b/i,
        /\b(one thing|next thing|next step|first thing)\b/i,
        /\bhelp me (focus|prioriti[sz]e|get going|start)\b/i,
    ],
    // The house. Kept wide because these get asked in passing and half-asleep
    // ("did I leave the hall light on?"), not in careful sentences.
    home_status: [
        /\b(light|lights|lamp|heating|thermostat|radiator|boiler|plug|socket|switch)\b/i,
        /\b(front|back|patio|garage|shed)\s*(door|gate)\b/i,
        /\b(door|window|doors|windows)\b.*\b(open|shut|closed|locked|unlocked)\b/i,
        /\b(is|are|did i|have i|anything)\b.*\b(on|off|open|shut|running|left)\b.*\b(house|home|upstairs|downstairs|kitchen|bedroom|bathroom|hall|landing|living room|lounge)\b/i,
        /\b(how (warm|cold|hot)|temperature)\b/i,
        /\b(my|the) (house|home)\b/i,
        /\b(battery|batteries)\b.*\b(low|need|dead)\b/i,
    ],
    home_control: [
        /\b(turn|switch|put|set|dim)\b[^.?!]{0,30}\b(on|off|up|down|to)\b/i,
        /\b(turn|switch)\s+(on|off)\b/i,
        /\b(heating|thermostat)\b[^.?!]{0,20}\b(\d{1,2}|up|down|on|off)\b/i,
        /\b(lights?|lamp)\b[^.?!]{0,20}\b(on|off)\b/i,
    ],
    // Buying something. Trigger-gated rather than always-on so it doesn't ride
    // on every prompt, but the phrasings are wide because this is one people ask
    // for in a dozen different ways — "how much is", "where can I get", "need a
    // new", or just naming a shop.
    shop_search: [
        /\b(buy|purchase|order)\b/i,
        /\bhow much (is|are|would|does|do|was)\b/i,
        /\b(what|how much) (does|do|would) .{0,40}\bcost\b/i,
        /\b(price|prices|pricing) (of|for|on)\b/i,
        /\b(cheapest|best price|good deal|on sale|bargain|value for money)\b/i,
        /\b(where can i|where do i|where would i|who) (get|buy|find|sells?)\b/i,
        /\b(need|want|looking for|after) (a|an|some|new)\b[^.?!]{0,40}\b(new|replacement|spare)?\b/i,
        /\b(shop|shopping|in stock|stockist)\b/i,
        /\b(amazon|argos|screwfix|toolstation|wickes|b&q|ikea|currys|john lewis|ebay|tesco|asda|sainsbury)\b/i,
        /\b(run out of|ran out of|need more)\b/i,
    ],
    send_email: [
        /\bsend (an?|the|this|that|it)?\s*(e-?mail|message)\b/i,
        /\b(e-?mail|send) (it|this|that|them|him|her)\b[^.?!]{0,40}\b(to|at)\b/i,
        /\be-?mail (it|this|that|them|him|her)\b/i,
        /\bfire (off|over) (an? )?e-?mail\b/i,
        /\b(send|e-?mail)\b[^.?!]{0,40}@/i,
        // Short confirmations when Q has already drafted and asked "say send"
        /^(yes[,.]?\s*)?(go ahead|send( it)?|fire it|send that|yes send|ok send|do it)[.!]?\s*$/i,
        /\blooks good[,.]?\s*(send|fire|go ahead)\b/i,
    ],
    web_search: [
        /\blook( it)? up\b/i,
        /\bsearch( for| the web| online)?\b/i,
        /\bgoogle (it|that|this|for)\b/i,
        /\bfind (me |online|on the web)\b/i,
        /\bwhat'?s (the latest|new on)\b/i,
        /\bup-?to-?date\b/i,
        /\bonline\b/i,
    ],
    search_images: [
        /\b(find|get|fetch|look up|search( for)?|show me|need|want|grab)\b[^.?!]{0,40}\b(photo|photos|picture|pictures|image|images|pic|pics|shot|snap)\b/i,
        /\b(photo|photos|picture|pictures|image|images|pics?) of\b/i,
        /\breal (photo|picture|image)\b/i,
        /\bwhat does\b[^.?!]{0,40}\blook like\b/i,
    ],
    street_view: [
        /\bstreet ?view\b/i,
        /\b(road|street|junction|signage|signs?|bus gate|restricted (street|route)|yellow lines?|loading bay|box junction)\b[^.?!]{0,30}\b(look|view|imagery|photo|picture|see|signed)\b/i,
        /\b(drove|driving|drive) (down|through|along|into)\b/i,
        /\b(parking|pcn|penalty charge|bus gate|moving[- ]traffic|tribunal|appeal|ticket|fine|contravention|ncp)\b/i,
    ],
    // Travel. These are METERED calls to an outside service, so they follow the
    // street_view pattern rather than ALWAYS_ON: attached only when the message
    // is clearly about a trip. The package-operator names (Jet2 / TUI /
    // loveholidays / On the Beach) are triggers on all three — those firms have
    // no public API, and Q needs the real tools in hand to say "I can price the
    // flight and the hotel separately, but not the package" instead of guessing.
    search_hotels: [
        /\bhotels?\b/i,
        /\b(place|places|somewhere|anywhere|room|rooms)\b[^.?!]{0,20}\bto stay\b/i,
        /\b(b\s?&\s?b|bed and breakfast|guest ?house|apart-?hotel|hostel|resort|villa|accommodation)\b/i,
        /\b(all[- ]inclusive|half[- ]board|full[- ]board|self[- ]catering|room only)\b/i,
        /\b(book|find|price|cost of|how much (is|are|for))\b[^.?!]{0,30}\b(stay|nights?|staying)\b/i,
        /\b(check[- ]?in|check[- ]?out)\b[^.?!]{0,25}\b(date|dates|night|nights)\b/i,
        /\b(jet\s?2|jet2holidays|tui|loveholidays|on the beach|first ?choice|package holiday)\b/i,
    ],
    search_flights: [
        /\bflights?\b/i,
        /\bfly(ing)?\b[^.?!]{0,15}\b(to|from|out|back|home|there)\b/i,
        /\b(airfare|air fare|plane ticket|plane tickets|return fare|one[- ]way)\b/i,
        /\b(cheap|cheapest|price|prices|cost|how much)\b[^.?!]{0,25}\b(fly|flight|flights|flying)\b/i,
        /\b(gatwick|heathrow|stansted|luton|manchester airport|birmingham airport|bristol airport)\b/i,
        /\b(jet\s?2|jet2holidays|tui|loveholidays|on the beach|first ?choice|package holiday)\b/i,
    ],
    flight_schedule: [
        /\b(what|which) days\b[^.?!]{0,40}\b(fly|flies|flight|flights|run|runs|operate|operates)\b/i,
        /\b(direct|non-?stop|indirect) flights?\b/i,
        /\bwho flies\b/i,
        /\bflight schedule\b/i,
        /\b(route|service)\b[^.?!]{0,25}\b(operates?|runs?|days of the week)\b/i,
        /\b(is there|are there)\b[^.?!]{0,25}\bflights?\b[^.?!]{0,25}\b(on|from|to)\b/i,
        /\b(out on|back on|home on)\b[^.?!]{0,20}\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
        /\b(jet\s?2|jet2holidays|tui|loveholidays|on the beach|first ?choice|package holiday)\b/i,
    ],
    // Scan-to-call QR. `qr` on its own is enough — offering it costs nothing
    // if he doesn't need it, and a bare "give me a QR" is nearly always a
    // dial one. The other patterns catch the phrasings that describe one
    // without saying "QR". WhatsApp has its own entry below; a message
    // mentioning both words gets both tools offered, which is correct.
    build_call_qr: [
        /\bqr\b/i,
        /\bscan[- ]?(to|and)?[- ]?(call|dial|ring)\b/i,
        /\bscan(nable)?\b[^.?!]{0,30}\b(call|dial|ring|phone|number)\b/i,
        /\b(call|dial|ring|phone)\b[^.?!]{0,20}\b(code|square)\b/i,
    ],
    // WhatsApp QR. Any mention of WhatsApp at all — if he doesn't need it the
    // tool just goes unused, but missing it means he can't offer to send one.
    // Email QR — the third contact mode. Shares the bare `qr` trigger with the
    // other two so all three are on the table whenever the user says QR, and Q
    // picks the right one from what they're actually asking for.
    build_email_qr: [
        /\bqr\b/i,
        /\bscan[- ]?(to|and)?[- ]?(e-?mail|write)\b/i,
        /\be-?mail\b[^.?!]{0,20}\b(code|qr|square)\b/i,
    ],
    build_whatsapp_qr: [
        // Bare "qr" too, so a plain "give me a QR for Dave" puts all four
        // QR kinds (call / WhatsApp / email / link) in front of Q to choose from.
        /\bqr\b/i,
        /\bwhats\s?app\b/i,
        /\bwa\.me\b/i,
        /\bscan[- ]?(to|and)?[- ]?(message|text|whats\s?app)\b/i,
    ],
    // Link QR — the kind people usually mean by "a QR code": one that opens a
    // web page. Bare `qr` like the others, plus the phrasings that describe it.
    build_link_qr: [
        /\bqr\b/i,
        /\bscan[- ]?(to|and)?[- ]?(open|visit|view|see)\b/i,
        /\b(link|website|web ?page|url|advert|listing|page)\b[^.?!]{0,20}\b(code|square|scannable)\b/i,
        /\bmake (this|that|the|my)? ?(link|url|website|page|advert) scannable\b/i,
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
    recall_tutor: [
        /\b(assignment|essay|coursework|dissertation|homework|thesis)\b/i,
        /\b(my tutor|the writer page|writing coach)\b/i,
        /\b(stuck on|got stuck|where was i|what was that question|pick up where|carry on with)\b/i,
        /\b(my (last |current )?(brief|task)|section i was (on|doing))\b/i,
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
    // generate_music trigger RETIRED 2026-08-15 (tool removed)
    generate_video: [
        /\b(generate|make|create|render|produce) [^.?!]{0,40}\b(video|clip|reel|animation)\b/i,
    ],
    // speak_as_q trigger RETIRED 2026-08-15 (tool removed)
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

    // Life — calendar + tasks. Each tool fires only when the message
    // clearly references its purpose.
    add_event: [
        /\b(add|put|book|schedule|pencil|stick)\b.*\b(in|on|for|to)\b.*\b(calendar|diary|on (the )?\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i,
        /\b(i('ve)? got|i have)\b.*\b(meeting|appointment|trip|party|event|thing)\b.*\b(on|at|next|tomorrow|tonight|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(st|nd|rd|th)?)\b/i,
        /\bnew event\b/i,
    ],
    list_events: [
        /\b(what'?s|whats|anything)\b.*\b(on|coming up|happening|in (the )?diary|this week|next week|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
        /\b(do i have|have i got)\b.*\b(anything|something|meetings?|appointments?|plans?)\b/i,
        /\b(my )?calendar\b/i,
        /\b(what'?s|whats) (my )?(week|day|weekend) (like|looking like)\b/i,
    ],
    add_task: [
        /\b(remind me|don'?t let me forget|i need to|i('ve)? got to|i have to|i must|got to)\b/i,
        // "put it on the list", "add to my tasks", "stick it on the to-do",
        // "pop that on my list", "chuck it on the task list" — on/to/in + a list word.
        /\b(add|put|pop|stick|chuck|note)\b[^.?!]*\b(on|to|in)\b[^.?!]*\b(list|task|tasks|to-?do|to-?dos)\b/i,
        // any reference to a task / to-do list at all
        /\b(task|to-?do)[- ]?list\b/i,
        /\bon (my|the) (list|tasks?|to-?dos?)\b/i,
        // "add a task", "new task", "make a to-do", "task: call EDF"
        /\b(add|new|make|create)\b[^.?!]*\b(task|to-?do)s?\b/i,
        /\b(task|to-?do)s?\s*:/i,
        /\b(todo|to-do)\b.*\b(:|add)\b/i,
    ],
    list_tasks: [
        /\b(what'?s|whats|show me|list|see|check)\b.*\b(on (my|the) list|my tasks?|my todos?|my to-?dos?|to-?do list|task list|left to do|outstanding|on my plate)\b/i,
        /\bwhat do i (need|have) to (do|get done)\b/i,
    ],
    complete_task: [
        /\b(i('ve)? )?(done|finished|completed?|sorted)\b.*\b(that|this|it|the|with)\b/i,
        /\btick (off|that|this|it)\b/i,
        /\bcross (off|that|this|it)\b/i,
    ],
    // Q can offer to save household-filter facts (year groups, schools,
    // allergies, work pattern). Triggers when the user volunteers info that
    // would change /life intake filtering. Q's persona requires asking first.
    update_life_context: [
        /\b(my )?(daughter|son|child|kid|partner|husband|wife)('s)?\b/i,
        /\byear\s*\d{1,2}\b/i,
        /\b(i'?m|im) (vegan|vegetarian|veggie|gluten[- ]free|dairy[- ]free|lactose|coeliac|allergic)\b/i,
        /\b(allerg(ic|y)|nut[- ]free)\b/i,
        /\bi work\b.*\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|weekend|nights?)\b/i,
    ],
};

// Tools that should always be available when the user has a doc open in
// the editor — set via ?docEditor=1 on the chat call from doc-editor.html.
const DOC_EDITOR_TOOLS = new Set([
    'read_doc', 'replace_text', 'delete_paragraph', 'insert_paragraph',
    'move_paragraph', 'merge_paragraph', 'format_paragraph',
]);

function selectActiveTools(userMessage, options = {}) {
    const msg = String(userMessage || '');
    // Triggers test the CURRENT message plus a bounded window of the recent
    // conversation (options.recentText, built by the caller). Gating on the
    // current message alone broke every multi-turn flow: "make me a QR" put
    // the QR tools in Q's hand, he asked "which number?", and the answer
    // ("07700…") contained no trigger word — so the tools VANISHED on the
    // exact turn he needed them and Q flailed (Sarah, 11 Aug). The window is
    // small, so gated tools still stay off unrelated prompts (the Together
    // 429 bloat the gate exists to prevent).
    const win = msg + '\n' + String(options.recentText || '');
    return TOOL_DEFINITIONS.filter(t => {
        const name = t.function?.name;
        if (!name) return false;
        if (ALWAYS_ON.has(name)) {
            // Inside a case Thread, Q must stay on THIS case and never go rummaging
            // through the user's other situations — not on the first turn, not on
            // any later turn. Reaching into other threads is what made a brand-new
            // "Baby shower" case start "checking saved situations" and trying to
            // connect to unrelated cases, and what dragged old cases into new ones.
            // This block is total on the thread surface.
            // The connection the user DOES value (e.g. council tax <-> CMS) does
            // NOT need these tools: Q carries those facts in his shared memory
            // (injected every turn), so he can still join genuinely related things
            // without pulling the wrong case's file in. read_thread/list_threads
            // stay available on the MAIN chat surface, where "what's happening with
            // my X case" is a legitimate request.
            if ((name === 'read_thread' || name === 'list_threads')
                && options.surface === 'thread') return false;
            return true;
        }
        // Writer coach: Q's tutoring tools are always in his hand there.
        if (options.surface === 'writer-coach' && WRITER_TOOLS.has(name)) return true;
        // Doc-editor page: all doc-editor tools always on
        if (options.docEditor && DOC_EDITOR_TOOLS.has(name)) return true;
        // APS / case mode: research + evidence tools always on (the prompt
        // tells Q to research and build the bundle — he must have the tools).
        if (options.advocate && ADVOCATE_TOOLS.has(name)) return true;
        // The core kit (email/search/calendar/tasklist/docs) is in ALWAYS_ON above,
        // so it's always in Q's hand. Everything else (image/music/video generation,
        // the doc-editor tools) stays trigger-gated — attached only when the user's
        // message asks for it — so it doesn't bloat every prompt and trip Together's
        // token rate limit on big cases.
        const triggers = TRIGGERS[name];
        if (!triggers) return false;
        return triggers.some(rx => rx.test(win));
    });
}

module.exports = {
    TOOL_DEFINITIONS,
    executeTool,
    analyzeDocument,
    selectActiveTools,
    // Direct callers for routes that want to use a tool without going via Q
    webSearch,
    // setQVoiceFromBuffer / clearQVoice / getQVoiceStatus RETIRED 2026-08-15
    // with the /q-voice/* routes — retired/2026-08-15-voice-clone-and-music/
};
