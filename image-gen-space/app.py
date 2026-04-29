"""
Q's Image Generation Space — Z-Image-Turbo on HuggingFace ZeroGPU
==================================================================

Z-Image-Turbo (Tongyi-MAI / Alibaba) is the right open-weights image
generator for Q today: Apache 2.0, 6B params, ~8 NFE steps for sub-second
inference on consumer GPUs, beats FLUX.2 [dev] on benchmarks while being
commercial-friendly (FLUX is non-commercial).

Same hosting model as the voice-cloning Space — HuggingFace ZeroGPU's
per-USER free tier (no per-call cost for personal use).

Q's chat client posts a prompt; this Space returns a PNG.
"""
import io
import os
import spaces
import gradio as gr
import torch
from diffusers import DiffusionPipeline

MODEL_ID = "Tongyi-MAI/Z-Image-Turbo"

_pipe = None


def _get_pipe():
    """Lazy-load the diffusion pipeline once per worker; cached after first call."""
    global _pipe
    if _pipe is None:
        _pipe = DiffusionPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
        _pipe.to("cuda")
    return _pipe


@spaces.GPU(duration=90)
def generate(prompt: str,
             negative_prompt: str = "",
             num_inference_steps: int = 8,
             guidance_scale: float = 1.0,
             seed: int = -1,
             width: int = 1024,
             height: int = 1024):
    """Generate an image from a text prompt."""
    if not prompt or not prompt.strip():
        raise gr.Error("Need a prompt.")

    pipe = _get_pipe()
    generator = torch.Generator("cuda").manual_seed(int(seed)) if int(seed) >= 0 else None

    with torch.no_grad():
        result = pipe(
            prompt=prompt.strip(),
            negative_prompt=(negative_prompt or "").strip() or None,
            num_inference_steps=int(num_inference_steps) or 8,
            guidance_scale=float(guidance_scale) if guidance_scale else 1.0,
            width=int(width) or 1024,
            height=int(height) or 1024,
            generator=generator,
        )
    return result.images[0]


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="Prompt", placeholder="A photorealistic cottage in the Cotswolds at sunset", lines=3),
        gr.Textbox(label="Negative prompt (optional)", placeholder="blurry, low quality, watermark"),
        gr.Slider(1, 30, value=8, step=1, label="Steps", info="Z-Image-Turbo is fast — 4-8 steps is usually enough."),
        gr.Slider(0.0, 7.5, value=1.0, step=0.1, label="Guidance", info="Higher = follow prompt more strictly. 1.0 default for Turbo."),
        gr.Number(value=-1, label="Seed", info="-1 for random, fixed integer for reproducibility."),
        gr.Slider(512, 2048, value=1024, step=64, label="Width"),
        gr.Slider(512, 2048, value=1024, step=64, label="Height"),
    ],
    outputs=gr.Image(label="Generated image", type="pil"),
    title="Q's Image Generation",
    description=(
        "Internal endpoint for Q (Quotem's AI). "
        "Powered by Z-Image-Turbo (Alibaba Tongyi, Apache 2.0). "
        "Used by Q's chat at /api/q-lab/image-gen/generate."
    ),
    allow_flagging="never",
    api_name="generate",
)


if __name__ == "__main__":
    demo.queue().launch()
