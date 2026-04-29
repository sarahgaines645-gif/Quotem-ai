---
title: Q Image Generation
emoji: 🎨
colorFrom: pink
colorTo: gray
sdk: gradio
sdk_version: 5.0.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zero-a10g
---

# Q's Image Generation Space

Z-Image-Turbo (Alibaba Tongyi) on HuggingFace ZeroGPU. Internal endpoint for Q's chat + dedicated image-gen page at `/api/q-lab/image-gen`.

Apache 2.0 — commercial-friendly. Beats FLUX.2 [dev] on benchmarks while being a third the size and Turbo-fast (4–8 steps for sub-second generation on consumer GPUs).

## Setup (one-time, ~15 minutes)

1. Go to https://huggingface.co/new-space
2. **Owner**: your HF account
3. **Space name**: `q-image-gen` (or anything — you'll paste the URL into Quotem)
4. **License**: Apache-2.0
5. **SDK**: Gradio
6. **Hardware**: ZeroGPU
7. **Visibility**: Public is fine
8. Create
9. Upload all three files from this folder:
   - `app.py`
   - `requirements.txt`
   - `README.md`
10. Wait for build (~10–15 minutes first time, watch the **Logs** tab)
11. Once "Running", grab the URL — it'll look like `https://YOUR-USERNAME-q-image-gen.hf.space`
12. Set that URL as `ZIMAGE_SPACE_URL` env var on Quotem's Railway service

## Notes

- Quota is per-USER (~600 H200-seconds/day, refilled every 12h)
- Each image takes 4–10 sec on H200 with default 8 steps
- Model loads ~12 GB into GPU memory; first call after idle has ~10s extra warm-up
- Apache 2.0 → safe to use commercially when Q ships
