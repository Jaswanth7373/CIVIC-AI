"""Severity engine (BUILD_SPEC section 2.4).

Technique - a transparent weighted-factor model (a linear scoring model, like a credit score):

    score = 100 x sum_i( w_i x v_i )        v_i in [0, 1], sum_i w_i = 1

Seven factors describe *how bad* the issue is (see ``severity_config`` for the weights):
visual severity from the photo, the intrinsic danger of the issue type, public safety, location
risk, potential impact described by the citizen, nearby complaints and recurrence of the same
issue. Every factor is reported with its value, effective weight and contribution in points, so
the score can be audited line by line.

Missing evidence is handled by *weight redistribution*: if there is no photo (or no description,
or no location assessment) that factor is excluded and its weight is shared proportionally by
the remaining factors - a missing photo must not make an issue look less severe. A blurry or dark
photo keeps only part of its weight (0.6 / 0.7) for the same reason.

The level comes from ``score_to_level(score, thresholds)``; categories with a public-safety weight
of at least 0.9 (open manholes) are never rated below "high" (hazard floor). The ``reason`` is a
specific sentence built from the strongest factors, e.g. "Severe road damage detected near a
high-traffic area, posing a public-safety risk."
"""
import logging
import math

from ..config import score_to_level
from .severity_config import (
    BLURRY_VISUAL_FACTOR,
    CATEGORY_SAFETY_SHARE,
    DARK_VISUAL_FACTOR,
    DARKNESS_EXPECTED_CATEGORIES,
    DEFAULT_CATEGORY_PROFILES,
    DUPLICATE_FREQUENCY_SHARE,
    FACTOR_KEYS,
    FACTOR_LABELS,
    FREQUENCY_SATURATION,
    HAZARD_FLOOR_SAFETY_WEIGHT,
    IMPACT_BLEND,
    IMPACT_BREADTH_BONUS,
    NEARBY_SATURATION,
    UNKNOWN_CATEGORY_PROFILE,
    SeverityConfig,
)

logger = logging.getLogger("ai.severity")

# Nouns used in reason sentences ("Severe pothole detected ...").
ISSUE_NOUNS = {
    "pothole": "pothole",
    "garbage": "garbage dump",
    "drainage": "drainage overflow",
    "streetlight": "streetlight fault",
    "water_leak": "water leak",
    "open_manhole": "open manhole",
    "road_crack": "road damage",
    "fallen_tree": "fallen tree",
    "other": "civic issue",
}


def _clamp01(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return min(1.0, max(0.0, number))


def _count(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def saturate(count, scale):
    """Diminishing-returns transform of a count: ``1 - exp(-n / scale)`` in [0, 1)."""
    return 1.0 - math.exp(-max(0.0, float(count)) / float(scale))


def impact_strength(impacts):
    """Strength (0..1) of the impacts found by the NLP module.

    The strongest impact counts fully and every additional impact type adds 10 % of its own
    score (breadth bonus), capped at 1: ``min(1, s_max + 0.1 x sum(other scores))``.
    """
    scores = sorted((_clamp01(item.get("score")) for item in impacts or [] if isinstance(item, dict)),
                    reverse=True)
    if not scores:
        return 0.0
    return min(1.0, scores[0] + IMPACT_BREADTH_BONUS * sum(scores[1:]))


def _optional_number(value, low, high):
    """``float(value)`` clamped to [low, high], or None when the value is missing or invalid."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return min(high, max(low, number))


def _resolve_profile(category, category_profile):
    """Category facts: valid DB profile values override the built-in defaults."""
    profile = dict(DEFAULT_CATEGORY_PROFILES.get(category, UNKNOWN_CATEGORY_PROFILE))
    profile["name"] = None
    if isinstance(category_profile, dict):
        base = _optional_number(category_profile.get("base_severity"), 0.0, 100.0)
        safety = _optional_number(category_profile.get("public_safety_weight"), 0.0, 1.0)
        if base is not None:
            profile["base_severity"] = base
        if safety is not None:
            profile["public_safety_weight"] = safety
        profile["name"] = category_profile.get("name")
    return profile


def issue_noun(category, profile_name=None):
    """Human noun for the category: built-in nouns, else the admin category name, else the slug."""
    if category in ISSUE_NOUNS:
        return ISSUE_NOUNS[category]
    if profile_name:
        return str(profile_name).strip().lower()
    return str(category or "civic issue").replace("_", " ")


def _photo_reliability(vision, category):
    """Share of the visual weight kept for this photo (1.0 = sharp, well-lit) + notes."""
    quality = vision.get("quality") or {}
    reliability, notes = 1.0, []
    if quality.get("is_blurry"):
        reliability *= BLURRY_VISUAL_FACTOR
        notes.append("blurry")
    if quality.get("is_dark") and category not in DARKNESS_EXPECTED_CATEGORIES:
        reliability *= DARK_VISUAL_FACTOR
        notes.append("dark")
    return reliability, notes


def _measure_factors(category, profile, vision, text, location_risk, nearby, frequency, duplicates):
    """Factor values (0..1), availability, reliability multipliers and human details."""
    factors = {}

    if isinstance(vision, dict) and vision.get("visual_severity") is not None:
        reliability, notes = _photo_reliability(vision, category)
        detail = f"Photo visual severity {_clamp01(vision['visual_severity']):.2f}"
        if notes:
            detail += f" ({' and '.join(notes)} photo - visual evidence down-weighted)"
        factors["visual"] = (_clamp01(vision["visual_severity"]), True, reliability, detail)
    else:
        factors["visual"] = (0.0, False, 0.0, "No photo analysed - weight redistributed to the other factors")

    base = profile["base_severity"]
    factors["issue_type"] = (base / 100.0, True, 1.0,
                             f"Base severity of {issue_noun(category, profile['name'])}: {base:.0f}/100")

    category_safety = profile["public_safety_weight"]
    has_text = isinstance(text, dict)
    if has_text and text.get("safety_score") is not None:
        text_safety = _clamp01(text["safety_score"])
        safety = CATEGORY_SAFETY_SHARE * category_safety + (1.0 - CATEGORY_SAFETY_SHARE) * text_safety
        detail = f"Category safety weight {category_safety:.2f}, text safety score {text_safety:.2f}"
    else:
        safety = category_safety
        detail = f"Category safety weight {category_safety:.2f} (no text safety score)"
    factors["public_safety"] = (safety, True, 1.0, detail)

    if isinstance(location_risk, dict) and location_risk.get("score") is not None:
        level = location_risk.get("level")
        value = _clamp01(location_risk["score"])
        factors["location"] = (value, True, 1.0,
                               f"Location risk {value:.2f}" + (f" ({level})" if level else ""))
    elif isinstance(location_risk, (int, float)) and not isinstance(location_risk, bool):
        factors["location"] = (_clamp01(location_risk), True, 1.0, f"Location risk {_clamp01(location_risk):.2f}")
    else:
        factors["location"] = (0.0, False, 0.0, "Location risk not assessed - weight redistributed")

    if has_text:
        strength = impact_strength(text.get("impacts"))
        hint = _clamp01(text.get("severity_hint_score"))
        urgency = _clamp01(text.get("urgency_score"))
        impact = (IMPACT_BLEND["impacts"] * strength + IMPACT_BLEND["severity_hint"] * hint
                  + IMPACT_BLEND["urgency"] * urgency)
        primary = text.get("primary_impact")
        detail = (f"Impact strength {strength:.2f}" + (f" (primary: {primary})" if primary else "")
                  + f", severity cues {hint:.2f}, urgency {urgency:.2f}")
        factors["impact"] = (min(1.0, impact), True, 1.0, detail)
    else:
        factors["impact"] = (0.0, False, 0.0, "No description analysed - weight redistributed")

    factors["nearby"] = (saturate(nearby, NEARBY_SATURATION), True, 1.0,
                         f"{nearby} complaint{'s' if nearby != 1 else ''} nearby")

    recurring = frequency + DUPLICATE_FREQUENCY_SHARE * duplicates
    detail = f"{frequency} same-category complaint{'s' if frequency != 1 else ''} nearby"
    if duplicates:
        detail += f", {duplicates} linked duplicate{'s' if duplicates != 1 else ''}"
    factors["frequency"] = (saturate(recurring, FREQUENCY_SATURATION), True, 1.0, detail)
    return factors


def _effective_weights(base_weights, measured):
    """Scale each weight by availability x reliability, then renormalise to sum 1."""
    raw = {key: base_weights[key] * (measured[key][2] if measured[key][1] else 0.0) for key in FACTOR_KEYS}
    total = sum(raw.values())
    if total <= 0:  # only possible with custom weights that zero every available factor
        return {key: 0.0 for key in FACTOR_KEYS}
    return {key: raw[key] / total for key in FACTOR_KEYS}


def _location_clause(location_risk, value):
    if not isinstance(location_risk, dict) or value < 0.3:
        return ""
    zones = location_risk.get("zones") or []
    if zones and isinstance(zones[0], dict) and zones[0].get("name"):
        return f" near {zones[0]['name']}"
    if location_risk.get("is_high_traffic"):
        return " near a high-traffic area"
    components = location_risk.get("components") or {}
    if components.get("keywords"):
        return " near a sensitive location"
    if components.get("density"):
        return " in an area with many complaints"
    return " in a high-risk location"


def _impact_label(text, skip_public_safety):
    impacts = sorted((i for i in (text or {}).get("impacts") or [] if isinstance(i, dict)),
                     key=lambda i: -_clamp01(i.get("score")))
    for item in impacts:
        if skip_public_safety and item.get("type") == "public_safety":
            continue
        label = item.get("label") or str(item.get("type") or "").replace("_", " ")
        if label:
            return label.lower()
    primary = (text or {}).get("primary_impact")
    if primary and not (skip_public_safety and str(primary).lower() == "public safety"):
        return str(primary).lower()
    return None


def _build_reason(category, profile, values, contributions, measured, location_risk, text, nearby, frequency,
                  level, floor_applied):
    """Specific human sentence from the strongest factors.

    The adjective describing the photo agrees with the final ``level`` shown next to the sentence: "Severe" only
    for a high / critical result, "Minor" only for a low one. A strong visual signal on a medium result reads
    "Clearly visible ..." - never "Severe pothole detected" beside a "medium severity" badge.
    """
    noun = issue_noun(category, profile["name"])
    capitalised = f"{noun[0].upper()}{noun[1:]}"
    if measured["visual"][1]:
        visual = values["visual"]
        if visual >= 0.65 and level in ("high", "critical"):
            subject = f"Severe {noun} detected"
        elif visual >= 0.65 and level == "medium":
            subject = f"Clearly visible {noun} detected"
        elif visual < 0.35 and level == "low":
            subject = f"Minor {noun} detected"
        else:
            subject = f"{capitalised} detected"
    else:
        subject = f"{capitalised} reported"
    location = _location_clause(location_risk, values["location"]) if measured["location"][1] else ""

    candidates = []
    if values["public_safety"] >= 0.7:
        candidates.append(("public_safety", "posing a serious public-safety risk"))
    elif values["public_safety"] >= 0.5:
        candidates.append(("public_safety", "posing a public-safety risk"))
    safety_used = bool(candidates)
    if measured["impact"][1] and values["impact"] >= 0.5:
        label = _impact_label(text, skip_public_safety=safety_used)
        if label:
            candidates.append(("impact", f"with {label} impact reported"))
    if frequency >= 2:
        candidates.append(("frequency", f"with {frequency} similar complaints nearby"))
    elif nearby >= 3:
        candidates.append(("nearby", f"with {nearby} other complaints nearby"))
    candidates.sort(key=lambda item: -contributions[item[0]])
    clauses = [phrase for _, phrase in candidates[:2]]

    if clauses:
        sentence = f"{subject}{location}, {' and '.join(clauses)}."
    elif level in ("low", "medium"):
        sentence = f"{subject}{location}, with no major risk factors."
    else:
        sentence = f"{subject}{location}."
    if floor_applied:
        sentence += " Rated at least High because this issue type is a serious public-safety hazard."
    return sentence


def assess_severity(*, category, category_profile=None, vision=None, text=None, location_risk=None,
                    nearby_count=0, frequency_count=0, duplicate_count=0, config=None):
    """Estimate how severe a civic issue is.

    Args:
        category: final category slug.
        category_profile: {"base_severity": 0-100, "public_safety_weight": 0-1} from the DB category.
        vision / text: module outputs (may be None).
        location_risk: output of ai.geospatial.location_risk.assess_location_risk.
        nearby_count: complaints within the nearby radius (any category) in the frequency window.
        frequency_count: complaints of the SAME category nearby in the window.
        duplicate_count: potential duplicates already linked.
        config: {"thresholds": {"medium": 26, "high": 51, "critical": 76}} (+ optional "weights" overrides)

    Returns (CONTRACT):
        {"severity": "high", "score": 84,
         "reason": "Large road damage detected near a high-traffic area.",
         "factors": {"visual": {"value": 0.8, "weight": 0.25, "contribution": 20.0, "label": "Visual severity"},
                     "issue_type": {...}, "public_safety": {...}, "location": {...},
                     "impact": {...}, "nearby": {...}, "frequency": {...}}}
    Each factor also carries ``available`` (False when its weight was redistributed) and ``detail``;
    the result adds ``floor_applied`` and ``thresholds``. ``contribution`` is in score points.
    """
    cfg = SeverityConfig.from_dict(config)
    profile = _resolve_profile(category, category_profile)
    nearby, frequency, duplicates = _count(nearby_count), _count(frequency_count), _count(duplicate_count)

    measured = _measure_factors(category, profile, vision, text, location_risk, nearby, frequency, duplicates)
    weights = _effective_weights(cfg.weights, measured)
    values = {key: measured[key][0] for key in FACTOR_KEYS}
    contributions = {key: 100.0 * weights[key] * values[key] for key in FACTOR_KEYS}

    raw_score = sum(contributions.values())
    score = int(min(100, max(0, math.floor(raw_score + 0.5))))
    floor_applied = False
    if profile["public_safety_weight"] >= HAZARD_FLOOR_SAFETY_WEIGHT and score < cfg.thresholds["high"]:
        score = int(math.ceil(cfg.thresholds["high"]))
        floor_applied = True
    level = score_to_level(score, cfg.thresholds)

    factors = {
        key: {
            "value": round(values[key], 3),
            "weight": round(weights[key], 4),
            "contribution": round(contributions[key], 1),
            "label": FACTOR_LABELS[key],
            "available": measured[key][1],
            "detail": measured[key][3],
        }
        for key in FACTOR_KEYS
    }
    reason = _build_reason(category, profile, values, contributions, measured, location_risk, text, nearby,
                           frequency, level, floor_applied)
    logger.debug("Severity for %s: %s (%d) floor=%s", category, level, score, floor_applied)
    return {
        "severity": level,
        "score": score,
        "reason": reason,
        "factors": factors,
        "floor_applied": floor_applied,
        "thresholds": dict(cfg.thresholds),
    }
