"""Central configuration for the CivicAI AI engine (framework independent).

MODEL_MODE
    demo        Runs the full pipeline WITHOUT trained deep-learning weights.
                Uses deterministic, transparent techniques (OpenCV heuristics,
                TF-IDF + scikit-learn, lexicon sentiment, perceptual hashing).
                Every result is flagged ``is_demo=True`` and the UI shows
                "Demo AI Mode". Demo predictions are never presented as trained-model output.
    production  Loads trained / pretrained models: YOLO weights (ultralytics),
                Sentence-Transformers embeddings, Hugging Face sentiment, CLIP.
                If a model cannot be loaded, the module falls back to the demo
                technique and reports ``fallback_reason`` - never silently.
"""
import os
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = AI_ROOT.parent

try:  # Allow standalone scripts (training, tests) to read backend/.env too
    from dotenv import load_dotenv

    load_dotenv(BACKEND_ROOT / ".env", override=False)
except Exception:  # pragma: no cover
    pass


def _env(key, default=None):
    value = os.environ.get(key)
    return value if value not in (None, "") else default


def get_model_mode() -> str:
    """Current mode: "demo" or "production" (read on every call so tests can switch it)."""
    mode = str(_env("MODEL_MODE", "demo")).strip().lower()
    return mode if mode in ("demo", "production") else "demo"


def is_demo_mode() -> bool:
    return get_model_mode() == "demo"


def _resolve(path_value, default: Path) -> Path:
    if not path_value:
        return default
    p = Path(path_value)
    return p if p.is_absolute() else (BACKEND_ROOT / p).resolve()


MODEL_PATH = _resolve(_env("MODEL_PATH"), BACKEND_ROOT / "ml_models")
YOLO_WEIGHTS = _resolve(_env("YOLO_WEIGHTS"), MODEL_PATH / "yolo" / "civicai_yolov8.pt")
TEXT_EMBEDDING_MODEL = _env("TEXT_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
SENTIMENT_MODEL = _env("SENTIMENT_MODEL", "cardiffnlp/twitter-roberta-base-sentiment-latest")
CLIP_MODEL = _env("CLIP_MODEL", "clip-ViT-B-32")
HF_CACHE_DIR = _resolve(_env("HF_CACHE_DIR"), MODEL_PATH / "hf_cache")
DEVICE = _env("AI_DEVICE", "cpu")

DEMO_BADGE = "Demo AI Mode"
DEMO_DISCLAIMER = (
    "Demo AI Mode: results come from transparent heuristic / lightweight models, "
    "not from trained deep-learning weights."
)

# Canonical civic issue classes shared by vision / nlp / fusion. They equal the
# slugs of the default CivicCategory rows. Admin-created categories are handled
# through their DB keywords / vision_labels (see ai.nlp.classifier, ai.vision.postprocessing).
CIVIC_CLASSES = [
    "pothole",
    "garbage",
    "drainage",
    "streetlight",
    "water_leak",
    "open_manhole",
    "road_crack",
    "fallen_tree",
    "other",
]

CLASS_LABELS = {
    "pothole": "Pothole",
    "garbage": "Garbage / Waste",
    "drainage": "Drainage / Waterlogging",
    "streetlight": "Streetlight / Electricity",
    "water_leak": "Water Leakage",
    "open_manhole": "Open Manhole",
    "road_crack": "Road Crack / Damage",
    "fallen_tree": "Fallen Tree / Obstruction",
    "other": "Other",
}

LEVELS = ["low", "medium", "high", "critical"]
DEFAULT_LEVEL_THRESHOLDS = {"medium": 26, "high": 51, "critical": 76}


def score_to_level(score: float, thresholds: dict | None = None) -> str:
    """Map a 0-100 score to low/medium/high/critical using inclusive lower thresholds."""
    t = {**DEFAULT_LEVEL_THRESHOLDS, **(thresholds or {})}
    if score >= t["critical"]:
        return "critical"
    if score >= t["high"]:
        return "high"
    if score >= t["medium"]:
        return "medium"
    return "low"


def mode_info() -> dict:
    mode = get_model_mode()
    return {"mode": mode, "is_demo": mode == "demo", "badge": DEMO_BADGE if mode == "demo" else "Production AI"}
