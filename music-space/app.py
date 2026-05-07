"""
Q's Music Space — MusicGen on HuggingFace ZeroGPU
==================================================

facebook/musicgen-small (300M, Apache 2.0) — stable, well-tested,
no git dependencies, works on Python 3.13 + ZeroGPU.

Q's chat client posts a style prompt + optional lyrics + duration;
this Space returns a numpy audio array as (sample_rate, array).
"""
import spaces
import gradio as gr
import torch
import numpy as np
from transformers import MusicgenForConditionalGeneration, AutoProcessor

MODEL_ID = "facebook/musicgen-small"

_model = None
_processor = None


def _load():
    global _model, _processor
    if _model is None:
        _processor = AutoProcessor.from_pretrained(MODEL_ID)
        _model = MusicgenForConditionalGeneration.from_pretrained(
            MODEL_ID, torch_dtype=torch.float16
        ).to("cuda")
    return _model, _processor


@spaces.GPU(duration=120)
def generate(prompt: str, lyrics: str = "", duration_sec: float = 30.0, seed: int = -1):
    if not prompt or not prompt.strip():
        raise gr.Error("Need a style/genre prompt.")

    model, processor = _load()

    if int(seed) >= 0:
        torch.manual_seed(int(seed))

    # MusicGen encodes ~50 tokens per second; cap at 1500 (≈30s) for ZeroGPU
    max_new_tokens = min(int(float(duration_sec) * 50), 1500)

    full_prompt = prompt.strip()
    if lyrics and lyrics.strip():
        full_prompt = full_prompt + ". " + lyrics.strip()

    inputs = processor(text=[full_prompt], padding=True, return_tensors="pt").to("cuda")

    with torch.no_grad():
        audio_values = model.generate(**inputs, max_new_tokens=max_new_tokens)

    sample_rate = model.config.audio_encoder.sampling_rate
    audio_np = audio_values[0, 0].cpu().float().numpy()
    return (int(sample_rate), audio_np)


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="Style / genre prompt", placeholder="warm acoustic folk, fingerpicked guitar, gentle vocals, hopeful", lines=2),
        gr.Textbox(label="Lyrics (optional)", placeholder="Leave blank for instrumental", lines=3),
        gr.Slider(10, 30, value=30, step=5, label="Duration (seconds)"),
        gr.Number(value=-1, label="Seed (-1 random)"),
    ],
    outputs=gr.Audio(label="Generated track", type="numpy"),
    title="Q's Music",
    description="Internal endpoint for Q (Quotem's AI). Powered by MusicGen (Meta, Apache 2.0).",
    api_name="generate",
)


if __name__ == "__main__":
    demo.queue().launch()
