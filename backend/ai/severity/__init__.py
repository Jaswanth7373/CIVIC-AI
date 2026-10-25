"""Severity assessment (Low / Medium / High / Critical).

    assess_severity(*, category, category_profile, vision, text, location_risk,
                    nearby_count, frequency_count, duplicate_count, config) -> dict
"""
from .severity_config import DEFAULT_FACTOR_WEIGHTS, SEVERITY_ENGINE_VERSION, SeverityConfig  # noqa: F401
from .severity_engine import assess_severity, impact_strength  # noqa: F401
