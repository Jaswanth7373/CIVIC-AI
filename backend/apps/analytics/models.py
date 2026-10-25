"""Analytics persistence: hotspot alerts raised by the DBSCAN hotspot scan.

All dashboard numbers are computed live from the complaint tables; only
alerts are stored (so the same hotspot does not alert admins repeatedly).
"""
from django.db import models
from django.utils import timezone


class HotspotAlert(models.Model):
    cluster_key = models.CharField(max_length=80, db_index=True, help_text="Rounded centroid + category, for de-dup")
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    radius_m = models.FloatField(default=0)
    complaint_count = models.PositiveIntegerField(default=0)
    dominant_category = models.ForeignKey(
        "departments.CivicCategory", on_delete=models.SET_NULL, null=True, blank=True, related_name="hotspot_alerts"
    )
    severity = models.CharField(max_length=10, blank=True)
    area_name = models.CharField(max_length=160, blank=True)
    complaint_ids = models.JSONField(default=list, blank=True)
    is_acknowledged = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"Hotspot {self.area_name or self.cluster_key} ({self.complaint_count})"
