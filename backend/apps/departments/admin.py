from django.contrib import admin

from .models import CivicCategory, Department


@admin.register(Department)
class DepartmentAdmin(admin.ModelAdmin):
    list_display = ("name", "code", "sla_hours", "is_active")
    search_fields = ("name", "code")
    list_filter = ("is_active",)


@admin.register(CivicCategory)
class CivicCategoryAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "department", "secondary_department", "base_severity", "is_active", "sort_order")
    list_filter = ("is_active", "department")
    search_fields = ("name", "slug")
    prepopulated_fields = {"slug": ("name",)}
