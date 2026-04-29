/**
 * Q VIDEO — text-to-video via the Wan 2.2 HF Space.
 *
 * POST a prompt + optional knobs, get back an MP4. Space (q-lab/video-space/)
 * runs Wan 2.2 under ZeroGPU. Conservative defaults (16 frames @ 8fps = 2 sec)
 * to fit the 300s per-call cap. Bigger output → upgrade Space hardware.
 */
'use strict';

const { Q_CONFIG } = require('../config');

async function generateVideo(prompt, options = {}) {
    const startTime = Date.now();
    const spaceUrl = (Q_CONFIG.wanSpaceUrl || '').replace(/\/+$/, '');

    if (!spaceUrl) {
        return { video: null, mimeType: '', error: 'WAN_SPACE_URL not set — see q-lab/video-space/README.md', durationMs: 0 };
    }
    if (!prompt || !prompt.trim()) {
        return { video: null, mimeType: '', error: 'No prompt', durationMs: 0 };
    }

    const negativePrompt = options.negativePrompt || '';
    const numFrames = Math.min(Math.max(parseInt(options.numFrames) || 16, 8), 49);
    const fps = Math.min(Math.max(parseInt(options.fps) || 8, 4), 24);
    const steps = Math.min(Math.max(parseInt(options.steps) || 25, 10), 50);
    const seed = typeof options.seed === 'number' ? options.seed : -1;

    try {
        const enqueueRes = await fetch(`${spaceUrl}/gradio_api/call/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [prompt.trim(), negativePrompt, numFrames, fps, steps, seed] }),
        });
        if (!enqueueRes.ok) {
            const errText = await enqueueRes.text();
            return { video: null, mimeType: '', error: `HF Space enqueue HTTP ${enqueueRes.status}: ${errText.substring(0, 200)}`, durationMs: Date.now() - startTime };
        }
        const { event_id } = await enqueueRes.json();
        if (!event_id) return { video: null, mimeType: '', error: 'No event_id from Space', durationMs: Date.now() - startTime };

        const resultRes = await fetch(`${spaceUrl}/gradio_api/call/generate/${event_id}`);
        if (!resultRes.ok) return { video: null, mimeType: '', error: `Result HTTP ${resultRes.status}`, durationMs: Date.now() - startTime };

        const text = await resultRes.text();
        const completeMatch = text.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*?\])\s*\n/);
        if (!completeMatch) {
            const errMatch = text.match(/event:\s*error\s*\ndata:\s*(.+)/);
            return { video: null, mimeType: '', error: errMatch ? errMatch[1].trim() : 'No complete event', durationMs: Date.now() - startTime };
        }
        let payload;
        try { payload = JSON.parse(completeMatch[1]); }
        catch { return { video: null, mimeType: '', error: 'Bad JSON in complete event', durationMs: Date.now() - startTime }; }

        const first = payload[0];
        let videoUrl = null;
        if (first && typeof first === 'object' && first.url) videoUrl = first.url;
        else if (first && typeof first === 'string') videoUrl = first;
        if (!videoUrl) return { video: null, mimeType: '', error: 'No video URL in Space response', durationMs: Date.now() - startTime };

        const vidRes = await fetch(videoUrl);
        if (!vidRes.ok) return { video: null, mimeType: '', error: `Video fetch HTTP ${vidRes.status}`, durationMs: Date.now() - startTime };
        const buf = Buffer.from(await vidRes.arrayBuffer());
        return { video: buf, mimeType: vidRes.headers.get('content-type') || 'video/mp4', durationMs: Date.now() - startTime };
    } catch (err) {
        return { video: null, mimeType: '', error: err.message || String(err), durationMs: Date.now() - startTime };
    }
}

module.exports = { generateVideo };
