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
1. A list of PDF form fields (name and type)
2. Information the user has provided (text, screenshot, or speech)

Extract the value for every field you can confidently fill. Return a JSON object whose KEYS are the EXACT field names from the list (copy them verbatim, including spaces, ellipses, and odd casing) and whose VALUES are the strings to write into each field.

RULES:
- Match by meaning, not exact wording. "tenant" in the user's info matches a field named "and you the tenant if th...".
- Dates: format as DD/MM/YYYY unless the field name suggests otherwise.
- Checkboxes (type "checkbox"): value is the string "true" or "false".
- Skip fields you don't have info for — omit them entirely. Never guess or invent.
- Output a single JSON object. No prose. No markdown fences. Start with { and end with }.

Example output shape:
{ "TenantName": "Eleanor Hartley", "StartDate": "01/06/2026", "PetsAllowed": "false" }`;

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
    const fieldList = fields.map(f => `- "${f.name}" (${f.type})`).join('\n');
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

    // CRITICAL: regenerate appearance streams so the values are visible in
    // every PDF viewer (Preview, browsers, Acrobat). Without this, values
    // are stored in the field dict but the page shows them as empty until
    // the user clicks each box.
    try {
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        form.updateFieldAppearances(helvetica);
    } catch (e) {
        console.warn('[q-form-filler] updateFieldAppearances failed:', e.message);
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

module.exports = { intakeAndFill, extractFieldValues, fillPdf };
