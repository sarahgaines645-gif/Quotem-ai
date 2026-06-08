'use strict';

/**
 * Q FORM FILLER
 *
 * Intake pipeline: user gives Q information (text, screenshot, or transcribed voice).
 * Q extracts the values for each PDF field, then pdf-lib writes them into the PDF.
 *
 * Flow:
 *   1. Receive: field list + raw info text (+ optional screenshot image)
 *   2. Call Q (DeepSeek V4 Pro or vision if screenshot) to map info → field values
 *   3. pdf-lib writes values into the PDF bytes
 *   4. Return filled PDF bytes as Buffer
 */

const { PDFDocument, StandardFonts, PDFName, rgb } = require('pdf-lib');
const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

const EXTRACT_SYSTEM = `You are a form-filling assistant. Your output is ALWAYS a single JSON object — never prose, never markdown, never an explanation.

You receive:
1. A list of PDF form fields. Each has a NAME, a TYPE, and CONTEXT — the actual surrounding form text (what comes above/before/after the blank space on the page). The context shows you what the form is really asking for.
2. Information the user has provided (text, screenshot, or speech).

Return a SINGLE JSON object with exactly two keys:
{
  "values": { "<exact field name>": "<value to write>", ... },
  "ask":    [ { "field": "<exact field name>", "question": "<short plain-English question to the user>" }, ... ]
}

"values" = ONLY the fields you can fill with HIGH CONFIDENCE directly from the information provided. Copy field names VERBATIM (including spaces, ellipses, odd casing).

"ask" = every field the form needs that you could NOT fill — because the information doesn't contain it, or it's genuinely ambiguous which value belongs in that blank. For each, write a short, friendly question asking the user for exactly that piece of information.

THE RULE THAT MATTERS MOST — NEVER MAKE ANYTHING UP:
- Do NOT invent, guess, or assume a value. If the provided information does not clearly contain it, it goes in "ask", NOT in "values". A blank you asked about is RIGHT; a value you invented is WRONG and worse than blank.
- Do NOT drop a name into a field just because the field mentions a role you happen to have a name for. If a clause is conditional or it is unclear WHICH person/value belongs in the blank (e.g. "appoint a lead tenant to manage the deposit, ___"), ASK — do not guess.
- Never fabricate scheme names, reference numbers, addresses, account names, or dates. If it is not in the data, ASK.

OTHER RULES:
- USE THE CONTEXT, not just the name. A field named "as a contractual" with context "before: 'and then continues on from' | after: 'monthly tenancy'" wants the type of periodic tenancy (e.g. "periodic"), NOT the whole phrase.
- A field name that looks like a sentence fragment is usually the LABEL just before the blank — read the after-context to see what value goes there.
- Match user info to fields by MEANING. "Tenant: Eleanor Hartley" → the field whose context asks for the tenant's name.
- RESOLVE ROLES TO THE ACTUAL VALUE: "deposit held by" / "payable to" / "the landlord" → the landlord's real name from the data, NOT the word "landlord".
- Dates: format as DD/MM/YYYY unless the context suggests otherwise.
- Checkboxes (type "checkbox"): value is "true" or "false".
- Do NOT ask about signature fields, and do NOT ask about a field you already put in "values".
- Output a single JSON object. No prose. No markdown fences. Start with { and end with }.

Example:
Fields: "as a fixed term for" (text, context "before: 'a tenancy that begins on [date]' | after: 'months and the rent is'"); "deposit scheme name" (text)
User info: "Term: 12 months, starting 1st June 2026. Landlord: Sterling Estate Group."
→ { "values": { "as a fixed term for": "12" }, "ask": [ { "field": "deposit scheme name", "question": "Which deposit protection scheme is the deposit registered with?" } ] }
("12" not "12 months" — the word "months" is already on the form; and the scheme name was NOT in the data, so ASK — never invent it.)`;

async function readStreamText(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let reasoning = '';
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const s = line.replace(/^data: /, '').trim();
            if (!s || s === '[DONE]') continue;
            try {
                const chunk = JSON.parse(s);
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) text += delta.content;
                // Thinking-mode quirk on Together AI: Kimi K2.5 / V4 Pro sometimes
                // stream the answer as reasoning_content with content left empty.
                // Mirror the fallback in q-chat.js / q-finance.js so it isn't lost.
                if (delta?.reasoning_content) reasoning += delta.reasoning_content;
                else if (delta?.reasoning) reasoning += delta.reasoning;
            } catch { /* ignore */ }
        }
    }
    return (text && text.trim()) ? text : reasoning;
}

/**
 * Extract field values from user-provided info using Q.
 *
 * @param {Array<{name:string, type:string}>} fields
 * @param {string} infoText  — raw text (pasted, transcribed, or OCR'd)
 * @param {string|null} imageDataUrl — optional screenshot
 * @returns {Promise<Object>} — { fieldName: value }
 */
async function extractFieldValues(fields, infoText, imageDataUrl = null) {
    const fieldList = fields.map(f => {
        const lbl = f.label ? `\n   LABEL: ${f.label}` : '';
        const ctx = f.context ? `\n   CONTEXT: ${f.context}` : '';
        const pg  = f.page ? ` [page ${f.page}]` : '';
        return `- name: "${f.name}" (${f.type})${pg}${lbl}${ctx}`;
    }).join('\n');
    const userContent = `FORM FIELDS — match user info to fields by their LABEL first (a clear human description of what each blank wants). The CONTEXT shows where the blank sits in the form's actual sentence — use it to disambiguate when the label isn't enough. The "name" is just the raw PDF identifier and is often misleading; do not match against it.

${fieldList}

INFORMATION PROVIDED BY THE USER:
${infoText || '(none)'}`;

    const isVision = !!imageDataUrl;
    // Text path: use the fast model — extraction is structural, doesn't need
    // V4 Pro's deep reasoning. Vision path keeps the multimodal model.
    const model = isVision
        ? Q_CONFIG.visionModel
        : (Q_CONFIG.fastModel || Q_CONFIG.model);

    let messages;
    if (isVision) {
        messages = [
            { role: 'system', content: EXTRACT_SYSTEM },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `FORM FIELDS:\n${fieldList}\n\nPlease extract the relevant information from the screenshot below and fill in as many fields as possible.` },
                    { type: 'image_url', image_url: { url: imageDataUrl } },
                ],
            },
        ];
    } else {
        messages = [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: userContent },
        ];
    }

    const body = {
        model,
        stream: isVision,
        max_tokens: 4096,
        temperature: 0.0,
        messages,
    };
    // Vision path streams; text path relies on the strict system prompt for JSON output.

    const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Q extraction failed ${response.status}: ${err.slice(0, 200)}`);
    }

    let raw;
    if (isVision) {
        raw = await readStreamText(response);
    } else {
        const data = await response.json();
        const msg = data.choices?.[0]?.message || {};
        // DeepSeek-V4-Pro thinking-mode quirk on Together: the answer sometimes
        // lands in reasoning_content/reasoning with content left empty. Mirror the
        // fallback already used in q-chat.js and q-finance.js.
        raw = (msg.content && msg.content.trim())
            ? msg.content
            : (msg.reasoning_content || msg.reasoning || '');
    }
    raw = cleanModelOutput(raw, 'form-filler');

    if (!raw || !raw.trim()) {
        console.error('[q-form-filler] Q returned empty content. Model:', model);
        throw new Error('Q returned an empty response — try again.');
    }

    // Strip markdown fences if present
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Find the JSON object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
        console.error('[q-form-filler] Q returned non-JSON. Raw response:', raw.slice(0, 500));
        throw new Error(`Q returned text instead of JSON: "${raw.slice(0, 120)}…"`);
    }

    let parsed;
    try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (parseErr) {
        console.error('[q-form-filler] JSON parse failed. Raw:', raw.slice(0, 500));
        throw new Error('Q returned malformed JSON — try again.');
    }

    // New shape: { values, ask }. Back-compat: a bare { field: value } object
    // (no "values"/"ask" keys) is treated as values with nothing to ask.
    const hasNewShape = parsed && typeof parsed === 'object' &&
        (parsed.values !== undefined || parsed.ask !== undefined);
    const values = hasNewShape ? (parsed.values || {}) : (parsed || {});
    const ask = (hasNewShape && Array.isArray(parsed.ask)) ? parsed.ask : [];
    return { values, ask };
}

/**
 * Write extracted values into a PDF and return filled bytes.
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {Object} values — { fieldName: value }
 * @returns {Promise<Uint8Array>}
 */
async function fillPdf(pdfBytes, values) {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const results = { filled: [], skipped: [], notFound: [] };

    // Build annotation-ref → page map as a fallback for PDFs whose widgets
    // don't carry a /P (page pointer) entry.
    const refKeyToPage = new Map();
    for (const page of pages) {
        let annots;
        try { annots = page.node.lookup(PDFName.of('Annots')); } catch { continue; }
        if (!annots || typeof annots.size !== 'function') continue;
        for (let i = 0; i < annots.size(); i++) {
            const ref = annots.get(i);
            if (ref) refKeyToPage.set(ref.toString(), page);
        }
    }

    function pageForWidget(widget) {
        // Standard PDF: widget annotation has /P pointing to its page
        try {
            const pRef = widget.dict.get(PDFName.of('P'));
            if (pRef) {
                const pageNode = pdfDoc.context.lookup(pRef);
                const found = pages.find(p => p.node === pageNode);
                if (found) return found;
            }
        } catch { /* fall through to scan */ }
        // Fallback: scan every page's annotation list
        for (const [ref, obj] of pdfDoc.context.indirectObjects) {
            if (obj === widget.dict) return refKeyToPage.get(ref.toString()) || null;
        }
        return null;
    }

    // Collect draw instructions BEFORE flatten — widgets disappear after it.
    const draws = [];

    for (const [name, value] of Object.entries(values)) {
        try {
            const field = form.getField(name);
            const type = field.constructor.name;
            const widgets = field.acroField.getWidgets();
            if (type === 'PDFTextField') {
                const text = String(value ?? '');
                for (const w of widgets) {
                    const page = pageForWidget(w);
                    if (page) draws.push({ page, rect: w.getRectangle(), text, isCheck: false });
                }
                results.filled.push(name);
            } else if (type === 'PDFCheckBox') {
                const v = String(value).toLowerCase();
                if (v === 'true' || v === 'yes' || v === '1') {
                    for (const w of widgets) {
                        const page = pageForWidget(w);
                        if (page) draws.push({ page, rect: w.getRectangle(), text: 'X', isCheck: true });
                    }
                }
                results.filled.push(name);
            } else if (type === 'PDFDropdown' || type === 'PDFListBox') {
                const options = field.getOptions();
                const match = options.find(o => o.toLowerCase() === String(value).toLowerCase()) || options[0];
                if (match) {
                    for (const w of widgets) {
                        const page = pageForWidget(w);
                        if (page) draws.push({ page, rect: w.getRectangle(), text: match, isCheck: false });
                    }
                    results.filled.push(name);
                } else results.skipped.push(name);
            } else {
                results.skipped.push(name);
            }
        } catch {
            results.notFound.push(name);
        }
    }

    // Flatten first — burns in any pre-baked field appearances (blank boxes on
    // NRLA-style forms) and removes the widget annotations. We never called
    // setText/check/select, so no values are stored — flatten just cleans up.
    try { form.flatten(); } catch (e) { console.warn('[q-form-filler] flatten:', e.message); }

    // Draw values AFTER flatten so our text is on top of everything.
    // y = rect.y + 1 puts the baseline at the very bottom of the field rect —
    // the same Y as surrounding body text. Word groups text into lines by Y
    // position, so this keeps filled values on the right line when converting.
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (const { page, rect, text, isCheck } of draws) {
        if (isCheck) {
            const size = Math.min(rect.height, rect.width) * 0.7;
            page.drawText('X', {
                x: rect.x + (rect.width - size * 0.55) / 2,
                y: rect.y + 1,
                size,
                font: helvetica,
                color: rgb(0, 0, 0),
            });
        } else {
            const fontSize = Math.min(Math.max(rect.height * 0.65, 8), 11);
            page.drawText(text, {
                x: rect.x + 2,
                y: rect.y + 1,
                size: fontSize,
                font: helvetica,
                color: rgb(0, 0, 0),
                maxWidth: rect.width - 4,
                lineHeight: fontSize * 1.15,
            });
        }
    }

    const filledBytes = await pdfDoc.save();
    return { filledBytes, results };
}

/**
 * Full pipeline: intake info → extract values → fill PDF → return bytes.
 *
 * @param {object} opts
 * @param {Buffer}  opts.pdfBytes
 * @param {Array}   opts.fields          — [{ name, type }]
 * @param {string}  opts.infoText        — pasted / transcribed info
 * @param {string}  [opts.imageDataUrl]  — optional screenshot
 * @returns {Promise<{ filledBytes, values, results }>}
 */
async function intakeAndFill({ pdfBytes, fields, infoText, imageDataUrl }) {
    const { values } = await extractFieldValues(fields, infoText, imageDataUrl || null);
    const { filledBytes, results } = await fillPdf(pdfBytes, values);
    return { filledBytes, values, results };
}

/**
 * Generate clean human labels for every field using BOTH inputs:
 *   - Rendered page images with numbered pink tags on each field
 *   - The extracted document text in reading order
 *
 * The numbered tags bridge the two inputs: Q can see tag 5 sits in a box
 * on the page, AND read "first payment of £" in the text right next to it,
 * and correlate them. Each input compensates for the other's weakness —
 * vision handles layout/structure, text gives reliable word access.
 *
 * @param {Array<string>} pageImages — data URLs (JPEG) for each page with tags drawn on
 * @param {number} totalTags — number of fields tagged
 * @param {string} documentText — extracted form text in reading order (no markers)
 * @returns {Promise<Object>} — { tagNumberAsString: humanLabel }
 */
async function labelFields(pageImages, totalTags, documentText = '') {
    const userText = `Each fillable field on these form pages is marked with a numbered pink tag (1, 2, 3 …) drawn on the rendered image. You also have the extracted form text below for reference.

Use BOTH inputs together: look at the page image to see which numbered tag sits where, then use the text to read the surrounding sentences accurately. Cross-reference them — the tag in the image and the words around it in the text describe the same blank.

For every numbered tag, work out what the user should write in that blank. Return a JSON object whose keys are the tag numbers (as strings: "1", "2", …) and values are short labels (2–6 words). There are ${totalTags} tags total — return a label for every one.

EXTRACTED TEXT (for reference alongside the images):
${documentText || '(no text extracted)'}`;

    const content = [
        { type: 'text', text: userText },
        ...pageImages.map(url => ({ type: 'image_url', image_url: { url } })),
    ];

    const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            // Vision model — Qwen3.6-Plus on Together. Streaming-only.
            model: Q_CONFIG.visionModel,
            stream: true,
            max_tokens: 6000,
            temperature: 0.0,
            messages: [{ role: 'user', content }],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Label upstream ${response.status}: ${err.slice(0, 200)}`);
    }
    const raw = await readStreamText(response);
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
        console.error('[q-form-filler] Vision label returned non-JSON:', raw.slice(0, 500));
        throw new Error('Vision label returned no JSON');
    }
    return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Fill a PDF for Word export — sets values via AcroForm API without flattening.
 * LibreOffice reads the /V entries directly and positions text correctly when
 * converting to .docx. Do not use for PDF download (appearance streams vary).
 */
async function fillPdfForWord(pdfBytes, values) {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const results = { filled: [], skipped: [], notFound: [] };

    for (const [name, value] of Object.entries(values)) {
        try {
            const field = form.getField(name);
            const type = field.constructor.name;
            if (type === 'PDFTextField') {
                field.setText(String(value ?? ''));
                results.filled.push(name);
            } else if (type === 'PDFCheckBox') {
                const v = String(value).toLowerCase();
                if (v === 'true' || v === 'yes' || v === '1') field.check();
                else field.uncheck();
                results.filled.push(name);
            } else if (type === 'PDFDropdown' || type === 'PDFListBox') {
                const options = field.getOptions();
                const match = options.find(o => o.toLowerCase() === String(value).toLowerCase()) || options[0];
                if (match) { field.select(match); results.filled.push(name); }
                else results.skipped.push(name);
            } else {
                results.skipped.push(name);
            }
        } catch {
            results.notFound.push(name);
        }
    }

    try {
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        form.updateFieldAppearances(helvetica);
    } catch (e) {
        console.warn('[q-form-filler] updateFieldAppearances failed:', e.message);
    }

    const filledBytes = await pdfDoc.save();
    return { filledBytes, results };
}

module.exports = { intakeAndFill, extractFieldValues, fillPdf, fillPdfForWord, labelFields };
