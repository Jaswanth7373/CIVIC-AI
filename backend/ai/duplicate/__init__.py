"""Duplicate complaint detection (text + image + location similarity).

    find_duplicates(target, candidates, *, config) -> [match dict, ...]
    compute_hashes(image) / hash_similarity(h1, h2) / batch_text_similarity(query, texts)

The similarity functions that share their module's name are imported from the module itself,
e.g. ``from ai.duplicate.image_similarity import image_similarity`` (re-exporting them here would
shadow the sub-modules ``ai.duplicate.image_similarity`` / ``text_similarity`` / ``location_similarity``).
"""
from .duplicate_engine import DEFAULT_DUPLICATE_CONFIG, DUPLICATE_ENGINE_VERSION, find_duplicates  # noqa: F401
from .image_similarity import compute_hashes, hash_similarity, load_image_bgr  # noqa: F401
from .text_similarity import batch_text_similarity  # noqa: F401
