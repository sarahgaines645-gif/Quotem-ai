/**
 * Q GRAPHICS — image-to-SVG via the StarVector HF Space.
 *
 * POST an image (file path or data URL), get back SVG text. The Space
 * (q-lab/graphics-space/) runs StarVector-1B-im2svg under ZeroGPU.
 *
 * Same Gradio-API call pattern as qwen-image-gen.js / qwen-voice-clone.js.
 */
'use strict';

const { Q_CONFIG } = require('../config');

async function vectoriseImage(imageDataUrl) {
    const startTime = Date.now();
    const spaceUrl = (Q_CONFIG.starVectorSpaceUrl || '').replace(/\/+$/, '');

    if (!spaceUrl) {
        return { svg: null, error: 'STARVECTOR_SPACE_URL not set — see q-lab/graphics-space/README.md', durationMs: 0 };
    }
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
        return { svg: null, error: 'imageDataUrl must be a data URL', durationMs: 0 };
    }

    try {
        const enqueueRes = await fetch(`${spaceUrl}/gradio_api/call/vectorise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [{ url: imageDataUrl, meta: { _type: 'gradio.FileData' } }],
            }),
        });
        if (!enqueueRes.ok) {
            const errText = await enqueueRes.text();
            return { svg: null, error: `HF Space enqueue HTTP ${enqueueRes.status}: ${errText.substring(0, 200)}`, durationMs: Date.now() - startTime };
        }
        const { event_id } = await enqueueRes.json();
        if (!event_id) return { svg: null, error: 'No event_id from Space', durationMs: Date.now() - startTime };

        const resultRes = await fetch(`${spaceUrl}/gradio_api/call/vectorise/${event_id}`);
        if (!resultRes.ok) return { svg: null, error: `Result HTTP ${resultRes.status}`, durationMs: Date.now() - startTime };

        const text = await resultRes.text();
        const completeMatch = text.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*?\])\s*\n/);
        if (!completeMatch) {
            const errMatch = text.match(/event:\s*error\s*\ndata:\s*(.+)/);
            return { svg: null, error: errMatch ? errMatch[1].trim() : 'No complete event', durationMs: Date.now() - startTime };
        }
        let payload;
        try { payload = JSON.parse(completeMatch[1]); }
        catch { return { svg: null, error: 'Bad JSON in complete event', durationMs: Date.now() - startTime }; }

        // app.py returns [svg_text, svg_text]
        const svg = Array.isArray(payload) ? payload[0] : payload;
        if (typeof svg !== 'string' || !svg.includes('<svg')) {
            return { svg: null, error: 'Space did not return valid SVG', durationMs: Date.now() - startTime };
        }
        return { svg, durationMs: Date.now() - startTime };
    } catch (err) {
        return { svg: null, error: err.message || String(err), durationMs: Date.now() - startTime };
    }
}

module.exports = { vectoriseImage };
