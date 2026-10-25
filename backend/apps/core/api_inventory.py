"""Live inventory of the REST API: every URL pattern under ``/api/`` with its HTTP methods and permission level.

The URLconf is walked with ``django.urls.get_resolver()``; for each route the view class is instantiated the
way DRF does it (router ``initkwargs`` + the action of the HTTP method) and ``get_permissions()`` is asked which
permission classes guard that method. The classes are translated into the permission levels of
docs/BUILD_SPEC.md section 4.2:

    P  public (AllowAny)        A  any authenticated user      C  citizen      O  officer      AD  administrator
    O (assigned)  only the officer the complaint is assigned to    C (owner)  only the citizen who reported it

``apps/core/test_api_contract.py`` compares this inventory with docs/API_ENDPOINTS.md, so the published API
documentation can never drift from the code; ``python manage.py api_endpoints`` prints it.
"""
import re
from dataclasses import dataclass
from types import SimpleNamespace

from django.urls import URLPattern, URLResolver, get_resolver

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
DOCUMENTED_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

#: Permission class name -> level.
PERMISSION_LEVELS = {
    "AllowAny": "P",
    "IsAuthenticated": "A",
    "IsCitizen": "C",
    "IsOfficer": "O",
    "IsAdmin": "AD",
    "IsOfficerOrAdmin": "O/AD",
    "IsAssignedOfficer": "O (assigned)",
    "IsAssignedOfficerOrAdmin": "O (assigned)/AD",
    "IsComplaintOwnerOrAdmin": "C (owner)/AD",
}
#: Classes whose level depends on the method: (read level, write level).
READ_WRITE_LEVELS = {
    "IsAdminOrPublicReadOnly": ("P", "AD"),
    "IsAdminOrReadOnly": ("A", "AD"),
}
#: Plain Django views (no DRF permission classes).
FUNCTION_VIEW_LEVELS = {"health": "P"}

_REGEX_PARAMETER = re.compile(r"\(\?P<(\w+)>[^)]*\)")
_PATH_PARAMETER = re.compile(r"<(?:\w+:)?(\w+)>")


@dataclass(frozen=True)
class Endpoint:
    method: str
    path: str  # e.g. "/api/complaints/{id}/accept/"
    permission: str  # e.g. "O (assigned)/AD"
    view: str  # e.g. "ComplaintViewSet.accept"


def normalize_path(route):
    """``api/^complaints/(?P<pk>\\d+)/accept/$`` / ``alerts/<int:pk>/`` -> ``/api/complaints/{id}/accept/``."""
    path = route.replace("^", "").replace("$", "")
    path = _REGEX_PARAMETER.sub(lambda match: "{id}" if match.group(1) == "pk" else "{%s}" % match.group(1), path)
    path = _PATH_PARAMETER.sub(lambda match: "{id}" if match.group(1) == "pk" else "{%s}" % match.group(1), path)
    return "/" + path.lstrip("/")


def permission_level(permissions, method):
    """Level label for permission instances guarding ``method`` (several classes are joined with " + ")."""
    labels = []
    for permission in permissions:
        name = type(permission).__name__
        if name in READ_WRITE_LEVELS:
            read, write = READ_WRITE_LEVELS[name]
            labels.append(read if method in SAFE_METHODS else write)
        else:
            labels.append(PERMISSION_LEVELS.get(name, name))
    return " + ".join(labels) or "P"


def _walk(patterns, prefix=""):
    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            yield from _walk(pattern.url_patterns, prefix + str(pattern.pattern))
        elif isinstance(pattern, URLPattern):
            yield prefix + str(pattern.pattern), pattern


def _view_permissions(view_class, initkwargs, method, action=None):
    view = view_class(**initkwargs)
    view.request = SimpleNamespace(method=method, query_params={}, data={}, user=None)
    view.args, view.kwargs, view.format_kwarg = (), {}, None
    if action is not None:
        view.action = action
    return view.get_permissions()


def _route_endpoints(route, pattern):
    callback = pattern.callback
    view_class = getattr(callback, "cls", None) or getattr(callback, "view_class", None)
    path = normalize_path(route)
    if view_class is None:  # plain Django function view
        name = getattr(callback, "__name__", str(callback))
        if name in FUNCTION_VIEW_LEVELS:
            yield Endpoint("GET", path, FUNCTION_VIEW_LEVELS[name], name)
        return
    initkwargs = getattr(callback, "initkwargs", None) or {}
    allowed = {method.upper() for method in getattr(view_class, "http_method_names", [])}
    actions = getattr(callback, "actions", None)
    if actions:  # ViewSet route: HTTP method -> action
        for method, action in actions.items():
            method = method.upper()
            if method in DOCUMENTED_METHODS and method in allowed:
                permissions = _view_permissions(view_class, initkwargs, method, action)
                yield Endpoint(method, path, permission_level(permissions, method), f"{view_class.__name__}.{action}")
        return
    for method in DOCUMENTED_METHODS:
        if method in allowed and hasattr(view_class, method.lower()):
            permissions = _view_permissions(view_class, initkwargs, method)
            yield Endpoint(method, path, permission_level(permissions, method), view_class.__name__)


def api_endpoints():
    """Every documented endpoint under ``/api/`` (sorted by path, then method)."""
    endpoints = []
    for route, pattern in _walk(get_resolver().url_patterns):
        if route.startswith("api/"):
            endpoints.extend(_route_endpoints(route, pattern))
    order = {method: index for index, method in enumerate(DOCUMENTED_METHODS)}
    return sorted(set(endpoints), key=lambda item: (item.path, order[item.method]))
