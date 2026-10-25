"""django-filter FilterSet for /api/officers/.

    ?department=3 | ?department=ROADS | ?department=none   (id, department code, or officers without one)
    ?is_available=true|false
    ?is_active=true|false                                   (account active; admins only see inactive ones)
    ?zone=ward 7                                            (case-insensitive substring)
Free-text ``?search=`` (name, e-mail, employee id, zone, designation) is handled by DRF's SearchFilter.
"""
from django_filters import rest_framework as filters

from apps.core.utils import parse_id

from .models import OfficerProfile


class OfficerFilter(filters.FilterSet):
    department = filters.CharFilter(method="filter_department")
    is_available = filters.BooleanFilter(field_name="is_available")
    is_active = filters.BooleanFilter(field_name="user__is_active")
    zone = filters.CharFilter(field_name="zone", lookup_expr="icontains")

    class Meta:
        model = OfficerProfile
        fields = ["department", "is_available", "is_active", "zone"]

    def filter_department(self, queryset, name, value):
        value = (value or "").strip()
        if not value:
            return queryset
        department_id = parse_id(value)
        if department_id is not None:
            return queryset.filter(department_id=department_id)
        if value.lower() in ("none", "null", "unassigned"):
            return queryset.filter(department__isnull=True)
        return queryset.filter(department__code__iexact=value)
