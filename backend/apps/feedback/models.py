"""Citizen feedback on resolved complaints, with NLP sentiment."""
from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone


class Feedback(models.Model):
    class Sentiment(models.TextChoices):
        POSITIVE = "positive", "Positive"
        NEUTRAL = "neutral", "Neutral"
        NEGATIVE = "negative", "Negative"

    complaint = models.ForeignKey("complaints.Complaint", on_delete=models.CASCADE, related_name="feedback")
    citizen = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="feedback_given")
    rating = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(5)])
    text = models.TextField(blank=True)
    sentiment = models.CharField(max_length=10, choices=Sentiment.choices, blank=True, db_index=True)
    sentiment_score = models.FloatField(default=0, help_text="-1 (very negative) .. +1 (very positive)")
    sentiment_confidence = models.FloatField(default=0)
    sentiment_model = models.CharField(max_length=160, blank=True)
    is_demo = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name_plural = "feedback"

    def __str__(self):
        return f"Feedback {self.rating}* ({self.sentiment}) on {self.complaint_id}"
