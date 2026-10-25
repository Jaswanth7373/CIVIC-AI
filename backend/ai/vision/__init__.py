"""Computer vision for civic issues (YOLO / CLIP zero-shot / demo OpenCV heuristics).

Public API (CONTRACT - keep these names/signatures):
    analyze_image(image, *, filename_hint=None, categories=None) -> dict
    describe_models() -> list[dict]
"""
from .inference import analyze_image  # noqa: F401
from .model import describe_models  # noqa: F401
