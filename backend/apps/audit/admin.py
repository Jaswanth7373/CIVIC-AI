from django.contrib import admin

from .models import AuditLog


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ("created_at", "actor", "action", "entity_type", "entity_id", "description", "ip_address")
    list_filter = ("action", "entity_type")
    search_fields = ("description", "entity_id", "actor__email")

    def get_readonly_fields(self, request, obj=None):
        return [f.name for f in AuditLog._meta.fields]
