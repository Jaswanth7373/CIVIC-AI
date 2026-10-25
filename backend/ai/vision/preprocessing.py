"""Image loading and pre-processing shared by every image-handling module of the AI engine.

``load_image`` is the single entry point used by vision, duplicate detection and resolution verification,
so every module accepts the same inputs and sees the same pixels:

* ``str`` / ``pathlib.Path``  - a file on disk (read through Pillow so EXIF orientation is honoured),
* ``bytes`` / ``bytearray`` / ``memoryview`` - an encoded image (JPEG, PNG, WebP, BMP, ...),
* a binary file-like object with ``.read()`` (e.g. a Django ``UploadedFile``; its position is restored),
* ``PIL.Image.Image``,
* ``numpy.ndarray`` - assumed to already be OpenCV style **BGR** (or grey / BGRA).

The result is always a C-contiguous ``uint8`` array of shape ``(H, W, 3)`` in BGR channel order - the
OpenCV convention used throughout the engine.

Why EXIF matters: phone cameras store pixels in sensor orientation and write the "how to rotate" flag into
EXIF. Without ``ImageOps.exif_transpose`` a portrait photo would be analysed lying on its side, which breaks
shape features (a vertical lamp pole would look horizontal) and the bounding boxes shown in the UI.
"""
from __future__ import annotations

import io
import logging
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from ai.exceptions import ImageProcessingError

from . import config as vcfg

logger = logging.getLogger("ai.vision.preprocessing")

_BYTES_TYPES = (bytes, bytearray, memoryview)


# ------------------------------------------------------------------------------------------------------
# Loading
# ------------------------------------------------------------------------------------------------------
def load_image(image) -> np.ndarray:
    """Load ``image`` (path / bytes / file-like / PIL / ndarray) as a BGR ``uint8`` array ``(H, W, 3)``.

    Raises:
        ImageProcessingError: the input is missing, of an unsupported type, cannot be decoded, or is too
            small (< ``MIN_IMAGE_SIDE`` px) to analyse.
    """
    if image is None:
        raise ImageProcessingError("No image was provided.")
    if isinstance(image, np.ndarray):
        bgr = _ndarray_to_bgr(image)
    elif isinstance(image, Image.Image):
        bgr = _pil_to_bgr(image)
    elif isinstance(image, (str, Path)):
        bgr = _load_path(Path(image))
    elif isinstance(image, _BYTES_TYPES):
        bgr = _decode_bytes(bytes(image))
    elif hasattr(image, "read"):
        bgr = _decode_bytes(_read_file_like(image))
    else:
        raise ImageProcessingError(f"Unsupported image input type: {type(image).__name__}.")

    h, w = bgr.shape[:2]
    if min(h, w) < vcfg.MIN_IMAGE_SIDE:
        raise ImageProcessingError(
            f"Image is too small to analyse ({w}x{h} px; at least {vcfg.MIN_IMAGE_SIDE} px per side needed)."
        )
    return np.ascontiguousarray(bgr)


def _load_path(path: Path) -> np.ndarray:
    if not path.is_file():
        raise ImageProcessingError(f"Image file not found: {path.name}")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ImageProcessingError(f"Could not read image file {path.name}: {exc}") from exc
    return _decode_bytes(data)


def _read_file_like(fobj) -> bytes:
    position = None
    try:
        position = fobj.tell()
    except Exception:  # not seekable - read from wherever it is
        position = None
    try:
        if position is not None:
            fobj.seek(0)
        data = fobj.read()
    except Exception as exc:
        raise ImageProcessingError(f"Could not read the uploaded image: {exc}") from exc
    finally:
        if position is not None:
            try:
                fobj.seek(position)
            except Exception:
                logger.debug("Could not restore the file position of %r", fobj)
    if isinstance(data, str):
        raise ImageProcessingError("The uploaded image must be opened in binary mode.")
    return bytes(data)


def _decode_bytes(data: bytes) -> np.ndarray:
    """Decode with Pillow (EXIF aware); formats Pillow cannot identify get a second chance with OpenCV.

    A file Pillow recognises but cannot fully decode (truncated / corrupt upload) is rejected rather than
    passed to OpenCV, which would silently return a partially grey picture.
    """
    if not data:
        raise ImageProcessingError("The image is empty (0 bytes).")
    try:
        pil = Image.open(io.BytesIO(data))
    except UnidentifiedImageError as exc:
        decoded = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if decoded is None:
            raise ImageProcessingError("The data is not a readable image.") from exc
        return decoded
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ImageProcessingError(f"Could not open the image: {exc}") from exc
    with pil:
        return _pil_to_bgr(pil)


def _pil_to_bgr(pil: Image.Image) -> np.ndarray:
    """Convert any Pillow image to BGR uint8, applying the EXIF orientation first."""
    try:
        pil.load()  # force decoding now so truncated / corrupt files fail here
        pil = ImageOps.exif_transpose(pil)
    except Exception as exc:   # OSError (truncated), SyntaxError / struct.error (corrupt headers), bombs, ...
        raise ImageProcessingError(f"Could not decode the image: {exc}") from exc

    mode = pil.mode
    if mode in ("I;16", "I;16L", "I;16B", "I;16N"):
        # 16-bit greyscale: keep the high byte (65535 -> 255) instead of letting Pillow clip everything above 255.
        # Integer arithmetic: a float64 copy would need 8 bytes per pixel (1.5 GB peak for an 8000x8000 PNG).
        grey = (np.asarray(pil, dtype=np.uint16) >> 8).astype(np.uint8)
        return cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR)
    if mode in ("I", "F"):
        # 32-bit greyscale: rescale by the brightest pixel, in float32 (half the memory of float64).
        arr = np.asarray(pil, dtype=np.float32)
        top = max(float(arr.max(initial=0.0)), 1.0)
        grey = np.clip(arr * (255.0 / top), 0, 255).astype(np.uint8)
        return cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR)
    if mode in ("RGBA", "LA", "PA") or (mode == "P" and "transparency" in pil.info):
        # Composite transparent pixels onto white (what a viewer shows) instead of on arbitrary hidden RGB.
        rgba = pil.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        pil = Image.alpha_composite(background, rgba)
    rgb = np.asarray(pil.convert("RGB"), dtype=np.uint8)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _ndarray_to_bgr(arr: np.ndarray) -> np.ndarray:
    """Validate a numpy image and coerce it to BGR uint8 (grey -> BGR, BGRA -> BGR, float 0-1 -> 0-255)."""
    if arr.size == 0:
        raise ImageProcessingError("The image array is empty.")
    if arr.ndim == 3 and arr.shape[2] == 1:
        arr = arr[:, :, 0]
    if arr.ndim not in (2, 3) or (arr.ndim == 3 and arr.shape[2] not in (3, 4)):
        raise ImageProcessingError(f"Unsupported image array shape {arr.shape}; expected HxW, HxWx3 or HxWx4.")

    if arr.dtype != np.uint8:
        if np.issubdtype(arr.dtype, np.floating):
            finite = np.nan_to_num(arr.astype(np.float64), nan=0.0, posinf=255.0, neginf=0.0)
            scale = 255.0 if finite.max(initial=0.0) <= 1.0 else 1.0
            arr = np.clip(finite * scale, 0, 255).astype(np.uint8)
        elif arr.dtype == np.uint16:
            arr = (arr / 257.0).round().astype(np.uint8)
        elif np.issubdtype(arr.dtype, np.integer) or arr.dtype == np.bool_:
            arr = np.clip(arr.astype(np.int64) * (255 if arr.dtype == np.bool_ else 1), 0, 255).astype(np.uint8)
        else:
            raise ImageProcessingError(f"Unsupported image array dtype {arr.dtype}.")

    if arr.ndim == 2:
        return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
    if arr.shape[2] == 4:
        return cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
    return arr


# ------------------------------------------------------------------------------------------------------
# Conversions / resizing
# ------------------------------------------------------------------------------------------------------
def to_gray(img: np.ndarray) -> np.ndarray:
    """BGR -> single-channel uint8 luminance (ITU-R BT.601 weights, as OpenCV)."""
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def bgr_to_pil(img: np.ndarray) -> Image.Image:
    """BGR ndarray -> RGB ``PIL.Image`` (the format CLIP / Hugging Face processors expect)."""
    return Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))


def resize_for_model(img: np.ndarray, max_side: int = vcfg.ANALYSIS_MAX_SIDE) -> np.ndarray:
    """Downscale so the longest side is at most ``max_side`` (aspect ratio kept, never upscales).

    ``INTER_AREA`` averages the source pixels that fall into each destination pixel, which is the
    alias-free choice for shrinking photos.
    """
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest <= max_side:
        return img
    scale = max_side / float(longest)
    size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA)


def letterbox(img: np.ndarray, new_shape: int | tuple[int, int] = vcfg.YOLO_IMGSZ,
              color: tuple[int, int, int] = (114, 114, 114)):
    """Resize keeping the aspect ratio and pad to ``new_shape`` (YOLO-style "letterbox").

    Detectors such as YOLO and CLIP take square inputs. Stretching a 4:3 photo would distort the shapes
    the network learned; centre-cropping would cut off defects near the border. Letterboxing scales the
    image to fit and pads the remainder with neutral grey (114 is the Ultralytics convention).

    Returns:
        ``(padded, ratio, (pad_left, pad_top))`` - map a padded-space point back to the original image with
        ``x = (x_p - pad_left) / ratio``, ``y = (y_p - pad_top) / ratio``.
    """
    target_h, target_w = (new_shape, new_shape) if isinstance(new_shape, int) else new_shape
    h, w = img.shape[:2]
    ratio = min(target_w / w, target_h / h)
    new_w, new_h = max(1, int(round(w * ratio))), max(1, int(round(h * ratio)))
    interpolation = cv2.INTER_AREA if ratio < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(img, (new_w, new_h), interpolation=interpolation) if (new_w, new_h) != (w, h) else img
    pad_left = (target_w - new_w) // 2
    pad_top = (target_h - new_h) // 2
    padded = cv2.copyMakeBorder(
        resized, pad_top, target_h - new_h - pad_top, pad_left, target_w - new_w - pad_left,
        cv2.BORDER_CONSTANT, value=color,
    )
    return padded, ratio, (pad_left, pad_top)


# ------------------------------------------------------------------------------------------------------
# Quality
# ------------------------------------------------------------------------------------------------------
def blur_score(img: np.ndarray) -> float:
    """Sharpness: variance of the Laplacian on the most detailed parts of the photo (high = sharp).

    The Laplacian is a second-derivative filter that responds to edges; blur removes edges and its variance
    collapses (Pech-Pacheco et al., 2000). Computed over the *whole* image, a perfectly sharp photo of a
    plain wall or smooth pavement also scores low, so the image is split into 32x32 tiles and the score is
    the mean variance of the top 25% tiles - a focus measure on the regions that contain detail. Computed
    at ``ANALYSIS_MAX_SIDE`` so it does not depend on the upload resolution.
    """
    gray = to_gray(resize_for_model(img))
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    tile = vcfg.BLUR_TILE
    rows, cols = lap.shape[0] // tile, lap.shape[1] // tile
    if rows == 0 or cols == 0:
        return float(lap.var())
    tiles = lap[: rows * tile, : cols * tile].reshape(rows, tile, cols, tile).transpose(0, 2, 1, 3)
    variances = np.sort(tiles.reshape(rows * cols, -1).var(axis=1))[::-1]
    top = max(1, int(round(len(variances) * vcfg.BLUR_TOP_FRACTION)))
    return float(variances[:top].mean())


def brightness(img: np.ndarray) -> float:
    """Mean luminance in [0, 1]."""
    return float(to_gray(resize_for_model(img)).mean() / 255.0)


def image_quality(img: np.ndarray) -> dict:
    """Return ``{width, height, blur_score, brightness, is_blurry, is_dark}`` for a BGR image."""
    h, w = img.shape[:2]
    sharpness = blur_score(img)
    light = brightness(img)
    return {
        "width": int(w),
        "height": int(h),
        "blur_score": round(sharpness, 1),
        "brightness": round(light, 3),
        "is_blurry": bool(sharpness < vcfg.BLUR_THRESHOLD),
        "is_dark": bool(light < vcfg.DARK_THRESHOLD),
    }
