"""Gunicorn configuration for the CivicAI API (Render, Railway or any Linux host).

    gunicorn config.wsgi -c gunicorn.conf.py

* ``bind``      0.0.0.0:$PORT (the platform injects PORT; 8000 locally)
* ``workers``   $WEB_CONCURRENCY (default 2). Every worker process holds its own copy of the AI models - about
                230 MB in MODEL_MODE=demo (measured after an analysis + a verification), about 0.9 GB with the
                production models (about 1.2 GB briefly while they load) - so size it to the instance (1 on a
                512 MB instance).
* ``threads``   $GUNICORN_THREADS (default 4) per worker (gthread worker): API calls that wait on the database
                share one copy of the models instead of needing more processes.
* ``timeout``   120 s: submitting a complaint runs the whole AI pipeline synchronously and the first request of
                a production worker may still be loading models.
* ``post_worker_init``  in MODEL_MODE=production each worker pre-loads the AI models (``apps.core.warmup``) in a
                background thread, so it serves requests (and the platform's port check) while torch /
                transformers load; demo mode loads its small models on first use.
"""
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
workers = max(1, int(os.environ.get("WEB_CONCURRENCY", "2")))
threads = max(1, int(os.environ.get("GUNICORN_THREADS", "4")))
timeout = 120
graceful_timeout = 30
keepalive = 5
# The platform's proxy terminates TLS and sets X-Forwarded-Proto (Django: SECURE_PROXY_SSL_HEADER).
forwarded_allow_ips = os.environ.get("FORWARDED_ALLOW_IPS", "*")
accesslog = "-"
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info").lower()


def post_worker_init(worker):
    """Start the AI model warm-up of a freshly booted worker (production mode only)."""
    from apps.core.warmup import is_production_mode, warm_up_in_background

    if is_production_mode():
        warm_up_in_background(name=f"civicai-ai-warmup-{worker.pid}")
        worker.log.info("AI model warm-up started in the background (MODEL_MODE=production)")
