"""URL routes of the complaints app (mounted under ``/api/`` by ``config.urls``).

* ``complaints/`` + ``complaints/map/`` + ``complaints/{id}/<action>/`` - :class:`ComplaintViewSet`
* ``duplicates/`` + ``duplicates/{id}/`` - :class:`DuplicateComplaintViewSet`
* ``ai/<endpoint>/`` - the AI views incl. the public ``ai/demo/`` (``ai/config/`` belongs to the core app and is
  not routed here)

``SimpleRouter`` (never ``DefaultRouter``, so no API-root view clashes with the other apps) registers
list-level routes such as ``complaints/map/`` before the ``complaints/{id}/`` detail route, and the
viewsets only accept numeric ids, so ``map`` can never be mistaken for a primary key.
"""
from django.urls import path
from rest_framework.routers import SimpleRouter

from .ai_views import (
    AnalyzeView,
    ClassifyView,
    DuplicatesView,
    ModelInfoView,
    PriorityView,
    PublicDemoView,
    SentimentView,
    VerifyResolutionView,
)
from .views import ComplaintViewSet, DuplicateComplaintViewSet

router = SimpleRouter(trailing_slash=True)
router.register("complaints", ComplaintViewSet, basename="complaint")
router.register("duplicates", DuplicateComplaintViewSet, basename="duplicate")

urlpatterns = [
    path("ai/analyze/", AnalyzeView.as_view(), name="ai-analyze"),
    path("ai/classify/", ClassifyView.as_view(), name="ai-classify"),
    path("ai/priority/", PriorityView.as_view(), name="ai-priority"),
    path("ai/duplicates/", DuplicatesView.as_view(), name="ai-duplicates"),
    path("ai/verify-resolution/", VerifyResolutionView.as_view(), name="ai-verify-resolution"),
    path("ai/sentiment/", SentimentView.as_view(), name="ai-sentiment"),
    path("ai/model-info/", ModelInfoView.as_view(), name="ai-model-info"),
    path("ai/demo/", PublicDemoView.as_view(), name="ai-demo"),
    *router.urls,
]
