from django.contrib import admin

from .models import AIConfiguration, ContactMessage, RiskZone


@admin.register(AIConfiguration)
class AIConfigurationAdmin(admin.ModelAdmin):
    list_display = (
        "__str__", "weight_severity", "weight_public_impact", "weight_location_risk",
        "weight_frequency", "weight_duplicates", "updated_at",
    )

    def has_add_permission(self, request):
        return not AIConfiguration.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(RiskZone)
class RiskZoneAdmin(admin.ModelAdmin):
    list_display = ("name", "zone_type", "risk_level", "radius_m", "is_active")
    list_filter = ("zone_type", "is_active")
    search_fields = ("name",)


@admin.register(ContactMessage)
class ContactMessageAdmin(admin.ModelAdmin):
    list_display = ("subject", "name", "email", "is_resolved", "created_at")
    list_filter = ("is_resolved",)
    search_fields = ("subject", "name", "email", "message")
