"""Citizen feedback sentiment analysis (positive / neutral / negative).

Demo technique (``MODEL_MODE=demo``): **VADER-style lexicon scoring**, implemented here.
    The feedback is preprocessed (synonyms, Hinglish / Telugu normalisation, clause boundaries),
    then every sentiment-bearing unit contributes a valence (``sentiment_lexicon``):

    1. civic *phrases* first, longest match ("resolved quickly" +2.8, "still not fixed" -2.8,
       "no action" -2.5, "waste of time" -2.8);
    2. single *words* (English + Hinglish / Telugu: "accha", "bekar", "baagundi" ...);
    3. *boosters / dampeners* in the three preceding words add / subtract 0.293 (decaying with
       distance), an ALL-CAPS word in mixed-case text adds 0.733 in its direction;
    4. *negation*: a negator ("not", "no", "never", "without", "nahi" / "ledu" -> not) in the three
       preceding words of the same clause multiplies the valence of a word or phrase by -0.74
       ("not a waste of time" turns positive); negated service verbs ("did not even inspect",
       "nobody responded", "closed without fixing") score -1.6;
    5. *persistence*: "still" followed by a problem state ("still leaking", "still open") -1.8;
    6. *contrast*: words before the last "but" / "however" / "lekin" / "kaani" count 0.5x, words
       after it 1.5x; a concessive clause ("although it was late, ...") counts 0.5x;
    7. emoji valences are added; each "!" (max 4) adds 0.292 in the direction of the sum.

    The sum ``s`` is squashed with VADER's normalisation ``s / sqrt(s^2 + 15)`` into a compound
    score in [-1, 1]; |compound| < 0.2 is neutral (a wider band than VADER's 0.05 because civic
    feedback is often a factual status update).

Production technique (``MODEL_MODE=production``): **cardiffnlp/twitter-roberta-base-sentiment-latest**
    via a lazily loaded ``transformers`` text-classification pipeline (weights in HF_CACHE_DIR);
    score = p(positive) - p(negative), confidence = top probability. Code-mixed text is passed in
    its English-normalised form. Falls back to the lexicon with ``fallback_reason`` on failure.

Star rating (1-5, optional)
    * empty text -> rating only (1-2 negative, 3 neutral, 4-5 positive);
    * neutral text -> the rating tips the label (score = 0.6 * text + 0.4 * rating);
    * text and rating agree -> score = 0.8 * text + 0.2 * rating, confidence rises;
    * text and rating strongly conflict (positive vs negative) -> the text label is kept (citizens
      mis-tap stars more often than they mis-write sentences), confidence is lowered and the
      explanation says so.
"""
import logging
import math
import re

from ..common import set_status
from ..config import SENTIMENT_MODEL, get_model_mode
from . import backends
from . import sentiment_lexicon as sl
from .text_preprocessor import is_stopword, preprocess

logger = logging.getLogger("ai.nlp")

DEMO_VERSION = "demo-lexicon-sentiment-1.0"
RATING_ONLY_VERSION = "rating-only-1.0"
DEMO_TECHNIQUE = "lexicon-based sentiment (VADER-style valence with negation, intensifiers, but-clauses and civic phrases)"
STATUS_NAME = "nlp.sentiment"
STATUS_TASK = "Feedback sentiment analysis"
NEUTRAL_THRESHOLD = 0.2
NEGATION_SCALAR = -0.74
NEGATION_WINDOW = 3
CONTRAST_BEFORE, CONTRAST_AFTER = 0.5, 1.5
CONCESSIVE_SCALE = 0.5
CAPS_BOOST = 0.733
EXCLAMATION_BOOST = 0.292
ALPHA = 15.0
_SHOUT_RE = re.compile(r"\b[A-Z]{2,}\b")
_PHRASES = sorted(((tuple(p.split()), v, p) for p, v in sl.PHRASE_VALENCE.items()), key=lambda x: -len(x[0]))
_MAX_PHRASE = max(len(p[0]) for p in _PHRASES)
_PHRASE_INDEX = {p[0]: (p[1], p[2]) for p in _PHRASES}


def label_from_score(score):
    if score >= NEUTRAL_THRESHOLD:
        return "positive"
    if score <= -NEUTRAL_THRESHOLD:
        return "negative"
    return "neutral"


def _normalize_rating(rating):
    if rating is None or rating == "":
        return None
    try:
        value = int(round(float(rating)))
    except (TypeError, ValueError):
        return None
    return value if 1 <= value <= 5 else None


def rating_label(rating):
    return "negative" if rating <= 2 else ("neutral" if rating == 3 else "positive")


# ---------------------------------------------------------------------------------------------
# Lexicon scoring
# ---------------------------------------------------------------------------------------------
class _Scorer:
    """One pass of the VADER-style algorithm over a preprocessed feedback text."""

    def __init__(self, text, prep):
        self.text = text or ""
        self.tokens = prep["canonical_tokens"]
        self.lemmas = prep["lemmas"]
        self.raw = prep["clean"].split()
        self.sources = prep["sources"]
        self.clause_starts = set(prep["clause_starts"])
        shouted = {w.lower() for w in _SHOUT_RE.findall(self.text)}
        self.shouted = shouted if not self.text.isupper() else set()
        self.values = [0.0] * len(self.tokens)
        self.consumed = [False] * len(self.tokens)
        self.evidence = []

    def _clause_start(self, i):
        start = i
        while start > 0 and start not in self.clause_starts:
            start -= 1
        return start

    def _preceding(self, i):
        """Up to NEGATION_WINDOW preceding token indices in the same clause, nearest first."""
        lower = max(self._clause_start(i), i - NEGATION_WINDOW)
        out = []
        for j in range(i - 1, lower - 1, -1):
            if self.tokens[j] in sl.CONTRAST:
                break
            out.append(j)
        return out

    def _negated(self, i):
        return any(self.tokens[j] in sl.NEGATORS for j in self._preceding(i))

    def _boost(self, i, valence):
        for distance, j in enumerate(self._preceding(i)):
            scalar = sl.BOOSTERS.get(self.tokens[j])
            if scalar:
                scalar *= (1.0, 0.95, 0.9)[distance]
                valence += scalar if valence > 0 else -scalar
        if self.raw[self.sources[i]] in self.shouted:
            valence += CAPS_BOOST if valence > 0 else -CAPS_BOOST
        return valence

    def _phrases(self):
        n = len(self.tokens)
        i = 0
        while i < n:
            for size in range(min(_MAX_PHRASE, n - i), 1, -1):
                if any(k in self.clause_starts for k in range(i + 1, i + size)):
                    continue
                hit = _PHRASE_INDEX.get(tuple(self.tokens[i:i + size]))
                if hit:
                    valence, display = hit
                    valence = self._boost(i, valence)
                    # "not a waste of time": a negator before a phrase flips it, unless the phrase
                    # carries its own negation ("not fixed", "no action").
                    if self.tokens[i] not in sl.NEGATORS and self._negated(i):
                        valence *= NEGATION_SCALAR
                        display = f"not {display}"
                    self.values[i] = valence
                    for k in range(i, i + size):
                        self.consumed[k] = True
                    self.evidence.append((display, self.values[i]))
                    i += size - 1
                    break
            i += 1

    def _words(self):
        seen_sources = set()
        for i, token in enumerate(self.tokens):
            if self.consumed[i] or token in sl.NEGATORS or token in sl.BOOSTERS:
                continue
            source = self.sources[i]
            raw = self.raw[source]
            if raw in sl.WORD_VALENCE and raw != token and source not in seen_sources:
                valence, display = sl.WORD_VALENCE[raw], raw
                seen_sources.add(source)
            elif token in sl.WORD_VALENCE:
                valence, display = sl.WORD_VALENCE[token], token
            elif self.lemmas[i] in sl.WORD_VALENCE:
                valence, display = sl.WORD_VALENCE[self.lemmas[i]], self.lemmas[i]
            else:
                valence, display = None, token
            negated = self._negated(i)
            if negated and token in sl.SERVICE_ACTIONS:
                self.values[i] = sl.NEGATED_ACTION_VALENCE
                self.evidence.append((f"not {display}", self.values[i]))
                continue
            if valence is None:
                continue
            valence = self._boost(i, valence)
            if negated:
                valence *= NEGATION_SCALAR
                display = f"not {display}"
            self.values[i] = valence
            self.evidence.append((display, valence))

    def _persistence(self):
        for i, token in enumerate(self.tokens):
            if token != "still" or self.consumed[i]:
                continue
            for j in range(i + 1, min(len(self.tokens), i + 4)):
                if j in self.clause_starts:
                    break
                if self.tokens[j] in sl.PROBLEM_STATES:
                    self.values[i] += sl.PERSISTENCE_VALENCE
                    self.evidence.append((f"still {self.tokens[j]}", sl.PERSISTENCE_VALENCE))
                    break

    def _contrast(self):
        contrast = [i for i, t in enumerate(self.tokens) if t in sl.CONTRAST]
        if contrast:
            pivot = contrast[-1]
            for i in range(len(self.values)):
                if i < pivot:
                    self.values[i] *= CONTRAST_BEFORE
                elif i > pivot:
                    self.values[i] *= CONTRAST_AFTER
        for k, token in enumerate(self.tokens):
            if token in sl.CONCESSIVE:
                j = k
                while j < len(self.values) and (j == k or j not in self.clause_starts):
                    self.values[j] *= CONCESSIVE_SCALE
                    j += 1

    def score(self):
        """``(compound, hits, evidence)``."""
        self._phrases()
        self._words()
        self._persistence()
        self._contrast()
        total = sum(self.values)
        hits = sum(1 for v in self.values if v)
        for char in self.text:
            valence = sl.EMOJI_VALENCE.get(char)
            if valence:
                total += valence
                hits += 1
                self.evidence.append((char, valence))
        if total:
            total += math.copysign(min(self.text.count("!"), 4) * EXCLAMATION_BOOST, total)
        compound = total / math.sqrt(total * total + ALPHA) if total else 0.0
        ordered = sorted(self.evidence, key=lambda e: -abs(e[1]))
        evidence = []
        for display, _ in ordered:
            if display not in evidence:
                evidence.append(display)
        return max(-1.0, min(1.0, compound)), hits, evidence[:5]


def lexicon_scores(text, prep=None):
    """Raw lexicon result ``(compound, hits, evidence)`` for ``text`` (used by evaluation)."""
    return _Scorer(text, prep or preprocess(text)).score()


def _lexicon_confidence(compound, hits):
    if abs(compound) >= NEUTRAL_THRESHOLD:
        strength = min(1.0, (abs(compound) - NEUTRAL_THRESHOLD) / 0.5)
        return (0.5 + 0.45 * strength) * (0.8 + 0.2 * min(1.0, hits / 2.0))
    if hits == 0:
        return 0.55
    return 0.5 + 0.3 * (1.0 - abs(compound) / NEUTRAL_THRESHOLD)


# ---------------------------------------------------------------------------------------------
# Transformer scoring
# ---------------------------------------------------------------------------------------------
def _english_view(text, prep):
    """Text for the English transformer: original if English, else translated canonical tokens."""
    if prep["language"] == "en":
        return text
    raw = prep["clean"].split()
    words, used = [], set()
    for token, source in zip(prep["canonical_tokens"], prep["sources"]):
        translated = sl.TRANSLATIONS.get(raw[source])
        if translated:
            if source not in used:
                words.append(translated)
                used.add(source)
            continue
        if not is_stopword(token) or token in sl.NEGATORS or len(token) > 3:
            words.append(token)
    return " ".join(words)


def _transformer_probabilities(text, prep):
    backend = backends.sentiment_pipeline()
    if not backend.ok:
        return None, f"Production sentiment model unavailable ({backend.error})"
    try:
        outputs = backend.model(_english_view(text, prep)[:2000], truncation=True)
    except Exception as exc:  # inference failure must not break feedback submission
        logger.warning("Sentiment inference failed: %s", exc)
        return None, f"Production sentiment inference failed ({type(exc).__name__})"
    scores = outputs[0] if outputs and isinstance(outputs[0], list) else outputs
    aliases = {"label_0": "negative", "label_1": "neutral", "label_2": "positive"}
    probabilities = {}
    for item in scores:
        label = str(item["label"]).lower()
        probabilities[aliases.get(label, label)] = float(item["score"])
    if not {"positive", "neutral", "negative"} <= set(probabilities):
        return None, f"Unexpected labels from {SENTIMENT_MODEL}: {sorted(probabilities)}"
    return probabilities, None


# ---------------------------------------------------------------------------------------------
# Rating fusion + public API
# ---------------------------------------------------------------------------------------------
def _combine_with_rating(label, score, confidence, rating):
    """Apply the rating rules from the module docstring -> (label, score, confidence, agreement, note)."""
    if rating is None:
        return label, score, confidence, "no_rating", ""
    r_label, r_score = rating_label(rating), (rating - 3) / 2.0
    stars = f"{rating}★"
    if label == "neutral":
        if r_label == "neutral":
            return label, score, confidence, "agree", f" The {stars} rating agrees."
        blended = 0.6 * score + 0.4 * r_score
        new_label = label_from_score(blended)
        return (new_label, blended, 0.5, "rating_decided",
                f" The text itself is neutral; the {stars} rating tipped the label to {new_label}.")
    if r_label == label:
        return (label, 0.8 * score + 0.2 * r_score, min(0.97, confidence + 0.08), "agree",
                f" The {stars} rating agrees.")
    if r_label == "neutral":
        return label, score, confidence * 0.9, "mild_conflict", f" The {stars} rating is neutral."
    return (label, score * 0.75, max(0.3, confidence * 0.6), "conflict",
            f" The {stars} rating contradicts the {label} text; the text label was kept with reduced confidence.")


def _result(label, score, confidence, *, method, version, is_demo, explanation, fallback_reason=None,
            evidence=None, probabilities=None, agreement="no_rating"):
    return {
        "label": label,
        "score": round(max(-1.0, min(1.0, score)), 4),
        "confidence": round(max(0.0, min(1.0, confidence)), 4),
        "model_version": version,
        "mode": get_model_mode(),
        "is_demo": is_demo,
        "method": method,
        "explanation": explanation,
        "fallback_reason": fallback_reason,
        "evidence": evidence or [],
        "probabilities": probabilities,
        "rating_agreement": agreement,
    }


def analyze_sentiment(text, rating=None):
    """Classify citizen feedback as positive / neutral / negative.

    Returns (CONTRACT):
        {"label": "positive", "score": 0.82, "confidence": 0.9,
         "model_version": "demo-lexicon-sentiment-1.0", "mode": "demo", "is_demo": True,
         "method": "lexicon" | "transformer" | "rating_only", "explanation": "..."}
    ``score`` is in [-1, 1]; empty text falls back to the rating (1-2 negative, 3 neutral, 4-5 positive).
    Extra keys: ``fallback_reason``, ``evidence`` (top phrases), ``probabilities`` (transformer only),
    ``rating_agreement`` (no_rating | agree | mild_conflict | conflict | rating_decided | rating_only).
    """
    text = "" if text is None else str(text)
    rating = _normalize_rating(rating)
    mode = get_model_mode()
    prep = preprocess(text)
    has_text = bool(prep["canonical_tokens"]) or any(ch in sl.EMOJI_VALENCE for ch in text)

    if not has_text:
        demo = mode == "demo"
        version = ("demo-" if demo else "") + RATING_ONLY_VERSION
        if rating is None:
            return _result("neutral", 0.0, 0.0, method="none", version=version, is_demo=demo,
                           explanation="No feedback text or rating was provided; sentiment defaults to neutral.")
        label = rating_label(rating)
        return _result(label, (rating - 3) / 2.0, {1: 0.75, 2: 0.6, 3: 0.55, 4: 0.6, 5: 0.75}[rating],
                       method="rating_only", version=version, is_demo=demo,
                       explanation=f"No feedback text was provided; sentiment was derived from the {rating}★ rating.",
                       agreement="rating_only")

    fallback_reason = None
    if mode == "production":
        probabilities, fallback_reason = _transformer_probabilities(text, prep)
        if probabilities is not None:
            score = probabilities["positive"] - probabilities["negative"]
            label = max(probabilities, key=probabilities.get)
            confidence = probabilities[label]
            label, score, confidence, agreement, note = _combine_with_rating(label, score, confidence, rating)
            set_status(STATUS_NAME, task=STATUS_TASK, status="active", version=SENTIMENT_MODEL,
                       framework="transformers", is_demo=False, detail="RoBERTa sentiment classifier (3 classes).")
            return _result(label, score, confidence, method="transformer", version=SENTIMENT_MODEL, is_demo=False,
                           explanation=(f"Transformer sentiment model ({SENTIMENT_MODEL}) rated the feedback "
                                        f"{label} ({confidence:.0%}).{note}"),
                           probabilities={k: round(v, 4) for k, v in probabilities.items()}, agreement=agreement)

    compound, hits, evidence = lexicon_scores(text, prep)
    label = label_from_score(compound)
    confidence = _lexicon_confidence(compound, hits)
    label, score, confidence, agreement, note = _combine_with_rating(label, compound, confidence, rating)
    phrases = f"key phrases: {', '.join(evidence[:3])}" if evidence else "no sentiment-bearing words found"
    explanation = f"Demo AI Mode: {DEMO_TECHNIQUE} rated the feedback {label} (score {score:+.2f}); {phrases}.{note}"
    if fallback_reason:
        explanation = f"{fallback_reason}; used the demo lexicon. " + explanation
        set_status(STATUS_NAME, task=STATUS_TASK, status="fallback", version=DEMO_VERSION, framework="python",
                   is_demo=True, detail=f"{fallback_reason}; using the demo lexicon.")
    else:
        set_status(STATUS_NAME, task=STATUS_TASK, status="active", version=DEMO_VERSION, framework="python",
                   is_demo=True, detail="VADER-style lexicon with negation, intensifiers and civic phrases.")
    return _result(label, score, confidence, method="lexicon", version=DEMO_VERSION, is_demo=True,
                   explanation=explanation, fallback_reason=fallback_reason, evidence=evidence, agreement=agreement)


def describe():
    """Model-info entry for the sentiment model (real runtime status, no model loading)."""
    from .classifier import _registry_status

    mode = get_model_mode()
    status = _registry_status(STATUS_NAME, mode)
    if status:
        return {k: status[k] for k in ("name", "task", "framework", "version", "status", "is_demo", "detail")}
    if mode == "production":
        installed = backends.is_installed("transformers") and backends.is_installed("torch")
        cached = backends.is_cached(SENTIMENT_MODEL)
        return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": "transformers", "version": SENTIMENT_MODEL,
                "status": "available" if installed else "not_installed", "is_demo": not installed,
                "detail": (f"Loads on first use; {'weights cached' if cached else 'weights download on first use'}."
                           if installed else "transformers/torch not installed; the demo lexicon will be used.")}
    return {"name": STATUS_NAME, "task": STATUS_TASK, "framework": "python", "version": DEMO_VERSION,
            "status": "available", "is_demo": True,
            "detail": "VADER-style lexicon with negation, intensifiers and civic phrases."}
