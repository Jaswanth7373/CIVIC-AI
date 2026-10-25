"""Re-encoding of uploaded photos before anything analyses or stores them.

Every photo a client uploads - complaint photos, resolution evidence, avatars and the AI playground inputs - goes
through :func:`sanitize_image_upload` once :func:`apps.core.validators.validate_image_upload` has accepted it
(:class:`apps.core.fields.SafeImageField` does both):

1. **Bounded decoding.** JPEGs are decoded directly at a reduced scale (``Image.draft`` lets libjpeg skip detail
   it would throw away anyway); PNG and WebP must be decoded in full, which is why the validator caps them at
   ``MAX_FULL_DECODE_PIXELS``. Every image is then downscaled to ``MAX_STORED_IMAGE_SIDE``, so the AI engine, the
   duplicate hashes and the browser never handle a 25-megapixel bitmap.
2. **Orientation.** The EXIF orientation is applied to the pixels, so the photo stays upright without metadata.
3. **No metadata.** The photo is re-encoded in its *real* format (as detected by Pillow, not as claimed by the
   file name) without EXIF / XMP blocks: the GPS position, capture time and phone make / model of the citizen's
   camera are never stored or served. Only the colour profile (ICC) is kept.
4. **Unguessable name.** The stored name is ``<80-bit random token>-<original stem>.<real extension>``, so media
   URLs cannot be enumerated, and the extension always matches the content (correct ``Content-Type``).
"""
import io
import math
import os
import re
import secrets

import numpy as np
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image, ImageOps

from .validators import ALLOWED_IMAGE_FORMATS

EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}
CONTENT_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
JPEG_QUALITY = 88
WEBP_QUALITY = 88
STEM_MAX_LENGTH = 40
_UNSAFE_STEM_CHARACTERS = re.compile(r"[^A-Za-z0-9_-]+")
_SIXTEEN_BIT_MODES = ("I;16", "I;16L", "I;16B", "I;16N")
#: Modes each encoder writes as they are; anything else is converted first.
_ENCODER_MODES = {
    "JPEG": ("L", "RGB"),
    "PNG": ("1", "L", "LA", "P", "RGB", "RGBA"),
    "WEBP": ("RGB", "RGBA"),
}


def sanitize_image_upload(uploaded, *, max_side=None):
    """Return a clean re-encoded copy of ``uploaded`` (a validated image) as a ``SimpleUploadedFile``.

    ``max_side`` defaults to ``settings.MAX_STORED_IMAGE_SIDE``. Raises django ``ValidationError`` when the file
    cannot be decoded (e.g. a truncated upload whose header looked fine).
    """
    max_side = int(max_side or getattr(settings, "MAX_STORED_IMAGE_SIDE", 2560))
    if hasattr(uploaded, "seek"):
        uploaded.seek(0)
    try:
        with Image.open(uploaded) as source:
            image_format = ALLOWED_IMAGE_FORMATS.get(source.format)
            if image_format is None:
                raise ValidationError(f"Unsupported image format ({source.format or 'unknown'}).")
            icc_profile = source.info.get("icc_profile")
            source_mode = source.mode
            if image_format == "JPEG":
                source.draft(source.mode, _fitted_size(source.size, max_side))
            source.load()
            image = _encodable(source, image_format, max_side)
            if _colour_model(source_mode) != _colour_model(image.mode):
                icc_profile = None  # e.g. a CMYK profile must not describe the RGB pixels it was converted to
            data = _encode(image, image_format, icc_profile)
    except ValidationError:
        raise
    except Exception as exc:  # noqa: BLE001 - truncated data, decoder errors, ...: the upload is not usable
        raise ValidationError("The uploaded image could not be processed.") from exc
    finally:
        if hasattr(uploaded, "seek"):
            uploaded.seek(0)
    return SimpleUploadedFile(
        stored_image_name(getattr(uploaded, "name", ""), image_format), data,
        content_type=CONTENT_TYPES[image_format],
    )


def stored_image_name(original_name, image_format):
    """``"<random token>-<safe stem>.<extension of the real format>"``, e.g. ``"9f2c...-pothole_03.jpg"``.

    The stem is kept (ASCII letters, digits, ``_`` and ``-`` only, at most 40 characters) because the demo vision
    model may use words in it as a disclosed hint; the random token makes the URL impossible to guess.
    """
    stem = os.path.splitext(os.path.basename(str(original_name or "")))[0]
    stem = _UNSAFE_STEM_CHARACTERS.sub("_", stem).strip("_-")[:STEM_MAX_LENGTH] or "photo"
    return f"{secrets.token_hex(10)}-{stem}.{EXTENSIONS[image_format]}"


def _fitted_size(size, max_side):
    """(w, h) of ``size`` scaled down to fit ``max_side`` (never up) - the target given to ``Image.draft``."""
    width, height = size
    scale = min(1.0, max_side / float(max(width, height, 1)))
    return max(1, int(width * scale)), max(1, int(height * scale))


def _encodable(image, image_format, max_side):
    """Upright, downscaled image in a mode the target encoder writes, without any metadata."""
    ImageOps.exif_transpose(image, in_place=True)
    image = _to_eight_bit(image)
    resize = max(image.size) > max_side
    if resize and image.mode in ("1", "P"):  # palette / bilevel images would be resized with NEAREST
        image = image.convert("RGBA" if image.has_transparency_data else ("L" if image.mode == "1" else "RGB"))
    if image.mode not in _ENCODER_MODES[image_format]:
        image = _convert_for(image, image_format)
    if resize:
        image = _downscale(image, max_side)
    # Drop EXIF / XMP / text chunks: only pixels (and the ICC profile) are written. A PNG's "transparency" entry
    # is pixel data (the transparent palette index or colour), so it is kept.
    transparency = image.info.get("transparency") if image_format == "PNG" else None
    image.info = {} if transparency is None else {"transparency": transparency}
    return image


def _downscale(image, max_side):
    """Shrink so the longest side is at most ``max_side`` (aspect ratio kept)."""
    if image.mode in ("RGBA", "LA"):
        # Pillow resamples transparent images through a premultiplied full-size copy; one integer box reduction
        # keeps that to a single pass (the result is at most max_side, possibly somewhat smaller).
        return image.reduce(math.ceil(max(image.size) / max_side))
    image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return image


def _to_eight_bit(image):
    """16/32-bit greyscale -> 8-bit "L" without a floating-point copy of the whole bitmap."""
    if image.mode in _SIXTEEN_BIT_MODES:
        # Keep the high byte of every 16-bit sample (65535 -> 255): a strided view of the raw bytes.
        raw = np.frombuffer(image.tobytes(), dtype=np.uint8)
        high = raw[0::2] if image.mode == "I;16B" else raw[1::2]
        width, height = image.size
        return Image.fromarray(np.ascontiguousarray(high).reshape(height, width))
    if image.mode in ("I", "F"):
        values = np.asarray(image, dtype=np.float32)
        top = max(float(values.max(initial=0.0)), 1.0)
        return Image.fromarray(np.clip(values * (255.0 / top), 0, 255).astype(np.uint8))
    return image


def _colour_model(mode):
    """"gray", "cmyk" or "rgb" - the colour space an embedded ICC profile has to describe."""
    if mode in ("1", "L", "LA", "I", "F") or mode.startswith("I;16"):
        return "gray"
    return "cmyk" if mode == "CMYK" else "rgb"


def _convert_for(image, image_format):
    has_alpha = image.mode in ("RGBA", "LA", "PA") or image.has_transparency_data
    if image_format == "JPEG":
        if has_alpha:  # JPEG has no alpha channel: composite onto white, as an image viewer shows it
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            return Image.alpha_composite(background, rgba).convert("RGB")
        return image.convert("L" if image.mode in ("1", "L") else "RGB")
    return image.convert("RGBA" if has_alpha else "RGB")


def _encode(image, image_format, icc_profile):
    buffer = io.BytesIO()
    options = {"icc_profile": icc_profile} if icc_profile else {}
    if image_format == "JPEG":
        image.save(buffer, "JPEG", quality=JPEG_QUALITY, optimize=True, **options)
    elif image_format == "PNG":
        image.save(buffer, "PNG", compress_level=6, **options)
    else:
        image.save(buffer, "WEBP", quality=WEBP_QUALITY, method=4, **options)
    return buffer.getvalue()
