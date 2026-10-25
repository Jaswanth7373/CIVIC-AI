"""Priority (re)calculation for stored complaints (BUILD_SPEC sections 2.5 and 3.1).

The scoring is done by the framework-independent ``ai.priority`` engine: a transparent **weighted sum** of five
normalised factors (default weights severity 40, public impact 25, location risk 15, frequency 10, duplicates 10;
admins tune them in AI settings), mapped to Low / Medium / High / Critical by configurable thresholds and
explained in plain English. This module gathers the *current* facts from the database, calls the engine,
stores the result as a new ``PriorityScore`` row (complete history - never overwritten) and mirrors the
score / level / SLA due date onto the complaint.

Engine inputs gathered from the database
    severity_score           complaint.severity_score (AI severity or an admin override), 0-100
    public_impact            text-derived impact of the latest AIPrediction, as defined by the engine
                             (``ai.priority.public_impact_from_text``: max of the text safety score and the impact
                             strength); None without a text analysis - the engine then uses the category alone
    category_safety_weight   CivicCategory.public_safety_weight - the inherent hazard of the issue type
    location_risk            AIPrediction.location_risk["score"], else a fresh ai.geospatial.assess_location_risk()
    nearby_count             complaints within AIConfiguration.nearby_radius_m in the last frequency_window_days
    frequency_count          ... of those, the complaints of the same category (a recurring problem)
    duplicate_count          complaint.duplicate_count (linked duplicate reports)
    is_reopened/reopen_count complaint.reopen_count (the engine adds a small, documented bump per reopen)

Manual overrides are sticky: once an administrator sets the priority by hand, automatic recalculations
(new duplicates, reopen, re-analysis, configuration changes) keep that decision and return the override row.
Pass ``keep_override=False`` to deliberately replace it with a fresh AI calculation.
"""
import logging

from django.db import transaction

from ai.config import score_to_level

from ..models import Complaint, Level, PriorityScore, StatusHistory
from . import notify as notifications
from .context import engine_config, engine_risk_zones, nearby_complaints
from .helpers import (
    address_text,
    json_safe,
    log_failure,
    normalize_actor,
    save_fields,
    to_float,
    to_score,
    to_unit,
)
from .status import add_event

logger = logging.getLogger("apps.complaints")

#: Engine component key -> PriorityScore column.
COMPONENT_FIELDS = {
    "severity": "severity_component",
    "public_impact": "impact_component",
    "location_risk": "location_component",
    "frequency": "frequency_component",
    "duplicates": "duplicate_component",
}

#: A recalculation is written to the citizen-visible timeline when the level changes or the score moves this much.
TIMELINE_SCORE_DELTA = 5

TRIGGER_LABELS = {
    "initial": "the initial AI analysis",
    "duplicate_update": "a change in linked duplicate reports",
    "reopened": "the complaint being reopened",
    "reanalysis": "an AI re-analysis",
    "ai_override": "an administrator's correction of the AI prediction",
    "config_change": "a change of the AI settings",
    "recalculated": "a recalculation",
}


# ---------------------------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------------------------
def public_impact_of(analysis, impacts=None):
    """Text-derived public impact (0..1) of an AI analysis, or None when there was no text analysis.

    ``analysis`` is a ``run_analysis`` result or a stored ``AIPrediction.raw_output``: the value the pipeline
    computed (``public_impact``) is used when present, otherwise the engine rule
    ``ai.priority.public_impact_from_text`` is applied to its text analysis (or to the stored ``impacts``).
    """
    analysis = analysis if isinstance(analysis, dict) else {}
    if analysis.get("public_impact") is not None:
        return round(to_unit(analysis["public_impact"]), 4)
    text = analysis.get("text")
    if not isinstance(text, dict):
        if not impacts:
            return None
        text = {"impacts": impacts}
    from ai.priority import public_impact_from_text

    value = public_impact_from_text(text)
    return None if value is None else round(to_unit(value), 4)


def build_priority_inputs(*, severity_score, public_impact=None, category=None, location_risk=0.0, nearby_count=0,
                          frequency_count=0, duplicate_count=0, reopen_count=0):
    """Engine input dict (``PriorityEngine.calculate`` contract) from plain facts. Shared by stored complaints
    and the no-database analysis preview. Unknown public impact / category stay None (the engine then relies
    on the evidence that exists instead of treating it as zero)."""
    return {
        "severity_score": to_score(severity_score),
        "public_impact": None if public_impact is None else round(to_unit(public_impact), 4),
        "location_risk": round(to_unit(location_risk), 4),
        "nearby_count": int(nearby_count or 0),
        "frequency_count": int(frequency_count or 0),
        "duplicate_count": int(duplicate_count or 0),
        "category_safety_weight": round(to_unit(category.public_safety_weight), 4) if category else None,
        "is_reopened": bool(reopen_count),
        "reopen_count": int(reopen_count or 0),
        "category": category.slug if category else None,
    }


def _location_risk_score(complaint, prediction, *, nearby_count):
    """(score 0..1, source) - the stored AI assessment, else a fresh one, else 0 when unavailable. A stored
    placeholder the engine marked ``assessed: False`` (location could not be assessed) is re-assessed."""
    stored = (prediction.location_risk or {}) if prediction is not None else {}
    stored = stored if isinstance(stored, dict) else {}
    score = stored.get("score")
    if isinstance(score, (int, float)) and not isinstance(score, bool) and stored.get("assessed") is not False:
        return to_unit(score), "ai_prediction"
    location = complaint.location
    try:
        from ai.geospatial import assess_location_risk

        result = assess_location_risk(
            float(location.latitude), float(location.longitude), address=address_text(location),
            text=complaint.description or "", risk_zones=engine_risk_zones(), nearby_count=nearby_count,
        )
    except Exception as exc:  # noqa: BLE001 - a missing risk estimate lowers one factor, it must not block scoring
        log_failure("Location risk assessment for priority", exc)
        return 0.0, "unavailable"
    return to_unit((result or {}).get("score")), "assessed"


def gather_priority_inputs(complaint, config=None, *, prediction=None):
    """(inputs, sources) for ``complaint`` from the current database state."""
    config = config or engine_config()
    if prediction is None:
        prediction = complaint.latest_prediction
    category = complaint.category if complaint.category_id else None
    location = complaint.location
    nearby = nearby_complaints(
        location.latitude, location.longitude, radius_m=config["nearby_radius_m"],
        days=config["frequency_window_days"], exclude_id=complaint.pk,
        exclude_statuses=[Complaint.Status.REJECTED], exclude_merged=True,
    )
    slug = category.slug if category else None
    frequency_count = sum(1 for item in nearby if slug and item["category"] == slug)
    location_risk, risk_source = _location_risk_score(complaint, prediction, nearby_count=len(nearby))
    inputs = build_priority_inputs(
        severity_score=complaint.severity_score,
        public_impact=public_impact_of(prediction.raw_output, prediction.impacts) if prediction is not None else None,
        category=category,
        location_risk=location_risk,
        nearby_count=len(nearby),
        frequency_count=frequency_count,
        duplicate_count=complaint.duplicate_count,
        reopen_count=complaint.reopen_count,
    )
    sources = {"location_risk": risk_source, "prediction_id": prediction.pk if prediction is not None else None}
    return inputs, sources


# ---------------------------------------------------------------------------------------------------------------
# Recalculation
# ---------------------------------------------------------------------------------------------------------------
def recalculate_priority(complaint, *, trigger="recalculated", actor=None, notify=True, keep_override=True):
    """Recompute the priority with ai.priority using current DB facts (severity, nearby/frequency counts,
    duplicate_count, location risk, reopen state), store a new PriorityScore row, update
    complaint.priority_score/priority_level/sla_due_at, and return the PriorityScore.

    * ``trigger`` records why (initial, duplicate_update, reopened, reanalysis, ai_override, config_change...).
    * The first score adds a "priority_assigned" timeline event; later ones add "priority_updated" when the
      level changes or the score moves by at least ``TIMELINE_SCORE_DELTA`` points.
    * When an open complaint becomes critical, administrators (once per complaint) and the assigned officer
      are alerted - unless ``notify=False`` (the submission pipeline sends its alerts in its own step).
    * ``keep_override`` keeps a manual priority override (see module docstring).
    """
    from ai.priority import calculate_priority

    previous = complaint.latest_priority
    if keep_override and previous is not None and previous.is_override:
        logger.info("Priority of %s kept: manual override by an administrator", complaint.complaint_number)
        return previous

    config = engine_config()
    inputs, sources = gather_priority_inputs(complaint, config)
    result = calculate_priority(inputs, config=config["priority"]) or {}
    thresholds = config["priority"]["thresholds"]
    final_score = to_score(result.get("final_score"))
    level = result.get("priority_level")
    if level not in Level.values:
        level = score_to_level(final_score, thresholds)
    components = json_safe(result.get("components") or {})
    factors = json_safe(result.get("factors") or {})
    if not isinstance(factors, dict):
        factors = {"engine": factors}
    factors.setdefault("components", components)
    factors.setdefault("inputs", inputs)
    factors.setdefault("sources", sources)

    old_score, old_level = complaint.priority_score, complaint.priority_level
    with transaction.atomic():
        priority = PriorityScore.objects.create(
            complaint=complaint,
            **{field: _component_score(components, key) for key, field in COMPONENT_FIELDS.items()},
            final_score=final_score,
            priority_level=level,
            weights=json_safe(result.get("weights") or config["priority"]["weights"]),
            factors=factors,
            explanation=str(result.get("explanation") or ""),
            trigger=str(trigger)[:30],
            is_override=False,
            created_by=normalize_actor(actor),
        )
        complaint.priority_score = final_score
        complaint.priority_level = level
        complaint.sla_due_at = complaint.compute_sla_due()
        save_fields(complaint, "priority_score", "priority_level", "sla_due_at")
        _record_timeline(complaint, priority, previous, old_score=old_score, old_level=old_level, actor=actor)

    if notify and level == Level.CRITICAL and old_level != Level.CRITICAL and complaint.is_open:
        notifications.notify_critical(complaint)
    return priority


def _component_score(components, key):
    value = components.get(key) if isinstance(components, dict) else None
    if isinstance(value, dict):
        value = value.get("score")
    return round(to_float(value), 2)


def _record_timeline(complaint, priority, previous, *, old_score, old_level, actor):
    metadata = {"priority_id": priority.pk, "score": priority.final_score, "level": priority.priority_level,
                "trigger": priority.trigger}
    if previous is None:
        add_event(complaint, StatusHistory.Event.PRIORITY_ASSIGNED, actor=actor, metadata=metadata,
                  remarks=f"Priority {priority.final_score}/100 ({priority.get_priority_level_display()}). "
                          f"{priority.explanation}")
        return
    if priority.priority_level == old_level and abs(priority.final_score - (old_score or 0)) < TIMELINE_SCORE_DELTA:
        return
    reason = TRIGGER_LABELS.get(priority.trigger, priority.trigger.replace("_", " "))
    metadata.update(previous_score=old_score, previous_level=old_level or None)
    add_event(complaint, StatusHistory.Event.PRIORITY_UPDATED, actor=actor, metadata=metadata,
              remarks=f"Priority changed from {old_score}/100 to {priority.final_score}/100 "
                      f"({priority.get_priority_level_display()}) after {reason}. {priority.explanation}")


# ---------------------------------------------------------------------------------------------------------------
# Manual override (used by overrides.override_ai)
# ---------------------------------------------------------------------------------------------------------------
def store_priority_override(complaint, priority_score, *, actor, reason):
    """Store an administrator's priority as ``PriorityScore(is_override=True, trigger="override")``.

    The score is clamped to 0-100 and its level follows the configured thresholds. The last AI components are
    copied so the breakdown still shows what the engine computed; ``factors["override"]`` records the previous
    value and the reason. Returns the new PriorityScore.
    """
    config = engine_config()
    final_score = to_score(priority_score)
    level = score_to_level(final_score, config["priority"]["thresholds"])
    previous = complaint.latest_priority
    previous_factors = (previous.factors or {}) if previous is not None else {}
    factors = {
        "override": {
            "requested_score": json_safe(priority_score),
            "previous_score": complaint.priority_score,
            "previous_level": complaint.priority_level or None,
            "reason": reason,
        },
        "components": previous_factors.get("components", {}),
        "inputs": previous_factors.get("inputs", {}),
    }
    name = actor.full_name if actor is not None else "an administrator"
    with transaction.atomic():
        override = PriorityScore.objects.create(
            complaint=complaint,
            **{field: getattr(previous, field) if previous is not None else 0.0 for field in COMPONENT_FIELDS.values()},
            final_score=final_score,
            priority_level=level,
            weights=(previous.weights if previous is not None else None) or config["priority"]["weights"],
            factors=json_safe(factors),
            explanation=f"Manually set by {name}: {reason}",
            trigger="override",
            is_override=True,
            created_by=normalize_actor(actor),
        )
        complaint.priority_score = final_score
        complaint.priority_level = level
        complaint.sla_due_at = complaint.compute_sla_due()
        save_fields(complaint, "priority_score", "priority_level", "sla_due_at")
    return override
