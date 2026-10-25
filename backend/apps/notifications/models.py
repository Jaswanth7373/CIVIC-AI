"""In-app notifications (bell + notifications page)."""
from django.conf import settings
from django.db import models
from django.utils import timezone


class Notification(models.Model):
    class Type(models.TextChoices):
        # Citizen
        COMPLAINT_SUBMITTED = "complaint_submitted", "Complaint submitted"
        AI_ANALYSIS_COMPLETED = "ai_analysis_completed", "AI analysis completed"
        DEPARTMENT_ASSIGNED = "department_assigned", "Department assigned"
        OFFICER_ASSIGNED = "officer_assigned", "Officer assigned"
        STATUS_CHANGED = "status_changed", "Status changed"
        COMPLAINT_RESOLVED = "complaint_resolved", "Complaint resolved"
        RESOLUTION_VERIFIED = "resolution_verified", "Resolution verified"
        FEEDBACK_REQUESTED = "feedback_requested", "Feedback requested"
        DUPLICATE_DETECTED = "duplicate_detected", "Possible duplicate detected"
        # Officer
        NEW_ASSIGNMENT = "new_assignment", "New assignment"
        CRITICAL_COMPLAINT = "critical_complaint", "Critical complaint"
        REASSIGNMENT = "reassignment", "Reassignment"
        COMPLAINT_REOPENED = "complaint_reopened", "Complaint reopened"
        # Admin
        HIGH_PRIORITY_UNRESOLVED = "high_priority_unresolved", "High-priority complaint unresolved"
        HOTSPOT_ALERT = "hotspot_alert", "Hotspot alert"
        MANUAL_REVIEW_REQUESTED = "manual_review_requested", "Manual verification requested"
        FEEDBACK_RECEIVED = "feedback_received", "Feedback received"
        SYSTEM = "system", "System"

    class Level(models.TextChoices):
        INFO = "info", "Info"
        SUCCESS = "success", "Success"
        WARNING = "warning", "Warning"
        CRITICAL = "critical", "Critical"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    title = models.CharField(max_length=160)
    message = models.TextField()
    notification_type = models.CharField(max_length=40, choices=Type.choices, default=Type.SYSTEM, db_index=True)
    level = models.CharField(max_length=10, choices=Level.choices, default=Level.INFO)
    complaint = models.ForeignKey(
        "complaints.Complaint", on_delete=models.CASCADE, null=True, blank=True, related_name="notifications"
    )
    link = models.CharField(max_length=255, blank=True, help_text="Frontend route, e.g. /citizen/complaints/12")
    is_read = models.BooleanField(default=False, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["user", "is_read", "-created_at"], name="notif_user_read_idx")]

    def __str__(self):
        return f"{self.user_id}: {self.title}"
