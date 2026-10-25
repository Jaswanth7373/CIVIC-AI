"""CivicAI Django project configuration package.

Celery is optional: the app is loaded only when the celery package is installed,
so the platform still runs (with tasks executed eagerly) without a worker.
"""
try:  # pragma: no cover - optional dependency
    from .celery import app as celery_app

    __all__ = ("celery_app",)
except Exception:  # celery not installed or misconfigured
    celery_app = None
