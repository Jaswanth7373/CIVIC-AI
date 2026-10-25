"""URL routes for the accounts app (mounted under /api/ by config.urls): admin user management."""
from rest_framework.routers import SimpleRouter

from .views import UserViewSet

router = SimpleRouter(trailing_slash=True)
router.register("users", UserViewSet, basename="user")

urlpatterns = router.urls
