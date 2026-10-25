"""AI-assisted before/after resolution verification.

Public API (CONTRACT):
    verify_resolution(before_image, after_image, *, category=None, boxes=None, config=None) -> dict
    describe_models() -> list[dict]
"""
from .verifier import describe_models, verify_resolution  # noqa: F401
