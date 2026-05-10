---
title: Q Video
emoji: 🎬
colorFrom: pink
colorTo: gray
sdk: gradio
sdk_version: 6.14.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zero-a10g
---

# Q's Video Space

Wan 2.2 text-to-video. Apache 2.0, commercial-friendly. Alibaba's open-source MoE video model.

Once HF builds it (~15–25 min first time — video models are large), set `WAN_SPACE_URL` on Railway.

**Heads-up:** video is the heaviest task in the stack. Defaults are conservative (16 frames @ 8 fps = 2 sec) to fit ZeroGPU's 300s call cap. For longer / higher-res clips, upgrade this Space to a paid GPU tier in HF settings.
