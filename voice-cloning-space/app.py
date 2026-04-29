"""
Q's Voice Cloning Space — Chatterbox on HuggingFace ZeroGPU
============================================================

Deploys Chatterbox (ResembleAI, Apache 2.0, voice-cloning TTS) as a free
HuggingFace Space using ZeroGPU. Q's chat client posts text + a reference
audio clip; this Space returns the text spoken in that voice.

Why Chatterbox: Apache-licensed, 0.5B Llama-based, beat ElevenLabs in
blind tests (63.75% preference). Smaller than F5-TTS, easier to host.

Why HuggingFace ZeroGPU (and not Modal/Replicate): per-USER quota
(~600 H200-seconds/day refilled every 12h), free for personal use, no
metering. Fits Sarah's "no per-call cost" rule.
"""
import spaces
import gradio as gr
import torch
from chatterbox.tts import ChatterboxTTS

# Model is loaded inside the GPU function — ZeroGPU spins GPU up per call,
# so persisting a model handle in CPU memory between calls is the right pattern.
_model = None


def _get_model():
    """Lazy-load Chatterbox once per worker. Cached after first call."""
    global _model
    if _model is None:
        _model = ChatterboxTTS.from_pretrained(device="cuda")
    return _model


@spaces.GPU(duration=60)
def generate(text: str, reference_audio: str, exaggeration: float = 0.5, cfg_weight: float = 0.5):
    """Generate `text` spoken in the voice from `reference_audio`."""
    if not text or not text.strip():
        raise gr.Error("Need some text to speak.")
    if not reference_audio:
        raise gr.Error("Need a reference voice clip (5–15 seconds works best).")

    model = _get_model()
    with torch.no_grad():
        wav = model.generate(
            text.strip(),
            audio_prompt_path=reference_audio,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
        )
    return (model.sr, wav.squeeze(0).cpu().numpy())


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="Text", placeholder="What should Q say?", lines=3),
        gr.Audio(type="filepath", label="Reference voice (5–15 sec clip)"),
        gr.Slider(0.0, 1.0, value=0.5, step=0.05, label="Exaggeration",
                  info="Higher = more emotive. 0.5 is natural."),
        gr.Slider(0.0, 1.0, value=0.5, step=0.05, label="Pace (cfg_weight)",
                  info="Lower = slower, more deliberate. 0.5 default."),
    ],
    outputs=gr.Audio(label="Cloned speech", autoplay=False),
    title="Q's Voice Cloning",
    description=(
        "Internal endpoint for Q (Quotem's AI). "
        "Powered by Chatterbox (ResembleAI, Apache 2.0). "
        "Used by Q's chat at /api/q-lab/speak-as-voice."
    ),
    allow_flagging="never",
    api_name="generate",
)


if __name__ == "__main__":
    demo.queue().launch()
