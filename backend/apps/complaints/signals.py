"""Signals for complaints: clean up the Location row when a complaint is deleted."""
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import Complaint, Location


@receiver(post_delete, sender=Complaint)
def delete_complaint_location(sender, instance, **kwargs):
    if instance.location_id:
        Location.objects.filter(pk=instance.location_id).delete()
