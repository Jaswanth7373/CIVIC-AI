"""Serializers for system-wide settings: AI configuration, risk zones, contact messages and geo queries."""
import copy
from decimal import ROUND_HALF_UP, Decimal

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from apps.complaints.serializers import UserMiniSerializer

from .geocoding import SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_MAX_LENGTH
from .models import AIConfiguration, ContactMessage, RiskZone

COORDINATE_QUANTUM = Decimal("0.000001")  # Decimal(9, 6) columns: ~0.1 m precision


def to_coordinate_decimal(value):
    """Round a float coordinate to the 6 decimal places stored by the ``DecimalField(9, 6)`` columns."""
    return Decimal(str(value)).quantize(COORDINATE_QUANTUM, rounding=ROUND_HALF_UP)


# Allowed ranges for the AI configuration. Besides the model's own clean() (weights sum to 100, ordered
# thresholds) they keep the engine inputs meaningful: e.g. DBSCAN needs min_samples >= 2 and eps > 0,
# probabilities / similarities live in 0..1, look-back windows are at least one day.
AI_CONFIG_LIMITS = {
    "weight_severity": (0, 100), "weight_public_impact": (0, 100), "weight_location_risk": (0, 100),
    "weight_frequency": (0, 100), "weight_duplicates": (0, 100),
    "threshold_medium": (1, 100), "threshold_high": (1, 100), "threshold_critical": (1, 100),
    "image_modality_weight": (0, 1), "text_modality_weight": (0, 1), "min_category_confidence": (0, 1),
    "duplicate_threshold": (0.1, 1), "duplicate_radius_m": (10, 5000), "duplicate_window_days": (1, 365),
    "duplicate_text_weight": (0, 1), "duplicate_image_weight": (0, 1), "duplicate_location_weight": (0, 1),
    "hotspot_eps_m": (50, 5000), "hotspot_min_samples": (2, 100), "hotspot_alert_threshold": (2, 1000),
    "verification_resolved_threshold": (1, 100), "verification_partial_threshold": (1, 100),
    "nearby_radius_m": (50, 10000), "frequency_window_days": (1, 365), "sla_alert_hours": (1, 720),
}


class AIConfigurationSerializer(serializers.ModelSerializer):
    """Every AIConfiguration field + ``updated_by`` (UserMini|null) + ``updated_at``.

    Validation applies the field ranges above, then builds a *copy* of the singleton with the submitted
    values and runs the model's own ``clean()`` (priority weights must sum to 100, thresholds must satisfy
    0 < medium < high < critical <= 100). Errors come back as HTTP 400 with per-field messages and the stored
    configuration is untouched.
    """

    updated_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = AIConfiguration
        fields = "__all__"
        read_only_fields = ["id", "updated_by", "updated_at"]
        extra_kwargs = {name: {"min_value": low, "max_value": high} for name, (low, high) in AI_CONFIG_LIMITS.items()}

    def validate(self, attrs):
        candidate = copy.copy(self.instance) if self.instance is not None else AIConfiguration()
        for name, value in attrs.items():
            setattr(candidate, name, value)
        try:
            candidate.clean()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict)

        errors = {}
        if candidate.image_modality_weight + candidate.text_modality_weight <= 0:
            errors["image_modality_weight"] = ["Image and text modality weights cannot both be 0."]
        if (candidate.duplicate_text_weight + candidate.duplicate_image_weight
                + candidate.duplicate_location_weight) <= 0:
            errors["duplicate_text_weight"] = ["At least one duplicate-similarity weight must be above 0."]
        if candidate.verification_partial_threshold >= candidate.verification_resolved_threshold:
            errors["verification_partial_threshold"] = [
                "The partially-resolved threshold must be lower than the resolved threshold."
            ]
        if errors:
            raise serializers.ValidationError(errors)
        return attrs


class RiskZoneSerializer(serializers.ModelSerializer):
    """Admin-defined sensitive places (schools, hospitals, junctions...) used by the location-risk factor."""

    latitude = serializers.FloatField(min_value=-90, max_value=90)
    longitude = serializers.FloatField(min_value=-180, max_value=180)
    zone_type_display = serializers.CharField(source="get_zone_type_display", read_only=True)

    class Meta:
        model = RiskZone
        fields = [
            "id", "name", "zone_type", "zone_type_display", "latitude", "longitude", "radius_m", "risk_level",
            "description", "is_active", "created_at",
        ]
        read_only_fields = ["id", "created_at"]
        extra_kwargs = {
            "radius_m": {"min_value": 10, "max_value": 10000},
            "risk_level": {"min_value": 1, "max_value": 5},
        }

    def validate_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Zone name is required.")
        return value

    def validate_latitude(self, value):
        return to_coordinate_decimal(value)

    def validate_longitude(self, value):
        return to_coordinate_decimal(value)


class ContactMessageSerializer(serializers.ModelSerializer):
    """Public contact form: ``{name, email, subject, message}``."""

    class Meta:
        model = ContactMessage
        fields = ["id", "name", "email", "subject", "message", "is_resolved", "created_at"]
        read_only_fields = ["id", "is_resolved", "created_at"]
        extra_kwargs = {"message": {"max_length": 5000}}

    @staticmethod
    def _clean(value, label, minimum):
        value = (value or "").strip()
        if len(value) < minimum:
            raise serializers.ValidationError(f"{label} must be at least {minimum} characters long.")
        return value

    def validate_name(self, value):
        return " ".join(self._clean(value, "Name", 2).split())

    def validate_email(self, value):
        return value.strip().lower()

    def validate_subject(self, value):
        return " ".join(self._clean(value, "Subject", 3).split())

    def validate_message(self, value):
        return self._clean(value, "Message", 10)


class ContactMessageAdminSerializer(ContactMessageSerializer):
    """Admin view of a contact message; only ``is_resolved`` can be changed."""

    class Meta(ContactMessageSerializer.Meta):
        read_only_fields = ["id", "name", "email", "subject", "message", "created_at"]


class ReverseGeocodeQuerySerializer(serializers.Serializer):
    """``?lat=&lng=`` for /geo/reverse/ (``lon`` is accepted as an alias of ``lng``)."""

    lat = serializers.FloatField(min_value=-90, max_value=90)
    lng = serializers.FloatField(min_value=-180, max_value=180)

    def to_internal_value(self, data):
        if hasattr(data, "get") and data.get("lng") in (None, "") and data.get("lon") not in (None, ""):
            data = {"lat": data.get("lat"), "lng": data.get("lon")}
        return super().to_internal_value(data)


class PlaceSearchQuerySerializer(serializers.Serializer):
    """``?q=&limit=`` for /geo/search/."""

    q = serializers.CharField(max_length=SEARCH_MAX_LENGTH, trim_whitespace=True)
    limit = serializers.IntegerField(min_value=1, max_value=SEARCH_LIMIT_MAX, default=SEARCH_LIMIT_DEFAULT)
