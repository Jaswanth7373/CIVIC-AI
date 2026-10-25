"""Celery application for CivicAI.

Celery + Redis are used only where background work is genuinely useful:
  * periodic SLA checks for high-priority unresolved complaints
  * periodic hotspot (DBSCAN) scans that raise admin alerts
  * optional asynchronous AI re-analysis in MODEL_MODE=production

When USE_CELERY=False (default for local development) every task runs eagerly
in-process, so no worker or broker is required.

Run a worker (Windows needs the solo pool):
    celery -A config worker -l info --pool=solo
    celery -A config beat -l info

With MODEL_MODE=production the worker loads the AI models once when it is ready (``worker_ready`` signal,
``apps.core.warmup``), so the first re-analysis task does not pay the model load time. The warm-up runs in the
worker's main process: it covers the solo / threads pools; prefork child processes load models on first use.
"""
import os

from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_ready

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("civicai")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


@worker_ready.connect
def warm_up_ai_models(sender=None, **kwargs):
    """Production workers pre-load the AI models before consuming tasks (no-op in demo mode)."""
    from apps.core.warmup import is_production_mode, warm_up_models

    if is_production_mode():
        warm_up_models()

app.conf.beat_schedule = {
    "sla-breach-check-hourly": {
        "task": "apps.complaints.tasks.check_sla_breaches",
        "schedule": crontab(minute=0),
    },
    "hotspot-scan-every-6-hours": {
        "task": "apps.analytics.tasks.scan_hotspots",
        "schedule": crontab(minute=15, hour="*/6"),
    },
}
