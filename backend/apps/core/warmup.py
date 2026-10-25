"""AI model warm-up: load the models of the current ``MODEL_MODE`` when a process starts.

In ``MODEL_MODE=production`` the first request that touches a model pays its load time (importing torch /
sentence-transformers / transformers and reading the weights - tens of seconds on a CPU, longer when the
weights still have to be downloaded). Warming up moves that cost to process start-up:

* ``python manage.py warmup_ai``                      - manual / deployment step; prints the model statuses
* Celery ``worker_ready`` signal (``config/celery.py``) - production workers, before they consume tasks
* gunicorn ``post_worker_init`` (``gunicorn.conf.py``)  - production web workers, in a background thread so the
                                                         worker answers health checks while models load

Each component is loaded in isolation: a model that cannot be loaded is reported as failed (the engine then
uses its documented demo fallback with a ``fallback_reason``) and never prevents the process from starting.
In demo mode the warm-up is cheap (it trains / loads the small TF-IDF models and the OpenCV heuristics).
"""
import logging
import threading
import time

logger = logging.getLogger("apps.core")

DONE, FAILED = "done", "failed"


def _elapsed_ms(started):
    return int(round((time.perf_counter() - started) * 1000))


def _warm_nlp():
    """``ai.nlp.warm_up()``: text classifier, embedder, keyword extractor and sentiment model."""
    from ai import nlp

    rows = nlp.warm_up() or []
    ready = sum(1 for row in rows if row.get("status") in ("active", "available"))
    return f"{len(rows)} NLP components checked, {ready} ready."


def _warm_vision():
    """``ai.vision.model.get_vision_model()``: YOLO / CLIP in production (demo heuristics otherwise)."""
    from ai.vision.model import get_vision_model

    model, fallback_reason = get_vision_model()
    name = getattr(model, "display_name", type(model).__name__)
    version = getattr(model, "version", "")
    detail = f"{name} loaded" + (f" ({version})" if version else "") + "."
    if fallback_reason:
        detail += f" Fallback: {fallback_reason}."
    return detail


COMPONENTS = (("nlp", _warm_nlp), ("vision", _warm_vision))


def model_statuses():
    """``describe_models()`` rows of every AI module (``ai.model_info``); ``[]`` if they cannot be produced."""
    try:
        from ai.model_info import get_model_info

        return list(get_model_info().get("models") or [])
    except Exception:  # noqa: BLE001 - reporting must never break the warm-up
        logger.warning("AI model statuses are unavailable.", exc_info=True)
        return []


def warm_up_models():
    """Load the AI models of the current mode now. Never raises.

    Returns ``{"mode", "steps": [{"component", "status": "done"|"failed", "detail", "duration_ms"}],
    "models": [describe_models() rows], "duration_ms"}``.
    """
    from ai.config import get_model_mode

    started = time.perf_counter()
    mode = get_model_mode()
    steps = []
    for component, loader in COMPONENTS:
        step_started = time.perf_counter()
        try:
            status, detail = DONE, loader()
        except Exception as exc:  # noqa: BLE001 - one component must not stop the others
            logger.warning("AI warm-up of %s failed: %s: %s", component, type(exc).__name__, exc)
            status, detail = FAILED, f"{type(exc).__name__}: {exc}"
        steps.append({"component": component, "status": status, "detail": detail,
                      "duration_ms": _elapsed_ms(step_started)})
    report = {"mode": mode, "steps": steps, "models": model_statuses(), "duration_ms": _elapsed_ms(started)}
    failed = [step["component"] for step in steps if step["status"] == FAILED]
    logger.info("AI warm-up (%s mode) finished in %d ms%s", mode, report["duration_ms"],
                f"; failed: {', '.join(failed)}" if failed else "")
    return report


def is_production_mode():
    """True when the AI engine runs with real models (``MODEL_MODE=production``)."""
    from ai.config import get_model_mode

    return get_model_mode() == "production"


def warm_up_in_background(*, name="civicai-ai-warmup"):
    """Run :func:`warm_up_models` in a daemon thread (used by web workers). Returns the started thread."""
    thread = threading.Thread(target=warm_up_models, name=name, daemon=True)
    thread.start()
    return thread
