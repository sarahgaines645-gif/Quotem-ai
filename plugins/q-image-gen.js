'use strict';

const { Q_CONFIG } = require('../config');

// Together AI image generation models (cheapest → best quality):
//   FLUX.1-schnell-Free  — free tier, fast, good for drafts
//   FLUX.1-schnell       — paid, same speed, slightly sharper
//   FLUX.1-dev           — paid, best quality, slower
const IMAGE_MODEL = 'black-forest-labs/FLUX.1-schnell-Free';

/**
 * Generate an image from a prompt via Together AI's images API.
 *
 * @param {string} prompt
 * @param {Object} [options]
 * @param {number} [options.steps=4]
 * @param {number} [options.width=1024]
 * @param {number} [options.height=1024]
 * @param {number} [options.seed]
 * @returns {Promise<{image: Buffer|null, mimeType: string, error?: string, durationMs: number}>}
 */
async function generateImage(prompt, options = {}) {
    const startTime = Date.now();

    if (!Q_CONFIG.apiKey) {
        return { image: null, mimeType: '', error: 'TOGETHER_API_KEY not set', durationMs: 0 };
    }
    if (!prompt || !prompt.trim()) {
        return { image: null, mimeType: '', error: 'No prompt', durationMs: 0 };
    }

    const steps  = Math.min(Math.max(parseInt(options.steps) || 4, 1), 12);
    const width  = parseInt(options.width)  || 1024;
    const height = parseInt(options.height) || 1024;

    const body = {
        model: IMAGE_MODEL,
        prompt: prompt.trim(),
        n: 1,
        width,
        height,
        steps,
        response_format: 'b64_json',
    };
    if (typeof options.seed === 'number') body.seed = options.seed;

    try {
        const res = await fetch(`${Q_CONFIG.baseURL}/images/generations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errText = await res.text();
            return {
                image: null,
                mimeType: '',
                error: `Together AI HTTP ${res.status}: ${errText.substring(0, 300)}`,
                durationMs: Date.now() - startTime,
            };
        }

        const json = await res.json();
        const b64 = json?.data?.[0]?.b64_json;
        if (!b64) {
            return { image: null, mimeType: '', error: 'No image data in response', durationMs: Date.now() - startTime };
        }

        return {
            image: Buffer.from(b64, 'base64'),
            mimeType: 'image/png',
            durationMs: Date.now() - startTime,
        };
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
