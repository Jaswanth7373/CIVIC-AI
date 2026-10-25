"""Exceptions raised by the AI engine."""


class AIEngineError(Exception):
    """Base class for AI engine errors."""


class ImageProcessingError(AIEngineError):
    """The image could not be read / decoded / processed."""


class ModelUnavailableError(AIEngineError):
    """A production model could not be loaded (missing package or weights)."""
