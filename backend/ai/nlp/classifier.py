"""Complaint text classification: the 9 civic classes plus admin-defined categories.

Demo technique (``MODEL_MODE=demo``): **TF-IDF + logistic regression**
    Features are a scikit-learn ``FeatureUnion`` of two TF-IDF views of the preprocessed text:

    * word unigrams + bigrams over the *normalised* text (lemmas after synonym normalisation, so
      "gaddha", "potholes" and "pothole" are one feature);
    * character 3-5 grams (``char_wb``) over the cleaned *surface* words, which makes the model
      robust to typos and unseen spellings ("pothol", "garbge", "gaddhe").

    Both use sublinear term frequency (1 + log tf) and L2 normalisation. The classifier is a
    multinomial ``LogisticRegression(class_weight="balanced")``: a linear model whose softmax gives
    a probability for every class, and whose coefficients make each decision explainable (the
    word n-grams with the largest positive contribution are reported as ``evidence_terms``).

Production technique (``MODEL_MODE=production``): **Sentence-Transformer embeddings + logistic
regression** - all-MiniLM-L6-v2 sentence embeddings (384-d, L2-normalised) of the canonical text
with a logistic-regression head trained on the same corpus. If the embedder cannot be loaded the
demo technique is used and ``fallback_reason`` explains why.

Training data is ``data/complaint_corpus.csv``. Fitted models are cached with joblib in
``MODEL_PATH/nlp/`` (``text_clf_demo.joblib`` / ``text_clf_st.joblib``) together with a fingerprint
of the corpus bytes, the preprocessing code + vocabularies and the hyper-parameters; a missing,
stale or unreadable cache is retrained automatically (a few seconds in demo mode).

Keyword blending (both modes) - admin categories work without retraining
    Every DB category passed in ``categories`` contributes its ``keywords`` (matched on lemmas,
    so "stray dogs" matches "stray dog"; overlapping matches count once, longest first). The
    keyword score is ``k = 1 - exp(-sum(w))`` with w = 1.0 per word and 1.5 per multi-word phrase.

    * Trained classes receive an additive boost ``KEYWORD_BOOST * k``.
    * Admin-created categories, unknown to the trained model, are treated as specialisations of
      the catch-all "other" class: they receive ``KEYWORD_BOOST * k`` plus a share of the
      probability the model gave to "other" (that mass is moved away from "other" in proportion
      to the strongest keyword score). Their name is used as an extra keyword phrase.

    Scores are renormalised over the trained classes + every provided category slug.
"""
import hashlib
import logging
import math
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from functools import lru_cache

import numpy as np

from ..common import get_or_load, get_statuses, set_status
from ..config import CIVIC_CLASSES, CLASS_LABELS, MODEL_PATH, TEXT_EMBEDDING_MODEL, get_model_mode
from . import backends
from .corpus import COMPLAINT_CORPUS, file_sha256, preprocessed_complaints, preprocessing_fingerprint
from .text_preprocessor import normalize_phrase, normalize_text, tokenize

logger = logging.getLogger("ai.nlp")

CLASSIFIER_VERSION = "1.0"
MODEL_VERSION_DEMO = "demo-tfidf-logreg-1.0"
DEMO_TECHNIQUE = "TF-IDF + logistic regression"
PRODUCTION_TECHNIQUE = "Sentence-Transformer embeddings + logistic regression"
DEMO_FILE = "text_clf_demo.joblib"
PRODUCTION_FILE = "text_clf_st.joblib"
STATUS_NAME = "nlp.text_classifier"
STATUS_TASK = "Complaint text classification"

DEMO_C = 8.0          # inverse L2 regularisation strength of the TF-IDF logistic regression
PRODUCTION_C = 10.0   # same for the embedding head
KEYWORD_BOOST = 0.5   # weight of a full-strength keyword match relative to model probability
WORD_WEIGHT = 1.0
PHRASE_WEIGHT = 1.5


def model_dir():
    return MODEL_PATH / "nlp"


def production_model_version():
    return f"st-{TEXT_EMBEDDING_MODEL.split('/')[-1]}-logreg-{CLASSIFIER_VERSION}"


# ---------------------------------------------------------------------------------------------
# Features / training
# ---------------------------------------------------------------------------------------------
def _split(text):
    return text.split()


def _pick_normalized(docs):
    return [d["normalized"] for d in docs]


def _pick_surface(docs):
    return [d["surface"] for d in docs]


def features(prep):
    """The two text views the demo model consumes, built from ``preprocess()`` output."""
    return {"normalized": prep["normalized"], "surface": " ".join(prep["tokens"])}


def build_demo_pipeline():
    """Untrained sklearn pipeline: FeatureUnion(word TF-IDF, char TF-IDF) -> LogisticRegression."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import FeatureUnion, Pipeline
    from sklearn.preprocessing import FunctionTransformer

    word = Pipeline([
        ("select", FunctionTransformer(_pick_normalized)),
        ("tfidf", TfidfVectorizer(tokenizer=_split, token_pattern=None, lowercase=False,
                                  ngram_range=(1, 2), sublinear_tf=True)),
    ])
    char = Pipeline([
        ("select", FunctionTransformer(_pick_surface)),
        ("tfidf", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2, lowercase=False,
                                  sublinear_tf=True)),
    ])
    return Pipeline([
        ("features", FeatureUnion([("word", word), ("char", char)])),
        ("clf", LogisticRegression(C=DEMO_C, class_weight="balanced", max_iter=5000)),
    ])


def train_demo(preps, labels):
    """Fit the demo TF-IDF pipeline on preprocessed documents."""
    pipeline = build_demo_pipeline()
    pipeline.fit([features(p) for p in preps], list(labels))
    return pipeline


def encode_canonical(encoder, preps):
    """Sentence embeddings (L2-normalised) of the canonical text of preprocessed documents."""
    texts = [p["canonical"] or p["clean"] or " " for p in preps]
    return encoder.encode(texts, batch_size=32, normalize_embeddings=True, convert_to_numpy=True,
                          show_progress_bar=False)


def train_production(preps, labels, encoder):
    """Fit the logistic-regression head on sentence embeddings."""
    from sklearn.linear_model import LogisticRegression

    head = LogisticRegression(C=PRODUCTION_C, class_weight="balanced", max_iter=5000)
    head.fit(encode_canonical(encoder, preps), list(labels))
    return head


class TextClassifier:
    """A fitted classifier behind one interface for both techniques."""

    def __init__(self, *, mode, model, version, technique, info, encoder=None):
        self.mode = mode
        self.model = model
        self.version = version
        self.technique = technique
        self.info = info
        self.encoder = encoder
        self.is_demo = mode == "demo"
        self.classes = [str(c) for c in model.classes_]
        self._word_vocab = None

    def predict_proba(self, preps):
        """Class probabilities, shape (n_docs, n_classes), columns ordered like ``self.classes``."""
        if self.is_demo:
            return self.model.predict_proba([features(p) for p in preps])
        return self.model.predict_proba(encode_canonical(self.encoder, preps))

    def evidence_terms(self, prep, label, k=3):
        """Word n-grams that pushed the demo model towards ``label`` the most (coef x tf-idf)."""
        if not self.is_demo or label not in self.classes:
            return []
        word_vectorizer = self.model.named_steps["features"].transformer_list[0][1].named_steps["tfidf"]
        if self._word_vocab is None:
            self._word_vocab = word_vectorizer.get_feature_names_out()
        row = word_vectorizer.transform([prep["normalized"]])
        if row.nnz == 0:
            return []
        coef = self.model.named_steps["clf"].coef_[self.classes.index(label), : len(self._word_vocab)]
        contributions = row.data * coef[row.indices]
        order = np.argsort(-contributions)
        return [str(self._word_vocab[row.indices[i]]) for i in order[:k] if contributions[i] > 0]


def _fingerprint(mode):
    import sklearn

    parts = [CLASSIFIER_VERSION, mode, file_sha256(COMPLAINT_CORPUS), preprocessing_fingerprint(),
             sklearn.__version__, f"C={DEMO_C if mode == 'demo' else PRODUCTION_C}"]
    if mode == "production":
        parts.append(TEXT_EMBEDDING_MODEL)
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _atomic_dump(payload, path):
    import joblib

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.stem + ".", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    try:
        joblib.dump(payload, tmp, compress=3)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def load_or_train(mode, encoder=None, *, force=False):
    """Return ``(model, info)`` from the joblib cache, (re)training when missing / stale / unreadable."""
    import joblib

    path = model_dir() / (DEMO_FILE if mode == "demo" else PRODUCTION_FILE)
    fingerprint = _fingerprint(mode)
    if path.exists() and not force:
        try:
            payload = joblib.load(path)
            if payload.get("fingerprint") == fingerprint:
                return payload["model"], {k: v for k, v in payload.items() if k != "model"} | {"source": "cache"}
            logger.info("Cached %s text classifier is stale (corpus/preprocessing changed); retraining", mode)
        except Exception as exc:  # corrupt file, incompatible sklearn pickle ...
            logger.warning("Could not read %s (%s); retraining", path, exc)
    rows, preps = preprocessed_complaints()
    labels = [r["label"] for r in rows]
    started = time.perf_counter()
    model = train_demo(preps, labels) if mode == "demo" else train_production(preps, labels, encoder)
    info = {
        "fingerprint": fingerprint,
        "rows": len(rows),
        "classes": [str(c) for c in model.classes_],
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "train_seconds": round(time.perf_counter() - started, 2),
        "embedding_model": TEXT_EMBEDDING_MODEL if mode == "production" else None,
    }
    try:
        _atomic_dump({**info, "model": model}, path)
    except OSError as exc:  # read-only deployment: keep the in-memory model
        logger.warning("Could not cache text classifier at %s: %s", path, exc)
    logger.info("Trained %s text classifier on %d rows in %.2fs", mode, len(rows), info["train_seconds"])
    return model, info | {"source": "trained"}


def _load_demo():
    model, info = load_or_train("demo")
    return TextClassifier(mode="demo", model=model, version=MODEL_VERSION_DEMO, technique=DEMO_TECHNIQUE, info=info)


def _predict(classifier, prep):
    """Model probabilities ``{class: p}`` for one preprocessed document."""
    return {c: float(p) for c, p in zip(classifier.classes, classifier.predict_proba([prep])[0])}


class _Unavailable:
    def __init__(self, error):
        self.error = error


def _load_production():
    backend = backends.sentence_transformer()
    if not backend.ok:
        return _Unavailable(backend.error)
    try:
        model, info = load_or_train("production", backend.model)
    except Exception as exc:
        logger.warning("Production text classifier could not be trained: %s", exc)
        return _Unavailable(f"{type(exc).__name__}: {exc}"[:240])
    technique = f"Sentence-Transformer ({TEXT_EMBEDDING_MODEL.split('/')[-1]}) embeddings + logistic regression"
    return TextClassifier(mode="production", model=model, version=production_model_version(),
                          technique=technique, info=info, encoder=backend.model)


def get_classifier():
    """``(TextClassifier, fallback_reason)`` for the current ``MODEL_MODE`` (models cached per process)."""
    fallback_reason = None
    if get_model_mode() == "production":
        production = get_or_load("nlp.text_classifier.production", _load_production)
        if isinstance(production, TextClassifier):
            _report_status(production, None)
            return production, None
        fallback_reason = f"Production text model unavailable ({production.error})"
    demo = get_or_load("nlp.text_classifier.demo", _load_demo)
    _report_status(demo, fallback_reason)
    return demo, fallback_reason


def _report_status(classifier, fallback_reason):
    # The training corpus is generated from slot templates (ai/nlp/data/build_corpus.py): say so, and let the
    # hand-written challenge set (``_report_metrics``) carry the accuracy claim.
    detail = (f"Trained on {classifier.info.get('rows')} synthetic, template-generated complaints "
              f"({classifier.info.get('source')}).")
    if fallback_reason:
        detail = f"{fallback_reason}; using {DEMO_TECHNIQUE}. " + detail
    set_status(STATUS_NAME, task=STATUS_TASK, status="fallback" if fallback_reason else "active",
               version=classifier.version, framework=_framework(classifier.mode),
               is_demo=classifier.is_demo, detail=detail)


def _framework(mode):
    return "scikit-learn" if mode == "demo" else "sentence-transformers + scikit-learn"


# ---------------------------------------------------------------------------------------------
# Keyword blending
# ---------------------------------------------------------------------------------------------
def category_signature(categories):
    """Hashable summary ``((slug, name, (keywords...)), ...)`` of category dicts (bad entries skipped)."""
    signature = []
    for category in categories or []:
        if not isinstance(category, dict):
            continue
        slug = str(category.get("slug") or "").strip()
        if not slug:
            continue
        keywords = tuple(str(k).strip() for k in (category.get("keywords") or []) if str(k).strip())
        signature.append((slug, str(category.get("name") or "").strip(), keywords))
    return tuple(signature)


@lru_cache(maxsize=128)
def _keyword_index(signature, trained):
    """Per category: keyword phrases as (original, lemma tuple, raw token tuple), longest first."""
    index = []
    for slug, name, keywords in signature:
        sources = list(keywords)
        if slug not in trained:  # no trained signal: the name and slug words are evidence too
            sources += [part for part in re.split(r"[/,&]|\band\b", name) if part.strip()]
            sources.append(slug.replace("_", " ").replace("-", " "))
        phrases, seen = [], set()
        for source in sources:
            lemmas = normalize_phrase(source)
            raw = tuple(tokenize(normalize_text(source)))
            if not lemmas or lemmas in seen:
                continue
            seen.add(lemmas)
            phrases.append((source, lemmas, raw))
        phrases.sort(key=lambda p: -len(p[1]))
        index.append((slug, tuple(phrases)))
    return tuple(index)


def _find_span(sequence, phrase, covered):
    size = len(phrase)
    for start in range(len(sequence) - size + 1):
        if tuple(sequence[start:start + size]) == phrase and covered.isdisjoint(range(start, start + size)):
            return range(start, start + size)
    return None


def keyword_scores(prep, categories, trained=tuple(CIVIC_CLASSES)):
    """``{slug: (score 0-1, [matched keywords])}`` for categories whose keywords occur in the text."""
    signature = category_signature(categories)
    if not signature:
        return {}
    lemmas, raw = prep["lemmas"], prep["clean"].split()
    scores = {}
    for slug, phrases in _keyword_index(signature, tuple(trained)):
        covered_lemmas, covered_raw = set(), set()
        total, matched = 0.0, []
        for source, phrase_lemmas, phrase_raw in phrases:
            span = _find_span(lemmas, phrase_lemmas, covered_lemmas)
            if span is not None:
                covered_lemmas.update(span)
            else:
                span = _find_span(raw, phrase_raw, covered_raw) if phrase_raw else None
                if span is None:
                    continue
                covered_raw.update(span)
            total += PHRASE_WEIGHT if len(phrase_lemmas) > 1 else WORD_WEIGHT
            matched.append(source)
        if matched:
            scores[slug] = (1.0 - math.exp(-total), matched)
    return scores


def blend_keyword_scores(model_probs, keyword_hits, extra_slugs=()):
    """Blend model probabilities with keyword scores (see module docstring) and renormalise."""
    scores = {slug: float(p) for slug, p in model_probs.items()}
    unknown = {slug: k for slug, (k, _) in keyword_hits.items() if slug not in model_probs}
    for slug, (k, _) in keyword_hits.items():
        if slug in model_probs:
            scores[slug] += KEYWORD_BOOST * k
    if unknown:
        p_other = float(model_probs.get("other", 0.0))
        transfer = p_other * max(unknown.values())
        total_k = sum(unknown.values())
        if "other" in scores:
            scores["other"] -= transfer
        for slug, k in unknown.items():
            scores[slug] = KEYWORD_BOOST * k + transfer * k / total_k
    for slug in extra_slugs:
        scores.setdefault(slug, 0.0)
    total = sum(max(v, 0.0) for v in scores.values())
    if total <= 0:
        return {slug: 1.0 / len(scores) for slug in scores}
    return {slug: max(v, 0.0) / total for slug, v in scores.items()}


def category_label(slug, categories=None):
    """Human label for a slug: built-in class label, else the admin category's name."""
    if slug in CLASS_LABELS:
        return CLASS_LABELS[slug]
    for s, name, _ in category_signature(categories):
        if s == slug and name:
            return name
    return slug.replace("_", " ").title()


# ---------------------------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------------------------
def classify(prep, *, categories=None):
    """Classify a preprocessed complaint.

    Returns ``{"category", "confidence", "probabilities", "model_probabilities", "keyword_matches",
    "keyword_decided", "evidence_terms", "model_version", "technique", "mode", "is_demo",
    "fallback_reason"}``; probabilities are rounded to 4 decimals and sorted (highest first).
    """
    classifier, fallback_reason = get_classifier()
    provided = [slug for slug, _, _ in category_signature(categories)]
    if not prep["normalized"] and not prep["tokens"]:
        model_probs = {c: 1.0 / len(classifier.classes) for c in classifier.classes}
    else:
        try:
            model_probs = _predict(classifier, prep)
        except Exception as exc:  # production inference error: degrade to the demo model, never crash
            if classifier.is_demo:
                raise
            logger.warning("Production text classifier inference failed, using the demo model: %s", exc)
            fallback_reason = f"Production text model inference failed ({type(exc).__name__})"
            classifier = get_or_load("nlp.text_classifier.demo", _load_demo)
            _report_status(classifier, fallback_reason)
            model_probs = _predict(classifier, prep)
    hits = keyword_scores(prep, categories, tuple(classifier.classes))
    probs = blend_keyword_scores(model_probs, hits, provided)
    # Ties (e.g. the uniform distribution of an empty text) resolve to the catch-all "other".
    ranked = sorted(probs.items(), key=lambda kv: (-kv[1], kv[0] != "other", kv[0]))
    category, confidence = ranked[0]
    model_top = max(model_probs, key=model_probs.get)
    return {
        "category": category,
        "confidence": round(confidence, 4),
        "probabilities": {slug: round(p, 4) for slug, p in ranked},
        "model_probabilities": {slug: round(p, 4) for slug, p in sorted(model_probs.items(), key=lambda kv: -kv[1])},
        "keyword_matches": {slug: matched for slug, (_, matched) in hits.items()},
        "keyword_decided": category != model_top,
        "evidence_terms": classifier.evidence_terms(prep, category) if category in classifier.classes else [],
        "model_version": classifier.version,
        "technique": classifier.technique,
        "mode": get_model_mode(),
        "is_demo": classifier.is_demo,
        "fallback_reason": fallback_reason,
    }


def _registry_status(name, mode):
    """The registry status for ``name`` if it was recorded under the current mode, else None."""
    for status in get_statuses():
        if status["name"] != name:
            continue
        if mode == "demo" and status["status"] == "active" and status["is_demo"]:
            return status
        if mode == "production" and (status["status"] == "fallback" or not status["is_demo"]):
            return status
    return None


def _report_metrics(mode):
    """Accuracy sentence from ``report_<mode>.json`` (written by scripts/train_text_classifier.py).

    The honest number leads: accuracy on the hand-written challenge complaints, whose wording is independent of
    the templates. The template hold-out split comes from the same generator as the training rows, so its score
    (often 100%) is reported only in brackets as "in-distribution".
    """
    import json

    path = model_dir() / f"report_{mode}.json"
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        holdout = f"in-distribution template hold-out {report['accuracy']:.1%}"
        challenge = report.get("challenge") or {}
        if "accuracy" not in challenge:
            return f" Accuracy: {holdout} ({path.name}); not yet measured on hand-written complaints."
        size = int(sum(item.get("support", 0) for item in (challenge.get("per_class") or {}).values()))
        sample = f"{size} hand-written challenge complaints" if size else "the hand-written challenge complaints"
        return (f" Accuracy on {sample} {challenge['accuracy']:.1%} (macro-F1 {challenge['macro_f1']:.3f}); "
                f"{holdout} ({path.name}).")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return ""


def describe():
    """Model-info entry for the text classifier (real runtime status, no model loading)."""
    mode = get_model_mode()
    status = _registry_status(STATUS_NAME, mode)
    if status:
        return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": status["framework"],
                "version": status["version"], "status": status["status"], "is_demo": status["is_demo"],
                "detail": status["detail"] + _report_metrics("demo" if status["is_demo"] else "production")}
    if mode == "production":
        if not backends.is_installed("sentence_transformers"):
            return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": _framework("production"),
                    "version": production_model_version(), "status": "not_installed", "is_demo": True,
                    "detail": "sentence-transformers is not installed; the demo TF-IDF classifier will be used."}
        cached = "weights cached" if backends.is_cached(TEXT_EMBEDDING_MODEL) else "weights download on first use"
        return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": _framework("production"),
                "version": production_model_version(), "status": "available", "is_demo": False,
                "detail": f"{PRODUCTION_TECHNIQUE} ({TEXT_EMBEDDING_MODEL}); loads on first use, {cached}."
                + _report_metrics("production")}
    cached = (model_dir() / DEMO_FILE).exists()
    return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": _framework("demo"),
            "version": MODEL_VERSION_DEMO, "status": "available", "is_demo": True,
            "detail": f"{DEMO_TECHNIQUE} on {COMPLAINT_CORPUS.name}; "
                      + ("cached model present." if cached else "trains automatically on first use.")
                      + _report_metrics("demo")}
