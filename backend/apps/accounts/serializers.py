"""Serializers for authentication, the signed-in user's profile and admin user management.

Shapes (docs/BUILD_SPEC.md section 4):

* ``UserMiniSerializer``  -> ``{"id", "full_name", "email", "role", "avatar", "phone"}`` - re-exported from its
  canonical home ``apps.complaints.serializers`` so a user looks the same in every endpoint
* ``UserSerializer``      -> the full ``User`` shape incl. ``citizen_profile``, ``officer_profile`` and ``stats``
* ``AdminUserSerializer`` -> ``User`` + ``complaint_count`` + ``civic_points`` (admin user list rows)

Security notes (viva):
* E-mail addresses are normalised to lower case and uniqueness is checked case-insensitively, so
  ``Ravi@x.com`` and ``ravi@x.com`` can never be two accounts.
* Passwords go through Django's configured validators (length, common-password list, numeric-only and
  similarity to the user's own name/e-mail) and are stored only via ``create_user`` / ``set_password``
  (salted PBKDF2 hashes). They are ``write_only`` and never serialised back.
* Registration always creates a *citizen*: the role is not an input field, so nobody can self-register as
  an officer or admin.
"""
import json
import re

from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import exceptions, serializers
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.serializers import TokenRefreshSerializer as SimpleJWTRefreshSerializer
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.utils import get_md5_hash_password

from apps.complaints.models import Complaint
from apps.complaints.serializers import DepartmentMiniSerializer, UserMiniSerializer  # noqa: F401 (re-export)
from apps.core.permissions import user_role
from apps.core.utils import absolute_media_url
from apps.core.fields import SafeImageField
from apps.officers.models import OfficerProfile

from .models import CitizenProfile, User

PHONE_RE = re.compile(r"^\+?[0-9][0-9\s\-]{5,18}[0-9]$")
PINCODE_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z \-]{2,9}$")
LANGUAGE_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$")
CITIZEN_PROFILE_FIELDS = (
    "address", "area", "city", "pincode", "date_of_birth", "gender", "preferred_language", "email_notifications",
)
EMAIL_TAKEN_MESSAGE = "An account with this email address already exists."
AVATAR_MAX_SIDE = 1024  # profile pictures are shown small; the stored copy is downscaled to this longest side


# ---------------------------------------------------------------------------------------------------------------
# Helpers shared by the serializers in this module (and the officers app)
# ---------------------------------------------------------------------------------------------------------------
def normalize_email(value):
    return (value or "").strip().lower()


def email_in_use(email, *, exclude_pk=None):
    return User.objects.filter(email__iexact=email).exclude(pk=exclude_pk).exists()


def validate_phone_number(value):
    """Optional phone number: digits with optional leading ``+``, spaces or hyphens; 7-15 digits in total."""
    value = (value or "").strip()
    if not value:
        return ""
    digits = re.sub(r"\D", "", value)
    if not PHONE_RE.match(value) or not 7 <= len(digits) <= 15:
        raise serializers.ValidationError("Enter a valid phone number (7-15 digits, optional leading +).")
    return value


def run_password_validators(password, user, *, field="password"):
    """Run ``AUTH_PASSWORD_VALIDATORS`` and re-raise failures as a DRF field error."""
    try:
        password_validation.validate_password(password, user=user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError({field: list(exc.messages)})


def related_or_none(instance, name):
    """Reverse one-to-one access (``user.citizen_profile``) that returns None instead of raising."""
    try:
        return getattr(instance, name)
    except (AttributeError, CitizenProfile.DoesNotExist, OfficerProfile.DoesNotExist):
        return None


def default_employee_id(user):
    """Unique fallback employee id for officers created without one: ``EMP-00042`` (from the user id)."""
    base = f"EMP-{user.pk:05d}"
    candidate, suffix = base, 2
    while OfficerProfile.objects.filter(employee_id=candidate).exclude(user=user).exists():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def ensure_officer_profile(user):
    """Keep the invariant "every officer-role user has an OfficerProfile".

    Officers are normally created through /api/officers/, but an admin may also create a user with
    role=officer (or promote someone) via /api/users/. A minimal profile is created then, so the officer is
    listed in Officer Management (where department, zone and capacity can be completed) and can be
    assigned complaints.
    """
    if user.role != User.Role.OFFICER:
        return None
    profile, _ = OfficerProfile.objects.get_or_create(user=user, defaults={"employee_id": default_employee_id(user)})
    return profile


def user_complaint_count(user):
    """Role-aware complaint count used in ``stats``: officers -> complaints assigned to them, everyone else ->
    complaints they reported. List endpoints annotate the same number as ``complaint_count``."""
    if user.role == User.Role.OFFICER:
        return Complaint.objects.filter(assigned_officer=user).count()
    return Complaint.objects.filter(citizen=user).count()


# ---------------------------------------------------------------------------------------------------------------
# Read shapes (UserMiniSerializer is imported from apps.complaints.serializers, the canonical shapes module)
# ---------------------------------------------------------------------------------------------------------------
class CitizenProfileSerializer(serializers.ModelSerializer):
    """Citizen profile fields (read + write). ``civic_points`` is earned, never written by the client."""

    class Meta:
        model = CitizenProfile
        fields = [*CITIZEN_PROFILE_FIELDS, "civic_points", "updated_at"]
        read_only_fields = ["civic_points", "updated_at"]

    def validate_pincode(self, value):
        value = (value or "").strip()
        if value and not PINCODE_RE.match(value):
            raise serializers.ValidationError("Enter a valid PIN / postal code.")
        return value

    def validate_date_of_birth(self, value):
        if value is None:
            return value
        today = timezone.localdate()
        if value > today:
            raise serializers.ValidationError("Date of birth cannot be in the future.")
        if value.year < 1900:
            raise serializers.ValidationError("Enter a realistic date of birth.")
        return value

    def validate_preferred_language(self, value):
        value = (value or "en").strip()
        if not LANGUAGE_RE.match(value):
            raise serializers.ValidationError("Use a language code such as en, te or hi.")
        return value


class OfficerProfileSummarySerializer(serializers.ModelSerializer):
    """OfficerProfileOut embedded in the ``User`` shape (``active_workload`` is added by ``UserSerializer``)."""

    department = DepartmentMiniSerializer(read_only=True)
    department_id = serializers.IntegerField(read_only=True, allow_null=True)
    base_latitude = serializers.FloatField(read_only=True, allow_null=True)
    base_longitude = serializers.FloatField(read_only=True, allow_null=True)

    class Meta:
        model = OfficerProfile
        fields = [
            "department", "department_id", "employee_id", "designation", "zone", "base_latitude", "base_longitude",
            "max_active_complaints", "is_available", "skills", "joined_on",
        ]
        read_only_fields = fields


class UserSerializer(serializers.ModelSerializer):
    """The full ``User`` shape returned by login, register, /auth/profile/ and the admin user endpoints.

    The counters in ``stats`` (and ``officer_profile.active_workload``) are read from queryset annotations
    when present - the admin list annotates them in SQL to avoid N+1 queries - and computed with one small
    query otherwise (single-object endpoints).
    """

    full_name = serializers.CharField(read_only=True)
    role = serializers.SerializerMethodField()
    avatar = serializers.SerializerMethodField()
    citizen_profile = serializers.SerializerMethodField()
    officer_profile = serializers.SerializerMethodField()
    stats = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id", "email", "first_name", "last_name", "full_name", "role", "phone", "avatar", "is_active",
            "date_joined", "last_login", "citizen_profile", "officer_profile", "stats",
        ]
        read_only_fields = fields

    def get_role(self, user):
        return user_role(user)

    def get_avatar(self, user):
        return absolute_media_url(self.context.get("request"), user.avatar)

    def get_citizen_profile(self, user):
        profile = related_or_none(user, "citizen_profile")
        return CitizenProfileSerializer(profile, context=self.context).data if profile is not None else None

    def get_officer_profile(self, user):
        profile = related_or_none(user, "officer_profile")
        if profile is None:
            return None
        data = OfficerProfileSummarySerializer(profile, context=self.context).data
        workload = getattr(user, "active_workload_count", None)
        data["active_workload"] = workload if workload is not None else profile.active_workload
        return data

    def get_stats(self, user):
        complaints = getattr(user, "complaint_count", None)
        if complaints is None:
            complaints = user_complaint_count(user)
        points = getattr(user, "civic_points", None)
        if points is None:
            profile = related_or_none(user, "citizen_profile")
            points = profile.civic_points if profile is not None else 0
        return {"complaints": complaints, "civic_points": points}


class AdminUserSerializer(UserSerializer):
    """Admin user-list row: ``User`` + ``complaint_count`` + ``civic_points`` (SQL annotations)."""

    complaint_count = serializers.IntegerField(read_only=True)
    civic_points = serializers.IntegerField(read_only=True)

    class Meta(UserSerializer.Meta):
        fields = [*UserSerializer.Meta.fields, "complaint_count", "civic_points"]
        read_only_fields = fields


# ---------------------------------------------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------------------------------------------
class RegisterSerializer(serializers.Serializer):
    """Citizen self-registration: ``{email, password, confirm_password, first_name, last_name, phone?}``."""

    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    confirm_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default="")
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default="")

    def validate_email(self, value):
        email = normalize_email(value)
        if email_in_use(email):
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

    def validate(self, attrs):
        if attrs["password"] != attrs["confirm_password"]:
            raise serializers.ValidationError({"confirm_password": ["Passwords do not match."]})
        # Unsaved instance so UserAttributeSimilarityValidator can compare against the e-mail and names.
        candidate = User(email=attrs["email"], first_name=attrs["first_name"], last_name=attrs.get("last_name", ""))
        run_password_validators(attrs["password"], candidate)
        return attrs

    def create(self, validated_data):
        validated_data.pop("confirm_password")
        try:
            with transaction.atomic():
                # role is fixed: public registration can only ever create citizens.
                return User.objects.create_user(role=User.Role.CITIZEN, **validated_data)
        except IntegrityError:
            # Two simultaneous sign-ups with the same e-mail: the unique index wins, report it as a field error.
            raise serializers.ValidationError({"email": [EMAIL_TAKEN_MESSAGE]})


class LoginSerializer(serializers.Serializer):
    """Shape validation for ``{email, password}``; authentication itself happens in ``LoginView``.

    ``email`` is a plain CharField on purpose: a malformed address must get the same generic
    "Invalid email or password." answer as a wrong password (no hints for attackers).
    """

    email = serializers.CharField(max_length=254)
    password = serializers.CharField(trim_whitespace=False, max_length=128)

    def validate_email(self, value):
        return normalize_email(value)


class LogoutSerializer(serializers.Serializer):
    refresh = serializers.CharField()


class TokenRefreshSerializer(SimpleJWTRefreshSerializer):
    """Refresh-token rotation (``ROTATE_REFRESH_TOKENS`` + ``BLACKLIST_AFTER_ROTATION``) with three guarantees on
    top of simplejwt's own serializer:

    * **Exactly one rotation per token.** simplejwt checks the blacklist when the token is decoded and blacklists
      it afterwards, so concurrent requests with the same token could all pass the check and each mint a new
      token family. Here the rotation only proceeds for the request that *created* the blacklist row (a unique
      key in the database); every other one gets the regular 401 "Token is blacklisted".
    * **Password changes end sessions.** A refresh token whose password fingerprint (``CHECK_REVOKE_TOKEN``) no
      longer matches the account is rejected, like an access token.
    * A hard-deleted or deactivated account is a 401, not a 500.
    """

    def validate(self, attrs):
        refresh = self.token_class(attrs["refresh"])  # signature, expiry, token type and blacklist checks
        user = self._active_user(refresh)
        if jwt_settings.CHECK_REVOKE_TOKEN and (
            refresh.payload.get(jwt_settings.REVOKE_TOKEN_CLAIM) != get_md5_hash_password(user.password)
        ):
            raise exceptions.AuthenticationFailed("The user's password has been changed.", code="password_changed")

        data = {"access": str(refresh.access_token)}
        if jwt_settings.ROTATE_REFRESH_TOKENS:
            if jwt_settings.BLACKLIST_AFTER_ROTATION:
                _, created = refresh.blacklist()
                if not created:  # a concurrent request rotated this very token first
                    raise TokenError("Token is blacklisted")
            refresh.set_jti()
            refresh.set_exp()
            refresh.set_iat()
            refresh.outstand()
            data["refresh"] = str(refresh)
        return data

    @staticmethod
    def _active_user(refresh):
        user_id = refresh.payload.get(jwt_settings.USER_ID_CLAIM)
        user = User.objects.filter(**{jwt_settings.USER_ID_FIELD: user_id}).first() if user_id else None
        if user is None or not jwt_settings.USER_AUTHENTICATION_RULE(user):
            raise exceptions.AuthenticationFailed(
                "No active account found for the given token.", code="no_active_account"
            )
        return user


class ChangePasswordSerializer(serializers.Serializer):
    """``{old_password, new_password}`` (+ optional ``confirm_password`` checked when sent)."""

    old_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    new_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    confirm_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128, required=False)

    def validate_old_password(self, value):
        if not self.context["request"].user.check_password(value):
            raise serializers.ValidationError("Your current password is incorrect.")
        return value

    def validate(self, attrs):
        if attrs["old_password"] == attrs["new_password"]:
            raise serializers.ValidationError(
                {"new_password": ["The new password must be different from the current password."]}
            )
        if "confirm_password" in attrs and attrs["confirm_password"] != attrs["new_password"]:
            raise serializers.ValidationError({"confirm_password": ["Passwords do not match."]})
        run_password_validators(attrs["new_password"], self.context["request"].user, field="new_password")
        return attrs

    def save(self, **kwargs):
        user = self.context["request"].user
        user.set_password(self.validated_data["new_password"])
        user.save(update_fields=["password", "updated_at"])
        return user


# ---------------------------------------------------------------------------------------------------------------
# Profile update (PATCH/PUT /api/auth/profile/)
# ---------------------------------------------------------------------------------------------------------------
class ProfileUpdateSerializer(serializers.ModelSerializer):
    """Updates the signed-in user's own profile from JSON *or* multipart form data.

    Accepted: ``first_name, last_name, phone, avatar (file), remove_avatar`` and, for citizens,
    ``citizen_profile: {address, area, city, pincode, date_of_birth, gender, preferred_language,
    email_notifications}``. Multipart forms cannot nest objects, so the citizen fields may also arrive flat
    (``address=...``), as ``citizen_profile[address]`` / ``citizen_profile.address`` or as a JSON string in
    ``citizen_profile``; ``to_internal_value`` folds all of these into the nested dict. The e-mail (login
    identity) and role cannot be changed here.
    """

    avatar = SafeImageField(required=False, allow_null=True, max_side=AVATAR_MAX_SIDE)
    remove_avatar = serializers.BooleanField(required=False, write_only=True)
    citizen_profile = CitizenProfileSerializer(required=False)

    class Meta:
        model = User
        fields = ["first_name", "last_name", "phone", "avatar", "remove_avatar", "citizen_profile"]

    def to_internal_value(self, data):
        return super().to_internal_value(self._fold_citizen_fields(data))

    @staticmethod
    def _fold_citizen_fields(data):
        if not hasattr(data, "keys"):
            return data  # not a mapping: let DRF report the type error
        plain = {key: data.get(key) for key in data.keys()}  # QueryDict -> single values (files included)
        nested = plain.pop("citizen_profile", None)
        if isinstance(nested, str):
            try:
                nested = json.loads(nested) if nested.strip() else {}
            except ValueError:
                raise serializers.ValidationError({"citizen_profile": ["Send citizen_profile as a JSON object."]})
        if nested is not None and not isinstance(nested, dict):
            plain["citizen_profile"] = nested  # wrong type - the nested serializer produces the error
            return plain
        nested = dict(nested or {})
        for field in CITIZEN_PROFILE_FIELDS:
            for key in (field, f"citizen_profile[{field}]", f"citizen_profile.{field}"):
                if key in plain:
                    nested[field] = plain.pop(key)
        if nested.get("date_of_birth") == "":
            nested["date_of_birth"] = None  # an empty form input clears the date
        if nested:
            plain["citizen_profile"] = nested
        if plain.get("avatar") == "":
            plain.pop("avatar")  # empty file input = "no change" (use remove_avatar or null to delete)
        return plain

    def validate_first_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("First name cannot be empty.")
        return value

    def validate_last_name(self, value):
        return " ".join((value or "").split())

    def validate_phone(self, value):
        return validate_phone_number(value)

    def update(self, user, validated_data):
        citizen_data = validated_data.pop("citizen_profile", None)
        remove_avatar = validated_data.pop("remove_avatar", False)
        avatar_sent = "avatar" in validated_data
        new_avatar = validated_data.pop("avatar", None)
        old_avatar_name = user.avatar.name if user.avatar else ""

        with transaction.atomic():
            for attr, value in validated_data.items():
                setattr(user, attr, value)
            if new_avatar is not None:
                user.avatar = new_avatar
            elif remove_avatar or avatar_sent:
                user.avatar = None
            user.save()
            if citizen_data and user.role == User.Role.CITIZEN:
                profile, _ = CitizenProfile.objects.get_or_create(user=user)
                for attr, value in citizen_data.items():
                    setattr(profile, attr, value)
                profile.save()

        new_avatar_name = user.avatar.name if user.avatar else ""
        if old_avatar_name and old_avatar_name != new_avatar_name:
            storage = user._meta.get_field("avatar").storage
            transaction.on_commit(lambda: storage.delete(old_avatar_name))  # no orphaned files in media/
        return user


# ---------------------------------------------------------------------------------------------------------------
# Admin user management (/api/users/)
# ---------------------------------------------------------------------------------------------------------------
class AdminUserCreateSerializer(serializers.Serializer):
    """Admin creates a user of any role. Officers get a minimal OfficerProfile (see ensure_officer_profile)."""

    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default="")
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default="")
    role = serializers.ChoiceField(choices=User.Role.choices, default=User.Role.CITIZEN)
    is_active = serializers.BooleanField(required=False, default=True)

    def validate_email(self, value):
        email = normalize_email(value)
        if email_in_use(email):
            raise serializers.ValidationError(EMAIL_TAKEN_MESSAGE)
        return email

    def validate_first_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("First name is required.")
        return value

    def validate_phone(self, value):
        return validate_phone_number(value)

    def validate(self, attrs):
        candidate = User(email=attrs["email"], first_name=attrs["first_name"], last_name=attrs.get("last_name", ""))
        run_password_validators(attrs["password"], candidate)
        return attrs

    def create(self, validated_data):
        try:
            with transaction.atomic():
                user = User.objects.create_user(**validated_data)
                ensure_officer_profile(user)
                return user
        except IntegrityError:
            raise serializers.ValidationError({"email": [EMAIL_TAKEN_MESSAGE]})


class AdminUserUpdateSerializer(serializers.ModelSerializer):
    """Admin edits ``first_name, last_name, phone, is_active, role`` (and may correct the e-mail).

    Guard rails: an admin cannot deactivate or change the role of their own account (no accidental
    lock-out), and only a superuser may modify a superuser account.
    """

    email = serializers.EmailField(max_length=254, required=False)

    class Meta:
        model = User
        fields = ["email", "first_name", "last_name", "phone", "is_active", "role"]

    def validate_email(self, value):
        email = normalize_email(value)
        if email_in_use(email, exclude_pk=self.instance.pk):
            raise serializers.ValidationError(EMAIL_TAKEN_MESSAGE)
        return email

    def validate_first_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("First name cannot be empty.")
        return value

    def validate_phone(self, value):
        return validate_phone_number(value)

    def validate(self, attrs):
        actor = self.context["request"].user
        if self.instance.is_superuser and not actor.is_superuser:
            raise exceptions.PermissionDenied("Only a superuser can modify a superuser account.")
        if self.instance.pk == actor.pk:
            errors = {}
            if attrs.get("is_active") is False:
                errors["is_active"] = ["You cannot deactivate your own account."]
            if "role" in attrs and attrs["role"] != self.instance.role:
                errors["role"] = ["You cannot change your own role."]
            if errors:
                raise serializers.ValidationError(errors)
        return attrs

    def update(self, instance, validated_data):
        with transaction.atomic():
            user = super().update(instance, validated_data)
            ensure_officer_profile(user)
            if not user.is_active:
                OfficerProfile.objects.filter(user=user).update(is_available=False)
        return user
