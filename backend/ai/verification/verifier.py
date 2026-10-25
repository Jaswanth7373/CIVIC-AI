"""AI-assisted before/after resolution verification (BUILD_SPEC section 2.8).

``verify_resolution`` answers "does the after-photo show the reported issue fixed?" with a 0-100 score,
a status and plain-English reasons. It combines three independent kinds of evidence:

1. **Same place?** (``scene_consistency``) - ORB feature matching + RANSAC homography between the photos
   (:mod:`ai.verification.preprocessing`). In production mode the CLIP image embeddings of both photos
   are compared as well: an after-photo that shows something unrelated is vetoed.
2. **Did the damaged area change?** (``region_change``) - after aligning the photos, a per-pixel change
   map (SSIM dissimilarity, brightness and colour difference after a robust exposure / white-balance
   correction) is summarised inside the originally detected boxes (or the most-changed area), relative to
   the change in the rest of the scene (:mod:`ai.verification.metrics`).
3. **Is the issue still visible?** (``issue_still_detected``) - the vision model re-analyses both photos;
   ``after_issue_confidence`` is its probability for the complaint's category in the after-photo and
   ``before_issue_confidence`` in the before-photo. Only the *relative* drop is trusted: if the model did
   not recognise the issue in the before-photo either (probability < 0.30), re-detection is not used.

Score::

    change = ramp(region_change, 0.05 -> 0.50)          (no change in the damaged area -> 0)
    ratio  = after_issue_confidence / before_issue_confidence
    gone   = 1 - ramp(ratio, 0 -> 0.90)                 (any residual chance that the issue is visible counts)
    raw    = 100 * change * (0.35 + 0.65 * gone)        (change only, no re-detection: 100 * change * 0.85)
    score  = raw * min(1, scene_consistency / 0.5) ** 0.5   (x 0.8 when image quality is poor)

Status rules: poor quality or scene mismatch (consistency < 0.25) -> ``needs_manual_review``; the issue is
still detected (after-probability >= 0.45, or top class with >= 0.35, and at least 60% of the
before-probability) -> ``not_resolved`` (score capped below the partial threshold); otherwise
``score >= resolved_threshold`` -> ``likely_resolved``, ``>= partial_threshold`` -> ``partially_resolved``,
else ``not_resolved``. The result always carries the disclaimer: officers and admins can override it.
"""
from __future__ import annotations

import logging
import time

import cv2
import numpy as np

from ai.common import set_status
from ai.config import CLIP_MODEL, get_model_mode
from ai.exceptions import ModelUnavailableError
from ai.vision import analyze_image
from ai.vision import config as vcfg
from ai.vision.model import clip_status, load_clip_model, short_error
from ai.vision.postprocessing import class_label, normalize_label, pct
from ai.vision.preprocessing import image_quality, load_image

from . import metrics as m
from .preprocessing import align_images, prepare_pair

logger = logging.getLogger("ai.verification")

DEMO_VERSION = "demo-opencv-verification-1.0"
PRODUCTION_VERSION = f"opencv-verification-1.0+{CLIP_MODEL}"
DISCLAIMER = "AI-assisted verification - not a guarantee. Officers and admins can override the result."
DEFAULT_CONFIG = {"resolved_threshold": 70, "partial_threshold": 45}
STATUS_LABELS = {
    "likely_resolved": "Likely Resolved",
    "partially_resolved": "Partially Resolved",
    "not_resolved": "Not Resolved",
    "needs_manual_review": "Needs Manual Review",
}

#: Below this scene consistency the photos probably do not show the same place.
SCENE_MISMATCH = 0.25
#: Scene consistency at which the score is no longer reduced.
SCENE_FULL_TRUST = 0.5
#: The issue counts as still visible when it is the top class of the after-photo with at least this
#: probability (whatever the before-probability was: the model's best guess for the after-photo is the issue) ...
STILL_DETECTED_TOP_PROB = 0.35
#: ... or when the vision model still gives it at least this probability ...
STILL_DETECTED_PROB = 0.45
#: ... and that is at least this share of the before-probability.
STILL_DETECTED_RATIO = 0.6
#: Re-detection is only meaningful if the model recognised the issue in the before-photo.
MIN_BEFORE_PROB = 0.30
#: Photos darker than this mean brightness, or less sharp than this, cannot be compared reliably.
MIN_BRIGHTNESS = 0.08
MIN_SHARPNESS = vcfg.BLUR_THRESHOLD / 2.0
#: Without enough ORB keypoints (plain surfaces) a capped global similarity stands in for geometry.
GLOBAL_SIMILARITY_CAP = 0.6
#: CLIP cosine similarity below which the after-photo is considered unrelated to the before-photo.
CLIP_VETO_RANGE = (0.60, 0.80)


def _ramp(x: float, lo: float, hi: float) -> float:
    return float(np.clip((x - lo) / (hi - lo), 0.0, 1.0))


def _r(value, digits=3):
    return None if value is None else round(float(value), digits)


def _thresholds(config) -> tuple[int, int]:
    cfg = dict(DEFAULT_CONFIG)
    if config:
        cfg.update(config.get("verification", config))
    resolved, partial = int(cfg["resolved_threshold"]), int(cfg["partial_threshold"])
    if not 0 < partial < resolved <= 100:
        raise ValueError("verification thresholds must satisfy 0 < partial_threshold < resolved_threshold <= 100")
    return resolved, partial


def _quality(before_q: dict, after_q: dict) -> tuple[bool, str]:
    problems = []
    for name, q in (("before", before_q), ("after", after_q)):
        if q["brightness"] < MIN_BRIGHTNESS:
            problems.append(f"the {name}-photo is too dark")
        if q["blur_score"] < MIN_SHARPNESS:
            problems.append(f"the {name}-photo is too blurry")
    return not problems, " and ".join(problems)


def _clip_similarity(before: np.ndarray, after: np.ndarray):
    """Cosine similarity of the CLIP embeddings (production) -> ``(value | None, unavailable_reason | None)``."""
    try:
        clip = load_clip_model()
    except ModelUnavailableError as exc:
        return None, str(exc)
    try:
        return float(np.dot(clip.encode_image(before), clip.encode_image(after))), None
    except Exception as exc:   # inference failure must not break verification
        logger.exception("CLIP scene similarity failed")
        return None, f"CLIP scene similarity failed ({short_error(exc)})"


def verify_resolution(before_image, after_image, *, category=None, boxes=None, config=None):
    """Compare a before and an after image of a civic issue.

    Args:
        before_image / after_image: path, bytes, PIL.Image or numpy array.
        category: category slug of the issue (e.g. "pothole") - used for re-detection. When omitted, the
            category the vision model sees in the before-photo is used.
        boxes: normalised [x1, y1, x2, y2] boxes of the originally detected issue (from AIPrediction).
        config: {"resolved_threshold": 70, "partial_threshold": 45} (or the full engine config, whose
            "verification" section is used).

    Returns (CONTRACT):
        {
          "score": 91,
          "status": "likely_resolved",   # likely_resolved | partially_resolved | not_resolved | needs_manual_review
          "status_label": "Likely Resolved",
          "explanation": "The after-image shows substantial visual change in the previously detected damaged area.",
          "metrics": {"ssim": 0.41, "histogram_similarity": 0.62, "change_ratio": 0.38, "region_change": 0.71,
                      "scene_consistency": 0.83, "issue_still_detected": False, "after_issue_confidence": 0.12,
                      "quality_ok": True},
          "model_version": "demo-opencv-verification-1.0", "mode": "demo", "is_demo": True,
          "disclaimer": "AI-assisted verification - not a guarantee. Officers and admins can override the result.",
          "processing_time_ms": 85,
        }
        ``metrics`` additionally holds edge_density_change, mean_abs_diff, colour_shift, alignment counts,
        region_source, after_category(_confidence) and clip_similarity (flat scalars only). Extra top-level
        keys: ``fallback_reason`` (production only, when CLIP was unavailable) and ``details`` (region box,
        quality of both photos, category used, vision model version).
    Raises:
        ai.exceptions.ImageProcessingError if either image cannot be decoded.
        ValueError if the thresholds in ``config`` are inconsistent.
    """
    started = time.perf_counter()
    resolved_t, partial_t = _thresholds(config)
    before_full, after_full = load_image(before_image), load_image(after_image)
    before_q, after_q = image_quality(before_full), image_quality(after_full)
    quality_ok, quality_problem = _quality(before_q, after_q)

    before, after, info = prepare_pair(before_full, after_full)
    alignment = align_images(before, after)
    valid = alignment.valid
    ssim_value = m.ssim(before, alignment.after, valid)
    hist_value = m.histogram_similarity(before, alignment.after, valid)
    change = m.change_map(before, alignment.after, valid)
    region_value, region_box, region_source = m.region_change(change, boxes, valid)

    # --- 1. same place? ---------------------------------------------------------------------------
    if alignment.aligned or alignment.enough_features:
        scene = alignment.scene_consistency
    else:   # plain photos: no geometric evidence either way -> weaker, capped global similarity
        scene = min(GLOBAL_SIMILARITY_CAP, 0.5 * ssim_value + 0.5 * hist_value)
    mode = get_model_mode()
    clip_similarity, clip_problem = None, None
    if mode == "production":
        clip_similarity, clip_problem = _clip_similarity(before, after)
        if clip_similarity is not None:
            veto = _ramp(clip_similarity, *CLIP_VETO_RANGE)
            scene = min(scene, veto) if (alignment.aligned or alignment.enough_features) else \
                min(GLOBAL_SIMILARITY_CAP, 0.8 * _ramp(clip_similarity, 0.75, 0.95))

    # --- 2. is the issue still visible? ---------------------------------------------------------------
    before_vision = analyze_image(before_full)
    target = normalize_label(category) if category else before_vision["category"]
    inferred = not category
    after_vision = analyze_image(after_full)
    before_conf = float(before_vision["probabilities"].get(target, 0.0))
    after_conf = float(after_vision["probabilities"].get(target, 0.0))
    applicable = target in vcfg.VISION_CLASSES and target != vcfg.FALLBACK_CLASS and before_conf >= MIN_BEFORE_PROB
    ratio = after_conf / max(before_conf, MIN_BEFORE_PROB)
    top_in_after = after_vision["category"] == target and after_conf >= STILL_DETECTED_TOP_PROB
    still = applicable and (top_in_after or (ratio >= STILL_DETECTED_RATIO and after_conf >= STILL_DETECTED_PROB))

    # --- 3. score + status --------------------------------------------------------------------------
    change_t = _ramp(region_value, 0.05, 0.50)
    if applicable:
        raw = 100.0 * change_t * (0.35 + 0.65 * (1.0 - _ramp(ratio, 0.0, 0.90)))
    else:
        raw = 100.0 * change_t * 0.85
    score = raw * min(1.0, scene / SCENE_FULL_TRUST) ** 0.5 * (1.0 if quality_ok else 0.8)
    # The status follows the whole-number score that is stored and shown: 69.6 is shown as 70, so with a
    # threshold of 70 it must read "likely resolved".
    score = int(round(float(np.clip(score, 0, 100))))
    if not quality_ok or scene < SCENE_MISMATCH:
        status = "needs_manual_review"
    elif still:
        status, score = "not_resolved", min(score, partial_t - 1)
    elif score >= resolved_t:
        status = "likely_resolved"
    elif score >= partial_t:
        status = "partially_resolved"
    else:
        status = "not_resolved"

    is_demo = mode != "production" or clip_similarity is None or bool(after_vision["is_demo"])
    # the vision module's reason is the more complete one (it covers YOLO and CLIP); else the scene check's
    fallback_reason = (after_vision["fallback_reason"] or clip_problem) if mode == "production" else None
    explanation = _explain(
        target=target, applicable=applicable, after_conf=after_conf, before_conf=before_conf, still=still,
        region_value=region_value, region_source=region_source, scene=scene, alignment=alignment,
        clip_similarity=clip_similarity, quality_problem=quality_problem, inferred=inferred, is_demo=is_demo,
        fallback_reason=fallback_reason,
    )
    metrics = {
        "ssim": _r(ssim_value), "histogram_similarity": _r(hist_value),
        "change_ratio": _r(m.change_ratio(change, valid)), "region_change": _r(region_value),
        "scene_consistency": _r(scene), "issue_still_detected": bool(still), "after_issue_confidence": _r(after_conf),
        "quality_ok": bool(quality_ok), "before_issue_confidence": _r(before_conf),
        "edge_density_change": _r(m.edge_density_change(before, alignment.after, valid)),
        "mean_abs_diff": _r(m.mean_abs_diff(before, alignment.after, valid)),
        "colour_shift": _r(m.colour_shift(before, alignment.after, valid)),
        "aligned": bool(alignment.aligned), "alignment_matches": int(alignment.matches),
        "alignment_inliers": int(alignment.inliers), "alignment_inlier_ratio": _r(alignment.inlier_ratio),
        "region_source": region_source, "after_category": after_vision["category"],
        "after_category_confidence": _r(after_vision["confidence"]), "clip_similarity": _r(clip_similarity),
    }
    _report_status(mode, clip_similarity is not None, clip_problem)
    return {
        "score": score,
        "status": status,
        "status_label": STATUS_LABELS[status],
        "explanation": explanation,
        "metrics": metrics,
        "model_version": PRODUCTION_VERSION if (mode == "production" and clip_similarity is not None) else DEMO_VERSION,
        "mode": mode,
        "is_demo": bool(is_demo),
        "disclaimer": DISCLAIMER,
        "processing_time_ms": int(round((time.perf_counter() - started) * 1000)),
        "fallback_reason": fallback_reason,
        "details": {
            "category": target, "category_inferred": inferred, "redetection_applicable": applicable,
            "region_box": region_box, "before_quality": before_q, "after_quality": after_q,
            "aspect_ratio_mismatch": info["aspect_mismatch"], "alignment_method": alignment.method,
            "vision_model_version": after_vision["model_version"],
        },
    }


def _explain(*, target, applicable, after_conf, before_conf, still, region_value, region_source, scene,
             alignment, clip_similarity, quality_problem, inferred, is_demo, fallback_reason) -> str:
    """Plain-English reasons, most decisive first."""
    issue = class_label(target).lower()
    where = ("the previously detected damaged area" if region_source == "prior_boxes"
             else "the most-changed part of the photo")
    sentences = []
    if quality_problem:
        sentences.append(f"Image quality is too low for a reliable comparison: {quality_problem}.")
    if scene < SCENE_MISMATCH:
        sentences.append(f"The two photos may not show the same place (scene consistency {pct(scene)}), "
                         "so the result needs a manual review.")
    if region_value >= 0.35:
        sentences.append(f"The after-image shows substantial visual change in {where} "
                         f"(region change {pct(region_value)}).")
    elif region_value >= 0.15:
        sentences.append(f"The after-image shows some visual change in {where} (region change {pct(region_value)}).")
    else:
        sentences.append(f"{where[0].upper()}{where[1:]} looks largely unchanged (region change {pct(region_value)}).")
    if applicable and still:
        sentences.append(f"The {issue} is still detected in the after-image (confidence {pct(after_conf)}, "
                         f"before {pct(before_conf)}).")
    elif applicable:
        sentences.append(f"The {issue} is no longer detected in the after-image ({issue} confidence "
                         f"{pct(after_conf)}, down from {pct(before_conf)} before).")
    elif target in vcfg.VISION_CLASSES and target != vcfg.FALLBACK_CLASS:
        sentences.append(f"The vision model did not clearly recognise the {issue} in the before-photo "
                         f"({pct(before_conf)}), so the decision rests on visual change.")
    else:
        sentences.append("Issue re-detection is not applicable to this category, so the decision rests on "
                         "visual change.")
    if scene >= SCENE_MISMATCH:
        same = (f"{alignment.inliers} matching features after alignment" if alignment.aligned else
                "global image similarity - the photos could not be aligned feature by feature")
        sentences.append(f"Both photos appear to show the same place (scene consistency {pct(scene)}, {same}).")
    if clip_similarity is not None:
        sentences.append(f"CLIP image embeddings of the two photos have a cosine similarity of {clip_similarity:.2f}.")
    if inferred:
        sentences.append(f"No category was given, so the category seen in the before-photo ({issue}) was used.")
    if fallback_reason:
        sentences.append(f"Production models were partly unavailable ({fallback_reason}); demo techniques were "
                         "used instead.")
    if is_demo:
        sentences.append("Demo AI Mode: OpenCV image comparison (ORB alignment, SSIM, histograms) and the demo "
                         "vision heuristics, not trained deep-learning models.")
    return " ".join(sentences)


def _report_status(mode: str, clip_used: bool, clip_problem) -> None:
    set_status("verification.opencv", task="Before/after resolution verification", status="active",
               version=DEMO_VERSION if not clip_used else PRODUCTION_VERSION, framework=f"OpenCV {cv2.__version__}",
               is_demo=mode != "production", detail="ORB + RANSAC alignment, SSIM, histogram, edge and region change.")
    if mode == "production":
        set_status("verification.clip_scene", task="Before/after scene similarity (CLIP)",
                   status="active" if clip_used else "fallback", version=CLIP_MODEL, framework="sentence-transformers",
                   is_demo=False, detail="CLIP embedding cosine similarity of both photos." if clip_used
                   else f"Unavailable: {clip_problem}")


def describe_models():
    """``[{name, task, framework, version, status, is_demo, detail}]`` for the admin "Model information" page."""
    mode = get_model_mode()
    state, detail = clip_status()
    clip_usable = state in ("loaded", "available")
    if state == "loaded":
        state = "active" if mode == "production" else "available"
    elif state == "available":
        detail += " Used for the same-place check when MODEL_MODE=production." if mode != "production" else \
            " Loaded on the first production verification."
    return [
        {
            "name": "OpenCV before/after comparison",
            "task": "Before/after resolution verification",
            "framework": f"OpenCV {cv2.__version__}",
            "version": PRODUCTION_VERSION if mode == "production" and clip_usable else DEMO_VERSION,
            "status": "active",
            "is_demo": mode != "production",
            "detail": "ORB + RANSAC homography alignment, SSIM (Gaussian-window formula), HSV histogram "
                      "correlation, Canny edge density, region change in the detected boxes, and re-detection "
                      "of the issue with the vision model.",
        },
        {
            "name": "CLIP scene similarity",
            "task": "Same-place check for before/after photos",
            "framework": "sentence-transformers",
            "version": CLIP_MODEL,
            "status": state,
            "is_demo": False,
            "detail": detail,
        },
    ]
