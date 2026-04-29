"""
Q's Graphics Space — StarVector image-to-SVG on HuggingFace ZeroGPU
====================================================================

StarVector (ServiceNow + Mila + ETS) generates clean SVG vector code
from an input raster image. Open weights, Apache 2.0.

Use case for Q: Sarah uploads an icon, logo sketch, or simple shape
and gets back a scalable SVG she can edit in any vector tool.

For text-to-SVG: generate an image first via the image-gen Space, then
vectorise it through here. (StarVector-im2svg is far more reliable than
the text-to-SVG variant in 2026.)
"""
import io
import spaces
import gradio as gr
import torch
from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor

MODEL_ID = "starvector/starvector-1b-im2svg"

_model = None
_processor = None


def _load():
    global _model, _processor
    if _model is None:
        _model = AutoModelForCausalLM.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to("cuda").eval()
        _processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    return _model, _processor


@spaces.GPU(duration=120)
def vectorise(image: Image.Image):
    if image is None:
        raise gr.Error("Need an image to vectorise.")
    model, processor = _load()
    inputs = processor(images=image.convert("RGB"), return_tensors="pt").to("cuda", torch.bfloat16)
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=1500,
            do_sample=False,
        )
    svg_text = processor.batch_decode(outputs, skip_special_tokens=True)[0]
    # Strip any non-SVG prefix the model emits.
    if "<svg" in svg_text:
        svg_text = svg_text[svg_text.index("<svg"):]
    if "</svg>" in svg_text:
        svg_text = svg_text[: svg_text.rindex("</svg>") + len("</svg>")]
    return svg_text, svg_text  # second slot for the file download


demo = gr.Interface(
    fn=vectorise,
    inputs=gr.Image(type="pil", label="Source image (logo, icon, simple shape)"),
    outputs=[
        gr.Code(label="SVG", language="html"),
        gr.Textbox(label="SVG (copyable)"),
    ],
    title="Q's Graphics — Image to SVG",
    description=(
        "Internal endpoint for Q (Quotem's AI). "
        "Powered by StarVector (ServiceNow, Apache 2.0). "
        "Best results on logos, icons, and clean line art with limited colours."
    ),
    allow_flagging="never",
    api_name="vectorise",
)


if __name__ == "__main__":
    demo.queue().launch()
