"""Authentication (/api/auth/*) and admin user management (/api/users/) endpoints.

Authentication uses JSON Web Tokens (djangorestframework-simplejwt):

* login / register return a short-lived *access* token (sent as ``Authorization: Bearer <access>``) and a
  longer-lived *refresh* token;
* ``/auth/refresh/`` rotates the refresh token and blacklists the used one (ROTATE_REFRESH_TOKENS +
  BLACKLIST_AFTER_ROTATION), so a stolen refresh token stops working after its next legitimate use; concurrent
  uses of one refresh token are serialised by the blacklist's unique key, so exactly one of them succeeds;
* ``/auth/logout/`` blacklists the refresh token *and* the access token of the session, ending it server-side;
* ``/auth/change-password/`` signs the account out everywhere: every token carries a password fingerprint
  (``CHECK_REVOKE_TOKEN``) and all outstanding refresh tokens are blacklisted. The response carries a fresh token
  pair for the session that made the change (see ``apps/accounts/tokens.py``).

Register and login are rate limited with the ``auth`` throttle scope (brute-force protection) and every
security-relevant event (register, login, failed login, logout, password change, admin edits) is written to
the audit log.
"""
from django.contrib.auth import authenticate
from django.contrib.auth.models import update_last_login
from django.db.models import Case, F, IntegerField, OuterRef, Value, When
from django.db.models.functions import Coalesce
from rest_framework import exceptions, status, viewsets
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from apps.audit.models import AuditLog
from apps.audit.services import log_action
from apps.complaints.models import Complaint
from apps.core.permissions import IsAdmin
from apps.core.throttles import CivicScopedRateThrottle
from apps.core.utils import ID_PATTERN
from apps.core.views import AnnotatedWriteMixin, diff_snapshots, snapshot, subquery_count
from apps.officers.models import OfficerProfile

from .models import User
from .serializers import (
    AdminUserCreateSerializer,
    AdminUserSerializer,
    AdminUserUpdateSerializer,
    ChangePasswordSerializer,
    LoginSerializer,
    LogoutSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    TokenRefreshSerializer,
    UserSerializer,
)
from .tokens import issue_tokens, revoke_access_token, revoke_all_sessions

INVALID_CREDENTIALS_MESSAGE = "Invalid email or password."
INACTIVE_ACCOUNT_MESSAGE = "This account has been deactivated. Please contact the CivicAI administrator."
USER_AUDIT_FIELDS = ["email", "first_name", "last_name", "phone", "is_active", "role"]


class PublicTokenEndpointMixin:
    """Settings for the anonymous token endpoints (register / login).

    * No authentication classes: a stale ``Authorization`` header left in the browser must not make the
      login request itself fail with "token not valid".
    * ``get_authenticate_header`` keeps failed logins as real HTTP 401 responses (DRF turns a 401 into 403
      when a view has no authenticator that could produce a ``WWW-Authenticate`` header).
    * ``auth`` scoped rate limit against password guessing / mass sign-ups.
    """

    authentication_classes = ()
    permission_classes = [AllowAny]
    throttle_classes = [CivicScopedRateThrottle]
    throttle_scope = "auth"

    def get_authenticate_header(self, request):
        return f'{jwt_settings.AUTH_HEADER_TYPES[0]} realm="api"'


class RegisterView(PublicTokenEndpointMixin, APIView):
    """POST /api/auth/register/ -> 201 ``{"user": User, "access", "refresh"}`` (always a citizen account)."""

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        log_action(user, AuditLog.Action.REGISTER, entity=user, description=f"Citizen account registered: {user.email}",
                   request=request)
        tokens = issue_tokens(user)
        if jwt_settings.UPDATE_LAST_LOGIN:
            update_last_login(None, user)
        return Response(
            {"user": UserSerializer(user, context={"request": request}).data, **tokens},
            status=status.HTTP_201_CREATED,
        )


class LoginView(PublicTokenEndpointMixin, APIView):
    """POST /api/auth/login/ ``{email, password}`` -> ``{"access", "refresh", "user": User}``.

    * Wrong e-mail *or* wrong password -> 401 with the same generic message (no account enumeration).
      Django's ``authenticate()`` also runs the password hasher for unknown e-mails, so response times do
      not reveal whether an account exists.
    * Correct password on a deactivated account -> 403 (only revealed once the password is proven).
    """

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]
        password = serializer.validated_data["password"]

        # Case-insensitive lookup of the stored spelling, then the regular auth backend check.
        account = User.objects.filter(email__iexact=email).first()
        user = authenticate(request=request, email=account.email if account else email, password=password)
        if user is None:
            if account is not None and not account.is_active and account.check_password(password):
                log_action(None, AuditLog.Action.LOGIN, entity=account,
                           description=f"Login blocked for deactivated account {account.email}",
                           changes={"success": False, "reason": "inactive"}, request=request)
                raise exceptions.PermissionDenied(INACTIVE_ACCOUNT_MESSAGE)
            if account is not None:
                log_action(None, AuditLog.Action.LOGIN, entity=account,
                           description=f"Failed login attempt for {account.email}",
                           changes={"success": False, "reason": "invalid_password"}, request=request)
            raise exceptions.AuthenticationFailed(INVALID_CREDENTIALS_MESSAGE, code="invalid_credentials")

        tokens = issue_tokens(user)
        if jwt_settings.UPDATE_LAST_LOGIN:
            update_last_login(None, user)
        log_action(user, AuditLog.Action.LOGIN, entity=user, description=f"{user.email} signed in",
                   changes={"success": True}, request=request)
        return Response({**tokens, "user": UserSerializer(user, context={"request": request}).data})


class RefreshView(TokenRefreshView):
    """POST /api/auth/refresh/ ``{refresh}`` -> ``{"access", "refresh"}`` (rotated; the old one is blacklisted)."""

    permission_classes = [AllowAny]
    serializer_class = TokenRefreshSerializer


class LogoutView(APIView):
    """POST /api/auth/logout/ ``{refresh}`` -> ``{"detail": "Logged out."}``.

    The refresh token is blacklisted, so it can no longer mint access tokens, and so is the access token the
    request was made with, so the session ends now rather than when that token expires. The refresh token must
    belong to the signed-in user (one user cannot revoke another user's session).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = LogoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            token = RefreshToken(serializer.validated_data["refresh"])
        except TokenError:
            raise exceptions.ValidationError(
                {"refresh": ["This refresh token is invalid, expired or already revoked."]}
            )
        if str(token.get(jwt_settings.USER_ID_CLAIM)) != str(request.user.pk):
            raise exceptions.ValidationError({"refresh": ["This refresh token does not belong to the current user."]})
        token.blacklist()
        revoke_access_token(request.auth)
        log_action(request.user, AuditLog.Action.LOGOUT, entity=request.user,
                   description=f"{request.user.email} signed out", request=request)
        return Response({"detail": "Logged out."})


class ProfileView(APIView):
    """GET/PATCH/PUT /api/auth/profile/ - the signed-in user's own profile (``User`` shape)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user, context={"request": request}).data)

    def patch(self, request):
        return self._update(request, partial=True)

    def put(self, request):
        return self._update(request, partial=False)

    def _update(self, request, *, partial):
        user = request.user
        before = snapshot(user, ["first_name", "last_name", "phone", "avatar"])
        serializer = ProfileUpdateSerializer(user, data=request.data, partial=partial, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        changes = diff_snapshots(before, snapshot(user, ["first_name", "last_name", "phone", "avatar"]))
        if "citizen_profile" in serializer.validated_data:
            changes["citizen_profile"] = sorted(serializer.validated_data["citizen_profile"].keys())
        if changes:
            log_action(user, AuditLog.Action.UPDATE, entity=user, description="Profile updated", changes=changes,
                       request=request)
        user.refresh_from_db()
        return Response(UserSerializer(user, context={"request": request}).data)


class ChangePasswordView(APIView):
    """POST /api/auth/change-password/ ``{old_password, new_password}`` -> 200 ``{"detail", "access", "refresh"}``.

    Every existing session of the account ends: the password fingerprint in all earlier tokens no longer matches
    and their refresh tokens are blacklisted. The new ``access`` / ``refresh`` pair keeps the session that made the
    change signed in (the client stores it in place of its old tokens).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        revoked = revoke_all_sessions(user)
        log_action(user, AuditLog.Action.PASSWORD_CHANGE, entity=user,
                   description=f"{user.email} changed their password", changes={"sessions_revoked": revoked},
                   request=request)
        return Response({"detail": "Password changed. You have been signed out on your other devices.",
                         **issue_tokens(user)})


def annotate_user_counts(queryset):
    """Annotate the per-row numbers shown in the admin user table, in the same SQL statement as the list:

    * ``complaint_count`` - complaints assigned (officers) or reported (everyone else),
    * ``civic_points``     - from the citizen profile (0 for staff),
    * ``active_workload_count`` - open complaints assigned to an officer (used by ``officer_profile``).

    Correlated sub-selects (``subquery_count``) are used instead of several ``Count()`` joins, which would
    multiply rows and inflate the numbers.
    """
    reported = subquery_count(Complaint.objects.filter(citizen=OuterRef("pk")), "citizen")
    assigned = subquery_count(Complaint.objects.filter(assigned_officer=OuterRef("pk")), "assigned_officer")
    active = subquery_count(
        Complaint.objects.filter(assigned_officer=OuterRef("pk"), status__in=Complaint.OPEN_ASSIGNED_STATUSES),
        "assigned_officer",
    )
    return queryset.annotate(
        reported_count=reported,
        assigned_count=assigned,
        active_workload_count=active,
        civic_points=Coalesce(F("citizen_profile__civic_points"), Value(0)),
    ).annotate(
        complaint_count=Case(
            When(role=User.Role.OFFICER, then=F("assigned_count")),
            default=F("reported_count"),
            output_field=IntegerField(),
        )
    )


class UserViewSet(AnnotatedWriteMixin, viewsets.ModelViewSet):
    """Admin user management.

    GET /api/users/ (filters ``role``, ``is_active``, ``search``; paginated) - POST (any role) -
    GET/PATCH/PUT /api/users/{id}/ - DELETE = soft delete (``is_active=False``; never your own account).
    """

    permission_classes = [IsAdmin]
    read_serializer_class = AdminUserSerializer
    filterset_fields = ["role", "is_active"]
    search_fields = ["email", "first_name", "last_name", "phone"]
    ordering_fields = ["date_joined", "email", "first_name", "last_name", "last_login", "role", "complaint_count"]
    ordering = ["-date_joined"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return annotate_user_counts(User.objects.select_related("citizen_profile", "officer_profile__department"))

    def get_serializer_class(self):
        if self.action == "create":
            return AdminUserCreateSerializer
        if self.action in ("update", "partial_update"):
            return AdminUserUpdateSerializer
        return AdminUserSerializer

    def perform_create(self, serializer):
        user = serializer.save()
        log_action(self.request.user, AuditLog.Action.CREATE, entity=user,
                   description=f"Created {user.role} account {user.email}",
                   changes=snapshot(user, USER_AUDIT_FIELDS), request=self.request)
        return user

    def perform_update(self, serializer):
        before = snapshot(serializer.instance, USER_AUDIT_FIELDS)
        user = serializer.save()
        changes = diff_snapshots(before, snapshot(user, USER_AUDIT_FIELDS))
        if changes:
            log_action(self.request.user, AuditLog.Action.UPDATE, entity=user,
                       description=f"Updated account {user.email}", changes=changes, request=self.request)
        return user

    def destroy(self, request, *args, **kwargs):
        user = self.get_object()
        if user.pk == request.user.pk:
            raise exceptions.ValidationError({"detail": ["You cannot deactivate your own account."]})
        if user.is_superuser and not request.user.is_superuser:
            raise exceptions.PermissionDenied("Only a superuser can deactivate a superuser account.")
        if user.is_active:
            user.is_active = False
            user.save(update_fields=["is_active", "updated_at"])
            OfficerProfile.objects.filter(user=user).update(is_available=False)
            log_action(request.user, AuditLog.Action.UPDATE, entity=user,
                       description=f"Deactivated account {user.email}",
                       changes={"is_active": [True, False]}, request=request)
        return Response({"detail": f"{user.full_name}'s account has been deactivated.", "deactivated": True})
