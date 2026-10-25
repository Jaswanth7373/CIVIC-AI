"""Notification matrix of the complaint lifecycle (BUILD_SPEC section 3.3).

Who is told what:
    citizen   complaint_submitted, ai_analysis_completed, department_assigned, status_changed,
              complaint_resolved, resolution_verified, feedback_requested, duplicate_detected, officer_assigned
              (sent by apps.assignments; for a new complaint the pipeline sends it after the other three)
    officer   critical_complaint (their complaint became critical), complaint_reopened, verification outcomes
    admins    critical_complaint (every new critical complaint, once), high_priority_unresolved (SLA task),
              manual_review_requested, complaint_reopened, system (AI analysis failures)

Every function is a *safe* wrapper around ``apps.notifications.services`` (owner B4): the import is lazy (no
circular imports between apps), the call runs inside a savepoint via ``run_side_effect`` and nothing here ever
raises - a notification problem can never undo or block the business action that triggered it. Each function
returns the number of notifications created.
"""
from django.db.models import Q

from .helpers import complaint_subject, run_side_effect

CRITICAL_COMPLAINT = "critical_complaint"


def _count(result):
    if isinstance(result, bool):
        return int(result)
    if isinstance(result, int):
        return result
    if isinstance(result, (list, tuple, set)):
        return len(result)
    return 1 if result else 0


def notify_user(user, *, notification_type, title, message, complaint=None, level=None):
    """One in-app notification for ``user`` (None is ignored). Returns 1 when created, else 0."""
    if user is None:
        return 0

    def _send():
        from apps.notifications.services import notify

        return notify(user, title=title, message=message, notification_type=notification_type,
                      complaint=complaint, level=level)

    effect = run_side_effect(f"'{notification_type}' notification for user {user.pk}", _send)
    return _count(effect.result) if effect.ok else 0


def notify_admins(*, notification_type, title, message, complaint=None, level=None):
    """Notify every active administrator. Returns how many notifications were created."""

    def _send():
        from apps.notifications.services import notify_admins as notify_all_admins

        return notify_all_admins(title=title, message=message, notification_type=notification_type,
                                 complaint=complaint, level=level)

    effect = run_side_effect(f"'{notification_type}' notification for administrators", _send)
    return _count(effect.result) if effect.ok else 0


def notify_citizen(complaint, *, notification_type, title, message, level=None, actor=None):
    """Notify the citizen who reported ``complaint`` - unless the citizen performed the action themselves."""
    citizen = complaint.citizen
    if actor is not None and citizen is not None and actor.pk == citizen.pk:
        return 0
    return notify_user(citizen, notification_type=notification_type, title=title, message=message,
                       complaint=complaint, level=level)


def notify_assigned_officer(complaint, *, notification_type, title, message, level=None, actor=None):
    """Notify the officer assigned to ``complaint`` (if any, and if they are not the actor)."""
    if not complaint.assigned_officer_id:
        return 0
    officer = complaint.assigned_officer
    if actor is not None and actor.pk == officer.pk:
        return 0
    return notify_user(officer, notification_type=notification_type, title=title, message=message,
                       complaint=complaint, level=level)


def notify_officer_assigned(complaint, officer):
    """The citizen's "Officer assigned to your complaint" notice (wording owned by apps.assignments)."""

    def _send():
        from apps.assignments.services import notify_citizen_of_assignment

        return notify_citizen_of_assignment(complaint, officer)

    effect = run_side_effect(f"'officer_assigned' notification for complaint {complaint.pk}", _send)
    return _count(effect.result) if effect.ok else 0


def already_notified(complaint, notification_type, *, user=None, admins=False, since=None):
    """True when a notification of this type about ``complaint`` already exists (optionally for one user, for
    administrators only, or created after ``since``). Used to send one-off alerts exactly once."""
    from apps.notifications.models import Notification

    queryset = Notification.objects.filter(complaint=complaint, notification_type=notification_type)
    if user is not None:
        queryset = queryset.filter(user=user)
    if admins:
        queryset = queryset.filter(Q(user__role="admin") | Q(user__is_superuser=True))
    if since is not None:
        queryset = queryset.filter(created_at__gte=since)
    return queryset.exists()


def notify_critical(complaint):
    """Critical-priority alert: administrators once per complaint, plus the assigned officer once.

    Deduplicated through the existing Notification rows, so recalculations that keep a complaint critical (or
    the officer alert already sent at assignment time) never repeat the alert.
    """
    number = complaint.complaint_number
    message = f"{complaint_subject(complaint)} ({number}) has critical priority ({complaint.priority_score}/100)."
    sent = 0
    if not already_notified(complaint, CRITICAL_COMPLAINT, admins=True):
        sent += notify_admins(notification_type=CRITICAL_COMPLAINT, title=f"Critical complaint {number}",
                              message=message, complaint=complaint, level="critical")
    if complaint.assigned_officer_id and not already_notified(
        complaint, CRITICAL_COMPLAINT, user=complaint.assigned_officer
    ):
        sent += notify_user(complaint.assigned_officer, notification_type=CRITICAL_COMPLAINT,
                            title=f"Your complaint {number} is critical",
                            message=f"{message} Please attend to it immediately.",
                            complaint=complaint, level="critical")
    return sent
