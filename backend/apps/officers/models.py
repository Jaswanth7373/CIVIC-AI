"""Officer profiles.

``OfficerProfile`` uses the user as primary key, so an officer's id is the same
number everywhere (``/api/officers/{id}/`` == ``User.id`` == ``Complaint.assigned_officer_id``).
"""
from django.conf import settings
from django.db import models


class OfficerProfile(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="officer_profile"
    )
    department = models.ForeignKey(
        "departments.Department", on_delete=models.SET_NULL, null=True, blank=True, related_name="officers"
    )
    employee_id = models.CharField(max_length=30, unique=True)
    designation = models.CharField(max_length=100, default="Field Officer")
    zone = models.CharField(max_length=120, blank=True, help_text="Ward / service area")
    base_latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    base_longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    max_active_complaints = models.PositiveSmallIntegerField(default=10, help_text="Workload capacity")
    is_available = models.BooleanField(default=True, db_index=True)
    skills = models.JSONField(default=list, blank=True)
    joined_on = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["user__first_name", "user__last_name"]
        indexes = [models.Index(fields=["department", "is_available"], name="officer_dept_avail_idx")]

    def __str__(self):
        return f"{self.user.full_name} ({self.employee_id})"

    @property
    def active_workload(self):
        """Number of complaints currently assigned to and open for this officer."""
        from apps.complaints.models import Complaint

        return Complaint.objects.filter(
            assigned_officer_id=self.user_id, status__in=Complaint.OPEN_ASSIGNED_STATUSES
        ).count()
