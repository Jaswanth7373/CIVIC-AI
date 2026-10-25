"""JWT session control: revocable access tokens and "sign out everywhere".

simplejwt issues two tokens per sign-in: a refresh token (7 days, recorded in ``OutstandingToken`` and rotated on
every use) and an access token (``JWT_ACCESS_MINUTES``) that every API request carries. Three rules make the
server-side session state authoritative:

* **Password fingerprint** (``SIMPLE_JWT["CHECK_REVOKE_TOKEN"]``): every token carries a hash of the user's
  password hash, and authentication rejects a token whose fingerprint no longer matches. Changing a password - by
  the user or by an administrator - therefore ends every existing session at once, access tokens included.
* **Revocable access tokens** (:class:`AccessToken`, ``AUTH_TOKEN_CLASSES``): logout blacklists the access token
  of the session as well as its refresh token, so the session cannot be used until the access token expires.
* :func:`revoke_all_sessions` blacklists every outstanding refresh token of a user (used after a password change).
"""
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import AccessToken as SimpleJWTAccessToken
from rest_framework_simplejwt.tokens import BlacklistMixin, RefreshToken


class AccessToken(BlacklistMixin, SimpleJWTAccessToken):
    """Access token that is checked against the token blacklist on every request and can be blacklisted.

    Access tokens are minted from refresh tokens (``refresh.access_token``), never through ``for_user``, so they
    are only written to ``OutstandingToken`` when a logout blacklists one.
    """


def issue_tokens(user):
    """New refresh/access pair for ``user`` (the refresh token is recorded as outstanding for blacklisting)."""
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


def revoke_all_sessions(user):
    """Blacklist every unexpired refresh token of ``user`` that is not blacklisted yet; returns how many."""
    pending = list(
        OutstandingToken.objects.filter(user=user, expires_at__gt=timezone.now(), blacklistedtoken__isnull=True)
    )
    BlacklistedToken.objects.bulk_create([BlacklistedToken(token=token) for token in pending], ignore_conflicts=True)
    return len(pending)


def revoke_access_token(token):
    """Blacklist the access token a request was authenticated with (``request.auth``); no-op for other auth."""
    if isinstance(token, BlacklistMixin):
        token.blacklist()
