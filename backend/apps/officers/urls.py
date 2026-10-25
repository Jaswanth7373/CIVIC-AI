"""URL routes for the officers app (mounted under /api/ by config.urls)."""
from rest_framework.routers import SimpleRouter

from .views import OfficerViewSet

router = SimpleRouter(trailing_slash=True)
router.register("officers", OfficerViewSet, basename="officer")

urlpatterns = router.urls
