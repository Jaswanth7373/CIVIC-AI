from django.contrib import admin

from .models import ComplaintAssignment


@admin.register(ComplaintAssignment)
class ComplaintAssignmentAdmin(admin.ModelAdmin):
    list_display = (
        "complaint", "officer", "department", "assignment_type", "status", "is_active",
        "recommendation_score", "assigned_at",
    )
    list_filter = ("assignment_type", "status", "is_active", "department")
    raw_id_fields = ("complaint", "officer", "assigned_by")
