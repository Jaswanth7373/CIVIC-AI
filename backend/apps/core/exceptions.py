"""Uniform API error format.

Every error response looks like::

    {"detail": "Human readable summary", "errors": {"field": ["message", ...]}, "code": "validation_error"}

``errors`` is present for validation errors (field -> list of messages).

Besides DRF's own exceptions the handler translates request problems that Django or the database driver raise
as plain exceptions, which would otherwise surface as HTTP 500:

* ``RequestDataTooBig`` (body above ``DATA_UPLOAD_MAX_MEMORY_SIZE``) -> 413 ``payload_too_large``;
* other ``SuspiciousOperation`` errors such as ``TooManyFieldsSent`` -> 400 ``parse_error``;
* ``DataError`` / ``OverflowError`` (a value the database cannot store or bind, e.g. an integer beyond 64 bits on
  SQLite) -> 400 ``validation_error``. Inputs are validated at the API boundary; this is the safety net.
"""
import logging

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import RequestDataTooBig, SuspiciousOperation
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DataError
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler

logger = logging.getLogger("apps.core")


class ServiceError(exceptions.APIException):
    """Raise from service functions for business-rule violations (HTTP 400)."""

    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "The request could not be completed."
    default_code = "service_error"


class TransitionNotAllowed(ServiceError):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This status change is not allowed."
    default_code = "transition_not_allowed"


class PayloadTooLarge(exceptions.APIException):
    status_code = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    default_detail = "The request is too large."
    default_code = "payload_too_large"


OUT_OF_RANGE_MESSAGE = "A value in the request is out of range."


def _first_message(data):
    if isinstance(data, list) and data:
        return _first_message(data[0])
    if isinstance(data, dict) and data:
        key, value = next(iter(data.items()))
        msg = _first_message(value)
        if key in ("non_field_errors", "detail"):
            return msg
        return f"{key.replace('_', ' ').capitalize()}: {msg}"
    return str(data)


def custom_exception_handler(exc, context):
    if isinstance(exc, RequestDataTooBig):
        exc = PayloadTooLarge("The request is too large to process.")
    elif isinstance(exc, SuspiciousOperation):  # TooManyFieldsSent, TooManyFilesSent, malformed multipart, ...
        logger.warning("Rejected a malformed request: %s", exc)
        exc = exceptions.ParseError("The request could not be read (malformed data or too many fields).")
    elif isinstance(exc, (DataError, OverflowError)):
        logger.warning("Request value out of range: %s", exc, exc_info=exc)
        exc = exceptions.ValidationError({"non_field_errors": [OUT_OF_RANGE_MESSAGE]})
    elif isinstance(exc, DjangoValidationError):
        detail = exc.message_dict if hasattr(exc, "error_dict") else {"non_field_errors": exc.messages}
        exc = exceptions.ValidationError(detail=detail)
    elif isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()

    response = exception_handler(exc, context)
    if response is None:
        logger.exception("Unhandled API error", exc_info=exc)
        return Response(
            {"detail": "An unexpected server error occurred.", "code": "server_error"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    data = response.data
    code = getattr(exc, "default_code", "error")
    if isinstance(exc, exceptions.ValidationError):
        errors = data if isinstance(data, dict) else {"non_field_errors": data}
        response.data = {"detail": _first_message(errors), "errors": errors, "code": "validation_error"}
    elif isinstance(data, dict) and "detail" in data:
        response.data = {"detail": str(data["detail"]), "code": getattr(data["detail"], "code", code)}
    else:
        response.data = {"detail": _first_message(data), "code": code}
    return response
