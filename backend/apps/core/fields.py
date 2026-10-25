"""Serializer fields shared by several apps."""
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .images import sanitize_image_upload
from .validators import validate_image_upload


class SafeImageField(serializers.ImageField):
    """``ImageField`` for every photo a client uploads.

    The upload is checked by :func:`apps.core.validators.validate_image_upload` (extension, size, real format,
    pixel limits) *before* any pixel is decoded, then replaced by the clean copy from
    :func:`apps.core.images.sanitize_image_upload` (downscaled to ``max_side``, metadata stripped, real-format
    extension, random file name). Views and services only ever see that copy.
    """

    def __init__(self, *, max_side=None, **kwargs):
        self.max_side = max_side
        super().__init__(**kwargs)

    def to_internal_value(self, data):
        uploaded = super().to_internal_value(data)
        try:
            validate_image_upload(uploaded)
            return sanitize_image_upload(uploaded, max_side=self.max_side)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages))
