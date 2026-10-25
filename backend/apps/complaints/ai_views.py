"""AI endpoints (``/api/ai/*``): the analysis preview, the model playground and the AI helpers of the UI.

==============================  =====  ==========================================================
``POST /ai/analyze/``           A      full analysis preview via ``services.pipeline.analyze_preview``
``POST /ai/classify/``          A      vision + NLP + multimodal fusion engines called directly
``POST /ai/priority/``          O/AD   recalculate a stored complaint, or run the engine on what-if inputs
``POST /ai/duplicates/``        A      re-run detection for a stored complaint, or "similar issues nearby"
``POST /ai/verify-resolution/`` O/AD   compare two uploaded photos, or verify a stored complaint
``POST /ai/sentiment/``         AD     sentiment analysis playground
``GET  /ai/model-info/``        A      model registry / status + the current AI configuration
``POST /ai/demo/``              P      public landing-page demo (vision + NLP + fusion + severity hint)
==============================  =====  ==========================================================

Preview / playground calls never write to the database; only the ``complaint_id`` variants persist
results (through the service layer). Every POST is rate limited with the ``ai`` throttle scope because
model inference is the most expensive work the server does; the public demo has its own, stricter
``ai_public`` scope.

Honest failure modes: an AI component that is not available (``NotImplementedError`` from an unfinished
engine, missing model weights, a missing package) answers **503** ``{"detail": "<Engine> unavailable."}``;
an image the engine cannot decode answers **400** with a clear message. Results are never invented.
"""
import logging
import time

from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from ai.config import DEMO_DISCLAIMER
from ai.exceptions import ModelUnavailableError
from apps.core.exceptions import ServiceError
from apps.core.models import AIConfiguration
from apps.core.permissions import IsAdmin, IsOfficerOrAdmin
from apps.core.throttles import CivicScopedRateThrottle
from apps.departments.models import CivicCategory

from .models import Complaint
from .permissions import can_act_as_officer, scope_complaints
from .serializers import (
    PRIORITY_WEIGHT_KEYS,
    AIConfigSnapshotSerializer,
    AnalyzeRequestSerializer,
    CategoryMiniSerializer,
    ClassifyRequestSerializer,
    ComplaintReferenceSerializer,
    DemoAnalysisRequestSerializer,
    DuplicateCheckSerializer,
    DuplicateLinkSerializer,
    PriorityBreakdownSerializer,
    PrioritySimulationSerializer,
    SentimentRequestSerializer,
    VerificationSerializer,
    VerifyResolutionRequestSerializer,
    complaint_duplicate_links,
    optimize_complaint_mini_queryset,
    serialize_engine_payload,
)
from .services import duplicates as duplicate_service
from .services import pipeline as pipeline_service
from .services import priority as priority_service
from .services import verification as verification_service
from .services.context import engine_categories, engine_config
from .views import unavailable_guard

logger = logging.getLogger("apps.complaints")

#: Maximum number of "similar issues nearby" returned by the duplicate preview.
DUPLICATE_PREVIEW_LIMIT = 10


# ---------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------
def read_upload(upload):
    """Bytes of an uploaded file (the stream is rewound so it can be read again)."""
    upload.seek(0)
    content = upload.read()
    upload.seek(0)
    return content


def scoped_complaint(request, complaint_id):
    """The complaint if it is inside the user's scope, else 404 (never reveals other complaints)."""
    queryset = scope_complaints(
        Complaint.objects.select_related("category", "department", "assigned_officer", "citizen", "location"),
        request.user,
    )
    complaint = queryset.filter(pk=complaint_id).first()
    if complaint is None:
        raise NotFound("Complaint not found.")
    return complaint


def duplicate_candidates_payload(matches, request, *, limit=None):
    """``[{"complaint": ComplaintMini, ...scores}]`` from engine matches (``complaint_id``) or from
    service rows that already carry the ``complaint``; matches whose complaint vanished are dropped."""
    matches = list(matches or [])[:limit] if limit else list(matches or [])
    wanted = [m.get("complaint_id") for m in matches if m.get("complaint") is None and m.get("complaint_id")]
    complaints = {c.pk: c for c in optimize_complaint_mini_queryset(Complaint.objects.filter(pk__in=wanted))}
    results = []
    for match in matches:
        scores = {key: value for key, value in match.items() if key not in ("complaint", "complaint_id")}
        complaint = match.get("complaint")
        if complaint is None:
            complaint = complaints.get(match.get("complaint_id"))
        if complaint is None:
            continue
        results.append(serialize_engine_payload({"complaint": complaint, **scores}, request=request))
    return results


def _has_value(request, field):
    data = request.data
    return hasattr(data, "get") and data.get(field) not in (None, "")


class AIEndpoint(APIView):
    """Base view: parsers for JSON + multipart, and the ``ai`` rate limit on every POST."""

    throttle_scope = "ai"
    parser_classes = (JSONParser, MultiPartParser, FormParser)

    def get_throttles(self):
        throttles = super().get_throttles()
        if self.request.method == "POST":
            throttles.append(ScopedRateThrottle())
        return throttles

    def validated(self, serializer_class):
        serializer = serializer_class(data=self.request.data, context={"request": self.request, "view": self})
        serializer.is_valid(raise_exception=True)
        return serializer.validated_data


# ---------------------------------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------------------------------
class AnalyzeView(AIEndpoint):
    """``POST /api/ai/analyze/`` - ``{image?, description, latitude?, longitude?, address?, category?}``.

    Runs the complete analysis (vision, NLP, fusion, location risk, severity, priority, duplicates,
    routing, officer recommendation) without saving anything and returns the engine outputs.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request):
        data = self.validated(AnalyzeRequestSerializer)
        with unavailable_guard("AI analysis service"):
            result = pipeline_service.analyze_preview(
                image_file=data.get("image"), text=data["description"], latitude=data.get("latitude"),
                longitude=data.get("longitude"), address=data["address"], reported_category=data["category"],
            )
        result = dict(result or {})
        if isinstance(result.get("duplicates"), list):
            result["duplicates"] = duplicate_candidates_payload(result["duplicates"], request)
        return Response(serialize_engine_payload(result, request=request))


def classify_inputs(image, description, *, categories, config, use_filename_hint=True):
    """Vision + NLP + multimodal fusion for an uploaded photo and/or a description - nothing is stored.

    Late fusion technique: the vision model and the text classifier each produce a probability distribution over
    the civic categories; ``fuse_predictions`` combines them weighted by modality confidence (configurable
    image/text weights) and flags disagreement for human review. Returns ``{"vision", "text", "fusion",
    "category": CivicCategory|None, "is_demo", "mode"}``; engine failures become API errors (``unavailable_guard``).
    ``use_filename_hint=False`` analyses the photo's pixels only (the demo heuristics otherwise accept a class
    keyword in the file name as a disclosed hint).
    """
    from ai.config import get_model_mode

    vision_result = text_result = None
    if image is not None:
        with unavailable_guard("Vision engine", image_field="image"):
            from ai import vision

            vision_result = vision.analyze_image(read_upload(image), categories=categories,
                                                 filename_hint=image.name if use_filename_hint else None)
    if description:
        with unavailable_guard("Text NLP engine"):
            from ai import nlp

            text_result = nlp.analyze_text(description, categories=categories)
    with unavailable_guard("Multimodal fusion engine"):
        from ai import multimodal

        fusion = multimodal.fuse_predictions(
            vision_result, text_result, reported_category=None, location_prior=None, categories=categories,
            config=config.get("fusion"),
        )
    slug = (fusion or {}).get("category")
    mode = get_model_mode()
    return {
        "vision": vision_result,
        "text": text_result,
        "fusion": fusion,
        "category": CivicCategory.objects.filter(slug=slug).first() if slug else None,
        "is_demo": mode == "demo" or any(bool(result.get("is_demo")) for result in (vision_result, text_result)
                                         if result),
        "mode": mode,
    }


class ClassifyView(AIEndpoint):
    """``POST /api/ai/classify/`` - ``{image?, description?}`` (at least one) -> ``{"vision", "text", "fusion",
    "category": CategoryMini|null, "is_demo", "mode"}`` (see :func:`classify_inputs`)."""

    permission_classes = (IsAuthenticated,)

    def post(self, request):
        data = self.validated(ClassifyRequestSerializer)
        result = classify_inputs(data.get("image"), data["description"], categories=engine_categories(),
                                 config=engine_config())
        category = result["category"]
        result["category"] = CategoryMiniSerializer(category).data if category else None
        return Response(serialize_engine_payload(result, request=request))


#: Always part of the public demo's disclaimer (in production mode it is the whole disclaimer).
DEMO_ENDPOINT_NOTE = (
    "Live demo: nothing is stored and no complaint is filed. The severity is a hint from the photo and the text "
    "only - location risk and nearby complaints are assessed when a real complaint is submitted."
)


class PublicDemoView(APIView):
    """``POST /api/ai/demo/`` (public, no account) - the landing page's live AI demo.

    multipart ``{image?, description?}`` (at least one; the photo passes the shared upload validator, the
    description is at most 1000 characters) -> ``{"vision", "text", "fusion", "category": CategoryMini|null,
    "severity_hint": {"level", "score", "reason"}, "is_demo", "mode", "disclaimer", "processing_time_ms"}``.

    Runs the real engines - vision, text NLP, multimodal fusion and the severity engine (without location
    context) - and **writes nothing** to the database or the media storage. The photo is classified from its
    pixels only (no file-name hints). Authentication is ignored (an expired token never blocks the demo) and
    requests are rate limited per client with the ``ai_public`` throttle scope (inference is CPU-heavy).
    """

    authentication_classes = ()
    permission_classes = (AllowAny,)
    throttle_classes = (CivicScopedRateThrottle,)
    throttle_scope = "ai_public"
    parser_classes = (MultiPartParser, FormParser, JSONParser)

    def post(self, request):
        started = time.perf_counter()
        serializer = DemoAnalysisRequestSerializer(data=request.data, context={"request": request, "view": self})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        categories = engine_categories()
        config = engine_config(create=False)
        result = classify_inputs(data.get("image"), data["description"], categories=categories, config=config,
                                 use_filename_hint=False)
        category = result["category"]
        severity = self._severity_hint(result, categories, config)
        payload = {
            "vision": result["vision"],
            "text": result["text"],
            "fusion": result["fusion"],
            "category": CategoryMiniSerializer(category).data if category else None,
            "severity_hint": severity,
            "is_demo": result["is_demo"],
            "mode": result["mode"],
            "disclaimer": f"{DEMO_DISCLAIMER} {DEMO_ENDPOINT_NOTE}" if result["is_demo"] else DEMO_ENDPOINT_NOTE,
            "processing_time_ms": int(round((time.perf_counter() - started) * 1000)),
        }
        return Response(serialize_engine_payload(payload))

    @staticmethod
    def _severity_hint(result, categories, config):
        """``ai.severity.assess_severity`` on the photo / text evidence; location risk is not assessed (its
        weight is redistributed by the engine) and no nearby complaints are looked up."""
        slug = (result["fusion"] or {}).get("category")
        profile = next((item for item in categories if item.get("slug") == slug), None)
        with unavailable_guard("Severity engine"):
            from ai.severity import assess_severity

            severity = assess_severity(
                category=slug, category_profile=profile, vision=result["vision"], text=result["text"],
                location_risk=None, nearby_count=0, frequency_count=0, duplicate_count=0,
                config=config.get("severity"),
            )
        return {"level": severity["severity"], "score": severity["score"], "reason": severity["reason"]}


class PriorityView(AIEndpoint):
    """``POST /api/ai/priority/``

    * ``{complaint_id}`` - recalculate the stored complaint's priority -> PriorityBreakdown (persisted);
    * ``{severity_score, public_impact, location_risk, nearby_count, frequency_count, duplicate_count,
      category?, is_reopened?, weights?}`` - run the priority engine on what-if inputs (nothing stored).
      ``weights`` overrides some/all configured weights; the engine normalises them to 100.
    """

    permission_classes = (IsOfficerOrAdmin,)

    def post(self, request):
        if _has_value(request, "complaint_id"):
            complaint = scoped_complaint(request, self.validated(ComplaintReferenceSerializer)["complaint_id"])
            with unavailable_guard("Priority service"):
                score = priority_service.recalculate_priority(complaint, actor=request.user)
            return Response(PriorityBreakdownSerializer(score, context={"request": request}).data)
        return Response(self._simulate(self.validated(PrioritySimulationSerializer)))

    def _simulate(self, data):
        priority_config = dict(engine_config().get("priority") or {})
        weights = {**(priority_config.get("weights") or {}), **data.get("weights", {})}
        if sum(float(weights.get(key, 0) or 0) for key in PRIORITY_WEIGHT_KEYS) <= 0:
            raise ValidationError({"weights": ["At least one priority weight must be greater than zero."]})
        category = data["category"]
        inputs = {
            "severity_score": data["severity_score"],
            "public_impact": data["public_impact"],
            "location_risk": data["location_risk"],
            "nearby_count": data["nearby_count"],
            "frequency_count": data["frequency_count"],
            "duplicate_count": data["duplicate_count"],
            "category_safety_weight": float(category.public_safety_weight) if category else 0.0,
            "is_reopened": data["is_reopened"],
            "category": category.slug if category else None,
        }
        with unavailable_guard("Priority engine"):
            from ai import priority as priority_engine

            result = priority_engine.PriorityEngine({**priority_config, "weights": weights}).calculate(inputs)
        return serialize_engine_payload(result)


class DuplicatesView(AIEndpoint):
    """``POST /api/ai/duplicates/``

    * ``{complaint_id}`` - re-run duplicate detection for a stored complaint and return all of its
      DuplicateLinks (both directions);
    * multipart ``{description, latitude, longitude, image?, category?}`` - "similar issues nearby" check of
      the submit form via ``services.duplicates.preview_duplicates``: complaints inside the duplicate radius /
      time window are scored by the duplicate engine (text-embedding similarity + perceptual image hashes +
      GPS distance decay). Nothing is stored.

    The category-mismatch rule of the engine needs the report's category: the citizen's optional hint is
    used, otherwise the text classifier's prediction; if the NLP engine is unavailable the check still runs
    on text, image and location alone (no category is guessed).
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request):
        if _has_value(request, "complaint_id"):
            complaint = scoped_complaint(request, self.validated(ComplaintReferenceSerializer)["complaint_id"])
            with unavailable_guard("Duplicate detection service"):
                duplicate_service.detect_duplicates(complaint)
            context = {"request": request, "viewed_complaint_id": complaint.pk}
            return Response(DuplicateLinkSerializer(complaint_duplicate_links(complaint), many=True, context=context).data)
        return Response(self._similar_nearby(self.validated(DuplicateCheckSerializer)))

    @staticmethod
    def _text_category(description):
        try:
            from ai import nlp

            return (nlp.analyze_text(description, categories=engine_categories()) or {}).get("category")
        except (NotImplementedError, ModelUnavailableError, ImportError) as exc:
            logger.warning("Text classifier unavailable for the duplicate check (%s); no category used", exc)
            return None

    def _similar_nearby(self, data):
        category, image = data["category"], data.get("image")
        with unavailable_guard("Duplicate detection service", image_field="image"):
            matches = duplicate_service.preview_duplicates(
                text=data["description"], latitude=data["latitude"], longitude=data["longitude"],
                image_data=read_upload(image) if image is not None else None,
                filename=image.name if image is not None else None,
                category_slug=category.slug if category else self._text_category(data["description"]),
            )
        return duplicate_candidates_payload(matches, self.request, limit=DUPLICATE_PREVIEW_LIMIT)


class VerifyResolutionView(AIEndpoint):
    """``POST /api/ai/verify-resolution/``

    * multipart ``{before_image, after_image, category?}`` - run the verification engine on the two
      photos (SSIM, histogram and edge-density change, issue re-detection) and return its output;
      nothing is stored;
    * ``{complaint_id}`` - AI-verify the stored complaint's latest evidence -> Verification (persisted;
      assigned officer or admin only).
    """

    permission_classes = (IsOfficerOrAdmin,)

    def post(self, request):
        if _has_value(request, "complaint_id"):
            complaint = scoped_complaint(request, self.validated(ComplaintReferenceSerializer)["complaint_id"])
            if not can_act_as_officer(request.user, complaint):
                raise PermissionDenied("Only the officer assigned to this complaint or an administrator can verify it.")
            with unavailable_guard("Resolution verification service"):
                verification = verification_service.run_ai_verification(complaint, actor=request.user, request=request)
            if verification is None:
                raise ServiceError("There is no resolution evidence to verify yet. Upload an after photo first.")
            return Response(VerificationSerializer(verification, context={"request": request}).data)

        data = self.validated(VerifyResolutionRequestSerializer)
        category = data["category"]
        with unavailable_guard("Verification engine", image_field="non_field_errors"):
            from ai import verification as verification_engine

            result = verification_engine.verify_resolution(
                read_upload(data["before_image"]), read_upload(data["after_image"]),
                category=category.slug if category else None, boxes=None,
                config=engine_config().get("verification"),
            )
        return Response(serialize_engine_payload(result))


class SentimentView(AIEndpoint):
    """``POST /api/ai/sentiment/`` - ``{text, rating?}`` -> sentiment engine output (admin playground)."""

    permission_classes = (IsAdmin,)

    def post(self, request):
        data = self.validated(SentimentRequestSerializer)
        with unavailable_guard("Sentiment engine"):
            from ai.nlp import sentiment as sentiment_engine

            result = sentiment_engine.analyze_sentiment(data["text"], data.get("rating"))
        return Response(serialize_engine_payload(result))


class ModelInfoView(AIEndpoint):
    """``GET /api/ai/model-info/`` - ``ai.model_info.get_model_info(engine_config())`` + ``{"config": AIConfiguration}``.

    The live AI configuration is passed to the engine so the component descriptions (priority weights and
    thresholds, duplicate weights / radius, DBSCAN parameters, fusion weights) show the values in force and
    report ``"parameters": "configured"``.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request):
        with unavailable_guard("Model information"):
            from ai import model_info

            info = model_info.get_model_info(engine_config())
        payload = serialize_engine_payload(dict(info or {}), request=request)
        payload["config"] = AIConfigSnapshotSerializer(AIConfiguration.load(), context={"request": request}).data
        return Response(payload)
