---
title: Q Voice Cloning
emoji: 🎙️
colorFrom: pink
colorTo: gray
sdk: gradio
sdk_version: 5.0.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zero-a10g
---

# Q's Voice Cloning Space

Chatterbox-powered TTS endpoint that lets Q speak in any voice from a 5–15 second reference clip.
Internal use only — called by Q's chat at `/api/q-lab/speak-as-voice`.

## Setup (one-time, ~15 minutes)

1. Go to https://huggingface.co/new-space
2. **Owner**: your HF account
3. **Space name**: `q-voice-cloning` (or anything — you'll paste the URL into Quotem)
4. **License**: Apache-2.0
5. **SDK**: Gradio
6. **Hardware**: ZeroGPU (free tier — H200 burst, ~600 sec/day quota)
7. **Visibility**: Public is fine (it's just a TTS endpoint, no secrets)
8. Create
9. In the new Space's **Files** tab, upload all three files from this folder:
   - `app.py`
   - `requirements.txt`
   - `README.md`
10. The Space will build (~10–15 minutes first time, watch the **Logs** tab)
11. Once it shows "Running", grab the URL — it'll look like `https://YOUR-USERNAME-q-voice-cloning.hf.space`
12. Set that URL as the `CHATTERBOX_SPACE_URL` env var on Quotem's Railway service

## Using the API

The Space exposes a Gradio endpoint at `/api/predict` that takes:
- `text`: string to speak
- `reference_audio`: file path or base64 audio
- `exaggeration`: 0.0–1.0 (default 0.5, higher = more emotive)
- `cfg_weight`: 0.0–1.0 (default 0.5, pacing)

Returns a WAV blob.

The Q chat client uses `@gradio/client` style calls via the `qwen-voice-clone.js` plugin.

## Notes

- ZeroGPU spins the GPU up per request — first call after idle takes ~5–10 sec extra
- Quota is per-USER, not per-app, so Sarah's daily 600 sec is generous for personal use
- Model is cached in CPU memory between calls; only inference runs on the GPU
- Public Spaces are rate-limited per IP; if it gets hammered, switch to private + add an HF auth token
