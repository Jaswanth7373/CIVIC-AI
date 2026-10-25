"""Query-string filters for the complaints and duplicates lists (django-filter).

``GET /api/complaints/`` and ``GET /api/complaints/map/`` share :class:`ComplaintFilter`::

    ?status=assigned,in_progress   comma separated list of statuses
    ?category=pothole | 3          category slug or id
    ?severity=high,critical        severity level(s)        ?priority_level=critical
    ?department=ROADS | 2          department code or id    ?assigned_officer=<user id>  ?citizen=<user id>
    ?date_from=2026-10-01&date_to=2026-10-31                 created date range (inclusive, local days)
    ?is_overdue=true   ?has_duplicates=true   ?needs_review=true
    ?unassigned=true   open complaints without an officer (false: every other complaint)

Date technique: a calendar day is converted into an explicit timezone-aware datetime range in the
server time zone (``created_at >= day 00:00`` and ``created_at < next day 00:00``) instead of using the
``__date`` lookup, which needs the database time-zone tables (often missing on MySQL) and cannot use
the ``created_at`` index.
"""
from datetime import datetime, time, timedelta

from django.db.models import Exists, OuterRef, Q
from django.utils import timezone
from django_filters import rest_framework as filters
from rest_framework.exceptions import ValidationError
from rest_framework.filters import OrderingFilter

from apps.core.filters import BoundedDateFilter, IdFilter
from apps.core.utils import parse_id

from .models import Complaint, DuplicateComplaint, Level

ISO_DATE_FORMATS = ["%Y-%m-%d"]


class ChoiceInFilter(filters.BaseInFilter, filters.ChoiceFilter):
    """Comma separated list of choice values (``?status=assigned,accepted``); every value is validated
    against the field's choices, so a typo returns ``400`` instead of silently matching nothing."""


class StableOrderingFilter(OrderingFilter):
    """DRF ``OrderingFilter`` that always appends ``-id`` as a final tie-breaker.

    Many complaints can share the same priority score or creation second; without a unique last
    sort key the database may return tied rows in a different order on each query, so a row could
    appear on two pages (or none) while paginating.
    """

    def get_ordering(self, request, queryset, view):
        ordering = list(super().get_ordering(request, queryset, view) or [])
        if not any(term.lstrip("-") in ("id", "pk") for term in ordering):
            ordering.append("-id")
        return ordering


def start_of_local_day(day):
    """Timezone-aware datetime for 00:00 of ``day`` in the active (``settings.TIME_ZONE``) time zone."""
    return timezone.make_aware(datetime.combine(day, time.min), timezone.get_current_timezone())


def active_duplicate_link_exists():
    """``Exists`` sub-query: the outer complaint takes part (either side) in a duplicate pair that is
    pending review or confirmed. Pairs a reviewer rejected (``not_duplicate``) no longer count."""
    return Exists(
        DuplicateComplaint.objects.filter(
            Q(complaint_id=OuterRef("pk")) | Q(similar_complaint_id=OuterRef("pk")),
            status__in=[DuplicateComplaint.Status.PENDING_REVIEW, DuplicateComplaint.Status.CONFIRMED_DUPLICATE],
        )
    )


class ComplaintFilter(filters.FilterSet):
    """Every list filter of the ``/api/complaints/`` contract (BUILD_SPEC section 4.2)."""

    status = ChoiceInFilter(field_name="status", choices=Complaint.Status.choices)
    category = filters.CharFilter(method="filter_category", help_text="Category id or slug")
    severity = ChoiceInFilter(field_name="severity", choices=Level.choices)
    priority_level = ChoiceInFilter(field_name="priority_level", choices=Level.choices)
    department = filters.CharFilter(method="filter_department", help_text="Department id or code")
    assigned_officer = IdFilter(field_name="assigned_officer_id")
    citizen = IdFilter(field_name="citizen_id")
    # ISO dates only: Django's default input formats would also read "03/04/2026" as 4 March (US order),
    # while Indian users mean 3 April - an ambiguous date is rejected instead of silently misread.
    date_from = BoundedDateFilter(method="filter_date_from", input_formats=ISO_DATE_FORMATS,
                                  help_text="Created on or after (YYYY-MM-DD)")
    date_to = BoundedDateFilter(method="filter_date_to", input_formats=ISO_DATE_FORMATS,
                                help_text="Created on or before (YYYY-MM-DD)")
    is_overdue = filters.BooleanFilter(method="filter_is_overdue")
    has_duplicates = filters.BooleanFilter(method="filter_has_duplicates")
    needs_review = filters.BooleanFilter(field_name="needs_manual_review")
    unassigned = filters.BooleanFilter(method="filter_unassigned",
                                       help_text="Open complaints that no officer is assigned to")

    class Meta:
        model = Complaint
        fields = []  # every filter is declared explicitly above

    def filter_queryset(self, queryset):
        cleaned = self.form.cleaned_data
        date_from, date_to = cleaned.get("date_from"), cleaned.get("date_to")
        if date_from and date_to and date_from > date_to:
            raise ValidationError({"date_to": ["date_to must be the same as or later than date_from."]})
        return super().filter_queryset(queryset)

    def filter_category(self, queryset, name, value):
        value = value.strip()
        category_id = parse_id(value)
        if category_id is not None:
            return queryset.filter(category_id=category_id)
        return queryset.filter(category__slug=value)

    def filter_department(self, queryset, name, value):
        value = value.strip()
        department_id = parse_id(value)
        if department_id is not None:
            return queryset.filter(department_id=department_id)
        return queryset.filter(department__code__iexact=value)

    def filter_date_from(self, queryset, name, value):
        return queryset.filter(created_at__gte=start_of_local_day(value))

    def filter_date_to(self, queryset, name, value):
        # inclusive end date: everything before 00:00 of the following day
        return queryset.filter(created_at__lt=start_of_local_day(value + timedelta(days=1)))

    def filter_is_overdue(self, queryset, name, value):
        overdue = Q(sla_due_at__isnull=False, sla_due_at__lt=timezone.now(), status__in=Complaint.OPEN_STATUSES)
        return queryset.filter(overdue) if value else queryset.exclude(overdue)

    def filter_has_duplicates(self, queryset, name, value):
        link = active_duplicate_link_exists()
        return queryset.filter(link) if value else queryset.filter(~link)

    def filter_unassigned(self, queryset, name, value):
        waiting = Q(assigned_officer__isnull=True, status__in=Complaint.OPEN_STATUSES)
        return queryset.filter(waiting) if value else queryset.exclude(waiting)


class DuplicateFilter(filters.FilterSet):
    """Filters for ``/api/duplicates/``: ``?status=pending_review`` and ``?complaint=<id>`` (either side)."""

    status = ChoiceInFilter(field_name="status", choices=DuplicateComplaint.Status.choices)
    complaint = IdFilter(method="filter_complaint")

    class Meta:
        model = DuplicateComplaint
        fields = []

    def filter_complaint(self, queryset, name, value):
        return queryset.filter(Q(complaint_id=value) | Q(similar_complaint_id=value))
