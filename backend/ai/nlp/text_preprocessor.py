"""Text preprocessing for civic complaint text (English, Indian English, Hinglish, romanised Telugu).

Pipeline applied by :func:`preprocess` (each step is a small, testable function):

1. **Unicode normalisation** (NFKC) - folds full-width / compatibility characters, unifies curly
   quotes, removes zero-width characters, then case-folds.
2. **Noise cleanup** - URLs, e-mail addresses and emoji are removed, ``#hashtags`` keep their word,
   English contractions are expanded ("isn't" -> "is not", "can't" -> "can not") so negations
   survive, and digits glued to words are split ("2weeks" -> "2 weeks", but "3rd" stays).
3. **Tokenisation** - a Unicode-aware regular expression that also keeps Devanagari and Telugu
   script words (including their combining vowel signs) together; punctuation is dropped.
4. **Language identification** - script detection plus counts of romanised Hindi / Telugu marker
   words ("hai", "nahi" / "undi", "ledu") -> ``en``, ``hi-en``, ``te-en``, ``hi``, ``te`` or ``und``.
5. **Synonym normalisation** - multi-word phrases first (longest match), then single words:
   gaddha -> pothole, kachra / chetta -> garbage, nala -> drain, bijli / current -> electricity,
   paani / neeru -> water, chettu -> tree, big -> large, outside -> near ... (see ``lexicons``).
   Words with different meanings in Hindi and Telugu are resolved by the detected language.
6. **Spelling correction** - an out-of-vocabulary token is corrected to a distinctive domain word
   when the Damerau-Levenshtein distance is 1 (2 for 8+ letters) and the first letter matches
   ("pothol" -> pothole, "garbge" -> garbage). Known English words are protected.
7. **Light lemmatisation** - curated table of inflected civic words (flooding -> flood) plus a
   plural-stripping rule with exceptions (potholes -> pothole, but "bus", "status" unchanged).
8. **Stopword removal** - English + romanised Hindi/Telugu function words; negations and spatial
   prepositions are kept because they carry meaning ("no water", "near school").

``preprocess(text)`` returns the contract keys ``clean``, ``tokens``, ``normalized``, ``language``
plus helper views used by the other NLP modules (``lemmas``, ``canonical``, ``canonical_tokens``,
``sources``, ``clause_starts``, ``replacements``). Cached models fingerprint this file and
``lexicons.py``, so any change here retrains them automatically.
"""
import re
import unicodedata
from functools import lru_cache

from . import lexicons as lx

# ---------------------------------------------------------------------------------------------
# Regular expressions
# ---------------------------------------------------------------------------------------------
_URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_MENTION_RE = re.compile(r"(?<!\w)@\w+")
_ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")
# Emoji & pictographs, dingbats, variation selectors, regional indicators (flags), skin tones.
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF\U00002B00-\U00002BFF"
    "\U0000FE00-\U0000FE0F\U0001F1E6-\U0001F1FF\U0000200D\U000020E3\U00002190-\U000021FF]+"
)
# Digits glued to letters ("2weeks") are split, ordinals ("3rd", "21st") are kept.
_DIGIT_ALPHA_RE = re.compile(r"(\d)(?!(?:st|nd|rd|th)\b)([^\W\d_])")
_ALPHA_DIGIT_RE = re.compile(r"([^\W\d_])(\d)")
# Word characters: Unicode letters/digits plus the Devanagari and Telugu blocks (their vowel signs
# and viramas are combining marks that ``\w`` does not match on its own).
_WORD = "(?:[^\\W_]|[\u0900-\u097F\u0C00-\u0C7F])"
_TOKEN_RE = re.compile(_WORD + "+")
# Clause breaks: , . ; : ! ? | ( ) [ ] newline, the Devanagari danda and the ellipsis character.
_CLAUSE_BREAK_RE = re.compile("[,.;:!?|()\\[\\]\n\u0964\u2026]")
_DEVANAGARI_RE = re.compile("[\u0900-\u097F]")
_TELUGU_RE = re.compile("[\u0C00-\u0C7F]")
_LATIN_RE = re.compile("[a-z]")

_CONTRACTIONS = (
    (re.compile(r"\bwon't\b"), "will not"),
    (re.compile(r"\bcan't\b"), "can not"),
    (re.compile(r"\bshan't\b"), "shall not"),
    (re.compile(r"\bain't\b"), "is not"),
    (re.compile(r"n't\b"), " not"),
    (re.compile(r"'re\b"), " are"),
    (re.compile(r"'ll\b"), " will"),
    (re.compile(r"'ve\b"), " have"),
    (re.compile(r"'m\b"), " am"),
    (re.compile(r"'d\b"), " would"),
    (re.compile(r"'s\b"), ""),
)
# Apostrophe-less texting forms of negated auxiliaries ("isnt", "dont", "doesnt" ...).
_BARE_NEGATIONS = {
    "isnt": ("is", "not"), "arent": ("are", "not"), "wasnt": ("was", "not"), "werent": ("were", "not"),
    "dont": ("do", "not"), "doesnt": ("does", "not"), "didnt": ("did", "not"), "cant": ("can", "not"),
    "couldnt": ("could", "not"), "wont": ("will", "not"), "wouldnt": ("would", "not"),
    "shouldnt": ("should", "not"), "hasnt": ("has", "not"), "havent": ("have", "not"),
    "hadnt": ("had", "not"), "aint": ("is", "not"),
}


def _nfkc(value):
    return unicodedata.normalize("NFKC", value)


# Lookup tables are normalised exactly like input text (NFKC + casefold) so native-script entries
# match regardless of how the citizen's keyboard composed the characters.
_PHRASES = {tuple(_nfkc(t).casefold() for t in k): v for k, v in lx.PHRASE_SYNONYMS.items()}
_MAX_PHRASE = max(len(k) for k in _PHRASES)
_WORDS = {_nfkc(k).casefold(): tuple(v.split()) for k, v in lx.WORD_SYNONYMS.items()}
_SYNONYM_TARGETS = {t for v in _WORDS.values() for t in v} | {t for v in _PHRASES.values() for t in v}
_STOPWORDS = frozenset(_nfkc(w).casefold() for w in lx.STOPWORDS)
_INDIC_STOPWORDS = frozenset(_nfkc(w).casefold() for w in lx.INDIC_STOPWORDS)
_ENGLISH_STOPWORDS = frozenset(lx.ENGLISH_STOPWORDS)
_KNOWN_WORDS = (
    set(_STOPWORDS) | set(_WORDS) | _SYNONYM_TARGETS | set(lx.LEMMA_TABLE)
    | set(lx.LEMMA_TABLE.values()) | set(lx.DOMAIN_TERMS) | set(lx.SPELLING_PROTECTED)
    | set(lx.LEMMA_EXCEPTIONS) | set(lx.NEGATIONS) | set(lx.KEYWORD_EXCLUDE)
)
_KEY_TERMS = tuple(sorted(set(lx.SPELLING_KEY_TERMS)))


# ---------------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------------
def normalize_text(text, *, lowercase=True):
    """Unicode-normalise and clean raw text (URLs, e-mails, mentions, emoji, contractions)."""
    value = _nfkc("" if text is None else str(text))
    value = value.replace("\u2019", "'").replace("\u2018", "'").replace("`", "'")
    value = value.replace("\u201c", '"').replace("\u201d", '"')
    value = _ZERO_WIDTH_RE.sub("", value)
    value = _URL_RE.sub(" ", value)
    value = _EMAIL_RE.sub(" ", value)
    value = _MENTION_RE.sub(" ", value)
    value = _EMOJI_RE.sub(" ", value)
    value = value.replace("#", " ")
    if lowercase:
        value = value.casefold()
    for pattern, replacement in _CONTRACTIONS:
        value = pattern.sub(replacement, value)
    value = _DIGIT_ALPHA_RE.sub(r"\1 \2", value)
    value = _ALPHA_DIGIT_RE.sub(r"\1 \2", value)
    return value


def tokenize_with_breaks(text):
    """Tokens plus, for each token, whether a clause break (, . ; : ! ? ...) precedes it."""
    tokens, breaks = [], []
    text = text.replace("'", "")
    previous_end = 0
    for match in _TOKEN_RE.finditer(text):
        broken = bool(tokens) and bool(_CLAUSE_BREAK_RE.search(text, previous_end, match.start()))
        previous_end = match.end()
        for k, token in enumerate(_BARE_NEGATIONS.get(match.group(), (match.group(),))):
            tokens.append(token)
            breaks.append(broken and k == 0)
    return tokens, breaks


def tokenize(text):
    """Split normalised text into word tokens (punctuation dropped, apostrophes removed)."""
    return tokenize_with_breaks(text)[0]


def detect_language(tokens, text=""):
    """Identify the language variety of a complaint.

    Native scripts are detected by Unicode block; for Latin-script text the number of romanised
    Hindi vs Telugu marker words decides between ``hi-en`` (Hinglish), ``te-en`` and ``en``.
    Strong markers count 1, weak (short, ambiguous) markers count 0.5; a score >= 1 is required.
    """
    deva = len(_DEVANAGARI_RE.findall(text))
    telu = len(_TELUGU_RE.findall(text))
    latin = len(_LATIN_RE.findall(text.casefold()))
    if not tokens:
        return "und"
    if deva and deva >= telu and deva >= latin:
        return "hi"
    if telu and telu > deva and telu >= latin:
        return "te"
    hindi = sum(1.0 for t in tokens if t in lx.HINDI_STRONG_MARKERS) + \
        sum(0.5 for t in tokens if t in lx.HINDI_WEAK_MARKERS)
    telugu = sum(1.0 for t in tokens if t in lx.TELUGU_STRONG_MARKERS) + \
        sum(0.5 for t in tokens if t in lx.TELUGU_WEAK_MARKERS)
    hindi += deva > 0
    telugu += telu > 0
    if max(hindi, telugu) < 1:
        return "en"
    return "te-en" if telugu > hindi else "hi-en"


def _osa_distance(a, b, limit):
    """Optimal-string-alignment (restricted Damerau-Levenshtein) distance with early exit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2 = None
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[-1]


@lru_cache(maxsize=8192)
def correct_spelling(token):
    """Return the domain key term a misspelt token most likely stands for, else the token itself.

    Conservative by design: only alphabetic, out-of-vocabulary tokens of 5+ letters are
    considered; the candidate must share the first letter and be within distance 1 (2 for
    8+ letter words); ties between two candidates leave the token unchanged.
    """
    if len(token) < 5 or not token.isascii() or not token.isalpha() or token in _KNOWN_WORDS:
        return token
    limit = 2 if len(token) >= 8 else 1
    best, best_dist, tie = token, limit + 1, False
    for term in _KEY_TERMS:
        if term[0] != token[0]:
            continue
        dist = _osa_distance(token, term, limit)
        if dist < best_dist:
            best, best_dist, tie = term, dist, False
        elif dist == best_dist and term != best:
            tie = True
    if best_dist <= limit and not tie:
        return best
    return token


@lru_cache(maxsize=16384)
def lemmatize(token):
    """Light lemmatisation: curated table first, then a plural-stripping rule with exceptions."""
    if token in lx.LEMMA_TABLE:
        return lx.LEMMA_TABLE[token]
    if len(token) <= 3 or not token.isalpha() or not token.isascii() or token in lx.LEMMA_EXCEPTIONS:
        return token
    if token.endswith(("ous", "ss", "us", "is")):
        return token
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    if token.endswith(("sses", "shes", "ches", "xes", "zes")):
        return token[:-2]
    if token.endswith("s"):
        return token[:-1]
    return token


def canonicalize(tokens, language="en"):
    """Apply phrase synonyms, word synonyms and spelling correction.

    Returns ``(canonical_tokens, replacements)`` where ``replacements`` lists the
    ``(original, canonical)`` pairs that changed (useful for explanations such as
    "gaddha -> pothole").
    """
    out, replacements, _ = _canonicalize(tokens, language)
    return out, replacements


def _canonicalize(tokens, language, breaks=None):
    """``canonicalize`` that also returns, per output token, the index of its source token.

    Phrases never span a clause break ("... no, water ..." is not "no water").
    """
    overrides = lx.TELUGU_OVERRIDES if language == "te-en" else lx.HINDI_OVERRIDES
    out, replacements, sources = [], [], []
    i, n = 0, len(tokens)
    while i < n:
        matched = False
        for size in range(min(_MAX_PHRASE, n - i), 1, -1):
            if breaks and any(breaks[i + 1:i + size]):
                continue
            key = tuple(tokens[i:i + size])
            target = _PHRASES.get(key)
            if target is not None:
                out.extend(target)
                sources.extend([i] * len(target))
                replacements.append((" ".join(key), " ".join(target)))
                i += size
                matched = True
                break
        if matched:
            continue
        token = tokens[i]
        override = overrides.get(token)
        mapped = (override,) if override else _WORDS.get(token)
        if mapped is None:
            corrected = correct_spelling(token)
            if corrected == token:
                # Inflected typos ("mosqitoes") are compared through their lemma ("mosqitoe").
                lemma = lemmatize(token)
                corrected = correct_spelling(lemma)
                corrected = corrected if corrected != lemma else token
            mapped = (corrected,)
        if mapped != (token,):
            replacements.append((token, " ".join(mapped)))
        out.extend(mapped)
        sources.extend([i] * len(mapped))
        i += 1
    return out, replacements, sources


def is_stopword(token):
    """True for English / romanised Hindi / Telugu / native-script function words."""
    return token in _STOPWORDS


def preprocess(text):
    """Preprocess one complaint / feedback text.

    Returns (CONTRACT keys first):
        clean       - normalised lowercase text with punctuation removed (all words kept)
        tokens      - content tokens in surface form (stopwords removed)
        normalized  - content lemmas after synonym normalisation, space separated (model input)
        language    - "en" | "hi-en" | "te-en" | "hi" | "te" | "und"
        lemmas      - full lemma sequence *including* stopwords (for phrase / negation rules)
        canonical   - synonym-normalised natural text, English function words kept (for
                      transformer models), romanised Hindi/Telugu function words dropped
        replacements - list of [original, canonical] pairs that were normalised
        canonical_tokens - synonym-normalised tokens aligned 1:1 with ``lemmas``
        sources     - for each lemma, the index of its source token in ``clean.split()``
        clause_starts - lemma indices that begin a new clause (after , . ; ! ? ...), used to
                      bound the scope of negations and contrast words
    """
    normalized_text = normalize_text(text)
    raw_tokens, breaks = tokenize_with_breaks(normalized_text)
    language = detect_language(raw_tokens, normalized_text)
    canonical_tokens, replacements, sources = _canonicalize(raw_tokens, language, breaks)
    lemmas = [lemmatize(t) for t in canonical_tokens]
    clause_starts = [i for i in range(1, len(lemmas)) if breaks[sources[i]] and sources[i] != sources[i - 1]]
    content = [
        lemma for token, lemma in zip(canonical_tokens, lemmas)
        if not (is_stopword(token) or is_stopword(lemma)) and not lemma.isdigit()
    ]
    surface_tokens = [t for t in raw_tokens if not is_stopword(t)]
    canonical = [t for t in canonical_tokens if t not in _INDIC_STOPWORDS or t in _ENGLISH_STOPWORDS]
    return {
        "clean": " ".join(raw_tokens),
        "tokens": surface_tokens,
        "normalized": " ".join(content),
        "language": language,
        "lemmas": lemmas,
        "canonical": " ".join(canonical),
        "replacements": [list(pair) for pair in replacements],
        "canonical_tokens": canonical_tokens,
        "sources": sources,
        "clause_starts": clause_starts,
    }


def normalize_phrase(phrase):
    """Normalise a keyword / phrase exactly like complaint text -> tuple of lemmas (stopwords kept).

    Used to match admin-defined category keywords ("stray dogs") against text lemmas.
    """
    tokens = tokenize(normalize_text(phrase))
    canonical_tokens, _ = canonicalize(tokens, detect_language(tokens, phrase or ""))
    return tuple(lemmatize(t) for t in canonical_tokens)
