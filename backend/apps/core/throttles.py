"""Scoped rate limiting for sensitive public endpoints.

DRF's ``ScopedRateThrottle`` limits requests per *scope*: a view declares ``throttle_scope = "auth"`` and the
allowed rate comes from ``REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]`` (config/settings.py):

    "auth": 20/min     register + login           (password guessing, mass sign-ups)
    "contact": 5/min   public contact form        (spam)
    "ai": 60/min       AI playground endpoints    (CPU-heavy inference)

New complaints are limited per citizen by two fixed-scope throttles (:class:`ComplaintSubmissionBurstThrottle`
6/min and :class:`ComplaintSubmissionDailyThrottle` 40/day): every submission runs the whole AI pipeline and
notifies officers, so one account must not be able to flood the queues, the duplicate review or its own
priority scores.

Requests are counted per user id when authenticated, otherwise per client IP, with a sliding window stored
in Django's cache (the history of request timestamps for ``throttle_<scope>_<ident>``). Over the limit, DRF
answers ``429 Too Many Requests`` with a ``Retry-After`` header.

Usage::

    class LoginView(APIView):
        throttle_classes = [CivicScopedRateThrottle]
        throttle_scope = "auth"
"""
from django.conf import settings
from rest_framework.throttling import ScopedRateThrottle, UserRateThrottle


class TestSuiteExemptMixin:
    """Follows the project rule "no throttling while the test-suite runs".

    config/settings.py removes the default throttles when ``TESTING`` is true; views that list a throttle
    explicitly would otherwise still be rate limited and the (shared, in-memory) cache would make unrelated
    tests fail with 429. Tests that verify throttling run with ``override_settings(TESTING=False)``.
    """

    def allow_request(self, request, view):
        if getattr(settings, "TESTING", False):
            return True
        return super().allow_request(request, view)


class CivicScopedRateThrottle(TestSuiteExemptMixin, ScopedRateThrottle):
    """``ScopedRateThrottle`` (the view's ``throttle_scope``) exempt from throttling during the test-suite."""


class ComplaintSubmissionBurstThrottle(TestSuiteExemptMixin, UserRateThrottle):
    """New complaints per citizen per minute (rate ``complaint_burst``, default 6/min)."""

    scope = "complaint_burst"


class ComplaintSubmissionDailyThrottle(TestSuiteExemptMixin, UserRateThrottle):
    """New complaints per citizen per day (rate ``complaint_daily``, default 40/day)."""

    scope = "complaint_daily"
