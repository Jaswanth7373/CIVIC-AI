"""Complaint lifecycle: transitions, timeline events, allowed actions (BUILD_SPEC section 3.2).

The lifecycle is a **finite-state machine**. ``TRANSITIONS`` lists every legal edge
``(from_status, to_status)`` together with the roles allowed to take it::

    submitted -> analyzed -> assigned -> accepted -> in_progress -> resolved -> verified -> closed
                                 \\-> rejected                         \\-> reopened -> accepted / in_progress

Roles are resolved *relative to the complaint*: ``system`` (actor None - the AI pipeline, Celery tasks),
``assigned_officer`` (the officer the complaint is assigned to), ``citizen_owner`` (the citizen who reported
it) and ``admin`` - administrators may perform any transition. Every change is validated here, whatever the
entry point (REST view, assignment service, feedback service, AI verification), so the rules live in one place.

``change_status`` is the single write path. Inside one transaction (with the complaint row locked by
``SELECT ... FOR UPDATE`` so two officers cannot race) it re-reads the current status, validates the edge, sets
the lifecycle timestamps, writes the ``StatusHistory`` timeline row and does the assignment bookkeeping; then it
applies the consequences of the new state (reopen -> priority recalculation, verified -> civic points) and
sends the notifications of the matrix (section 3.3).
"""
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from apps.core.exceptions import ServiceError, TransitionNotAllowed
from apps.core.permissions import user_role

from ..models import Complaint, DuplicateComplaint, ResolutionEvidence, StatusHistory
from . import notify as notifications
from .helpers import (
    VERIFIED_RESOLUTION_POINTS,
    award_civic_points,
    json_safe,
    normalize_actor,
    run_side_effect,
    save_fields,
)

S = Complaint.Status
Event = StatusHistory.Event

# Roles relative to a complaint
SYSTEM = "system"
ADMIN = "admin"
ASSIGNED_OFFICER = "assigned_officer"
OFFICER = "officer"  # an officer the complaint is NOT assigned to
CITIZEN_OWNER = "citizen_owner"
CITIZEN = "citizen"  # a citizen who did not report the complaint

#: Legal lifecycle edges -> roles allowed to take them (administrators may take any edge).
TRANSITIONS = {
    (S.SUBMITTED, S.ANALYZED): {SYSTEM},
    (S.ANALYZED, S.ASSIGNED): {SYSTEM},
    (S.REOPENED, S.ASSIGNED): {SYSTEM},
    (S.ASSIGNED, S.ASSIGNED): {SYSTEM},  # reassignment keeps the status
    (S.ASSIGNED, S.ACCEPTED): {ASSIGNED_OFFICER},
    (S.REOPENED, S.ACCEPTED): {ASSIGNED_OFFICER},
    (S.REOPENED, S.IN_PROGRESS): {ASSIGNED_OFFICER},
    (S.ASSIGNED, S.REJECTED): {ASSIGNED_OFFICER},
    (S.ACCEPTED, S.REJECTED): {ASSIGNED_OFFICER},
    (S.ACCEPTED, S.IN_PROGRESS): {ASSIGNED_OFFICER},
    (S.IN_PROGRESS, S.RESOLVED): {ASSIGNED_OFFICER},
    (S.ACCEPTED, S.RESOLVED): {ASSIGNED_OFFICER},
    (S.RESOLVED, S.VERIFIED): {SYSTEM, ASSIGNED_OFFICER},  # AI likely_resolved + auto-verify, or manual verification
    (S.RESOLVED, S.IN_PROGRESS): {SYSTEM},  # resolution rejected by (manual) verification
    (S.RESOLVED, S.REOPENED): {CITIZEN_OWNER},
    (S.VERIFIED, S.REOPENED): {CITIZEN_OWNER},
    (S.CLOSED, S.REOPENED): {CITIZEN_OWNER},
    (S.VERIFIED, S.CLOSED): {SYSTEM},  # after citizen feedback
    (S.RESOLVED, S.CLOSED): {SYSTEM},
}

#: Timeline event recorded for a status change (others use "status_changed" unless the caller passes one).
STATUS_EVENTS = {
    S.ACCEPTED: Event.ACCEPTED,
    S.IN_PROGRESS: Event.IN_PROGRESS,
    S.RESOLVED: Event.RESOLVED,
    S.VERIFIED: Event.VERIFIED,
    S.CLOSED: Event.CLOSED,
    S.REJECTED: Event.REJECTED,
    S.REOPENED: Event.REOPENED,
}

#: Transitions that must be justified with remarks.
REMARKS_REQUIRED = {S.REJECTED: "rejecting", S.RESOLVED: "resolving", S.REOPENED: "reopening"}

#: Canonical order of the action keys returned by ``get_allowed_actions`` (API contract).
ACTION_KEYS = [
    "edit", "delete", "accept", "reject", "start_work", "upload_evidence", "resolve", "verify", "manual_verify",
    "request_manual_review", "reopen", "feedback", "assign", "reassign", "override_ai", "reanalyze",
    "review_duplicates", "add_remark", "close",
]

CITIZEN_EDITABLE_STATUSES = (S.SUBMITTED, S.ANALYZED, S.ASSIGNED)
EVIDENCE_STATUSES = (S.ACCEPTED, S.IN_PROGRESS, S.RESOLVED)
REOPENABLE_STATUSES = (S.RESOLVED, S.VERIFIED, S.CLOSED)
FEEDBACK_STATUSES = (S.RESOLVED, S.VERIFIED)

_ROLE_NAMES = {
    SYSTEM: "the system",
    ASSIGNED_OFFICER: "the assigned officer",
    CITIZEN_OWNER: "the citizen who reported it",
}


def status_label(value):
    """Display label of a status ("in_progress" -> "In Progress")."""
    try:
        return S(value).label
    except ValueError:
        return str(value)


def status_phrase(value):
    """Status label for use inside a sentence: lower case except acronyms ("AI Analyzed" -> "AI analyzed")."""
    return " ".join(word if word.isupper() else word.lower() for word in status_label(value).split())


# ---------------------------------------------------------------------------------------------------------------
# Roles, reopen window, cycle helpers
# ---------------------------------------------------------------------------------------------------------------
def actor_role(complaint, user):
    """Role of ``user`` relative to ``complaint`` (None = the system; unknown/anonymous users get None)."""
    if user is None:
        return SYSTEM
    role = user_role(user)
    if role == "admin":
        return ADMIN
    if role == "officer":
        return ASSIGNED_OFFICER if complaint.assigned_officer_id == user.pk else OFFICER
    if role == "citizen":
        return CITIZEN_OWNER if complaint.citizen_id == user.pk else CITIZEN
    return None


def reopen_window_days():
    return int(settings.CIVICAI.get("REOPEN_WINDOW_DAYS", 14))


def reopen_deadline(complaint):
    """Last moment the citizen may reopen (resolved_at + REOPEN_WINDOW_DAYS), or None if never resolved."""
    if complaint.resolved_at is None:
        return None
    return complaint.resolved_at + timedelta(days=reopen_window_days())


def last_reopened_at(complaint):
    """Timestamp of the most recent reopen (start of the current resolution cycle), or None."""
    if not complaint.reopen_count:
        return None
    return (
        StatusHistory.objects.filter(complaint=complaint, event=Event.REOPENED)
        .order_by("-timestamp", "-id").values_list("timestamp", flat=True).first()
    )


def feedback_given_this_cycle(complaint):
    """True when the citizen already gave feedback after the last reopen (or ever, if never reopened)."""
    from apps.feedback.models import Feedback

    queryset = Feedback.objects.filter(complaint=complaint)
    since = last_reopened_at(complaint)
    if since is not None:
        queryset = queryset.filter(created_at__gt=since)
    return queryset.exists()


def has_pending_duplicates(complaint):
    return DuplicateComplaint.objects.filter(
        Q(complaint=complaint) | Q(similar_complaint=complaint), status=DuplicateComplaint.Status.PENDING_REVIEW
    ).exists()


def officer_can_override_verification(complaint):
    """May the assigned officer record a manual verification now?

    While the complaint is "resolved", and also after an *AI-assisted* verification moved it to "verified": the
    AI result carries the promise "officers and admins can override the result", so the officer can still
    correct it (e.g. send the work back) until the complaint is closed. A verification a person made (an
    administrator's manual decision) is not the officer's to overrule.
    """
    from ..models import ResolutionVerification

    if complaint.status == S.RESOLVED:
        return True
    if complaint.status != S.VERIFIED:
        return False
    latest = complaint.latest_verification
    return latest is not None and latest.method == ResolutionVerification.Method.AI_ASSISTED


def has_current_after_image(complaint):
    """An after photo exists for the current resolution cycle (uploaded after the last reopen)."""
    queryset = ResolutionEvidence.objects.filter(complaint=complaint).exclude(
        Q(after_image__isnull=True) | Q(after_image="")
    )
    since = last_reopened_at(complaint)
    if since is not None:
        queryset = queryset.filter(uploaded_at__gt=since)
    return queryset.exists()


def _officer_department_id(user):
    try:
        return user.officer_profile.department_id
    except ObjectDoesNotExist:
        return None


# ---------------------------------------------------------------------------------------------------------------
# Transition validation
# ---------------------------------------------------------------------------------------------------------------
def transition_error(complaint, new_status, user):
    """Why ``user`` may not move ``complaint`` to ``new_status`` right now (None when it is allowed)."""
    old_status = complaint.status
    if new_status not in S.values:
        return f"Unknown status '{new_status}'."
    role = actor_role(complaint, user)
    if role is None:
        return "You are not allowed to change the status of this complaint."
    edge = (old_status, new_status)
    if old_status == new_status and edge not in TRANSITIONS:
        return f"The complaint is already {status_phrase(new_status)}."
    if role == ADMIN:
        return None
    allowed = TRANSITIONS.get(edge)
    if not allowed:
        return (f"A complaint cannot move from {status_phrase(old_status)} to "
                f"{status_phrase(new_status)}.")
    if role not in allowed:
        who = " or ".join(_ROLE_NAMES[name] for name in sorted(allowed)) + " (or an administrator)"
        return (f"Only {who} can move this complaint from {status_phrase(old_status)} to "
                f"{status_phrase(new_status)}.")
    if role == CITIZEN_OWNER and new_status == S.REOPENED:
        deadline = reopen_deadline(complaint)
        if deadline is None:
            return "This complaint was never resolved, so it cannot be reopened."
        if timezone.now() > deadline:
            return (f"Complaints can only be reopened within {reopen_window_days()} days of being resolved; "
                    f"this window closed on {timezone.localtime(deadline):%d %b %Y}.")
    return None


def can_change_status(complaint, new_status, user):
    """True if ``user`` (None = system) may move ``complaint`` to ``new_status``."""
    return transition_error(complaint, new_status, user) is None


# ---------------------------------------------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------------------------------------------
def add_event(complaint, event, *, actor=None, remarks="", metadata=None, old_status=None, new_status=None,
              is_public=True, timestamp=None):
    """Append a StatusHistory row (timeline event) without changing the status. Returns StatusHistory.

    ``old_status`` / ``new_status`` stay blank for events that are not status changes. ``actor=None`` shows as
    "CivicAI Engine" (system) on the timeline; ``is_public=False`` hides the entry from the citizen.
    """
    event = str(event)
    if event not in Event.values:
        raise ValueError(f"Unknown timeline event '{event}'.")
    return StatusHistory.objects.create(
        complaint=complaint,
        event=event,
        old_status=old_status or "",
        new_status=new_status or "",
        changed_by=normalize_actor(actor),
        remarks=(remarks or "").strip(),
        metadata=json_safe(metadata or {}),
        is_public=bool(is_public),
        timestamp=timestamp or timezone.now(),
    )


# ---------------------------------------------------------------------------------------------------------------
# The single write path
# ---------------------------------------------------------------------------------------------------------------
def change_status(complaint, new_status, *, actor=None, remarks="", event=None, metadata=None, notify=True,
                  force=False, request=None):
    """Validate + apply a status transition, set lifecycle timestamps, record StatusHistory, notify.

    Raises apps.core.exceptions.TransitionNotAllowed when not permitted. Returns StatusHistory.

    * ``event`` overrides the timeline event (e.g. "ai_analyzed", "officer_assigned"); by default the event
      matching the new status is used (accepted, in_progress, resolved, verified, closed, rejected, reopened)
      and "status_changed" otherwise.
    * ``notify=False`` suppresses the notifications sent here (the caller sends its own).
    * ``force=True`` skips the role table - only for service-level flows that already enforced their own rule
      (merging a confirmed duplicate, a manual verification sending the work back); the actor is still recorded.
    * Remarks are mandatory when rejecting, resolving or reopening.
    """
    new_status = str(new_status)
    if new_status not in S.values:
        raise ServiceError(f"Unknown status '{new_status}'.")
    if event is not None and str(event) not in Event.values:
        raise ValueError(f"Unknown timeline event '{event}'.")
    remarks = (remarks or "").strip()
    if new_status in REMARKS_REQUIRED and not remarks:
        raise ServiceError(f"Remarks are required when {REMARKS_REQUIRED[new_status]} a complaint.")

    with transaction.atomic():
        locked = (
            Complaint.objects.select_for_update().filter(pk=complaint.pk).values_list("status", "reopen_count").first()
        )
        if locked is None:
            raise ServiceError("This complaint no longer exists.")
        complaint.status, complaint.reopen_count = locked  # never act on a stale in-memory copy
        old_status = complaint.status
        if not force:
            reason = transition_error(complaint, new_status, actor)
            if reason:
                raise TransitionNotAllowed(reason)
        actor = normalize_actor(actor)
        now = timezone.now()
        save_fields(complaint, *_apply_status(complaint, new_status, now))
        history = StatusHistory.objects.create(
            complaint=complaint,
            event=str(event or STATUS_EVENTS.get(new_status, Event.STATUS_CHANGED)),
            old_status=old_status,
            new_status=new_status,
            changed_by=actor,
            remarks=remarks,
            metadata=json_safe(metadata or {}),
            is_public=True,
            timestamp=now,
        )
        _assignment_bookkeeping(complaint, new_status, now)
        if actor is not None:
            from apps.audit.services import log_action

            run_side_effect(
                "Audit log of a status change", log_action, actor, "status_change", entity=complaint,
                description=f"{complaint.complaint_number}: {old_status} -> {new_status}",
                changes={"status": [old_status, new_status]}, request=request,
            )
    _after_transition(complaint, old_status, new_status, actor=actor, remarks=remarks, notify=notify)
    return history


def _apply_status(complaint, new_status, now):
    """Set the new status plus its lifecycle timestamps / counters. Returns the changed field names."""
    complaint.status = new_status
    fields = ["status"]
    if new_status == S.ACCEPTED and complaint.accepted_at is None:
        complaint.accepted_at = now  # first acceptance is kept for response-time analytics
        fields.append("accepted_at")
    elif new_status == S.RESOLVED:
        complaint.resolved_at = now
        complaint.needs_manual_review = False  # a fresh resolution is judged by the next verification
        fields += ["resolved_at", "needs_manual_review"]
    elif new_status == S.VERIFIED:
        complaint.verified_at = now
        complaint.resolved_at = complaint.resolved_at or now
        complaint.needs_manual_review = False
        fields += ["verified_at", "resolved_at", "needs_manual_review"]
    elif new_status == S.CLOSED:
        complaint.closed_at = now
        fields.append("closed_at")
    elif new_status == S.REOPENED:
        complaint.reopen_count += 1
        complaint.resolved_at = complaint.verified_at = complaint.closed_at = None
        fields += ["reopen_count", "resolved_at", "verified_at", "closed_at"]
    return fields


def _assignment_bookkeeping(complaint, new_status, now):
    """Keep ComplaintAssignment in step with the complaint: stamp acceptance; close the active assignment when
    the work ends (resolved / closed -> completed, rejected -> rejected)."""
    from apps.assignments.models import ComplaintAssignment

    active = ComplaintAssignment.objects.filter(complaint=complaint, is_active=True)
    if new_status == S.ACCEPTED:
        active.filter(accepted_at__isnull=True).update(accepted_at=now)
    elif new_status in (S.RESOLVED, S.CLOSED, S.REJECTED) and active.exists():
        from apps.assignments.services import complete_active_assignment

        complete_active_assignment(complaint, status="rejected" if new_status == S.REJECTED else "completed")


def _after_transition(complaint, old_status, new_status, *, actor, remarks, notify):
    """Consequences of entering ``new_status`` (run after the status row is written)."""
    if new_status == S.REOPENED:
        from .priority import recalculate_priority

        run_side_effect("Priority recalculation after reopen", recalculate_priority, complaint,
                        trigger="reopened", notify=notify)
    if new_status == S.VERIFIED:
        run_side_effect("Civic points for a verified resolution", award_civic_points, complaint.citizen,
                        VERIFIED_RESOLUTION_POINTS)
    if notify:
        _notify_transition(complaint, old_status, new_status, actor=actor, remarks=remarks)


def _notify_transition(complaint, old_status, new_status, *, actor, remarks):
    number = complaint.complaint_number
    note = f" Remarks: {remarks}" if remarks else ""
    if new_status == S.RESOLVED:
        notifications.notify_citizen(
            complaint, notification_type="complaint_resolved", title="Complaint resolved",
            message=f"{number} has been marked as resolved by the field team.{note} The repair is now being "
                    "verified.", actor=actor,
        )
    elif new_status == S.VERIFIED:
        notifications.notify_citizen(
            complaint, notification_type="resolution_verified", title="Resolution verified",
            message=f"The resolution of {number} has been verified. Thank you for reporting it!", actor=actor,
        )
        notifications.notify_citizen(
            complaint, notification_type="feedback_requested", title="How did we do?",
            message=f"Please rate how {number} was handled - your feedback helps improve civic services.",
            actor=actor,
        )
    else:
        notifications.notify_citizen(
            complaint, notification_type="status_changed", title=f"Complaint {status_phrase(new_status)}",
            message=f"{number} is now {status_phrase(new_status)} (was {status_phrase(old_status)})."
                    f"{note}", actor=actor,
        )
    if new_status == S.REOPENED:
        message = f"{number} was reopened.{note}"
        notifications.notify_assigned_officer(
            complaint, notification_type="complaint_reopened", title=f"Complaint {number} reopened",
            message=f"{message} Please review it again.", actor=actor,
        )
        notifications.notify_admins(notification_type="complaint_reopened", title=f"Complaint {number} reopened",
                                    message=message, complaint=complaint)


# ---------------------------------------------------------------------------------------------------------------
# Allowed actions (drives the frontend buttons)
# ---------------------------------------------------------------------------------------------------------------
def get_allowed_actions(complaint, user):
    """List of action keys the user can perform now (drives the frontend buttons). See API contract."""
    if user is None or not getattr(user, "is_authenticated", False):
        return []
    role = actor_role(complaint, user)
    status = complaint.status
    actions = set()

    if role == CITIZEN_OWNER:
        if status in CITIZEN_EDITABLE_STATUSES and complaint.accepted_at is None:
            actions |= {"edit", "delete"}
        if status in FEEDBACK_STATUSES and not feedback_given_this_cycle(complaint):
            actions.add("feedback")
        if status in REOPENABLE_STATUSES and can_change_status(complaint, S.REOPENED, user):
            actions.add("reopen")

    elif role == ASSIGNED_OFFICER:
        for action, target in (("accept", S.ACCEPTED), ("reject", S.REJECTED), ("start_work", S.IN_PROGRESS),
                               ("resolve", S.RESOLVED)):
            if can_change_status(complaint, target, user):
                actions.add(action)
        if status in EVIDENCE_STATUSES:
            actions.add("upload_evidence")
        if status == S.RESOLVED:
            actions |= {"manual_verify", "request_manual_review"}
            if has_current_after_image(complaint):
                actions.add("verify")
        elif status == S.VERIFIED and officer_can_override_verification(complaint):
            actions.add("manual_verify")
        actions.add("add_remark")
        if has_pending_duplicates(complaint):
            actions.add("review_duplicates")

    elif role == OFFICER:
        department_id = _officer_department_id(user)
        if department_id is not None and department_id == complaint.department_id:
            actions.add("add_remark")
            if has_pending_duplicates(complaint):
                actions.add("review_duplicates")

    elif role == ADMIN:
        actions |= {"edit", "delete", "override_ai", "reanalyze", "add_remark"}
        if status in Complaint.OPEN_STATUSES:
            actions.add("reject")
            actions.add("reassign" if complaint.assigned_officer_id else "assign")
        if status in (S.ACCEPTED, S.IN_PROGRESS):
            actions.add("resolve")
        if status in EVIDENCE_STATUSES:
            actions.add("upload_evidence")
        if status == S.RESOLVED and has_current_after_image(complaint):
            actions.add("verify")
        if status in (S.RESOLVED, S.VERIFIED):
            actions |= {"manual_verify", "close"}
        if status in REOPENABLE_STATUSES + (S.REJECTED,):
            actions.add("reopen")
        if has_pending_duplicates(complaint):
            actions.add("review_duplicates")

    return [key for key in ACTION_KEYS if key in actions]


# ---------------------------------------------------------------------------------------------------------------
# Lifecycle actions (thin wrappers used by the REST views). Each returns the StatusHistory row it created.
# ---------------------------------------------------------------------------------------------------------------
def accept_complaint(complaint, *, actor, remarks="", request=None):
    """The assigned officer accepts the work order (assigned / reopened -> accepted)."""
    return change_status(complaint, S.ACCEPTED, actor=actor, remarks=remarks, request=request)


def start_work(complaint, *, actor, remarks="", request=None):
    """The assigned officer starts the field work (accepted / reopened -> in_progress)."""
    return change_status(complaint, S.IN_PROGRESS, actor=actor, remarks=remarks, request=request)


def reject_complaint(complaint, *, actor, remarks, request=None):
    """Reject an invalid / non-actionable complaint (assigned / accepted -> rejected; remarks required)."""
    return change_status(complaint, S.REJECTED, actor=actor, remarks=remarks, request=request)


def resolve_complaint(complaint, *, actor, remarks, after_image=None, request=None):
    """Mark resolved (optionally attaching an after image) and trigger AI verification when possible.

    The after photo is stored as resolution evidence in the same transaction as the status change. Then, when
    ``AIConfiguration.auto_verify_resolution`` is on and an after photo exists for this resolution cycle, the
    AI-assisted verification runs immediately (see ``verification.auto_verify_after_resolution``) and may move
    the complaint on to "verified". A verification problem never undoes the resolution - the complaint is then
    flagged for manual review instead.
    """
    from .verification import auto_verify_after_resolution, upload_evidence

    remarks = (remarks or "").strip()
    if not remarks:
        raise ServiceError(f"Remarks are required when {REMARKS_REQUIRED[S.RESOLVED]} a complaint.")
    reason = transition_error(complaint, S.RESOLVED, actor)
    if reason:
        raise TransitionNotAllowed(reason)
    with transaction.atomic():
        if after_image is not None:
            upload_evidence(complaint, actor=actor, after_image=after_image, remarks=remarks, request=request)
        history = change_status(complaint, S.RESOLVED, actor=actor, remarks=remarks, request=request)
    auto_verify_after_resolution(complaint)
    return history


def reopen_complaint(complaint, *, actor, reason, request=None):
    """Reopen a resolved / verified / closed complaint (citizen owner within the reopen window, or an admin).

    Consequences (applied by ``change_status``): reopen_count + 1, resolved/verified/closed timestamps cleared,
    priority recalculated with trigger "reopened", the assigned officer and the administrators notified.
    """
    return change_status(complaint, S.REOPENED, actor=actor, remarks=reason, request=request)


def close_complaint(complaint, *, actor, remarks="", request=None):
    """Close a resolved / verified complaint (administrators; the system closes after citizen feedback)."""
    return change_status(complaint, S.CLOSED, actor=actor, remarks=remarks, request=request)


def add_remark(complaint, *, actor, remarks, is_public=True):
    """Add a free-text remark to the timeline (assigned officer, an officer of the complaint's department, or an
    administrator). Returns the StatusHistory row (event "remark")."""
    remarks = (remarks or "").strip()
    if not remarks:
        raise ServiceError("Remarks cannot be empty.")
    role = actor_role(complaint, actor)
    department_id = _officer_department_id(actor) if role == OFFICER else None
    allowed = role in (ADMIN, ASSIGNED_OFFICER) or (
        department_id is not None and department_id == complaint.department_id
    )
    if not allowed:
        raise PermissionDenied("Only the assigned officer, its department or an administrator can add remarks.")
    return add_event(complaint, Event.REMARK, actor=actor, remarks=remarks, is_public=is_public)
