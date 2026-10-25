from django.contrib import admin

from .models import OfficerProfile


@admin.register(OfficerProfile)
class OfficerProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "employee_id", "department", "designation", "zone", "is_available", "max_active_complaints")
    list_filter = ("department", "is_available")
    search_fields = ("user__email", "user__first_name", "user__last_name", "employee_id", "zone")
