"""Signals for the accounts app: auto-create a CitizenProfile for citizen users."""
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import CitizenProfile, User


@receiver(post_save, sender=User)
def ensure_citizen_profile(sender, instance, created, **kwargs):
    if instance.role == User.Role.CITIZEN:
        CitizenProfile.objects.get_or_create(user=instance)
