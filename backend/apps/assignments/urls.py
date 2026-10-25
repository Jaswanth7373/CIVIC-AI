"""URL routes for the assignments app (mounted under /api/ by config.urls)."""
from rest_framework.routers import SimpleRouter

from .views import AssignmentViewSet

router = SimpleRouter(trailing_slash=True)
router.register("assignments", AssignmentViewSet, basename="assignment")

urlpatterns = router.urls
