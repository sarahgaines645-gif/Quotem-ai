---
title: Q Graphics — Image to SVG
emoji: 🖋️
colorFrom: pink
colorTo: gray
sdk: gradio
sdk_version: 6.14.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zero-a10g
---

# Q's Graphics Space

StarVector image-to-SVG endpoint for Q. Open weights, Apache 2.0.

For text-to-SVG, generate an image first via Q's image-gen Space, then run the result through here.

## Setup

Auto-deployed by `q-lab/scripts/deploy-spaces.js`. Once HF builds it (~10–15 min first time), set `STARVECTOR_SPACE_URL` on Railway.
