"""URL routes for the feedback app (mounted under /api/ by config.urls)."""
from rest_framework.routers import SimpleRouter

from .views import FeedbackViewSet

router = SimpleRouter(trailing_slash=True)
router.register("feedback", FeedbackViewSet, basename="feedback")

urlpatterns = router.urls
