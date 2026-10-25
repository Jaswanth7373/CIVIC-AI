"""Multimodal (image + text + location) fusion.

    fuse_predictions(image_result, text_result, *, reported_category, location_prior, categories, config)
"""
from .fusion import DEFAULT_FUSION_CONFIG, FUSION_VERSION, fuse_predictions  # noqa: F401
