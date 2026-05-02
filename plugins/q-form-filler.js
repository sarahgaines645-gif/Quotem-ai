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

const { PDFDocument, StandardFonts } = require('pdf-lib');
const { Q_CONFIG } = require('../config');

const EXTRACT_SYSTEM = `You are a form-filling assistant. Your output is ALWAYS a single JSON object — never prose, never markdown, never an explanation.

You receive:
1. A list of PDF form fields. Each has a NAME, a TYPE, and CONTEXT — the actual surrounding form text (what comes above/before/after the blank space on the page). The context shows you what the form is really asking for.
2. Information the user has provided (text, screenshot, or speech).

Extract the value for every field you can confidently fill. Return a JSON object whose KEYS are the EXACT field names from the list (copy them verbatim, including spaces, ellipses, and odd casing) and whose VALUES are the strings to write into each field.

RULES — READ CAREFULLY:
- USE THE CONTEXT, not just the name. A field named "as a contractual" with context "before: 'and then continues on from' | after: 'monthly tenancy'" is asking for the type of periodic tenancy (e.g. "periodic"), NOT the entire phrase.
- A field name that looks like a sentence fragment is usually the LABEL just before the blank — read the after-context to see what kind of value goes there.
- Match user info to fields by MEANING. "Tenant: Eleanor Hartley" maps to a field whose context shows it's asking for the tenant's name.
- Dates: format as DD/MM/YYYY unless the context suggests otherwise.
- Checkboxes (type "checkbox"): value is "true" or "false".
- If a field's context isn't clear and you don't have an obvious match, OMIT it. Never guess or fabricate. Half-filled correctly beats fully-filled with wrong values.
- Output a single JSON object. No prose. No markdown fences. Start with { and end with }.

Example:
Field: { name: "as a fixed term for", context: "before: 'a single tenancy that begins on [date]' | after: 'months and the rent is'" }
User info: "Term: 12 months, starting 1st June 2026"
→ output: { "as a fixed term for": "12" }   (NOT "12 months" — the word "months" is already in the form)`;

async function readStreamText(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
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
            } catch { /* ignore */ }
        }
    }
    return text;
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
        const ctx = f.context ? `\n   context: ${f.context}` : '';
        const pg  = f.page ? ` [page ${f.page}]` : '';
        return `- "${f.name}" (${f.type})${pg}${ctx}`;
    }).join('\n');
    const userContent = `FORM FIELDS:\n${fieldList}\n\nINFORMATION PROVIDED:\n${infoText || '(none)'}`;

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
    // Force JSON output for the text path (vision streams it; we keep the prompt strict instead)
    if (!isVision) body.response_format = { type: 'json_object' };

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
        raw = data.choices?.[0]?.message?.content || '';
    }

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

    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch (parseErr) {
        console.error('[q-form-filler] JSON parse failed. Raw:', raw.slice(0, 500));
        throw new Error('Q returned malformed JSON — try again.');
    }
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

    // CRITICAL: regenerate appearance streams so the values render. NRLA-
    // style PDFs have pre-baked empty appearance dictionaries that override
    // setText() — without this step, values are stored but display blank.
    try {
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        form.updateFieldAppearances(helvetica);
    } catch (e) {
        console.warn('[q-form-filler] updateFieldAppearances failed:', e.message);
    }

    // Flatten the form: convert every field's value into static page content.
    // After this the PDF can no longer be edited interactively, but the values
    // are guaranteed to display in any viewer (Preview, browsers, Acrobat).
    // This is the right tradeoff for "filled and ready to send/print" output.
    try {
        form.flatten();
    } catch (e) {
        console.warn('[q-form-filler] flatten failed:', e.message);
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
    const values = await extractFieldValues(fields, infoText, imageDataUrl || null);
    const { filledBytes, results } = await fillPdf(pdfBytes, values);
    return { filledBytes, values, results };
}

/**
 * Generate clean human labels for every field by reading the surrounding
 * form text. AcroForm field names are usually a sentence fragment from the
 * end of the line ("as a contractual", "and then continues on from"); they
 * tell you nothing about what the field actually wants. This function reads
 * the context and produces short human labels like "Tenancy type" or
 * "Continuation start".
 *
 * @param {Array<{name, type, page, context}>} fields
 * @returns {Promise<Object>} — { fieldName: humanLabel }
 */
async function labelFields(fields) {
    const fieldLines = fields.map((f, i) => {
        const ctx = f.context ? `\n   PASSAGE:\n${f.context.split('\n').map(l => '     ' + l).join('\n')}` : '';
        return `[${i+1}] name: "${f.name}"  type: ${f.type}${ctx}`;
    }).join('\n\n');

    const system = `You are labeling form fields. For each field you receive:
  - a NAME (often a meaningless sentence fragment from the form layout)
  - a TYPE (text, checkbox, etc.)
  - a PASSAGE: several lines of the actual form text, with [BLANK] marking exactly where the field appears.

Your job: READ THE WHOLE PASSAGE. Understand what role the [BLANK] plays in the sentence. Produce a SHORT human label (2-5 words) describing what the user should write into that blank.

CRITICAL RULES:
1. You must read the words IMMEDIATELY before AND after [BLANK] to understand its role. Then read further out for the section/topic.
2. Never just rephrase the field name. The name is often misleading.
3. Markers are decisive:
   - "£[BLANK]" → it's a money AMOUNT
   - "begins on [BLANK]" / "starting [BLANK]" / "dated [BLANK]" → it's a DATE
   - "for [BLANK] months" / "for [BLANK] weeks" → it's a NUMBER (term length)
   - "every [BLANK]" → frequency word ("month", "week")
   - "by [BLANK]" after "paid" → a PAYMENT DATE
   - "to [BLANK]" after "paid" → a RECIPIENT (name or account)
   - "in cleared funds to [BLANK]" → bank/recipient details
4. Use the section heading from the passage. If the passage starts with "Rent" the field relates to rent.

WORKED EXAMPLES:

Field name: "as a fixed term for"
PASSAGE:
  Term
  This agreement creates a single tenancy that begins on [DATE] [BLANK] months and the rent is
LABEL: "Term length (months)"
(reasoning: "for [BLANK] months" — the blank is the NUMBER of months, not a date)

Field name: "and then continues on from"
PASSAGE:
  as a fixed term for [N] months [BLANK] as a contractual
  periodic tenancy
LABEL: "Fixed term end date"
(reasoning: "continues on from [BLANK] as a contractual periodic tenancy" — the blank is the date the periodic part starts)

Field name: "must be paid in advance by"
PASSAGE:
  Rent
  The first payment of £[AMOUNT] must be paid in advance by [BLANK].
LABEL: "First payment date"
(reasoning: "paid in advance by [BLANK]" — date, not amount)

Field name: "First payment due"
PASSAGE:
  Rent
  The first payment of £[BLANK] must be paid in advance by [DATE].
LABEL: "First payment amount"
(reasoning: "£[BLANK] must be paid" — the £ marker decides this is an amount)

Field name: "every"
PASSAGE:
  Subsequent rent payments of £[N] must be paid in advance by [DATE] every [BLANK]
  while the tenancy lasts.
LABEL: "Payment frequency"
(reasoning: "every [BLANK] while the tenancy lasts" — frequency word like "month")

Field name: "We will let out the room"
PASSAGE:
  We will let out the room [BLANK] at [ADDRESS]
  to you as well as any furniture, fixtures and household belongings
LABEL: "Room name or number"
(reasoning: "the room [BLANK] at [address]" — the blank is what identifies the room, not the address)

Field name: "at"
PASSAGE:
  We will let out the room [ROOM-NAME] at [BLANK]
  to you as well as any furniture, fixtures and household belongings
LABEL: "Property address"
(reasoning: "the room ... at [BLANK]" — the blank is the address of the property)

OUTPUT:
A single JSON object mapping each EXACT field name (verbatim — copy character-for-character) to its label. No prose, no markdown, no explanation. Start with { and end with }.`;

    const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            // Use the proper brain — V4 Pro reasons through sentence roles, the
            // fast model just word-shuffles. Labelling is one-time per PDF so the
            // extra latency is fine.
            model: Q_CONFIG.model,
            max_tokens: 4096,
            temperature: 0.0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: `FIELDS:\n${fieldLines}` },
            ],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Label upstream ${response.status}: ${err.slice(0, 200)}`);
    }
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Q returned no labels');
    return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = { intakeAndFill, extractFieldValues, fillPdf, labelFields };
