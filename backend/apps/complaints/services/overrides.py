"""Admin override of AI predictions (human-in-the-loop correction).

The AI decision is never edited in place: the original ``AIPrediction`` row stays untouched (so analytics can
measure how often humans disagree with the AI), while the complaint gets the corrected values and
``is_ai_overridden=True``. Overridden category / severity survive later automatic re-analysis, and a manual
priority is stored as an override ``PriorityScore`` that automatic recalculations keep (see ``priority``).

* Category change -> the department is re-routed through the routing table and the SLA due date recomputed;
  an automatically generated title follows the new category. An officer who is already assigned stays assigned
  (moving the work order is a separate, explicit reassignment by the admin).
* Severity change -> when no score is given, a representative ``severity_score`` for the chosen level is used:
  the current score if it already lies in that level's band, else the middle of the band (bands come from the
  configured thresholds, e.g. high = 51-75 -> 63).
* Priority change -> clamped to 0-100, stored as ``PriorityScore(is_override=True, trigger="override")`` with
  the explanation "Manually set by <admin>: <reason>".
Every override adds an "ai_overridden" timeline event and an "ai_override" audit entry with the changes.
"""
from django.db import transaction
from rest_framework.exceptions import PermissionDenied, ValidationError

from ai.config import score_to_level
from apps.core.exceptions import ServiceError
from apps.core.permissions import is_admin
from apps.core.utils import parse_id

from ..models import Level, StatusHistory
from . import notify as notifications
from .context import engine_config
from .helpers import build_title, is_automatic_title, run_side_effect, save_fields, to_float, to_score
from .priority import recalculate_priority, store_priority_override
from .routing import route_department
from .status import add_event
from .verification import verification_review_pending


def severity_band(level, thresholds):
    """Inclusive (low, high) score range of a level for the given {"medium", "high", "critical"} thresholds."""
    medium, high, critical = int(thresholds["medium"]), int(thresholds["high"]), int(thresholds["critical"])
    return {
        Level.LOW: (0, medium - 1),
        Level.MEDIUM: (medium, high - 1),
        Level.HIGH: (high, critical - 1),
        Level.CRITICAL: (critical, 100),
    }[level]


def representative_severity_score(level, thresholds, current=None):
    """Keep ``current`` when it already lies in the level's band, else the band's middle."""
    low, high = severity_band(level, thresholds)
    if current is not None and low <= current <= high:
        return int(current)
    return int(round((low + high) / 2))


def _resolve_category(value):
    from apps.departments.models import CivicCategory

    if isinstance(value, CivicCategory):
        category = value
    else:
        text = str(value).strip()
        queryset = CivicCategory.objects.all()
        category_id = parse_id(text)
        category = (queryset.filter(pk=category_id) if category_id is not None else queryset.filter(slug=text)).first()
    if category is None:
        raise ValidationError({"category": ["Unknown category."]})
    if not category.is_active:
        raise ValidationError({"category": [f"'{category.name}' is inactive; activate it before using it."]})
    return category


def override_ai(complaint, *, actor, category=None, severity=None, priority_score=None, reason="",
                severity_score=None, request=None):
    """Admin corrects category / severity / priority. Re-routes department when the category changes,
    stores an override PriorityScore, sets is_ai_overridden, timeline event + audit log. Returns complaint.

    ``category``: CivicCategory, id or slug. ``severity``: low / medium / high / critical (optionally with an
    explicit ``severity_score`` that must lie in that level's band; a score alone implies its level).
    ``priority_score``: 0-100 (clamped). ``reason`` is mandatory.
    """
    from apps.audit.services import log_action

    if not is_admin(actor):
        raise PermissionDenied("Only administrators can override AI predictions.")
    reason = (reason or "").strip()
    if not reason:
        raise ValidationError({"reason": ["Explain why the AI prediction is being overridden."]})
    if category is None and severity is None and severity_score is None and priority_score is None:
        raise ServiceError("Provide a category, a severity or a priority score to override.")

    config = engine_config()
    severity_thresholds = config["severity"]["thresholds"]
    changes = {}
    department_changed = False
    with transaction.atomic():
        if category is not None:
            new_category = _resolve_category(category)
            old_category = complaint.category if complaint.category_id else None
            if old_category is None or old_category.pk != new_category.pk:
                changes["category"] = [old_category.slug if old_category else None, new_category.slug]
                title_was_automatic = is_automatic_title(complaint.title, old_category, complaint.location)
                complaint.category = new_category
                if not complaint.title.strip() or title_was_automatic:
                    complaint.title = build_title(new_category, complaint.location)
                department = route_department(new_category)
                if department is not None and department.pk != complaint.department_id:
                    changes["department"] = [complaint.department.code if complaint.department_id else None,
                                             department.code]
                    complaint.department = department
                    department_changed = True

        if severity is not None or severity_score is not None:
            level, score = _severity_override(complaint, severity, severity_score, severity_thresholds)
            if level != complaint.severity:
                changes["severity"] = [complaint.severity or None, level]
            if score != complaint.severity_score:
                changes["severity_score"] = [complaint.severity_score, score]
            complaint.severity, complaint.severity_score = level, score

        complaint.is_ai_overridden = True
        complaint.needs_manual_review = verification_review_pending(complaint)
        complaint.sla_due_at = complaint.compute_sla_due()
        save_fields(complaint, "category", "title", "department", "severity", "severity_score", "is_ai_overridden",
                    "needs_manual_review", "sla_due_at")

        old_priority = complaint.priority_score
        old_level = complaint.priority_level
        if priority_score is not None:
            store_priority_override(complaint, priority_score, actor=actor, reason=reason)
            changes["priority_score"] = [old_priority, complaint.priority_score]
        elif "category" in changes or "severity" in changes or "severity_score" in changes:
            recalculate_priority(complaint, trigger="ai_override", actor=actor, notify=False)
            if complaint.priority_score != old_priority:
                changes["priority_score"] = [old_priority, complaint.priority_score]

        add_event(complaint, StatusHistory.Event.AI_OVERRIDDEN, actor=actor, remarks=reason,
                  metadata={"changes": changes})
        summary = ", ".join(f"{name} {before} -> {after}" for name, (before, after) in changes.items()) or "confirmed"
        run_side_effect(
            "Audit log of an AI override", log_action, actor, "ai_override", entity=complaint,
            description=f"AI override on {complaint.complaint_number}: {summary}"[:255],
            changes={**changes, "reason": reason}, request=request,
        )

    if department_changed:
        notifications.notify_citizen(
            complaint, notification_type="department_assigned", title="Department updated",
            message=f"{complaint.complaint_number} is now handled by the {complaint.department.name}.", actor=actor,
        )
    if complaint.priority_level == Level.CRITICAL and old_level != Level.CRITICAL and complaint.is_open:
        notifications.notify_critical(complaint)
    return complaint


def _severity_override(complaint, severity, severity_score, thresholds):
    if severity is not None and severity not in Level.values:
        raise ValidationError({"severity": [f"Choose one of: {', '.join(Level.values)}."]})
    if severity_score is not None:
        score = to_score(severity_score)
        if severity is None:
            return score_to_level(score, thresholds), score
        low, high = severity_band(severity, thresholds)
        if not low <= score <= high:
            raise ValidationError({"severity_score": [
                f"A {severity} severity needs a score between {low} and {high} (got {to_float(severity_score):g})."
            ]})
        return severity, score
    return severity, representative_severity_score(severity, thresholds, current=complaint.severity_score)
