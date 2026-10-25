"""Upload validation: extension whitelist, size limit, real-image and real-format check (Pillow), dimensions.

Only the image *header* is read here (``Image.open`` + ``verify``); nothing is decoded. That matters because the
pixel count, not the file size, decides how much memory a decoded image needs: a 20 KB PNG can declare
8000x8000 pixels (256 MB as RGBA). ``MAX_IMAGE_PIXELS`` (JPEG, decoded at reduced scale by
:mod:`apps.core.images`) and ``MAX_FULL_DECODE_PIXELS`` (PNG / WebP, always decoded in full) reject such files
before any code decodes them.
"""
import os

from django.conf import settings
from django.core.exceptions import ValidationError
from PIL import Image, UnidentifiedImageError

#: Pillow format name -> the format the upload is treated as. MPO ("multi-picture object") is the JPEG variant
#: many phone cameras write (a JPEG with extra frames such as depth or HDR gain maps).
ALLOWED_IMAGE_FORMATS = {"JPEG": "JPEG", "MPO": "JPEG", "PNG": "PNG", "WEBP": "WEBP"}
MIN_IMAGE_SIDE = 32


def validate_image_upload(file):
    """Validate an uploaded image file. Raises django ValidationError with a clear message.

    Checks, in order: file extension, file size, that Pillow can parse it (truncated / fake files are rejected),
    that its *real* format is JPEG, PNG or WebP (a GIF, BMP or TIFF renamed to ``photo.jpg`` is rejected), and the
    dimensions: at most ``MAX_IMAGE_DIMENSION`` px per side, at most ``MAX_IMAGE_PIXELS`` in total (JPEG) or
    ``MAX_FULL_DECODE_PIXELS`` (PNG / WebP), at least 32 px per side.

    Use :class:`apps.core.fields.SafeImageField` in serializers: it runs this check and then re-encodes the photo
    (:func:`apps.core.images.sanitize_image_upload`).
    """
    if file is None:
        return file
    max_mb = getattr(settings, "MAX_IMAGE_UPLOAD_MB", 8)
    allowed = getattr(settings, "ALLOWED_IMAGE_EXTENSIONS", ["jpg", "jpeg", "png", "webp"])
    max_dim = getattr(settings, "MAX_IMAGE_DIMENSION", 8000)
    max_pixels = getattr(settings, "MAX_IMAGE_PIXELS", 25_000_000)
    max_full_decode = getattr(settings, "MAX_FULL_DECODE_PIXELS", 12_000_000)

    ext = os.path.splitext(getattr(file, "name", "") or "")[1].lower().lstrip(".")
    if ext not in allowed:
        raise ValidationError(f"Unsupported file type '.{ext or '?'}'. Allowed: {', '.join(allowed)}.")

    size = getattr(file, "size", 0) or 0
    if size > max_mb * 1024 * 1024:
        raise ValidationError(f"Image is too large ({size / 1024 / 1024:.1f} MB). Maximum size is {max_mb} MB.")
    if size == 0:
        raise ValidationError("The uploaded image is empty.")

    try:
        pos = file.tell() if hasattr(file, "tell") else 0
        with Image.open(file) as img:
            image_format = img.format
            width, height = img.size
            img.verify()  # detects truncated / fake images (reads the chunks, decodes no pixels)
        if hasattr(file, "seek"):
            file.seek(pos)
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise ValidationError("The uploaded file is not a valid image.")

    if image_format not in ALLOWED_IMAGE_FORMATS:
        raise ValidationError(
            f"Unsupported image format ({image_format or 'unknown'}). Upload a JPEG, PNG or WebP photo."
        )
    if width > max_dim or height > max_dim:
        raise ValidationError(f"Image dimensions {width}x{height} exceed the {max_dim}px limit.")
    # JPEGs are decoded at a reduced scale; PNG / WebP must be decoded in full, so they get the lower limit.
    is_jpeg = ALLOWED_IMAGE_FORMATS[image_format] == "JPEG"
    pixel_limit = max_pixels if is_jpeg else min(max_pixels, max_full_decode)
    if width * height > pixel_limit:
        kind = "" if is_jpeg else " for PNG and WebP images"
        raise ValidationError(
            f"Image resolution {width}x{height} ({width * height / 1e6:.1f} megapixels) exceeds the "
            f"{pixel_limit / 1e6:.0f} megapixel limit{kind}. Upload a smaller photo."
        )
    if width < MIN_IMAGE_SIDE or height < MIN_IMAGE_SIDE:
        raise ValidationError(f"Image is too small to analyse (minimum {MIN_IMAGE_SIDE}x{MIN_IMAGE_SIDE} pixels).")
    return file
