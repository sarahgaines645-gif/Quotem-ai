"""
Q's Music Space — ACE-Step on HuggingFace ZeroGPU
==================================================

ACE-Step (28 Jan 2026, joint ACE Studio + StepFun) is the open-weights
"Stable Diffusion moment for music" — generates full songs from a text
prompt in seconds on consumer hardware. Apache 2.0, beats Suno v5 on
SongEval.

Sarah's chat client posts a prompt + duration; this Space returns audio.
"""
import io
import spaces
import gradio as gr
import torch
import scipy.io.wavfile

# ACE-Step is loaded via its own pipeline class. The exact import path /
# model id should match the HF model card current at deploy time.
# As of April 2026 the canonical id is "ACE-Step/ACE-Step-v1-3.5B".
MODEL_ID = "ACE-Step/ACE-Step-v1-3.5B"

_pipe = None


def _load():
    global _pipe
    if _pipe is None:
        from acestep.pipeline_ace_step import ACEStepPipeline
        _pipe = ACEStepPipeline(checkpoint_dir=MODEL_ID, device="cuda", dtype=torch.bfloat16)
    return _pipe


@spaces.GPU(duration=120)
def generate(prompt: str, lyrics: str = "", duration_sec: float = 30.0, seed: int = -1):
    if not prompt or not prompt.strip():
        raise gr.Error("Need a style/genre prompt.")

    pipe = _load()
    audio, sample_rate = pipe(
        prompt=prompt.strip(),
        lyrics=(lyrics or "").strip(),
        audio_duration=float(duration_sec) or 30.0,
        seed=int(seed) if int(seed) >= 0 else None,
    )

    # ACEStepPipeline returns torch tensor or np array — normalise to np int16.
    if hasattr(audio, "cpu"):
        audio = audio.cpu().numpy()
    return (int(sample_rate), audio)


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="Style / genre prompt", placeholder="warm acoustic folk, fingerpicked guitar, gentle vocals, hopeful", lines=2),
        gr.Textbox(label="Lyrics (optional)", placeholder="Sun comes up over rolling hills...\nTime to start the day...", lines=4),
        gr.Slider(10, 120, value=30, step=5, label="Duration (seconds)"),
        gr.Number(value=-1, label="Seed (-1 random)"),
    ],
    outputs=gr.Audio(label="Generated track", type="numpy"),
    title="Q's Music",
    description=(
        "Internal endpoint for Q (Quotem's AI). "
        "Powered by ACE-Step (Apache 2.0)."
    ),
    allow_flagging="never",
    api_name="generate",
)


if __name__ == "__main__":
    demo.queue().launch()
