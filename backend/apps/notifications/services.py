"""In-app notification service (BUILD_SPEC section 3.3).

Every user-facing event in CivicAI (complaint submitted, officer assigned, complaint resolved, hotspot detected,
negative feedback ...) becomes a :class:`~apps.notifications.models.Notification` row that the React app shows in
the bell menu, on the dashboards and on the notifications page.

Design decisions (useful to explain in a viva):

* **Notifications are a side effect, never the main operation.**  ``notify`` therefore never raises: it validates
  its input, runs the INSERT inside its own savepoint (``transaction.atomic``) and logs any failure.  A broken
  notification can neither fail the request nor poison the caller's surrounding database transaction.
* **Role-aware deep links.**  Each role has its own complaint page in the frontend (``/citizen/complaints/12``,
  ``/officer/complaints/12``, ``/admin/complaints/12``), so the link is computed from the *recipient's* role.
* **Level from type.**  The colour/importance of a notification (info / success / warning / critical) defaults
  from its type, so every caller gets a consistent UI without repeating the mapping.
* **Inactive accounts are skipped** - deactivated users cannot log in, so notifying them only creates noise.
"""
import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.core.permissions import user_role

from .models import Notification

logger = logging.getLogger("apps.notifications")

#: Frontend route prefix of each role's complaint pages.
ROLE_ROUTE_PREFIXES = {"citizen": "/citizen", "officer": "/officer", "admin": "/admin"}

#: Default level per notification type; every type that is not listed defaults to "info".
DEFAULT_LEVELS = {
    Notification.Type.CRITICAL_COMPLAINT: Notification.Level.CRITICAL,
    Notification.Type.COMPLAINT_RESOLVED: Notification.Level.SUCCESS,
    Notification.Type.RESOLUTION_VERIFIED: Notification.Level.SUCCESS,
    Notification.Type.HIGH_PRIORITY_UNRESOLVED: Notification.Level.WARNING,
    Notification.Type.HOTSPOT_ALERT: Notification.Level.WARNING,
    Notification.Type.MANUAL_REVIEW_REQUESTED: Notification.Level.WARNING,
    Notification.Type.COMPLAINT_REOPENED: Notification.Level.WARNING,
}

_TITLE_MAX_LENGTH = Notification._meta.get_field("title").max_length
_LINK_MAX_LENGTH = Notification._meta.get_field("link").max_length


def complaint_link(complaint, role):
    """Frontend route for a complaint: /citizen/complaints/<id>, /officer/complaints/<id>, /admin/complaints/<id>.

    ``complaint`` may be a Complaint instance or its id. Returns "" when there is no complaint or the role is
    unknown (an empty link simply renders a notification without a "view" action).
    """
    complaint_id = getattr(complaint, "pk", complaint)
    prefix = ROLE_ROUTE_PREFIXES.get(str(role) if role else "")
    if not complaint_id or prefix is None:
        return ""
    return f"{prefix}/complaints/{complaint_id}"


def default_level(notification_type):
    """Level used when the caller does not choose one (see ``DEFAULT_LEVELS``)."""
    return str(DEFAULT_LEVELS.get(notification_type, Notification.Level.INFO))


def notify(user, *, title, message, notification_type, complaint=None, link="", level=None):
    """Create one in-app Notification for ``user`` and return it (or ``None`` when nothing was created).

    * Inactive or missing users are skipped.
    * ``link`` defaults to ``complaint_link(complaint, <recipient role>)``; superusers count as admins.
    * ``level`` defaults from the notification type (``default_level``); an unknown level falls back to it too.
    * An unknown ``notification_type`` is stored as "system" (and logged) instead of failing.
    * Never raises: errors are logged and ``None`` is returned. The INSERT runs in its own savepoint so a
      database error cannot break the caller's transaction.
    """
    if user is None or not getattr(user, "is_active", False):
        return None
    try:
        notification_type = _clean_type(notification_type)
        level = _clean_level(level, notification_type)
        complaint_id = getattr(complaint, "pk", complaint) or None
        if not link and complaint_id:
            link = complaint_link(complaint_id, user_role(user))
        with transaction.atomic():
            return Notification.objects.create(
                user=user,
                title=str(title or "")[:_TITLE_MAX_LENGTH],
                message=str(message or ""),
                notification_type=notification_type,
                level=level,
                complaint_id=complaint_id,
                link=str(link or "")[:_LINK_MAX_LENGTH],
            )
    except Exception:
        logger.exception(
            "Could not create a %r notification for user %s", notification_type, getattr(user, "pk", None)
        )
        return None


def notify_many(users, **kwargs):
    """``notify()`` each user once (duplicates and ``None`` entries are ignored). Returns the number created."""
    created = 0
    seen = set()
    for user in users:
        if user is None or user.pk in seen:
            continue
        seen.add(user.pk)
        if notify(user, **kwargs) is not None:
            created += 1
    return created


def notify_admins(**kwargs):
    """``notify()`` every active administrator (role "admin" or Django superuser). Returns the number created."""
    admins = (
        get_user_model().objects.filter(is_active=True)
        .filter(Q(role="admin") | Q(is_superuser=True))
        .order_by("pk")
    )
    return notify_many(admins, **kwargs)


def notify_department_officers(department, **kwargs):
    """``notify()`` every active officer of ``department`` (instance or id). Returns the number created."""
    department_id = getattr(department, "pk", department)
    if not department_id:
        return 0
    officers = get_user_model().objects.filter(
        is_active=True, role="officer", officer_profile__department_id=department_id
    ).order_by("pk")
    return notify_many(officers, **kwargs)


def mark_read(notification):
    """Mark one notification as read (idempotent: the first ``read_at`` is kept). Returns the notification."""
    if not notification.is_read:
        notification.is_read = True
        notification.read_at = timezone.now()
        notification.save(update_fields=["is_read", "read_at"])
    return notification


def mark_all_read(user):
    """Mark every unread notification of ``user`` as read. Returns how many rows changed."""
    return Notification.objects.filter(user=user, is_read=False).update(is_read=True, read_at=timezone.now())


def unread_count(user):
    """Number of unread notifications of ``user`` (drives the bell badge)."""
    return Notification.objects.filter(user=user, is_read=False).count()


def _clean_type(notification_type):
    value = str(notification_type or "")
    if value in Notification.Type.values:
        return value
    logger.warning("Unknown notification type %r - stored as 'system'", notification_type)
    return str(Notification.Type.SYSTEM)


def _clean_level(level, notification_type):
    if level is None:
        return default_level(notification_type)
    value = str(level)
    if value in Notification.Level.values:
        return value
    logger.warning("Unknown notification level %r - using the default for %s", level, notification_type)
    return default_level(notification_type)
