/**
 * Q IMAGE GENERATION — calls the Z-Image-Turbo Space on HuggingFace
 *
 * Posts a text prompt, gets back a generated PNG.
 *
 * The Space is deployed from q-lab/image-gen-space/. The Space URL lives
 * in Q_CONFIG.zImageSpaceUrl (env var ZIMAGE_SPACE_URL). No per-call cost
 * within the HF ZeroGPU per-user quota.
 *
 * Same Gradio-API call shape as qwen-voice-clone.js — POST to
 * /gradio_api/call/generate, then GET the SSE stream for the result.
 */
'use strict';

const { Q_CONFIG } = require('../config');

/**
 * Generate an image from a prompt.
 *
 * @param {string} prompt - What to draw.
 * @param {Object} [options]
 * @param {string} [options.negativePrompt='']
 * @param {number} [options.steps=8] - Z-Image-Turbo is fast; 4-8 usually enough.
 * @param {number} [options.guidanceScale=1.0]
 * @param {number} [options.seed=-1] - -1 for random.
 * @param {number} [options.width=1024]
 * @param {number} [options.height=1024]
 * @returns {Promise<{image: Buffer|null, mimeType: string, error?: string, durationMs: number}>}
 */
async function generateImage(prompt, options = {}) {
    const startTime = Date.now();
    const spaceUrl = (Q_CONFIG.zImageSpaceUrl || '').replace(/\/+$/, '');

    if (!spaceUrl) {
        return {
            image: null,
            mimeType: '',
            error: 'ZIMAGE_SPACE_URL not set — see q-lab/image-gen-space/README.md to deploy the Space',
            durationMs: 0,
        };
    }
    if (!prompt || !prompt.trim()) {
        return { image: null, mimeType: '', error: 'No prompt', durationMs: 0 };
    }

    const negativePrompt = options.negativePrompt || '';
    const steps = Math.min(Math.max(parseInt(options.steps) || 8, 1), 30);
    const guidanceScale = typeof options.guidanceScale === 'number' ? options.guidanceScale : 1.0;
    const seed = typeof options.seed === 'number' ? options.seed : -1;
    const width = Math.min(Math.max(parseInt(options.width) || 1024, 512), 2048);
    const height = Math.min(Math.max(parseInt(options.height) || 1024, 512), 2048);

    try {
        // Step 1: enqueue
        const enqueueRes = await fetch(`${spaceUrl}/gradio_api/call/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [prompt.trim(), negativePrompt, steps, guidanceScale, seed, width, height],
            }),
        });

        if (!enqueueRes.ok) {
            const errText = await enqueueRes.text();
            return {
                image: null,
                mimeType: '',
                error: `HF Space enqueue HTTP ${enqueueRes.status}: ${errText.substring(0, 200)}`,
                durationMs: Date.now() - startTime,
            };
        }
        const { event_id } = await enqueueRes.json();
        if (!event_id) {
            return { image: null, mimeType: '', error: 'No event_id from Space', durationMs: Date.now() - startTime };
        }

        // Step 2: stream result
        const resultRes = await fetch(`${spaceUrl}/gradio_api/call/generate/${event_id}`);
        if (!resultRes.ok) {
            return {
                image: null,
                mimeType: '',
                error: `HF Space result HTTP ${resultRes.status}`,
                durationMs: Date.now() - startTime,
            };
        }
        const text = await resultRes.text();
        const completeMatch = text.match(/event:\s*complete\s*\ndata:\s*(\[.*\])/);
        if (!completeMatch) {
            const errMatch = text.match(/event:\s*error\s*\ndata:\s*(.+)/);
            const errMsg = errMatch ? errMatch[1].trim() : 'No complete event from Space';
            return { image: null, mimeType: '', error: errMsg, durationMs: Date.now() - startTime };
        }

        let payload;
        try { payload = JSON.parse(completeMatch[1]); }
        catch (e) { return { image: null, mimeType: '', error: 'Bad JSON in complete event', durationMs: Date.now() - startTime }; }

        const first = payload[0];
        let imageUrl = null;
        if (first && typeof first === 'object' && first.url) imageUrl = first.url;
        else if (first && typeof first === 'string') imageUrl = first;
        if (!imageUrl) {
            return { image: null, mimeType: '', error: 'No image URL in Space response', durationMs: Date.now() - startTime };
        }

        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) {
            return {
                image: null,
                mimeType: '',
                error: `Image fetch HTTP ${imgRes.status}`,
                durationMs: Date.now() - startTime,
            };
        }
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        const mimeType = imgRes.headers.get('content-type') || 'image/png';

        return { image: imgBuf, mimeType, durationMs: Date.now() - startTime };
    } catch (err) {
        return {
            image: null,
            mimeType: '',
            error: err.message || String(err),
            durationMs: Date.now() - startTime,
        };
    }
}

module.exports = { generateImage };
