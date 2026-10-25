"""Query-string filter building blocks shared by every list endpoint (django-filter).

Values in a query string are attacker-controlled, so the filters below reject anything the database cannot
store with a clean HTTP 400 instead of letting it reach the SQL driver:

* :class:`IdFilter` - a primary key: a whole number from 1 to 2**63-1. django-filter's ``NumberFilter`` accepts
  decimals and numbers such as ``1e30``, which SQLite cannot bind (OverflowError, HTTP 500) and which silently
  truncate (``?citizen=1.5`` matched citizen 1).
* :class:`BoundedDateFilter` - a calendar day between 2000-01-01 and 2100-12-31 (the analytics window).
  ``date_to=9999-12-31`` used to overflow when the inclusive end (``day + 1``) was computed, and
  ``date_from=0001-01-01`` when midnight was converted to UTC.
"""
from datetime import date

from django import forms
from django.core.exceptions import ValidationError
from django_filters import rest_framework as filters

from .utils import MAX_DB_ID

MIN_FILTER_DATE = date(2000, 1, 1)
MAX_FILTER_DATE = date(2100, 12, 31)


def validate_filter_date(value):
    """Shared date window of every list / analytics filter (raises Django ValidationError)."""
    if value is not None and not MIN_FILTER_DATE <= value <= MAX_FILTER_DATE:
        raise ValidationError(
            f"Date must be between {MIN_FILTER_DATE.isoformat()} and {MAX_FILTER_DATE.isoformat()}.",
            code="date_out_of_range",
        )


class IdFilter(filters.Filter):
    """``?officer=12`` - an exact primary key (1 .. 2**63-1); anything else is a 400 validation error."""

    field_class = forms.IntegerField

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("min_value", 1)
        kwargs.setdefault("max_value", MAX_DB_ID)
        super().__init__(*args, **kwargs)


class BoundedDateFilter(filters.DateFilter):
    """``DateFilter`` limited to the 2000-01-01 .. 2100-12-31 window (see :func:`validate_filter_date`)."""

    def __init__(self, *args, **kwargs):
        kwargs["validators"] = [*kwargs.get("validators", ()), validate_filter_date]
        super().__init__(*args, **kwargs)
