"""Sentence embeddings for complaint text (used by duplicate detection and keyword ranking).

``get_text_embedder()`` returns the process-wide embedder for the current ``MODEL_MODE``. Every
embedder exposes the same interface (CONTRACT):

    .encode(texts: list[str]) -> numpy.ndarray   rows are L2-normalised (all-zero for empty text)
    .similarity(a: str, b: str) -> float in [0, 1]
    .batch_similarity(query: str, texts: list[str]) -> list[float]   (convenience)
    .name: str, .is_demo: bool   (+ .version, .dimension, .fallback_reason)

Demo technique: **TF-IDF vector-space embedding**
    Texts are preprocessed (lemmas + synonym normalisation: big -> large, outside -> near,
    road hole -> pothole, gaddha -> pothole ...) and mapped into two TF-IDF spaces fitted on the
    bundled complaint corpus: word unigrams + bigrams and character 3-5 grams (``char_wb``). Each
    block is L2-normalised and weighted (word 0.6, char 0.4 of the squared norm), concatenated and
    L2-normalised again, so the cosine similarity of two texts is
    ``0.6 * cos_word + 0.4 * cos_char``. Character n-grams tolerate typos; idf down-weights words
    every complaint uses. Measured: "Large pothole near school." vs "Big road pothole outside
    school." -> 0.86, while "Garbage not collected for a week" vs "Streetlight not working at
    night" -> 0.09.

Production technique: **sentence-transformers/all-MiniLM-L6-v2** (384-d, mean pooling,
normalised) on the canonical text; similarity is the cosine clipped to [0, 1] (same pairs: 0.97
and 0.16). If the model cannot be loaded the demo embedder is returned with ``fallback_reason``
set; an inference error inside ``similarity`` / ``batch_similarity`` is answered by the demo
embedder as well.
"""
import logging

import numpy as np

from ..common import get_or_load, set_status
from ..config import TEXT_EMBEDDING_MODEL, get_model_mode
from . import backends
from .corpus import preprocessed_complaints
from .text_preprocessor import preprocess

logger = logging.getLogger("ai.nlp")

DEMO_NAME = "demo-tfidf-embedder"
DEMO_VERSION = "demo-tfidf-embedder-1.0"
STATUS_NAME = "nlp.embedder"
STATUS_TASK = "Text embeddings (duplicate detection)"
WORD_WEIGHT = 0.6
CHAR_WEIGHT = 0.4


def _split(text):
    return text.split()


class TfidfEmbedder:
    """Demo embedder: weighted word + character TF-IDF spaces fitted on the complaint corpus."""

    is_demo = True
    name = DEMO_NAME
    version = DEMO_VERSION

    def __init__(self, corpus_texts, fallback_reason=None):
        from sklearn.feature_extraction.text import TfidfVectorizer

        self.fallback_reason = fallback_reason
        self._word = TfidfVectorizer(tokenizer=_split, token_pattern=None, lowercase=False,
                                     ngram_range=(1, 2), sublinear_tf=True, max_features=6000)
        self._char = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), lowercase=False,
                                     sublinear_tf=True, min_df=2, max_features=12000)
        self._word.fit(corpus_texts)
        self._char.fit(corpus_texts)
        self.dimension = len(self._word.vocabulary_) + len(self._char.vocabulary_)

    @staticmethod
    def _normalized(texts):
        return [preprocess(t)["normalized"] for t in texts]

    def _encode_normalized(self, normalized):
        from scipy.sparse import hstack
        from sklearn.preprocessing import normalize

        word = normalize(self._word.transform(normalized)) * np.sqrt(WORD_WEIGHT)
        char = normalize(self._char.transform(normalized)) * np.sqrt(CHAR_WEIGHT)
        return normalize(hstack([word, char]).tocsr())

    def encode(self, texts):
        """Dense float32 matrix (n, dimension); each non-empty row has unit L2 norm."""
        texts = list(texts)
        if not texts:
            return np.zeros((0, self.dimension), dtype=np.float32)
        return self._encode_normalized(self._normalized(texts)).toarray().astype(np.float32)

    def similarity(self, a, b):
        """Cosine similarity in [0, 1] (TF-IDF weights are non-negative)."""
        na, nb = self._normalized([a, b])
        if na and na == nb:
            return 1.0
        m = self._encode_normalized([na, nb])
        return float(np.clip(m[0].multiply(m[1]).sum(), 0.0, 1.0))

    def batch_similarity(self, query, texts):
        """Similarities of ``query`` against each of ``texts`` (list of floats in [0, 1])."""
        texts = list(texts)
        if not texts:
            return []
        normalized = self._normalized([query] + texts)
        m = self._encode_normalized(normalized)
        sims = np.asarray((m[1:] @ m[0].T).todense()).ravel()
        return [1.0 if normalized[0] and normalized[0] == n else float(np.clip(s, 0.0, 1.0))
                for n, s in zip(normalized[1:], sims)]


class SentenceEmbedder:
    """Production embedder: SentenceTransformer sentence embeddings (cosine similarity)."""

    is_demo = False
    fallback_reason = None

    def __init__(self, model, name):
        self._model = model
        self.name = name
        self.version = name
        getter = getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension
        self.dimension = int(getter())

    def encode(self, texts):
        texts = [preprocess(t)["canonical"] or " " for t in texts]
        if not texts:
            return np.zeros((0, self.dimension), dtype=np.float32)
        return self._model.encode(texts, batch_size=32, normalize_embeddings=True, convert_to_numpy=True,
                                  show_progress_bar=False).astype(np.float32)

    def similarity(self, a, b):
        try:
            m = self.encode([a, b])
        except Exception as exc:  # inference error: answer with the demo technique, never crash
            logger.warning("Sentence embedding failed, using TF-IDF similarity: %s", exc)
            return _demo_embedder(f"Production embedder inference failed ({type(exc).__name__})").similarity(a, b)
        return float(np.clip(m[0] @ m[1], 0.0, 1.0))

    def batch_similarity(self, query, texts):
        texts = list(texts)
        if not texts:
            return []
        try:
            m = self.encode([query] + texts)
        except Exception as exc:
            logger.warning("Sentence embedding failed, using TF-IDF similarity: %s", exc)
            reason = f"Production embedder inference failed ({type(exc).__name__})"
            return _demo_embedder(reason).batch_similarity(query, texts)
        return [float(v) for v in np.clip(m[1:] @ m[0], 0.0, 1.0)]


def _demo_embedder(fallback_reason=None):
    def _load():
        _, preps = preprocessed_complaints()
        return TfidfEmbedder([p["normalized"] for p in preps], fallback_reason=fallback_reason)

    return get_or_load("nlp.embedder.demo" + ("::fallback" if fallback_reason else ""), _load)


def get_text_embedder():
    """Return the process-wide embedder for the current mode (see module docstring)."""
    if get_model_mode() == "production":
        backend = backends.sentence_transformer()
        if backend.ok:
            embedder = get_or_load(f"nlp.embedder.production::{backend.name}",
                                   lambda: SentenceEmbedder(backend.model, backend.name))
            set_status(STATUS_NAME, task=STATUS_TASK, status="active", version=embedder.version,
                       framework="sentence-transformers", is_demo=False,
                       detail=f"{embedder.dimension}-d sentence embeddings, cosine similarity.")
            return embedder
        reason = f"Production embedder unavailable ({backend.error})"
        embedder = _demo_embedder(reason)
        set_status(STATUS_NAME, task=STATUS_TASK, status="fallback", version=DEMO_VERSION,
                   framework="scikit-learn", is_demo=True, detail=f"{reason}; using TF-IDF word + char embeddings.")
        return embedder
    embedder = _demo_embedder()
    set_status(STATUS_NAME, task=STATUS_TASK, status="active", version=DEMO_VERSION, framework="scikit-learn",
               is_demo=True, detail=f"TF-IDF word + char embeddings ({embedder.dimension} dims) fitted on the complaint corpus.")
    return embedder


def describe():
    """Model-info entry for the embedder (real runtime status, no model loading)."""
    from .classifier import _registry_status

    mode = get_model_mode()
    status = _registry_status(STATUS_NAME, mode)
    if status:
        return {k: status[k] for k in ("name", "task", "framework", "version", "status", "is_demo", "detail")}
    if mode == "production":
        installed = backends.is_installed("sentence_transformers")
        return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": "sentence-transformers",
                "version": TEXT_EMBEDDING_MODEL, "status": "available" if installed else "not_installed",
                "is_demo": not installed,
                "detail": ("Loads on first use; " + ("weights cached." if backends.is_cached(TEXT_EMBEDDING_MODEL)
                                                     else "weights download on first use."))
                if installed else "sentence-transformers is not installed; TF-IDF embeddings will be used."}
    return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": "scikit-learn", "version": DEMO_VERSION,
            "status": "available", "is_demo": True,
            "detail": "TF-IDF word + char embeddings; fitted on the complaint corpus on first use."}
