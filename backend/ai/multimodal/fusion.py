"""Late fusion of image / text / location evidence (BUILD_SPEC section 2.3).

Technique - confidence-weighted late fusion (a *linear opinion pool*)::

    P(c) = w_img * P_img(c) + w_txt * P_txt(c) + w_rep * [c == reported] + w_loc * P_loc(c)

Each modality first produces its own probability distribution over the categories; fusion then
combines those *decisions* (late fusion) instead of raw features, so the vision and NLP models
stay independent and replaceable. The weights are computed for every complaint:

* **Modality weight** is proportional to the configured weight (image 0.55 / text 0.45) x the
  modality's own confidence x a reliability factor: blurry photo x0.6, dark photo x0.7 (darkness
  is expected for streetlight faults and is not penalised there), demo image heuristic x0.5 (it
  reaches 98.9 % on the generated sample photos but only 22.4 % on the real street photos of
  ``sample_data/real_images``) and a further x0.6 when it is not confident (< 0.5). A confident
  description therefore outweighs an unsure, blurry photo or the demo heuristic, and vice versa.
* **Trust floor**: when both modalities are present each keeps at least 20 % of the modality
  mass - the system never blindly trusts one modality.
* **Weak priors**: the category selected by the citizen gets 12 % of the mass and the category
  mix of nearby complaints up to 8 % (scaled by how many nearby complaints there are). Priors
  can tip a near-tie but cannot overrule confident model evidence.
* **Corroboration**: when image and text independently agree, the fused confidence is raised
  by ``(1 - p) x 0.35 x min(conf_img, conf_txt)`` - two independent sources agreeing are more
  reliable than either alone. Other classes are rescaled so the distribution still sums to 1
  and ``probabilities[category] == confidence``.

``needs_review`` is set when both modalities are confident (> 0.6) but disagree, when the top-2
margin is below 0.10, when the fused confidence is below ``min_confidence`` or when there is no
model evidence at all. Classes are the union of the modality outputs and the active categories;
when ``categories`` is given the decision is restricted to those slugs (admin-defined slugs
included), so it always maps onto an active ``CivicCategory``.
"""
import logging
import math
from dataclasses import dataclass, field

from ..config import CIVIC_CLASSES, DEMO_DISCLAIMER

logger = logging.getLogger("ai.multimodal")

FUSION_VERSION = "late-fusion-linear-pool-1.0"
FUSION_METHOD = "Confidence-weighted late fusion (linear opinion pool)"
DEFAULT_FUSION_CONFIG = {
    "image_weight": 0.55,
    "text_weight": 0.45,
    "min_confidence": 0.30,
    "reported_weight": 0.12,  # citizen-selected category prior
    "location_weight": 0.08,  # nearby-complaint category prior (maximum)
}
BLURRY_IMAGE_FACTOR = 0.6
DARK_IMAGE_FACTOR = 0.7
DARKNESS_EXPECTED_CLASSES = frozenset({"streetlight"})
#: Measured reliability of the demo image heuristic: top-1 22.4 % on the 134 real street photos (98.9 % on the
#: generated ones it was tuned on; ``scripts/evaluate_vision.py --images sample_data/real_images``), so its
#: opinion counts half - a confident description decides, an agreeing photo still corroborates.
DEMO_IMAGE_RELIABILITY = 0.5
DEMO_LOW_CONFIDENCE = 0.5
DEMO_LOW_CONFIDENCE_FACTOR = 0.6
MIN_MODALITY_SHARE = 0.2
CONFIDENT_MODALITY = 0.6
MIN_TOP2_MARGIN = 0.10
AGREEMENT_BONUS = 0.35
LOCATION_PRIOR_SATURATION = 3.0  # nearby complaints at which ~63 % of the location weight is used


@dataclass
class _Evidence:
    """One modality's opinion, normalised over the class universe."""

    name: str  # "image" | "text"
    category: str  # what the model itself predicted (may be outside the universe)
    confidence: float
    distribution: dict
    reliability: float = 1.0
    is_demo: bool = False
    notes: list = field(default_factory=list)


def _unit(value, default=None):
    """Float in [0, 1] or ``default`` for missing / invalid input."""
    if value is None or isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return min(1.0, max(0.0, number))


def _fusion_config(config):
    """Merge the fusion section of the engine config with defaults and validate it."""
    cfg = dict(DEFAULT_FUSION_CONFIG)
    if isinstance(config, dict):
        section = config["fusion"] if isinstance(config.get("fusion"), dict) else config
        for key in DEFAULT_FUSION_CONFIG:
            if section.get(key) is None:
                continue
            value = section[key]
            try:
                number = None if isinstance(value, bool) else float(value)
            except (TypeError, ValueError):
                number = None
            if number is None or not math.isfinite(number) or not 0.0 <= number <= 1.0:
                raise ValueError(f"Fusion setting '{key}' must be a number between 0 and 1, got {value!r}")
            cfg[key] = number
    if cfg["image_weight"] + cfg["text_weight"] <= 0:
        raise ValueError("Image and text modality weights cannot both be zero")
    if cfg["reported_weight"] + cfg["location_weight"] >= 0.5:
        raise ValueError("Prior weights must stay weak (reported + location < 0.5)")
    return cfg


def _category_universe(categories, sources):
    """Ordered candidate classes: active categories when given, else CIVIC_CLASSES + any slug seen."""
    allowed = [c["slug"] for c in categories or [] if isinstance(c, dict) and c.get("slug")]
    if allowed:
        allowed = list(dict.fromkeys(allowed))
        return [c for c in CIVIC_CLASSES if c in allowed] + [c for c in allowed if c not in CIVIC_CLASSES]
    universe = list(CIVIC_CLASSES)
    for slug in sources:
        if isinstance(slug, str) and slug and slug not in universe:
            universe.append(slug)
    return universe


def _restricted(probabilities, universe):
    """(distribution over the universe, share of the original mass kept) or (None, 0)."""
    if not isinstance(probabilities, dict) or not probabilities:
        return None, 0.0
    original = sum(v for v in (_unit(p, 0.0) for p in probabilities.values()))
    values = {c: _unit(probabilities.get(c), 0.0) for c in universe}
    total = sum(values.values())
    if total <= 0:
        return None, 0.0
    kept = total / original if original > 0 else 0.0
    return {c: v / total for c, v in values.items()}, min(1.0, kept)


def _evidence(name, result, universe):
    """Turn a vision / NLP result into an ``_Evidence`` (None when the modality is absent)."""
    if not isinstance(result, dict):
        return None
    category = result.get("category") if isinstance(result.get("category"), str) and result.get("category") else None
    confidence = _unit(result.get("confidence"))
    distribution, kept = _restricted(result.get("probabilities"), universe)
    notes = []
    if distribution is None:
        if category is None:
            return None
        n = len(universe)
        if category in universe:
            conf = confidence if confidence is not None else 0.5
            rest = (1.0 - conf) / (n - 1) if n > 1 else 0.0
            distribution = {c: (conf if c == category else rest) for c in universe} if n > 1 else {category: 1.0}
            kept = 1.0
        else:
            distribution = {c: 1.0 / n for c in universe}
            kept = 0.0
    if category is None:
        category = max(universe, key=lambda c: distribution[c])
    if confidence is None:
        confidence = distribution.get(category, max(distribution.values()))

    reliability = 1.0
    if category not in universe:
        # The model's favourite class is not an active category: only the belief it placed on
        # active categories is usable, so the modality counts proportionally less.
        reliability *= kept
        notes.append(f"its top class '{category}' is not an active category")
    is_demo = bool(result.get("is_demo")) or result.get("mode") == "demo"
    if name == "image":
        quality = result.get("quality") or {}
        problems = []
        if quality.get("is_blurry"):
            reliability *= BLURRY_IMAGE_FACTOR
            problems.append("blurry")
        if quality.get("is_dark") and category not in DARKNESS_EXPECTED_CLASSES:
            reliability *= DARK_IMAGE_FACTOR
            problems.append("dark")
        if problems:
            notes.append(f"the photo is {' and '.join(problems)}")
        if is_demo:
            reliability *= DEMO_IMAGE_RELIABILITY
            if confidence < DEMO_LOW_CONFIDENCE:
                reliability *= DEMO_LOW_CONFIDENCE_FACTOR
                notes.append("the demo image heuristic is not confident")
            else:
                notes.append("the demo image heuristic is unreliable on real street photos")
    return _Evidence(name, category, confidence, distribution, reliability, is_demo, notes)


def _location_distribution(location_prior, universe):
    if not isinstance(location_prior, dict):
        return None
    distribution, _ = _restricted(location_prior, universe)
    return distribution


def _modality_weights(image, text, cfg, mass):
    """Split the modality mass between image and text (confidence x reliability, trust floor)."""
    if image and text:
        a = cfg["image_weight"] * image.confidence * image.reliability
        b = cfg["text_weight"] * text.confidence * text.reliability
        if a + b > 0:
            share = a / (a + b)
        else:
            share = cfg["image_weight"] / (cfg["image_weight"] + cfg["text_weight"])
        share = min(1.0 - MIN_MODALITY_SHARE, max(MIN_MODALITY_SHARE, share))
        return mass * share, mass * (1.0 - share)
    if image:
        return mass, 0.0
    if text:
        return 0.0, mass
    return 0.0, 0.0


def _label_maker(categories):
    names = {c["slug"]: c.get("name") for c in categories or [] if isinstance(c, dict) and c.get("slug")}

    def label(slug):
        if slug == "other":
            return "other issue"
        if slug in CIVIC_CLASSES:
            return slug.replace("_", " ")
        return str(names.get(slug) or str(slug).replace("_", " "))

    return label


def _pct(value):
    return f"{round(100 * value):.0f}%"


def _explain(image, text, agreement, top, confidence, label, reported, w_reported, location_top, w_location,
             review_reasons):
    parts = []
    if agreement == "agree":
        parts.append(f"Image model detected {label(image.category)} ({_pct(image.confidence)}) and the text "
                     f"classifier agreed ({_pct(text.confidence)}); fused confidence {_pct(confidence)}.")
    elif agreement == "disagree":
        parts.append(f"Image model suggested {label(image.category)} ({_pct(image.confidence)}) but the text "
                     f"classifier suggested {label(text.category)} ({_pct(text.confidence)}); fused decision: "
                     f"{label(top)} ({_pct(confidence)}).")
    elif agreement == "single_modality":
        evidence = image or text
        if image:
            lead = (f"Image model detected {label(image.category)} ({_pct(image.confidence)}); "
                    f"no description was analysed")
        else:
            lead = (f"Text classifier predicted {label(text.category)} ({_pct(text.confidence)}); "
                    f"no photo was provided")
        if top == evidence.category:
            parts.append(f"{lead}; fused confidence {_pct(confidence)}.")
        else:
            parts.append(f"{lead}; fused decision: {label(top)} ({_pct(confidence)}).")
    else:
        parts.append(f"No image or text evidence was available; {label(top)} was chosen from weak priors only "
                     f"({_pct(confidence)}).")

    for evidence in (image, text):
        if evidence and evidence.notes:
            parts.append(f"{evidence.name.capitalize()} weight reduced because {' and '.join(evidence.notes)}.")
    if w_reported > 0:
        parts.append(f"The citizen-selected category ({label(reported)}) was used as a weak prior.")
    if w_location > 0 and location_top:
        parts.append(f"Nearby complaints (mostly {label(location_top)}) were used as a weak location prior.")
    if review_reasons:
        parts.append(f"Flagged for manual review: {'; '.join(review_reasons)}.")
    if (image and image.is_demo) or (text and text.is_demo):
        parts.append(DEMO_DISCLAIMER)
    return " ".join(parts)


def fuse_predictions(image_result=None, text_result=None, *, reported_category=None, location_prior=None,
                     categories=None, config=None, location_prior_count=None):
    """Combine modality predictions into one category decision.

    Args:
        image_result: output of ai.vision.analyze_image (or None when no image).
        text_result: output of ai.nlp.analyze_text (or None).
        reported_category: slug the citizen selected (weak prior) or None.
        location_prior: {slug: share} distribution of categories among nearby complaints, or None.
        categories: list of active category dicts (slug, name, keywords, vision_labels, ...).
        config: {"image_weight": 0.55, "text_weight": 0.45, "min_confidence": 0.30}
            (optional "reported_weight" / "location_weight"; the whole engine config is accepted too).
        location_prior_count: number of nearby complaints behind ``location_prior``; scales the location
            weight by ``1 - exp(-n / 3)`` (None = full location weight).

    Returns (CONTRACT):
        {"category": "pothole", "confidence": 0.93, "probabilities": {...},
         "image_category": "pothole", "image_confidence": 0.88,
         "text_category": "pothole", "text_confidence": 0.91,
         "weights": {"image": 0.52, "text": 0.38, "reported": 0.06, "location": 0.04},
         "agreement": "agree" | "disagree" | "single_modality" | "none",
         "needs_review": False, "explanation": "..."}
    An absent modality reports ``""`` / ``0.0`` (the ``AIPrediction`` column defaults). Extra keys:
    ``review_reasons``, ``margin`` (top-2 gap), ``method`` and ``version``. Probabilities are sorted
    from most to least likely.
    """
    cfg = _fusion_config(config)
    sources = [reported_category]
    for result in (image_result, text_result):
        if isinstance(result, dict):
            sources.append(result.get("category"))
            sources.extend((result.get("probabilities") or {}).keys())
    if isinstance(location_prior, dict):
        sources.extend(location_prior.keys())
    universe = _category_universe(categories, sources)
    label = _label_maker(categories)

    image = _evidence("image", image_result, universe)
    text = _evidence("text", text_result, universe)
    if image and cfg["image_weight"] <= 0:
        image = None
    if text and cfg["text_weight"] <= 0:
        text = None

    reported = reported_category if reported_category in universe else None
    location = _location_distribution(location_prior, universe)
    w_reported = cfg["reported_weight"] if reported else 0.0
    w_location = 0.0
    if location:
        evidence_factor = 1.0
        if location_prior_count is not None:
            evidence_factor = 1.0 - math.exp(-max(0.0, float(location_prior_count)) / LOCATION_PRIOR_SATURATION)
        w_location = cfg["location_weight"] * evidence_factor
    mass = 1.0 - w_reported - w_location
    w_image, w_text = _modality_weights(image, text, cfg, mass)

    fused = {c: 0.0 for c in universe}
    for evidence, weight in ((image, w_image), (text, w_text)):
        if evidence and weight > 0:
            for c in universe:
                fused[c] += weight * evidence.distribution[c]
    if reported:
        fused[reported] += w_reported
    if location and w_location > 0:
        for c in universe:
            fused[c] += w_location * location[c]
    if not image and not text:  # no model evidence: the modality mass becomes a uniform "don't know"
        for c in universe:
            fused[c] += mass / len(universe)
    total = sum(fused.values())
    fused = {c: v / total for c, v in fused.items()}

    # Exact ties (e.g. no evidence and no priors) go to the catch-all "other" category, then class order.
    order = {c: (0 if c == "other" else 1, i) for i, c in enumerate(universe)}
    ranked = sorted(universe, key=lambda c: (-round(fused[c], 12), order[c]))
    top = ranked[0]
    if image and text:
        agreement = "agree" if image.category == text.category else "disagree"
    elif image or text:
        agreement = "single_modality"
    else:
        agreement = "none"

    if agreement == "agree" and top == image.category:
        strength = min(image.confidence * image.reliability, text.confidence * text.reliability)
        p = fused[top]
        boosted = p + (1.0 - p) * AGREEMENT_BONUS * strength
        scale = (1.0 - boosted) / (1.0 - p) if p < 1.0 else 0.0
        fused = {c: (boosted if c == top else v * scale) for c, v in fused.items()}

    confidence = fused[top]
    margin = confidence - (fused[ranked[1]] if len(ranked) > 1 else 0.0)
    review_reasons = []
    if agreement == "none":
        review_reasons.append("no image or text evidence was available")
    if agreement == "disagree" and image.confidence > CONFIDENT_MODALITY and text.confidence > CONFIDENT_MODALITY:
        review_reasons.append("image and text are both confident but disagree")
    if len(ranked) > 1 and margin < MIN_TOP2_MARGIN:
        review_reasons.append(f"the top two categories are less than {round(MIN_TOP2_MARGIN * 100)} points apart")
    if confidence < cfg["min_confidence"]:
        review_reasons.append(f"fused confidence is below the {_pct(cfg['min_confidence'])} minimum")

    location_top = min(universe, key=lambda c: (-location[c], order[c])) if location else None
    explanation = _explain(image, text, agreement, top, confidence, label, reported, w_reported, location_top,
                           w_location, review_reasons)
    logger.debug("Fusion -> %s (%.3f, %s, review=%s)", top, confidence, agreement, bool(review_reasons))
    return {
        "category": top,
        "confidence": round(confidence, 4),
        "probabilities": {c: round(fused[c], 4) for c in ranked},
        "image_category": image.category if image else "",
        "image_confidence": round(image.confidence, 4) if image else 0.0,
        "text_category": text.category if text else "",
        "text_confidence": round(text.confidence, 4) if text else 0.0,
        "weights": {"image": round(w_image, 3), "text": round(w_text, 3), "reported": round(w_reported, 3),
                    "location": round(w_location, 3)},
        "agreement": agreement,
        "needs_review": bool(review_reasons),
        "review_reasons": review_reasons,
        "margin": round(margin, 4),
        "explanation": explanation,
        "method": FUSION_METHOD,
        "version": FUSION_VERSION,
    }
