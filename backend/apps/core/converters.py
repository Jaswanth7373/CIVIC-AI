"""URL path converters."""
from .utils import ID_PATTERN


class IdConverter:
    """``<id:pk>`` - a primary key of 1-18 ASCII digits, passed to the view as ``int``.

    Django's built-in ``<int:...>`` accepts any number of digits, so ``/alerts/99999999999999999999999/`` reached
    the database with an integer SQLite cannot bind (OverflowError, HTTP 500); such paths now simply do not match
    (404).
    """

    regex = ID_PATTERN

    def to_python(self, value):
        return int(value)

    def to_url(self, value):
        return str(int(value))
