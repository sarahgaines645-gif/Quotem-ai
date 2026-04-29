---
title: Q Music
emoji: 🎵
colorFrom: pink
colorTo: gray
sdk: gradio
sdk_version: 5.0.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zero-a10g
---

# Q's Music Space

ACE-Step text-to-music endpoint. Apache 2.0. Beats Suno v5 on SongEval (April 2026).

Once HF builds it (~10–15 min first time), set `ACESTEP_SPACE_URL` on Railway.

If `acestep` isn't on PyPI yet at the time of deploy, edit `requirements.txt` to install from the official GitHub repo: `git+https://github.com/ace-step/ACE-Step-1.5`.
