"""Project password validators (configured in ``settings.AUTH_PASSWORD_VALIDATORS``)."""
from django.core.exceptions import ValidationError


class NotOnlyWhitespaceValidator:
    """Rejects a password made only of spaces, tabs or line breaks.

    Password fields keep whitespace (``trim_whitespace=False``) so real passwords are never altered, but then eight
    spaces would satisfy the length rule and none of Django's validators object: an effectively empty secret.
    """

    message = "Your password cannot consist only of spaces."

    def validate(self, password, user=None):
        if not str(password or "").strip():
            raise ValidationError(self.message, code="password_only_whitespace")

    def get_help_text(self):
        return "Your password cannot consist only of spaces."
