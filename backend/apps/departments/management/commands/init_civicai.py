"""``python manage.py init_civicai`` - install CivicAI's reference data (idempotent).

Creates or re-syncs the 7 departments, 9 civic categories (with routing, severity weights, multilingual
keywords and vision labels), the AI configuration singleton and the Hyderabad risk zones defined in
``apps.departments.defaults``. Running it again never duplicates rows.

Options::

    --admin-email EMAIL        create (or promote/update) an administrator superuser
    --admin-password PASSWORD  password for that account (or set CIVICAI_ADMIN_PASSWORD, which keeps the
                               password out of the shell history); validated by AUTH_PASSWORD_VALIDATORS
    --admin-first-name / --admin-last-name
    --keep-existing            only create missing rows; leave rows an admin has edited untouched

Examples::

    python manage.py init_civicai
    python manage.py init_civicai --admin-email admin@civicai.local --admin-password "<strong password>"
"""
import os

from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction

from apps.accounts.models import User
from apps.departments.defaults import ReferenceDataError, ensure_reference_data


class Command(BaseCommand):
    help = ("Install CivicAI reference data (departments, categories, AI configuration, risk zones) "
            "and optionally an admin account.")

    def add_arguments(self, parser):
        parser.add_argument("--admin-email", default=os.environ.get("CIVICAI_ADMIN_EMAIL", ""),
                            help="E-mail of an administrator account to create or update.")
        parser.add_argument("--admin-password", default=None,
                            help="Password for the administrator (default: $CIVICAI_ADMIN_PASSWORD).")
        parser.add_argument("--admin-first-name", default=None, help="First name for a new administrator.")
        parser.add_argument("--admin-last-name", default=None, help="Last name for a new administrator.")
        parser.add_argument("--keep-existing", action="store_true",
                            help="Only create missing rows; do not overwrite existing reference data.")

    def handle(self, *args, **options):
        update_existing = not options["keep_existing"]
        try:
            summary = ensure_reference_data(update_existing=update_existing)
        except ReferenceDataError as exc:
            raise CommandError(str(exc))

        self.stdout.write(self.style.MIGRATE_HEADING("CivicAI reference data"))
        for label, key in (("Departments", "departments"), ("Categories", "categories"), ("Risk zones", "risk_zones")):
            self.stdout.write(f"  {label:<12} {self._describe(summary[key])}")
        config = summary["ai_configuration"]["config"]
        state = "created with defaults" if summary["ai_configuration"]["created"] else "kept (existing settings)"
        self.stdout.write(
            f"  {'AI config':<12} {state}: priority weights severity {config.weight_severity:g} / "
            f"impact {config.weight_public_impact:g} / location {config.weight_location_risk:g} / "
            f"frequency {config.weight_frequency:g} / duplicates {config.weight_duplicates:g}"
        )

        email = (options["admin_email"] or "").strip().lower()
        if email:
            password = options["admin_password"] or os.environ.get("CIVICAI_ADMIN_PASSWORD") or ""
            outcome = self._ensure_admin(email, password, options["admin_first_name"], options["admin_last_name"])
            self.stdout.write(f"  {'Admin':<12} {outcome} {email} (superuser, role=admin)")
        self.stdout.write(self.style.SUCCESS("CivicAI is initialised."))

    @staticmethod
    def _describe(counter):
        parts = [f"{counter['created']} created"]
        if counter["updated"]:
            parts.append(f"{counter['updated']} updated")
        if counter["kept"]:
            parts.append(f"{counter['kept']} kept")
        return f"{counter['total']} ({', '.join(parts)})"

    def _ensure_admin(self, email, password, first_name, last_name):
        """Create the admin superuser, or promote / update an existing account with that e-mail."""
        try:
            validate_email(email)
        except ValidationError:
            raise CommandError(f"'{email}' is not a valid e-mail address.")

        user = User.objects.filter(email__iexact=email).first()
        if user is None and not password:
            raise CommandError("A password is required to create a new admin: use --admin-password or set "
                               "CIVICAI_ADMIN_PASSWORD.")
        names = {
            "first_name": first_name if first_name is not None else (user.first_name if user else "CivicAI"),
            "last_name": last_name if last_name is not None else (user.last_name if user else "Administrator"),
        }
        if password:
            try:
                password_validation.validate_password(password, user=User(email=email, **names))
            except ValidationError as exc:
                raise CommandError("Admin password rejected: " + " ".join(exc.messages))

        with transaction.atomic():
            if user is None:
                User.objects.create_superuser(email=email, password=password, **names)
                return "created"
            user.role = User.Role.ADMIN
            user.is_staff = True
            user.is_superuser = True
            user.is_active = True
            user.first_name, user.last_name = names["first_name"], names["last_name"]
            if password:
                user.set_password(password)
            user.save()
        return "updated" if password else "updated (password unchanged)"
