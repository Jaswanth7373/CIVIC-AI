"""Priority engine (BUILD_SPEC section 2.5).

Technique - a weighted additive scoring model (multi-criteria decision analysis):

    component_i = weight_i x factor_i            factor_i in [0, 1], weights sum to 100
    final_score = round( sum_i component_i + reopen_bump )   clamped to 0..100

    severity       factor = severity_score / 100
    public_impact  factor = 0.7 x max(text impact, category safety) + 0.3 x mean(...)
    location_risk  factor = location risk score
    frequency      factor = 1 - exp(-0.4 x same-category complaints nearby)
    duplicates     factor = 1 - exp(-0.4 x linked duplicate reports)

Because each weight is the maximum points of its component, the breakdown reads naturally
("Severity 35/40, Public Impact 25/25, Location Risk 12/15, Frequency 8/10, Duplicates 7/10 ->
Priority Score: 87/100"). Components are rounded to 1 decimal and the final score is the
conventionally rounded sum of the displayed components, so the breakdown always adds up.
Reopened complaints get a small documented bump (+5 per reopen, max +10).

The level uses inclusive lower thresholds (0-25 low, 26-50 medium, 51-75 high, 76-100 critical)
and the explanation names the strongest components in plain English. The engine is a pure,
deterministic function of its inputs and configuration.
"""
import logging
import math

from ..config import score_to_level
from .priority_config import COMPONENT_KEYS, COMPONENT_LABELS, PRIORITY_ENGINE_VERSION, PriorityConfig
from .priority_rules import (
    duplicates_rule,
    frequency_rule,
    location_risk_rule,
    public_impact_rule,
    reopen_adjustment,
    severity_rule,
    to_count,
    to_unit,
)

logger = logging.getLogger("ai.priority")

LEVEL_TITLES = {"low": "Low", "medium": "Medium", "high": "High", "critical": "Critical"}
STRONG_COMPONENT = 0.5  # factor at which a component is a reason *for* the level
WEAK_COMPONENT = 0.3  # factor below which a component is a reason the level is not higher
MAX_REASONS = 3


def _join(phrases):
    """["a", "b", "c"] -> "a, b and c"."""
    if len(phrases) == 1:
        return phrases[0]
    return ", ".join(phrases[:-1]) + " and " + phrases[-1]


def _points(value):
    """35.0 -> "35", 34.6 -> "34.6"."""
    return f"{value:.0f}" if float(value).is_integer() else f"{value:.1f}"


def build_explanation(level, components, reopen_points=0.0, reopen_reason=""):
    """Sentence naming the strongest components, e.g.
    "High priority because the issue has high severity, significant public impact and multiple nearby complaints."

    * Components whose factor is >= 0.5 are the reasons for the level (largest contribution first, at
      most three).
    * For low / medium priority, heavy components with a factor < 0.3 are added as the reasons the
      priority is not higher ("..., but limited public impact and a low-risk location.").
    * When no component is strong, the two largest contributors describe the (low) priority
      ("Low priority because the issue has only moderate severity and limited public impact.").
    """
    ranked = sorted(COMPONENT_KEYS, key=lambda k: (-components[k]["score"], COMPONENT_KEYS.index(k)))
    strong = [k for k in ranked if components[k]["raw"] >= STRONG_COMPONENT and components[k]["score"] > 0]
    strong = strong[:MAX_REASONS]
    title = LEVEL_TITLES[level]
    if strong:
        sentence = f"{title} priority because the issue has {_join([components[k]['reason'] for k in strong])}"
        if level in ("low", "medium"):
            weak = sorted((k for k in COMPONENT_KEYS if k not in strong and components[k]["max"] > 0
                           and components[k]["raw"] < WEAK_COMPONENT),
                          key=lambda k: (-components[k]["max"], COMPONENT_KEYS.index(k)))[:2]
            if weak:
                sentence += f", but {_join([components[k]['reason'] for k in weak])}"
        sentence += "."
    else:
        top = [k for k in ranked if components[k]["max"] > 0][:2] or ["severity"]
        sentence = f"{title} priority because the issue has only {_join([components[k]['reason'] for k in top])}."
    if reopen_points:
        sentence += f" It was {reopen_reason} (+{_points(reopen_points)} points)."
    return sentence


class PriorityEngine:
    """PriorityEngine(config).calculate(inputs) -> dict.

    config: {"weights": {"severity": 40, "public_impact": 25, "location_risk": 15, "frequency": 10, "duplicates": 10},
             "thresholds": {"medium": 26, "high": 51, "critical": 76}}
    inputs: {"severity_score": 0-100, "public_impact": 0-1, "location_risk": 0-1,
             "nearby_count": int, "frequency_count": int, "duplicate_count": int,
             "category_safety_weight": 0-1, "is_reopened": bool, "category": slug}

    ``config`` may also be the whole engine config (its "priority" section is used) or a
    ``PriorityConfig``; invalid weights / thresholds raise ``ValueError``. ``inputs`` may add
    ``reopen_count`` (int); ``location_risk`` may be the full location-risk dict; ``public_impact``
    may be omitted (the category safety weight is then used alone).
    """

    def __init__(self, config=None):
        self.config = PriorityConfig.from_dict(config)

    @staticmethod
    def _facts(inputs):
        location = inputs.get("location_risk")
        if isinstance(location, dict):
            location = location.get("score")
        return {
            "severity_score": round(100.0 * severity_rule(inputs.get("severity_score")).raw, 2),
            "public_impact": None if inputs.get("public_impact") is None else to_unit(inputs["public_impact"]),
            "category_safety_weight": (None if inputs.get("category_safety_weight") is None
                                       else to_unit(inputs["category_safety_weight"])),
            "location_risk": to_unit(location),
            "nearby_count": to_count(inputs.get("nearby_count")),
            "frequency_count": to_count(inputs.get("frequency_count")),
            "duplicate_count": to_count(inputs.get("duplicate_count")),
            "is_reopened": bool(inputs.get("is_reopened")),
            "reopen_count": to_count(inputs.get("reopen_count")),
            "category": inputs.get("category"),
        }

    def calculate(self, inputs):
        """Returns (CONTRACT):
            {"final_score": 87, "priority_level": "critical",
             "components": {"severity": {"score": 35.0, "max": 40.0, "raw": 0.875, "label": "Severity"},
                            "public_impact": {...}, "location_risk": {...}, "frequency": {...}, "duplicates": {...}},
             "weights": {...}, "factors": {...},
             "explanation": "High priority because the issue has high severity, significant public impact and multiple nearby complaints.",
             "summary": "Priority Score: 87/100"}
        Components also carry ``reason``; the result adds ``breakdown`` (["Severity 35/40", ...]),
        ``adjustments`` (reopen bump), ``thresholds`` and ``version``.
        """
        if inputs is None:
            inputs = {}
        if not isinstance(inputs, dict):
            raise ValueError("Priority inputs must be a mapping")
        cfg = self.config
        facts = self._facts(inputs)
        results = {
            "severity": severity_rule(facts["severity_score"], cfg.thresholds),
            "public_impact": public_impact_rule(facts["public_impact"], facts["category_safety_weight"]),
            "location_risk": location_risk_rule(facts["location_risk"]),
            "frequency": frequency_rule(facts["frequency_count"], cfg.frequency_k),
            "duplicates": duplicates_rule(facts["duplicate_count"], cfg.duplicate_k),
        }
        components = {}
        for key in COMPONENT_KEYS:
            weight = cfg.weights[key]
            components[key] = {
                "score": round(weight * results[key].raw, 1),
                "max": round(weight, 1),
                "raw": round(results[key].raw, 4),
                "label": COMPONENT_LABELS[key],
                "reason": results[key].reason,
            }

        bump, bump_reason = reopen_adjustment(facts["is_reopened"], facts["reopen_count"], cfg.reopen_bump)
        total = sum(components[key]["score"] for key in COMPONENT_KEYS) + bump
        final_score = int(min(100, max(0, math.floor(total + 0.5 + 1e-9))))
        level = score_to_level(final_score, cfg.thresholds)

        result = {
            "final_score": final_score,
            "priority_level": level,
            "components": components,
            "weights": {key: round(cfg.weights[key], 2) for key in COMPONENT_KEYS},
            "factors": {**{key: components[key]["raw"] for key in COMPONENT_KEYS},
                        "reopen_bump": bump, "inputs": facts},
            "adjustments": ([{"key": "reopened", "label": "Reopened complaint", "score": bump,
                              "reason": bump_reason}] if bump else []),
            "explanation": build_explanation(level, components, bump, bump_reason),
            "summary": f"Priority Score: {final_score}/100",
            "breakdown": [f"{components[key]['label']} {_points(components[key]['score'])}/"
                          f"{_points(components[key]['max'])}" for key in COMPONENT_KEYS],
            "thresholds": dict(cfg.thresholds),
            "version": PRIORITY_ENGINE_VERSION,
        }
        logger.debug("Priority %s (%s) for category %s", final_score, level, facts["category"])
        return result


def calculate_priority(inputs, config=None):
    return PriorityEngine(config).calculate(inputs)
