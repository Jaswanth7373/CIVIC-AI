from django.contrib import admin

from .models import Feedback


@admin.register(Feedback)
class FeedbackAdmin(admin.ModelAdmin):
    list_display = ("complaint", "citizen", "rating", "sentiment", "sentiment_score", "created_at")
    list_filter = ("sentiment", "rating")
    search_fields = ("text",)
