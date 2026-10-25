"""Priority engine configuration: component weights, level thresholds and saturation constants.

The priority score (0-100) is a weighted sum of five components. Each weight is the maximum
number of points a component can contribute, so the weights must add up to 100:

    severity 40 | public_impact 25 | location_risk 15 | frequency 10 | duplicates 10

Admins can change them (``AIConfiguration``); ``PriorityConfig.from_dict`` accepts any
non-negative weights and rescales them proportionally so they sum to exactly 100 (e.g.
``{"severity": 2, "public_impact": 1, ...}`` keeps the same *ratios*). Missing weights take their
default value before rescaling; unknown keys, negative numbers and an all-zero set are rejected.

Levels use inclusive lower thresholds: 0-25 low, 26-50 medium, 51-75 high, 76-100 critical
(validated by the same function as severity levels).
"""
from dataclasses import dataclass, field

from ..config import DEFAULT_LEVEL_THRESHOLDS
from ..severity.severity_config import config_number, validate_thresholds

PRIORITY_ENGINE_VERSION = "priority-weighted-rules-1.0"

COMPONENT_KEYS = ("severity", "public_impact", "location_risk", "frequency", "duplicates")
COMPONENT_LABELS = {
    "severity": "Severity",
    "public_impact": "Public Impact",
    "location_risk": "Location Risk",
    "frequency": "Frequency",
    "duplicates": "Duplicates",
}
DEFAULT_WEIGHTS = {"severity": 40.0, "public_impact": 25.0, "location_risk": 15.0, "frequency": 10.0,
                   "duplicates": 10.0}
DEFAULT_THRESHOLDS = dict(DEFAULT_LEVEL_THRESHOLDS)  # {"medium": 26, "high": 51, "critical": 76}

# Saturation constants for count-based factors: factor = 1 - exp(-k * n).
# With k = 0.4: 1 report -> 0.33, 2 -> 0.55, 3 -> 0.70, 4 -> 0.80, 6 -> 0.91. The first few reports
# matter most; a tenth report adds almost nothing (diminishing returns, no runaway scores).
FREQUENCY_SATURATION_K = 0.4
DUPLICATE_SATURATION_K = 0.4

# Reopened complaints (the citizen says the fix did not work) get a small documented bump:
# 5 points per reopen, counted at most twice (max +10); the final score stays capped at 100.
REOPEN_BUMP_POINTS = 5.0
MAX_REOPEN_BUMPS = 2


def normalize_weights(weights=None):
    """Validate weights and rescale them so they sum to 100 (ratios are preserved).

    Missing keys use ``DEFAULT_WEIGHTS``; unknown keys, negative values and an all-zero set raise
    ``ValueError``.
    """
    merged = dict(DEFAULT_WEIGHTS)
    if weights is not None:
        if not isinstance(weights, dict):
            raise ValueError("weights must be a mapping of component -> weight")
        unknown = sorted(set(weights) - set(COMPONENT_KEYS))
        if unknown:
            raise ValueError(f"Unknown priority weight(s): {', '.join(map(str, unknown))}. "
                             f"Expected: {', '.join(COMPONENT_KEYS)}")
        for key, value in weights.items():
            merged[key] = config_number(value, f"Weight '{key}'")
    for key, value in merged.items():
        if value < 0:
            raise ValueError(f"Weight '{key}' cannot be negative")
    total = sum(merged.values())
    if total <= 0:
        raise ValueError("At least one priority weight must be greater than zero")
    return {key: merged[key] * 100.0 / total for key in COMPONENT_KEYS}


@dataclass(frozen=True)
class PriorityConfig:
    """Validated priority settings (weights always sum to 100)."""

    weights: dict = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    thresholds: dict = field(default_factory=lambda: dict(DEFAULT_THRESHOLDS))
    frequency_k: float = FREQUENCY_SATURATION_K
    duplicate_k: float = DUPLICATE_SATURATION_K
    reopen_bump: float = REOPEN_BUMP_POINTS

    @classmethod
    def from_dict(cls, config=None):
        """Build from ``{"weights": {...}, "thresholds": {...}}`` (``AIConfiguration`` priority section).

        Also accepts the whole engine config (uses its ``"priority"`` section), ``None`` / ``{}`` for the
        defaults, an existing ``PriorityConfig``, and optional ``frequency_k`` / ``duplicate_k`` /
        ``reopen_bump`` overrides. Raises ``ValueError`` on invalid values.
        """
        if isinstance(config, cls):
            return config
        if config is None:
            config = {}
        if not isinstance(config, dict):
            raise ValueError("Priority config must be a mapping")
        if isinstance(config.get("priority"), dict):
            config = config["priority"]
        frequency_k = config_number(config.get("frequency_k", FREQUENCY_SATURATION_K), "frequency_k")
        duplicate_k = config_number(config.get("duplicate_k", DUPLICATE_SATURATION_K), "duplicate_k")
        reopen_bump = config_number(config.get("reopen_bump", REOPEN_BUMP_POINTS), "reopen_bump")
        if frequency_k <= 0 or duplicate_k <= 0:
            raise ValueError("Saturation constants must be positive")
        if not 0 <= reopen_bump <= 20:
            raise ValueError("reopen_bump must be between 0 and 20 points")
        return cls(
            weights=normalize_weights(config.get("weights")),
            thresholds=validate_thresholds(config.get("thresholds")),
            frequency_k=frequency_k,
            duplicate_k=duplicate_k,
            reopen_bump=reopen_bump,
        )

    def to_dict(self):
        """Plain-dict view (weights rounded to 2 decimals) for API responses / model info."""
        return {
            "weights": {key: round(value, 2) for key, value in self.weights.items()},
            "thresholds": dict(self.thresholds),
            "frequency_k": self.frequency_k,
            "duplicate_k": self.duplicate_k,
            "reopen_bump": self.reopen_bump,
        }
