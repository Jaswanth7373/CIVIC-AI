"""Request guards that run before any view."""
from django.conf import settings
from django.http import JsonResponse


class RequestBodyLimitMiddleware:
    """Answers 413 for a request whose declared body (``Content-Length``) exceeds ``MAX_REQUEST_BODY_BYTES``.

    Django caps only form fields (``DATA_UPLOAD_MAX_MEMORY_SIZE``): uploaded files are streamed to disk without a
    total limit and DRF's JSON parser reads the whole body into memory. The largest legitimate request carries two
    photos (before + after evidence), so the default limit is two maximum-size images plus 4 MB of form data. The
    check reads only the header, before a single byte of the body is consumed.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        limit = getattr(settings, "MAX_REQUEST_BODY_BYTES", None)
        try:
            length = int(request.META.get("CONTENT_LENGTH") or 0)
        except (TypeError, ValueError):
            length = 0
        if limit and length > limit:
            return JsonResponse(
                {"detail": f"The request is too large (maximum {limit / (1024 * 1024):.0f} MB).",
                 "code": "payload_too_large"},
                status=413,
            )
        return self.get_response(request)
