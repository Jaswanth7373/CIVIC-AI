"""Text similarity for duplicate detection (BUILD_SPEC section 2.6).

Technique - embedding cosine similarity. Both complaint descriptions are turned into vectors by
the engine's text embedder (``ai.nlp.embedding.get_text_embedder()``: TF-IDF word + character
n-grams with synonym normalisation in demo mode, ``all-MiniLM-L6-v2`` sentence embeddings in
production). The rows are L2-normalised, so the cosine similarity is simply the dot product:

    sim(a, b) = (a . b) / (|a| |b|)      clipped to [0, 1]

Sentence embeddings capture meaning ("Big road pothole outside school" ~ "Large pothole near the
school"), which is why duplicates are found even when citizens use different words. All texts are
encoded in one batch, so comparing a new complaint with N candidates costs one ``encode`` call.
"""
import numpy as np


def _clean(text):
    return " ".join(str(text).split()) if text else ""


def batch_text_similarity(query, texts):
    """Similarity in [0, 1] between ``query`` and every text in ``texts`` (same order).

    Empty texts score 0.0. Errors from the embedder propagate to the caller.
    """
    texts = list(texts)
    scores = [0.0] * len(texts)
    query = _clean(query)
    indices = [i for i, text in enumerate(texts) if _clean(text)]
    if not query or not indices:
        return scores

    from ..nlp.embedding import get_text_embedder

    vectors = get_text_embedder().encode([query] + [_clean(texts[i]) for i in indices])
    if hasattr(vectors, "toarray"):  # tolerate sparse matrices
        vectors = vectors.toarray()
    vectors = np.asarray(vectors, dtype=float)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0  # an all-zero vector (no known words) has similarity 0 to everything
    vectors = vectors / norms
    cosines = vectors[1:] @ vectors[0]
    for position, index in enumerate(indices):
        value = float(cosines[position])
        scores[index] = round(min(1.0, max(0.0, value)), 4) if np.isfinite(value) else 0.0
    return scores


def text_similarity(a, b):
    """Similarity in [0, 1] of two complaint texts (0.0 when either is empty)."""
    return batch_text_similarity(a, [b])[0]
