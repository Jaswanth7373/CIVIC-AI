"""Departments, civic categories and routing endpoints (all lists are non-paginated).

    GET            /api/departments/            public; ``?include_inactive=true`` (admins) adds inactive ones
    POST/PUT/PATCH /api/departments/{id}/       admins
    DELETE         /api/departments/{id}/       admins; deactivates instead when the department is in use
    GET/PUT        /api/departments/routing/    category -> department routing table (GET: signed in, PUT: admin)
    GET            /api/categories/             public; ``?include_inactive=true`` (admins)
    POST/PUT/PATCH/DELETE /api/categories/{id}/ admins; DELETE deactivates categories that were already used

Counters (officer_count, open_complaints, complaint_count ...) are correlated sub-selects, so a full list
is one SQL query regardless of the number of rows.
"""
from django.db import transaction
from django.db.models import OuterRef, Q
from django_filters import rest_framework as filters
from rest_framework import status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.audit.services import log_action
from apps.complaints.models import AIPrediction, Complaint
from apps.core.filters import IdFilter
from apps.core.permissions import IsAdmin, IsAdminOrPublicReadOnly, is_admin
from apps.core.utils import ID_PATTERN
from apps.core.views import AnnotatedWriteMixin, diff_snapshots, is_truthy, snapshot, subquery_count
from apps.officers.models import OfficerProfile

from .models import CivicCategory, Department
from .serializers import (
    CategorySerializer,
    DepartmentSerializer,
    RoutingRowSerializer,
    RoutingUpdateSerializer,
    categories_using_department,
)

DEPARTMENT_AUDIT_FIELDS = ["name", "code", "description", "email", "phone", "head_name", "icon", "color",
                           "sla_hours", "is_active"]
CATEGORY_AUDIT_FIELDS = ["name", "slug", "description", "icon", "color", "department", "secondary_department",
                         "keywords", "vision_labels", "base_severity", "public_safety_weight", "sla_hours",
                         "is_active", "sort_order"]


def annotated_departments():
    """Departments with ``officer_count`` (active officers), ``category_count`` (active categories routed
    here as primary), ``open_complaints`` and ``total_complaints``."""
    return Department.objects.annotate(
        officer_count=subquery_count(
            OfficerProfile.objects.filter(department=OuterRef("pk"), user__is_active=True,
                                          user__role=User.Role.OFFICER),
            "department",
        ),
        category_count=subquery_count(CivicCategory.objects.filter(department=OuterRef("pk"), is_active=True),
                                      "department"),
        open_complaints=subquery_count(
            Complaint.objects.filter(department=OuterRef("pk"), status__in=Complaint.OPEN_STATUSES), "department"
        ),
        total_complaints=subquery_count(Complaint.objects.filter(department=OuterRef("pk")), "department"),
    )


def annotated_categories():
    """Categories with their routing departments joined and ``complaint_count`` (complaints whose final
    category is this one)."""
    return CivicCategory.objects.select_related("department", "secondary_department").annotate(
        complaint_count=subquery_count(Complaint.objects.filter(category=OuterRef("pk")), "category"),
    )


class _ActiveFilterMixin:
    """Public readers only ever see active rows; admins see inactive ones in lists when they ask for
    ``?include_inactive=true`` and can always open / edit an inactive row by id."""

    def filter_active(self, queryset):
        admin = is_admin(self.request.user)
        if self.action == "list":
            if not (admin and is_truthy(self.request.query_params.get("include_inactive", ""))):
                return queryset.filter(is_active=True)
            return queryset
        return queryset if admin else queryset.filter(is_active=True)


class DepartmentViewSet(_ActiveFilterMixin, AnnotatedWriteMixin, viewsets.ModelViewSet):
    serializer_class = DepartmentSerializer
    permission_classes = [IsAdminOrPublicReadOnly]
    pagination_class = None
    search_fields = ["name", "code", "description", "head_name"]
    ordering_fields = ["name", "code", "sla_hours", "created_at", "open_complaints", "total_complaints"]
    ordering = ["name"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return self.filter_active(annotated_departments())

    def perform_create(self, serializer):
        department = serializer.save()
        log_action(self.request.user, AuditLog.Action.CREATE, entity=department,
                   description=f"Created department {department.code} - {department.name}",
                   changes=snapshot(department, DEPARTMENT_AUDIT_FIELDS), request=self.request)
        return department

    def perform_update(self, serializer):
        before = snapshot(serializer.instance, DEPARTMENT_AUDIT_FIELDS)
        department = serializer.save()
        changes = diff_snapshots(before, snapshot(department, DEPARTMENT_AUDIT_FIELDS))
        if changes:
            log_action(self.request.user, AuditLog.Action.UPDATE, entity=department,
                       description=f"Updated department {department.code}", changes=changes, request=self.request)
        return department

    def destroy(self, request, *args, **kwargs):
        """Hard-delete only an unused department; otherwise deactivate it so complaint history, officer
        records and routing stay intact (204 = deleted, 200 + explanation = deactivated)."""
        department = self.get_object()
        usage = {
            "complaints": Complaint.objects.filter(department=department).count(),
            "officers": OfficerProfile.objects.filter(department=department).count(),
            "categories": categories_using_department(department).count(),
        }
        if not any(usage.values()):
            log_action(request.user, AuditLog.Action.DELETE, entity=department,
                       description=f"Deleted department {department.code} - {department.name}",
                       changes=snapshot(department, DEPARTMENT_AUDIT_FIELDS), request=request)
            department.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        if department.is_active:
            department.is_active = False
            department.save(update_fields=["is_active", "updated_at"])
            log_action(request.user, AuditLog.Action.UPDATE, entity=department,
                       description=f"Deactivated department {department.code} (still in use, so not deleted)",
                       changes={"is_active": [True, False], "usage": usage}, request=request)
        in_use = ", ".join(f"{count} {name}" for name, count in usage.items() if count)
        return Response({
            "detail": f"{department.name} is still used by {in_use}, so it was deactivated instead of deleted.",
            "deactivated": True,
            "usage": usage,
            "department": self.get_read_serializer(self.annotated_instance(department)).data,
        })


class CategoryFilter(filters.FilterSet):
    """``?department=<id>`` - categories routed to that department (a strict id: 1 .. 2**63-1)."""

    department = IdFilter(field_name="department_id")

    class Meta:
        model = CivicCategory
        fields = ["department"]


class CategoryViewSet(_ActiveFilterMixin, AnnotatedWriteMixin, viewsets.ModelViewSet):
    serializer_class = CategorySerializer
    permission_classes = [IsAdminOrPublicReadOnly]
    pagination_class = None
    filterset_class = CategoryFilter
    search_fields = ["name", "slug", "description"]
    ordering_fields = ["sort_order", "name", "base_severity", "created_at", "complaint_count"]
    ordering = ["sort_order", "name"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return self.filter_active(annotated_categories())

    def perform_create(self, serializer):
        category = serializer.save()
        log_action(self.request.user, AuditLog.Action.CREATE, entity=category,
                   description=f"Created category {category.slug}",
                   changes=snapshot(category, CATEGORY_AUDIT_FIELDS), request=self.request)
        return category

    def perform_update(self, serializer):
        before = snapshot(serializer.instance, CATEGORY_AUDIT_FIELDS)
        category = serializer.save()
        changes = diff_snapshots(before, snapshot(category, CATEGORY_AUDIT_FIELDS))
        if changes:
            log_action(self.request.user, AuditLog.Action.UPDATE, entity=category,
                       description=f"Updated category {category.slug}", changes=changes, request=self.request)
        return category

    def destroy(self, request, *args, **kwargs):
        """Delete a never-used category; deactivate one that complaints or AI predictions reference."""
        category = self.get_object()
        usage = {
            "complaints": Complaint.objects.filter(Q(category=category) | Q(reported_category=category)).count(),
            "ai_predictions": AIPrediction.objects.filter(final_category=category).count(),
        }
        if not any(usage.values()):
            log_action(request.user, AuditLog.Action.DELETE, entity=category,
                       description=f"Deleted category {category.slug}",
                       changes=snapshot(category, CATEGORY_AUDIT_FIELDS), request=request)
            category.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        if category.is_active:
            category.is_active = False
            category.save(update_fields=["is_active", "updated_at"])
            log_action(request.user, AuditLog.Action.UPDATE, entity=category,
                       description=f"Deactivated category {category.slug} (already used, so not deleted)",
                       changes={"is_active": [True, False], "usage": usage}, request=request)
        in_use = ", ".join(f"{count} {name.replace('_', ' ')}" for name, count in usage.items() if count)
        return Response({
            "detail": f"{category.name} is referenced by {in_use}, so it was deactivated instead of deleted.",
            "deactivated": True,
            "usage": usage,
            "category": self.get_read_serializer(self.annotated_instance(category)).data,
        })


class RoutingView(APIView):
    """GET (signed in) / PUT (admin) the category -> department routing table.

    PUT ``{"mappings": [{"category": id, "department": id|null, "secondary_department": id|null}]}`` updates
    only the listed categories, atomically (all rows or none), writes one audit entry with the before/after
    department codes and answers with the full table (same shape as GET).
    """

    def get_permissions(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAdmin()]

    def routing_rows(self, request):
        queryset = CivicCategory.objects.select_related("department", "secondary_department").order_by(
            "sort_order", "name"
        )
        if not (is_admin(request.user) and is_truthy(request.query_params.get("include_inactive", ""))):
            queryset = queryset.filter(is_active=True)
        return RoutingRowSerializer(queryset, many=True, context={"request": request}).data

    def get(self, request):
        return Response(self.routing_rows(request))

    def put(self, request):
        serializer = RoutingUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        def code(department):
            return department.code if department is not None else None

        changes = {}
        with transaction.atomic():
            for mapping in serializer.validated_data["mappings"]:
                category = mapping["category"]
                primary, secondary = mapping["department"], mapping["secondary_department"]
                old = (category.department, category.secondary_department)
                if (code(old[0]), code(old[1])) == (code(primary), code(secondary)):
                    continue
                category.department, category.secondary_department = primary, secondary
                category.save(update_fields=["department", "secondary_department", "updated_at"])
                changes[category.slug] = {
                    "department": [code(old[0]), code(primary)],
                    "secondary_department": [code(old[1]), code(secondary)],
                }
        if changes:
            log_action(request.user, AuditLog.Action.UPDATE, entity_type="CategoryRouting", entity_id="routing",
                       description=f"Updated department routing for {len(changes)} categor"
                                   f"{'y' if len(changes) == 1 else 'ies'}: {', '.join(sorted(changes))}",
                       changes=changes, request=request)
        return Response(self.routing_rows(request))
