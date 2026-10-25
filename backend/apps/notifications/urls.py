"""URL routes for the notifications app (mounted under /api/ by config.urls)."""
from rest_framework.routers import SimpleRouter

from .views import NotificationViewSet

router = SimpleRouter(trailing_slash=True)
router.register("notifications", NotificationViewSet, basename="notification")

urlpatterns = router.urls
