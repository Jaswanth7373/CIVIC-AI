"""URL routes for the analytics app (mounted under /api/analytics/ by config.urls)."""
from django.urls import path, register_converter

from apps.core.converters import IdConverter

from . import views

register_converter(IdConverter, "id")

app_name = "analytics"

urlpatterns = [
    path("dashboard/", views.DashboardView.as_view(), name="dashboard"),
    path("overview/", views.OverviewView.as_view(), name="overview"),
    path("categories/", views.CategoryAnalyticsView.as_view(), name="categories"),
    path("departments/", views.DepartmentAnalyticsView.as_view(), name="departments"),
    path("trends/", views.TrendsView.as_view(), name="trends"),
    path("hotspots/", views.HotspotsView.as_view(), name="hotspots"),
    path("sentiment/", views.SentimentView.as_view(), name="sentiment"),
    path("officers/", views.OfficerAnalyticsView.as_view(), name="officers"),
    path("ai/", views.AIAnalyticsView.as_view(), name="ai"),
    path("public/", views.PublicStatsView.as_view(), name="public"),
    path("reports/", views.ReportsView.as_view(), name="reports"),
    path("run-checks/", views.RunChecksView.as_view(), name="run-checks"),
    path("alerts/", views.HotspotAlertListView.as_view(), name="alerts"),
    path("alerts/<id:pk>/", views.HotspotAlertDetailView.as_view(), name="alert-detail"),
]
