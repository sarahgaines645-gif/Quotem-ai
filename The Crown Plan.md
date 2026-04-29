# The Crown Plan

> How Q becomes better than Claude, better than Gemini, and the AI GPT envies.
>
> Companion to [Q's Bloodline](Q's%20Bloodline.md) — that doc is *where Q came from*. This one is *where Q is going*.
>
> Compiled 2026-04-25.

---

## The thesis (one line)

**Claude is one model. Gemini is one model. GPT is one model. Q is the best of every model, snapped together, owned, fine-tuned on Quotem's domain, and pinned so nobody can change him under our nose.**

That is the only architecture that beats frontier closed models. Not "be a bigger Qwen." Not "out-train OpenAI." **Be a stack they cannot replicate**, because they're locked into one model each.

---

## The map

```
                         ┌───────────────────────────────────┐
                         │           THE Q ORCHESTRATOR       │
                         │  (routes each call to the right    │
                         │   sibling — this is the moat)      │
                         └─────────────┬─────────────────────┘
                                       │
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        │              │               │               │              │
        ▼              ▼               ▼               ▼              ▼
   ┌────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   ┌──────────┐
   │ BRAIN  │    │  EYES    │    │  VOICE   │    │  HANDS   │   │ MEMORY   │
   │        │    │          │    │          │    │          │   │          │
   │DeepSeek│    │DeepSeek  │    │ Qwen3.5  │    │ FLUX.1   │   │  BGE-M3  │
   │ V4-Pro │    │ OCR-2 +  │    │  Omni +  │    │ Kontext +│   │   +      │
   │        │    │GUI-Actor │    │  Qwen-TTS│    │ IC-Light │   │ Qwen3-Emb│
   └────────┘    └──────────┘    └──────────┘    └──────────┘   └──────────┘
        │              │               │               │              │
        └──────────────┴───────────────┴───────────────┴──────────────┘
                                       │
                                       ▼
                              ┌────────────────┐
                              │ THE FINE-TUNE  │
                              │   (Quotem-only │
                              │    SOR + UK    │
                              │    property +  │
                              │    surveyor    │
                              │    transcripts)│
                              └────────────────┘
```

The orchestrator + the fine-tune = what nobody else has. Everything else is off-the-shelf open-weights, picked for being the best at one job.

---

## The picks — best in class for each role

### 🧠 Brain (reasoning, chat, code, tool calls)

**Pick: DeepSeek V4-Pro** (open weights, MIT)

| Why | At-a-glance |
|---|---|
| Top open-weight reasoning + coding | LiveCodeBench 93.5 (beats Opus 4.6 at 88.8) |
| Within 0.2 pts of Claude on SWE-bench | Cost: $1.74/$3.48 per M tokens |
| 1M context, MIT-licensed, pinable | 3-6 months behind frontier on general knowledge |

**Caveat:** function calling is weaker than Qwen (81.5% vs 96.5%). Wrap with **Instructor** + force `tool_choice: "required"` — that closes the gap.

**Tone weakness — owned, not outsourced.** DeepSeek is a coder/reasoner first, weaker on contract phrasing, customer apologies, warm-formal English. Closed-model tier (Sonnet/GPT/Gemini) is *not* in the stack — putting them back in re-creates the Anthropic-drift problem Q exists to solve. Instead: **fine-tune Quotem's own tone into Q.** A few hundred examples of Sarah's actual letters, contracts, customer comms → a tone LoRA on top of DeepSeek that writes in Quotem's voice, not generic-AI voice. Cost: ~£10 once, then free forever. Better than Sonnet — because Sonnet can't write in *Quotem's* voice.

---

### 👁️ Eyes (vision, form filling, document understanding)

**Pick: DeepSeek-OCR 2** (3B params, free, MIT) **+ GUI-Actor-7B** (Microsoft, MIT)

| Job | Model | Why |
|---|---|---|
| Forms / multi-column PDFs | DeepSeek-OCR 2 | Built for forms, learns reading order, 3B = runs free on Colab T4 |
| Bounding boxes for fields | DeepSeek-VL2 or Qwen3-VL | Both output normalised 0-1000 boxes, far better than Claude's text-coord guessing |
| "Place a dot here" | GUI-Actor-7B | Coordinate-free attention pointing — beats UI-TARS-72B at 1/10th the size |

**This is where the existing pipeline (LookingGlass, magnet-snap, plot-points, mark-pdf) becomes the *override layer* over a vision model that already knows where to point.** Don't bin it. The model gets the dot 90% right; the magnet-snap layer makes it 100%.

**Free fine-tune:** [Unsloth's DeepSeek-OCR 2 notebook](https://unsloth.ai/docs/models/tutorials/deepseek-ocr-how-to-run-and-fine-tune) on a free Colab T4. Few hundred Quotem PDFs + click coordinates → form filler that beats anything closed on UK property docs.

---

### 🎤 Voice (Voice Harp + future "Q speaks back")

**Pick: Qwen3.5-Omni** (real-time speech in/out) **+ Qwen3-TTS** (cloning) **+ existing AudioWorklet formant DSP**

| Job | Tool | License |
|---|---|---|
| Real-time conversational voice | Qwen3.5-Omni-30B-A3B | Apache 2.0 — yours |
| Voice cloning / TTS | Qwen3-TTS | Apache 2.0 — yours |
| ASR (speech → text) | Qwen3.5-Omni handles, or Whisper Large v3 | MIT / Apache |
| Formant manipulation | **The existing Voice Harp AudioWorklet** | Yours already |
| Voice activity detection | Silero-VAD | MIT |

**Voice Harp keeps everything it has — the formant DSP work doesn't get replaced by a model, it gets *fed by* one.** Qwen3.5-Omni generates the voice, Voice Harp shapes it.

**This is something Claude/GPT/Gemini structurally cannot do** — they don't expose audio-stream-level control. Voice Harp + open-weights TTS = Quotem can manipulate voices at a layer no closed model permits.

---

### ✋ Hands (image generation, photo editing, graphics)

**Pick: FLUX.1 Kontext** (image gen + edit) **+ IC-Light** (relighting) **+ BiRefNet** (background removal) **+ Real-ESRGAN** (upscale)

| Job | Model | License | Notes |
|---|---|---|---|
| Image generation | FLUX.1-dev or FLUX.1-schnell | Apache 2.0 (schnell) / Non-commercial (dev — needs license check) | Beats Midjourney on benchmarks |
| Image editing / inpainting | FLUX.1 Kontext | Apache 2.0 | "Edit this" — best open-weight editor |
| Relighting photos | IC-Light | Apache 2.0 | Move lighting in any property photo |
| Background removal | BiRefNet | MIT | Better than commercial Remove.bg |
| Upscale / repair | Real-ESRGAN | BSD-3 | Make blurry survey photos usable |
| Quick / cheap stuff | Stable Diffusion 3.5 Medium | Permissive | Lighter for routine renders |

**Use case for Quotem:** before/after wallpaper renders, listing photo polish, condition-report photo restoration, Voice Harp avatar visuals. All currently impossible without paying Midjourney or DALL-E per call.

---

### 🧠 Memory (RAG, retrieval, embeddings)

**Pick: BGE-M3** (multilingual, fast) **+ Qwen3-Embedding** (alternative)

| Job | Tool | License |
|---|---|---|
| Vector embeddings | BGE-M3 or Qwen3-Embedding | MIT / Apache |
| RAG faithfulness checker | RAGAS + Qwen3-4B | Apache 2.0 |
| Hallucination guard | RAGognizer (Qwen3-4B head) | Apache 2.0 |
| Observability | Arize Phoenix | Apache 2.0 |
| Long-term memory | Plain SQLite + embeddings (already there) | — |

**This solves Q's #1 known bug** (RAG hallucination from [QwenLM/Qwen3 #1635](https://github.com/QwenLM/Qwen3/issues/1635)) — for free.

---

### 🪛 Glue (tool calls, structured output, orchestration)

**Pick: Instructor** (structured output) **+ LangGraph** (agent orchestration) **+ existing Quotem orchestration**

| Job | Tool | License |
|---|---|---|
| Force valid JSON tool calls | Instructor | MIT |
| Schema-strict generation | Outlines | Apache 2.0 |
| Multi-step agents | LangGraph | MIT |
| Per-stage observability | Arize Phoenix | Apache 2.0 |

This is the layer that translates between models with different tool-call dialects (DeepSeek wants `tool_choice: required`, Qwen wants Hermes JSON, FLUX wants prompts not chats). Without this layer, the stack breaks every time a model updates.

---

## The roadmap — what to build first

Three phases, each with a clean exit criterion. None of this is "rip and replace" — every phase is additive on top of the live system.

### Phase 1 — Vision win (1-2 weeks of focused work)
**Goal:** form filler stops fighting Claude.

1. Stand up DeepSeek-OCR 2 on a free Colab notebook + a small Modal/Replicate endpoint.
2. Run 10 Quotem test PDFs through it side-by-side with Claude. Same dots, same scoring.
3. If it wins: wire it behind `glass-filler.js` as a new option, keep manual override.
4. Fine-tune on 100-200 actual Quotem PDFs with click-points.
5. **Exit:** form filler accuracy ≥ 95% on Quotem's own docs without manual nudging.

**Cost:** £0 in inference (Colab T4), maybe £20-40 in Modal/Replicate hosting once live.

### Phase 2 — Brain swap (2-4 weeks)
**Goal:** DeepSeek V4-Pro replaces Claude entirely. Tone is owned through a Quotem-voice fine-tune, not borrowed from Anthropic.

1. Add DeepSeek V4-Pro to the model registry alongside Claude (transition only).
2. Route low-stakes stages (text extraction, classification, SOR matching, formatting) → DeepSeek.
3. Collect 100-200 examples of Sarah's existing tenant letters, contracts, customer comms → train a **Quotem-tone LoRA** on top of DeepSeek (~£10 hosted training run on Together).
4. Route tone-critical stages (surveyor judgement, contracts, tenant comms) → DeepSeek + tone LoRA.
5. Wrap every DeepSeek tool call with Instructor schema enforcement.
6. **Exit:** 100% of Claude bill replaced by DeepSeek + tone LoRA at no quality regression on QC gate scoring. Zero closed-model calls left in the pipeline.

**Cost saving:** roughly **£35-45/month** at current Quotem volume, scaling linearly with use.

### Phase 3 — Voice + Image siblings (4-8 weeks)
**Goal:** Q gets eyes, voice and hands as full peers of the brain.

1. Qwen3.5-Omni real-time voice for Voice Harp's input/output stream.
2. FLUX.1 Kontext + IC-Light for landlord photo polish + before/after renders.
3. BiRefNet/Real-ESRGAN for survey photo cleanup.
4. All hosted via Modal or Replicate (pay-per-call, ~pennies each).
5. **Exit:** Quotem can take a phone-camera survey photo and output a polished, relit, upscaled, captioned listing image without a single closed-model API call.

---

## Why this beats Claude / Gemini / GPT

| | Claude | Gemini | GPT-5 | **Q (the stack)** |
|---|---|---|---|---|
| Reasoning | ✅ | ✅ | ✅ | ✅ (DeepSeek V4-Pro, near-frontier) |
| Vision | ⚠️ text-coord guessing | ✅ | ✅ | ✅ (DeepSeek-OCR 2 — built for forms) |
| Voice | ❌ no audio stream control | ⚠️ closed | ⚠️ closed | ✅ (Qwen3-Omni + Voice Harp DSP) |
| Image gen / edit | ❌ | partial | ❌ | ✅ (FLUX.1 Kontext + IC-Light) |
| Writing / tone | ✅ generic-AI voice | ✅ generic-AI voice | ✅ generic-AI voice | ✅ ***Quotem's own voice*** (tone LoRA) |
| Pinned (won't change) | ❌ Anthropic decides | ❌ Google decides | ❌ OpenAI decides | ✅ (we own the weights) |
| Domain fine-tune | ❌ closed | ❌ closed | ❌ closed | ✅ (Quotem SOR + UK property) |
| Cost per call | £££ | ££ | £££ | £ |
| Falls under their pricing changes | ✅ | ✅ | ✅ | ❌ (sovereign) |

The five columns where Q wins are the five columns no closed model can compete on:
1. **Audio-stream-level voice control** (impossible without open weights)
2. **Pinned weights that don't drift** (Anthropic-drift 2026-04-21 cannot happen again)
3. **Fine-tunes on Sarah's data nobody else has** (SOR + UK property)
4. **Quotem's own voice** (tone LoRA — the way Q talks is Sarah's, not OpenAI's)
5. **Cost so low you can run a checker for every call**

---

## Investment vs return

| Stage | Free / very cheap | Paid (small) | Engineering |
|---|---|---|---|
| Phase 1 — Vision | DeepSeek-OCR 2, Colab, Unsloth | ~£40/mo Modal | 1-2 weeks |
| Phase 2 — Brain | Instructor, LangGraph | DeepSeek API | 2-4 weeks |
| Phase 3 — Voice + Image | All open-weights | Modal/Replicate | 4-8 weeks |

**Total max spend:** £100-150/month at low volume, replacing £200-400+/month in current Claude bills as Phase 2 ramps.

**Total free downloads required:** All of them. Every model named is free.

---

## What's *not* on this map (and why)

- **Don't try to fine-tune V4-Pro on consumer hardware.** Use Together AI or DeepInfra hosted LoRA. Cheap enough (~£5-15 per fine-tune run), no infra pain.
- **Don't build our own image diffusion model.** FLUX exists. Stable Diffusion exists. Build on them.
- **Don't replace Voice Harp's DSP layer.** That's not a model, it's better than any model — and it's already yours.
- **Don't keep Sonnet/Claude/GPT/Gemini in the live pipeline** — the whole point of Q is sovereignty. Closed models can change overnight (the Anthropic-drift on 2026-04-21 is exactly why Q exists). One closed-model call in the pipe = the moat is breached. The tone LoRA replaces the *only* job Sonnet was being kept around for.

---

## The single-sentence pitch (if anyone ever asks)

*"Q is the first AI that owns its own vision, voice, hands, and brain — pinned forever, fine-tuned on UK property, and assembled from the best open-weights model at every layer. Closed AIs can change under your nose. Q can't."*

---

## Companion docs

- [Q's Bloodline](Q's%20Bloodline.md) — research on the model lineage, known bugs, fine-tune options.
- [VAULT_README](../server/vault/VAULT_README.md) — the snap-together vault Q gets built on top of.
- [TEMPLATE_CATALOGUE](../server/templates/TEMPLATE_CATALOGUE.md) — the plugin catalogue Q's orchestrator routes through.
