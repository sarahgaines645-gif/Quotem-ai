"""
Q's Voice Cloning Space — XTTS-v2 (Coqui) on HuggingFace ZeroGPU
=================================================================

Voice cloning from a short reference clip (5-15 sec). XTTS-v2 is the
most-deployed voice cloning model on HF Spaces — reliable, well-supported,
no Chinese-language transitive dependencies.

Same Gradio interface signature as the previous chatterbox-based app
(text, reference_audio, exaggeration, cfg_weight) so Q's existing plugin
needs no changes — exaggeration maps to temperature, cfg_weight to speed.
"""
import os
import spaces
import gradio as gr
import torch

# Accept the Coqui non-commercial model licence non-interactively
os.environ["COQUI_TOS_AGREED"] = "1"

from TTS.api import TTS

_tts = None


def _get_model():
    """Lazy-load XTTS-v2 once. Cached after first call."""
    global _tts
    if _tts is None:
        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
    return _tts


@spaces.GPU(duration=60)
def generate(text: str, reference_audio: str, exaggeration: float = 0.5, cfg_weight: float = 0.5):
    """Generate `text` spoken in the voice from `reference_audio`."""
    if not text or not text.strip():
        raise gr.Error("Need some text to speak.")
    if not reference_audio:
        raise gr.Error("Need a reference voice clip (5-15 seconds works best).")

    # Map the legacy sliders (kept for plugin compatibility):
    #   exaggeration 0..1  -> temperature 0.4..0.9 (higher = more expressive)
    #   cfg_weight   0..1  -> speed       0.75..1.25 (lower = slower / more deliberate)
    temperature = 0.4 + max(0.0, min(1.0, float(exaggeration))) * 0.5
    speed       = 0.75 + max(0.0, min(1.0, float(cfg_weight))) * 0.5

    tts = _get_model()
    out_path = "/tmp/q-voice.wav"
    tts.tts_to_file(
        text=text.strip(),
        speaker_wav=reference_audio,
        language="en",
        file_path=out_path,
        speed=speed,
        temperature=temperature,
    )
    return out_path


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="Text", placeholder="What should Q say?", lines=3),
        gr.Audio(type="filepath", label="Reference voice (5-15 sec clip)"),
        gr.Slider(0.0, 1.0, value=0.5, step=0.05, label="Expressiveness",
                  info="Higher = more emotive."),
        gr.Slider(0.0, 1.0, value=0.5, step=0.05, label="Pace",
                  info="Lower = slower, more deliberate."),
    ],
    outputs=gr.Audio(label="Cloned speech", autoplay=False),
    title="Q's Voice Cloning",
    description=(
        "Internal endpoint for Q (Quotem's AI). "
        "XTTS-v2 (Coqui Public Model Licence — non-commercial). "
        "Used by Q's chat at /api/q-lab/speak-as-voice."
    ),
    api_name="generate",
)


if __name__ == "__main__":
    demo.queue().launch()
