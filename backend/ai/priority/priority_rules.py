"""Priority rules - one pure function per priority component.

Every rule maps raw facts about a complaint to a normalised factor ``raw`` in [0, 1] plus a short
noun phrase (``reason``) that the explanation generator can drop straight into a sentence such as
"High priority because the issue has high severity, significant public impact and multiple
nearby complaints.". The engine multiplies ``raw`` by the component weight (its maximum points).

Rules are pure (no I/O, no state), so they are deterministic and trivially unit-testable.
"""
import math
from typing import NamedTuple

from ..config import score_to_level
from ..severity.severity_engine import impact_strength
from .priority_config import DUPLICATE_SATURATION_K, FREQUENCY_SATURATION_K, MAX_REOPEN_BUMPS, REOPEN_BUMP_POINTS

SEVERITY_PHRASES = {
    "critical": "critical severity",
    "high": "high severity",
    "medium": "moderate severity",
    "low": "low severity",
}
STRONG_BAND = 0.6  # raw >= 0.6 -> "significant" / "high-risk"
MODERATE_BAND = 0.3  # raw >= 0.3 -> "moderate"


class RuleResult(NamedTuple):
    raw: float  # normalised factor in [0, 1]
    reason: str  # short noun phrase for explanations, e.g. "significant public impact"


def to_unit(value, default=0.0):
    """Coerce to a float in [0, 1]; None / junk -> ``default``."""
    if value is None or isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return min(1.0, max(0.0, number))


def to_count(value):
    """Coerce to a non-negative int; None / junk -> 0."""
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def saturating(count, k):
    """``1 - exp(-k * n)``: 0 for no reports, approaches 1 with diminishing returns."""
    return 1.0 - math.exp(-k * max(0, count))


def severity_rule(severity_score, thresholds=None):
    """Severity factor = severity_score / 100; phrase from the severity level bands."""
    if severity_score is None or isinstance(severity_score, bool):
        score = 0.0
    else:
        try:
            score = float(severity_score)
        except (TypeError, ValueError):
            score = 0.0
        if not math.isfinite(score):
            score = 0.0
    score = min(100.0, max(0.0, score))
    return RuleResult(score / 100.0, SEVERITY_PHRASES[score_to_level(score, thresholds)])


def public_impact_rule(public_impact, category_safety_weight=None):
    """Public impact = 0.7 x max(a, b) + 0.3 x mean(a, b).

    ``a`` is the impact derived from the complaint text (safety score / impacts, see
    ``public_impact_from_text``) and ``b`` the category's public-safety weight. The blend is
    dominated by the stronger evidence (an open manhole is dangerous even when the citizen does not
    say so) but rewards agreement between the two. With only one value available it is used as-is.
    """
    values = [to_unit(v) for v in (public_impact, category_safety_weight) if v is not None]
    if not values:
        raw = 0.0
    else:
        raw = 0.7 * max(values) + 0.3 * (sum(values) / len(values))
    if raw >= STRONG_BAND:
        reason = "significant public impact"
    elif raw >= MODERATE_BAND:
        reason = "moderate public impact"
    else:
        reason = "limited public impact"
    return RuleResult(raw, reason)


def location_risk_rule(location_risk):
    """Location factor = location risk score (accepts the 0..1 score or the full location-risk dict)."""
    if isinstance(location_risk, dict):
        location_risk = location_risk.get("score")
    raw = to_unit(location_risk)
    if raw >= STRONG_BAND:
        reason = "a high-risk location"
    elif raw >= MODERATE_BAND:
        reason = "a moderately risky location"
    else:
        reason = "a low-risk location"
    return RuleResult(raw, reason)


def frequency_rule(frequency_count, k=FREQUENCY_SATURATION_K):
    """Frequency factor = ``1 - exp(-k x n)`` with n = same-category complaints nearby."""
    count = to_count(frequency_count)
    if count >= 2:
        reason = "multiple nearby complaints"
    elif count == 1:
        reason = "a similar complaint nearby"
    else:
        reason = "no similar complaints nearby"
    return RuleResult(saturating(count, k), reason)


def duplicates_rule(duplicate_count, k=DUPLICATE_SATURATION_K):
    """Duplicates factor = ``1 - exp(-k x n)`` with n = linked duplicate reports."""
    count = to_count(duplicate_count)
    if count >= 2:
        reason = "several duplicate reports"
    elif count == 1:
        reason = "a duplicate report"
    else:
        reason = "no duplicate reports"
    return RuleResult(saturating(count, k), reason)


def reopen_adjustment(is_reopened, reopen_count=None, bump=REOPEN_BUMP_POINTS):
    """Points added for reopened complaints: ``bump`` per reopen, counted at most twice.

    Returns ``(points, reason)``; ``(0.0, "")`` when the complaint was never reopened.
    """
    count = to_count(reopen_count)
    if is_reopened and count == 0:
        count = 1
    if count == 0:
        return 0.0, ""
    times = "once" if count == 1 else f"{count} times"
    return float(bump) * min(count, MAX_REOPEN_BUMPS), f"reopened {times} by the citizen"


def public_impact_from_text(text_result):
    """Text-derived public impact (0..1) for the priority engine, or None without a text analysis.

    = max(text safety score, impact strength) where impact strength is the strongest impact plus a
    10 % breadth bonus per additional impact type (see ``ai.severity.severity_engine.impact_strength``).
    """
    if not isinstance(text_result, dict):
        return None
    return round(max(to_unit(text_result.get("safety_score")), impact_strength(text_result.get("impacts"))), 4)
