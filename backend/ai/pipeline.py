"""Complaint analysis pipeline (BUILD_SPEC section 2.9).

Orchestrates the AI analysis of ONE complaint, in this order, timing and reporting every step:

    preprocess         normalise the text, decode the photo once, summarise nearby complaints
    image_analysis     ai.vision.analyze_image  (skipped without a photo; a failure is reported as
                       "failed" and the analysis continues with the text alone)
    text_analysis      ai.nlp.analyze_text      (skipped for an empty description)
    multimodal_fusion  ai.multimodal.fuse_predictions (citizen category + nearby categories as priors)
    location_risk      ai.geospatial.assess_location_risk
    severity           ai.severity.assess_severity

The pipeline is framework independent: the Django service layer passes plain dicts (categories,
risk zones, nearby complaints, ``AIConfiguration.to_engine_config()``) and persists the result.
Priority, duplicates and routing need database facts and are computed afterwards by
``apps.complaints.services``; the result carries ``public_impact`` ready for the priority engine.

If neither the photo nor the text could be analysed because of failures, an ``AnalysisError``
(an ``AIEngineError`` carrying the step list) is raised so the caller can flag the complaint for
manual review instead of storing an evidence-free classification. When the cause is an engine module
that is still a stub, the error is an ``AnalysisNotImplementedError`` (also a ``NotImplementedError``).
"""
import logging
import time
import unicodedata
from collections import Counter

from .config import CLASS_LABELS, get_model_mode
from .duplicate.image_similarity import load_image_bgr
from .exceptions import AIEngineError
from .geospatial import assess_location_risk
from .multimodal import FUSION_VERSION, fuse_predictions
from .priority.priority_rules import public_impact_from_text
from .severity import SEVERITY_ENGINE_VERSION, assess_severity

logger = logging.getLogger("ai.pipeline")

STEP_LABELS = {
    "preprocess": "Data preprocessing",
    "image_analysis": "Image AI analysis",
    "text_analysis": "Text NLP analysis",
    "multimodal_fusion": "Multimodal classification",
    "location_risk": "Location risk assessment",
    "severity": "Severity assessment",
}
AGREEMENT_TEXT = {
    "agree": "image and text agree",
    "disagree": "image and text disagree",
    "single_modality": "single modality",
    "none": "no model evidence",
}


class AnalysisError(AIEngineError):
    """No modality could be analysed (or fusion / severity failed). ``steps`` holds the step reports."""

    def __init__(self, message, steps):
        super().__init__(message)
        self.steps = steps


class AnalysisNotImplementedError(AnalysisError, NotImplementedError):
    """``AnalysisError`` caused by an engine module that is still a ``NotImplementedError`` stub.

    It is both an ``AIEngineError`` and a ``NotImplementedError``, so callers can tell "a dependency is not
    implemented yet" apart from a runtime failure while still receiving the step reports.
    """


class _StepLog:
    """Collects ``{key, label, status, duration_ms, detail}`` records in execution order."""

    def __init__(self):
        self.items = []

    def add(self, key, status, started, detail):
        self.items.append({
            "key": key,
            "label": STEP_LABELS[key],
            "status": status,
            "duration_ms": int(round((time.perf_counter() - started) * 1000)),
            "detail": detail,
        })


def _label(slug, categories=None):
    for category in categories or []:
        if isinstance(category, dict) and category.get("slug") == slug and category.get("name"):
            return str(category["name"])
    return CLASS_LABELS.get(slug, str(slug or "unknown").replace("_", " "))


def _pct(value):
    try:
        return f"{round(100 * float(value)):.0f}%"
    except (TypeError, ValueError):
        return "n/a"


def _error_text(exc):
    message = str(exc).strip()
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


def normalize_text(text):
    """Unicode NFKC normalisation + whitespace collapsing (the NLP module does the linguistic cleanup)."""
    if text is None:
        return ""
    return " ".join(unicodedata.normalize("NFKC", str(text)).split())


def nearby_category_prior(nearby):
    """({slug: share} among categorised nearby complaints or None, number of categorised complaints)."""
    counts = Counter(n.get("category") for n in nearby if isinstance(n.get("category"), str) and n.get("category"))
    total = sum(counts.values())
    if not total:
        return None, 0
    return {slug: round(count / total, 4) for slug, count in counts.most_common()}, total


def _category_profile(categories, slug):
    for category in categories or []:
        if isinstance(category, dict) and category.get("slug") == slug:
            return category
    return None


def _unassessed_location(explanation):
    """Neutral location-risk dict (JSON-storable) for a location that could not be assessed."""
    return {"score": 0.0, "level": "low", "zones": [], "factors": [], "is_high_traffic": False,
            "explanation": explanation, "assessed": False}


def _vision_detail(vision, categories):
    objects = vision.get("detected_objects") or []
    detail = (f"Detected {_label(vision.get('category'), categories)} ({_pct(vision.get('confidence'))}) using "
              f"{vision.get('model_version') or 'the vision model'}; {len(objects)} region"
              f"{'s' if len(objects) != 1 else ''} found.")
    if vision.get("fallback_reason"):
        detail += f" Fallback: {vision['fallback_reason']}."
    return detail


def _text_detail(text_result, categories):
    detail = (f"Classified as {_label(text_result.get('category'), categories)} "
              f"({_pct(text_result.get('confidence'))})")
    keywords = [str(k) for k in (text_result.get("keywords") or [])[:5]]
    return detail + (f"; keywords: {', '.join(keywords)}." if keywords else ".")


def run_analysis(*, text, latitude, longitude, image=None, filename=None, address="", reported_category=None,
                 categories=None, risk_zones=None, nearby=None, config=None):
    """Run preprocessing -> vision -> NLP -> fusion -> location risk -> severity for one complaint.

    nearby: [{"id", "category", "latitude", "longitude", "status", "created_at"}] - complaints around the
            location within the frequency window (provided by the Django layer).
    config: AIConfiguration.to_engine_config() dict.

    Returns (CONTRACT):
        {"vision": {...} | None, "text": {...}, "fusion": {...}, "location_risk": {...}, "severity": {...},
         "nearby_count": 6, "frequency_count": 3,
         "mode": "demo", "is_demo": True, "model_versions": {"vision": "...", "text": "..."},
         "steps": [{"key": "preprocess", "label": "Data preprocessing", "status": "done", "duration_ms": 3,
                    "detail": "..."}, ...],
         "processing_time_ms": 120}
    ``text`` is None when the description is empty or its analysis failed. Extra keys: ``public_impact``
    (0..1 text-derived input for the priority engine, None without text), ``location_prior``,
    ``fallback_reasons`` and fusion / severity versions inside ``model_versions``. ``is_demo`` is True in
    demo mode or when any modality result came from a demo technique (e.g. a production fallback).

    Raises:
        AnalysisError: neither the photo nor the text could be analysed because of failures, or the
            fusion / severity step failed. ``AnalysisNotImplementedError`` (subclass, also a
            ``NotImplementedError``) when a failing modality module is still a stub.
    """
    total_started = time.perf_counter()
    config = config if isinstance(config, dict) else {}
    steps = _StepLog()
    mode = get_model_mode()

    # 1. Preprocess ------------------------------------------------------------------------------
    started = time.perf_counter()
    clean_text = normalize_text(text)
    nearby = [n for n in (nearby or []) if isinstance(n, dict)]
    location_prior, categorised_nearby = nearby_category_prior(nearby)
    decoded, decode_error = None, None
    if image is not None:
        try:
            decoded = load_image_bgr(image)
        except Exception as exc:  # noqa: BLE001 - reported as a failed image step below
            decode_error = exc
    parts = [f"description normalised ({len(clean_text.split())} words)" if clean_text else "no description text"]
    if decoded is not None:
        parts.append(f"photo decoded ({decoded.shape[1]}x{decoded.shape[0]} px)")
    elif image is not None:
        parts.append("photo could not be decoded")
    else:
        parts.append("no photo")
    parts.append(f"{len(nearby)} nearby complaint{'s' if len(nearby) != 1 else ''} in the frequency window")
    detail = "; ".join(parts)
    steps.add("preprocess", "done", started, detail[0].upper() + detail[1:] + ".")

    failures = []  # (modality, exception) of every failed modality

    # 2. Image analysis --------------------------------------------------------------------------
    started = time.perf_counter()
    vision = None
    if image is None:
        steps.add("image_analysis", "skipped", started, "No photo attached.")
    elif decode_error is not None:
        failures.append(("image", decode_error))
        steps.add("image_analysis", "failed", started,
                  f"The photo could not be read ({_error_text(decode_error)}); the analysis continues without it.")
    else:
        try:
            from .vision import analyze_image

            result = analyze_image(decoded, filename_hint=filename, categories=categories)
            detail = _vision_detail(result, categories)
            vision = result
            steps.add("image_analysis", "done", started, detail)
        except Exception as exc:  # noqa: BLE001 - image failures must not stop the pipeline
            logger.warning("Image analysis failed, continuing with text only: %s", _error_text(exc))
            failures.append(("image", exc))
            steps.add("image_analysis", "failed", started,
                      f"Image analysis failed ({_error_text(exc)}); the analysis continues without the photo.")

    # 3. Text analysis ---------------------------------------------------------------------------
    started = time.perf_counter()
    text_result = None
    if not clean_text:
        steps.add("text_analysis", "skipped", started, "No description provided.")
    else:
        try:
            from .nlp import analyze_text

            result = analyze_text(clean_text, categories=categories)
            detail = _text_detail(result, categories)
            text_result = result
            steps.add("text_analysis", "done", started, detail)
        except Exception as exc:  # noqa: BLE001 - reported; the photo may still be usable
            logger.warning("Text analysis failed: %s", _error_text(exc))
            failures.append(("text", exc))
            steps.add("text_analysis", "failed", started, f"Text analysis failed ({_error_text(exc)}).")

    if vision is None and text_result is None and failures:
        reasons = "; ".join(f"{name}: {_error_text(exc)}" for name, exc in failures)
        not_implemented = any(isinstance(exc, NotImplementedError) for _, exc in failures)
        error_class = AnalysisNotImplementedError if not_implemented else AnalysisError
        raise error_class(f"AI analysis failed - no modality could be analysed ({reasons})",
                          steps.items) from failures[0][1]

    # 4. Multimodal fusion -----------------------------------------------------------------------
    started = time.perf_counter()
    try:
        fusion = fuse_predictions(vision, text_result, reported_category=reported_category,
                                  location_prior=location_prior, categories=categories,
                                  config=config.get("fusion"), location_prior_count=categorised_nearby)
    except Exception as exc:
        steps.add("multimodal_fusion", "failed", started, f"Fusion failed ({_error_text(exc)}).")
        raise AnalysisError(f"Multimodal fusion failed: {_error_text(exc)}", steps.items) from exc
    detail = (f"{_label(fusion['category'], categories)} with {_pct(fusion['confidence'])} confidence "
              f"({AGREEMENT_TEXT.get(fusion['agreement'], fusion['agreement'])})")
    steps.add("multimodal_fusion", "done", started,
              detail + ("; flagged for manual review." if fusion["needs_review"] else "."))

    # 5. Location risk (severity redistributes the location weight when it cannot be assessed) ------------
    started = time.perf_counter()
    severity_location = None
    if latitude is None or longitude is None:
        location_risk = _unassessed_location("No coordinates were provided, so location risk was not assessed.")
        steps.add("location_risk", "skipped", started, "No coordinates provided.")
    else:
        try:
            location_risk = assess_location_risk(latitude, longitude, address=address or "", text=clean_text,
                                                 risk_zones=risk_zones, nearby_count=len(nearby))
            severity_location = location_risk
            detail = f"{location_risk['level'].capitalize()} location risk ({location_risk['score']:.2f})"
            if location_risk["factors"]:
                detail += f": {location_risk['factors'][0]}"
            steps.add("location_risk", "done", started, detail + ".")
        except Exception as exc:  # noqa: BLE001 - e.g. invalid coordinates
            logger.warning("Location risk assessment failed: %s", _error_text(exc))
            location_risk = _unassessed_location(f"Location risk could not be assessed ({_error_text(exc)}).")
            steps.add("location_risk", "failed", started, location_risk["explanation"])

    # 6. Severity --------------------------------------------------------------------------------
    started = time.perf_counter()
    category = fusion["category"]
    frequency_count = sum(1 for n in nearby if n.get("category") == category)
    try:
        severity = assess_severity(category=category, category_profile=_category_profile(categories, category),
                                   vision=vision, text=text_result, location_risk=severity_location,
                                   nearby_count=len(nearby), frequency_count=frequency_count, duplicate_count=0,
                                   config=config.get("severity"))
    except Exception as exc:
        steps.add("severity", "failed", started, f"Severity assessment failed ({_error_text(exc)}).")
        raise AnalysisError(f"Severity assessment failed: {_error_text(exc)}", steps.items) from exc
    steps.add("severity", "done", started,
              f"{severity['severity'].capitalize()} severity ({severity['score']}/100): {severity['reason']}")

    modality_results = [r for r in (vision, text_result) if isinstance(r, dict)]
    fallback_reasons = []
    for name, result in (("vision", vision), ("text", text_result)):
        if isinstance(result, dict) and result.get("fallback_reason"):
            fallback_reasons.append(f"{name}: {result['fallback_reason']}")
    return {
        "vision": vision,
        "text": text_result,
        "fusion": fusion,
        "location_risk": location_risk,
        "severity": severity,
        "nearby_count": len(nearby),
        "frequency_count": frequency_count,
        "public_impact": public_impact_from_text(text_result),
        "location_prior": location_prior,
        "mode": mode,
        "is_demo": mode == "demo" or any(bool(r.get("is_demo")) for r in modality_results),
        "fallback_reasons": fallback_reasons,
        "model_versions": {
            "vision": vision.get("model_version") if vision else None,
            "text": text_result.get("model_version") if text_result else None,
            "fusion": FUSION_VERSION,
            "severity": SEVERITY_ENGINE_VERSION,
        },
        "steps": steps.items,
        "processing_time_ms": int(round((time.perf_counter() - total_started) * 1000)),
    }
