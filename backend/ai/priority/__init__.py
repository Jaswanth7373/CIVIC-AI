"""Priority engine (0-100, configurable weights, explained).

    PriorityEngine(config).calculate(inputs) -> dict      (or calculate_priority(inputs, config))
    PriorityConfig.from_dict(config)                      validated + normalised weights / thresholds
    public_impact_from_text(text_result)                  text-derived public impact input (0..1)
"""
from .priority_config import (  # noqa: F401
    COMPONENT_KEYS,
    COMPONENT_LABELS,
    DEFAULT_WEIGHTS,
    PRIORITY_ENGINE_VERSION,
    PriorityConfig,
    normalize_weights,
)
from .priority_engine import PriorityEngine, calculate_priority  # noqa: F401
from .priority_rules import public_impact_from_text  # noqa: F401
