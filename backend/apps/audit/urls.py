"""URL routes for the audit app (mounted under /api/ by config.urls)."""
from rest_framework.routers import SimpleRouter

from .views import AuditLogViewSet

router = SimpleRouter(trailing_slash=True)
router.register("audit-logs", AuditLogViewSet, basename="audit-log")

urlpatterns = router.urls
