"""
Q's Video Space — Wan 2.2 T2V on HuggingFace ZeroGPU
=====================================================

Wan 2.2 (Alibaba) is the first open-source MoE video model — Apache 2.0,
720p / 24fps, commercial-friendly.

Heads-up on ZeroGPU: video is the heaviest task on the stack. Each clip
takes 60-180s on H200 even at low resolution. ZeroGPU per-call cap is
300s, so we keep frames + resolution conservative for personal use.
For longer / higher-res output, switch this Space to a paid GPU tier.
"""
import io
import spaces
import gradio as gr
import torch
from diffusers import DiffusionPipeline
from diffusers.utils import export_to_video

MODEL_ID = "Wan-AI/Wan2.2-T2V-A14B"

_pipe = None


def _load():
    global _pipe
    if _pipe is None:
        _pipe = DiffusionPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
        _pipe.to("cuda")
    return _pipe


@spaces.GPU(duration=240)
def generate(prompt: str,
             negative_prompt: str = "",
             num_frames: int = 16,
             fps: int = 8,
             num_inference_steps: int = 25,
             seed: int = -1):
    if not prompt or not prompt.strip():
        raise gr.Error("Need a prompt.")

    pipe = _load()
    generator = torch.Generator("cuda").manual_seed(int(seed)) if int(seed) >= 0 else None

    with torch.no_grad():
        result = pipe(
            prompt=prompt.strip(),
            negative_prompt=(negative_prompt or "").strip() or None,
            num_frames=int(num_frames) or 16,
            num_inference_steps=int(num_inference_steps) or 25,
            generator=generator,
        )
    frames = result.frames[0] if hasattr(result, "frames") else result

    out_path = "/tmp/q-video.mp4"
    export_to_video(frames, out_path, fps=int(fps) or 8)
    return out_path


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="Prompt", placeholder="Sunlight breaking through clouds over rolling green hills, cinematic", lines=2),
        gr.Textbox(label="Negative prompt (optional)", placeholder="blurry, low quality, watermark"),
        gr.Slider(8, 49, value=16, step=1, label="Frames"),
        gr.Slider(4, 24, value=8, step=1, label="FPS"),
        gr.Slider(10, 50, value=25, step=1, label="Inference steps"),
        gr.Number(value=-1, label="Seed (-1 random)"),
    ],
    outputs=gr.Video(label="Generated clip"),
    title="Q's Video",
    description=(
        "Internal endpoint for Q (Quotem's AI). "
        "Powered by Wan 2.2 (Alibaba, Apache 2.0). "
        "Conservative defaults (16 frames @ 8fps = 2 sec) to fit ZeroGPU's 300s call cap."
    ),
    api_name="generate",
)


if __name__ == "__main__":
    demo.queue().launch()
