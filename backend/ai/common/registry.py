"""Thread-safe lazy model cache + model status registry.

Heavy models are loaded once per process on first use::

    from ai.common import get_or_load, set_status
    model = get_or_load("nlp.embedder", lambda: SentenceTransformer(name))
    set_status("nlp.embedder", task="Text embeddings", status="active", version=name,
               framework="sentence-transformers", is_demo=False)

``get_statuses()`` feeds the admin "Model information" page.
Status values: "active" (loaded & used), "available" (installed, not loaded yet),
"fallback" (production requested but demo technique used), "not_installed",
"weights_missing", "error".
"""
import threading
import time

_cache: dict = {}
_status: dict = {}
_locks: dict = {}
_global_lock = threading.Lock()


def _lock_for(key):
    with _global_lock:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def get_or_load(key, loader):
    """Return the cached object for ``key`` or build it with ``loader()`` (once)."""
    if key in _cache:
        return _cache[key]
    with _lock_for(key):
        if key not in _cache:
            _cache[key] = loader()
        return _cache[key]


def set_status(name, *, task, status, version="", framework="", is_demo=False, detail=""):
    _status[name] = {
        "name": name,
        "task": task,
        "status": status,
        "version": version,
        "framework": framework,
        "is_demo": bool(is_demo),
        "detail": detail,
        "updated_at": time.time(),
    }


def get_statuses():
    return [dict(v) for v in _status.values()]


def reset_registry():
    """Clear cached models and statuses (used by tests / mode switches)."""
    with _global_lock:
        _cache.clear()
        _status.clear()
