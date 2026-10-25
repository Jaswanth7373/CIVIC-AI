"""REST endpoints of the analytics app, mounted at ``/api/analytics/`` (owner B5).

Views are deliberately thin: validate the query string, call one function of
:mod:`apps.analytics.services` / :mod:`apps.analytics.reports` and return the result passed
through :func:`services.clean_json` (no NaN / numpy values can reach the JSON renderer).

Permissions: ``dashboard/`` any authenticated user (role-aware); ``hotspots/`` officers and
admins; ``public/`` anyone (aggregates only, authentication ignored); everything else admins.
"""
import logging

from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import APIException, PermissionDenied
from rest_framework.generics import ListAPIView
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log_action
from apps.core.permissions import IsAdmin, IsOfficerOrAdmin, user_role

from . import reports, services
from .models import HotspotAlert
from .serializers import (
    AlertQuerySerializer,
    AnalyticsQuerySerializer,
    HotspotAlertSerializer,
    HotspotAlertUpdateSerializer,
    HotspotQuerySerializer,
    ReportQuerySerializer,
    SentimentQuerySerializer,
    TrendQuerySerializer,
    validated_query,
)
from .tasks import scan_hotspots

logger = logging.getLogger("apps.analytics")


class HotspotEngineUnavailableError(APIException):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "Hotspot engine unavailable"
    default_code = "hotspot_engine_unavailable"


def _json(data, status_code=status.HTTP_200_OK):
    return Response(services.clean_json(data), status=status_code)


class AdminAnalyticsView(APIView):
    """Base for admin-only analytics endpoints that accept the common filters."""

    permission_classes = [IsAdmin]
    query_serializer_class = AnalyticsQuerySerializer

    def query(self, request):
        return validated_query(self.query_serializer_class, request)


class DashboardView(APIView):
    """GET ``dashboard/`` - citizen, officer or admin dashboard depending on the caller's role."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        role = user_role(request.user)
        if role == "citizen":
            return _json(services.citizen_dashboard(request.user, request=request))
        if role == "officer":
            return _json(services.officer_dashboard(request.user, request=request))
        if role == "admin":
            filters = validated_query(AnalyticsQuerySerializer, request).filters
            return _json({"role": "admin", **services.overview(filters, request=request)})
        raise PermissionDenied("Your account has no dashboard role.")


class OverviewView(AdminAnalyticsView):
    """GET ``overview/`` - platform-wide totals, distributions and recent critical complaints."""

    def get(self, request):
        return _json(services.overview(self.query(request).filters, request=request))


class CategoryAnalyticsView(AdminAnalyticsView):
    """GET ``categories/`` - per-category workload and performance."""

    def get(self, request):
        return _json(services.category_breakdown(self.query(request).filters, request=request))


class DepartmentAnalyticsView(AdminAnalyticsView):
    """GET ``departments/`` - per-department performance, SLA compliance and workload."""

    def get(self, request):
        return _json(services.department_breakdown(self.query(request).filters, request=request))


class OfficerAnalyticsView(AdminAnalyticsView):
    """GET ``officers/`` - per-officer workload, utilisation and track record."""

    def get(self, request):
        return _json(services.officer_performance(self.query(request).filters, request=request))


class TrendsView(AdminAnalyticsView):
    """GET ``trends/?period=day|week|month&days=90`` - time series bucketed in Python."""

    query_serializer_class = TrendQuerySerializer

    def get(self, request):
        query = self.query(request)
        data = query.validated_data
        return _json(services.trends(query.filters, request=request, period=data["period"], days=data["days"]))


class SentimentView(AdminAnalyticsView):
    """GET ``sentiment/`` - feedback sentiment distribution, breakdowns, trend and keywords."""

    query_serializer_class = SentimentQuerySerializer

    def get(self, request):
        query = self.query(request)
        data = query.validated_data
        return _json(services.sentiment_analytics(
            query.filters, request=request, period=data["period"], days=data["days"]
        ))


class AIAnalyticsView(AdminAnalyticsView):
    """GET ``ai/`` - AI model performance (confidence, agreement, overrides, duplicates, verification)."""

    def get(self, request):
        return _json(services.ai_performance(self.query(request).filters, request=request))


class HotspotsView(APIView):
    """GET ``hotspots/`` - DBSCAN hotspot clusters, map points and recent alerts (officers / admins)."""

    permission_classes = [IsOfficerOrAdmin]

    def get(self, request):
        query = validated_query(HotspotQuerySerializer, request)
        data = query.validated_data
        try:
            result = services.hotspot_map(
                query.filters, user=request.user, request=request,
                eps_m=data.get("eps_m"), min_samples=data.get("min_samples"), days=data["days"],
            )
        except services.HotspotEngineUnavailable:
            raise HotspotEngineUnavailableError() from None
        return _json(result)


class PublicStatsView(APIView):
    """GET ``public/`` - anonymous landing-page statistics (aggregates only, no personal data)."""

    permission_classes = [AllowAny]
    authentication_classes = []  # a stale token in the browser must not turn a public page into a 401

    def get(self, request):
        return _json(services.public_stats(request=request))


class ReportFormatNegotiation(BaseContentNegotiation):
    """On ``reports/`` the ``format`` query parameter selects the export type (json | csv | pdf),
    not a DRF renderer, so content negotiation always answers with the JSON renderer (used for the
    preview and for error responses; files are returned as plain ``HttpResponse`` objects)."""

    def select_parser(self, request, parsers):
        return parsers[0] if parsers else None

    def select_renderer(self, request, renderers, format_suffix=None):
        return renderers[0], renderers[0].media_type


class ReportsView(AdminAnalyticsView):
    """GET ``reports/?report=summary|complaints|departments|officers|feedback&format=json|csv|pdf``."""

    query_serializer_class = ReportQuerySerializer
    renderer_classes = [JSONRenderer]
    content_negotiation_class = ReportFormatNegotiation

    def get(self, request):
        query = self.query(request)
        data = query.validated_data
        filters, key, output = query.filters, data["report"], data["format"]
        if output == "json":
            return _json(reports.report_preview(reports.build_report(key, filters, limit=data["limit"])))
        report = reports.build_report(key, filters, limit=reports.EXPORT_ROW_LIMITS[output])
        if output == "csv":
            body, content_type = reports.render_csv(report), "text/csv; charset=utf-8"
        else:
            body, content_type = reports.render_pdf(report), "application/pdf"
        filename = reports.report_filename(key, output)
        response = HttpResponse(body, content_type=content_type)
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response["Access-Control-Expose-Headers"] = "Content-Disposition"
        response["Cache-Control"] = "no-store"
        log_action(
            request.user, "export", entity_type="report", entity_id=key,
            description=f"Exported {report.name} as {output.upper()} ({len(report.rows)} rows)",
            changes={"report": key, "format": output, "filters": filters.as_dict(), "rows": len(report.rows),
                     "filename": filename},
            request=request,
        )
        return response


def _sla_alert_count(result):
    """Normalise whatever ``check_sla_breaches`` returns (int, list, dict) to a count."""
    if result is None:
        return 0
    if isinstance(result, bool):
        return int(result)
    if isinstance(result, int):
        return result
    if isinstance(result, dict):
        for key in ("alerts", "sla_alerts", "notified", "count", "complaints"):
            value = result.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
            if isinstance(value, (list, tuple, set)):
                return len(value)
        return 0
    if isinstance(result, (list, tuple, set)):
        return len(result)
    return 0


class RunChecksView(APIView):
    """POST ``run-checks/`` - run the SLA breach check and the hotspot scan now."""

    permission_classes = [IsAdmin]

    def post(self, request):
        errors = {}
        sla_alerts = 0
        try:
            from apps.complaints.tasks import check_sla_breaches
        except ImportError:
            errors["sla_check"] = "The SLA check task is not available."
        else:
            try:
                sla_alerts = _sla_alert_count(check_sla_breaches())
            except NotImplementedError:
                errors["sla_check"] = "The SLA check is not implemented yet."
            except Exception:
                logger.exception("SLA breach check failed")
                errors["sla_check"] = "The SLA check failed; see the server log."
        hotspot_alerts = 0
        try:
            hotspot_alerts = scan_hotspots(raise_errors=True)
        except services.HotspotEngineUnavailable:
            errors["hotspot_scan"] = "Hotspot engine unavailable"
        except Exception:
            logger.exception("Hotspot scan failed")
            errors["hotspot_scan"] = "The hotspot scan failed; see the server log."
        payload = {"sla_alerts": sla_alerts, "hotspot_alerts": hotspot_alerts}
        if errors:
            payload["errors"] = errors
        log_action(
            request.user, "other", entity_type="system", entity_id="run-checks",
            description=f"Ran SLA and hotspot checks ({sla_alerts} SLA alerts, {hotspot_alerts} hotspot alerts)",
            changes=payload, request=request,
        )
        return _json(payload)


class HotspotAlertListView(ListAPIView):
    """GET ``alerts/`` - hotspot alerts, newest first; optional ``?is_acknowledged=true|false``.

    Returns ``[HotspotAlert]`` (the newest 100) by default, as the frontend service expects; when
    ``page`` or ``page_size`` is given the standard paginated envelope is returned instead.
    """

    permission_classes = [IsAdmin]
    serializer_class = HotspotAlertSerializer
    filter_backends = []
    unpaginated_limit = 100

    def get_queryset(self):
        query = validated_query(AlertQuerySerializer, self.request)
        alerts = HotspotAlert.objects.select_related("dominant_category").order_by("-created_at", "-id")
        if "is_acknowledged" in query.validated_data:
            alerts = alerts.filter(is_acknowledged=query.validated_data["is_acknowledged"])
        return alerts

    def list(self, request, *args, **kwargs):
        if "page" in request.query_params or "page_size" in request.query_params:
            return super().list(request, *args, **kwargs)
        alerts = self.get_queryset()[: self.unpaginated_limit]
        return Response(self.get_serializer(alerts, many=True).data)


class HotspotAlertDetailView(APIView):
    """GET / PATCH ``alerts/{id}/`` - read one alert or set ``is_acknowledged``."""

    permission_classes = [IsAdmin]

    def get(self, request, pk):
        alert = get_object_or_404(HotspotAlert.objects.select_related("dominant_category"), pk=pk)
        return Response(HotspotAlertSerializer(alert, context={"request": request}).data)

    def patch(self, request, pk):
        alert = get_object_or_404(HotspotAlert.objects.select_related("dominant_category"), pk=pk)
        serializer = HotspotAlertUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        previous, value = alert.is_acknowledged, serializer.validated_data["is_acknowledged"]
        if previous != value:
            alert.is_acknowledged = value
            alert.save(update_fields=["is_acknowledged"])
            log_action(
                request.user, "update", entity=alert,
                description=f"Hotspot alert {'acknowledged' if value else 'reopened'}: {alert.area_name}"[:255],
                changes={"is_acknowledged": [previous, value]}, request=request,
            )
        return Response(HotspotAlertSerializer(alert, context={"request": request}).data)
