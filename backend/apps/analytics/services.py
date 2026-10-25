"""Analytics service layer for CivicAI (owner B5).

Every number returned here is computed from the database at request time - nothing is cached,
sampled or hard-coded.  Views stay thin: they validate the query string
(``serializers.AnalyticsQuerySerializer``), call one function of this module and return its dict.

Techniques (useful for the viva)
--------------------------------
* **Aggregation in the database** - counts and averages use conditional aggregation,
  ``values(<group>).annotate(Count("id", filter=Q(...)), Avg(...))``: one ``GROUP BY`` query per
  breakdown instead of one query per row.
* **Time bucketing in Python (pandas)** - MySQL's ``CONVERT_TZ`` needs time-zone tables that are
  often missing, so ``TruncDate`` / ``TruncMonth`` / ``__date`` would silently return NULL.  We
  fetch the raw UTC timestamps, convert them to ``settings.TIME_ZONE`` with pandas
  (``tz_convert``) and bucket by local day, ISO week (starting Monday) or calendar month.
* **Definitions** - resolution time = ``resolved_at - created_at`` (hours); SLA compliance =
  share of resolved complaints with ``resolved_at <= sla_due_at``; satisfaction = share of
  feedback rated 4 or 5; "critical" = open complaints whose AI priority level is critical.
* **Hotspots** - complaint coordinates are clustered with DBSCAN using the haversine metric
  (``ai.geospatial.hotspots.detect_hotspots``); dense clusters raise de-duplicated
  :class:`~apps.analytics.models.HotspotAlert` rows and admin notifications.
* **Units** - every ``*_rate``, ``*_pct``, ``sla_compliance`` and ``percentage`` value is a
  percentage 0-100 (1 decimal); ``utilization`` and AI confidences are fractions 0-1.
* **Sanitised output** - :func:`clean_json` turns NaN/inf into 0 and numpy/Decimal values into
  plain JSON numbers, so empty data yields zeros and empty arrays, never invalid JSON.
"""
import logging
import math
import re
from collections import Counter
from collections.abc import Mapping
from datetime import date, datetime, timedelta
from decimal import Decimal

import numpy as np
import pandas as pd
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Avg, Count, Exists, F, OuterRef, Q
from django.utils import timezone

from apps.complaints.models import (
    AIPrediction,
    Complaint,
    DuplicateComplaint,
    Level,
    ResolutionVerification,
    StatusHistory,
)
from apps.core.models import AIConfiguration
from apps.core.permissions import user_role
from apps.core.utils import bounding_box, haversine_m
from apps.departments.models import CivicCategory, Department
from apps.feedback.models import Feedback
from apps.notifications.models import Notification
from apps.officers.models import OfficerProfile

from .models import HotspotAlert
from .serializers import (
    LEVEL_LABELS,
    STATUS_LABELS,
    HotspotAlertSerializer,
    iso,
    local_midnight,
    local_today,
    local_tz,
    serialize_shared,
    with_list_annotations,
)

logger = logging.getLogger("apps.analytics")

OPEN = list(Complaint.OPEN_STATUSES)
PENDING = list(Complaint.PENDING_STATUSES)
IN_PROGRESS = list(Complaint.IN_PROGRESS_STATUSES)
RESOLVED = list(Complaint.RESOLVED_STATUSES)
OPEN_ASSIGNED = list(Complaint.OPEN_ASSIGNED_STATUSES)
LEVELS = [Level.LOW, Level.MEDIUM, Level.HIGH, Level.CRITICAL]
CRITICAL = Level.CRITICAL
SENTIMENTS = [choice for choice, _ in Feedback.Sentiment.choices]
SENTIMENT_LABELS = dict(Feedback.Sentiment.choices)

RESOLUTION_BUCKETS = [("< 24 h", 0, 24), ("1–3 days", 24, 72), ("3–7 days", 72, 168), ("> 7 days", 168, math.inf)]
RECENT_RESOLVED_DAYS = 30

HOTSPOT_SCAN_DAYS = 30          # alerts consider open complaints of the last 30 days
HOTSPOT_LOCAL_RADIUS_M = 2000   # neighbourhood examined after a new complaint
HOTSPOT_DEDUP_HOURS = 24        # the same hotspot alerts admins at most once per 24 h
MAX_HOTSPOT_POINTS = 5000       # keeps DBSCAN (O(n log n) with a ball tree) fast on huge datasets
ACTIVE_ALERT_DAYS = 30

KEYWORD_SAMPLE_TEXTS = 200      # most recent feedback texts per sentiment fed to keyword extraction
KEYWORD_DOCUMENT_CHARS = 20000
TOP_KEYWORDS = 10
# Techniques behind ``top_keywords``, in the order ``keyword_method`` lists them.
KEYWORD_METHOD_ORDER = ["sentiment_lexicon", "keyword_extractor", "word_frequency"]
_WORD_RE = re.compile(r"[^\W\d_]{3,}", re.UNICODE)
# Words of three or more letters that carry no meaning on their own (English + common Hinglish fillers).
_STOPWORDS = frozenset(
    """
    the and was were are been being for with that this those these from have has had not but you your
    yours our ours they them their there here what which who whom when where why how all any can could
    would should will shall may might must very just also too than then into onto over under after
    before again about above below off out only own same some such more most other its his her hers him
    she mine does did done got get gets hai hain tha thi kya nahi bhi aur par mein
    """.split()
)


class HotspotEngineUnavailable(Exception):
    """The DBSCAN hotspot engine (``ai.geospatial.hotspots``) is not implemented or failed."""


# ---------------------------------------------------------------------------------------------
# Small numeric / JSON helpers
# ---------------------------------------------------------------------------------------------
def _num(value, digits=1):
    """Round a possibly missing / NaN number; empty data becomes 0.0 (never NaN)."""
    if value is None:
        return 0.0
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(value) or math.isinf(value):
        return 0.0
    return round(value, digits)


def _pct(part, whole, digits=1):
    """``part / whole`` as a percentage 0-100 (0.0 when ``whole`` is 0)."""
    return _num(100.0 * part / whole, digits) if whole else 0.0


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def percentages(counts, digits=1):
    """Percentages of ``counts`` that add up to exactly 100 (largest-remainder rounding).

    Plain rounding of 1/3, 1/3, 1/3 gives 33.3 x 3 = 99.9; the largest-remainder (Hamilton)
    method hands the missing 0.1 to the share with the largest rounding loss.
    """
    total = sum(counts)
    if not total:
        return [0.0 for _ in counts]
    scale = 10 ** digits
    raw = [count * 100 * scale / total for count in counts]
    floors = [math.floor(value) for value in raw]
    remainder = 100 * scale - sum(floors)
    for index in sorted(range(len(raw)), key=lambda i: raw[i] - floors[i], reverse=True)[:remainder]:
        floors[index] += 1
    return [value / scale for value in floors]


def _clean_key(key):
    if isinstance(key, (np.integer,)):
        return int(key)
    if isinstance(key, (np.floating,)):
        return float(key)
    if key is None or isinstance(key, (str, int, float, bool)):
        return key
    return str(key)


def clean_json(value):
    """Recursively convert to JSON-safe Python values (numpy -> int/float, NaN/inf -> 0, dates -> ISO)."""
    if isinstance(value, Mapping):
        return {_clean_key(key): clean_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [clean_json(item) for item in value]
    if isinstance(value, np.ndarray):
        return clean_json(value.tolist())
    if value is pd.NaT:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating, Decimal)):
        number = float(value)
        return 0.0 if math.isnan(number) or math.isinf(number) else number
    if isinstance(value, (datetime, date)):
        return iso(value)
    return value


def _counts(queryset, field):
    """``{value: count}`` for one column via ``GROUP BY``."""
    return dict(queryset.order_by().values_list(field).annotate(n=Count("id")))


def _level_distribution(counts):
    return [{"level": level, "label": LEVEL_LABELS[level], "count": counts.get(level, 0)} for level in LEVELS]


# ---------------------------------------------------------------------------------------------
# Time windows and pandas bucketing
# ---------------------------------------------------------------------------------------------
def resolve_window(filters, days):
    """Inclusive local ``(start_date, end_date)`` for a time series.

    Explicit ``date_from`` / ``date_to`` filters win; otherwise the last ``days`` days up to today.
    """
    end = filters.date_to or local_today()
    start = filters.date_from or (end - timedelta(days=days - 1))
    return start, max(start, end)


def to_local(values):
    """Aware UTC datetimes (or None) -> naive local wall-clock pandas timestamps (NaT for None)."""
    series = pd.to_datetime(pd.Series(list(values), dtype="object"), utc=True)
    return series.dt.tz_convert(local_tz()).dt.tz_localize(None)


def bucket_dates(local, period):
    """Map local timestamps to the first day (python ``date``) of their day / week / month bucket."""
    day = local.dt.normalize()
    if period == "week":
        day = day - pd.to_timedelta(day.dt.weekday, unit="D")      # ISO weeks start on Monday
    elif period == "month":
        day = day - pd.to_timedelta(day.dt.day - 1, unit="D")      # first day of the month
    return day.dt.date


def _floor_date(value, period):
    if period == "week":
        return value - timedelta(days=value.weekday())
    if period == "month":
        return value.replace(day=1)
    return value


def _next_bucket(value, period):
    if period == "week":
        return value + timedelta(days=7)
    if period == "month":
        return (value.replace(day=28) + timedelta(days=4)).replace(day=1)
    return value + timedelta(days=1)


def bucket_range(start, end, period):
    """Every bucket start date between ``start`` and ``end`` (so empty periods show as zeros)."""
    current, last = _floor_date(start, period), _floor_date(end, period)
    buckets = []
    while current <= last:
        buckets.append(current)
        current = _next_bucket(current, period)
    return buckets


def bucket_label(value, period):
    """Short axis label: "Oct 1" for days/weeks, "Oct 2026" for months."""
    if period == "month":
        return f"{value:%b %Y}"
    return f"{value:%b} {value.day}"


def _window_bounds(start, end):
    """Aware ``[start, end)`` datetimes for inclusive local dates."""
    return local_midnight(start), local_midnight(end + timedelta(days=1))


# ---------------------------------------------------------------------------------------------
# Resolution-time and SLA metrics
# ---------------------------------------------------------------------------------------------
def resolution_frame(queryset, *group_fields):
    """DataFrame with one row per resolved complaint of ``queryset``.

    Columns: ``hours`` (resolved_at - created_at, clipped at 0 for clock-skewed data),
    ``within_sla`` (1.0 / 0.0, NaN when the complaint had no SLA due date) and ``group_fields``.
    """
    columns = ["created_at", "resolved_at", "sla_due_at", *group_fields]
    rows = list(
        queryset.filter(status__in=RESOLVED, resolved_at__isnull=False)
        .order_by()
        .values_list(*columns)
    )
    frame = pd.DataFrame(rows, columns=columns)
    if frame.empty:
        frame["hours"] = pd.Series(dtype="float64")
        frame["within_sla"] = pd.Series(dtype="float64")
        return frame
    created = pd.to_datetime(frame["created_at"], utc=True)
    resolved = pd.to_datetime(frame["resolved_at"], utc=True)
    due = pd.to_datetime(frame["sla_due_at"], utc=True)
    frame["hours"] = ((resolved - created).dt.total_seconds() / 3600.0).clip(lower=0)
    frame["within_sla"] = np.where(due.isna(), np.nan, (resolved <= due).astype(float))
    return frame


def mean_hours(frame, digits=1):
    """Average resolution time in hours (0.0 for no resolved complaints)."""
    return _num(frame["hours"].mean(), digits) if len(frame) else 0.0


def sla_compliance(frame):
    """Percentage of resolved complaints (with an SLA) resolved on or before ``sla_due_at``."""
    within = frame["within_sla"].dropna() if len(frame) else pd.Series(dtype="float64")
    return _num(within.mean() * 100.0, 1) if len(within) else 0.0


def grouped_hours(frame, field):
    """``{group: average hours}``."""
    if frame.empty:
        return {}
    return frame.groupby(field)["hours"].mean().to_dict()


def grouped_sla(frame, field):
    """``{group: SLA compliance %}``."""
    if frame.empty:
        return {}
    within = frame.dropna(subset=["within_sla"])
    if within.empty:
        return {}
    return (within.groupby(field)["within_sla"].mean() * 100.0).to_dict()


def resolution_distribution(frame):
    """Resolved complaints per resolution-time bucket (< 24 h, 1–3 days, 3–7 days, > 7 days)."""
    hours = frame["hours"] if len(frame) else pd.Series(dtype="float64")
    return [
        {"bucket": label, "count": int(((hours >= low) & (hours < high)).sum())}
        for label, low, high in RESOLUTION_BUCKETS
    ]


def key_figures(queryset):
    """Headline numbers for any Complaint queryset (used by reports)."""
    now = timezone.now()
    counts = queryset.order_by().aggregate(
        total=Count("id"),
        open=Count("id", filter=Q(status__in=OPEN)),
        resolved=Count("id", filter=Q(status__in=RESOLVED)),
        overdue=Count("id", filter=Q(status__in=OPEN, sla_due_at__lt=now)),
    )
    frame = resolution_frame(queryset)
    return {**counts, "avg_resolution_hours": mean_hours(frame), "sla_compliance": sla_compliance(frame)}


# ---------------------------------------------------------------------------------------------
# Admin overview
# ---------------------------------------------------------------------------------------------
def _priority_histogram(queryset):
    """Ten priority-score buckets (0-9 ... 90-100) via conditional aggregation in one query."""
    scored = queryset.exclude(priority_level="").order_by()
    aggregates = {}
    labels = []
    for index in range(10):
        low = index * 10
        if index == 9:
            aggregates[f"b{index}"] = Count("id", filter=Q(priority_score__gte=low))
            labels.append(f"{low}-100")
        else:
            aggregates[f"b{index}"] = Count("id", filter=Q(priority_score__gte=low, priority_score__lte=low + 9))
            labels.append(f"{low}-{low + 9}")
    counts = scored.aggregate(**aggregates)
    return [{"bucket": label, "count": counts[f"b{index}"]} for index, label in enumerate(labels)]


def active_alerts(filters=None):
    """Unacknowledged hotspot alerts of the last 30 days (optionally narrowed by category / department)."""
    alerts = HotspotAlert.objects.filter(
        is_acknowledged=False, created_at__gte=timezone.now() - timedelta(days=ACTIVE_ALERT_DAYS)
    )
    if filters is not None and filters.category is not None:
        alerts = alerts.filter(dominant_category=filters.category)
    if filters is not None and filters.department is not None:
        alerts = alerts.filter(dominant_category__department=filters.department)
    return alerts


def overview(filters, *, request=None, include_lists=True):
    """Admin overview (``overview/`` and the admin ``dashboard/``).

    ``totals.critical`` / ``overdue`` count *open* complaints (they need action now);
    ``needs_review`` counts open complaints flagged for manual review plus resolved ones whose
    resolution awaits an admin's manual verification; ``reopened`` counts complaints reopened at least
    once (``reopen_count > 0``);
    ``duplicates_pending`` counts duplicate pairs awaiting review; ``hotspot_count`` is the
    number of active (unacknowledged, last 30 days) hotspot alerts.
    """
    now = timezone.now()
    complaints = Complaint.objects.filter(filters.complaint_q()).order_by()
    open_q = Q(status__in=OPEN)
    totals = complaints.aggregate(
        total=Count("id"),
        pending=Count("id", filter=Q(status__in=PENDING)),
        in_progress=Count("id", filter=Q(status__in=IN_PROGRESS)),
        resolved=Count("id", filter=Q(status__in=RESOLVED)),
        critical=Count("id", filter=open_q & Q(priority_level=CRITICAL)),
        rejected=Count("id", filter=Q(status=Complaint.Status.REJECTED)),
        reopened=Count("id", filter=Q(reopen_count__gt=0)),
        overdue=Count("id", filter=open_q & Q(sla_due_at__lt=now)),
        # Open work flagged for review plus resolved work waiting for an admin's manual verification.
        needs_review=Count(
            "id", filter=(open_q | Q(status=Complaint.Status.RESOLVED)) & Q(needs_manual_review=True)
        ),
    )
    totals["duplicates_pending"] = DuplicateComplaint.objects.filter(
        status=DuplicateComplaint.Status.PENDING_REVIEW, complaint__in=complaints.values("pk")
    ).count()
    ordered_totals = {key: totals[key] for key in (
        "total", "pending", "in_progress", "resolved", "critical", "rejected", "reopened", "overdue",
        "duplicates_pending", "needs_review",
    )}

    frame = resolution_frame(complaints)
    feedback = Feedback.objects.filter(complaint__in=complaints.values("pk")).aggregate(
        avg=Avg("rating"), total=Count("id"), satisfied=Count("id", filter=Q(rating__gte=4))
    )
    status_counts = _counts(complaints, "status")
    data = {
        "totals": ordered_totals,
        "avg_resolution_hours": mean_hours(frame),
        "sla_compliance": sla_compliance(frame),
        "avg_rating": _num(feedback["avg"], 2),
        "satisfaction_rate": _pct(feedback["satisfied"], feedback["total"]),
        "feedback_count": feedback["total"],
        "status_distribution": [
            {"status": status, "label": STATUS_LABELS[status], "count": status_counts.get(status, 0)}
            for status in Complaint.Status.values
        ],
        "severity_distribution": _level_distribution(_counts(complaints, "severity")),
        "priority_distribution": _level_distribution(_counts(complaints, "priority_level")),
        "priority_histogram": _priority_histogram(complaints),
        "resolution_time_distribution": resolution_distribution(frame),
        "hotspot_count": active_alerts(filters).count(),
        "generated_at": iso(now),
    }
    if include_lists:
        recent = (
            with_list_annotations(complaints.filter(open_q, priority_level=CRITICAL))
            .order_by("-created_at", "-id")[:5]
        )
        data["recent_critical"] = serialize_shared("complaint_list", recent, request=request, many=True)
    return data


# ---------------------------------------------------------------------------------------------
# Role-aware dashboards
# ---------------------------------------------------------------------------------------------
def _pending_feedback_complaints(citizen, limit=10):
    """Complaints of ``citizen`` waiting for feedback on their current resolution, newest first.

    The rule (resolved/verified, no feedback since the latest reopen) has a single home,
    ``apps.feedback.services.pending_feedback_for``, so the dashboard and the Feedback page always agree.
    """
    from apps.feedback.services import pending_feedback_for

    return list(pending_feedback_for(citizen)[:limit])


def citizen_dashboard(user, *, request=None):
    """Citizen home: own totals, recent complaints, the active complaint with its public timeline,
    feedback requests, latest notifications and civic points."""
    own = Complaint.objects.filter(citizen=user).order_by()
    totals = own.aggregate(
        total=Count("id"),
        pending=Count("id", filter=Q(status__in=PENDING)),
        in_progress=Count("id", filter=Q(status__in=IN_PROGRESS)),
        resolved=Count("id", filter=Q(status__in=RESOLVED)),
        rejected=Count("id", filter=Q(status=Complaint.Status.REJECTED)),
    )
    recent = with_list_annotations(Complaint.objects.filter(citizen=user)).order_by("-created_at", "-id")[:5]
    active = (
        with_list_annotations(Complaint.objects.filter(citizen=user, status__in=OPEN))
        .order_by("-updated_at", "-id")
        .first()
    )
    active_payload = None
    if active is not None:
        events = (
            StatusHistory.objects.filter(complaint=active, is_public=True)
            .select_related("changed_by")
            .order_by("timestamp", "id")
        )
        active_payload = {
            "complaint": serialize_shared("complaint_list", active, request=request),
            "timeline": serialize_shared("timeline_event", events, request=request, many=True),
        }
    feedback_requests = [
        {"complaint": serialize_shared("complaint_mini", complaint, request=request),
         "resolved_at": iso(complaint.resolved_at)}
        for complaint in _pending_feedback_complaints(user)
    ]
    notifications = (
        Notification.objects.filter(user=user).select_related("complaint").order_by("-created_at", "-id")[:5]
    )
    profile = getattr(user, "citizen_profile", None)
    return {
        "role": "citizen",
        "totals": totals,
        "recent_complaints": serialize_shared("complaint_list", recent, request=request, many=True),
        "active_complaint": active_payload,
        "feedback_requests": feedback_requests,
        "notifications": serialize_shared("notification", notifications, request=request, many=True),
        "civic_points": profile.civic_points if profile else 0,
    }


def _officer_workload(user):
    """Workload ``{"active", "capacity", "utilization", "overloaded"}`` of the officer dashboard - the
    ``apps.assignments.services.officer_workload`` numbers, identical to ``/officers/{id}/workload/``."""
    from apps.assignments.services import officer_workload

    data = officer_workload(user)
    return {key: data[key] for key in ("active", "capacity", "utilization", "overloaded")}


def officer_dashboard(user, *, request=None):
    """Officer home: totals of complaints assigned to the officer, workload, the work queue (open
    assigned complaints by descending priority) and the latest timeline activity."""
    now = timezone.now()
    mine = Complaint.objects.filter(assigned_officer=user).order_by()
    totals = mine.aggregate(
        assigned=Count("id", filter=Q(status__in=OPEN_ASSIGNED)),
        critical=Count("id", filter=Q(status__in=OPEN_ASSIGNED, priority_level=CRITICAL)),
        pending=Count("id", filter=Q(status__in=PENDING)),
        in_progress=Count("id", filter=Q(status__in=IN_PROGRESS)),
        resolved=Count("id", filter=Q(status__in=RESOLVED)),
        overdue=Count("id", filter=Q(status__in=OPEN, sla_due_at__lt=now)),
    )
    queue = (
        with_list_annotations(Complaint.objects.filter(assigned_officer=user, status__in=OPEN_ASSIGNED))
        .order_by("-priority_score", F("sla_due_at").asc(nulls_last=True), "created_at", "id")[:10]
    )
    events = list(
        StatusHistory.objects.filter(complaint__assigned_officer=user)
        .select_related("changed_by", "complaint")
        .order_by("-timestamp", "-id")[:10]
    )
    activity = []
    for event, payload in zip(events, serialize_shared("timeline_event", events, request=request, many=True)):
        payload = dict(payload)
        payload["complaint_number"] = event.complaint.complaint_number
        payload["complaint_id"] = event.complaint_id
        activity.append(payload)
    profile = getattr(user, "officer_profile", None)
    return {
        "role": "officer",
        "totals": totals,
        "avg_resolution_hours": mean_hours(resolution_frame(mine)),
        "workload": _officer_workload(user),
        "queue": serialize_shared("complaint_list", queue, request=request, many=True),
        "recent_activity": activity,
        "department": serialize_shared(
            "department_mini", profile.department if profile else None, request=request
        ),
    }


# ---------------------------------------------------------------------------------------------
# Category / department / officer breakdowns
# ---------------------------------------------------------------------------------------------
def _status_aggregates(now):
    """Conditional aggregates shared by the category and department breakdowns."""
    open_q = Q(status__in=OPEN)
    return {
        "total": Count("id"),
        "open": Count("id", filter=open_q),
        "pending": Count("id", filter=Q(status__in=PENDING)),
        "in_progress": Count("id", filter=Q(status__in=IN_PROGRESS)),
        "resolved": Count("id", filter=Q(status__in=RESOLVED)),
        "critical": Count("id", filter=open_q & Q(priority_level=CRITICAL)),
        "overdue": Count("id", filter=open_q & Q(sla_due_at__lt=now)),
    }


def category_breakdown(filters, *, request=None):
    """Per-category workload and performance (``categories/``), busiest category first.

    Active categories always appear (zeros when unused); inactive ones appear only when they
    have matching complaints.  With a department filter only categories routed to that
    department or having its complaints are listed.
    """
    now = timezone.now()
    complaints = Complaint.objects.filter(filters.complaint_q(), category__isnull=False).order_by()
    stats = {
        row["category_id"]: row
        for row in complaints.values("category_id").annotate(
            **_status_aggregates(now), avg_priority=Avg("priority_score"), avg_severity=Avg("severity_score")
        )
    }
    frame = resolution_frame(complaints, "category_id")
    hours = grouped_hours(frame, "category_id")
    if filters.category is not None:
        categories = CivicCategory.objects.filter(pk=filters.category.pk)
    elif filters.department is not None:
        categories = CivicCategory.objects.filter(
            Q(pk__in=list(stats)) | Q(is_active=True, department=filters.department)
        )
    else:
        categories = CivicCategory.objects.filter(Q(pk__in=list(stats)) | Q(is_active=True))
    ranked = []
    for category in categories:
        row = stats.get(category.pk, {})
        total = row.get("total", 0)
        ranked.append(((-total, category.sort_order, category.name), {
            "category": serialize_shared("category_mini", category, request=request),
            "total": total,
            "open": row.get("open", 0),
            "resolved": row.get("resolved", 0),
            "critical": row.get("critical", 0),
            "avg_priority": _num(row.get("avg_priority"), 1),
            "avg_severity_score": _num(row.get("avg_severity"), 1),
            "avg_resolution_hours": _num(hours.get(category.pk), 1),
            "resolution_rate": _pct(row.get("resolved", 0), total),
        }))
    ranked.sort(key=lambda pair: pair[0])
    return [row for _, row in ranked]


def department_breakdown(filters, *, request=None):
    """Per-department performance (``departments/``), busiest department first.

    ``officer_count`` and ``active_workload`` (open complaints currently assigned to the
    department's officers) describe the present state and ignore the date filter.
    """
    now = timezone.now()
    complaints = Complaint.objects.filter(filters.complaint_q(), department__isnull=False).order_by()
    stats = {
        row["department_id"]: row
        for row in complaints.values("department_id").annotate(**_status_aggregates(now))
    }
    frame = resolution_frame(complaints, "department_id")
    hours = grouped_hours(frame, "department_id")
    sla = grouped_sla(frame, "department_id")
    ratings = dict(
        Feedback.objects.filter(complaint__in=complaints.values("pk"))
        .order_by()
        .values_list("complaint__department")
        .annotate(avg=Avg("rating"))
    )
    officer_counts = dict(
        OfficerProfile.objects.filter(user__is_active=True, department__isnull=False)
        .order_by()
        .values_list("department")
        .annotate(n=Count("user"))
    )
    workload = dict(
        Complaint.objects.filter(
            status__in=OPEN_ASSIGNED,
            assigned_officer__is_active=True,
            assigned_officer__officer_profile__department__isnull=False,
        )
        .order_by()
        .values_list("assigned_officer__officer_profile__department")
        .annotate(n=Count("id"))
    )
    if filters.department is not None:
        departments = Department.objects.filter(pk=filters.department.pk)
    else:
        departments = Department.objects.filter(Q(is_active=True) | Q(pk__in=list(stats)))
    rows = []
    for department in departments:
        row = stats.get(department.pk, {})
        total = row.get("total", 0)
        rows.append({
            "department": serialize_shared("department_mini", department, request=request),
            "total": total,
            "pending": row.get("pending", 0),
            "in_progress": row.get("in_progress", 0),
            "resolved": row.get("resolved", 0),
            "critical": row.get("critical", 0),
            "overdue": row.get("overdue", 0),
            "avg_resolution_hours": _num(hours.get(department.pk), 1),
            "resolution_rate": _pct(row.get("resolved", 0), total),
            "sla_compliance": _num(sla.get(department.pk), 1),
            "avg_rating": _num(ratings.get(department.pk), 2),
            "officer_count": officer_counts.get(department.pk, 0),
            "active_workload": workload.get(department.pk, 0),
        })
    rows.sort(key=lambda item: (-item["total"], item["department"]["name"]))
    return rows


def officer_performance(filters, *, request=None):
    """Per-officer workload and track record (``officers/``).

    ``active`` / ``capacity`` / ``utilization`` / ``overloaded`` / ``critical_active`` come from
    ``apps.assignments.services`` (``collect_officer_stats`` + ``workload_figures``) - the numbers of
    ``/officers/{id}/workload/`` and the recommender.  ``active``, ``critical_active`` and
    ``resolved_30d`` describe the present; ``resolved_total``, ``avg_resolution_hours`` and
    ``avg_rating`` respect the date / category / severity filters (on the complaint's ``created_at``).
    ``department`` filters the officers themselves.
    """
    from apps.assignments.services import collect_officer_stats, workload_figures

    now = timezone.now()
    officers = list(
        get_user_model().objects.filter(role="officer", is_active=True, officer_profile__isnull=False)
        .select_related("officer_profile__department")
        .order_by("first_name", "last_name", "id")
    )
    if filters.department is not None:
        officers = [user for user in officers if user.officer_profile.department_id == filters.department.pk]
    ids = [user.id for user in officers]
    stats = collect_officer_stats(ids)
    assigned = Complaint.objects.filter(assigned_officer_id__in=ids).order_by()
    resolved_recently = _counts(
        assigned.filter(status__in=RESOLVED, resolved_at__gte=now - timedelta(days=RECENT_RESOLVED_DAYS)),
        "assigned_officer_id",
    )
    historical = assigned.filter(filters.complaint_q(department=False, status=False))
    resolved_counts = _counts(historical.filter(status__in=RESOLVED), "assigned_officer_id")
    hours = grouped_hours(resolution_frame(historical, "assigned_officer_id"), "assigned_officer_id")
    ratings = dict(
        Feedback.objects.filter(complaint__in=historical.values("pk"))
        .order_by()
        .values_list("complaint__assigned_officer")
        .annotate(avg=Avg("rating"))
    )
    rows = []
    for user in officers:
        profile = user.officer_profile
        officer_stats = stats[user.id]
        workload = workload_figures(officer_stats.active, profile.max_active_complaints)
        rows.append({
            "officer": serialize_shared("officer_mini", user, request=request),
            "department": serialize_shared("department_mini", profile.department, request=request),
            "active": workload["active"],
            "capacity": workload["capacity"],
            "utilization": workload["utilization"],
            "overloaded": workload["overloaded"],
            "is_available": profile.is_available,
            "resolved_total": resolved_counts.get(user.id, 0),
            "resolved_30d": resolved_recently.get(user.id, 0),
            "avg_resolution_hours": _num(hours.get(user.id), 1),
            "avg_rating": _num(ratings.get(user.id), 2),
            "critical_active": officer_stats.critical,
        })
    return rows


# ---------------------------------------------------------------------------------------------
# Trends (bucketed in Python with pandas)
# ---------------------------------------------------------------------------------------------
def trends(filters, *, request=None, period="day", days=90):
    """Time series of submitted / resolved / critical complaints, resolution time and categories.

    Submitted and critical counts are bucketed by ``created_at``; resolved counts and the
    average resolution time by ``resolved_at``.  Every bucket of the window is present (zeros
    for empty periods) so charts have a continuous axis.
    """
    start, end = resolve_window(filters, days)
    start_dt, end_dt = _window_bounds(start, end)
    base = Complaint.objects.filter(filters.complaint_q(dates=False)).order_by()
    created = pd.DataFrame(
        list(
            base.filter(created_at__gte=start_dt, created_at__lt=end_dt)
            .values_list("created_at", "priority_level", "category_id")
        ),
        columns=["created_at", "priority_level", "category_id"],
    )
    resolved = resolution_frame(base.filter(resolved_at__gte=start_dt, resolved_at__lt=end_dt))
    buckets = bucket_range(start, end, period)

    submitted_counts, critical_counts, category_counts, category_totals = {}, {}, {}, {}
    if not created.empty:
        created["bucket"] = bucket_dates(to_local(created["created_at"]), period)
        submitted_counts = created.groupby("bucket").size().to_dict()
        critical_counts = created[created["priority_level"] == CRITICAL].groupby("bucket").size().to_dict()
        categorised = created.dropna(subset=["category_id"]).copy()
        if not categorised.empty:
            categorised["category_id"] = categorised["category_id"].astype(int)
            category_counts = categorised.groupby(["bucket", "category_id"]).size().to_dict()
            category_totals = categorised["category_id"].value_counts().to_dict()
    resolved_counts, resolved_hours = {}, {}
    if not resolved.empty:
        resolved["bucket"] = bucket_dates(to_local(resolved["resolved_at"]), period)
        resolved_counts = resolved.groupby("bucket").size().to_dict()
        resolved_hours = resolved.groupby("bucket")["hours"].mean().to_dict()

    # busiest category first; ties follow the admin-defined category order
    categories = sorted(
        CivicCategory.objects.filter(pk__in=list(category_totals)),
        key=lambda category: (-category_totals[category.pk], category.sort_order, category.name),
    )
    series, resolution_trend, category_series = [], [], []
    for bucket in buckets:
        label = bucket_label(bucket, period)
        series.append({
            "date": bucket.isoformat(),
            "label": label,
            "submitted": int(submitted_counts.get(bucket, 0)),
            "resolved": int(resolved_counts.get(bucket, 0)),
            "critical": int(critical_counts.get(bucket, 0)),
        })
        resolution_trend.append({
            "date": bucket.isoformat(),
            "label": label,
            "avg_hours": _num(resolved_hours.get(bucket), 1),
            "count": int(resolved_counts.get(bucket, 0)),
        })
        point = {"date": bucket.isoformat(), "label": label}
        for category in categories:
            point[category.slug] = int(category_counts.get((bucket, category.pk), 0))
        category_series.append(point)
    return {
        "period": period,
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "series": series,
        "resolution_time_trend": resolution_trend,
        "category_series": category_series,
        "categories": serialize_shared("category_mini", categories, request=request, many=True),
    }


# ---------------------------------------------------------------------------------------------
# Feedback sentiment
# ---------------------------------------------------------------------------------------------
def _word_frequency_keywords(texts, top_k):
    """Fallback keyword ranking: document frequency of non-stopword words (>= 3 letters)."""
    frequency = Counter()
    for text in texts:
        frequency.update({word for word in _WORD_RE.findall(text.lower()) if word not in _STOPWORDS})
    ranked = sorted(frequency.items(), key=lambda item: (-item[1], item[0]))[:top_k]
    return [{"keyword": word, "count": count} for word, count in ranked]


def _topic_keywords(texts, top_k):
    """Topical keywords of a group of feedback texts -> ``([{"keyword", "count"}], method)``.

    The texts are joined into one document and ranked by ``ai.nlp.keyword_extractor`` (TF-IDF /
    KeyBERT-style ranking, owner A2); ``count`` is the number of texts containing the keyword.
    While that module is unavailable a transparent word-frequency ranking is used instead.
    """
    document = "\n".join(texts)[:KEYWORD_DOCUMENT_CHARS]
    try:
        from ai.nlp.keyword_extractor import extract_keywords

        phrases = extract_keywords(document, top_k=top_k)
    except NotImplementedError:
        phrases = None
    except Exception:
        logger.warning("Keyword extraction failed; falling back to word frequency.", exc_info=True)
        phrases = None
    if not phrases:
        return _word_frequency_keywords(texts, top_k), "word_frequency"
    lowered = [text.lower() for text in texts]
    keywords = []
    for phrase in phrases[:top_k]:
        phrase = str(phrase).strip().lower()
        if phrase:
            keywords.append({"keyword": phrase, "count": sum(1 for text in lowered if phrase in text)})
    return keywords, "keyword_extractor"


def _opinion_phrases(texts, sentiment):
    """Opinion phrases of a group of feedback texts -> ``Counter({phrase: number of texts})``.

    The phrases are the *evidence* of ``ai.nlp.sentiment``'s lexicon scorer - civic phrases such as
    "resolved quickly" / "still not fixed" / "no action", negated words ("not responded") and
    persistence ("still overflowing").  ``analyze_sentiment(text)["evidence"]`` reports exactly this list
    in demo mode; ``lexicon_scores`` is called directly so the phrases stay available (and cheap: no model
    inference) when production mode classifies the sentiment with the transformer.  A phrase is counted
    only when its own polarity matches the group (a negative review may still say "resolved quickly").
    """
    try:
        from ai.nlp.sentiment import lexicon_scores
    except ImportError:
        logger.warning("ai.nlp.sentiment is unavailable; feedback keywords use topical keywords only.")
        return Counter()
    wanted_sign = 1 if sentiment == Feedback.Sentiment.POSITIVE else -1
    polarity = {}
    counts = Counter()
    for text in texts:
        try:
            evidence = lexicon_scores(text)[2]
        except Exception:  # one odd text must not hide the others
            logger.warning("Sentiment evidence extraction failed for a feedback text.", exc_info=True)
            continue
        phrases = set()
        for phrase in evidence:
            phrase = " ".join(str(phrase).lower().split())
            if not any(char.isalpha() for char in phrase):  # emoji evidence is not a keyword
                continue
            if phrase not in polarity:
                polarity[phrase] = lexicon_scores(phrase)[0]
            if polarity[phrase] * wanted_sign > 0:
                phrases.add(phrase)
        counts.update(phrases)
    return counts


def _keywords_for(texts, sentiment, top_k=TOP_KEYWORDS):
    """Top keywords of the positive or negative feedback -> ``([{"keyword", "count"}], methods)``.

    Opinion phrases from the sentiment lexicon (:func:`_opinion_phrases`) and topical keywords
    (:func:`_topic_keywords`) are merged; ``count`` is the number of feedback texts mentioning the
    keyword (the larger count when both sources found it).  Ranked by count, ties favour opinion
    phrases, then alphabetical order.  ``methods`` names the techniques that produced the list.
    """
    if not texts:
        return [], []
    opinions = _opinion_phrases(texts, sentiment)
    topics, topic_method = _topic_keywords(texts, top_k)
    merged = {phrase: (count, 0) for phrase, count in opinions.items()}
    for item in topics:
        count, kind = merged.get(item["keyword"], (0, 1))
        merged[item["keyword"]] = (max(count, item["count"]), kind)
    ranked = sorted(merged.items(), key=lambda pair: (-pair[1][0], pair[1][1], pair[0]))[:top_k]
    methods = (["sentiment_lexicon"] if opinions else []) + [topic_method]
    return [{"keyword": phrase, "count": count} for phrase, (count, _) in ranked], methods


def _sentiment_group(feedback, field, shape, request):
    """Sentiment split + average rating grouped by a complaint relation (department / category)."""
    rows = (
        feedback.exclude(**{f"{field}__isnull": True})
        .values(field)
        .annotate(
            positive=Count("id", filter=Q(sentiment=Feedback.Sentiment.POSITIVE)),
            neutral=Count("id", filter=Q(sentiment=Feedback.Sentiment.NEUTRAL)),
            negative=Count("id", filter=Q(sentiment=Feedback.Sentiment.NEGATIVE)),
            total=Count("id"),
            avg_rating=Avg("rating"),
        )
        .order_by("-total", field)
    )
    rows = list(rows)
    model = Department if shape == "department_mini" else CivicCategory
    objects = model.objects.in_bulk([row[field] for row in rows])
    key = "department" if shape == "department_mini" else "category"
    return [
        {
            key: serialize_shared(shape, objects.get(row[field]), request=request),
            "positive": row["positive"],
            "neutral": row["neutral"],
            "negative": row["negative"],
            "total": row["total"],
            "avg_rating": _num(row["avg_rating"], 2),
        }
        for row in rows
        if row[field] in objects
    ]


def filtered_feedback(filters):
    """Feedback matching the filters: dates on the feedback's ``created_at``, the rest on its complaint."""
    return Feedback.objects.filter(
        filters.complaint_q(prefix="complaint__", dates=False) & filters.date_q("created_at")
    ).order_by()


def feedback_figures(feedback):
    """Sentiment distribution (percentages summing to exactly 100), average rating and satisfaction."""
    totals = feedback.aggregate(total=Count("id"), avg=Avg("rating"), satisfied=Count("id", filter=Q(rating__gte=4)))
    sentiment_counts = _counts(feedback.exclude(sentiment=""), "sentiment")
    counts = [sentiment_counts.get(sentiment, 0) for sentiment in SENTIMENTS]
    distribution = [
        {"sentiment": sentiment, "label": SENTIMENT_LABELS[sentiment], "count": count, "percentage": share}
        for sentiment, count, share in zip(SENTIMENTS, counts, percentages(counts))
    ]
    share = {item["sentiment"]: item["percentage"] for item in distribution}
    return {
        "distribution": distribution,
        "positive_pct": share[Feedback.Sentiment.POSITIVE],
        "neutral_pct": share[Feedback.Sentiment.NEUTRAL],
        "negative_pct": share[Feedback.Sentiment.NEGATIVE],
        "average_rating": _num(totals["avg"], 2),
        "total_feedback": totals["total"],
        "satisfaction_rate": _pct(totals["satisfied"], totals["total"]),
    }


def sentiment_analytics(filters, *, request=None, period="week", days=90):
    """Feedback sentiment analytics (``sentiment/``).

    Filters apply to the feedback's ``created_at`` (dates) and to its complaint (department,
    category, severity, status).  Percentages are computed over sentiment-labelled feedback and
    sum to exactly 100.
    """
    feedback = filtered_feedback(filters)
    figures = feedback_figures(feedback)
    rating_counts = _counts(feedback, "rating")

    start, end = resolve_window(filters, days)
    start_dt, end_dt = _window_bounds(start, end)
    timeline = pd.DataFrame(
        list(
            feedback.filter(created_at__gte=start_dt, created_at__lt=end_dt)
            .values_list("created_at", "sentiment", "rating")
        ),
        columns=["created_at", "sentiment", "rating"],
    )
    grouped = {}
    if not timeline.empty:
        timeline["bucket"] = bucket_dates(to_local(timeline["created_at"]), period)
        for bucket, group in timeline.groupby("bucket"):
            grouped[bucket] = group
    over_time = []
    for bucket in bucket_range(start, end, period):
        group = grouped.get(bucket)
        sentiments = group["sentiment"].value_counts().to_dict() if group is not None else {}
        over_time.append({
            "date": bucket.isoformat(),
            "label": bucket_label(bucket, period),
            "positive": int(sentiments.get(Feedback.Sentiment.POSITIVE, 0)),
            "neutral": int(sentiments.get(Feedback.Sentiment.NEUTRAL, 0)),
            "negative": int(sentiments.get(Feedback.Sentiment.NEGATIVE, 0)),
            "total": int(len(group)) if group is not None else 0,
            "avg_rating": _num(group["rating"].mean(), 2) if group is not None else 0.0,
        })

    recent = (
        feedback.select_related("complaint__department", "complaint__category", "citizen")
        .order_by("-created_at", "-id")[:10]
    )
    top_keywords, methods = {}, []
    for sentiment in (Feedback.Sentiment.POSITIVE, Feedback.Sentiment.NEGATIVE):
        texts = list(
            feedback.filter(sentiment=sentiment).exclude(text="")
            .order_by("-created_at", "-id")
            .values_list("text", flat=True)[:KEYWORD_SAMPLE_TEXTS]
        )
        top_keywords[str(sentiment)], used = _keywords_for(texts, sentiment)
        methods.extend(method for method in used if method not in methods)
    return {
        **figures,
        "rating_distribution": [{"rating": rating, "count": rating_counts.get(rating, 0)} for rating in range(1, 6)],
        "by_department": _sentiment_group(feedback, "complaint__department", "department_mini", request),
        "by_category": _sentiment_group(feedback, "complaint__category", "category_mini", request),
        "over_time": over_time,
        "period": period,
        "recent": serialize_shared("feedback", recent, request=request, many=True),
        "top_keywords": top_keywords,
        # e.g. "sentiment_lexicon+keyword_extractor" (None without feedback text)
        "keyword_method": "+".join(sorted(methods, key=KEYWORD_METHOD_ORDER.index)) or None,
    }


# ---------------------------------------------------------------------------------------------
# AI performance
# ---------------------------------------------------------------------------------------------
def _confidence_histogram(predictions):
    """Ten fused-confidence buckets 0-10% ... 90-100% via conditional aggregation."""
    aggregates = {}
    for index in range(10):
        low = index / 10
        condition = Q(multimodal_confidence__gte=low)
        if index < 9:
            condition &= Q(multimodal_confidence__lt=(index + 1) / 10)
        aggregates[f"b{index}"] = Count("id", filter=condition)
    counts = predictions.aggregate(**aggregates)
    return [{"bucket": f"{index * 10}-{index * 10 + 10}%", "count": counts[f"b{index}"]} for index in range(10)]


def _model_info():
    """``ai.model_info.get_model_info(<live AI configuration>)`` - never breaks the analytics endpoint."""
    from ai.config import get_model_mode

    try:
        from ai.model_info import get_model_info
        from apps.complaints.services.context import engine_config

        return get_model_info(engine_config())
    except Exception:
        logger.warning("ai.model_info.get_model_info() failed.", exc_info=True)
        mode = get_model_mode()
        return {"mode": mode, "is_demo": mode == "demo", "models": [], "components": [],
                "error": "Model information is unavailable."}


def ai_performance(filters, *, request=None):
    """AI performance analytics (``ai/``) for complaints matching the filters.

    Prediction-level figures use every AIPrediction (re-analyses included).  Complaint-level
    figures use each complaint's *latest* prediction: ``needs_review_count``,
    ``ai_category_match_rate`` (latest prediction's final category == the complaint's current
    category, i.e. the AI was not corrected) and the ``confusion`` pairs (AI vs final category).
    ``modality_agreement_rate`` = image category == text category among predictions that have
    both; duplicate ``precision`` = confirmed / (confirmed + rejected) reviewed pairs.
    """
    from ai.config import get_model_mode

    predictions = AIPrediction.objects.filter(filters.complaint_q(prefix="complaint__")).order_by()
    has_image, has_text = ~Q(image_category=""), ~Q(text_category="")
    stats = predictions.aggregate(
        total=Count("id"),
        avg_confidence=Avg("multimodal_confidence"),
        avg_image=Avg("image_confidence", filter=has_image),
        avg_text=Avg("text_confidence", filter=has_text),
        avg_ms=Avg("processing_time_ms"),
        both=Count("id", filter=has_image & has_text),
        agree=Count("id", filter=has_image & has_text & Q(image_category=F("text_category"))),
    )

    by_category_rows = list(
        predictions.exclude(final_category__isnull=True)
        .values("final_category")
        .annotate(count=Count("id"), avg_confidence=Avg("multimodal_confidence"))
        .order_by("-count", "final_category")
    )
    categories = CivicCategory.objects.in_bulk([row["final_category"] for row in by_category_rows])
    predictions_by_category = [
        {"category": serialize_shared("category_mini", categories[row["final_category"]], request=request),
         "count": row["count"], "avg_confidence": _num(row["avg_confidence"], 3)}
        for row in by_category_rows
        if row["final_category"] in categories
    ]

    latest_rows = predictions.values_list(
        "complaint_id", "needs_review", "final_category__slug", "final_category_slug", "complaint__category__slug"
    ).order_by("complaint_id", "-created_at", "-id")
    seen = set()
    needs_review = compared = matched = 0
    confusion = Counter()
    for complaint_id, review, fk_slug, stored_slug, final_slug in latest_rows:
        if complaint_id in seen:
            continue
        seen.add(complaint_id)
        needs_review += bool(review)
        ai_slug = fk_slug or stored_slug
        if ai_slug and final_slug:
            compared += 1
            matched += ai_slug == final_slug
            confusion[(ai_slug, final_slug)] += 1

    complaints = Complaint.objects.filter(filters.complaint_q()).order_by()
    analyzed = complaints.filter(Exists(AIPrediction.objects.filter(complaint=OuterRef("pk")))).count()
    overrides = complaints.filter(is_ai_overridden=True).count()

    duplicate_counts = _counts(DuplicateComplaint.objects.filter(filters.complaint_q(prefix="complaint__")), "status")
    confirmed = duplicate_counts.get(DuplicateComplaint.Status.CONFIRMED_DUPLICATE, 0)
    rejected = duplicate_counts.get(DuplicateComplaint.Status.NOT_DUPLICATE, 0)

    verifications = ResolutionVerification.objects.filter(filters.complaint_q(prefix="complaint__")).order_by()
    verification_stats = verifications.aggregate(
        total=Count("id"), avg_score=Avg("score"), manual=Count("id", filter=Q(is_manual_override=True))
    )
    verification_counts = _counts(verifications, "status")
    mode = get_model_mode()
    return {
        "mode": mode,
        "is_demo": mode == "demo",
        "total_predictions": stats["total"],
        "avg_confidence": _num(stats["avg_confidence"], 3),
        "avg_image_confidence": _num(stats["avg_image"], 3),
        "avg_text_confidence": _num(stats["avg_text"], 3),
        "modality_agreement_rate": _pct(stats["agree"], stats["both"]),
        "needs_review_count": needs_review,
        "override_count": overrides,
        "override_rate": _pct(overrides, analyzed),
        "analyzed_complaints": analyzed,
        "ai_category_match_rate": _pct(matched, compared),
        "confidence_histogram": _confidence_histogram(predictions),
        "predictions_by_category": predictions_by_category,
        "confusion": [
            {"ai": ai_slug, "final": final_slug, "count": count}
            for (ai_slug, final_slug), count in sorted(confusion.items(), key=lambda item: (-item[1], item[0]))
        ],
        "duplicates": {
            "detected": sum(duplicate_counts.values()),
            "pending": duplicate_counts.get(DuplicateComplaint.Status.PENDING_REVIEW, 0),
            "confirmed": confirmed,
            "rejected": rejected,
            "precision": _pct(confirmed, confirmed + rejected),
        },
        "verification": {
            "total": verification_stats["total"],
            "by_status": [
                {"status": status, "label": label, "count": verification_counts.get(status, 0)}
                for status, label in ResolutionVerification.Status.choices
            ],
            "avg_score": _num(verification_stats["avg_score"], 1),
            "manual_overrides": verification_stats["manual"],
        },
        "avg_processing_ms": int(round(_num(stats["avg_ms"], 1))),
        "severity_distribution": _level_distribution(_counts(predictions, "severity")),
        "model_info": _model_info(),
    }


# ---------------------------------------------------------------------------------------------
# Public statistics (landing page) - aggregated only, no personal data
# ---------------------------------------------------------------------------------------------
def public_stats(*, request=None):
    """City-wide aggregates for anonymous visitors: no names, e-mails, phones or exact coordinates."""
    complaints = Complaint.objects.order_by()
    counts = complaints.aggregate(total=Count("id"), resolved=Count("id", filter=Q(status__in=RESOLVED)))
    users = _counts(get_user_model().objects.filter(is_active=True), "role")
    recent = (
        Complaint.objects.filter(status__in=RESOLVED, resolved_at__isnull=False)
        .select_related("category", "location")
        .order_by("-resolved_at", "-id")[:5]
    )
    return {
        "total_complaints": counts["total"],
        "resolved_complaints": counts["resolved"],
        "resolution_rate": _pct(counts["resolved"], counts["total"]),
        "avg_resolution_hours": mean_hours(resolution_frame(complaints)),
        "departments": Department.objects.filter(is_active=True).count(),
        "categories": CivicCategory.objects.filter(is_active=True).count(),
        "active_officers": users.get("officer", 0),
        "citizens": users.get("citizen", 0),
        "recent_resolved": [
            {
                "complaint_number": complaint.complaint_number,
                "title": complaint.title or (
                    f"{complaint.category.name} issue" if complaint.category else "Civic issue"
                ),
                "category": serialize_shared("category_mini", complaint.category, request=request),
                "area": complaint.location.area,
                "resolved_at": iso(complaint.resolved_at),
            }
            for complaint in recent
        ],
    }


# ---------------------------------------------------------------------------------------------
# Hotspots (DBSCAN) and hotspot alerts
# ---------------------------------------------------------------------------------------------
_POINT_FIELDS = (
    "id", "complaint_number", "location__latitude", "location__longitude", "location__area", "category_id",
    "category__slug", "category__name", "severity", "severity_score", "priority_score", "status", "created_at",
)


def _point_rows(queryset, limit=MAX_HOTSPOT_POINTS):
    """Most recent complaints as flat dicts (one SQL query, location and category joined)."""
    return list(queryset.order_by("-created_at", "-id").values(*_POINT_FIELDS)[:limit])


def _engine_point(row):
    """Plain dict in the ``ai.geospatial.hotspots.detect_hotspots`` input contract."""
    return {
        "id": row["id"],
        "latitude": float(row["location__latitude"]),
        "longitude": float(row["location__longitude"]),
        "category": row["category__slug"] or "",
        "category_name": row["category__name"] or "",
        "severity": row["severity"] or "",
        "severity_score": row["severity_score"] or 0,
        "priority_score": row["priority_score"] or 0,
        "status": row["status"],
        "area": row["location__area"] or "",
        "created_at": iso(row["created_at"]),
    }


def _empty_hotspots(eps_m, min_samples):
    """``detect_hotspots`` result for zero points (the engine is not called for an empty set)."""
    return {"clusters": [], "noise_ids": [], "labels": {}, "params": {"eps_m": eps_m, "min_samples": min_samples},
            "algorithm": "DBSCAN (haversine)", "total_points": 0}


def level_thresholds(config):
    """Admin-configured Low/Medium/High/Critical score thresholds (used for cluster severity levels)."""
    return {"medium": int(config.threshold_medium), "high": int(config.threshold_high),
            "critical": int(config.threshold_critical)}


def run_dbscan(points, *, eps_m, min_samples, thresholds=None):
    """Cluster points with ``ai.geospatial.hotspots.detect_hotspots`` (DBSCAN, haversine metric).

    DBSCAN groups points that have at least ``min_samples`` neighbours within ``eps_m`` metres
    (core points) together with the points reachable from them; everything else is noise.  The
    engine works on radians with ``eps = eps_m / 6371000`` (the Earth's radius).  ``thresholds``
    (from AIConfiguration) turn each cluster's average severity score into its severity level.

    Raises :class:`HotspotEngineUnavailable` when the engine is not implemented or fails.
    """
    if not points:
        return _empty_hotspots(eps_m, min_samples)
    try:
        from ai.geospatial.hotspots import detect_hotspots

        return detect_hotspots(points, eps_m=eps_m, min_samples=min_samples, thresholds=thresholds)
    except NotImplementedError as exc:
        raise HotspotEngineUnavailable("Hotspot engine unavailable") from exc
    except Exception as exc:
        logger.exception("DBSCAN hotspot detection failed for %d points", len(points))
        raise HotspotEngineUnavailable("Hotspot engine unavailable") from exc


def _normalise_labels(labels):
    """Engine labels ``{complaint_id: cluster_id}`` with integer keys and values (-1 = noise)."""
    normalised = {}
    for key, value in (labels or {}).items():
        try:
            normalised[int(key)] = int(value)
        except (TypeError, ValueError):
            continue
    return normalised


def _officer_scope(user):
    """Complaints an officer may analyse: their department's plus the ones assigned to them."""
    profile = getattr(user, "officer_profile", None)
    scope = Q(assigned_officer=user)
    if profile is not None and profile.department_id:
        scope |= Q(department_id=profile.department_id)
    return scope


def hotspot_map(filters, *, user, request=None, eps_m=None, min_samples=None, days=90):
    """``hotspots/``: DBSCAN clusters + every point with its cluster label + the latest alerts.

    Parameters default to ``AIConfiguration.hotspot_eps_m / hotspot_min_samples``.  The window
    is ``date_from``/``date_to`` when given, otherwise the last ``days`` days.  Officers only see
    their department's (and their own) complaints.  Raises :class:`HotspotEngineUnavailable`.
    """
    config = AIConfiguration.load()
    eps_m = int(eps_m or config.hotspot_eps_m)
    min_samples = int(min_samples or config.hotspot_min_samples)
    start, end = resolve_window(filters, days)
    start_dt, end_dt = _window_bounds(start, end)
    complaints = Complaint.objects.filter(
        filters.complaint_q(dates=False), created_at__gte=start_dt, created_at__lt=end_dt
    )
    if user_role(user) == "officer":
        complaints = complaints.filter(_officer_scope(user))
    available = complaints.count()
    rows = _point_rows(complaints)
    result = dict(run_dbscan([_engine_point(row) for row in rows], eps_m=eps_m, min_samples=min_samples,
                             thresholds=level_thresholds(config)))
    labels = _normalise_labels(result.get("labels"))

    slugs = {cluster.get("dominant_category") for cluster in result.get("clusters", [])} - {None, ""}
    ids = {row["category_id"] for row in rows} - {None}
    categories = list(CivicCategory.objects.filter(Q(pk__in=ids) | Q(slug__in=slugs)))
    minis_by_id = {category.pk: serialize_shared("category_mini", category, request=request) for category in categories}
    minis_by_slug = {category.slug: minis_by_id[category.pk] for category in categories}

    clusters = []
    for cluster in result.get("clusters", []):
        item = dict(cluster)
        slug = item.get("dominant_category") or ""
        item["dominant_category_slug"] = slug
        item["dominant_category"] = minis_by_slug.get(slug)
        clusters.append(item)
    alerts = HotspotAlert.objects.select_related("dominant_category").order_by("-created_at", "-id")[:10]
    result.update({
        "clusters": clusters,
        "labels": labels,
        "points": [
            {
                "id": row["id"],
                "complaint_number": row["complaint_number"],
                "latitude": float(row["location__latitude"]),
                "longitude": float(row["location__longitude"]),
                "category": minis_by_id.get(row["category_id"]),
                "severity": row["severity"],
                "status": row["status"],
                "cluster": labels.get(row["id"], -1),
            }
            for row in rows
        ],
        "alerts": HotspotAlertSerializer(alerts, many=True, context={"request": request}).data,
        "window": {"date_from": start.isoformat(), "date_to": end.isoformat(), "days": (end - start).days + 1},
        "points_available": available,
        "points_truncated": available > len(rows),
    })
    return result


def hotspot_cluster_key(latitude, longitude, category_slug):
    """De-duplication key: centroid rounded to 3 decimals (~110 m) + dominant category."""
    return f"{latitude:.3f},{longitude:.3f}:{category_slug or 'mixed'}"[:80]


def _notify_admins_of_hotspot(alert, category_name):
    """Tell every admin about a new hotspot (notifications service owned by B4; never raises)."""
    subject = f"{alert.complaint_count} open {category_name} complaints" if category_name else (
        f"{alert.complaint_count} open complaints"
    )
    message = (
        f"DBSCAN clustering found {subject} within {alert.radius_m:.0f} m of {alert.area_name} "
        f"in the last {HOTSPOT_SCAN_DAYS} days."
    )
    if alert.severity:
        message += f" Cluster severity: {LEVEL_LABELS.get(alert.severity, alert.severity)}."
    try:
        from apps.notifications.services import notify_admins

        notify_admins(
            title=f"Hotspot alert: {alert.area_name}"[:160],
            message=message,
            notification_type="hotspot_alert",
            level="warning",
            link="/admin/hotspots",
        )
    except NotImplementedError:
        logger.info("Notification service not implemented yet; hotspot alert %s not broadcast.", alert.pk)
    except Exception:
        logger.exception("Could not notify admins about hotspot alert %s", alert.pk)


def raise_hotspot_alert(cluster, *, eps_m, now=None):
    """Create a HotspotAlert for a DBSCAN cluster unless the same hotspot alerted in the last 24 h.

    "Same hotspot" = an alert with the same ``cluster_key`` or with the same dominant category
    whose centroid lies within ``eps_m`` of this centroid (centroids drift slightly as new
    complaints join a cluster, which can change the 3-decimal key).  Returns the alert or None.
    """
    now = now or timezone.now()
    latitude, longitude = float(cluster["latitude"]), float(cluster["longitude"])
    slug = cluster.get("dominant_category") or ""
    category = CivicCategory.objects.filter(slug=slug).first() if slug else None
    key = hotspot_cluster_key(latitude, longitude, slug)
    recent = HotspotAlert.objects.filter(created_at__gte=now - timedelta(hours=HOTSPOT_DEDUP_HOURS))
    if recent.filter(cluster_key=key).exists():
        return None
    for previous in recent.filter(dominant_category=category).only("latitude", "longitude"):
        if haversine_m(latitude, longitude, previous.latitude, previous.longitude) <= eps_m:
            return None
    area = str(cluster.get("area_name") or "").strip() or f"{latitude:.4f}, {longitude:.4f}"
    severity = cluster.get("severity_level") or cluster.get("max_severity") or ""
    alert = HotspotAlert.objects.create(
        cluster_key=key,
        latitude=Decimal(f"{latitude:.6f}"),
        longitude=Decimal(f"{longitude:.6f}"),
        radius_m=_num(cluster.get("radius_m"), 1),
        complaint_count=_int(cluster.get("count")),
        dominant_category=category,
        severity=severity if severity in Level.values else "",
        area_name=area[:160],
        complaint_ids=[_int(pk) for pk in (cluster.get("complaint_ids") or [])][:1000],
        created_at=now,
    )
    _notify_admins_of_hotspot(alert, category.name if category else cluster.get("dominant_category_name", ""))
    logger.info("Hotspot alert %s raised: %s (%d complaints)", alert.pk, alert.area_name, alert.complaint_count)
    return alert


def _cluster_containing(result, complaint_id):
    """The cluster dict containing ``complaint_id`` (by label, then by membership) or None."""
    label = _normalise_labels(result.get("labels")).get(complaint_id)
    for cluster in result.get("clusters", []):
        if label is not None and label >= 0 and _int(cluster.get("cluster_id"), -2) == label:
            return cluster
    for cluster in result.get("clusters", []):
        if complaint_id in {_int(pk) for pk in (cluster.get("complaint_ids") or [])}:
            return cluster
    return None


def _check_hotspot_alert(complaint):
    config = AIConfiguration.load()
    now = timezone.now()
    location = complaint.location
    latitude, longitude = float(location.latitude), float(location.longitude)
    min_lat, max_lat, min_lng, max_lng = bounding_box(latitude, longitude, HOTSPOT_LOCAL_RADIUS_M)
    nearby = Complaint.objects.filter(
        status__in=OPEN,
        created_at__gte=now - timedelta(days=HOTSPOT_SCAN_DAYS),
        location__latitude__gte=min_lat,
        location__latitude__lte=max_lat,
        location__longitude__gte=min_lng,
        location__longitude__lte=max_lng,
    )
    points = [
        point for point in map(_engine_point, _point_rows(nearby))
        if haversine_m(latitude, longitude, point["latitude"], point["longitude"]) <= HOTSPOT_LOCAL_RADIUS_M
    ]
    if not any(point["id"] == complaint.pk for point in points):
        return None  # the complaint itself is not open / recent, so it cannot be part of a hotspot
    if len(points) < config.hotspot_alert_threshold:
        return None  # no cluster can reach the threshold: skip the clustering work
    result = run_dbscan(points, eps_m=config.hotspot_eps_m, min_samples=config.hotspot_min_samples,
                        thresholds=level_thresholds(config))
    cluster = _cluster_containing(result, complaint.pk)
    if cluster is None or _int(cluster.get("count")) < config.hotspot_alert_threshold:
        return None
    return raise_hotspot_alert(cluster, eps_m=config.hotspot_eps_m, now=now)


def check_hotspot_alert(complaint):
    """After a new complaint: run DBSCAN around it; if its cluster has >= hotspot_alert_threshold complaints
    and no alert for that cluster in the last 24 h, create a HotspotAlert and notify admins.
    Returns HotspotAlert | None. Never raises.

    Technique: open complaints of the last 30 days inside a 2 km bounding box are fetched with
    one indexed query, filtered exactly with the haversine distance, clustered with DBSCAN
    (``AIConfiguration.hotspot_eps_m`` / ``hotspot_min_samples``) and the cluster containing the
    new complaint is compared with ``hotspot_alert_threshold``.  The work runs in a savepoint so
    a failure can never break the caller's transaction (the submission flow).
    """
    if complaint is None or not getattr(complaint, "pk", None):
        return None
    try:
        with transaction.atomic():
            return _check_hotspot_alert(complaint)
    except HotspotEngineUnavailable:
        logger.info("Hotspot engine unavailable; skipped the hotspot check for complaint %s", complaint.pk)
    except Exception:
        logger.exception("Hotspot check failed for complaint %s", complaint.pk)
    return None


def scan_city_hotspots(*, days=HOTSPOT_SCAN_DAYS):
    """City-wide DBSCAN over open complaints of the last ``days`` days; raise alerts for dense clusters.

    Returns ``{"points", "clusters", "alerts_created"}``.  Raises :class:`HotspotEngineUnavailable`
    when the clustering engine is not available.
    """
    config = AIConfiguration.load()
    now = timezone.now()
    open_recent = Complaint.objects.filter(status__in=OPEN, created_at__gte=now - timedelta(days=days))
    points = [_engine_point(row) for row in _point_rows(open_recent)]
    summary = {"points": len(points), "clusters": 0, "alerts_created": 0}
    if len(points) < config.hotspot_alert_threshold:
        return summary
    result = run_dbscan(points, eps_m=config.hotspot_eps_m, min_samples=config.hotspot_min_samples,
                        thresholds=level_thresholds(config))
    clusters = sorted(result.get("clusters", []), key=lambda cluster: -_int(cluster.get("count")))
    summary["clusters"] = len(clusters)
    for cluster in clusters:
        if _int(cluster.get("count")) < config.hotspot_alert_threshold:
            continue
        with transaction.atomic():
            if raise_hotspot_alert(cluster, eps_m=config.hotspot_eps_m, now=now) is not None:
                summary["alerts_created"] += 1
    return summary
