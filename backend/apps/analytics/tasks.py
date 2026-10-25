"""Celery tasks of the analytics app (owner B5).

``scan_hotspots`` is scheduled every 6 hours by ``config.celery`` (beat entry
"hotspot-scan-every-6-hours").  With ``USE_CELERY=False`` (local development) Celery runs tasks
eagerly, and the function can also simply be called directly - ``POST /api/analytics/run-checks/``
does exactly that.
"""
import logging

from celery import shared_task

from . import services

logger = logging.getLogger("apps.analytics")


@shared_task(name="apps.analytics.tasks.scan_hotspots")
def scan_hotspots(days=services.HOTSPOT_SCAN_DAYS, raise_errors=False):
    """City-wide DBSCAN scan of open complaints from the last ``days`` days.

    Every cluster with at least ``AIConfiguration.hotspot_alert_threshold`` complaints that has
    not alerted in the last 24 hours becomes a HotspotAlert and admins are notified.  Returns the
    number of alerts created.  While the clustering engine is unavailable the scan logs a warning
    and returns 0, unless ``raise_errors`` is set (used by the run-checks endpoint to report it).
    """
    try:
        summary = services.scan_city_hotspots(days=days)
    except services.HotspotEngineUnavailable:
        if raise_errors:
            raise
        logger.warning("Hotspot scan skipped: the DBSCAN hotspot engine is unavailable.")
        return 0
    logger.info(
        "Hotspot scan: %d open complaints, %d clusters, %d new alerts",
        summary["points"], summary["clusters"], summary["alerts_created"],
    )
    return summary["alerts_created"]
