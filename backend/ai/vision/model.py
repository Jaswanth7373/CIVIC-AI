"""Vision models and the mode-aware model factory.

Three interchangeable techniques expose the same small interface - ``predict(bgr, categories=...)``
returning raw label probabilities + pixel detections, plus metadata (``key``, ``version``, ``is_demo``,
``vocabulary``...). :func:`ai.vision.inference.analyze_image` turns that raw output into the API contract.

=====================  ==================================================================================
DemoHeuristicModel     MODEL_MODE=demo (and last-resort fallback). Deterministic OpenCV colour / texture /
                       shape features (:mod:`ai.vision.heuristics`) -> softmax. Needs only OpenCV.
YOLOModel              Production technique 1: a YOLOv8 detector trained with ``scripts/train_yolo.py``.
                       Needs the ``ultralytics`` package AND the weights file ``YOLO_WEIGHTS``.
CLIPZeroShotModel      Production technique 2: OpenAI CLIP (via sentence-transformers) compares the image
                       embedding with text-prompt embeddings of every class - classification without any
                       civic training data ("zero-shot"). Needs ``sentence-transformers`` + a download.
=====================  ==================================================================================

:func:`get_vision_model` picks the technique for the current ``MODEL_MODE`` and reports honestly why a
production model could not be used (``fallback_reason``). Heavy models are imported lazily, loaded once
per process (``ai.common.get_or_load``) and a failed load is not retried for ``LOAD_RETRY_SECONDS``.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import threading
import time
from importlib import metadata
from pathlib import Path

import cv2
import numpy as np

from ai import config as ai_config
from ai.common import get_or_load, get_statuses, set_status
from ai.exceptions import ModelUnavailableError

from . import config as vcfg
from . import postprocessing as post
from .heuristics import extract_features
from .preprocessing import bgr_to_pil, letterbox

logger = logging.getLogger("ai.vision.model")

STATUS_YOLO = "vision.yolo"
STATUS_CLIP = "vision.clip"
STATUS_DEMO = "vision.demo_heuristic"
STATUS_CLIP_ENCODER = "clip.encoder"
TASK = "Civic issue image classification / detection"


# ======================================================================================================
# Demo technique
# ======================================================================================================
class DemoHeuristicModel:
    """Deterministic OpenCV heuristics (see :mod:`ai.vision.heuristics` for every feature).

    Every defect class gets a 0-1 feature score; ``other`` gets the constant ``DEMO_OTHER_BASE_SCORE`` so
    it wins whenever no defect pattern is convincing. A softmax with temperature
    ``DEMO_SOFTMAX_TEMPERATURE`` turns scores into probabilities (a score lead of 0.2 multiplies the odds
    by e). The regions of the contours / line networks behind each score become the detections.
    """

    key = "demo"
    display_name = "Demo OpenCV heuristics"
    technique = "Demo AI Mode (OpenCV colour, texture and shape heuristics - not a trained model)"
    framework = f"OpenCV {cv2.__version__}"
    version = vcfg.DEMO_MODEL_VERSION
    is_demo = True
    approximate_boxes = False
    vocabulary = tuple(vcfg.VISION_CLASSES)

    def predict(self, img: np.ndarray, *, categories=None) -> dict:
        h, w = img.shape[:2]
        scale = vcfg.ANALYSIS_MAX_SIDE / float(max(h, w))
        if scale != 1.0:   # features use pixel constants tuned for a 640 px longest side
            interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
            view = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=interpolation)
        else:
            view = img
        features = extract_features(view)
        scores = {slug: result.score for slug, result in features.items()}
        scores[vcfg.FALLBACK_CLASS] = vcfg.DEMO_OTHER_BASE_SCORE
        detections = [
            {"label": region.label, "strength": float(region.strength), "box": [v / scale for v in region.box]}
            for result in features.values() for region in result.regions if region.strength > 0.05
        ]
        evidence = {slug: result.evidence for slug, result in features.items()}
        evidence[vcfg.FALLBACK_CLASS] = ("none of the defect patterns (pothole, garbage, water, cracks, ...) "
                                         "was convincing")
        return {
            "label_probs": post.softmax(scores, vcfg.DEMO_SOFTMAX_TEMPERATURE),
            "detections": detections,
            "scores": {k: round(float(v), 3) for k, v in scores.items()},
            "evidence": evidence,
        }


# ======================================================================================================
# Production technique 1 - YOLOv8
# ======================================================================================================
def _to_numpy(value) -> np.ndarray:
    for attr in ("detach", "cpu"):
        if hasattr(value, attr):
            value = getattr(value, attr)()
    return value.numpy() if hasattr(value, "numpy") else np.asarray(value)


class YOLOModel:
    """Ultralytics YOLOv8 detector loaded from ``YOLO_WEIGHTS``.

    The detector returns boxes with class names and confidences (after its own NMS). Class names are mapped
    to CivicAI categories (synonyms + admin ``vision_labels``); image-level probabilities come from the
    boxes' noisy-OR evidence (:func:`ai.vision.postprocessing.evidence_to_label_probs`).
    """

    key = "yolo"
    display_name = "YOLOv8 detector"
    technique = "YOLOv8 object detector"
    is_demo = False
    approximate_boxes = False

    def __init__(self, weights: Path):
        from ultralytics import YOLO   # lazy: heavy optional dependency

        self.weights = Path(weights)
        self.model = YOLO(str(self.weights))
        names = self.model.names
        self.names = dict(names) if isinstance(names, dict) else dict(enumerate(names))
        self.vocabulary = tuple(post.normalize_label(n) for n in self.names.values())
        self.version = f"yolov8:{self.weights.name}"
        self.framework = _package_label("ultralytics", "Ultralytics")
        self._lock = threading.Lock()   # one Ultralytics model instance must not predict in parallel threads

    def predict(self, img: np.ndarray, *, categories=None) -> dict:
        with self._lock:
            results = self.model.predict(img, conf=vcfg.YOLO_CONFIDENCE, iou=vcfg.YOLO_IOU, imgsz=vcfg.YOLO_IMGSZ,
                                         max_det=vcfg.YOLO_MAX_DETECTIONS, device=ai_config.DEVICE, verbose=False)
        boxes = results[0].boxes
        xyxy = _to_numpy(boxes.xyxy).reshape(-1, 4)
        confs = _to_numpy(boxes.conf).reshape(-1)
        classes = _to_numpy(boxes.cls).reshape(-1).astype(int)
        detections = [
            {"label": str(self.names.get(int(c), c)), "confidence": float(p), "box": [float(v) for v in b]}
            for b, p, c in zip(xyxy, confs, classes)
        ]
        evidence = post.detection_evidence(detections)
        found = ", ".join(f"{d['label']} ({post.pct(d['confidence'])})" for d in detections[:5])
        summary = f"YOLO detected {len(detections)} object(s): {found}" if detections else \
            "YOLO detected no civic-issue object above the confidence threshold"
        return {
            "label_probs": post.evidence_to_label_probs(evidence),
            "detections": detections,
            "scores": {k: round(v, 4) for k, v in evidence.items()},
            "evidence": {"*": summary},
        }


# ======================================================================================================
# Production technique 2 - CLIP zero-shot
# ======================================================================================================
class CLIPZeroShotModel:
    """Zero-shot classification with CLIP (contrastive language-image pre-training).

    CLIP maps images and sentences into the same 512-d space so that a photo lies close to sentences that
    describe it. Each class is represented by the normalised mean embedding of several prompts
    (``CLIP_PROMPTS``; admin categories get prompts from their name / vision labels / description). The
    cosine similarities, multiplied by CLIP's logit scale (100), go through a softmax. CLIP does not
    localise, so the box is an approximate salient region (:func:`postprocessing.salient_region_box`).
    """

    key = "clip"
    display_name = "CLIP zero-shot classifier"
    is_demo = False
    approximate_boxes = True

    def __init__(self, encoder):
        self.encoder = encoder
        self.version = f"clip-zero-shot:{ai_config.CLIP_MODEL}"
        self.technique = f"CLIP zero-shot classification ({ai_config.CLIP_MODEL})"
        self.framework = _package_label("sentence-transformers", "sentence-transformers")
        self.vocabulary = tuple(vcfg.VISION_CLASSES)
        self._text_cache: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()

    @staticmethod
    def class_prompts(categories=None) -> dict[str, list[str]]:
        prompts = {slug: list(texts) for slug, texts in vcfg.CLIP_PROMPTS.items()}
        for category in categories or []:
            slug = post.normalize_label(category.get("slug", ""))
            if not slug or slug in prompts:
                continue
            phrases = [str(category.get("name") or slug.replace("_", " ")).lower()]
            labels = category.get("vision_labels") or []
            phrases += [str(label).replace("_", " ").lower() for label in labels if str(label).strip()]
            description = str(category.get("description") or "").strip().split(".")[0][:120]
            texts = [template.format(phrase) for phrase in dict.fromkeys(phrases)
                     for template in vcfg.CLIP_CUSTOM_PROMPT_TEMPLATES]
            if description:
                texts.append(f"a photo of {description.lower()}")
            prompts[slug] = texts[:12]
        return prompts

    def _encode_texts(self, texts: list[str]) -> np.ndarray:
        with self._lock:
            missing = [t for t in texts if t not in self._text_cache]
            if missing:
                vectors = self.encoder.encode(missing, convert_to_numpy=True, normalize_embeddings=True,
                                              show_progress_bar=False)
                self._text_cache.update(zip(missing, np.asarray(vectors, dtype=np.float32)))
            return np.stack([self._text_cache[t] for t in texts])

    def class_embeddings(self, prompts: dict[str, list[str]]):
        slugs = list(prompts)
        matrix = []
        for slug in slugs:
            mean = self._encode_texts(prompts[slug]).mean(axis=0)
            matrix.append(mean / (np.linalg.norm(mean) + 1e-12))
        return slugs, np.stack(matrix)

    def encode_image(self, img: np.ndarray) -> np.ndarray:
        """L2-normalised CLIP embedding of a BGR image (letterboxed so nothing is cropped away)."""
        square, _, _ = letterbox(img, vcfg.CLIP_INPUT_SIDE)
        vector = self.encoder.encode([bgr_to_pil(square)], convert_to_numpy=True, normalize_embeddings=True,
                                     show_progress_bar=False)
        return np.asarray(vector, dtype=np.float32).reshape(-1)

    def predict(self, img: np.ndarray, *, categories=None) -> dict:
        slugs, text = self.class_embeddings(self.class_prompts(categories))
        similarities = text @ self.encode_image(img)
        probs = post.softmax(dict(zip(slugs, vcfg.CLIP_LOGIT_SCALE * similarities)), 1.0)
        top = max(probs, key=probs.get)
        box = post.salient_region_box(img)
        detections = [{"label": top, "strength": 1.0, "box": box}] if box and top != vcfg.FALLBACK_CLASS else []
        best_prompt = max(vcfg.CLIP_PROMPTS.get(top, [top.replace("_", " ")]), key=len)
        return {
            "label_probs": probs,
            "detections": detections,
            "scores": {slug: round(float(s), 4) for slug, s in zip(slugs, similarities)},
            "evidence": {"*": f"the image embedding is closest to text prompts such as \"{best_prompt}\""},
        }


# ======================================================================================================
# Loading with caching, honest status reporting and negative caching of failures
# ======================================================================================================
_failures: dict[str, tuple[float, str]] = {}
_failures_lock = threading.Lock()


def _package_label(dist: str, label: str) -> str:
    try:
        return f"{label} {metadata.version(dist)}"
    except metadata.PackageNotFoundError:
        return label


def short_error(exc: Exception, limit: int = 160) -> str:
    """``"OSError: first line of the message"`` - concise enough for an explanation shown to users."""
    lines = str(exc).strip().splitlines()
    text = f"{type(exc).__name__}: {lines[0] if lines else ''}".rstrip(": ")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _display_path(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ai_config.BACKEND_ROOT)).replace("\\", "/")
    except ValueError:
        return Path(path).name


def _recent_failure(key: str):
    with _failures_lock:
        entry = _failures.get(key)
    if entry and time.monotonic() - entry[0] < vcfg.LOAD_RETRY_SECONDS:
        return entry[1]
    return None


def _record_failure(key: str, reason: str) -> None:
    with _failures_lock:
        _failures[key] = (time.monotonic(), reason)


def reset_load_failures() -> None:
    """Forget failed model loads so the next request retries immediately (tests / after installing a model)."""
    with _failures_lock:
        _failures.clear()


def _yolo_unavailable_reason():
    if not _installed("ultralytics"):
        return "YOLO: the 'ultralytics' package is not installed"
    weights = Path(ai_config.YOLO_WEIGHTS)
    if not weights.is_file():
        return f"YOLO: trained weights not found at {_display_path(weights)}"
    return None


def load_yolo_model() -> YOLOModel:
    """Load (once) the YOLOv8 detector or raise :class:`ModelUnavailableError` with a readable reason."""
    reason = _yolo_unavailable_reason() or _recent_failure("yolo")
    if reason:
        raise ModelUnavailableError(reason)
    weights = Path(ai_config.YOLO_WEIGHTS)
    try:
        return get_or_load(f"vision.yolo:{weights}", lambda: YOLOModel(weights))
    except Exception as exc:  # broken weights, incompatible ultralytics version, ...
        reason = f"YOLO: could not load {weights.name} ({short_error(exc)})"
        logger.warning(reason)
        _record_failure("yolo", reason)
        raise ModelUnavailableError(reason) from exc


def clip_is_cached() -> bool:
    """Whether the CLIP weights are already on disk (otherwise the first load downloads ~600 MB)."""
    name = ai_config.CLIP_MODEL
    if Path(name).is_dir():
        return True
    repo = name if "/" in name else f"sentence-transformers/{name}"
    cache = Path(ai_config.HF_CACHE_DIR)
    return (cache / ("models--" + repo.replace("/", "--"))).is_dir() or (cache / repo.replace("/", "_")).is_dir()


def load_clip_encoder():
    """The shared ``SentenceTransformer`` CLIP encoder (also used by resolution verification)."""
    if not _installed("sentence_transformers"):
        raise ModelUnavailableError("CLIP: the 'sentence-transformers' package is not installed")
    reason = _recent_failure("clip")
    if reason:
        raise ModelUnavailableError(reason)

    def _load():
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        from sentence_transformers import SentenceTransformer   # lazy: imports torch

        Path(ai_config.HF_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        encoder = SentenceTransformer(ai_config.CLIP_MODEL, cache_folder=str(ai_config.HF_CACHE_DIR),
                                      device=ai_config.DEVICE)
        set_status(STATUS_CLIP_ENCODER, task="Shared CLIP image / text encoder", status="active",
                   version=ai_config.CLIP_MODEL,
                   framework=_package_label("sentence-transformers", "sentence-transformers"),
                   detail="Loaded once per process; used for zero-shot vision and before/after scene similarity.")
        return encoder

    try:
        return get_or_load(f"clip.encoder:{ai_config.CLIP_MODEL}", _load)
    except Exception as exc:  # no internet on first use, corrupt cache, out of memory, ...
        reason = f"CLIP: could not load {ai_config.CLIP_MODEL} ({short_error(exc)})"
        logger.warning(reason)
        _record_failure("clip", reason)
        raise ModelUnavailableError(reason) from exc


def clip_status() -> tuple[str, str]:
    """Installation state of the shared CLIP encoder without loading it.

    Returns ``(state, detail)`` with state ``not_installed`` / ``error`` (recent failed load) / ``loaded``
    (in memory in this process) / ``available``.
    """
    if not _installed("sentence_transformers"):
        return "not_installed", "Install requirements-ml.txt (sentence-transformers)."
    failure = _recent_failure("clip")
    if failure:
        return "error", failure
    cached = "weights cached locally" if clip_is_cached() else "weights (~600 MB) download on first use"
    encoder = next((s for s in get_statuses() if s["name"] == STATUS_CLIP_ENCODER), None)
    if encoder and encoder["status"] == "active" and encoder["version"] == ai_config.CLIP_MODEL:
        return "loaded", f"Loaded ({cached})."
    return "available", f"Ready ({cached})."


def load_clip_model() -> CLIPZeroShotModel:
    encoder = load_clip_encoder()
    return get_or_load(f"vision.clip:{ai_config.CLIP_MODEL}", lambda: CLIPZeroShotModel(encoder))


def get_demo_model() -> DemoHeuristicModel:
    return get_or_load("vision.demo", DemoHeuristicModel)


def _report(model, status: str, detail: str) -> None:
    name = {"yolo": STATUS_YOLO, "clip": STATUS_CLIP, "demo": STATUS_DEMO}[model.key]
    set_status(name, task=TASK, status=status, version=model.version, framework=model.framework,
               is_demo=model.is_demo, detail=detail)


def get_vision_model(mode: str | None = None):
    """Return ``(model, fallback_reason)`` for ``mode`` (default: the current ``MODEL_MODE``).

    demo        -> the OpenCV heuristics, ``fallback_reason=None``.
    production  -> YOLOv8 if ``ultralytics`` and the weights exist, else CLIP zero-shot, else the demo
                   heuristics with ``fallback_reason`` explaining what was missing.
    """
    mode = mode or ai_config.get_model_mode()
    demo = get_demo_model()
    if mode != "production":
        _report(demo, "active", "MODEL_MODE=demo: transparent OpenCV heuristics, confidences capped at 75%.")
        return demo, None
    reasons = []
    for loader in (load_yolo_model, load_clip_model):
        try:
            model = loader()
        except ModelUnavailableError as exc:
            reasons.append(str(exc))
            continue
        _report(model, "active", f"Production vision model in use ({model.technique}).")
        _report(demo, "available", "Standby: used only if the production models fail.")
        return model, None
    reason = "; ".join(reasons)
    _report(demo, "fallback", f"Production models unavailable - {reason}")
    return demo, reason


def mark_inference_failure(model, exc: Exception) -> str:
    """Record that a production model crashed while predicting; returns the fallback reason."""
    reason = f"{model.display_name} failed during inference ({short_error(exc)})"
    _report(model, "error", reason)
    _report(get_demo_model(), "fallback", reason)
    return reason


# ======================================================================================================
# Model information for the admin page
# ======================================================================================================
def describe_models() -> list[dict]:
    """``[{name, task, framework, version, status, is_demo, detail}]`` for YOLO, CLIP and the demo model.

    Status is computed without loading anything: ``not_installed`` / ``weights_missing`` / ``error`` /
    ``available`` (usable, not loaded yet or not used in this mode) / ``active`` (loaded and in use) /
    ``fallback`` (production requested but the demo technique is being used).
    """
    mode = ai_config.get_model_mode()
    registry = {s["name"]: s for s in get_statuses()}

    def loaded(name):
        return registry.get(name, {}).get("status") == "active"

    def crashed(name):   # failed while predicting (see mark_inference_failure)
        entry = registry.get(name, {})
        return entry.get("detail", "") if entry.get("status") == "error" else ""

    yolo_reason = _yolo_unavailable_reason()
    if yolo_reason and "not installed" in yolo_reason:
        yolo_status = "not_installed"
        yolo_detail = "Install requirements-ml.txt and train weights with scripts/train_yolo.py."
    elif yolo_reason:
        missing = yolo_reason.replace("YOLO: ", "")
        yolo_status = "weights_missing"
        yolo_detail = f"{missing[0].upper()}{missing[1:]} - train them with scripts/train_yolo.py."
    elif _recent_failure("yolo") or crashed(STATUS_YOLO):
        yolo_status, yolo_detail = "error", _recent_failure("yolo") or crashed(STATUS_YOLO)
    elif mode == "production" and loaded(STATUS_YOLO):
        yolo_status, yolo_detail = "active", "Primary production detector."
    else:
        yolo_status = "available"
        yolo_detail = "Weights found; loaded on the first production request." if mode == "production" else \
            "Ready; used when MODEL_MODE=production."
    yolo_usable = yolo_status in ("available", "active")

    clip_state, clip_detail = clip_status()
    if clip_state in ("loaded", "available") and crashed(STATUS_CLIP):
        clip_state, clip_detail = "error", crashed(STATUS_CLIP)
    if clip_state == "loaded":
        clip_state = "active" if mode == "production" and loaded(STATUS_CLIP) else "available"
        clip_detail = "Zero-shot classification of complaint photos." if clip_state == "active" else clip_detail
    if clip_state == "available" and mode == "production":
        clip_detail += " Standby behind YOLO." if yolo_usable else " Used for classification in production mode."
    elif clip_state == "available":
        clip_detail += " Used when MODEL_MODE=production."
    clip_usable = clip_state in ("available", "active")

    if mode != "production":
        demo_status, demo_detail = "active", "Demo AI Mode: OpenCV heuristics, confidences capped at 75%."
    elif registry.get(STATUS_DEMO, {}).get("status") == "fallback":
        demo_status, demo_detail = "fallback", registry[STATUS_DEMO]["detail"]
    elif yolo_usable or clip_usable:
        demo_status, demo_detail = "available", "Used only if the production models fail."
    else:
        demo_status, demo_detail = "fallback", "No production vision model is usable, so the demo technique is used."

    return [
        {"name": "YOLOv8 civic issue detector", "task": "Civic issue object detection",
         "framework": _package_label("ultralytics", "Ultralytics"), "version": Path(ai_config.YOLO_WEIGHTS).name,
         "status": yolo_status, "is_demo": False, "detail": yolo_detail},
        {"name": "CLIP zero-shot classifier", "task": "Civic issue image classification (zero-shot)",
         "framework": _package_label("sentence-transformers", "sentence-transformers"),
         "version": ai_config.CLIP_MODEL, "status": clip_state, "is_demo": False, "detail": clip_detail},
        {"name": "Demo OpenCV heuristics", "task": TASK, "framework": f"OpenCV {cv2.__version__}",
         "version": vcfg.DEMO_MODEL_VERSION, "status": demo_status, "is_demo": True, "detail": demo_detail},
    ]
