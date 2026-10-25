"""URL routes for the departments app (mounted under /api/ by config.urls).

``departments/routing/`` is listed before the router so it is never mistaken for a department id
(the detail routes additionally only accept numeric ids).
"""
from django.urls import path
from rest_framework.routers import SimpleRouter

from .views import CategoryViewSet, DepartmentViewSet, RoutingView

router = SimpleRouter(trailing_slash=True)
router.register("departments", DepartmentViewSet, basename="department")
router.register("categories", CategoryViewSet, basename="category")

urlpatterns = [
    path("departments/routing/", RoutingView.as_view(), name="department-routing"),
    *router.urls,
]
