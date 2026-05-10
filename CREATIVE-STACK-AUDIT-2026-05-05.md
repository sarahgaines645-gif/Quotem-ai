# Creative Stack Audit — Quotem-AI / Q

> **Date:** 2026-05-05
> **Question that triggered this:** "Is there a design model on Together AI we should use for marketing?"
> **Short answer:** No — you've already chosen better ones. They're sitting on disk waiting to be wired up.

---

## What's in `quotem-ai/` right now

Five creative-AI skills are designed and partially built. All run on HuggingFace Spaces (free ZeroGPU per-user quota), all open-weights and Apache 2.0 (commercial-friendly), and all coordinate with Q via a Gradio API call from a plugin file.

| Skill | Model | Plugin file | HF Space folder | Wired into Q's tool list? |
|---|---|---|---|---|
| Image generation | Z-Image-Turbo (Alibaba Tongyi) | `plugins/q-image-gen.js` | `image-gen-space/` | No |
| Image → SVG / vector | StarVector | `plugins/q-graphics.js` | `graphics-space/` | No |
| Music generation | ACE-Step | `plugins/q-music.js` | `music-space/` | No |
| Video generation | Wan 2.2 (Alibaba MoE) | `plugins/q-video.js` | `video-space/` | No |
| Voice cloning | Chatterbox | `plugins/q-voice-clone.js` | `voice-cloning-space/` | No |
| Vision (input) | Qwen3.6-Plus (Together AI) | `plugins/q-chat.js` | n/a (Together) | Yes — live |

Plugins are imported at the top of `plugins/q-chat.js` (lines 23–29) but are **not** in `plugins/q-tools.js` — meaning Q can't decide to call them himself. There's one direct call site at line 997 of `q-chat.js` (looks like a manual route handler).

`.env.example` shows all five Space URLs as blank, so the Spaces are most likely **not deployed** to HuggingFace yet either.

---

## Why Together AI's design models aren't the right move

Together AI's catalogue includes FLUX.2 (image), Wan / Veo / Sora / Seedream (video), and assorted 200+ general LLMs. Side-by-side with what's already chosen for `quotem-ai/`:

| Capability | Together AI's offer | What's already chosen for Q |
|---|---|---|
| Image | FLUX.2 [pro] — paid per image, restrictive commercial licence; FLUX.2 [dev] is non-commercial | **Z-Image-Turbo** — Apache 2.0, beats FLUX.2 [dev] on benchmarks, free on HF ZeroGPU |
| Video | Veo 3 / Sora 2 — paid per second, restrictive licences | **Wan 2.2** — Apache 2.0, free |
| Music | None on Together | **ACE-Step** — Apache 2.0, beats Suno v5 on SongEval (Apr 2026) |
| Vector / SVG | None on Together | **StarVector** — Apache 2.0 |
| Voice cloning | None on Together | **Chatterbox** — Apache 2.0 |

The only material edges Together's models give you:

- Production reliability — no ZeroGPU cold starts (~5–10 sec extra on first call after idle).
- No quota cap — HF ZeroGPU gives ~600 H200-seconds/day per user.
- **Multi-reference image input** on FLUX.2 — feed 2–3 reference shots and the model locks character/style identity while changing scene. Genuinely useful for "Q's avatar identical across 30 marketing shots." Worth keeping in mind if brand-character consistency becomes a bottleneck.
- **Hex-code colour matching** — locks brand colours into output.

None of those edges justify the per-image cost or licensing complexity at Quotem's current scale. Revisit if the free quota becomes the bottleneck or if multi-reference character-lock becomes essential for marketing.

---

## How this improves Q / Quotem once wired

| Use case | Skill that solves it | Live impact |
|---|---|---|
| Marketing site hero shots, social posts, banner art | Image-gen (Z-Image-Turbo) | Ship visuals without paying a designer per asset |
| SVG logos, brand icons, vectorising existing artwork | Graphics (StarVector) | Brand asset library at no per-call cost |
| Demo videos for the landing page, "how it works" reels | Video (Wan 2.2) | Replaces commissioned explainer videos |
| Background music for those videos, hold music, on-app stings | Music (ACE-Step) | Royalty-free per-track; no licensing |
| Q narrating his own demo videos in his own voice | Voice-clone (Chatterbox) | Brand consistency — Q sounds like Q everywhere |

For Q himself, putting these into his tool list lets him use them mid-conversation:
- "Q, draw me a hero shot for the landlord page"
- "Q, make a 10-second demo clip of the calendar tool"
- "Q, narrate that script in your voice and stitch it over the video"

Today he can't, because none of the five plugins are registered in `q-tools.js`.

---

## What's blocking it — three pieces of work, no R&D

1. **Add 5 tool definitions to `plugins/q-tools.js`** and dispatch to `executeTool`. Mirrors how existing tools like `web_search`, `create_document`, `analyze_document` are wired. ~1 hour. The plugins are already imported and exporting the right functions (`generateImage`, `generateMusic`, `generateVideo`, `vectoriseImage`, `speakAsVoice`).

2. **Deploy the 5 HF Spaces.** Needs `.hf-secrets` file at the repo root with `HF_TOKEN` and `HF_USER`. Then `node scripts/deploy-spaces.js`. First-build takes ~10–15 min for image-gen / graphics / music / voice-cloning, ~15–25 min for video (larger model). Run sequentially; the script is idempotent.

3. **Set 5 env vars on Railway:** `ZIMAGE_SPACE_URL`, `STARVECTOR_SPACE_URL`, `ACESTEP_SPACE_URL`, `WAN_SPACE_URL`, `CHATTERBOX_SPACE_URL`. Each Space exposes a URL like `https://<HF_USER>-q-image-gen.hf.space`.

After that, Q has eyes (already), hands for image, video, music, vector, and his own voice. Same stack that's already on disk — turned on.

---

## Notes / open items

- **Cold-start UX.** ZeroGPU spins up per request; first call after idle is ~5–10 sec extra. Image-gen calls take 4–10 sec on warm GPU. Total user-visible latency on first cold call could be 15–20 sec. Worth a "Q is sketching..." state in the chat UI.
- **Quota.** ~600 H200-seconds/day per user is generous for personal/team use. If Quotem ever offers AI-generated visuals as a customer-facing feature, the quota becomes the ceiling and FLUX.2 [pro] on Together starts looking better as a paid backstop.
- **Identity rule applies.** Per the existing rule (no third-party provider names on user-facing surfaces), the "powered by Z-Image-Turbo" / "powered by Wan 2.2" labels stay internal — customers see "Q drew this" or no attribution, not the underlying model name.
- **Memory mirror to `quotem-ai/` repo for vision is still open** (per memory note from 2026-04-30). Q's eyes work on master via Qwen3.6-Plus; the same wiring needs to land in `quotem-ai/` so production Q can see attachments too. Worth doing in the same pass as the creative-stack tools.

---

## Recommendation

Don't shop Together AI for design models. Spend the equivalent hour on the three tasks above and Q gets the full creative stack you've already chosen.
