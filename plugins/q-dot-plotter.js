/**
 * Q DOT PLOTTER — plot exact pixel coordinates of fillable spaces on a form.
 *
 * Adapted from Quotem's glass-filler.js (the rails detector). Same prompt
 * shape, but routed through Q's own vision (Qwen3.6-Plus on Together AI)
 * instead of Anthropic Claude. The vision model receives a single rendered
 * page image and returns geometry — pin coordinates, not labels.
 *
 * Output shape:
 *   { segments: [{ a: [x, y], b: [x, y] }, ...] }
 *
 * Each segment = a fillable space. For a line/underline, a and b are the
 * left and right ends. For a checkbox, a === b (the centre). Coordinates
 * are top-left origin pixels in the image's native dimensions.
 *
 * No PDF rendering, no text writing, no fill — that's a separate plugin
 * (form-filler, coming next phase). This plugin is purely vision → dots.
 */
'use strict';

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

const PLOTTER_PROMPT = `You are the Plotter — a precision coordinate AI for document form-filling.

YOUR ONLY JOB
Look at the page image and return the pixel coordinates of every fillable answer space on the form. You return geometry, not language. You plot pins, you do not label them.

WHAT COUNTS AS A FILLABLE SPACE
- A printed underline (a row of "____" or a horizontal line)
- An empty box or rectangle sized for typing
- A dotted or dashed line meant for writing
- A signature line
- A checkbox (small empty square)

WHAT IS NOT FILLABLE — NEVER EMIT
- Body paragraph prose (sentences that wrap across multiple lines)
- Section headings, titles, page headers
- Legal or instructional printed text
- A label with no visible blank next to or beneath it

COORDINATE SPACE
Top-left origin. (0,0) is the top-left corner. x increases right. y increases down.
You are told the exact pixel dimensions before the image. Use those EXACT dimensions as your coordinate space — not any other dimensions you perceive.

OUTPUT SHAPE
Return ONLY valid JSON in this shape:
{
  "segments": [
    { "a": [x1, y1], "b": [x2, y2] },
    ...
  ]
}

WHERE TO PLACE A AND B
- Underline / dotted line / signature line: a and b sit ON the line at its two ends. a.y MUST equal b.y. No diagonals.
- Empty typing box: a just inside the left edge, b just inside the right edge, y in the lower third of the box.
- Multi-line address block: one segment per visible row, stacked.
- Checkbox: BOTH a AND b are the SAME coordinate — the centre of the small square. e.g. a 15×15 box at top-left (100,200) → a=[107,207], b=[107,207].

Do NOT return a "label" field. Do NOT describe what each space is for. Just coordinates.`;

async function readStreamAsResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const s = line.replace(/^data: /, '').trim();
            if (!s || s === '[DONE]') continue;
            try {
                const chunk = JSON.parse(s);
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) content += delta.content;
            } catch { /* ignore malformed SSE */ }
        }
    }
    return content;
}

/**
 * Plot fillable-space coordinates on a page image.
 *
 * @param {string} imageDataUrl - data: URL containing a PNG/JPG of the page
 * @param {{ w: number, h: number }} dimensions - exact pixel size of the image
 * @returns {Promise<{ segments: Array<{ a: [number, number], b: [number, number] }> }>}
 */
async function plotDots(imageDataUrl, dimensions) {
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        throw new Error('imageDataUrl required');
    }
    if (!dimensions || !dimensions.w || !dimensions.h) {
        throw new Error('dimensions { w, h } required');
    }

    const response = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: Q_CONFIG.visionModel,
            stream: true,                     // Qwen3.6-Plus is streaming-only on Together
            max_tokens: 4000,
            temperature: 0.0,
            messages: [
                { role: 'system', content: PLOTTER_PROMPT },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `PAGE 0 (${dimensions.w}×${dimensions.h}px) — use these exact pixel dimensions as your coordinate space.` },
                        { type: 'image_url', image_url: { url: imageDataUrl } },
                    ],
                },
            ],
            response_format: { type: 'json_object' },
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Plotter upstream ${response.status}: ${errText.substring(0, 200)}`);
    }

    const text = cleanModelOutput(await readStreamAsResponse(response), 'dot-plotter');
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed || !Array.isArray(parsed.segments)) {
        throw new Error('Plotter returned no segments');
    }
    return parsed;
}

module.exports = { plotDots };
