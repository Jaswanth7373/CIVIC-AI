"""Department routing.

Routing is data, not code: ``CivicCategory.department`` *is* the routing table (admins edit it on the
Departments page), with ``CivicCategory.secondary_department`` as the fallback (e.g. Open Manhole -> Roads, else
Drainage). When neither is usable the complaint goes to the General Civic Department (code "GEN").
Inactive departments are skipped at every step, so deactivating a department never strands new complaints.
"""
GENERAL_DEPARTMENT_CODE = "GEN"


def route_department(category):
    """Return the Department for a CivicCategory using the DB routing table (category.department ->
    category.secondary_department -> department with code "GEN" -> None)."""
    from apps.departments.models import Department

    if category is not None:
        for department in (category.department, category.secondary_department):
            if department is not None and department.is_active:
                return department
    return Department.objects.filter(code__iexact=GENERAL_DEPARTMENT_CODE, is_active=True).first()


def routing_reason(category, department):
    """Human sentence explaining which routing rule produced ``department``."""
    if department is None:
        return "No active department is configured for this category and no General Civic Department exists."
    if category is None:
        return f"Routed to the {department.name} (no category available - general fallback)."
    if category.department_id == department.pk:
        return f"Routed to the {department.name} by the {category.name} routing rule."
    if category.secondary_department_id == department.pk:
        return (f"Routed to the {department.name}, the secondary department for {category.name} "
                "(primary department inactive or not set).")
    return f"Routed to the {department.name} (general fallback for {category.name})."
