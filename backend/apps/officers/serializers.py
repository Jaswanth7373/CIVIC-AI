"""Serializers for officer management (/api/officers/) and the officer workload queue.

* ``OfficerSerializer``      -> OfficerOut (``id`` == user id, nested ``user``, department, capacity, live stats)
* ``OfficerWriteSerializer`` -> flat create/update payload; creates the ``User(role=officer)`` and its
  ``OfficerProfile`` in one database transaction
* ``OfficerMiniSerializer``  -> OfficerMini, re-exported from its canonical home ``apps.complaints.serializers``
* ``ComplaintListItemSerializer`` -> alias of the canonical ``ComplaintListSerializer`` (workload queue rows)

Live statistics: ``active_workload``, ``resolved_count`` and ``avg_rating`` come from
``apps.assignments.services.collect_officer_stats`` - the same aggregates the officer recommender, the
workload endpoint and the officer analytics use, so the numbers agree on every page. ``avg_resolution_hours``
is computed in Python from one batched query (``average_resolution_hours``) - timestamp arithmetic inside SQL
aggregates behaves differently on MySQL and SQLite (BUILD_SPEC section 0.5). A list page therefore costs a
constant number of queries however many officers it shows.
"""
from collections import defaultdict

from django.db import IntegrityError, transaction
from django.db.models.manager import BaseManager
from rest_framework import serializers

from apps.accounts.models import User
from apps.accounts.tokens import revoke_all_sessions
from apps.accounts.serializers import (
    EMAIL_TAKEN_MESSAGE,
    default_employee_id,
    email_in_use,
    normalize_email,
    run_password_validators,
    validate_phone_number,
)
from apps.complaints.models import Complaint
from apps.complaints.serializers import ComplaintListSerializer, DepartmentMiniSerializer, OfficerMiniSerializer
from apps.core.serializers import to_coordinate_decimal
from apps.core.utils import absolute_media_url
from apps.departments.models import Department
from apps.departments.serializers import clean_term_list

from .models import OfficerProfile

__all__ = [
    "ComplaintListItemSerializer", "OfficerMiniSerializer", "OfficerSerializer", "OfficerUserSerializer",
    "OfficerWriteSerializer", "attach_officer_stats", "average_resolution_hours",
]

#: The workload queue uses the canonical ComplaintList shape (BUILD_SPEC section 4.1).
ComplaintListItemSerializer = ComplaintListSerializer


def average_resolution_hours(officer_ids):
    """``{officer_user_id: mean hours from complaint creation to resolution}`` for resolved complaints.

    One query for any number of officers; the subtraction and averaging happen in Python.
    """
    officer_ids = [officer_id for officer_id in officer_ids if officer_id is not None]
    if not officer_ids:
        return {}
    totals, counts = defaultdict(float), defaultdict(int)
    rows = Complaint.objects.filter(
        assigned_officer_id__in=officer_ids, status__in=Complaint.RESOLVED_STATUSES, resolved_at__isnull=False
    ).values_list("assigned_officer_id", "created_at", "resolved_at")
    for officer_id, created_at, resolved_at in rows:
        hours = (resolved_at - created_at).total_seconds() / 3600.0
        if hours >= 0:  # ignore inconsistent historic rows instead of skewing the mean
            totals[officer_id] += hours
            counts[officer_id] += 1
    return {officer_id: round(totals[officer_id] / counts[officer_id], 1) for officer_id in counts}


def attach_officer_stats(profiles):
    """Attach the live statistics rendered by :class:`OfficerSerializer` to officer profiles.

    ``profile.officer_stats`` = ``apps.assignments.services.OfficerStats`` (workload, resolved count, ratings)
    and ``profile.stat_avg_resolution_hours``; three queries in total for any number of profiles.
    """
    from apps.assignments.services import collect_officer_stats

    profiles = list(profiles)
    ids = [profile.user_id for profile in profiles]
    stats = collect_officer_stats(ids)
    hours = average_resolution_hours(ids)
    for profile in profiles:
        profile.officer_stats = stats[profile.user_id]
        profile.stat_avg_resolution_hours = hours.get(profile.user_id)
    return profiles


class OfficerUserSerializer(serializers.ModelSerializer):
    """The ``user`` object nested in OfficerOut."""

    full_name = serializers.CharField(read_only=True)
    avatar = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "first_name", "last_name", "full_name", "phone", "avatar", "is_active", "last_login"]
        read_only_fields = fields

    def get_avatar(self, user):
        return absolute_media_url(self.context.get("request"), user.avatar)


class OfficerListSerializer(serializers.ListSerializer):
    """Loads the statistics of every officer of the page at once (:func:`attach_officer_stats`)."""

    def to_representation(self, data):
        officers = attach_officer_stats(data.all() if isinstance(data, BaseManager) else data)
        return super().to_representation(officers)


class OfficerSerializer(serializers.ModelSerializer):
    """OfficerOut. Statistics come from :func:`attach_officer_stats` (computed on demand for a single row)."""

    id = serializers.IntegerField(source="user_id", read_only=True)
    user = OfficerUserSerializer(read_only=True)
    department = DepartmentMiniSerializer(read_only=True)
    department_id = serializers.IntegerField(read_only=True, allow_null=True)
    base_latitude = serializers.FloatField(read_only=True, allow_null=True)
    base_longitude = serializers.FloatField(read_only=True, allow_null=True)
    active_workload = serializers.SerializerMethodField()
    resolved_count = serializers.SerializerMethodField()
    avg_resolution_hours = serializers.SerializerMethodField()
    avg_rating = serializers.SerializerMethodField()

    class Meta:
        model = OfficerProfile
        fields = [
            "id", "user", "department", "department_id", "employee_id", "designation", "zone", "base_latitude",
            "base_longitude", "max_active_complaints", "is_available", "skills", "joined_on", "active_workload",
            "resolved_count", "avg_resolution_hours", "avg_rating", "created_at",
        ]
        read_only_fields = fields
        list_serializer_class = OfficerListSerializer

    @staticmethod
    def _stats(profile):
        if not hasattr(profile, "officer_stats"):
            attach_officer_stats([profile])
        return profile.officer_stats

    def get_active_workload(self, profile):
        return self._stats(profile).active

    def get_resolved_count(self, profile):
        return self._stats(profile).resolved

    def get_avg_resolution_hours(self, profile):
        self._stats(profile)
        return profile.stat_avg_resolution_hours

    def get_avg_rating(self, profile):
        rating = self._stats(profile).average_rating
        return round(float(rating), 2) if rating is not None else None


class OfficerWriteSerializer(serializers.Serializer):
    """Create / update an officer from one flat payload::

        {email, password, first_name, last_name, phone, is_active, department, employee_id, designation, zone,
         base_latitude, base_longitude, max_active_complaints, is_available, skills, joined_on}

    * create: ``password`` is required and checked by Django's password validators; the account always
      gets ``role=officer``; a blank ``employee_id`` becomes ``EMP-<user id>``.
    * update: ``password`` is optional (blank = keep the current one).
    * deactivating the account (``is_active=false``) also marks the officer unavailable, so the
      recommendation engine stops assigning work to them.
    The instance handled by ``update`` / returned by ``create`` is the ``OfficerProfile``.
    """

    USER_FIELDS = ("email", "first_name", "last_name", "phone", "is_active")
    PROFILE_FIELDS = ("department", "employee_id", "designation", "zone", "base_latitude", "base_longitude",
                      "max_active_complaints", "is_available", "skills", "joined_on")

    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(write_only=True, required=False, allow_blank=True, trim_whitespace=False,
                                     max_length=128)
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)
    department = serializers.PrimaryKeyRelatedField(queryset=Department.objects.all(), allow_null=True,
                                                    required=False)
    employee_id = serializers.CharField(max_length=30, required=False, allow_blank=True)
    designation = serializers.CharField(max_length=100, required=False, allow_blank=True)
    zone = serializers.CharField(max_length=120, required=False, allow_blank=True)
    base_latitude = serializers.FloatField(min_value=-90, max_value=90, required=False, allow_null=True)
    base_longitude = serializers.FloatField(min_value=-180, max_value=180, required=False, allow_null=True)
    max_active_complaints = serializers.IntegerField(min_value=1, max_value=200, required=False)
    is_available = serializers.BooleanField(required=False)
    skills = serializers.JSONField(required=False)
    joined_on = serializers.DateField(required=False, allow_null=True)

    @property
    def existing_user(self):
        return self.instance.user if self.instance is not None else None

    def validate_email(self, value):
        email = normalize_email(value)
        if email_in_use(email, exclude_pk=getattr(self.existing_user, "pk", None)):
            raise serializers.ValidationError(EMAIL_TAKEN_MESSAGE)
        return email

    def validate_first_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("First name is required.")
        return value

    def validate_last_name(self, value):
        return " ".join((value or "").split())

    def validate_phone(self, value):
        return validate_phone_number(value)

    def validate_employee_id(self, value):
        value = (value or "").strip().upper()
        if value:
            taken = OfficerProfile.objects.filter(employee_id__iexact=value)
            if self.instance is not None:
                taken = taken.exclude(pk=self.instance.pk)
            if taken.exists():
                raise serializers.ValidationError("Another officer already has this employee id.")
        return value

    def validate_designation(self, value):
        return " ".join((value or "").split())

    def validate_zone(self, value):
        return " ".join((value or "").split())

    def validate_skills(self, value):
        return clean_term_list(value, label="Skills", lowercase=False, max_items=30)

    def validate_department(self, department):
        current_id = getattr(self.instance, "department_id", None)
        if department is not None and not department.is_active and department.pk != current_id:
            raise serializers.ValidationError(f"{department.name} is inactive; activate it first.")
        return department

    def validate(self, attrs):
        errors = {}
        password = attrs.get("password") or ""
        if self.instance is None and not password:
            errors["password"] = ["A password is required for a new officer account."]

        latitude = attrs.get("base_latitude", getattr(self.instance, "base_latitude", None))
        longitude = attrs.get("base_longitude", getattr(self.instance, "base_longitude", None))
        if (latitude is None) != (longitude is None):
            errors["base_latitude"] = ["Provide both base latitude and base longitude, or neither."]
        if errors:
            raise serializers.ValidationError(errors)

        if password:
            user = self.existing_user or User()
            candidate = User(
                email=attrs.get("email", user.email),
                first_name=attrs.get("first_name", user.first_name),
                last_name=attrs.get("last_name", user.last_name),
            )
            run_password_validators(password, candidate)
        return attrs

    @staticmethod
    def _profile_values(validated_data):
        values = {name: validated_data[name] for name in OfficerWriteSerializer.PROFILE_FIELDS
                  if name in validated_data}
        for name in ("base_latitude", "base_longitude"):
            if values.get(name) is not None:
                values[name] = to_coordinate_decimal(values[name])
        return values

    def create(self, validated_data):
        user_values = {name: validated_data[name] for name in self.USER_FIELDS if name in validated_data}
        profile_values = self._profile_values(validated_data)
        if not profile_values.get("designation"):
            profile_values.pop("designation", None)  # model default "Field Officer"
        if user_values.get("is_active") is False:
            profile_values["is_available"] = False
        try:
            with transaction.atomic():
                user = User.objects.create_user(password=validated_data["password"], role=User.Role.OFFICER,
                                                **user_values)
                if not profile_values.get("employee_id"):
                    profile_values["employee_id"] = default_employee_id(user)
                return OfficerProfile.objects.create(user=user, **profile_values)
        except IntegrityError:
            # Unique e-mail / employee id taken by a concurrent request: nothing was saved (atomic block).
            raise serializers.ValidationError(
                {"non_field_errors": ["The e-mail address or employee id was just taken by another account."]}
            )

    def update(self, profile, validated_data):
        user = profile.user
        password = validated_data.get("password") or ""
        try:
            with transaction.atomic():
                for name in self.USER_FIELDS:
                    if name in validated_data:
                        setattr(user, name, validated_data[name])
                if password:
                    user.set_password(password)
                user.save()
                if password:  # a reset password ends the officer's existing sessions (apps/accounts/tokens.py)
                    revoke_all_sessions(user)
                for name, value in self._profile_values(validated_data).items():
                    setattr(profile, name, value)
                if not profile.employee_id:
                    profile.employee_id = default_employee_id(user)
                if not user.is_active:
                    profile.is_available = False
                profile.save()
        except IntegrityError:
            raise serializers.ValidationError(
                {"non_field_errors": ["The e-mail address or employee id was just taken by another account."]}
            )
        return profile

