"""Officer assignments (full history: auto / manual / reassignment)."""
from django.conf import settings
from django.db import models
from django.utils import timezone


class ComplaintAssignment(models.Model):
    class Type(models.TextChoices):
        AUTO = "auto", "Automatic (AI recommended)"
        MANUAL = "manual", "Manual"
        REASSIGNMENT = "reassignment", "Reassignment"

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        COMPLETED = "completed", "Completed"
        REASSIGNED = "reassigned", "Reassigned"
        REJECTED = "rejected", "Rejected"
        CANCELLED = "cancelled", "Cancelled"

    complaint = models.ForeignKey("complaints.Complaint", on_delete=models.CASCADE, related_name="assignments")
    officer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assignments")
    department = models.ForeignKey(
        "departments.Department", on_delete=models.SET_NULL, null=True, blank=True, related_name="assignments"
    )
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="assignments_made",
        help_text="Null when assigned automatically by the recommendation engine",
    )
    assignment_type = models.CharField(max_length=14, choices=Type.choices, default=Type.AUTO)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.ACTIVE, db_index=True)
    is_active = models.BooleanField(default=True, db_index=True)
    recommendation_score = models.FloatField(null=True, blank=True)
    recommendation_reasons = models.JSONField(default=list, blank=True)
    notes = models.TextField(blank=True)
    assigned_at = models.DateTimeField(default=timezone.now)
    accepted_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-assigned_at", "-id"]
        indexes = [
            models.Index(fields=["officer", "is_active"], name="assignment_officer_active_idx"),
            models.Index(fields=["complaint", "is_active"], name="assignment_complaint_act_idx"),
        ]

    def __str__(self):
        return f"{self.complaint_id} -> {self.officer_id} ({self.status})"
