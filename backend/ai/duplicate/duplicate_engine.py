"""Duplicate complaint detection (BUILD_SPEC section 2.6).

Technique - multi-signal similarity scoring. For the new complaint and every candidate (already
pre-filtered by the caller to the duplicate radius and time window):

    text      embedding cosine similarity of the descriptions           (text_similarity)
    image     perceptual hashes + colour histogram (+ CLIP in production) (image_similarity)
    location  truncated Gaussian kernel of the haversine distance       (location_similarity)

    overall = w_text x text + w_image x image + w_location x location     (default 0.4 / 0.3 / 0.3)

* When either complaint has no photo the image term is dropped and the remaining weights are
  renormalised (0.4 / 0.3 -> 0.571 / 0.429), so a missing photo neither helps nor hurts.
* Category mismatch penalty: different categories multiply the score by 0.85 - unless the texts
  are more than 80 % similar (then the classifier probably disagreed, not the citizens).
* ``is_duplicate = overall >= threshold and distance <= radius``; candidates scoring below 0.45 are
  not returned at all. Results are sorted by overall similarity (closest first on ties).

Image comparison is the expensive part, so it is skipped when even a perfect image match could
not lift the candidate above the reporting floor (an exact upper-bound pruning step).
"""
import logging
import math
import os

from ..geospatial.distance import format_distance, haversine_m, parse_coordinates
from .image_similarity import compare_features, extract_features, features_from_hashes
from .location_similarity import location_similarity
from .text_similarity import batch_text_similarity

logger = logging.getLogger("ai.duplicate")

DUPLICATE_ENGINE_VERSION = "duplicate-multisignal-1.0"
DEFAULT_DUPLICATE_CONFIG = {
    "threshold": 0.72,
    "radius_m": 300,
    "weights": {"text": 0.4, "image": 0.3, "location": 0.3},
    "min_similarity": 0.45,  # candidates below this overall score are not reported
    "category_penalty": 0.85,
    "penalty_exempt_text_similarity": 0.8,
}


def _unit(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number, got {value!r}") from None
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1")
    return number


def _duplicate_config(config):
    """Defaults + the duplicate section of the engine config (the whole engine config is accepted too)."""
    section = config or {}
    if isinstance(section, dict) and isinstance(section.get("duplicate"), dict):
        section = section["duplicate"]
    if not isinstance(section, dict):
        raise ValueError("Duplicate config must be a mapping")
    cfg = {key: (dict(value) if isinstance(value, dict) else value) for key, value in DEFAULT_DUPLICATE_CONFIG.items()}
    for key in ("threshold", "min_similarity", "category_penalty", "penalty_exempt_text_similarity"):
        if section.get(key) is not None:
            cfg[key] = _unit(section[key], key)
    if section.get("radius_m") is not None:
        try:
            radius = float(section["radius_m"])
        except (TypeError, ValueError):
            radius = float("nan")
        if not math.isfinite(radius) or radius <= 0:
            raise ValueError(f"radius_m must be a positive number of metres, got {section['radius_m']!r}")
        cfg["radius_m"] = radius
    weights = dict(cfg["weights"])
    for key, value in (section.get("weights") or {}).items():
        if key not in weights:
            raise ValueError(f"Unknown duplicate weight '{key}' (expected text, image, location)")
        weights[key] = _unit(value, f"Duplicate weight '{key}'")
    if weights["text"] + weights["location"] <= 0:
        raise ValueError("Text and location weights cannot both be zero")
    cfg["weights"] = weights
    return cfg


def _image_features(record):
    """Comparable image features of a target / candidate record, or None when it has no image.

    Prefers the decoded image (``image`` = any loader input, or an existing ``image_path``); falls back
    to the stored ``phash`` / ``dhash`` (/ ``ahash``) when the file is missing or unreadable.
    """
    source = record.get("image")
    path = record.get("image_path")
    if source is None and path and os.path.isfile(str(path)):
        source = str(path)
    if source is not None:
        try:
            return extract_features(source)
        except Exception as exc:  # noqa: BLE001 - one unreadable photo must not stop duplicate detection
            logger.warning("Could not read image of complaint %s (%s); using stored hashes",
                           record.get("id"), exc)
    hashes = {kind: record.get(kind) for kind in ("phash", "dhash", "ahash") if record.get(kind)}
    return features_from_hashes(hashes) if hashes else None


def _combine(text_sim, image_sim, location_sim, weights):
    """Weighted mean of the available signals -> (overall, weights actually used)."""
    used = {"text": weights["text"], "location": weights["location"]}
    if image_sim is not None:
        used["image"] = weights["image"]
    total = sum(used.values())
    used = {key: value / total for key, value in used.items()}
    overall = used["text"] * text_sim + used["location"] * location_sim
    if image_sim is not None:
        overall += used["image"] * image_sim
    return overall, {key: round(used.get(key, 0.0), 4) for key in ("text", "image", "location")}


def _explanation(text_sim, image_sim, distance, category_match, mismatch, penalised):
    parts = [f"Text {round(text_sim * 100):.0f}% similar",
             f"images {round(image_sim * 100):.0f}% similar" if image_sim is not None else "no image comparison",
             f"{format_distance(distance)} apart"]
    if category_match:
        parts.append("same category")
    elif penalised:
        parts.append("different category (score x0.85)")
    elif mismatch:
        parts.append("different category but near-identical text")
    return ", ".join(parts)[:255]


def find_duplicates(target, candidates, *, config=None):
    """Score ``target`` against ``candidates`` (already pre-filtered by the caller to a radius / time window).

    target / candidate dict: {"id", "text", "latitude", "longitude", "category", "phash", "dhash",
                              "image_path" (optional), "created_at" (optional)}
    config: {"threshold": 0.72, "radius_m": 300, "weights": {"text": 0.4, "image": 0.3, "location": 0.3}}

    Returns (CONTRACT) list sorted by overall_similarity desc (only candidates with overall >= 0.45):
        [{"complaint_id": 7, "text_similarity": 0.86, "image_similarity": 0.91 | None,
          "location_similarity": 0.97, "distance_m": 42.0, "category_match": True,
          "overall_similarity": 0.89, "is_duplicate": True, "explanation": "..."}]

    Records may also carry ``image`` (raw image input instead of a path) and ``ahash``. Each result adds
    ``weights`` (the renormalised weights used), ``category_penalty_applied`` and ``image_method``.
    The target needs valid coordinates (ValueError otherwise); candidates without valid coordinates or
    with the target's own id are skipped. Text-embedding errors propagate to the caller.
    """
    cfg = _duplicate_config(config)
    t_lat, t_lng = parse_coordinates(target.get("latitude"), target.get("longitude"))
    target_id = target.get("id")

    pool = []
    for candidate in candidates or []:
        if target_id is not None and candidate.get("id") == target_id:
            continue
        try:
            c_lat, c_lng = parse_coordinates(candidate.get("latitude"), candidate.get("longitude"))
        except ValueError:
            logger.warning("Skipping duplicate candidate %s with invalid coordinates", candidate.get("id"))
            continue
        pool.append((candidate, haversine_m(t_lat, t_lng, c_lat, c_lng)))
    if not pool:
        return []

    text_scores = batch_text_similarity(target.get("text") or "", [c.get("text") or "" for c, _ in pool])
    weights = cfg["weights"]
    target_category = target.get("category") or None
    target_features = None
    target_features_loaded = False

    results = []
    for (candidate, distance), text_sim in zip(pool, text_scores):
        location_sim = location_similarity(distance, cfg["radius_m"])
        candidate_category = candidate.get("category") or None
        category_match = bool(target_category and candidate_category == target_category)
        mismatch = bool(target_category and candidate_category and not category_match)
        penalised = mismatch and text_sim <= cfg["penalty_exempt_text_similarity"]
        factor = cfg["category_penalty"] if penalised else 1.0

        # Upper bound: score with a perfect image match. If even that cannot reach the reporting floor
        # the candidate is dropped without the (expensive) image comparison - the true score is lower.
        best_case, _ = _combine(text_sim, 1.0, location_sim, weights)
        if best_case * factor < cfg["min_similarity"]:
            continue

        image_sim, image_method = None, None
        if weights["image"] > 0:
            if not target_features_loaded:
                target_features, target_features_loaded = _image_features(target), True
            candidate_features = _image_features(candidate) if target_features is not None else None
            if candidate_features is not None:
                comparison = compare_features(target_features, candidate_features)
                image_sim, image_method = comparison["similarity"], comparison["method"]

        overall, used_weights = _combine(text_sim, image_sim, location_sim, weights)
        overall *= factor
        if overall < cfg["min_similarity"]:
            continue
        results.append({
            "complaint_id": candidate.get("id"),
            "text_similarity": round(text_sim, 4),
            "image_similarity": round(image_sim, 4) if image_sim is not None else None,
            "location_similarity": round(location_sim, 4),
            "distance_m": round(distance, 1),
            "category_match": category_match,
            "overall_similarity": round(overall, 4),
            "is_duplicate": bool(overall >= cfg["threshold"] and distance <= cfg["radius_m"]),
            "explanation": _explanation(text_sim, image_sim, distance, category_match, mismatch, penalised),
            "weights": used_weights,
            "category_penalty_applied": penalised,
            "image_method": image_method,
        })

    results.sort(key=lambda r: (-r["overall_similarity"], r["distance_m"], str(r["complaint_id"])))
    return results
