from django.contrib import admin

from .models import HotspotAlert


@admin.register(HotspotAlert)
class HotspotAlertAdmin(admin.ModelAdmin):
    list_display = ("area_name", "complaint_count", "dominant_category", "severity", "is_acknowledged", "created_at")
    list_filter = ("is_acknowledged", "severity")
