"""Vision inference entry point: :func:`analyze_image` (BUILD_SPEC section 2.1).

Pipeline for one photo:

1. ``load_image`` - path / bytes / PIL / ndarray -> BGR (EXIF orientation honoured); undecodable input
   raises :class:`ai.exceptions.ImageProcessingError`.
2. ``image_quality`` - size, sharpness (variance of the Laplacian), brightness.
3. ``resize_for_model`` - at most 640 px on the longest side.
4. ``get_vision_model`` - demo heuristics, or in production YOLOv8 -> CLIP -> demo with ``fallback_reason``.
   A production model that crashes during prediction also falls back (production never crashes).
5. Post-processing - label -> category mapping (incl. admin ``vision_labels``), demo confidence caps and the
   optional, always-disclosed filename hint, boxes (clip / NMS / normalise), visual severity, explanation.
"""
from __future__ import annotations

import logging
import time

from ai.config import get_model_mode

from . import config as vcfg
from . import postprocessing as post
from .model import get_demo_model, get_vision_model, mark_inference_failure
from .preprocessing import image_quality, load_image, resize_for_model, to_gray

logger = logging.getLogger("ai.vision.inference")


def analyze_image(image, *, filename_hint=None, categories=None):
    """Analyse a civic-issue photo.

    Args:
        image: path (str/Path), raw bytes, PIL.Image or BGR numpy array.
        filename_hint: original upload filename (demo mode may use keywords in it, and must say so).
        categories: optional list of category dicts ({"slug", "name", "vision_labels", ...}) so detector
            labels can be mapped onto admin-defined categories.

    Returns (CONTRACT):
        {
          "category": "pothole", "confidence": 0.92,
          "probabilities": {"pothole": 0.92, "garbage": 0.01, ...},
          "detected_objects": [{"label": "pothole", "confidence": 0.91, "box": [x1, y1, x2, y2], "area_ratio": 0.18}],
          "bounding_boxes": [[x1, y1, x2, y2]],      # normalised 0..1, (x1, y1) = top-left
          "visual_severity": 0.74,                    # 0..1
          "quality": {"width": 1280, "height": 720, "blur_score": 210.5, "brightness": 0.46,
                      "is_blurry": False, "is_dark": False},
          "model_version": "demo-opencv-heuristic-1.0", "mode": "demo", "is_demo": True,
          "fallback_reason": None, "explanation": "...", "processing_time_ms": 41,
        }
        Additional keys: ``model_name`` (demo / yolo / clip), ``filename_hint_used`` and ``model_scores``
        (the raw per-class scores of the technique, for transparency). Each detected object also carries
        ``detector_label``, ``approximate`` (True for CLIP's salient-region boxes) and ``contrast``.
    Raises:
        ai.exceptions.ImageProcessingError if the image cannot be decoded.
    """
    started = time.perf_counter()
    img = load_image(image)
    quality = image_quality(img)
    work = resize_for_model(img)

    model, fallback_reason = get_vision_model()
    try:
        raw = model.predict(work, categories=categories)
    except Exception as exc:
        if model.is_demo:
            raise   # the deterministic OpenCV technique failing is a bug, not a deployment problem
        logger.exception("Vision model %s failed; falling back to the demo heuristics", model.key)
        fallback_reason = mark_inference_failure(model, exc)
        model = get_demo_model()
        raw = model.predict(work, categories=categories)

    probs = post.label_probs_to_class_probs(raw["label_probs"], categories, model.vocabulary)
    hint = visual = None
    if model.is_demo:
        probs = post.cap_confidence(probs, vcfg.DEMO_CONFIDENCE_CAP)
        hint_slug, keyword = post.filename_hint_class(filename_hint, categories)
        if hint_slug:
            image_only = post.top_class(probs)
            probs = post.apply_filename_hint(probs, hint_slug)
            hint = (hint_slug, keyword)
            if post.top_class(probs)[0] != image_only[0]:   # the hint changed the decision: say so
                visual = (*image_only, _evidence(raw, image_only[0], categories))
    category, confidence = post.top_class(probs)

    objects = _build_objects(raw["detections"], probs, category, categories, work, model.approximate_boxes)
    severity = post.visual_severity([o for o in objects if o["label"] == category], confidence)
    explanation = post.build_explanation(
        technique=model.technique, category=category, confidence=confidence, probs=probs,
        evidence=_evidence(raw, category, categories), categories=categories, hint=hint, visual=visual,
        fallback_reason=fallback_reason, quality=quality, approximate=model.approximate_boxes,
        n_objects=len(objects),
    )
    return {
        "category": category,
        "confidence": round(confidence, 4),
        "probabilities": post.round_probs(probs),
        "detected_objects": objects,
        "bounding_boxes": [obj["box"] for obj in objects],
        "visual_severity": severity,
        "quality": quality,
        "model_version": model.version,
        "mode": get_model_mode(),
        "is_demo": bool(model.is_demo),
        "fallback_reason": fallback_reason,
        "explanation": explanation,
        "processing_time_ms": int(round((time.perf_counter() - started) * 1000)),
        "model_name": model.key,
        "filename_hint_used": hint is not None,
        "model_scores": raw["scores"],
    }


def _evidence(raw: dict, slug: str, categories=None) -> str:
    """The technique's evidence sentence for ``slug`` (admin categories use their detector label's text)."""
    evidence = raw["evidence"]
    if slug in evidence:
        return evidence[slug]
    index = post.build_label_index(categories)
    for label, text in evidence.items():
        if label != "*" and slug in post.map_label(label, index):
            return text
    return evidence.get("*", "")


def _build_objects(detections, probs, category, categories, work, approximate):
    """Map raw detections onto categories, keep the relevant ones, NMS per class, normalise boxes.

    Objects are kept for the predicted category and for any other category whose probability reaches
    ``SECONDARY_OBJECT_MIN_PROB``. Detector confidences are used as they are; for the demo / CLIP regions
    (which have a strength instead) the confidence is the class probability scaled by the region's strength
    relative to the strongest region of that class.
    """
    h, w = work.shape[:2]
    gray = to_gray(work)
    index = post.build_label_index(categories)
    strongest: dict[str, float] = {}
    for det in detections:
        if "confidence" not in det:
            strongest[det["label"]] = max(strongest.get(det["label"], 0.0), det["strength"])
    candidates = []
    for det in detections:
        targets = post.map_label(det["label"], index)
        target = max(targets, key=lambda t: probs.get(t, 0.0))
        p = probs.get(target, 0.0)
        if target != category and p < vcfg.SECONDARY_OBJECT_MIN_PROB:
            continue
        box = post.normalize_box(det["box"], w, h)
        if box is None:
            continue
        if "confidence" in det:
            conf = det["confidence"]
        else:
            conf = p * det["strength"] / max(strongest.get(det["label"], 0.0), 1e-9)
        candidates.append({
            "label": target,
            "confidence": round(float(conf), 4),
            "box": box,
            "area_ratio": round(post.box_area_ratio(box), 4),
            "detector_label": str(det["label"]),
            "approximate": bool(approximate),
            "contrast": round(post.region_contrast(gray, det["box"]), 3),
        })
    kept = []
    for label in dict.fromkeys(c["label"] for c in candidates):
        group = [c for c in candidates if c["label"] == label]
        kept += [group[i] for i in post.nms([g["box"] for g in group], [g["confidence"] for g in group])]
    kept.sort(key=lambda o: (o["label"] != category, -o["confidence"]))
    return kept[: vcfg.MAX_REPORTED_OBJECTS]
