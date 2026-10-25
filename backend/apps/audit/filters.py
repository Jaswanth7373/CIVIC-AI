"""django-filter FilterSet for /api/audit-logs/.

    ?action=login            one action, or a comma list: ?action=login,logout
    ?entity_type=Complaint   case-insensitive
    ?entity_id=42
    ?actor=5                 user id of the person who acted
    ?date_from=2026-10-01    inclusive, local calendar day (settings.TIME_ZONE)
    ?date_to=2026-10-17      inclusive, local calendar day
Free-text ``?search=`` (description, entity id, actor e-mail / name) is handled by DRF's SearchFilter.

Dates are converted to timezone-aware datetime boundaries ``[start of date_from, start of the day after
date_to)`` instead of using ``__date`` lookups, which need MySQL time-zone tables (BUILD_SPEC section 0.5).
"""
import datetime

from django.utils import timezone
from django_filters import rest_framework as filters

from apps.core.filters import BoundedDateFilter, IdFilter

from .models import AuditLog


def local_day_start(day):
    """Midnight of ``day`` in the project time zone, as an aware datetime."""
    return timezone.make_aware(datetime.datetime.combine(day, datetime.time.min), timezone.get_default_timezone())


class AuditLogFilter(filters.FilterSet):
    action = filters.CharFilter(method="filter_action")
    entity_type = filters.CharFilter(field_name="entity_type", lookup_expr="iexact")
    entity_id = filters.CharFilter(field_name="entity_id")
    actor = IdFilter(field_name="actor_id")
    date_from = BoundedDateFilter(method="filter_date_from")
    date_to = BoundedDateFilter(method="filter_date_to")

    class Meta:
        model = AuditLog
        fields = ["action", "entity_type", "entity_id", "actor", "date_from", "date_to"]

    def filter_action(self, queryset, name, value):
        actions = [item.strip() for item in (value or "").split(",") if item.strip()]
        return queryset.filter(action__in=actions) if actions else queryset

    def filter_date_from(self, queryset, name, value):
        return queryset.filter(created_at__gte=local_day_start(value))

    def filter_date_to(self, queryset, name, value):
        return queryset.filter(created_at__lt=local_day_start(value + datetime.timedelta(days=1)))
