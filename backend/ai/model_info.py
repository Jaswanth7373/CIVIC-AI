"""Model information for the admin "AI settings / model info" page (BUILD_SPEC section 2.9).

Aggregates, at call time:

* ``models``     - ``describe_models()`` of the vision, NLP and verification modules (each call is
                   isolated: a failing module is reported with status "error" instead of breaking the page);
* ``components`` - descriptions of the rule-based / classical engines (priority, duplicates, DBSCAN
                   hotspots, multimodal fusion, severity) with their live parameters;
* ``registry``   - load status of every lazily loaded model (``ai.common.registry``);
* mode, badge and the demo disclaimer.
"""
import importlib
import logging

from .common import get_statuses
from .config import DEMO_DISCLAIMER, mode_info

logger = logging.getLogger("ai.model_info")

_MODEL_MODULES = (
    ("vision", "Civic issue image classification / detection"),
    ("nlp", "Complaint text analysis"),
    ("verification", "Before/after resolution verification"),
)


def _describe(module_name, task):
    """``describe_models()`` of ``ai.<module_name>``; an error row when it cannot be produced."""
    try:
        module = importlib.import_module(f"{__package__}.{module_name}")
        return [dict(row) for row in module.describe_models()]
    except Exception as exc:  # noqa: BLE001 - one broken module must not hide the others
        logger.warning("describe_models() failed for ai.%s: %s", module_name, exc)
        return [{"name": module_name, "task": task, "framework": "", "version": "", "status": "error",
                 "is_demo": True, "detail": f"Model description unavailable ({type(exc).__name__}: {exc})"}]


def _section(config, key):
    return config.get(key) if isinstance(config, dict) and isinstance(config.get(key), dict) else {}


def _components(config, is_demo):
    from .duplicate.duplicate_engine import DEFAULT_DUPLICATE_CONFIG, DUPLICATE_ENGINE_VERSION
    from .geospatial.hotspots import HOTSPOT_ENGINE_VERSION
    from .multimodal.fusion import DEFAULT_FUSION_CONFIG, FUSION_METHOD, FUSION_VERSION
    from .priority import COMPONENT_LABELS, PRIORITY_ENGINE_VERSION, PriorityConfig
    from .severity import DEFAULT_FACTOR_WEIGHTS, SEVERITY_ENGINE_VERSION

    try:
        priority = PriorityConfig.from_dict(config)
    except ValueError as exc:
        logger.warning("Invalid priority configuration, describing defaults: %s", exc)
        priority = PriorityConfig()
    weights = {key: round(value, 2) for key, value in priority.weights.items()}
    weight_text = ", ".join(f"{COMPONENT_LABELS[key].lower()} {value:g}" for key, value in weights.items())
    thresholds = priority.thresholds

    duplicate = {**DEFAULT_DUPLICATE_CONFIG, **_section(config, "duplicate")}
    duplicate_weights = {**DEFAULT_DUPLICATE_CONFIG["weights"], **(duplicate.get("weights") or {})}
    hotspot = {"eps_m": 400, "min_samples": 3, **_section(config, "hotspot")}
    fusion = {**DEFAULT_FUSION_CONFIG, **_section(config, "fusion")}
    try:
        import sklearn

        sklearn_version = f"scikit-learn {sklearn.__version__}"
    except ImportError:
        sklearn_version = "scikit-learn (not installed)"

    def source(key):
        """Whether the numbers in a component's detail come from the live configuration or the defaults."""
        return "configured" if _section(config, key) else "defaults"

    image_signals = "perceptual hashes + colour histograms" + ("" if is_demo else " + CLIP embeddings")
    return [
        {
            "key": "priority", "name": "Priority engine", "task": "0-100 priority score with explanation",
            "framework": "Python (weighted rule-based scoring)", "version": PRIORITY_ENGINE_VERSION,
            "status": "active", "is_demo": False, "parameters": source("priority"),
            "detail": (f"Component weights: {weight_text}. Levels: medium >= {thresholds['medium']}, high >= "
                       f"{thresholds['high']}, critical >= {thresholds['critical']}. Frequency and duplicates "
                       f"saturate as 1 - exp(-{priority.frequency_k:g}n); reopened complaints get "
                       f"+{priority.reopen_bump:g} points."),
            "weights": weights, "thresholds": dict(thresholds),
        },
        {
            "key": "duplicates", "name": "Duplicate engine", "task": "Duplicate complaint detection",
            "framework": "Text embeddings + ImageHash/OpenCV" + ("" if is_demo else " + CLIP"),
            "version": DUPLICATE_ENGINE_VERSION, "status": "active", "is_demo": is_demo,
            "parameters": source("duplicate"),
            "detail": (f"Overall = {duplicate_weights['text']:g} text + {duplicate_weights['image']:g} image + "
                       f"{duplicate_weights['location']:g} location similarity (image weight redistributed when a "
                       f"photo is missing; x0.85 for a category mismatch). Images: {image_signals}. Duplicate "
                       f"when >= {float(duplicate['threshold']):g} within {float(duplicate['radius_m']):g} m."),
        },
        {
            "key": "hotspots", "name": "DBSCAN hotspots", "task": "Geospatial hotspot clustering",
            "framework": sklearn_version, "version": HOTSPOT_ENGINE_VERSION, "status": "active", "is_demo": False,
            "parameters": source("hotspot"),
            "detail": (f"DBSCAN(metric='haversine', algorithm='ball_tree') on radian coordinates, eps = "
                       f"{float(hotspot['eps_m']):g} m / 6 371 km, min_samples = {int(hotspot['min_samples'])}; "
                       f"isolated complaints are noise."),
        },
        {
            "key": "fusion", "name": "Multimodal fusion", "task": "Image + text + location category decision",
            "framework": "Python (probabilistic late fusion)", "version": FUSION_VERSION, "status": "active",
            "is_demo": False, "parameters": source("fusion"),
            "detail": (f"{FUSION_METHOD}: image {float(fusion['image_weight']):g} / text "
                       f"{float(fusion['text_weight']):g} scaled by confidence and photo quality, citizen category "
                       f"and nearby categories as weak priors; manual review below "
                       f"{float(fusion['min_confidence']):.0%} confidence or on confident disagreement."),
        },
        {
            "key": "severity", "name": "Severity engine", "task": "Low / medium / high / critical severity",
            "framework": "Python (weighted factor model)", "version": SEVERITY_ENGINE_VERSION, "status": "active",
            "is_demo": False, "parameters": source("severity"),
            "detail": ("Weighted factors: " + ", ".join(f"{key.replace('_', ' ')} {value:g}"
                                                         for key, value in DEFAULT_FACTOR_WEIGHTS.items())
                       + "; missing evidence is redistributed; open manholes are at least high."),
        },
    ]


def get_model_info(config=None):
    """Returns {"mode", "is_demo", "badge", "models": [describe_models() of vision, nlp, verification, ...],
    "components": [...static descriptions of priority/duplicate/hotspot engines...]}

    plus ``"registry"`` (``get_statuses()``) and ``"disclaimer"`` (``DEMO_DISCLAIMER`` in demo mode, else None).
    ``config`` (optional) is ``AIConfiguration.to_engine_config()`` so components show the live parameters;
    every component reports ``"parameters": "configured" | "defaults"`` accordingly.
    """
    info = mode_info()
    models = []
    for module_name, task in _MODEL_MODULES:
        models.extend(_describe(module_name, task))
    return {
        **info,
        "models": models,
        "components": _components(config, info["is_demo"]),
        "registry": get_statuses(),
        "disclaimer": DEMO_DISCLAIMER if info["is_demo"] else None,
    }
