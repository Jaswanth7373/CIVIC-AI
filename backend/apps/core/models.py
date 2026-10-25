"""System-wide configuration models.

* ``AIConfiguration`` - singleton holding every tunable AI parameter (priority
  weights, thresholds, duplicate / hotspot / verification settings). Admins edit
  it from "System / AI Settings"; the AI engine receives it as a plain dict via
  ``AIConfiguration.load().to_engine_config()``.
* ``RiskZone`` - admin-defined sensitive places (schools, hospitals, junctions...)
  used by the location-risk factor of severity and priority.
* ``ContactMessage`` - messages from the public contact form.
"""
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone


class AIConfiguration(models.Model):
    # --- Priority engine weights (percent of the 0-100 score; must sum to 100) ---
    weight_severity = models.FloatField(default=40)
    weight_public_impact = models.FloatField(default=25)
    weight_location_risk = models.FloatField(default=15)
    weight_frequency = models.FloatField(default=10)
    weight_duplicates = models.FloatField(default=10)

    # --- Level thresholds (score >= threshold -> level). Defaults: 0-25 low, 26-50 medium, 51-75 high, 76-100 critical
    threshold_medium = models.PositiveSmallIntegerField(default=26)
    threshold_high = models.PositiveSmallIntegerField(default=51)
    threshold_critical = models.PositiveSmallIntegerField(default=76)

    # --- Multimodal fusion ---
    image_modality_weight = models.FloatField(default=0.55)
    text_modality_weight = models.FloatField(default=0.45)
    min_category_confidence = models.FloatField(
        default=0.30, help_text="Below this fused confidence the complaint is flagged for manual review"
    )

    # --- Duplicate detection ---
    duplicate_threshold = models.FloatField(default=0.72)
    duplicate_radius_m = models.PositiveIntegerField(default=300)
    duplicate_window_days = models.PositiveIntegerField(default=30)
    duplicate_text_weight = models.FloatField(default=0.40)
    duplicate_image_weight = models.FloatField(default=0.30)
    duplicate_location_weight = models.FloatField(default=0.30)

    # --- Hotspots (DBSCAN) ---
    hotspot_eps_m = models.PositiveIntegerField(default=400)
    hotspot_min_samples = models.PositiveSmallIntegerField(default=3)
    hotspot_alert_threshold = models.PositiveSmallIntegerField(default=5)

    # --- Resolution verification ---
    verification_resolved_threshold = models.PositiveSmallIntegerField(default=70)
    verification_partial_threshold = models.PositiveSmallIntegerField(default=45)

    # --- Automation ---
    auto_assign_officer = models.BooleanField(default=True)
    auto_verify_resolution = models.BooleanField(default=True)
    nearby_radius_m = models.PositiveIntegerField(default=500, help_text="Radius for nearby-complaint frequency")
    frequency_window_days = models.PositiveIntegerField(default=30)
    sla_alert_hours = models.PositiveIntegerField(default=48, help_text="Alert admins when high priority stays open")

    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "AI configuration"
        verbose_name_plural = "AI configuration"

    def __str__(self):
        return "CivicAI AI configuration"

    def clean(self):
        total = (
            self.weight_severity + self.weight_public_impact + self.weight_location_risk
            + self.weight_frequency + self.weight_duplicates
        )
        if abs(total - 100) > 0.01:
            raise ValidationError({"weight_severity": f"Priority weights must sum to 100 (currently {total:g})."})
        if not (0 < self.threshold_medium < self.threshold_high < self.threshold_critical <= 100):
            raise ValidationError({"threshold_medium": "Thresholds must satisfy 0 < medium < high < critical <= 100."})

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):  # singleton cannot be deleted
        return (0, {})

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def to_engine_config(self):
        """Plain dict consumed by the framework-independent ``ai`` package."""
        thresholds = {
            "medium": int(self.threshold_medium),
            "high": int(self.threshold_high),
            "critical": int(self.threshold_critical),
        }
        return {
            "priority": {
                "weights": {
                    "severity": float(self.weight_severity),
                    "public_impact": float(self.weight_public_impact),
                    "location_risk": float(self.weight_location_risk),
                    "frequency": float(self.weight_frequency),
                    "duplicates": float(self.weight_duplicates),
                },
                "thresholds": dict(thresholds),
            },
            "severity": {"thresholds": dict(thresholds)},
            "fusion": {
                "image_weight": float(self.image_modality_weight),
                "text_weight": float(self.text_modality_weight),
                "min_confidence": float(self.min_category_confidence),
            },
            "duplicate": {
                "threshold": float(self.duplicate_threshold),
                "radius_m": int(self.duplicate_radius_m),
                "window_days": int(self.duplicate_window_days),
                "weights": {
                    "text": float(self.duplicate_text_weight),
                    "image": float(self.duplicate_image_weight),
                    "location": float(self.duplicate_location_weight),
                },
            },
            "hotspot": {
                "eps_m": int(self.hotspot_eps_m),
                "min_samples": int(self.hotspot_min_samples),
                "alert_threshold": int(self.hotspot_alert_threshold),
            },
            "verification": {
                "resolved_threshold": int(self.verification_resolved_threshold),
                "partial_threshold": int(self.verification_partial_threshold),
            },
            "nearby_radius_m": int(self.nearby_radius_m),
            "frequency_window_days": int(self.frequency_window_days),
        }


class RiskZone(models.Model):
    class ZoneType(models.TextChoices):
        SCHOOL = "school", "School / College"
        HOSPITAL = "hospital", "Hospital"
        MARKET = "market", "Market / Commercial"
        HIGHWAY = "highway", "Highway / Arterial road"
        JUNCTION = "junction", "Traffic junction"
        TRANSIT = "transit", "Bus / Metro / Railway station"
        RESIDENTIAL = "residential", "Dense residential"
        INDUSTRIAL = "industrial", "Industrial"
        OTHER = "other", "Other"

    name = models.CharField(max_length=150)
    zone_type = models.CharField(max_length=20, choices=ZoneType.choices, default=ZoneType.OTHER, db_index=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    radius_m = models.PositiveIntegerField(default=300)
    risk_level = models.PositiveSmallIntegerField(default=3, help_text="1 (low) .. 5 (very high)")
    description = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.get_zone_type_display()})"

    def to_engine_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "zone_type": self.zone_type,
            "latitude": float(self.latitude),
            "longitude": float(self.longitude),
            "radius_m": int(self.radius_m),
            "risk_level": int(self.risk_level),
        }


class ContactMessage(models.Model):
    name = models.CharField(max_length=120)
    email = models.EmailField()
    subject = models.CharField(max_length=160)
    message = models.TextField()
    is_resolved = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.subject} - {self.email}"
