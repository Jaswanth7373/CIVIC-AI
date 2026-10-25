"""Perceptual image hashing & image similarity (BUILD_SPEC section 2.6).

Techniques:

* **Perceptual hashes** (``imagehash``, 8x8 = 64-bit, stored as 16 hex characters):
    - aHash: shrink to 8x8 grey, bit = pixel brighter than the mean;
    - dHash: shrink to 9x8 grey, bit = pixel brighter than its right neighbour (gradients);
    - pHash: 32x32 grey -> 2-D DCT -> keep the 8x8 lowest frequencies, bit = coefficient above the
      median (robust to resizing, JPEG re-compression and small colour changes).
  Similar images have hashes that differ in few bits: ``similarity = 1 - hamming_distance / 64``.
  Two unrelated photos differ in about half of the bits, so ~0.5 is the chance level.
* **Colour histogram correlation**: 2-D Hue x Saturation histogram (30 x 32 bins, brightness
  ignored so lighting changes matter less) compared with Pearson correlation
  (``cv2.HISTCMP_CORREL``), clipped to [0, 1].
* **CLIP image embeddings** (production only): both photos are embedded with the CLIP image
  encoder and compared by cosine similarity. CLIP cosine between unrelated photos is ~0.5, so it is
  rescaled ``(cos - 0.5) / 0.5`` to [0, 1]. Unlike hashes, CLIP recognises the *same scene*
  photographed from a different angle.

Combination: demo = 0.6 x hash + 0.4 x histogram; production = 0.5 x CLIP + 0.3 x hash +
0.2 x histogram (renormalised over the parts that are available). The hash part is the weighted
mean of pHash 0.5 / dHash 0.3 / aHash 0.2 over the kinds both images have.
"""
import io
import logging
import math
import os

import numpy as np

from ..common import get_or_load, set_status
from ..config import CLIP_MODEL, DEVICE, HF_CACHE_DIR, get_model_mode
from ..exceptions import ImageProcessingError

logger = logging.getLogger("ai.duplicate")

HASH_SIZE = 8  # 8 x 8 = 64-bit hashes -> 16 hex characters
HASH_KIND_WEIGHTS = {"phash": 0.5, "dhash": 0.3, "ahash": 0.2}
HISTOGRAM_BINS = (30, 32)  # hue (OpenCV range 0-180), saturation (0-256)
HISTOGRAM_MAX_SIDE = 256  # histograms are computed on a downscaled copy (speed, less noise)
DEMO_COMBINATION = {"hash": 0.6, "histogram": 0.4}
PRODUCTION_COMBINATION = {"clip": 0.5, "hash": 0.3, "histogram": 0.2}
CLIP_UNRELATED_COSINE = 0.5
# Same registry key as ai.vision.model.load_clip_encoder(), so the vision, verification and duplicate
# modules share ONE CLIP instance (~600 MB) per process.
CLIP_REGISTRY_KEY = f"clip.encoder:{CLIP_MODEL}"
_CLIP_STATE_KEY = "duplicate.clip_state"
_CLIP_STATUS_NAME = "duplicate.image_embeddings"


# ----------------------------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------------------------
def load_image_bgr(image):
    """Decode a path / bytes / file-like / PIL.Image / ndarray into a BGR ``uint8`` array (H, W, 3).

    Uses the engine's shared loader ``ai.vision.preprocessing.load_image`` (EXIF-aware); if that module
    is not importable or raises, a small local Pillow loader is used instead. Raises
    ``ImageProcessingError`` when the input cannot be decoded at all.
    """
    try:
        from ..vision.preprocessing import load_image
    except ImportError as exc:
        logger.debug("ai.vision.preprocessing unavailable (%s); using the Pillow loader", exc)
    else:
        try:
            return load_image(image)
        except Exception as exc:  # noqa: BLE001 - any loader failure falls back to Pillow
            logger.debug("ai.vision.preprocessing.load_image failed (%s: %s); using the Pillow loader",
                         type(exc).__name__, exc)
    return _pil_load_bgr(image)


def _pil_load_bgr(image):
    """Minimal Pillow-based loader (EXIF orientation honoured) used when the vision loader is unavailable."""
    from PIL import Image, ImageOps

    if image is None:
        raise ImageProcessingError("No image was provided.")
    if isinstance(image, np.ndarray):
        return _array_to_bgr(image)
    try:
        if isinstance(image, Image.Image):
            rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB"), dtype=np.uint8)
        else:
            if isinstance(image, (bytes, bytearray, memoryview)):
                source = io.BytesIO(bytes(image))
            elif isinstance(image, (str, os.PathLike)):
                source = os.fspath(image)
            elif hasattr(image, "read"):
                position = image.tell() if hasattr(image, "tell") else None
                data = image.read()
                if position is not None and hasattr(image, "seek"):
                    image.seek(position)
                source = io.BytesIO(data)
            else:
                raise ImageProcessingError(f"Unsupported image input type: {type(image).__name__}.")
            with Image.open(source) as pil:
                pil.load()
                rgb = np.asarray(ImageOps.exif_transpose(pil).convert("RGB"), dtype=np.uint8)
    except ImageProcessingError:
        raise
    except Exception as exc:  # noqa: BLE001 - every decoding problem becomes ImageProcessingError
        raise ImageProcessingError(f"Could not decode the image: {exc}") from exc
    return np.ascontiguousarray(rgb[:, :, ::-1])


def _array_to_bgr(arr):
    """Coerce a numpy image (grey, BGR or BGRA; uint8 or float 0..1) to BGR uint8."""
    if arr.size == 0:
        raise ImageProcessingError("The image array is empty.")
    if arr.dtype != np.uint8:
        values = np.nan_to_num(arr.astype(np.float64))
        if np.issubdtype(arr.dtype, np.floating) and values.max(initial=0.0) <= 1.0:
            values = values * 255.0
        arr = np.clip(values, 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        return np.ascontiguousarray(np.repeat(arr[:, :, None], 3, axis=2))
    if arr.ndim == 3 and arr.shape[2] in (1, 3, 4):
        if arr.shape[2] == 1:
            return np.ascontiguousarray(np.repeat(arr, 3, axis=2))
        return np.ascontiguousarray(arr[:, :, :3])
    raise ImageProcessingError(f"Unsupported image array shape {arr.shape}.")


def _bgr_to_pil(bgr):
    from PIL import Image

    return Image.fromarray(np.ascontiguousarray(bgr[:, :, ::-1]))


# ----------------------------------------------------------------------------------------------
# Perceptual hashes
# ----------------------------------------------------------------------------------------------
def _hashes_from_pil(pil):
    import imagehash

    return {
        "phash": str(imagehash.phash(pil, hash_size=HASH_SIZE)),
        "dhash": str(imagehash.dhash(pil, hash_size=HASH_SIZE)),
        "ahash": str(imagehash.average_hash(pil, hash_size=HASH_SIZE)),
    }


def compute_hashes(image):
    """Return {"phash": "<16 hex>", "dhash": "<16 hex>", "ahash": "<16 hex>", "width": int, "height": int}.

    ``image``: path, bytes, PIL.Image or numpy array (BGR). Raises ImageProcessingError if it cannot be decoded.
    """
    bgr = load_image_bgr(image)
    return {**_hashes_from_pil(_bgr_to_pil(bgr)), "width": int(bgr.shape[1]), "height": int(bgr.shape[0])}


def _hash_hex(value):
    """Normalised hex string of a hash (str or imagehash.ImageHash) or None if missing / invalid."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    try:
        int(text, 16)
    except ValueError:
        return None
    return text


def hash_similarity(hash_a, hash_b):
    """Similarity in [0, 1] from the Hamming distance of two hex hashes (1.0 = identical). None-safe -> None.

    ``1 - hamming / bits`` with bits = 4 x hex length (64 for the 16-hex hashes used here). Hashes of
    different lengths are not comparable and also return None.
    """
    a, b = _hash_hex(hash_a), _hash_hex(hash_b)
    if a is None or b is None or len(a) != len(b):
        return None
    bits = 4 * len(a)
    distance = (int(a, 16) ^ int(b, 16)).bit_count()
    return round(1.0 - distance / bits, 4)


def combined_hash_similarity(hashes_a, hashes_b):
    """Weighted mean (pHash 0.5, dHash 0.3, aHash 0.2) over the hash kinds both sides have, or None."""
    total, weight_sum = 0.0, 0.0
    for kind, weight in HASH_KIND_WEIGHTS.items():
        similarity = hash_similarity((hashes_a or {}).get(kind), (hashes_b or {}).get(kind))
        if similarity is not None:
            total += weight * similarity
            weight_sum += weight
    return round(total / weight_sum, 4) if weight_sum else None


# ----------------------------------------------------------------------------------------------
# Colour histograms
# ----------------------------------------------------------------------------------------------
def color_histogram(bgr):
    """L1-normalised Hue x Saturation histogram of a BGR image (float32, 30 x 32)."""
    import cv2

    h, w = bgr.shape[:2]
    scale = HISTOGRAM_MAX_SIDE / max(h, w)
    if scale < 1.0:
        bgr = cv2.resize(bgr, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                         interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, list(HISTOGRAM_BINS), [0, 180, 0, 256])
    cv2.normalize(hist, hist, alpha=1.0, norm_type=cv2.NORM_L1)
    return hist


def histogram_similarity(hist_a, hist_b):
    """Pearson correlation of two histograms clipped to [0, 1] (negative correlation = dissimilar)."""
    import cv2

    correlation = float(cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL))
    if not math.isfinite(correlation):
        return 0.0
    return round(min(1.0, max(0.0, correlation)), 4)


# ----------------------------------------------------------------------------------------------
# CLIP embeddings (production)
# ----------------------------------------------------------------------------------------------
class _ClipState:
    """Per registry lifetime: why CLIP could not be loaded (so it is not retried for every image)."""

    def __init__(self):
        self.failure = None
        self.reported_active = False


def _load_clip():
    """Load the CLIP SentenceTransformer with the same arguments as the vision module's shared encoder."""
    from sentence_transformers import SentenceTransformer  # lazy: imports torch

    return SentenceTransformer(CLIP_MODEL, cache_folder=str(HF_CACHE_DIR), device=DEVICE)


def _shared_clip_encoder():
    """The process-wide CLIP encoder: the vision module's loader when available, else loaded here (same key)."""
    try:
        from ..vision.model import load_clip_encoder
    except ImportError:
        return get_or_load(CLIP_REGISTRY_KEY, _load_clip)
    return load_clip_encoder()


def _clip_model():
    state = get_or_load(_CLIP_STATE_KEY, _ClipState)
    if state.failure:
        return None
    try:
        model = _shared_clip_encoder()
    except Exception as exc:  # noqa: BLE001 - missing package, missing weights, no network...
        state.failure = f"{type(exc).__name__}: {exc}"
        logger.warning("CLIP image embeddings unavailable, using hashes + histograms: %s", state.failure)
        set_status(_CLIP_STATUS_NAME, task="Image embeddings for duplicate detection", status="fallback",
                   version=CLIP_MODEL, framework="sentence-transformers", is_demo=True,
                   detail=f"CLIP unavailable ({state.failure}); perceptual hashes + colour histograms used")
        return None
    if not state.reported_active:
        state.reported_active = True
        set_status(_CLIP_STATUS_NAME, task="Image embeddings for duplicate detection", status="active",
                   version=CLIP_MODEL, framework="sentence-transformers", is_demo=False,
                   detail="CLIP image embeddings compared by cosine similarity")
    return model


def clip_embedding(bgr):
    """L2-normalised CLIP image embedding of a BGR image, or None when CLIP is unavailable."""
    model = _clip_model()
    if model is None:
        return None
    vector = model.encode([_bgr_to_pil(bgr)], convert_to_numpy=True, normalize_embeddings=True)[0]
    return np.asarray(vector, dtype=np.float32)


def clip_similarity(vec_a, vec_b):
    """Cosine of two CLIP embeddings rescaled so unrelated photos (~0.5) -> 0 and identical -> 1."""
    norm = float(np.linalg.norm(vec_a) * np.linalg.norm(vec_b))
    if norm == 0.0:
        return None
    cosine = float(np.dot(vec_a, vec_b)) / norm
    return round(min(1.0, max(0.0, (cosine - CLIP_UNRELATED_COSINE) / (1.0 - CLIP_UNRELATED_COSINE))), 4)


# ----------------------------------------------------------------------------------------------
# Features + comparison
# ----------------------------------------------------------------------------------------------
def extract_features(image, *, use_clip=None):
    """Everything needed to compare an image: hashes, colour histogram and (production) CLIP embedding.

    ``use_clip`` defaults to ``MODEL_MODE == "production"``. Raises ImageProcessingError for undecodable input.
    """
    bgr = load_image_bgr(image)
    if use_clip is None:
        use_clip = get_model_mode() == "production"
    return {
        "hashes": _hashes_from_pil(_bgr_to_pil(bgr)),
        "histogram": color_histogram(bgr),
        "clip": clip_embedding(bgr) if use_clip else None,
        "width": int(bgr.shape[1]),
        "height": int(bgr.shape[0]),
    }


def features_from_hashes(hashes):
    """Features of an image known only by its stored hashes (e.g. ``ComplaintImage.phash / dhash``)."""
    return {"hashes": {k: v for k, v in (hashes or {}).items() if k in HASH_KIND_WEIGHTS and v},
            "histogram": None, "clip": None}


def compare_features(features_a, features_b):
    """Combine the available similarity signals of two feature sets.

    Returns {"similarity": 0..1 | None, "hash": .., "histogram": .., "clip": .., "method": "clip+hash+histogram"}.
    """
    parts = {
        "clip": (clip_similarity(features_a["clip"], features_b["clip"])
                 if features_a.get("clip") is not None and features_b.get("clip") is not None else None),
        "hash": combined_hash_similarity(features_a.get("hashes"), features_b.get("hashes")),
        "histogram": (histogram_similarity(features_a["histogram"], features_b["histogram"])
                      if features_a.get("histogram") is not None and features_b.get("histogram") is not None
                      else None),
    }
    combination = PRODUCTION_COMBINATION if parts["clip"] is not None else DEMO_COMBINATION
    available = {key: weight for key, weight in combination.items() if parts.get(key) is not None}
    if not available:
        return {"similarity": None, **parts, "method": None}
    total = sum(available.values())
    similarity = sum(parts[key] * weight for key, weight in available.items()) / total
    return {"similarity": round(similarity, 4), **parts, "method": "+".join(available)}


def image_similarity(a, b):
    """Overall similarity in [0, 1] of two images (path / bytes / PIL / ndarray).

    Demo: perceptual hashes + colour-histogram correlation; production: + CLIP embedding cosine.
    """
    return compare_features(extract_features(a), extract_features(b))["similarity"]
