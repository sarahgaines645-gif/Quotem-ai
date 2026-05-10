'use strict';

// Image generation via OpenAI gpt-image-1.
//
// Best-in-class prompt fidelity (Apr 2026), notably stronger on text and
// logos than FLUX. Uses OPENAI_API_KEY (already provisioned for embeddings
// + Whisper) — no new wiring.
//
// Previous: black-forest-labs/FLUX.1-schnell on Together (drew "vaguely in
// the area" — not specific enough for actual user requests).
//
// Cost: ~$0.04/image medium quality, ~$0.17 high (Apr 2026 pricing).
// Note: OpenAI's content moderation is stricter than Together's — some
// prompts that worked on FLUX may be refused.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const IMAGE_MODEL = 'gpt-image-1';

/**
 * Generate an image from a prompt via OpenAI's images API.
 *
 * @param {string} prompt
 * @param {Object} [options]
 * @param {number} [options.width=1024]   Mapped to nearest supported size.
 * @param {number} [options.height=1024]
 * @param {string} [options.quality]      'low' | 'medium' | 'high' (default medium)
 * @param {string} [options.negativePrompt]  Folded into the prompt — gpt-image-1
 *   has no native negative_prompt field.
 * @returns {Promise<{image: Buffer|null, mimeType: string, error?: string, durationMs: number}>}
 */
async function generateImage(prompt, options = {}) {
    const startTime = Date.now();

    if (!OPENAI_API_KEY) {
        return { image: null, mimeType: '', error: 'OPENAI_API_KEY not set', durationMs: 0 };
    }
    if (!prompt || !prompt.trim()) {
        return { image: null, mimeType: '', error: 'No prompt', durationMs: 0 };
    }

    // gpt-image-1 supports 1024x1024, 1024x1536 (portrait), 1536x1024
    // (landscape), or 'auto'. Map any width/height the caller passed to the
    // closest aspect-ratio match.
    const w = parseInt(options.width) || 1024;
    const h = parseInt(options.height) || 1024;
    const ratio = w / h;
    const size = ratio > 1.15 ? '1536x1024'
              : ratio < 0.87 ? '1024x1536'
              : '1024x1024';

    const quality = options.quality === 'high' ? 'high'
                  : options.quality === 'low' ? 'low'
                  : 'medium';

    const fullPrompt = options.negativePrompt
        ? `${prompt.trim()}\n\nAvoid: ${String(options.negativePrompt).trim()}`
        : prompt.trim();

    const body = {
        model: IMAGE_MODEL,
        prompt: fullPrompt,
        n: 1,
        size,
        quality,
    };

    try {
        const res = await fetch(`${OPENAI_BASE_URL}/images/generations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errText = await res.text();
            return {
                image: null,
                mimeType: '',
                error: `OpenAI HTTP ${res.status}: ${errText.substring(0, 300)}`,
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
