"""Celery tasks of the complaints app (BUILD_SPEC section 3.6).

Celery + Redis are optional: with ``USE_CELERY=False`` (the default) ``CELERY_TASK_ALWAYS_EAGER`` makes
``task.delay()`` run in-process, and every task also works when called directly like a normal function.

    check_sla_breaches        hourly (Celery beat, see config/celery.py) - SLA alerts for open high/critical
                              complaints, at most once per complaint per 24 h
    reanalyze_complaint_task  re-run the AI pipeline for one complaint in the background (e.g. heavy
                              production models after a citizen edits the description)
"""
import logging

from celery import shared_task

logger = logging.getLogger("apps.complaints")


@shared_task(name="apps.complaints.tasks.check_sla_breaches")
def check_sla_breaches(dry_run=False):
    """Alert administrators and assigned officers about SLA breaches. Returns the number of complaints alerted."""
    from .services.sla import check_sla_breaches as run_sla_check

    count = run_sla_check(dry_run=dry_run)
    logger.info("SLA check: %s complaint(s) %s", count, "would be alerted" if dry_run else "alerted")
    return count


@shared_task(name="apps.complaints.tasks.reanalyze_complaint_task")
def reanalyze_complaint_task(complaint_id):
    """Re-run the AI analysis of one complaint. Returns the analysis dict ({"steps", "summary"}) or None when the
    complaint no longer exists. The result is plain JSON, so it can travel through a Celery result backend."""
    from .models import Complaint
    from .services.pipeline import reanalyze_complaint

    complaint = (
        Complaint.objects.select_related("location", "category", "department", "assigned_officer", "citizen")
        .filter(pk=complaint_id).first()
    )
    if complaint is None:
        logger.warning("Re-analysis skipped: complaint %s does not exist", complaint_id)
        return None
    return reanalyze_complaint(complaint)
