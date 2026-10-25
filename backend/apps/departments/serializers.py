"""Serializers for departments, civic categories and the category -> department routing table.

JSON shapes follow docs/BUILD_SPEC.md section 4:

* ``DepartmentMiniSerializer`` / ``CategoryMiniSerializer`` - the compact shapes embedded everywhere
  (``{"id", "name", "code", "icon", "color"}`` and ``{"id", "name", "slug", "icon", "color"}``), re-exported
  from their canonical home ``apps.complaints.serializers``.
* ``DepartmentSerializer`` (DepartmentOut) and ``CategorySerializer`` (CategoryOut) - full admin shapes. Their
  counters (``officer_count``, ``complaint_count`` ...) are SQL annotations added by the viewsets.
* ``RoutingRowSerializer`` / ``RoutingUpdateSerializer`` - the routing table. ``CivicCategory.department`` *is*
  the routing table (category -> primary department, optional secondary/fallback department).

Categories are data, not code: admins can add a category with its own keywords and vision labels and the AI
engine uses them immediately (``CivicCategory.to_engine_dict``). That is why keywords / labels are validated
and normalised carefully here.
"""
import re

from django.db.models import Q
from django.utils.text import slugify
from rest_framework import serializers

from apps.complaints.serializers import CategoryMiniSerializer, DepartmentMiniSerializer

from .models import CivicCategory, Department

HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
# lucide-react icon names are kebab-case, e.g. "traffic-cone", "tree-deciduous".
ICON_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DEPARTMENT_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,19}$")
# Category slugs are the class names the AI engine predicts, e.g. "water_leak".
CATEGORY_SLUG_RE = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")

MAX_TERMS = 100
MAX_TERM_LENGTH = 60


def validate_hex_color(value):
    """Colours drive chart series and badges, so only ``#RRGGBB`` is accepted (stored upper-case)."""
    value = (value or "").strip()
    if not HEX_COLOR_RE.match(value):
        raise serializers.ValidationError("Enter a colour in #RRGGBB format, e.g. #D9480F.")
    return value.upper()


def validate_icon_name(value):
    """Icons are lucide-react names rendered by the frontend; reject anything that is not kebab-case."""
    value = (value or "").strip().lower()
    if not ICON_NAME_RE.match(value):
        raise serializers.ValidationError("Use a lucide icon name in kebab-case, e.g. traffic-cone.")
    return value


def clean_term_list(value, *, label="Value", underscore=False, max_items=MAX_TERMS, max_length=MAX_TERM_LENGTH,
                    lowercase=True):
    """Validate a JSON list of non-empty strings and return it normalised.

    Used for category ``keywords`` / ``vision_labels`` and officer ``skills``. Every item is stripped and its
    inner whitespace collapsed; keywords and labels are lower-cased because the NLP / vision engines compare
    lower-case tokens; vision labels additionally use ``_`` instead of spaces (detector class names such as
    ``road_hole``). Duplicates are dropped case-insensitively while keeping the admin's order.
    """
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise serializers.ValidationError(f"{label} must be a list of strings.")
    cleaned, seen = [], set()
    for position, item in enumerate(value, start=1):
        if not isinstance(item, str):
            raise serializers.ValidationError(f"{label}: item {position} must be a string.")
        term = " ".join(item.split())
        if lowercase:
            term = term.lower()
        if underscore:
            term = term.replace(" ", "_")
        if not term:
            raise serializers.ValidationError(f"{label}: item {position} is empty.")
        if len(term) > max_length:
            raise serializers.ValidationError(f"{label}: item {position} is longer than {max_length} characters.")
        if term.lower() not in seen:
            seen.add(term.lower())
            cleaned.append(term)
    if len(cleaned) > max_items:
        raise serializers.ValidationError(f"{label} can contain at most {max_items} items.")
    return cleaned


def unique_category_slug(name, *, exclude_pk=None):
    """Derive a unique engine-friendly slug from a category name: "Broken Footpath" -> "broken_footpath".

    Underscores (not hyphens) keep admin categories consistent with the built-in AI class names
    (``water_leak``, ``open_manhole``). A numeric suffix resolves collisions (``broken_footpath_2``).
    """
    base = slugify(name).replace("-", "_").strip("_")[:50] or "category"
    candidate, suffix = base, 2
    while CivicCategory.objects.filter(slug=candidate).exclude(pk=exclude_pk).exists():
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


# ---------------------------------------------------------------------------------------------------------------
# Departments
# ---------------------------------------------------------------------------------------------------------------
class DepartmentSerializer(serializers.ModelSerializer):
    """DepartmentOut (read) and the admin write payload.

    ``officer_count`` / ``category_count`` / ``open_complaints`` / ``total_complaints`` are correlated-subquery
    annotations prepared by ``DepartmentViewSet.get_queryset`` (one SQL statement for the whole list).
    """

    # Declared explicitly so the auto-generated (case-sensitive) unique validators are replaced by the
    # case-insensitive checks below.
    name = serializers.CharField(max_length=120)
    code = serializers.CharField(max_length=20)
    officer_count = serializers.IntegerField(read_only=True)
    category_count = serializers.IntegerField(read_only=True)
    open_complaints = serializers.IntegerField(read_only=True)
    total_complaints = serializers.IntegerField(read_only=True)

    class Meta:
        model = Department
        fields = [
            "id", "name", "code", "description", "email", "phone", "head_name", "icon", "color", "sla_hours",
            "is_active", "officer_count", "category_count", "open_complaints", "total_complaints",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]
        extra_kwargs = {"sla_hours": {"min_value": 1, "max_value": 8760}}

    def _others(self):
        queryset = Department.objects.all()
        if self.instance is not None:
            queryset = queryset.exclude(pk=self.instance.pk)
        return queryset

    def validate_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Department name is required.")
        if self._others().filter(name__iexact=value).exists():
            raise serializers.ValidationError("A department with this name already exists.")
        return value

    def validate_code(self, value):
        value = value.strip().upper()
        if not DEPARTMENT_CODE_RE.match(value):
            raise serializers.ValidationError(
                "Use 2-20 upper-case letters, digits or underscores starting with a letter, e.g. ROADS."
            )
        if self._others().filter(code__iexact=value).exists():
            raise serializers.ValidationError("A department with this code already exists.")
        return value

    def validate_icon(self, value):
        return validate_icon_name(value)

    def validate_color(self, value):
        return validate_hex_color(value)

    def validate_phone(self, value):
        value = (value or "").strip()
        if value and not re.match(r"^\+?[0-9][0-9\s\-]{5,18}[0-9]$", value):
            raise serializers.ValidationError("Enter a valid phone number.")
        return value


# ---------------------------------------------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------------------------------------------
class CategorySerializer(serializers.ModelSerializer):
    """CategoryOut (read) and the admin write payload.

    * ``slug`` is generated from the name when omitted and is immutable afterwards: it is the class name the
      AI engine predicts, so renaming it would silently disconnect stored predictions from the category.
    * ``keywords`` / ``vision_labels`` must be lists of non-empty strings (normalised by ``clean_term_list``).
    * ``complaint_count`` is a subquery annotation added by ``CategoryViewSet.get_queryset``.
    """

    name = serializers.CharField(max_length=100)
    slug = serializers.CharField(max_length=60, required=False, allow_blank=True)
    department = serializers.PrimaryKeyRelatedField(
        queryset=Department.objects.all(), allow_null=True, required=False
    )
    department_detail = DepartmentMiniSerializer(source="department", read_only=True)
    secondary_department = serializers.PrimaryKeyRelatedField(
        queryset=Department.objects.all(), allow_null=True, required=False
    )
    secondary_department_detail = DepartmentMiniSerializer(source="secondary_department", read_only=True)
    keywords = serializers.JSONField(required=False)
    vision_labels = serializers.JSONField(required=False)
    effective_sla_hours = serializers.IntegerField(read_only=True)
    complaint_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = CivicCategory
        fields = [
            "id", "name", "slug", "description", "icon", "color", "department", "department_detail",
            "secondary_department", "secondary_department_detail", "keywords", "vision_labels", "base_severity",
            "public_safety_weight", "sla_hours", "effective_sla_hours", "is_active", "sort_order",
            "complaint_count", "created_at",
        ]
        read_only_fields = ["id", "created_at"]
        extra_kwargs = {
            "base_severity": {"min_value": 0, "max_value": 100},
            "public_safety_weight": {"min_value": 0.0, "max_value": 1.0},
            "sla_hours": {"min_value": 1, "max_value": 8760},
            "sort_order": {"min_value": 0, "max_value": 32767},
        }

    def validate_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Category name is required.")
        others = CivicCategory.objects.filter(name__iexact=value)
        if self.instance is not None:
            others = others.exclude(pk=self.instance.pk)
        if others.exists():
            raise serializers.ValidationError("A category with this name already exists.")
        return value

    def validate_slug(self, value):
        value = (value or "").strip().lower().replace("-", "_")
        if self.instance is not None:
            if value and value != self.instance.slug:
                raise serializers.ValidationError(
                    "The slug is the AI engine's class name and cannot be changed after creation."
                )
            return self.instance.slug
        if value and not CATEGORY_SLUG_RE.match(value):
            raise serializers.ValidationError("Use lower-case letters, digits and underscores, e.g. broken_footpath.")
        if value and CivicCategory.objects.filter(slug=value).exists():
            raise serializers.ValidationError("A category with this slug already exists.")
        return value

    def validate_icon(self, value):
        return validate_icon_name(value)

    def validate_color(self, value):
        return validate_hex_color(value)

    def validate_keywords(self, value):
        return clean_term_list(value, label="Keywords")

    def validate_vision_labels(self, value):
        return clean_term_list(value, label="Vision labels", underscore=True)

    def _check_department(self, department, field):
        """Routing to an inactive department would strand new complaints, so only allow it if unchanged."""
        if department is None or department.is_active:
            return
        current_id = getattr(self.instance, f"{field}_id", None) if self.instance is not None else None
        if department.pk != current_id:
            raise serializers.ValidationError({field: [f"{department.name} is inactive; activate it first."]})

    def validate(self, attrs):
        primary = attrs.get("department", getattr(self.instance, "department", None))
        secondary = attrs.get("secondary_department", getattr(self.instance, "secondary_department", None))
        if "department" in attrs:
            self._check_department(attrs["department"], "department")
        if "secondary_department" in attrs:
            self._check_department(attrs["secondary_department"], "secondary_department")
        if primary is not None and secondary is not None and primary.pk == secondary.pk:
            raise serializers.ValidationError(
                {"secondary_department": ["The secondary department must differ from the primary department."]}
            )
        if self.instance is None and not attrs.get("slug"):
            attrs["slug"] = unique_category_slug(attrs["name"])
        return attrs


# ---------------------------------------------------------------------------------------------------------------
# Routing table
# ---------------------------------------------------------------------------------------------------------------
class RoutingRowSerializer(serializers.Serializer):
    """One routing row built from a CivicCategory:
    ``{"category": CategoryMini, "department": DepartmentMini|null, "secondary_department": DepartmentMini|null}``."""

    category = CategoryMiniSerializer(source="*", read_only=True)
    department = DepartmentMiniSerializer(read_only=True)
    secondary_department = DepartmentMiniSerializer(read_only=True)


class RoutingMappingSerializer(serializers.Serializer):
    category = serializers.IntegerField(min_value=1)
    department = serializers.IntegerField(min_value=1, allow_null=True)
    secondary_department = serializers.IntegerField(min_value=1, allow_null=True, required=False)


class RoutingUpdateSerializer(serializers.Serializer):
    """``{"mappings": [{"category": id, "department": id|null, "secondary_department": id|null}]}``.

    Validation is done in bulk (two ``in_bulk`` queries for any number of rows). Rows that omit
    ``secondary_department`` keep their current secondary department. After validation every mapping holds
    model instances: ``{"category": CivicCategory, "department": Department|None,
    "secondary_department": Department|None}``.
    """

    mappings = RoutingMappingSerializer(many=True, allow_empty=False)

    def validate_mappings(self, mappings):
        category_ids = [row["category"] for row in mappings]
        duplicates = sorted({cid for cid in category_ids if category_ids.count(cid) > 1})
        if duplicates:
            raise serializers.ValidationError(f"Each category may appear only once (repeated: {duplicates}).")

        categories = CivicCategory.objects.select_related("department", "secondary_department").in_bulk(category_ids)
        department_ids = {
            row[key] for row in mappings for key in ("department", "secondary_department") if row.get(key)
        }
        departments = Department.objects.in_bulk(department_ids)

        errors, resolved, has_errors = [], [], False
        for row in mappings:
            row_errors = {}
            category = categories.get(row["category"])
            if category is None:
                row_errors["category"] = [f"Category {row['category']} does not exist."]
            values = {}
            for key in ("department", "secondary_department"):
                if key not in row:
                    values[key] = getattr(category, key, None) if category else None
                    continue
                if row[key] is None:
                    values[key] = None
                    continue
                department = departments.get(row[key])
                if department is None:
                    row_errors[key] = [f"Department {row[key]} does not exist."]
                elif not department.is_active and getattr(category, f"{key}_id", None) != department.pk:
                    row_errors[key] = [f"{department.name} is inactive; activate it first."]
                values[key] = department
            primary, secondary = values.get("department"), values.get("secondary_department")
            if primary is not None and secondary is not None and primary.pk == secondary.pk:
                row_errors["secondary_department"] = [
                    "The secondary department must differ from the primary department."
                ]
            errors.append(row_errors)
            has_errors = has_errors or bool(row_errors)
            resolved.append({"category": category, **values})
        if has_errors:
            raise serializers.ValidationError(errors)
        return resolved


def categories_using_department(department):
    """Categories that route to ``department`` as primary or secondary (used to block hard deletes)."""
    return CivicCategory.objects.filter(Q(department=department) | Q(secondary_department=department))
