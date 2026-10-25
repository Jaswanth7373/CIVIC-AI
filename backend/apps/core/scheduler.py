"""Built-in scheduler for the periodic checks when Celery beat is not running.

Celery beat (config/celery.py) runs the SLA breach check hourly and the city-wide hotspot scan every six hours.
The shipped configuration - local development and the Render blueprint - runs without Celery
(``USE_CELERY=False``), so without this module high-priority-unresolved and hotspot alerts would only appear
after an administrator pressed "Run checks now".

:class:`PeriodicChecksMiddleware` takes over: the first request after a check's interval has elapsed starts that
check in a background thread, so the request itself is not delayed. A cache entry claimed with ``cache.add``
(atomic: only one caller can create it) lets a single run start per interval and process. Both checks
de-duplicate their alerts in the database - one SLA alert per complaint per 24 hours, one hotspot alert per
cluster per 24 hours - so several worker processes each running them is harmless.

Settings: ``PERIODIC_CHECKS_ENABLED`` (default: on when ``USE_CELERY`` is off, never while the test-suite runs),
``SLA_CHECK_INTERVAL_MINUTES`` (60) and ``HOTSPOT_SCAN_INTERVAL_MINUTES`` (360); an interval of 0 disables that
check.
"""
import logging
import threading

from django.conf import settings
from django.core.cache import cache
from django.db import close_old_connections, connections
from django.utils.module_loading import import_string

logger = logging.getLogger("apps.core")

CACHE_PREFIX = "civicai:periodic-check:"


def periodic_checks():
    """``[(key, task import path, interval in minutes)]`` of the checks Celery beat would otherwise run."""
    return [
        ("sla_check", "apps.complaints.tasks.check_sla_breaches",
         getattr(settings, "SLA_CHECK_INTERVAL_MINUTES", 60)),
        ("hotspot_scan", "apps.analytics.tasks.scan_hotspots",
         getattr(settings, "HOTSPOT_SCAN_INTERVAL_MINUTES", 360)),
    ]


def start_due_checks(*, spawn=None):
    """Start every check whose interval has elapsed; returns the keys of the checks started.

    ``spawn(key, task_path)`` runs one check; the default starts a daemon thread (tests pass a synchronous one).
    """
    spawn = spawn or _spawn_thread
    started = []
    for key, task_path, minutes in periodic_checks():
        if not minutes or minutes <= 0:
            continue
        if cache.add(f"{CACHE_PREFIX}{key}", "claimed", timeout=int(minutes * 60)):
            spawn(key, task_path)
            started.append(key)
    return started


def run_check(key, task_path):
    """Run one periodic check now (exceptions are logged, never raised)."""
    try:
        result = import_string(task_path)()
        logger.info("Periodic %s finished (%s)", key.replace("_", " "), result)
    except Exception:  # noqa: BLE001 - a failing background check must never surface in a request
        logger.exception("Periodic %s failed", key.replace("_", " "))


def _spawn_thread(key, task_path):
    def _target():
        close_old_connections()
        try:
            run_check(key, task_path)
        finally:
            connections.close_all()  # the thread's own database connections

    threading.Thread(target=_target, name=f"civicai-{key}", daemon=True).start()


class PeriodicChecksMiddleware:
    """After each response, start the periodic checks that are due (see the module docstring)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if getattr(settings, "PERIODIC_CHECKS_ENABLED", False):
            try:
                start_due_checks()
            except Exception:  # noqa: BLE001 - e.g. the cache backend is unavailable
                logger.exception("Could not start the periodic checks")
        return response
