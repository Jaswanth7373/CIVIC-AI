"""SLA breach monitoring (BUILD_SPEC section 3.6) - run hourly by Celery beat or ``manage.py check_sla``.

A complaint breaches its service level when it is still open (pending or in progress), its priority is high or
critical, and either its SLA due date has passed or it has been open longer than
``AIConfiguration.sla_alert_hours``. The SLA due date itself comes from ``Complaint.compute_sla_due()``: the
category SLA (else the department SLA), halved for critical and cut to 75 % for high priority.

Each breaching complaint alerts the administrators and the assigned officer with a ``high_priority_unresolved``
notification - at most once per complaint per 24 hours. The de-duplication reads the existing Notification rows,
so it also holds across restarts and between the Celery task and the management command.
"""
from datetime import timedelta

from django.db.models import Q
from django.utils import timezone

from ..models import Complaint, Level
from . import notify as notifications
from .helpers import complaint_subject, format_duration

ALERT_TYPE = "high_priority_unresolved"
ALERT_COOLDOWN = timedelta(hours=24)


def find_sla_breaches(now=None):
    """QuerySet of open high/critical complaints past their SLA due date or older than sla_alert_hours."""
    from apps.core.models import AIConfiguration

    now = now or timezone.now()
    alert_after = timedelta(hours=AIConfiguration.load().sla_alert_hours)
    return (
        Complaint.objects.filter(status__in=Complaint.OPEN_STATUSES, priority_level__in=[Level.HIGH, Level.CRITICAL])
        .filter(Q(sla_due_at__lt=now) | Q(created_at__lt=now - alert_after))
        .select_related("location", "category", "assigned_officer", "department")
        .order_by("-priority_score", "created_at")
    )


def check_sla_breaches(*, dry_run=False, now=None):
    """Alert admins + the assigned officer about each breaching complaint (once per complaint per 24 h).

    Returns the number of complaints alerted (with ``dry_run``: the number that would be alerted).
    """
    from apps.notifications.models import Notification

    now = now or timezone.now()
    breaches = list(find_sla_breaches(now))
    recently_alerted = set(
        Notification.objects.filter(
            notification_type=ALERT_TYPE, created_at__gte=now - ALERT_COOLDOWN,
            complaint_id__in=[complaint.pk for complaint in breaches],
        ).values_list("complaint_id", flat=True)
    )
    due = [complaint for complaint in breaches if complaint.pk not in recently_alerted]
    if dry_run:
        return len(due)
    alerted = 0
    for complaint in due:
        title, message, level = _alert_text(complaint, now)
        sent = notifications.notify_admins(notification_type=ALERT_TYPE, title=title, message=message,
                                           complaint=complaint, level=level)
        sent += notifications.notify_assigned_officer(complaint, notification_type=ALERT_TYPE, title=title,
                                                      message=message, level=level)
        if sent:
            alerted += 1
    return alerted


def _hours_between(start, end):
    return max(0.0, (end - start).total_seconds() / 3600.0)


def _alert_text(complaint, now):
    """Title, message and level of a ``high_priority_unresolved`` alert, e.g.

    "Overdue high-priority complaint: CIV-2026-000574" - "High priority complaint CIV-2026-000574 (Garbage / Waste
    near Clock Tower, Secunderabad) was due 26 Sep 03:00 (21 d 16 h overdue) and has been open for 23 d 4 h;
    status: Assigned. Assigned to Ravi Kumar." Durations use the UI's "d / h" style and the place is never
    repeated (it is part of the automatic title)."""
    number = complaint.complaint_number
    overdue = complaint.sla_due_at is not None and complaint.sla_due_at < now
    level_label = complaint.get_priority_level_display()
    open_for = format_duration(_hours_between(complaint.created_at, now))
    handler = (f"Assigned to {complaint.assigned_officer.full_name}." if complaint.assigned_officer_id
               else "No officer assigned yet.")
    if overdue:
        title = f"Overdue {level_label.lower()}-priority complaint: {number}"
        late = format_duration(max(1.0, _hours_between(complaint.sla_due_at, now)))
        timing = (f"was due {timezone.localtime(complaint.sla_due_at):%d %b %H:%M} ({late} overdue) and "
                  f"has been open for {open_for}")
    else:
        title = f"High-priority complaint unresolved: {number}"
        timing = f"has been open for {open_for}"
    message = (f"{level_label} priority complaint {number} ({complaint_subject(complaint)}) {timing}; "
               f"status: {complaint.get_status_display()}. {handler}")
    level = "critical" if complaint.priority_level == Level.CRITICAL or overdue else "warning"
    return title, message, level
