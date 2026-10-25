"""Officer recommendation & assignment (BUILD_SPEC section 3.4).

Recommendation technique: a transparent weighted-sum multi-criteria score
-------------------------------------------------------------------------
For every candidate officer four factors, each normalised to 0..1, are computed:

    capacity      1 - workload / capacity
                  workload = complaints assigned to the officer that are still open
                  (status in ``Complaint.OPEN_ASSIGNED_STATUSES``); capacity = ``max_active_complaints``
    proximity     exp(-d / 5 km), d = haversine distance from the officer's base location to the complaint
                  (0.5 - neutral - when either location is unknown)
    availability  1 when the officer is marked available, else 0
    track record  mean of two Bayesian-smoothed rates, each shrunk towards a neutral 0.5 with two
                  pseudo-observations (so an officer without history scores exactly 0.5 and one lucky case
                  does not look like a perfect record):
                    resolution rate = (resolved + 1) / (resolved + rejected + open-past-SLA + 2)
                    satisfaction    = (sum of ratings mapped 1..5 -> 0..1 + 1) / (number of ratings + 2)

    score = 0.40*capacity + 0.25*proximity + 0.15*availability + 0.20*track_record
    critical-priority complaints shift weight from capacity to experience:
    score = 0.30*capacity + 0.25*proximity + 0.15*availability + 0.30*track_record

Candidates follow the department routing chain: officers of the complaint's department; when none of them can
take the complaint (available and below capacity) the officers of the category's secondary department are
added, then those of the General Civic Department (GEN), then every other active officer.

Ranking applies the hard constraints before the soft score: officers at/over capacity are ranked last, officers
marked unavailable come after available ones, and the weighted score orders officers inside each group. The
first officer who is available and below capacity is flagged ``recommended``; automatic assignment picks
exactly that officer. Each candidate carries human-readable reasons explaining the ranking.

Workload numbers (one definition for the whole API)
---------------------------------------------------
``active``      complaints assigned to the officer whose status is in ``Complaint.OPEN_ASSIGNED_STATUSES``
                (assigned / accepted / in_progress / reopened) - counted by :func:`collect_officer_stats`
``capacity``    ``OfficerProfile.max_active_complaints``
``utilization`` active / capacity clamped to 0..1 (an officer with zero capacity counts as fully utilised)
``overloaded``  active > capacity

:func:`workload_figures` computes the last two; every endpoint that reports an officer's workload
(``/officers/``, ``/officers/{id}/workload/``, ``/assignments/recommend/``, ``/analytics/officers/``, the officer
dashboard and the AI analysis preview) takes its numbers from this module, so they always agree.
"""
import logging
import math
from dataclasses import dataclass

from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.complaints.models import Complaint, Level, StatusHistory
from apps.core.exceptions import ServiceError, TransitionNotAllowed
from apps.core.utils import haversine_m
from apps.departments.models import Department
from apps.feedback.models import Feedback
from apps.officers.models import OfficerProfile

from .models import ComplaintAssignment

logger = logging.getLogger("apps.assignments")

#: Factor weights (sum to 1). Critical complaints value a proven track record more than spare capacity.
DEFAULT_WEIGHTS = {"capacity": 0.40, "proximity": 0.25, "availability": 0.15, "track_record": 0.20}
CRITICAL_WEIGHTS = {"capacity": 0.30, "proximity": 0.25, "availability": 0.15, "track_record": 0.30}

PROXIMITY_SCALE_KM = 5.0  # exp(-d/5): 1.0 on site, ~0.37 at 5 km, ~0.14 at 10 km
UNKNOWN_PROXIMITY = 0.5  # neutral value when a location is missing
NEUTRAL_RATE = 0.5  # prior mean of the track-record rates
PRIOR_STRENGTH = 2.0  # pseudo-observations used for the Bayesian smoothing
GENERAL_DEPARTMENT_CODE = "GEN"
DEFAULT_CAPACITY = OfficerProfile._meta.get_field("max_active_complaints").default

# How a candidate's department relates to the complaint (routing-chain order).
PRIMARY, SECONDARY, GENERAL, OTHER = "primary", "secondary", "general", "other"

#: Statuses ``complete_active_assignment`` may close an assignment with.
CLOSING_STATUSES = (
    ComplaintAssignment.Status.COMPLETED,
    ComplaintAssignment.Status.REJECTED,
    ComplaintAssignment.Status.CANCELLED,
)


# ---------------------------------------------------------------------------------------------------------------
# Officer statistics
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class OfficerStats:
    """Facts about one officer's complaints, aggregated with a single GROUP BY query for all candidates."""

    active: int = 0  # open complaints assigned to the officer (= workload)
    critical: int = 0  # ... of which have critical priority
    resolved: int = 0  # resolved / verified / closed complaints
    rejected: int = 0  # complaints the officer rejected
    breached: int = 0  # open complaints already past their SLA due date
    rating_total: int = 0  # sum of citizen ratings (1-5) on the officer's complaints
    rating_count: int = 0

    @property
    def decided(self):
        """Complaints with a verdict on the officer's performance."""
        return self.resolved + self.rejected + self.breached

    @property
    def resolution_rate(self):
        """Bayesian-smoothed share of decided complaints that were resolved (0.5 without history)."""
        return (self.resolved + PRIOR_STRENGTH * NEUTRAL_RATE) / (self.decided + PRIOR_STRENGTH)

    @property
    def satisfaction(self):
        """Bayesian-smoothed average rating mapped from 1..5 to 0..1 (0.5 without ratings)."""
        normalised_total = (self.rating_total - self.rating_count) / 4.0
        return (normalised_total + PRIOR_STRENGTH * NEUTRAL_RATE) / (self.rating_count + PRIOR_STRENGTH)

    @property
    def track_record(self):
        return (self.resolution_rate + self.satisfaction) / 2.0

    @property
    def average_rating(self):
        return self.rating_total / self.rating_count if self.rating_count else None


def workload_figures(active, capacity):
    """``{"active", "capacity", "utilization", "overloaded"}`` - the workload numbers of one officer.

    ``utilization`` = active / capacity clamped to 0..1 (1.0 for an officer with zero capacity, who cannot take
    complaints); ``overloaded`` = more open complaints than the configured capacity (active > capacity).
    """
    active, capacity = max(0, int(active or 0)), max(0, int(capacity or 0))
    utilization = min(1.0, active / capacity) if capacity > 0 else 1.0
    return {"active": active, "capacity": capacity, "utilization": round(utilization, 3), "overloaded": active > capacity}


def profile_capacity(profile):
    """Workload capacity of an officer profile (the model default when the officer has no profile)."""
    return int(profile.max_active_complaints) if profile is not None else DEFAULT_CAPACITY


def collect_officer_stats(officer_ids):
    """``{officer_user_id: OfficerStats}`` for the given officers (two aggregate queries in total)."""
    stats = {officer_id: OfficerStats() for officer_id in officer_ids}
    if not stats:
        return stats
    ids = list(stats)
    open_assigned = Q(status__in=Complaint.OPEN_ASSIGNED_STATUSES)
    complaint_rows = (
        Complaint.objects.filter(assigned_officer_id__in=ids)
        .order_by()
        .values("assigned_officer_id")
        .annotate(
            active=Count("id", filter=open_assigned),
            critical=Count("id", filter=open_assigned & Q(priority_level=Level.CRITICAL)),
            resolved=Count("id", filter=Q(status__in=Complaint.RESOLVED_STATUSES)),
            rejected=Count("id", filter=Q(status=Complaint.Status.REJECTED)),
            breached=Count("id", filter=open_assigned & Q(sla_due_at__lt=timezone.now())),
        )
    )
    for row in complaint_rows:
        officer_stats = stats[row["assigned_officer_id"]]
        officer_stats.active = row["active"]
        officer_stats.critical = row["critical"]
        officer_stats.resolved = row["resolved"]
        officer_stats.rejected = row["rejected"]
        officer_stats.breached = row["breached"]
    rating_rows = (
        Feedback.objects.filter(complaint__assigned_officer_id__in=ids)
        .order_by()
        .values("complaint__assigned_officer_id")
        .annotate(total=Sum("rating"), count=Count("id"))
    )
    for row in rating_rows:
        officer_stats = stats[row["complaint__assigned_officer_id"]]
        officer_stats.rating_total = row["total"] or 0
        officer_stats.rating_count = row["count"]
    return stats


# ---------------------------------------------------------------------------------------------------------------
# Recommendation
# ---------------------------------------------------------------------------------------------------------------
def recommend_officers(complaint, *, limit=5):
    """Rank officers for a complaint by department match, workload/capacity, availability, distance and
    track record (priority-aware). Works for unsaved complaints too (used by AI previews).

    Returns (best first; ``limit=None`` returns every candidate)::

        [{"officer": <User>, "profile": <OfficerProfile>, "department": <Department|None>, "score": 0.83,
          "workload": 3, "capacity": 10, "utilization": 0.3, "overloaded": False, "distance_km": 2.4 | None,
          "is_available": True, "same_department": True, "at_capacity": False, "critical_active": 0,
          "components": {"capacity": 0.7, "proximity": 0.62, "availability": 1.0, "track_record": 0.5},
          "weights": {...}, "reasons": ["Roads Department officer", "3/10 active complaints", "2.4 km away", ...],
          "recommended": True}]
    """
    profiles = _active_officer_profiles()
    if not profiles:
        return []
    stats = collect_officer_stats([profile.user_id for profile in profiles])
    primary, chain = _routing_chain(complaint)
    pool = _candidate_pool(profiles, stats, chain)
    point = _complaint_point(complaint)
    weights = _weights_for(complaint)
    candidates = [
        _evaluate(complaint, profile, relation, stats[profile.user_id], point, weights, primary)
        for profile, relation in pool
    ]
    candidates.sort(key=_rank_key)
    best = next((candidate for candidate in candidates if _can_take_more(candidate)), None)
    if best is not None:
        best["recommended"] = True
    return candidates[:limit] if limit else candidates


def _active_officer_profiles():
    return list(
        OfficerProfile.objects.select_related("user", "department")
        .filter(user__is_active=True, user__role="officer")
        .order_by("user_id")
    )


def _routing_chain(complaint):
    """``(primary_department, [(Department, relation), ...])`` in fallback order (duplicates removed)."""
    category = complaint.category if complaint.category_id else None
    primary = complaint.department if complaint.department_id else None
    if primary is None and category is not None and category.department_id:
        primary = category.department
    chain = []
    if primary is not None:
        chain.append((primary, PRIMARY))
    if category is not None and category.secondary_department_id:
        chain.append((category.secondary_department, SECONDARY))
    general = Department.objects.filter(code__iexact=GENERAL_DEPARTMENT_CODE, is_active=True).first()
    if general is not None:
        chain.append((general, GENERAL))
    unique, seen = [], set()
    for department, relation in chain:
        if department.pk not in seen:
            seen.add(department.pk)
            unique.append((department, relation))
    return primary, unique


def _candidate_pool(profiles, stats, chain):
    """Walk the routing chain, adding each department's officers, until someone can take the complaint."""
    pool, seen = [], set()
    for department, relation in chain:
        for profile in profiles:
            if profile.department_id == department.pk and profile.user_id not in seen:
                seen.add(profile.user_id)
                pool.append((profile, relation))
        if any(_is_eligible(profile, stats[profile.user_id]) for profile, _ in pool):
            return pool
    pool.extend((profile, OTHER) for profile in profiles if profile.user_id not in seen)
    return pool


def _is_eligible(profile, officer_stats):
    return profile.is_available and officer_stats.active < profile.max_active_complaints


def _can_take_more(candidate):
    return candidate["is_available"] and not candidate["at_capacity"]


def _weights_for(complaint):
    return CRITICAL_WEIGHTS if complaint.priority_level == Level.CRITICAL else DEFAULT_WEIGHTS


def _complaint_point(complaint):
    """(lat, lng) of the complaint, or None when it has no usable location."""
    try:
        location = complaint.location
    except ObjectDoesNotExist:
        return None
    if location is None or location.latitude is None or location.longitude is None:
        return None
    return float(location.latitude), float(location.longitude)


def _distance_km(profile, point):
    if point is None or profile.base_latitude is None or profile.base_longitude is None:
        return None
    return haversine_m(point[0], point[1], profile.base_latitude, profile.base_longitude) / 1000.0


def _evaluate(complaint, profile, relation, officer_stats, point, weights, primary):
    """Score one candidate with the weighted-sum model and explain it."""
    figures = workload_figures(officer_stats.active, profile_capacity(profile))
    workload, capacity = figures["active"], figures["capacity"]
    at_capacity = workload >= capacity
    # an officer with zero capacity cannot take complaints
    capacity_factor = max(0.0, 1.0 - workload / capacity) if capacity > 0 else 0.0
    distance_km = _distance_km(profile, point)
    proximity = math.exp(-distance_km / PROXIMITY_SCALE_KM) if distance_km is not None else UNKNOWN_PROXIMITY
    components = {
        "capacity": capacity_factor,
        "proximity": proximity,
        "availability": 1.0 if profile.is_available else 0.0,
        "track_record": officer_stats.track_record,
    }
    score = sum(weights[key] * value for key, value in components.items())
    reasons = [
        _department_reason(profile, relation, complaint),
        _workload_reason(workload, capacity, at_capacity, officer_stats.critical),
        _distance_reason(distance_km, point, profile),
        "Available" if profile.is_available else "Marked unavailable",
        _track_record_reason(officer_stats),
    ]
    if complaint.assigned_officer_id and complaint.assigned_officer_id == profile.user_id:
        reasons.append("Currently assigned to this complaint")
    return {
        "officer": profile.user,
        "profile": profile,
        "department": profile.department,
        "score": round(score, 3),
        "workload": workload,
        "capacity": capacity,
        "utilization": figures["utilization"],
        "overloaded": figures["overloaded"],
        "distance_km": round(distance_km, 2) if distance_km is not None else None,
        "is_available": profile.is_available,
        "same_department": bool(primary is not None and profile.department_id == primary.pk),
        "at_capacity": at_capacity,
        "critical_active": officer_stats.critical,
        "components": {key: round(value, 3) for key, value in components.items()},
        "weights": dict(weights),
        "reasons": reasons,
        "recommended": False,
    }


def _rank_key(candidate):
    """Hard constraints first (capacity, availability), then the weighted score, then simple tie-breakers."""
    distance = candidate["distance_km"]
    return (
        candidate["at_capacity"],
        not candidate["is_available"],
        -candidate["score"],
        candidate["workload"],
        distance if distance is not None else math.inf,
        candidate["officer"].pk,
    )


def _department_reason(profile, relation, complaint):
    name = profile.department.name if profile.department_id else "No department"
    if relation == PRIMARY:
        return f"{name} officer"
    if relation == SECONDARY:
        return f"{name} officer (secondary department for {complaint.category.name})"
    if relation == GENERAL:
        return f"{name} officer (general fallback)"
    return f"{name} officer (outside the routed departments)"


def _workload_reason(workload, capacity, at_capacity, critical):
    text = f"At capacity: {workload}/{capacity} active complaints" if at_capacity else (
        f"{workload}/{capacity} active complaints"
    )
    if critical:
        text += f" ({critical} critical)"
    return text


def _distance_reason(distance_km, point, profile):
    if distance_km is None:
        return "Complaint location unknown" if point is None else "Base location not set"
    if distance_km < 1:
        return f"{round(distance_km * 1000)} m away"
    return f"{distance_km:.1f} km away"


def _track_record_reason(officer_stats):
    parts = []
    if officer_stats.decided:
        rate = officer_stats.resolved / officer_stats.decided
        parts.append(f"Resolution rate {rate:.0%} ({officer_stats.resolved} of {officer_stats.decided})")
    if officer_stats.rating_count:
        parts.append(f"avg rating {officer_stats.average_rating:.1f}/5 ({officer_stats.rating_count} ratings)")
    if not parts:
        return "No track record yet (neutral score)"
    text = ", ".join(parts)
    return text[0].upper() + text[1:]


def _evaluate_single(complaint, officer):
    """Score one specific officer for ``complaint`` (records how a manual choice compares). None without profile."""
    profile = OfficerProfile.objects.select_related("user", "department").filter(user_id=officer.pk).first()
    if profile is None:
        return None
    officer_stats = collect_officer_stats([profile.user_id])[profile.user_id]
    primary, chain = _routing_chain(complaint)
    relation = next((rel for department, rel in chain if department.pk == profile.department_id), OTHER)
    return _evaluate(
        complaint, profile, relation, officer_stats, _complaint_point(complaint), _weights_for(complaint), primary
    )


# ---------------------------------------------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------------------------------------------
def assign_officer(complaint, officer, *, assigned_by=None, assignment_type="auto", notes="", score=None,
                   reasons=None, notify=True, notify_citizen=True, request=None):
    """Assign (or reassign) ``officer`` (User with role officer). Deactivates the previous active assignment,
    sets complaint.assigned_officer, moves status to "assigned", records timeline + audit, notifies the
    officer / previous officer / citizen. Returns the new ComplaintAssignment.

    * ``assigned_by`` is the acting admin (``None`` = automatic assignment by the system).
    * Any assignment that replaces another officer is stored with type "reassignment"; the replaced active
      assignment becomes status "reassigned" / inactive.
    * When ``score``/``reasons`` are not given (manual choice) the officer is scored with the recommendation
      model so the history shows how the choice compares.
    * Timeline: one entry - event "officer_assigned" (or "reassigned") with metadata
      ``{officer_id, officer_name, score, ...}``. It is written by ``change_status(..., event=...)`` when the status
      moves to "assigned", or by ``add_event`` when the complaint is already "assigned".
    * Everything runs in one transaction with the complaint row locked, so two concurrent assignments cannot
      both create an active assignment.
    * ``notify_citizen=False`` leaves out the citizen's "Officer assigned" notice; the submission pipeline sends
      it itself (:func:`notify_citizen_of_assignment`) after "Complaint submitted", "AI analysis completed" and
      "Department assigned", so the citizen's feed follows the lifecycle order.

    Raises ServiceError (invalid officer, resolved complaint, officer already assigned) or TransitionNotAllowed
    (the actor may not move the complaint to "assigned" from its current status).
    """
    from apps.audit.services import log_action
    from apps.complaints.services import status as status_service

    _validate_officer(officer)
    if assignment_type not in ComplaintAssignment.Type.values:
        raise ServiceError(f"Unknown assignment type '{assignment_type}'.")
    label = complaint.complaint_number or "This complaint"

    with transaction.atomic():
        complaint.status = _lock_and_read_status(complaint)
        if complaint.status in Complaint.RESOLVED_STATUSES:
            raise ServiceError(
                f"{label} is already {complaint.get_status_display().lower()}; reopen it before assigning an "
                "officer."
            )
        active = list(ComplaintAssignment.objects.filter(complaint=complaint, is_active=True).select_related("officer"))
        if any(assignment.officer_id == officer.pk for assignment in active):
            raise ServiceError(f"{officer.full_name} is already assigned to {label}.")
        previous_officer = _previous_officer(complaint, active, officer)
        is_reassignment = previous_officer is not None or bool(active)

        needs_transition = complaint.status != Complaint.Status.ASSIGNED
        if needs_transition and not status_service.can_change_status(complaint, Complaint.Status.ASSIGNED,
                                                                     assigned_by):
            raise TransitionNotAllowed(
                f"An officer cannot be assigned while the complaint is {complaint.get_status_display().lower()}."
            )

        if score is None and reasons is None:
            evaluation = _evaluate_single(complaint, officer)
            if evaluation is not None:
                score, reasons = evaluation["score"], evaluation["reasons"]

        now = timezone.now()
        for previous in active:
            previous.status = ComplaintAssignment.Status.REASSIGNED
            previous.is_active = False
            previous.completed_at = now
            previous.save(update_fields=["status", "is_active", "completed_at"])

        if is_reassignment:
            assignment_type = ComplaintAssignment.Type.REASSIGNMENT
        profile = getattr(officer, "officer_profile", None)
        officer_department = profile.department if profile is not None and profile.department_id else None
        assignment = ComplaintAssignment.objects.create(
            complaint=complaint,
            officer=officer,
            department=officer_department or complaint.department,
            assigned_by=assigned_by,
            assignment_type=assignment_type,
            recommendation_score=score,
            recommendation_reasons=list(reasons or []),
            notes=notes or "",
            assigned_at=now,
        )

        complaint.assigned_officer = officer
        update_fields = ["assigned_officer", "updated_at"]
        if not complaint.department_id and officer_department is not None:
            complaint.department = officer_department
            update_fields.append("department")
        complaint.save(update_fields=update_fields)

        event = StatusHistory.Event.REASSIGNED if is_reassignment else StatusHistory.Event.OFFICER_ASSIGNED
        metadata = {
            "officer_id": officer.pk,
            "officer_name": officer.full_name,
            "score": score,
            "assignment_id": assignment.pk,
            "assignment_type": str(assignment_type),
        }
        if previous_officer is not None:
            metadata["previous_officer_id"] = previous_officer.pk
            metadata["previous_officer_name"] = previous_officer.full_name
        remarks = _timeline_remarks(officer, officer_department, assigned_by, score, previous_officer)
        if needs_transition:
            status_service.change_status(
                complaint, Complaint.Status.ASSIGNED, actor=assigned_by, remarks=remarks, event=event,
                metadata=metadata, notify=False,
            )
        else:
            status_service.add_event(complaint, event, actor=assigned_by, remarks=remarks, metadata=metadata)

        if notify:
            _notify_assignment(complaint, officer, previous_officer, is_reassignment, notify_citizen=notify_citizen)

        log_action(
            assigned_by,
            "reassign" if is_reassignment else "assign",
            entity=complaint,
            description=_audit_description(label, officer, assigned_by, score, previous_officer),
            changes={
                "assigned_officer": [previous_officer.pk if previous_officer else None, officer.pk],
                "assignment_id": assignment.pk,
                "assignment_type": str(assignment_type),
                "recommendation_score": score,
            },
            request=request,
        )
    return assignment


def auto_assign(complaint, *, notify_citizen=True):
    """Assign the top recommended officer (if any). Returns ComplaintAssignment | None.

    The officer is the one ``recommend_officers`` flags ``recommended`` (available and below capacity); the
    assignment has type "auto" and ``assigned_by=None``. Returns None when no officer can take the complaint or
    the system may not move it to "assigned" from its current status. An existing active assignment is returned
    unchanged - automatic assignment never overrides an earlier decision. Whether auto-assignment is enabled
    (``AIConfiguration.auto_assign_officer``) is decided by the caller.
    """
    from apps.complaints.services import status as status_service

    current = ComplaintAssignment.objects.filter(complaint=complaint, is_active=True).first()
    if current is not None:
        return current
    if complaint.status != Complaint.Status.ASSIGNED and not status_service.can_change_status(
        complaint, Complaint.Status.ASSIGNED, None
    ):
        logger.info("Complaint %s is '%s'; automatic assignment skipped", complaint.pk, complaint.status)
        return None
    candidates = recommend_officers(complaint, limit=1)
    if not candidates or not candidates[0]["recommended"]:
        logger.info("No available officer with spare capacity for complaint %s", complaint.pk)
        return None
    best = candidates[0]
    return assign_officer(
        complaint, best["officer"], assigned_by=None, assignment_type=ComplaintAssignment.Type.AUTO,
        score=best["score"], reasons=best["reasons"], notify_citizen=notify_citizen,
    )


def complete_active_assignment(complaint, *, status="completed"):
    """Close the active assignment (when resolved / rejected / closed).

    ``status`` is "completed" (resolved/closed), "rejected" or "cancelled". The assignment becomes inactive with
    ``completed_at`` = now; the complaint keeps its ``assigned_officer`` for history. Returns the closed
    assignment, or None when the complaint had no active assignment.
    """
    if status not in CLOSING_STATUSES:
        raise ValueError(f"status must be one of {', '.join(CLOSING_STATUSES)}; got {status!r}")
    now = timezone.now()
    closed = list(ComplaintAssignment.objects.filter(complaint=complaint, is_active=True))
    for assignment in closed:
        assignment.status = status
        assignment.is_active = False
        assignment.completed_at = now
        assignment.save(update_fields=["status", "is_active", "completed_at"])
    return closed[0] if closed else None


def officer_workload(officer):
    """{"active": int, "capacity": int, "utilization": 0..1, "overloaded": bool, "critical": int,
    "by_status": {status: n}}

    ``officer`` is the officer's User (or OfficerProfile). ``active`` and ``critical`` are the
    :func:`collect_officer_stats` counts (the same numbers the officer list and the recommender use);
    ``by_status`` lists every open-assigned status (assigned / accepted / in_progress / reopened), zeros
    included, so the shape is stable for charts.
    """
    if isinstance(officer, OfficerProfile):
        user_id, profile = officer.user_id, officer
    else:
        user_id, profile = officer.pk, getattr(officer, "officer_profile", None)
    officer_stats = collect_officer_stats([user_id])[user_id]
    counts = dict(
        Complaint.objects.filter(assigned_officer_id=user_id, status__in=Complaint.OPEN_ASSIGNED_STATUSES)
        .order_by().values_list("status").annotate(total=Count("id"))
    )
    return {
        **workload_figures(officer_stats.active, profile_capacity(profile)),
        "critical": officer_stats.critical,
        "by_status": {str(status): counts.get(str(status), 0) for status in Complaint.OPEN_ASSIGNED_STATUSES},
    }


# ---------------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------------
def _validate_officer(officer):
    if officer is None or getattr(officer, "role", None) != "officer":
        raise ServiceError("Only users with the officer role can be assigned to complaints.")
    if not officer.is_active:
        raise ServiceError(f"{officer.full_name}'s account is deactivated; choose an active officer.")


def _lock_and_read_status(complaint):
    """Row-lock the complaint (SELECT ... FOR UPDATE on MySQL) so concurrent assignments are serialised, and
    return its committed status - decisions are never taken on a stale in-memory copy."""
    return Complaint.objects.select_for_update().values_list("status", flat=True).get(pk=complaint.pk)


def _previous_officer(complaint, active_assignments, new_officer):
    """The officer the complaint moves away from (None for a first assignment or a re-activation)."""
    if active_assignments:
        return active_assignments[0].officer
    if complaint.assigned_officer_id and complaint.assigned_officer_id != new_officer.pk:
        return complaint.assigned_officer
    return None


def _timeline_remarks(officer, department, assigned_by, score, previous_officer):
    target = officer.full_name + (f" ({department.name})" if department is not None else "")
    if previous_officer is not None:
        text = f"Reassigned from {previous_officer.full_name} to {target}."
    elif assigned_by is None:
        text = f"Automatically assigned to {target}."
    else:
        text = f"Assigned to {target}."
    if assigned_by is None and score is not None:
        text += f" Recommendation score {score:.2f}."
    return text


def _audit_description(label, officer, assigned_by, score, previous_officer):
    if previous_officer is not None:
        return f"Reassigned {label} from {previous_officer.full_name} to {officer.full_name}"
    if assigned_by is None:
        suffix = f" (score {score:.2f})" if score is not None else ""
        return f"Auto-assigned {label} to {officer.full_name}{suffix}"
    return f"Assigned {label} to {officer.full_name}"


def _complaint_subject(complaint):
    if complaint.title:
        return complaint.title
    if complaint.category_id:
        return complaint.category.name
    return complaint.complaint_number or "A complaint"


def notify_citizen_of_assignment(complaint, officer, *, is_reassignment=False):
    """The citizen's "Officer assigned to your complaint" notice (also sent by the submission pipeline)."""
    from apps.notifications.services import notify

    profile = getattr(officer, "officer_profile", None)
    department = profile.department if profile is not None and profile.department_id else None
    number = complaint.complaint_number or f"Complaint #{complaint.pk}"
    handler = officer.full_name + (f" ({department.name})" if department is not None else "")
    return notify(
        complaint.citizen,
        title="New officer assigned to your complaint" if is_reassignment else "Officer assigned to your complaint",
        message=f"{handler} will handle {number}: {_complaint_subject(complaint)}.",
        notification_type="officer_assigned", complaint=complaint,
    )


def _notify_assignment(complaint, officer, previous_officer, is_reassignment, *, notify_citizen=True):
    """Notifications matrix (section 3.3): officer, previous officer, citizen, critical alert."""
    from apps.notifications.services import notify

    number = complaint.complaint_number or f"Complaint #{complaint.pk}"
    subject = _complaint_subject(complaint)
    priority = ""
    if complaint.priority_level:
        priority = f" Priority: {complaint.get_priority_level_display()} ({complaint.priority_score}/100)."

    if is_reassignment:
        notify(
            officer, title=f"Complaint reassigned to you: {number}",
            message=f"{subject} ({number}) has been reassigned to you.{priority}",
            notification_type="reassignment", complaint=complaint,
        )
    else:
        notify(
            officer, title=f"New complaint assigned: {number}",
            message=f"{subject} ({number}) has been assigned to you.{priority}",
            notification_type="new_assignment", complaint=complaint,
        )
    if previous_officer is not None:
        notify(
            previous_officer, title=f"Complaint reassigned: {number}",
            message=f"{number} has been reassigned to {officer.full_name}. No further action is needed from you.",
            notification_type="reassignment", complaint=complaint,
        )
    if notify_citizen:
        notify_citizen_of_assignment(complaint, officer, is_reassignment=is_reassignment)
    if complaint.priority_level == Level.CRITICAL:
        notify(
            officer, title=f"Critical complaint: {number}",
            message=f"{subject} has critical priority ({complaint.priority_score}/100). Please attend to it "
                    "immediately.",
            notification_type="critical_complaint", complaint=complaint,
        )
