"""URL routes for the core app (mounted under /api/ by config.urls).

Only ``ai/config/`` belongs to this app; every other ``/api/ai/*`` path is served by the complaints app.
"""
from django.urls import path
from rest_framework.routers import SimpleRouter

from .views import (
    AIConfigView,
    ContactMessageViewSet,
    GeoReverseView,
    GeoSearchView,
    RiskZoneViewSet,
    SystemConfigView,
)

router = SimpleRouter(trailing_slash=True)
router.register("risk-zones", RiskZoneViewSet, basename="risk-zone")
router.register("contact", ContactMessageViewSet, basename="contact-message")

urlpatterns = [
    path("system/config/", SystemConfigView.as_view(), name="system-config"),
    path("ai/config/", AIConfigView.as_view(), name="ai-config"),
    path("geo/reverse/", GeoReverseView.as_view(), name="geo-reverse"),
    path("geo/search/", GeoSearchView.as_view(), name="geo-search"),
    *router.urls,
]
