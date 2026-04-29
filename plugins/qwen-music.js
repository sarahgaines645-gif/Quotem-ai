/**
 * Q MUSIC — text-to-music via the ACE-Step HF Space.
 *
 * POST a style prompt (+ optional lyrics + duration), get back WAV audio.
 * Space (q-lab/music-space/) runs ACE-Step under ZeroGPU.
 */
'use strict';

const { Q_CONFIG } = require('../config');

async function generateMusic(prompt, options = {}) {
    const startTime = Date.now();
    const spaceUrl = (Q_CONFIG.aceStepSpaceUrl || '').replace(/\/+$/, '');

    if (!spaceUrl) {
        return { audio: null, mimeType: '', error: 'ACESTEP_SPACE_URL not set — see q-lab/music-space/README.md', durationMs: 0 };
    }
    if (!prompt || !prompt.trim()) {
        return { audio: null, mimeType: '', error: 'No prompt', durationMs: 0 };
    }

    const lyrics = options.lyrics || '';
    const duration = Math.min(Math.max(parseFloat(options.duration) || 30, 10), 120);
    const seed = typeof options.seed === 'number' ? options.seed : -1;

    try {
        const enqueueRes = await fetch(`${spaceUrl}/gradio_api/call/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [prompt.trim(), lyrics, duration, seed] }),
        });
        if (!enqueueRes.ok) {
            const errText = await enqueueRes.text();
            return { audio: null, mimeType: '', error: `HF Space enqueue HTTP ${enqueueRes.status}: ${errText.substring(0, 200)}`, durationMs: Date.now() - startTime };
        }
        const { event_id } = await enqueueRes.json();
        if (!event_id) return { audio: null, mimeType: '', error: 'No event_id from Space', durationMs: Date.now() - startTime };

        const resultRes = await fetch(`${spaceUrl}/gradio_api/call/generate/${event_id}`);
        if (!resultRes.ok) return { audio: null, mimeType: '', error: `Result HTTP ${resultRes.status}`, durationMs: Date.now() - startTime };

        const text = await resultRes.text();
        const completeMatch = text.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*?\])\s*\n/);
        if (!completeMatch) {
            const errMatch = text.match(/event:\s*error\s*\ndata:\s*(.+)/);
            return { audio: null, mimeType: '', error: errMatch ? errMatch[1].trim() : 'No complete event', durationMs: Date.now() - startTime };
        }
        let payload;
        try { payload = JSON.parse(completeMatch[1]); }
        catch { return { audio: null, mimeType: '', error: 'Bad JSON in complete event', durationMs: Date.now() - startTime }; }

        const first = payload[0];
        let audioUrl = null;
        if (first && typeof first === 'object' && first.url) audioUrl = first.url;
        else if (first && typeof first === 'string') audioUrl = first;
        if (!audioUrl) return { audio: null, mimeType: '', error: 'No audio URL in Space response', durationMs: Date.now() - startTime };

        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) return { audio: null, mimeType: '', error: `Audio fetch HTTP ${audioRes.status}`, durationMs: Date.now() - startTime };
        const buf = Buffer.from(await audioRes.arrayBuffer());
        return { audio: buf, mimeType: audioRes.headers.get('content-type') || 'audio/wav', durationMs: Date.now() - startTime };
    } catch (err) {
        return { audio: null, mimeType: '', error: err.message || String(err), durationMs: Date.now() - startTime };
    }
}

module.exports = { generateMusic };
