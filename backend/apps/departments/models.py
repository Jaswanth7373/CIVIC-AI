"""Municipal departments and the configurable civic issue categories.

``CivicCategory`` is data, not code: admins can add new categories (with
keywords / vision labels / routing) from the admin panel and the AI engine
picks them up without code changes.  ``CivicCategory.department`` IS the
department routing table (category -> department), with an optional
secondary department used as a fallback (e.g. Open Manhole -> Roads / Drainage).
"""
from django.db import models


class Department(models.Model):
    name = models.CharField(max_length=120, unique=True)
    code = models.CharField(max_length=20, unique=True, help_text="Short code, e.g. ROADS")
    description = models.TextField(blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=20, blank=True)
    head_name = models.CharField(max_length=120, blank=True)
    icon = models.CharField(max_length=50, default="building-2", help_text="lucide icon name (kebab-case)")
    color = models.CharField(max_length=7, default="#0B6E4F", help_text="Hex colour used in charts / badges")
    sla_hours = models.PositiveIntegerField(default=72, help_text="Target resolution time in hours")
    is_active = models.BooleanField(default=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class CivicCategory(models.Model):
    name = models.CharField(max_length=100, unique=True)
    slug = models.SlugField(max_length=60, unique=True, help_text="Machine name used by the AI engine")
    description = models.TextField(blank=True)
    icon = models.CharField(max_length=50, default="circle-alert", help_text="lucide icon name (kebab-case)")
    color = models.CharField(max_length=7, default="#64748B")
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True, related_name="categories",
        help_text="Primary routing department",
    )
    secondary_department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True, related_name="secondary_categories",
        help_text="Fallback department (used when the primary has no available officer)",
    )
    keywords = models.JSONField(default=list, blank=True, help_text="Text keywords that indicate this category")
    vision_labels = models.JSONField(
        default=list, blank=True, help_text="Detector class names (YOLO/CLIP labels) that map to this category"
    )
    base_severity = models.PositiveSmallIntegerField(default=50, help_text="Inherent severity of the issue type, 0-100")
    public_safety_weight = models.FloatField(default=0.5, help_text="Inherent public-safety hazard, 0-1")
    sla_hours = models.PositiveIntegerField(null=True, blank=True, help_text="Overrides the department SLA")
    is_active = models.BooleanField(default=True, db_index=True)
    sort_order = models.PositiveSmallIntegerField(default=100)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "name"]
        verbose_name = "civic category"
        verbose_name_plural = "civic categories"

    def __str__(self):
        return self.name

    @property
    def effective_sla_hours(self):
        if self.sla_hours:
            return self.sla_hours
        if self.department_id and self.department:
            return self.department.sla_hours
        return 72

    def to_engine_dict(self):
        """Plain-dict representation consumed by the framework-independent ``ai`` package."""
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "keywords": list(self.keywords or []),
            "vision_labels": list(self.vision_labels or []),
            "base_severity": int(self.base_severity),
            "public_safety_weight": float(self.public_safety_weight),
            "department_id": self.department_id,
            "secondary_department_id": self.secondary_department_id,
            "description": self.description,
        }
