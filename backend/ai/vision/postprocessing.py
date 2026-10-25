"""Post-processing shared by every vision technique (demo heuristics, YOLO, CLIP).

The models produce *raw* output - label probabilities and pixel boxes. This module turns that into the
contract of :func:`ai.vision.analyze_image`:

1. **Label -> category mapping.** A detector label (``"D40"``, ``"trash"``, ``"pothole"``) is mapped to the
   canonical CivicAI class through :data:`ai.vision.config.LABEL_SYNONYMS`, and additionally to every
   admin-defined category whose ``vision_labels`` contain it. Probability mass of a label that maps to
   several categories is shared equally between them (the image cannot tell them apart - the text model
   and the multimodal fusion can).
2. **Boxes** are clipped to the image, de-duplicated with non-maximum suppression (NMS) and normalised to
   0-1 so the frontend can draw them on any display size.
3. **Honesty rules**: demo confidences are capped (0.75, or 0.90 with a disclosed filename hint).
4. **Visual severity** (0-1) from defect area, darkness/contrast of the defect region and detection count.
5. **Explanation** - a plain-English sentence describing what was seen and by which technique.
"""
from __future__ import annotations

import math
import re
from pathlib import PurePath

import cv2
import numpy as np

from ai.config import CLASS_LABELS

from . import config as vcfg


# ------------------------------------------------------------------------------------------------------
# Boxes
# ------------------------------------------------------------------------------------------------------
def box_iou(a, b) -> float:
    """Intersection-over-union of two ``[x1, y1, x2, y2]`` boxes (any consistent unit)."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / union) if union > 0 else 0.0


def nms(boxes, scores, iou_threshold: float = vcfg.NMS_IOU_THRESHOLD) -> list[int]:
    """Greedy non-maximum suppression; returns the indices of the boxes to keep (best first).

    Repeatedly keep the highest-scoring box and discard every remaining box that overlaps it by more than
    ``iou_threshold`` - so one physical defect is reported once even if several candidates cover it.
    """
    order = sorted(range(len(boxes)), key=lambda i: -float(scores[i]))
    keep: list[int] = []
    for i in order:
        if all(box_iou(boxes[i], boxes[j]) <= iou_threshold for j in keep):
            keep.append(i)
    return keep


def clip_box(box, width: int, height: int):
    """Clip a pixel box to the image; ``None`` when nothing (or less than 1 px) is left."""
    x1, y1, x2, y2 = (float(v) for v in box)
    x1, x2 = sorted((min(max(x1, 0.0), width), min(max(x2, 0.0), width)))
    y1, y2 = sorted((min(max(y1, 0.0), height), min(max(y2, 0.0), height)))
    if x2 - x1 < 1.0 or y2 - y1 < 1.0:
        return None
    return [x1, y1, x2, y2]


def normalize_box(box, width: int, height: int):
    """Pixel box -> ``[x1, y1, x2, y2]`` in 0..1 (top-left origin), clipped, 4 decimals."""
    clipped = clip_box(box, width, height)
    if clipped is None:
        return None
    x1, y1, x2, y2 = clipped
    return [round(x1 / width, 4), round(y1 / height, 4), round(x2 / width, 4), round(y2 / height, 4)]


def box_area_ratio(norm_box) -> float:
    return float(max(0.0, norm_box[2] - norm_box[0]) * max(0.0, norm_box[3] - norm_box[1]))


def spectral_residual_saliency(gray: np.ndarray) -> np.ndarray:
    """Saliency map (0-1, same size as ``gray``) by the *spectral residual* method (Hou & Zhang, CVPR 2007).

    Natural images share a smooth average log-amplitude spectrum; what deviates from it (the "residual")
    is what stands out. Steps on a 64x64 thumbnail: FFT -> log amplitude ``L`` and phase ``P`` ->
    residual ``R = L - mean3x3(L)`` -> back-transform ``|IFFT(exp(R + iP))|^2`` -> Gaussian smoothing.
    """
    h, w = gray.shape[:2]
    small = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA).astype(np.float64)
    spectrum = np.fft.fft2(small)
    log_amp = np.log(np.abs(spectrum) + 1e-8)
    residual = log_amp - cv2.blur(log_amp, (3, 3))
    saliency = np.abs(np.fft.ifft2(np.exp(residual + 1j * np.angle(spectrum)))) ** 2
    saliency = cv2.GaussianBlur(saliency, (0, 0), 2.5)
    saliency = cv2.resize(saliency, (w, h), interpolation=cv2.INTER_LINEAR)
    saliency -= saliency.min()
    return saliency / saliency.max() if saliency.max() > 0 else saliency


def salient_region_box(img: np.ndarray):
    """Pixel box around the most salient region (Otsu threshold of the saliency map, largest blob).

    Used to give a classification-only model (CLIP) an *approximate* location to show; returns ``None``
    when nothing stands out.
    """
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    saliency = (spectral_residual_saliency(gray) * 255).astype(np.uint8)
    _, mask = cv2.threshold(saliency, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n < 2:
        return None
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, bw, bh, area = stats[i]
    if area < 0.002 * gray.size:
        return None
    return [float(x), float(y), float(x + bw), float(y + bh)]


def region_contrast(gray: np.ndarray, box) -> float:
    """Darkness / contrast of a defect region (0-1), comparing the box with a ring around it.

    ``|median(inside) - median(ring)| / 80`` measures how much darker (pothole, manhole) or brighter the
    region is; half of ``|std(inside) - std(ring)| / 40`` adds texture contrast (a colourful garbage pile on
    plain pavement). Both are clipped so the result stays in 0..1.
    """
    h, w = gray.shape[:2]
    clipped = clip_box(box, w, h)
    if clipped is None:
        return 0.0
    x1, y1, x2, y2 = (int(round(v)) for v in clipped)
    pad_x, pad_y = max(3, (x2 - x1) // 4), max(3, (y2 - y1) // 4)
    ox1, oy1, ox2, oy2 = max(0, x1 - pad_x), max(0, y1 - pad_y), min(w, x2 + pad_x), min(h, y2 + pad_y)
    inner = gray[y1:y2, x1:x2].astype(np.float32)
    outer = gray[oy1:oy2, ox1:ox2].astype(np.float32)
    ring_mask = np.ones(outer.shape, bool)
    ring_mask[y1 - oy1:y2 - oy1, x1 - ox1:x2 - ox1] = False
    ring = outer[ring_mask]
    if inner.size == 0 or ring.size < 10:
        return 0.0
    level = abs(float(np.median(inner)) - float(np.median(ring))) / 80.0
    texture = abs(float(inner.std()) - float(ring.std())) / 40.0
    return float(min(1.0, level + 0.5 * texture))


# ------------------------------------------------------------------------------------------------------
# Labels and categories
# ------------------------------------------------------------------------------------------------------
def normalize_label(label) -> str:
    """``"Open Manhole"`` / ``"open-manhole"`` -> ``"open_manhole"``."""
    return re.sub(r"[^a-z0-9]+", "_", str(label).strip().lower()).strip("_")


def _category_labels(category: dict) -> list[str]:
    labels = category.get("vision_labels") or []
    if isinstance(labels, str):
        labels = [part for part in re.split(r"[,;]", labels)]
    out = [normalize_label(category.get("slug", ""))]
    out += [normalize_label(label) for label in labels if str(label).strip()]
    return [label for label in dict.fromkeys(out) if label]


def build_label_index(categories) -> dict[str, list[str]]:
    """Map every normalised label (category slug + its ``vision_labels``) to the category slugs using it."""
    index: dict[str, list[str]] = {}
    for category in categories or []:
        slug = normalize_label(category.get("slug", ""))
        if not slug:
            continue
        for label in _category_labels(category):
            index.setdefault(label, [])
            if slug not in index[label]:
                index[label].append(slug)
    return index


def map_label(label, label_index=None) -> list[str]:
    """All category slugs a detector label stands for.

    Built-in synonym first (``"d40"`` -> ``pothole``), then every category declaring the label in its
    ``vision_labels``. When an admin category claims a label, the generic ``other`` class is dropped (the
    specific category is the better answer). Unknown labels map to ``other``.
    """
    key = normalize_label(label)
    targets: list[str] = []
    canonical = vcfg.LABEL_SYNONYMS.get(key)
    if canonical:
        targets.append(canonical)
    for slug in (label_index or {}).get(key, []):
        if slug not in targets:
            targets.append(slug)
    if len(targets) > 1 and vcfg.FALLBACK_CLASS in targets:
        targets.remove(vcfg.FALLBACK_CLASS)
    return targets or [vcfg.FALLBACK_CLASS]


def matching_categories(categories, vocabulary) -> list[str]:
    """Admin (non-canonical) category slugs whose labels intersect the model's label vocabulary."""
    vocab = {normalize_label(v) for v in vocabulary}
    matches = []
    for category in categories or []:
        slug = normalize_label(category.get("slug", ""))
        if slug and slug not in vcfg.VISION_CLASSES and vocab.intersection(_category_labels(category)):
            matches.append(slug)
    return matches


def label_probs_to_class_probs(label_probs: dict, categories=None, vocabulary=()) -> dict:
    """Convert model label probabilities into category probabilities (all canonical classes present).

    Every label's probability is split equally between the categories it maps to (:func:`map_label`).
    Admin categories whose ``vision_labels`` match the model vocabulary appear even when their share is 0,
    so the key set is stable for a given category configuration. The result sums to 1.
    """
    index = build_label_index(categories)
    probs = {cls: 0.0 for cls in vcfg.VISION_CLASSES}
    for slug in matching_categories(categories, vocabulary):
        probs.setdefault(slug, 0.0)
    for label, p in label_probs.items():
        targets = map_label(label, index)
        share = float(p) / len(targets)
        for target in targets:
            probs[target] = probs.get(target, 0.0) + share
    total = sum(probs.values())
    if total <= 0:
        probs[vcfg.FALLBACK_CLASS] = 1.0
        total = 1.0
    return {k: v / total for k, v in probs.items()}


def detection_evidence(detections) -> dict[str, float]:
    """Per-label evidence from detector boxes with a *noisy-OR*: ``1 - prod(1 - conf_i)``.

    Two 60% boxes of the same label give 84% evidence that the label is present - more boxes make the
    image-level claim stronger, but it can never exceed 100%.
    """
    remaining: dict[str, float] = {}
    for det in detections:
        key = normalize_label(det["label"])
        remaining[key] = remaining.get(key, 1.0) * (1.0 - float(det["confidence"]))
    return {label: 1.0 - rest for label, rest in remaining.items()}


def evidence_to_label_probs(evidence: dict[str, float]) -> dict[str, float]:
    """Image-level label probabilities from detector evidence.

    Detector confidences are used directly. If they sum to more than 1 they are normalised. Otherwise the
    unexplained mass (the chance that none of the detections is a real defect) is split:
    ``NO_DETECTION_OTHER_SHARE`` to ``other`` and the rest uniformly over all classes - so an image with no
    detections is "probably other", but with an honest, low confidence.
    """
    total = sum(evidence.values())
    if total >= 1.0:
        return {label: value / total for label, value in evidence.items()}
    probs = dict(evidence)
    residual = 1.0 - total
    probs[vcfg.FALLBACK_CLASS] = probs.get(vcfg.FALLBACK_CLASS, 0.0) + residual * vcfg.NO_DETECTION_OTHER_SHARE
    uniform = residual * (1.0 - vcfg.NO_DETECTION_OTHER_SHARE) / len(vcfg.VISION_CLASSES)
    for cls in vcfg.VISION_CLASSES:
        probs[cls] = probs.get(cls, 0.0) + uniform
    return probs


# ------------------------------------------------------------------------------------------------------
# Probabilities
# ------------------------------------------------------------------------------------------------------
def softmax(scores: dict, temperature: float = 1.0) -> dict:
    """Numerically stable softmax over a ``{label: score}`` dict."""
    keys = list(scores)
    values = np.array([scores[k] for k in keys], dtype=np.float64) / max(temperature, 1e-9)
    values -= values.max()
    exp = np.exp(values)
    exp /= exp.sum()
    return {k: float(v) for k, v in zip(keys, exp)}


def top_class(probs: dict):
    """``(slug, probability)`` of the most likely class; ties go to the earlier canonical class."""
    order = {cls: i for i, cls in enumerate(vcfg.VISION_CLASSES)}
    best = max(probs, key=lambda k: (probs[k], -order.get(k, len(order))))
    return best, float(probs[best])


def cap_confidence(probs: dict, cap: float) -> dict:
    """Limit the top probability to ``cap``; the excess is given to the other classes in proportion to
    their current probabilities (so the distribution still sums to 1 and keeps its ranking)."""
    top, p_top = top_class(probs)
    if p_top <= cap:
        return dict(probs)
    excess = p_top - cap
    rest = {k: v for k, v in probs.items() if k != top}
    rest_total = sum(rest.values())
    capped = {top: cap}
    for k, v in rest.items():
        capped[k] = v + excess * (v / rest_total if rest_total > 0 else 1.0 / len(rest))
    return capped


def filename_hint_class(filename, categories=None):
    """Class suggested by keywords in an upload filename, e.g. ``"pothole_03.jpg"`` -> ``"pothole"``.

    The stem is split into lower-case tokens; single tokens and joined neighbouring pairs
    (``open_manhole``) are compared with :data:`FILENAME_HINT_KEYWORDS` and with admin categories' slugs /
    vision labels. Returns ``(slug, keyword)`` or ``(None, None)`` when nothing - or more than one class -
    matches (an ambiguous name is ignored rather than guessed).
    """
    if not filename:
        return None, None
    stem = PurePath(str(filename)).stem.lower()
    tokens = [t for t in re.split(r"[^a-z0-9]+", stem) if t and not t.isdigit()]
    candidates = tokens + [f"{a}_{b}" for a, b in zip(tokens, tokens[1:])]
    keyword_map: dict[str, str] = {}
    for cls, words in vcfg.FILENAME_HINT_KEYWORDS.items():
        for word in words:
            keyword_map[word] = cls
    for category in categories or []:
        slug = normalize_label(category.get("slug", ""))
        if slug and slug not in vcfg.VISION_CLASSES:
            for label in _category_labels(category):
                keyword_map.setdefault(label, slug)
    found = {}
    for cand in candidates:
        if cand in keyword_map:
            found.setdefault(keyword_map[cand], cand)
    if len(found) != 1:
        return None, None
    (slug, keyword), = found.items()
    return slug, keyword


def apply_filename_hint(probs: dict, hint_class: str, weight: float = vcfg.FILENAME_HINT_WEIGHT,
                        cap: float = vcfg.DEMO_HINT_CONFIDENCE_CAP) -> dict:
    """Blend the probabilities with a one-hot vote for ``hint_class`` and cap the result.

    ``p' = (1 - w) * p + w * onehot(hint)``, then the top class is capped at ``cap`` (0.90).
    """
    blended = {k: (1.0 - weight) * v for k, v in probs.items()}
    blended[hint_class] = blended.get(hint_class, 0.0) + weight
    return cap_confidence(blended, cap)


def round_probs(probs: dict, digits: int = 4) -> dict:
    return {k: round(float(v), digits) for k, v in probs.items()}


# ------------------------------------------------------------------------------------------------------
# Severity + explanation
# ------------------------------------------------------------------------------------------------------
def visual_severity(objects: list[dict], confidence: float) -> float:
    """0-1 visual severity of the detected defect.

    ``0.45 * area + 0.35 * contrast + 0.20 * count``, scaled by ``0.6 + 0.4 * confidence``:

    * area      - ``sqrt(total box area / 30% of the image)`` capped at 1 (a defect filling a third of the
                  frame is "large"; the square root makes small defects still count),
    * contrast  - area-weighted :func:`region_contrast` of the boxes (deep, dark, high-contrast damage),
    * count     - ``1 - exp(-n / 2)``: several defects are worse than one,
    * an uncertain detection lowers the claim instead of producing a confident "severe" score.
    """
    if not objects:
        return vcfg.SEVERITY_NO_DETECTION
    weights = vcfg.SEVERITY_WEIGHTS
    total_area = min(1.0, sum(obj["area_ratio"] for obj in objects))
    area_term = min(1.0, math.sqrt(total_area / vcfg.SEVERITY_FULL_AREA_RATIO))
    area_sum = sum(max(obj["area_ratio"], 1e-6) for obj in objects)
    contrast_term = sum(obj.get("contrast", 0.0) * max(obj["area_ratio"], 1e-6) for obj in objects) / area_sum
    count_term = 1.0 - math.exp(-len(objects) / 2.0)
    raw = weights["area"] * area_term + weights["contrast"] * contrast_term + weights["count"] * count_term
    return round(float(min(1.0, max(0.0, raw * (0.6 + 0.4 * confidence)))), 3)


def class_label(slug: str, categories=None) -> str:
    """Human label of a class: admin category name, built-in label, or the slug made readable."""
    for category in categories or []:
        if normalize_label(category.get("slug", "")) == slug and category.get("name"):
            return str(category["name"])
    return CLASS_LABELS.get(slug, slug.replace("_", " ").title())


def pct(value: float) -> str:
    return f"{round(100 * float(value))}%"


def _sentence(text: str) -> str:
    text = text.strip()
    return text[0].upper() + text[1:] + ("" if text.endswith(".") else ".") if text else ""


def build_explanation(*, technique: str, category: str, confidence: float, probs: dict, evidence: str,
                      categories=None, hint=None, visual=None, fallback_reason=None, quality=None,
                      approximate=False, n_objects: int = 0) -> str:
    """Compose the user-facing explanation (technique, decision, evidence, caveats).

    ``hint`` is ``(slug, keyword)`` when a filename hint was used; ``visual`` is ``(slug, probability,
    evidence)`` of the image technique alone when that hint changed the decision.
    """
    parts = []
    if fallback_reason:
        parts.append(f"Production vision models are unavailable ({fallback_reason}), so the demo technique was used.")
    ranked = sorted(probs.items(), key=lambda kv: -kv[1])
    runner_up = next(((k, v) for k, v in ranked if k != category), None)
    decision = f"{technique}: classified as {class_label(category, categories)} ({pct(confidence)})"
    if runner_up and runner_up[1] >= 0.05:
        decision += f", ahead of {class_label(runner_up[0], categories)} ({pct(runner_up[1])})"
    parts.append(decision + ".")
    if visual:
        v_slug, v_prob, v_evidence = visual
        parts.append(f"The image alone pointed to {class_label(v_slug, categories)} ({pct(v_prob)})"
                     + (f": {v_evidence}." if v_evidence else "."))
    elif evidence:
        parts.append(_sentence(evidence))
    if n_objects and approximate:
        parts.append("The highlighted area is an approximate salient region, not a detector box.")
    if hint:
        slug, keyword = hint
        effect = "changed the result" if visual else "raised its probability"
        parts.append(f"A filename hint was used: the upload name contains '{keyword}', suggesting "
                     f"{class_label(slug, categories)}; this {effect} (demo technique only).")
    if quality:
        notes = []
        if quality.get("is_dark"):
            notes.append("dark")
        if quality.get("is_blurry"):
            notes.append("blurry")
        if notes:
            parts.append(f"The photo is {' and '.join(notes)}, so this result is less reliable.")
    return " ".join(parts)
