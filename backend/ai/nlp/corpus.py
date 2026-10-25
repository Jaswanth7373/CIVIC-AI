"""Bundled NLP corpora: loading, fingerprinting and cached preprocessing.

The complaint corpus trains the text classifier, fits the demo embedder and provides the document
frequencies used by the keyword extractor. The hand-written complaint challenge set, the feedback
corpus and the held-out feedback challenge set are evaluation-only (classifier generalisation and
sentiment accuracy). All of them are produced by ``ai/nlp/data/build_corpus.py`` and committed.
"""
import csv
import hashlib
from pathlib import Path

from ..common import get_or_load

DATA_DIR = Path(__file__).resolve().parent / "data"
COMPLAINT_CORPUS = DATA_DIR / "complaint_corpus.csv"
FEEDBACK_CORPUS = DATA_DIR / "feedback_corpus.csv"
CHALLENGE_CORPUS = DATA_DIR / "complaint_challenge.csv"
FEEDBACK_CHALLENGE_CORPUS = DATA_DIR / "feedback_challenge.csv"
_SOURCE_DIR = Path(__file__).resolve().parent


def file_sha256(path):
    """SHA-256 hex digest of a file's bytes."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def preprocessing_fingerprint():
    """Hash of the code + vocabularies that turn raw text into model features.

    Cached models store this value; when the lexicons or the preprocessor change, the stored
    fingerprint no longer matches and the model is retrained instead of silently using features
    computed by an older preprocessing pipeline.
    """
    digest = hashlib.sha256()
    for name in ("lexicons.py", "text_preprocessor.py"):
        digest.update((_SOURCE_DIR / name).read_bytes())
    return digest.hexdigest()


def _read_csv(path, required):
    with open(path, encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in required if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{Path(path).name} is missing columns: {', '.join(missing)}")
        return [{k: (row.get(k) or "").strip() for k in required} for row in reader if (row.get("text") or "").strip()]


def load_complaints(path=COMPLAINT_CORPUS):
    """Rows ``{"text", "label", "severity"}`` of the labelled complaint corpus."""
    return _read_csv(path, ("text", "label", "severity"))


def load_feedback(path=FEEDBACK_CORPUS):
    """Rows ``{"text", "label"}`` of the labelled feedback corpus."""
    return _read_csv(path, ("text", "label"))


def load_challenge(path=CHALLENGE_CORPUS):
    """Rows ``{"text", "label"}`` of the hand-written challenge set (evaluation only, never trained on)."""
    return _read_csv(path, ("text", "label"))


def load_feedback_challenge(path=FEEDBACK_CHALLENGE_CORPUS):
    """Rows ``{"text", "label"}`` of the held-out feedback set (evaluation only, never tuned on)."""
    return _read_csv(path, ("text", "label"))


def preprocessed_complaints():
    """``(rows, preps)`` for the complaint corpus, preprocessed once per process and corpus version."""
    from .text_preprocessor import preprocess

    key = f"nlp.corpus.preprocessed::{file_sha256(COMPLAINT_CORPUS)[:16]}::{preprocessing_fingerprint()[:16]}"

    def _load():
        rows = load_complaints()
        return rows, [preprocess(r["text"]) for r in rows]

    return get_or_load(key, _load)
