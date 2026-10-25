"""Severity engine configuration: factor weights, category defaults and saturation constants.

Severity (0-100) is a weighted sum of seven factors, each normalised to 0..1. Weights sum to 1:

    visual 0.25        how bad the defect looks (vision ``visual_severity``)
    issue_type 0.20    intrinsic danger of the category (DB ``base_severity`` / 100)
    public_safety 0.20 category safety weight blended with the text safety score
    location 0.10      location risk score (risk zones, traffic cues, density)
    impact 0.10        potential impact described in the text (impacts, urgency, severity cues)
    nearby 0.08        how many complaints exist around the location (any category)
    frequency 0.07     how often this same issue type is reported nearby

Visual evidence gets the largest single weight because the photo is the most direct evidence
of magnitude; category and safety come next because some issue types (open manholes) are
dangerous regardless of how they look. Context factors (location, crowding, recurrence) refine
the score but cannot dominate it.

Level thresholds are shared with the priority engine (``validate_thresholds``): inclusive lower
bounds, default 0-25 low, 26-50 medium, 51-75 high, 76-100 critical.
"""
import math
from dataclasses import dataclass, field

from ..config import DEFAULT_LEVEL_THRESHOLDS

SEVERITY_ENGINE_VERSION = "severity-weighted-factors-1.0"

FACTOR_KEYS = ("visual", "issue_type", "public_safety", "location", "impact", "nearby", "frequency")
DEFAULT_FACTOR_WEIGHTS = {
    "visual": 0.25,
    "issue_type": 0.20,
    "public_safety": 0.20,
    "location": 0.10,
    "impact": 0.10,
    "nearby": 0.08,
    "frequency": 0.07,
}
FACTOR_LABELS = {
    "visual": "Visual severity",
    "issue_type": "Issue type",
    "public_safety": "Public safety",
    "location": "Location risk",
    "impact": "Potential impact",
    "nearby": "Nearby complaints",
    "frequency": "Complaint frequency",
}

# Category defaults (same values as the seeded CivicCategory rows) used when the caller does not
# pass a ``category_profile``; admin categories without a profile use UNKNOWN_CATEGORY_PROFILE.
DEFAULT_CATEGORY_PROFILES = {
    "pothole": {"base_severity": 60, "public_safety_weight": 0.75},
    "garbage": {"base_severity": 40, "public_safety_weight": 0.45},
    "drainage": {"base_severity": 55, "public_safety_weight": 0.60},
    "streetlight": {"base_severity": 45, "public_safety_weight": 0.60},
    "water_leak": {"base_severity": 50, "public_safety_weight": 0.40},
    "open_manhole": {"base_severity": 85, "public_safety_weight": 0.95},
    "road_crack": {"base_severity": 40, "public_safety_weight": 0.50},
    "fallen_tree": {"base_severity": 65, "public_safety_weight": 0.80},
    "other": {"base_severity": 30, "public_safety_weight": 0.30},
}
UNKNOWN_CATEGORY_PROFILE = {"base_severity": 40, "public_safety_weight": 0.40}

# Public safety = 55 % category safety weight + 45 % text safety score (when text is available).
CATEGORY_SAFETY_SHARE = 0.55

# Potential impact = 60 % impact strength + 25 % text severity cues + 15 % urgency cues.
IMPACT_BLEND = {"impacts": 0.60, "severity_hint": 0.25, "urgency": 0.15}
IMPACT_BREADTH_BONUS = 0.10  # each additional impact type adds 10 % of its score

# Count factors saturate: value = 1 - exp(-n / s).
NEARBY_SATURATION = 6.0  # 6 complaints nearby -> 0.63
FREQUENCY_SATURATION = 4.0  # 4 same-category complaints -> 0.63
DUPLICATE_FREQUENCY_SHARE = 0.5  # a linked duplicate counts as half a recurring report

# Photo quality: evidence from a blurry / dark photo counts less, the removed weight goes to the
# other factors. Darkness is expected (not a defect) for streetlight faults.
BLURRY_VISUAL_FACTOR = 0.6
DARK_VISUAL_FACTOR = 0.7
DARKNESS_EXPECTED_CATEGORIES = frozenset({"streetlight"})

# Hazard floor: categories whose public-safety weight is >= 0.9 (open manholes) are never rated
# below the "high" threshold - an open manhole can kill regardless of what the photo shows.
HAZARD_FLOOR_SAFETY_WEIGHT = 0.9


def config_number(value, name):
    """``float()`` for configuration values; booleans, non-numeric and non-finite input raise ValueError."""
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number, got {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number, got {value!r}") from None
    if not math.isfinite(number):
        raise ValueError(f"{name} must be a finite number")
    return number


def validate_thresholds(thresholds=None):
    """Return {"medium", "high", "critical"} satisfying 0 < medium < high < critical <= 100.

    Missing keys use the defaults (26 / 51 / 76); unknown keys or a wrong order raise ValueError.
    """
    merged = dict(DEFAULT_LEVEL_THRESHOLDS)
    if thresholds is not None:
        if not isinstance(thresholds, dict):
            raise ValueError("thresholds must be a mapping with medium / high / critical")
        unknown = sorted(set(thresholds) - set(DEFAULT_LEVEL_THRESHOLDS))
        if unknown:
            raise ValueError(f"Unknown threshold(s): {', '.join(map(str, unknown))}")
        for key, value in thresholds.items():
            merged[key] = config_number(value, f"Threshold '{key}'")
    if not 0 < merged["medium"] < merged["high"] < merged["critical"] <= 100:
        raise ValueError("Thresholds must satisfy 0 < medium < high < critical <= 100")
    return {key: int(merged[key]) if float(merged[key]).is_integer() else float(merged[key])
            for key in ("medium", "high", "critical")}


def normalize_factor_weights(weights=None):
    """Merge with defaults, validate and rescale so the seven factor weights sum to 1."""
    merged = dict(DEFAULT_FACTOR_WEIGHTS)
    if weights is not None:
        if not isinstance(weights, dict):
            raise ValueError("Severity weights must be a mapping of factor -> weight")
        unknown = sorted(set(weights) - set(FACTOR_KEYS))
        if unknown:
            raise ValueError(f"Unknown severity factor(s): {', '.join(map(str, unknown))}")
        for key, value in weights.items():
            merged[key] = config_number(value, f"Severity weight '{key}'")
    if any(value < 0 for value in merged.values()):
        raise ValueError("Severity factor weights cannot be negative")
    total = sum(merged.values())
    if total <= 0:
        raise ValueError("At least one severity factor weight must be greater than zero")
    return {key: merged[key] / total for key in FACTOR_KEYS}


@dataclass(frozen=True)
class SeverityConfig:
    """Validated severity settings (weights always sum to 1)."""

    weights: dict = field(default_factory=lambda: dict(DEFAULT_FACTOR_WEIGHTS))
    thresholds: dict = field(default_factory=lambda: dict(DEFAULT_LEVEL_THRESHOLDS))

    @classmethod
    def from_dict(cls, config=None):
        """Build from ``{"thresholds": {...}, "weights": {...}}`` (``AIConfiguration`` severity section).

        Also accepts the whole engine config (uses its ``"severity"`` section), an existing
        ``SeverityConfig`` and ``None`` for the defaults. Raises ValueError on invalid values.
        """
        if isinstance(config, cls):
            return config
        config = config or {}
        if not isinstance(config, dict):
            raise ValueError("Severity config must be a mapping")
        if isinstance(config.get("severity"), dict):
            config = config["severity"]
        return cls(weights=normalize_factor_weights(config.get("weights")),
                   thresholds=validate_thresholds(config.get("thresholds")))
