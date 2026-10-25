"""Access control for the complaints API (complaints, duplicates and the /api/ai/* endpoints).

Three layers protect every endpoint:

1. **Role permissions** (``has_permission``) decide who may call an endpoint at all - citizen,
   officer or admin - using the shared helpers of ``apps.core.permissions``.
2. **Object scoping** decides which complaints a user can *see*. It is applied to the queryset
   itself, so a complaint outside the user's scope simply does not exist for them and the API
   answers ``404 Not Found`` (instead of a ``403`` that would leak that the id exists):

   * citizen -> only the complaints they reported;
   * officer -> complaints assigned to them, plus read access to the complaints of their department;
   * admin   -> everything.

3. **Object permissions** (``has_object_permission``) guard write actions on a complaint the user
   can see: an officer may read a department colleague's complaint, but only the officer it is
   *assigned to* may accept, resolve or verify it.

The lifecycle rules themselves (which status change is legal right now) are enforced again by
``apps.complaints.services.status``; these classes are the HTTP-level gate in front of it.
"""
from django.db.models import Q
from rest_framework.permissions import BasePermission

from apps.core.permissions import user_role

#: Officer scope used by default on list endpoints: only complaints assigned to the officer.
OFFICER_SCOPE_ASSIGNED = "assigned"
#: Officer read scope: assigned complaints plus every complaint of the officer's department.
OFFICER_SCOPE_DEPARTMENT = "department"
OFFICER_SCOPES = (OFFICER_SCOPE_ASSIGNED, OFFICER_SCOPE_DEPARTMENT)


def officer_department_id(user):
    """Department id of an officer (``None`` when the user has no officer profile / department)."""
    profile = getattr(user, "officer_profile", None)  # reverse 1:1 raises an AttributeError subclass
    return getattr(profile, "department_id", None)


def scope_complaints(queryset, user, *, officer_scope=OFFICER_SCOPE_DEPARTMENT):
    """Restrict a ``Complaint`` queryset to what ``user`` may see.

    ``officer_scope`` only matters for officers: ``"assigned"`` keeps the complaints assigned to
    them, ``"department"`` (the read scope used for detail pages) also includes every complaint
    routed to their department. Unknown roles / anonymous users see nothing.
    """
    role = user_role(user)
    if role == "admin":
        return queryset
    if role == "citizen":
        return queryset.filter(citizen_id=user.pk)
    if role == "officer":
        department_id = officer_department_id(user)
        if officer_scope == OFFICER_SCOPE_ASSIGNED or department_id is None:
            return queryset.filter(assigned_officer_id=user.pk)
        return queryset.filter(Q(assigned_officer_id=user.pk) | Q(department_id=department_id))
    return queryset.none()


def scope_duplicate_pairs(queryset, user):
    """Restrict a ``DuplicateComplaint`` queryset: officers see pairs where *either* complaint is
    assigned to them or belongs to their department; admins see all pairs; others see none."""
    role = user_role(user)
    if role == "admin":
        return queryset
    if role != "officer":
        return queryset.none()
    condition = Q(complaint__assigned_officer_id=user.pk) | Q(similar_complaint__assigned_officer_id=user.pk)
    department_id = officer_department_id(user)
    if department_id is not None:
        condition |= Q(complaint__department_id=department_id) | Q(similar_complaint__department_id=department_id)
    return queryset.filter(condition)


def is_assigned_officer(user, complaint):
    """True when ``user`` is an officer and ``complaint`` is currently assigned to them."""
    return user_role(user) == "officer" and complaint.assigned_officer_id == user.pk


def can_act_as_officer(user, complaint):
    """Admins may act on any complaint; officers only on the complaints assigned to them."""
    return user_role(user) == "admin" or is_assigned_officer(user, complaint)


class IsComplaintOwnerOrAdmin(BasePermission):
    """Citizen who reported the complaint, or an administrator (edit / delete / reopen)."""

    message = "Only the citizen who reported this complaint or an administrator can do this."

    def has_permission(self, request, view):
        return user_role(request.user) in ("citizen", "admin")

    def has_object_permission(self, request, view, obj):
        return user_role(request.user) == "admin" or obj.citizen_id == request.user.pk


class IsAssignedOfficer(BasePermission):
    """Officer-only actions (accept, start work, request manual verification) - assigned officer only."""

    message = "Only the officer assigned to this complaint can do this."

    def has_permission(self, request, view):
        return user_role(request.user) == "officer"

    def has_object_permission(self, request, view, obj):
        return is_assigned_officer(request.user, obj)


class IsAssignedOfficerOrAdmin(BasePermission):
    """Officer/admin actions (reject, resolve, evidence, verification, remarks, status updates)."""

    message = "Only the officer assigned to this complaint or an administrator can do this."

    def has_permission(self, request, view):
        return user_role(request.user) in ("officer", "admin")

    def has_object_permission(self, request, view, obj):
        return can_act_as_officer(request.user, obj)
