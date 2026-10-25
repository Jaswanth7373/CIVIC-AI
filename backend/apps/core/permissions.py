"""Role-based permission classes shared by every CivicAI app.

Roles live on ``User.role`` ("citizen" | "officer" | "admin"). Superusers are
always treated as admins.
"""
from rest_framework.permissions import SAFE_METHODS, BasePermission


def user_role(user):
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return "admin"
    return getattr(user, "role", None)


def is_admin(user):
    return user_role(user) == "admin"


def is_officer(user):
    return user_role(user) == "officer"


def is_citizen(user):
    return user_role(user) == "citizen"


def withholds_personal_data(viewer, owner_id):
    """True when ``viewer`` is a citizen looking at data that belongs to another person.

    Citizens only ever see their own personal data: the contact details (phone, e-mail) of officers, admins and
    other citizens, and the contents of other citizens' reports (description, photo, exact address), are withheld
    wherever such an object appears in a citizen's response - e.g. the officer assigned to their complaint, or a
    nearby report the duplicate check matched. Staff (and internal callers without a request) see everything.
    """
    return is_citizen(viewer) and getattr(viewer, "pk", None) != owner_id


class IsAdmin(BasePermission):
    message = "Administrator access required."

    def has_permission(self, request, view):
        return is_admin(request.user)


class IsOfficer(BasePermission):
    message = "Officer access required."

    def has_permission(self, request, view):
        return is_officer(request.user)


class IsCitizen(BasePermission):
    message = "Citizen access required."

    def has_permission(self, request, view):
        return is_citizen(request.user)


class IsOfficerOrAdmin(BasePermission):
    message = "Officer or administrator access required."

    def has_permission(self, request, view):
        return user_role(request.user) in ("officer", "admin")


class IsAdminOrReadOnly(BasePermission):
    """Anyone authenticated can read; only admins can write."""

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return bool(request.user and request.user.is_authenticated)
        return is_admin(request.user)


class IsAdminOrPublicReadOnly(BasePermission):
    """Anyone (even anonymous) can read; only admins can write. Used for categories / departments lists."""

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return is_admin(request.user)
