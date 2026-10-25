"""Keyword / keyphrase extraction from complaint text.

Candidate generation (both modes, RAKE-style)
    The lemma sequence from ``text_preprocessor`` is split into runs of content words at stopwords,
    negations, numbers and generic words ("near", "problem", "please" ...). Every 1-3 word n-gram
    inside a run is a candidate, in canonical form (lemmatised, synonyms normalised, so "potholes"
    and "gaddha" both yield "pothole").

Demo ranking: **TF-IDF + domain dictionary + position**
    score = (1 + ln tf) * sqrt(idf) * (1 + 3 * domain) * position * length_factor
    * idf comes from the complaint corpus (smoothed: ln((1 + N) / (1 + df)) + 1; a phrase uses the
      mean idf of its words). The square root damps idf: in a category-balanced corpus the
      category words themselves ("pothole") are frequent, and undamped idf would rank any rare
      word above them;
    * domain is the civic dictionary weight (1.0 category vocabulary such as pothole / garbage /
      manhole, 0.8 hazards and sensitive places such as school / accident / traffic, ...);
    * position favours words mentioned early (+25% for the first word, decaying linearly);
    * length_factor: known domain phrases ("open manhole", "live wire") 1.15, other phrases made
      only of non-dictionary words (place names such as "sai nagar") 1.1. A phrase that merely
      wraps a dictionary word ("school entrance") is not a candidate - the word itself is.
    Selection is greedy with redundancy removal: a candidate that contains, or is contained in,
    an already selected keyword is skipped.

Production ranking: **KeyBERT-style embedding similarity with MMR diversity** (implemented here,
no keybert package): the document and every candidate are embedded with the sentence
transformer; relevance = 0.75 * cos(candidate, document) + 0.25 * domain weight; keywords are
chosen by Maximal Marginal Relevance, ``MMR = 0.7 * relevance - 0.3 * max cos(candidate, selected)``,
which trades relevance against redundancy. Falls back to the demo ranking if the model is
unavailable.
"""
import logging
import math

import numpy as np

from ..common import get_or_load, set_status
from ..config import TEXT_EMBEDDING_MODEL, get_model_mode
from . import backends
from . import lexicons as lx
from .corpus import preprocessed_complaints
from .text_preprocessor import is_stopword, preprocess

logger = logging.getLogger("ai.nlp")

STATUS_NAME = "nlp.keywords"
STATUS_TASK = "Keyword extraction"
DEMO_VERSION = "demo-tfidf-keywords-1.0"
MAX_NGRAM = 3
MMR_LAMBDA = 0.7
_BREAKERS = lx.NEGATIONS | lx.KEYWORD_EXCLUDE


def _is_breaker(token):
    return (token in _BREAKERS or is_stopword(token) or token.isdigit()
            or (token.isascii() and len(token) < 3) or not any(ch.isalpha() for ch in token))


def _allowed_phrase(words):
    phrase = " ".join(words)
    return phrase in lx.DOMAIN_PHRASES or all(lx.DOMAIN_TERMS.get(w, 0.0) < 0.6 for w in words)


def candidates(prep):
    """``{phrase: {"tf": int, "first": int, "n": int}}`` of 1-3 word candidates in canonical form."""
    lemmas = prep["lemmas"]
    found = {}
    run = []
    for position, token in enumerate(lemmas + ["."]):  # the trailing "." flushes the last run
        if position < len(lemmas) and not _is_breaker(token):
            run.append((position, token))
            continue
        for i in range(len(run)):
            for n in range(1, MAX_NGRAM + 1):
                if i + n > len(run):
                    break
                words = [t for _, t in run[i:i + n]]
                if len(set(words)) < len(words) or (n > 1 and not _allowed_phrase(words)):
                    continue
                phrase = " ".join(words)
                entry = found.setdefault(phrase, {"tf": 0, "first": run[i][0], "n": n})
                entry["tf"] += 1
        run = []
    return found


def _idf_table():
    """Smoothed idf of every word in the complaint corpus (computed once per process)."""

    def _load():
        _, preps = preprocessed_complaints()
        df = {}
        for prep in preps:
            for word in set(prep["normalized"].split()):
                df[word] = df.get(word, 0) + 1
        n_docs = len(preps)
        table = {word: math.log((1 + n_docs) / (1 + count)) + 1.0 for word, count in df.items()}
        return table, math.log(1 + n_docs) + 1.0

    return get_or_load("nlp.keywords.idf", _load)


def domain_weight(phrase):
    """Civic dictionary weight of a candidate in [0, 1]."""
    if phrase in lx.DOMAIN_PHRASES:
        return lx.DOMAIN_PHRASES[phrase]
    words = phrase.split()
    if len(words) == 1:
        return lx.DOMAIN_TERMS.get(phrase, 0.0)
    return 0.6 * max(lx.DOMAIN_TERMS.get(w, 0.0) for w in words)


def _redundant(phrase, selected):
    words = set(phrase.split())
    for chosen in selected:
        other = set(chosen.split())
        if words <= other or other <= words:
            return True
    return False


def _rank_demo(cands, length):
    idf, max_idf = _idf_table()
    scored = []
    for phrase, info in cands.items():
        words = phrase.split()
        phrase_idf = sum(idf.get(w, max_idf) for w in words) / len(words)
        position = 1.0 + 0.25 * (1.0 - info["first"] / max(1, length))
        if info["n"] == 1:
            length_factor = 1.0
        else:
            length_factor = 1.15 if phrase in lx.DOMAIN_PHRASES else 1.1
        score = ((1.0 + math.log(info["tf"])) * math.sqrt(phrase_idf) * (1.0 + 3.0 * domain_weight(phrase))
                 * position * length_factor)
        scored.append((score, info["first"], phrase))
    scored.sort(key=lambda s: (-s[0], s[1], s[2]))
    return [phrase for _, _, phrase in scored]


def _select(ranked, top_k):
    selected = []
    for phrase in ranked:
        if len(selected) >= top_k:
            break
        if not _redundant(phrase, selected):
            selected.append(phrase)
    return selected


def _rank_mmr(prep, cands, model, top_k):
    """KeyBERT-style ranking: cosine(candidate, document) blended with domain weight, then MMR."""
    phrases = sorted(cands, key=lambda p: (cands[p]["first"], p))
    vectors = model.encode([prep["canonical"] or prep["clean"]] + phrases, batch_size=64,
                           normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    doc, cand = vectors[0], vectors[1:]
    relevance = 0.75 * (cand @ doc) + 0.25 * np.array([domain_weight(p) for p in phrases])
    pairwise = cand @ cand.T
    selected = []
    remaining = list(range(len(phrases)))
    while remaining and len(selected) < top_k:
        if selected:
            redundancy = pairwise[np.ix_(remaining, selected)].max(axis=1)
        else:
            redundancy = np.zeros(len(remaining))
        mmr = MMR_LAMBDA * relevance[remaining] - (1.0 - MMR_LAMBDA) * redundancy
        best = remaining[int(np.argmax(mmr))]
        remaining.remove(best)
        if not _redundant(phrases[best], [phrases[i] for i in selected]):
            selected.append(best)
    return [phrases[i] for i in selected]


def extract_from_prep(prep, top_k=6):
    """Keywords for an already preprocessed text (used by ``ai.nlp.analyze_text``)."""
    if top_k <= 0:
        return []
    cands = candidates(prep)
    if not cands:
        return []
    if get_model_mode() == "production":
        backend = backends.sentence_transformer()
        if backend.ok:
            set_status(STATUS_NAME, task=STATUS_TASK, status="active", version=f"keybert-mmr-{backend.name}",
                       framework="sentence-transformers", is_demo=False,
                       detail="Embedding similarity ranking with Maximal Marginal Relevance diversity.")
            try:
                return _rank_mmr(prep, cands, backend.model, top_k)
            except Exception as exc:  # inference failure must never break complaint analysis
                logger.warning("Embedding keyword ranking failed, using TF-IDF ranking: %s", exc)
        set_status(STATUS_NAME, task=STATUS_TASK, status="fallback", version=DEMO_VERSION, framework="python",
                   is_demo=True, detail=f"Sentence embedder unavailable ({backend.error}); TF-IDF + domain ranking.")
    else:
        set_status(STATUS_NAME, task=STATUS_TASK, status="active", version=DEMO_VERSION, framework="python",
                   is_demo=True, detail="TF-IDF (corpus idf) + civic domain dictionary + position ranking.")
    return _select(_rank_demo(cands, len(prep["lemmas"])), top_k)


def extract_keywords(text, top_k=6):
    """Return up to ``top_k`` lowercase keywords/keyphrases, most important first."""
    return extract_from_prep(preprocess(text), top_k=top_k)


def describe():
    """Model-info entry for the keyword extractor (real runtime status, no model loading)."""
    from .classifier import _registry_status

    mode = get_model_mode()
    status = _registry_status(STATUS_NAME, mode)
    if status:
        return {k: status[k] for k in ("name", "task", "framework", "version", "status", "is_demo", "detail")}
    if mode == "production":
        installed = backends.is_installed("sentence_transformers")
        return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": "sentence-transformers",
                "version": f"keybert-mmr-{TEXT_EMBEDDING_MODEL}", "status": "available" if installed else "not_installed",
                "is_demo": not installed,
                "detail": "KeyBERT-style embedding ranking with MMR; loads with the sentence embedder."
                if installed else "sentence-transformers is not installed; TF-IDF keyword ranking will be used."}
    return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": "python", "version": DEMO_VERSION,
            "status": "available", "is_demo": True,
            "detail": "TF-IDF (corpus idf) + civic domain dictionary + position ranking."}
