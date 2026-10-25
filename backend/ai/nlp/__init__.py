"""NLP for civic complaint text and citizen feedback (see docs/BUILD_SPEC.md section 2.2).

Public API (CONTRACT - keep these names/signatures):
    analyze_text(text, *, categories=None) -> dict
    describe_models() -> list[dict]
    warm_up() -> list[dict]          (optional: preload the current mode's models)
Sub-modules:
    text_preprocessor  - Unicode cleanup, tokenisation, language id, Hinglish/Telugu synonym
                         normalisation, spelling correction, light lemmatisation, stopwords
    classifier         - TF-IDF + logistic regression (demo) / Sentence-Transformer + logistic
                         regression (production), blended with DB category keywords
    embedding          - get_text_embedder(): TF-IDF (demo) / all-MiniLM-L6-v2 (production)
    keyword_extractor  - extract_keywords(): TF-IDF + domain boost (demo) / KeyBERT-style MMR
    impact             - impacts, urgency, sensitive locations, severity hint (rule-based)
    sentiment          - analyze_sentiment(): VADER-style lexicon (demo) / RoBERTa (production)
Helpers:
    lexicons / sentiment_lexicon - curated vocabularies (stopwords, synonyms, valences ...)
    corpus             - loading + fingerprinting of the bundled corpora in data/
    backends           - lazy, failure-tolerant loading of sentence-transformers / transformers
    data/build_corpus  - reproducible generator of the corpora (python -m ai.nlp.data.build_corpus)
Training / evaluation: scripts/train_text_classifier.py --mode demo|production
"""
import time

from ..config import get_model_mode
from . import classifier as _classifier
from . import embedding as _embedding
from . import keyword_extractor as _keywords
from . import sentiment as _sentiment
from .impact import assess_impact
from .lexicons import LANGUAGE_NAMES
from .text_preprocessor import preprocess

__all__ = ["analyze_text", "describe_models", "preprocess", "warm_up"]

LOW_CONFIDENCE = 0.45


def _explanation(result, cls, replacements):
    label = _classifier.category_label(result["category"], result["_categories"])
    parts = []
    if cls["fallback_reason"]:
        parts.append(f"{cls['fallback_reason']}, so the demo technique was used.")
    sentence = "Demo AI Mode: " if cls["is_demo"] else ""
    sentence += f"{cls['technique']} classified the text as {label} ({result['confidence']:.0%})"
    matched = cls["keyword_matches"].get(result["category"])
    if cls["keyword_decided"] and matched:
        sentence += f" after matching category keywords ({', '.join(matched[:3])})"
    keywords = result["keywords"][:3]
    sentence += f"; keywords: {', '.join(keywords)}" if keywords else "; no distinctive keywords"
    impact = result["primary_impact"]
    sentence += f"; potential impact: {impact}." if impact else "; no specific impact detected."
    parts.append(sentence)
    if result["language"] not in ("en", "und") and replacements:
        examples = ", ".join(f"{a} → {b}" for a, b in replacements[:3])
        parts.append(f"{LANGUAGE_NAMES.get(result['language'], result['language'])} words were normalised ({examples}).")
    if result["confidence"] < LOW_CONFIDENCE:
        parts.append("Low confidence: manual review is advisable.")
    return " ".join(parts)


def analyze_text(text, *, categories=None):
    """Full text analysis of a complaint description.

    ``categories``: active DB category dicts (``slug``, ``name``, ``keywords``, optional
    ``base_severity``) - their keywords are blended into the classification so admin-created
    categories work without retraining.

    Returns (CONTRACT):
        {
          "category": "pothole", "confidence": 0.88, "probabilities": {"pothole": 0.88, ...},
          "keywords": ["pothole", "school", "traffic"],
          "impacts": [{"type": "public_safety", "label": "Public Safety", "score": 0.9, "evidence": ["school"]}],
          "primary_impact": "Public Safety",
          "safety_score": 0.8, "urgency_score": 0.6,
          "severity_hint": "high", "severity_hint_score": 0.72,
          "location_mentions": ["school entrance"],
          "clean_text": "large pothole near school entrance causing traffic problems",
          "language": "en",
          "model_version": "demo-tfidf-logreg-1.0", "mode": "demo", "is_demo": True,
          "explanation": "...", "processing_time_ms": 12,
        }
    Extra keys: ``fallback_reason``, ``technique``, ``model_probabilities`` (before keyword
    blending), ``keyword_matches``, ``evidence_terms`` (n-grams that drove the demo model),
    ``normalized_text``, ``replacements`` and ``signals`` (urgency / magnitude details).
    """
    started = time.perf_counter()
    prep = preprocess(text)
    cls = _classifier.classify(prep, categories=categories)
    keywords = _keywords.extract_from_prep(prep, top_k=6)
    impact = assess_impact(prep, category=cls["category"], categories=categories)
    result = {
        "category": cls["category"],
        "confidence": cls["confidence"],
        "probabilities": cls["probabilities"],
        "keywords": keywords,
        "impacts": impact["impacts"],
        "primary_impact": impact["primary_impact"],
        "safety_score": impact["safety_score"],
        "urgency_score": impact["urgency_score"],
        "severity_hint": impact["severity_hint"],
        "severity_hint_score": impact["severity_hint_score"],
        "location_mentions": impact["location_mentions"],
        "clean_text": " ".join(prep["tokens"]),
        "language": prep["language"],
        "model_version": cls["model_version"],
        "mode": get_model_mode(),
        "is_demo": cls["is_demo"],
        "explanation": "",
        "processing_time_ms": 0,
        "fallback_reason": cls["fallback_reason"],
        "technique": cls["technique"],
        "model_probabilities": cls["model_probabilities"],
        "keyword_matches": cls["keyword_matches"],
        "evidence_terms": cls["evidence_terms"],
        "normalized_text": prep["normalized"],
        "replacements": prep["replacements"],
        "signals": impact["signals"],
        "_categories": categories,
    }
    result["explanation"] = _explanation(result, cls, prep["replacements"])
    result.pop("_categories")
    result["processing_time_ms"] = int(round((time.perf_counter() - started) * 1000))
    return result


def describe_models():
    """Model-info entries (``{name, task, framework, version, status, is_demo, detail}``) for the
    text classifier, embedder, sentiment model and keyword extractor - real runtime status."""
    return [_classifier.describe(), _embedding.describe(), _sentiment.describe(), _keywords.describe()]


def warm_up():
    """Load every NLP model of the current mode now instead of on the first request.

    Optional: in production the first use costs ~20 s (importing sentence-transformers / torch and
    loading the weights), so a server or worker can call this at start-up. Returns
    ``describe_models()`` afterwards, i.e. the real status of each component.
    """
    analyze_text("Large pothole near the school entrance causing traffic problems.")
    _embedding.get_text_embedder().similarity("pothole near school", "pothole outside school")
    _sentiment.analyze_sentiment("The issue was resolved quickly.")
    return describe_models()
