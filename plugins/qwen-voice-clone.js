/**
 * Q VOICE CLONING — calls the Chatterbox Space on HuggingFace
 *
 * Posts text + a reference audio clip, gets back audio of Q speaking
 * the text in that voice. Reference clips are short (5–15 sec).
 *
 * The Space is deployed from q-lab/voice-cloning-space/. The Space URL
 * lives in Q_CONFIG.chatterboxSpaceUrl (env var CHATTERBOX_SPACE_URL).
 *
 * No per-call cost — HF ZeroGPU free tier (per-user quota, ~600 sec/day).
 */
'use strict';

const { Q_CONFIG } = require('../config');

/**
 * Generate cloned-voice speech.
 *
 * @param {string} text - What Q should say.
 * @param {Buffer} referenceAudio - Reference voice clip (raw audio bytes — wav/mp3/webm).
 * @param {string} referenceMimeType - MIME type of the reference (e.g. 'audio/webm').
 * @param {Object} [options]
 * @param {number} [options.exaggeration=0.5] - 0–1, higher = more emotive.
 * @param {number} [options.cfgWeight=0.5] - 0–1, lower = slower pacing.
 * @returns {Promise<{audio: Buffer|null, mimeType: string, error?: string, durationMs: number}>}
 */
async function speakAsVoice(text, referenceAudio, referenceMimeType, options = {}) {
    const startTime = Date.now();
    const spaceUrl = (Q_CONFIG.chatterboxSpaceUrl || '').replace(/\/+$/, '');

    if (!spaceUrl) {
        return {
            audio: null,
            mimeType: '',
            error: 'CHATTERBOX_SPACE_URL not set — see q-lab/voice-cloning-space/README.md to deploy the Space',
            durationMs: 0,
        };
    }
    if (!text || !text.trim()) {
        return { audio: null, mimeType: '', error: 'No text to speak', durationMs: 0 };
    }
    if (!referenceAudio || referenceAudio.length === 0) {
        return { audio: null, mimeType: '', error: 'No reference audio', durationMs: 0 };
    }

    const exaggeration = typeof options.exaggeration === 'number' ? options.exaggeration : 0.5;
    const cfgWeight = typeof options.cfgWeight === 'number' ? options.cfgWeight : 0.5;

    try {
        // Gradio's HTTP API: POST /gradio_api/call/generate with JSON body, then GET the result.
        // Reference audio is sent as a base64 data URL — Gradio's audio file input accepts that.
        const referenceB64 = referenceAudio.toString('base64');
        const referenceDataUrl = `data:${referenceMimeType || 'audio/webm'};base64,${referenceB64}`;

        // Step 1: POST to enqueue the call.
        const enqueueRes = await fetch(`${spaceUrl}/gradio_api/call/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [
                    text.trim(),
                    { url: referenceDataUrl, meta: { _type: 'gradio.FileData' } },
                    exaggeration,
                    cfgWeight,
                ],
            }),
        });

        if (!enqueueRes.ok) {
            const errText = await enqueueRes.text();
            return {
                audio: null,
                mimeType: '',
                error: `HF Space enqueue HTTP ${enqueueRes.status}: ${errText.substring(0, 200)}`,
                durationMs: Date.now() - startTime,
            };
        }

        const { event_id } = await enqueueRes.json();
        if (!event_id) {
            return { audio: null, mimeType: '', error: 'No event_id from Space', durationMs: Date.now() - startTime };
        }

        // Step 2: GET /gradio_api/call/generate/{event_id} as a stream of SSE events.
        // The "complete" event carries the result — a Gradio FileData object pointing to the WAV.
        const resultRes = await fetch(`${spaceUrl}/gradio_api/call/generate/${event_id}`);
        if (!resultRes.ok || !resultRes.body) {
            return {
                audio: null,
                mimeType: '',
                error: `HF Space result HTTP ${resultRes.status}`,
                durationMs: Date.now() - startTime,
            };
        }

        const text_body = await resultRes.text();
        // SSE: lines like "event: complete\ndata: [...]\n\n"
        // We just want the data line after "event: complete".
        const completeMatch = text_body.match(/event:\s*complete\s*\ndata:\s*(\[.*\])/);
        if (!completeMatch) {
            const errMatch = text_body.match(/event:\s*error\s*\ndata:\s*(.+)/);
            const errMsg = errMatch ? errMatch[1].trim() : 'No complete event from Space';
            return { audio: null, mimeType: '', error: errMsg, durationMs: Date.now() - startTime };
        }

        let payload;
        try {
            payload = JSON.parse(completeMatch[1]);
        } catch (e) {
            return { audio: null, mimeType: '', error: 'Bad JSON in complete event', durationMs: Date.now() - startTime };
        }

        // Gradio audio output is [sample_rate, samples] OR a FileData {url, ...}.
        // ZeroGPU SDK serializes np.ndarray returns as a FileData URL we can fetch.
        const first = payload[0];
        let audioUrl = null;
        if (first && typeof first === 'object' && first.url) {
            audioUrl = first.url;
        } else if (first && typeof first === 'string') {
            audioUrl = first;
        }
        if (!audioUrl) {
            return { audio: null, mimeType: '', error: 'No audio URL in Space response', durationMs: Date.now() - startTime };
        }

        // Fetch the actual audio bytes.
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
            return {
                audio: null,
                mimeType: '',
                error: `Audio fetch HTTP ${audioRes.status}`,
                durationMs: Date.now() - startTime,
            };
        }
        const audioBuf = Buffer.from(await audioRes.arrayBuffer());
        const mimeType = audioRes.headers.get('content-type') || 'audio/wav';

        return {
            audio: audioBuf,
            mimeType,
            durationMs: Date.now() - startTime,
        };
    } catch (err) {
        return {
            audio: null,
            mimeType: '',
            error: err.message || String(err),
            durationMs: Date.now() - startTime,
        };
    }
}

module.exports = { speakAsVoice };
