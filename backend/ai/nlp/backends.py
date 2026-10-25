"""Lazy loaders for the production deep-learning backends of the NLP engine.

* ``sentence_transformer()`` - ``SentenceTransformer(TEXT_EMBEDDING_MODEL)`` (default
  ``sentence-transformers/all-MiniLM-L6-v2``, 384-d sentence embeddings), shared by the production
  text classifier, the embedder (duplicate detection) and the KeyBERT-style keyword extractor.
* ``sentiment_pipeline()`` - a Hugging Face ``transformers`` text-classification pipeline for
  ``SENTIMENT_MODEL`` (default ``cardiffnlp/twitter-roberta-base-sentiment-latest``).

Weights are downloaded once into ``HF_CACHE_DIR`` (``backend/ml_models/hf_cache``) and loaded once
per process through the shared registry. When the weights are already cached they are loaded with
``local_files_only=True`` (no network round-trips, works offline); only if that fails is a normal,
downloading load attempted. A failed load (package missing, no network, corrupt cache) is cached
too, as a ``Backend`` with ``error`` set, so callers fall back to the demo technique immediately
instead of retrying a slow download on every request; ``ai.common.reset_registry()`` clears it for
a retry.
"""
import logging
import os
import time
from dataclasses import dataclass

from ..common import get_or_load
from ..config import DEVICE, HF_CACHE_DIR, SENTIMENT_MODEL, TEXT_EMBEDDING_MODEL

logger = logging.getLogger("ai.nlp")


@dataclass(frozen=True)
class Backend:
    """A loaded model or the reason it could not be loaded."""

    name: str
    model: object = None
    error: str = None
    load_seconds: float = 0.0

    @property
    def ok(self):
        return self.model is not None


def _describe_error(exc):
    message = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    text = f"{type(exc).__name__}: {message}" if message else type(exc).__name__
    return text[:240]


def _prepare_hub():
    HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # Windows without developer mode cannot create symlinks; the hub then copies files. The warning
    # about it is noise for this deployment, the cache still works.
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def _cache_first(model_name, build):
    """``build(local_files_only)``: offline from the cache when possible, otherwise online."""
    if is_cached(model_name):
        try:
            return build(True)
        except Exception as exc:  # incomplete / partial cache -> try a downloading load
            logger.info("Cached weights of %s could not be loaded offline (%s); retrying online", model_name, exc)
    return build(False)


def sentence_transformer():
    """Process-wide SentenceTransformer for ``TEXT_EMBEDDING_MODEL`` (``Backend``)."""

    def _load():
        started = time.perf_counter()
        try:
            _prepare_hub()
            from sentence_transformers import SentenceTransformer

            model = _cache_first(TEXT_EMBEDDING_MODEL, lambda local: SentenceTransformer(
                TEXT_EMBEDDING_MODEL, cache_folder=str(HF_CACHE_DIR), device=DEVICE, local_files_only=local))
            seconds = time.perf_counter() - started
            logger.info("Loaded sentence embedder %s in %.1fs", TEXT_EMBEDDING_MODEL, seconds)
            return Backend(TEXT_EMBEDDING_MODEL, model, None, seconds)
        except Exception as exc:  # ImportError, OSError (download), RuntimeError (torch) ...
            logger.warning("Sentence embedder %s unavailable: %s", TEXT_EMBEDDING_MODEL, exc)
            return Backend(TEXT_EMBEDDING_MODEL, None, _describe_error(exc), time.perf_counter() - started)

    return get_or_load(f"nlp.backend.sentence_transformer::{TEXT_EMBEDDING_MODEL}", _load)


def sentiment_pipeline():
    """Process-wide transformers text-classification pipeline for ``SENTIMENT_MODEL`` (``Backend``)."""

    def _load():
        started = time.perf_counter()
        try:
            _prepare_hub()
            from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

            def build(local):
                tokenizer = AutoTokenizer.from_pretrained(SENTIMENT_MODEL, cache_dir=str(HF_CACHE_DIR),
                                                          local_files_only=local)
                model = AutoModelForSequenceClassification.from_pretrained(
                    SENTIMENT_MODEL, cache_dir=str(HF_CACHE_DIR), local_files_only=local)
                return pipeline("text-classification", model=model, tokenizer=tokenizer, top_k=None, device=DEVICE)

            classifier = _cache_first(SENTIMENT_MODEL, build)
            seconds = time.perf_counter() - started
            logger.info("Loaded sentiment model %s in %.1fs", SENTIMENT_MODEL, seconds)
            return Backend(SENTIMENT_MODEL, classifier, None, seconds)
        except Exception as exc:
            logger.warning("Sentiment model %s unavailable: %s", SENTIMENT_MODEL, exc)
            return Backend(SENTIMENT_MODEL, None, _describe_error(exc), time.perf_counter() - started)

    return get_or_load(f"nlp.backend.sentiment_pipeline::{SENTIMENT_MODEL}", _load)


def is_installed(module_name):
    """True when ``module_name`` can be imported (checked without importing it)."""
    import importlib.util

    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def is_cached(model_name):
    """True when the Hugging Face hub cache in ``HF_CACHE_DIR`` already holds ``model_name``."""
    folder = HF_CACHE_DIR / ("models--" + model_name.replace("/", "--"))
    if not folder.exists() and "/" not in model_name:
        folder = HF_CACHE_DIR / ("models--sentence-transformers--" + model_name)
    return (folder / "snapshots").exists()
