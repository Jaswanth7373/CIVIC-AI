"""CivicAI URL configuration.

Every app exposes its REST endpoints from ``apps/<app>/urls.py`` (using
``SimpleRouter`` / explicit paths, never ``DefaultRouter`` - so there is no
root-view clash). Authentication lives under /api/auth/, analytics under
/api/analytics/, everything else directly under /api/.

Uploaded media (complaint photos, resolution evidence, avatars) is served by Django in development
(``DEBUG=True``) and, on a single-instance deployment without object storage (Render disk, Railway volume),
when ``settings.SERVE_MEDIA`` is enabled (env ``SERVE_MEDIA=True``). The files are validated images
(``validate_image_upload``) served with their image content type and ``X-Content-Type-Options: nosniff``; at scale
use object storage + CDN.
"""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path, re_path
from django.views.static import serve as serve_media


def health(request):
    mode = settings.CIVICAI["MODEL_MODE"]
    return JsonResponse({"status": "ok", "service": "civicai-api", "model_mode": mode, "demo_mode": mode != "production"})


admin.site.site_header = "CivicAI Administration"
admin.site.site_title = "CivicAI Admin"
admin.site.index_title = "Platform data"

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", health, name="health"),
    path("api/auth/", include("apps.accounts.urls_auth")),
    path("api/analytics/", include("apps.analytics.urls")),
    path("api/", include("apps.accounts.urls")),
    path("api/", include("apps.core.urls")),
    path("api/", include("apps.departments.urls")),
    path("api/", include("apps.officers.urls")),
    path("api/", include("apps.complaints.urls")),
    path("api/", include("apps.assignments.urls")),
    path("api/", include("apps.feedback.urls")),
    path("api/", include("apps.notifications.urls")),
    path("api/", include("apps.audit.urls")),
]


def media_urlpatterns():
    """Patterns serving MEDIA_ROOT: always with DEBUG=True, otherwise only when ``SERVE_MEDIA`` is enabled."""
    if settings.DEBUG:
        return static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    if getattr(settings, "SERVE_MEDIA", False):
        return [re_path(rf"^{settings.MEDIA_URL.strip('/')}/(?P<path>.*)$", serve_media,
                        {"document_root": settings.MEDIA_ROOT}, name="media")]
    return []


urlpatterns += media_urlpatterns()
