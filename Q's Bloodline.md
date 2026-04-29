# Q's Training

Research notes on the model Q is built on (`Qwen/Qwen3-235B-A22B-Instruct-2507-tput` via Together AI) — known bugs to design around, and free ways to fine-tune.

Compiled 2026-04-25.

---

## What Q is actually running

Pinned in `q-lab/config.js`:

```
model: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput'
baseURL: https://api.together.xyz/v1
```

This is the **FP8 throughput-optimised Instruct-2507 variant** on Together. Important distinction:
- **Instruct** (what we use) — direct answers, no exposed chain-of-thought.
- **Thinking** — outputs reasoning before answering. Different tokenizer behaviour, different bugs.
- **FP8 / -tput** — quantised for cheap high-volume inference; spec-decoding enabled server-side.

All bug references below are filtered to issues that affect the Instruct variant.

---

## Known bugs (in priority order for Quotem)

### 1. RAG hallucinations — the headline bug

The model answers from priors instead of the documents you give it, even when context is present.

- [QwenLM/Qwen3 #1635](https://github.com/QwenLM/Qwen3/issues/1635) — Dify user reported full context in system prompt, model still hallucinated on social-insurance / housing-fund questions.
- [HF discussion](https://huggingface.co/Qwen/Qwen3-235B-A22B/discussions/16) — "broad knowledge has degraded since Qwen2 — flooding responses with hallucinations on popular domains."

**Why it matters for Quotem:** every feature where Q is supposed to *only use what's in front of it* — text-reader, SOR matching, contract review, email triage — is the exact failure mode being reported. Same shape as the £1.20-cable regression already in memory.

**Mitigation:** wrap text-reader / SOR-matching outputs in a checker that re-reads the source and rejects anything not grounded. Borrow the Claude QC gate pattern.

---

### 2. Tool calling is unreliable

- [HF discussion #20](https://huggingface.co/Qwen/Qwen3-235B-A22B/discussions/20) — "model ignores the tool and answers directly in ~70% of cases" vs QwQ-32B which always calls.
- Format mismatch is rife: Qwen3 Instruct was trained on **Hermes-style JSON**, the Coder variants on **Qwen3-Coder XML**. Wrong template = silent tool-call failure.
- ReAct / stopword-based tool templates are explicitly **not recommended** by Qwen for reasoning models.

**Mitigation:** lock to Hermes JSON before adding tools. Plan a checker stage from day one — never trust a tool call wasn't dropped.

Reference: [Qwen function-calling docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html).

---

### 3. Context understanding for long / messy prompts

- [Issue #1591](https://github.com/QwenLM/Qwen3/issues/1591) — "good at LeetCode, bad at debugging." Strong on well-posed problems, weaker when the spec is buried in surrounding noise — exactly what surveyor transcripts and email threads look like.
- KV-cache OOM warnings appear well before the advertised 262K context. Together's hosted version mitigates, but local/Unsloth users routinely drop to 32K to keep stable.

**Mitigation:** structure prompts so the *ask* is at the top, not buried at the end after a long input dump.

---

### 4. Thinking-mode quirks (lower risk for us — we're on Instruct)

- The 235B family ships with `enable_thinking=True` by default in tokenizer. Instruct-2507 is the non-thinking branch — but several inference stacks (Ollama, jan, vLLM) leak unclosed `<think>` tags into multi-turn history, which breaks the *next* turn's tool call.
- Speculative decoding + Qwen3 = malformed tool calls ([vLLM #35800](https://github.com/vllm-project/vllm/issues/35800)). Together has spec-decode enabled on `-tput` endpoints — worth a smoke test if tool calling looks flaky.

**Mitigation:** smoke-test multi-turn chat for leaked `<think>` tags in assistant history.

---

### 5. Sampling parameters silently dropped

- Repeat / presence / frequency penalties accepted by some serving stacks then ignored ([Ollama #14493](https://github.com/ollama/ollama/issues/14493)).
- Model card recommends `presence_penalty=1.5` to stop repetition loops.

**Mitigation:** verify Together actually applies penalties — look for stuck-repeat patterns in long outputs. If we see them, the param isn't reaching the model.

---

## Where to head first

Highest-impact, in order:

1. **RAG faithfulness checker** — wrap text-reader / SOR-matching outputs.
2. **Lock tool-call format to Hermes JSON** before adding tools.
3. **Smoke-test for leaked `<think>` tags** in multi-turn chat history.

---

## Free ways to fine-tune

The 235B itself is too big for free GPU tiers. Realistic free paths:

### 1. Unsloth + free Colab T4 — for smaller siblings of Q

- [Unsloth's Qwen3 guide](https://docs.unsloth.ai/models/qwen3-how-to-run-and-fine-tune) has ready-made notebooks.
- Free Colab T4 (16 GB VRAM) fits **Qwen3-14B** or **Qwen3-30B-A3B** with QLoRA — both share Q's tokenizer + chat template.
- A LoRA trained on the small model gives a directional read on how the 235B will behave on the same task.

Unsloth claims the 235B itself trains in **17.5 GB VRAM** ([release notes](https://github.com/unslothai/unsloth/releases)) — but you'd need a paid GPU (A100/H100, ~$1-2/hr on Runpod/Lambda) to actually run it. No truly free path for 235B.

### 2. Kaggle notebooks — 30 hr/week of free T4×2 or P100

- 2× T4 (32 GB combined) free — more headroom than Colab.
- Same Unsloth notebooks port across.
- **Best free option for serious LoRA runs on the 14B / 30B siblings.**

### 3. Hugging Face Spaces

Free tier is CPU only — not useful for training. Listed only so we don't waste time looking.

### 4. Together AI's own fine-tuning — not free, but cheap and on the same model

- Together supports LoRA fine-tuning directly on `Qwen3-235B-A22B-Instruct-2507`.
- Pay-per-token, no infra setup, deploy straight back to the API key Q already uses.
- **One-step promotion path:** prove the recipe at 14B for free, then send the same dataset to Together for a small fee.

### Practical recommendation

Cheapest way to build fine-tuning intuition without burning budget:

1. Free Colab + Unsloth + Qwen3-14B
2. A few hundred Quotem-domain examples (SOR descriptions, surveyor transcripts, quote summaries)
3. Once the recipe works at 14B, send the same dataset to Together's hosted LoRA on the real 235B

---

## Sources

- [QwenLM/Qwen3 #1635 — RAG hallucinations](https://github.com/QwenLM/Qwen3/issues/1635)
- [QwenLM/Qwen3 #1591 — context understanding](https://github.com/QwenLM/Qwen3/issues/1591)
- [HF discussion — Qwen3 losing broad knowledge since Qwen2](https://huggingface.co/Qwen/Qwen3-235B-A22B/discussions/16)
- [HF discussion #20 — tools ignored ~70% of the time](https://huggingface.co/Qwen/Qwen3-235B-A22B/discussions/20)
- [Qwen3-235B-A22B-Instruct-2507 model card](https://huggingface.co/Qwen/Qwen3-235B-A22B-Instruct-2507)
- [Together AI — Qwen3 235B Instruct 2507 FP8 page](https://www.together.ai/models/qwen3-235b-a22b-instruct-2507-fp8)
- [Ollama #14493 — penalties silently ignored](https://github.com/ollama/ollama/issues/14493)
- [Ollama #14601 — malformed tool definitions](https://github.com/ollama/ollama/issues/14601)
- [vLLM #35800 — speculative decoding breaks tool calls](https://github.com/vllm-project/vllm/issues/35800)
- [Qwen function-calling docs (Hermes vs XML)](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [Unsloth — Qwen3 fine-tune guide](https://docs.unsloth.ai/models/qwen3-how-to-run-and-fine-tune)
- [Unsloth notebooks repo](https://github.com/unslothai/notebooks)
- [Unsloth releases — 235B LoRA in 17.5 GB](https://github.com/unslothai/unsloth/releases)
