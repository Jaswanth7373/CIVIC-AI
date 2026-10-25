"""Potential impact, urgency, sensitive locations and a severity hint from complaint text.

Everything here is a transparent, rule-based analysis over the canonical lemma sequence produced
by ``text_preprocessor`` (so "bacche" / "kids" / "children" all read as "child"), stopwords kept
and clause boundaries known:

Impacts - weighted lexicons for seven impact types
    public_safety, traffic, health, environment, property, service_disruption, accessibility.
    Each matched term has a weight in (0, 1]; a type's score is the noisy-OR of its matched
    weights, ``1 - prod(1 - w_i)``, i.e. the chance that at least one piece of evidence is real.
    Two-word terms may have up to two words in between inside the same clause ("no drinking
    water" matches "no water", "entering the houses" matches "enter house").

Negation
    A term preceded by a negator (no, not, never, without, nobody, cannot) within three words *of
    the same clause* counts only 30%: "no accident yet" still signals risk, but not an accident,
    while in "no streetlight, accidents happen daily" the comma ends the negation's scope.
    "but" / "however" also end the scope. Terms that contain the negation themselves ("no water",
    "not working") are exempt, and so is accessibility vocabulary, where absence *is* the
    problem ("no footpath").

Hazard near vulnerable people
    When the category is a physical hazard (pothole, open manhole, road crack, fallen tree,
    streetlight / electrical) and the text mentions a school, hospital, children, elderly ...,
    public safety is combined (noisy-OR) with 0.5; for sanitation categories (garbage, drainage,
    water) the health impact is combined with 0.35.

Urgency (0-1) = noisy-OR of explicit urgency words ("urgent", "immediately", "emergency"),
    escalation cues ("again", "many times", "third complaint", "no action"), how long the problem
    has persisted (parsed durations such as "for 2 weeks", "since 10 days", "kal se":
    0.75 * (1 - exp(-days / 21))) and half of the safety score.

Severity hint (0-1) = 0.50 * category base severity + 0.30 * harm + 0.08 * breadth
    + 0.06 * urgency + 0.06 * magnitude ("huge", "deep", "massive") - 0.10 * minor ("small",
    "hairline"), where harm is the most serious impact (score x importance: public safety 1.0,
    health 0.95, service disruption 0.9, traffic / accessibility 0.85, property 0.8, environment
    0.75) and breadth the second most serious. Half of the category's base severity anchors the
    hint, so a plain "pothole on the road" lands at medium and text evidence moves it from there. Inherently critical hazards (live wire,
    electrocution, open manhole, fire, collapse, drowning, death) raise the hint to at least
    "high", and to "critical" when vulnerable people are mentioned. Mapped to low / medium / high /
    critical with ``score_to_level``.

Location mentions - sensitive places (school, hospital, market, junction, temple, metro station,
    bus stop ...) extended with an adjacent modifier / part ("government school", "school
    entrance").
"""
import math
from bisect import bisect_right
from functools import lru_cache

from ..config import CLASS_LABELS, score_to_level
from . import lexicons as lx
from .text_preprocessor import normalize_phrase

IMPACT_TYPES = {
    # type: (label, importance used to rank the primary impact, negation reduces the evidence)
    "public_safety": ("Public Safety", 1.00, True),
    "health": ("Health", 0.95, True),
    "service_disruption": ("Service Disruption", 0.90, True),
    "traffic": ("Traffic", 0.85, True),
    "accessibility": ("Accessibility", 0.85, False),
    "property": ("Property", 0.80, True),
    "environment": ("Environment", 0.75, True),
}

IMPACT_LEXICON = {
    "public_safety": {
        "accident": 0.85, "injury": 0.9, "hurt": 0.75, "death": 1.0, "die": 1.0, "dead": 0.6, "kill": 1.0,
        "danger": 0.75, "dangerous": 0.8, "hazard": 0.75, "risk": 0.55, "unsafe": 0.7, "live wire": 1.0,
        "electrocution": 1.0, "electric shock": 0.95, "shock": 0.6, "spark": 0.75, "fire": 0.85,
        "short circuit": 0.85, "open manhole": 1.0, "manhole open": 0.95, "manhole": 0.5, "uncovered": 0.65,
        "no cover": 0.8, "without cover": 0.8, "cover missing": 0.75, "fallen into": 0.8, "fallen in": 0.7,
        "slip": 0.55, "skid": 0.6, "collapse": 0.75, "drown": 1.0, "bite": 0.7, "attack": 0.7, "chase": 0.5,
        "crime": 0.6, "theft": 0.55, "chain snatch": 0.6, "child": 0.6, "school": 0.6, "student": 0.55,
        "hospital": 0.6, "ambulance": 0.6, "elderly": 0.55, "senior citizen": 0.55, "old people": 0.5,
        "pregnant": 0.5, "woman": 0.4, "dark": 0.4, "pitch dark": 0.5, "hang": 0.4, "lean": 0.4, "tilt": 0.4,
        "fallen": 0.45,
    },
    "traffic": {
        "traffic": 0.8, "traffic jam": 0.9, "jam": 0.7, "congestion": 0.85, "vehicle": 0.5, "car": 0.4,
        "bike": 0.45, "two wheeler": 0.5, "bus": 0.45, "auto": 0.35, "truck": 0.4, "commuter": 0.5,
        "main road": 0.65, "junction": 0.6, "highway": 0.75, "signal": 0.45, "bus stop": 0.45,
        "flyover": 0.55, "service road": 0.5, "ring road": 0.6, "blocked road": 0.75, "road blocked": 0.75,
        "road closed": 0.8, "divert": 0.6, "detour": 0.55, "peak hour": 0.6,
    },
    "health": {
        "mosquito": 0.75, "dengue": 1.0, "malaria": 1.0, "chikungunya": 1.0, "typhoid": 0.95, "cholera": 1.0,
        "jaundice": 0.9, "diarrhoea": 0.9, "diarrhea": 0.9, "disease": 0.85, "infection": 0.8, "illness": 0.8,
        "sick": 0.75, "fever": 0.7, "smell": 0.6, "stink": 0.7, "foul": 0.6, "odour": 0.6, "odor": 0.6,
        "sewage": 0.75, "dirty water": 0.8, "contaminated": 0.9, "drinking water": 0.5, "stagnant": 0.65,
        "rat": 0.55, "fly": 0.4, "cockroach": 0.5, "unhygienic": 0.75, "hygiene": 0.5, "health hazard": 0.9,
        "breed": 0.6, "vomit": 0.7, "asthma": 0.7, "public health": 0.8, "rot": 0.5, "filth": 0.6, "dirty": 0.45,
    },
    "environment": {
        "pollution": 0.8, "smoke": 0.7, "burn": 0.6, "plastic": 0.55, "water waste": 0.75, "waste": 0.3,
        "lake": 0.55, "river": 0.55, "open dumping": 0.65, "dump": 0.4, "debris": 0.45,
        "construction debris": 0.55, "noise": 0.6, "noise pollution": 0.85, "dust": 0.55, "chemical": 0.7,
        "oil spill": 0.6, "tree": 0.3, "tree cutting": 0.7, "loudspeaker": 0.6,
    },
    "property": {
        "damage": 0.55, "property damage": 0.9, "house": 0.45, "home": 0.45, "shop": 0.45, "building": 0.45,
        "wall": 0.45, "compound wall": 0.55, "basement": 0.65, "enter house": 0.8, "inside house": 0.75,
        "parked car": 0.6, "vehicle damage": 0.7, "roof": 0.55, "furniture": 0.5, "fallen on car": 0.8,
        "fallen on house": 0.85, "fallen on wall": 0.75, "flood": 0.45, "tyre": 0.45, "tyre burst": 0.6,
    },
    "service_disruption": {
        "no water": 0.9, "water supply": 0.55, "no supply": 0.8, "low pressure": 0.6, "power cut": 0.9,
        "outage": 0.85, "no electricity": 0.9, "no power": 0.85, "no light": 0.6, "not working": 0.4,
        "not collect": 0.6, "no collect": 0.6, "not clean": 0.45, "blocked": 0.5, "disrupt": 0.75,
        "interrupt": 0.7, "shortage": 0.7, "irregular": 0.5, "disconnect": 0.7, "road closed": 0.6,
        "cannot pass": 0.6, "tanker": 0.5, "not coming": 0.5, "not come": 0.5,
    },
    "accessibility": {
        "wheelchair": 1.0, "footpath": 0.6, "pedestrian": 0.7, "sidewalk": 0.6, "pavement": 0.55,
        "walk": 0.4, "disabled": 0.9, "handicap": 0.9, "blind": 0.8, "crutch": 0.7, "ramp": 0.65,
        "crossing": 0.5, "zebra crossing": 0.6, "stroller": 0.6, "pram": 0.6, "elderly": 0.45,
        "senior citizen": 0.45, "difficult to walk": 0.7, "cannot walk": 0.7, "cannot cross": 0.65,
    },
}

CRITICAL_HAZARDS = frozenset({"live wire", "electrocution", "electric shock", "open manhole", "manhole open",
                              "fire", "short circuit", "collapse", "drown", "death", "die", "kill"})
VULNERABLE = {"school": "school", "hospital": "hospital", "child": "children", "elderly": "elderly people",
              "student": "students", "anganwadi": "anganwadi", "playground": "playground", "college": "college",
              "clinic": "clinic", "ambulance": "ambulances", "pregnant": "pregnant women",
              "disabled": "disabled people", "wheelchair": "wheelchair users", "senior": "senior citizens"}
SAFETY_HAZARD_CATEGORIES = frozenset({"pothole", "open_manhole", "road_crack", "fallen_tree", "streetlight"})
HEALTH_HAZARD_CATEGORIES = frozenset({"garbage", "drainage", "water_leak"})
NEGATORS = lx.NEGATIONS | {"not"}
SCOPE_BREAKERS = frozenset({"but", "however", "although", "though", "lekin", "magar", "kaani", "kani"})
NEGATION_WINDOW = 3
NEGATED_FACTOR = 0.3
MAX_GAP = 2

URGENCY_TERMS = {
    "urgent": 0.75, "immediately": 0.7, "immediate": 0.7, "emergency": 0.85, "as soon as possible": 0.75,
    "at the earliest": 0.5, "earliest": 0.45, "quickly": 0.4, "soon": 0.3, "before someone": 0.55,
    "before somebody": 0.55, "right now": 0.5, "today itself": 0.6, "on priority": 0.6, "priority": 0.4,
}
ESCALATION_TERMS = {
    "again": 0.35, "repeatedly": 0.5, "many times": 0.55, "several times": 0.55, "multiple times": 0.55,
    "third time": 0.6, "second time": 0.45, "third complaint": 0.6, "second complaint": 0.45,
    "twice": 0.45, "thrice": 0.55, "no action": 0.5, "no response": 0.5, "nobody came": 0.5,
    "nobody come": 0.5, "still not": 0.4, "already complained": 0.45, "complained before": 0.4,
    "again and again": 0.6, "every day": 0.3, "daily": 0.3, "every time": 0.3, "every year": 0.35,
    "every rain": 0.35,
}
MAGNITUDE_TERMS = {
    "huge": 0.8, "massive": 0.9, "large": 0.6, "deep": 0.7, "major": 0.7, "severe": 0.8, "heavy": 0.5,
    "entire": 0.5, "whole": 0.5, "completely": 0.5, "knee deep": 0.9, "wide": 0.5, "multiple": 0.4,
    "full of": 0.4, "giant": 0.8, "gaping": 0.7, "badly": 0.5,
}
MINOR_TERMS = {"small": 0.6, "minor": 0.7, "slight": 0.6, "little": 0.4, "hairline": 0.7, "tiny": 0.7}
INTENSIFIERS = frozenset({"very", "extremely", "too", "really", "so"})

NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30,
    "few": 3, "couple": 2, "several": 5, "many": 7, "ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4,
    "paanch": 5, "das": 10, "kai": 5, "oka": 1, "rendu": 2, "moodu": 3, "naalugu": 4, "aidu": 5,
}
UNIT_DAYS = {"hour": 1 / 24, "day": 1, "week": 7, "month": 30, "year": 365}
FIXED_DURATIONS = {
    ("since", "yesterday"): 1, ("last", "week"): 7, ("last", "month"): 30, ("last", "year"): 365,
    ("long", "time"): 60, ("since", "long"): 60, ("for", "age"): 180, ("since", "morning"): 0.5,
    ("last", "rain"): 20, ("many", "day"): 14, ("several", "day"): 10, ("few", "day"): 4,
}

DEFAULT_BASE_SEVERITY = {"pothole": 60, "garbage": 40, "drainage": 55, "streetlight": 45, "water_leak": 50,
                         "open_manhole": 85, "road_crack": 40, "fallen_tree": 65, "other": 30}
UNKNOWN_BASE_SEVERITY = 40

PLACE_HEADS = {
    ("school",): "school", ("hospital",): "hospital", ("market",): "market", ("junction",): "junction",
    ("temple",): "temple", ("mosque",): "mosque", ("church",): "church", ("metro",): "metro",
    ("station",): "station", ("bus", "stop"): "bus stop", ("park",): "park", ("playground",): "playground",
    ("college",): "college", ("clinic",): "clinic", ("anganwadi",): "anganwadi", ("highway",): "highway",
    ("main", "road"): "main road", ("flyover",): "flyover", ("signal",): "signal",
    ("health", "centre"): "health centre", ("old", "age", "home"): "old age home",
}
PLACE_PARTS = frozenset({"entrance", "gate", "road", "junction", "area", "premise", "compound", "campus",
                         "ground", "stop", "station", "side", "wall", "crossing", "signal", "circle", "corner",
                         "lane", "pillar", "centre", "center"})
PLACE_MODIFIERS = frozenset({"government", "primary", "high", "public", "private", "main", "bus", "metro",
                             "railway", "city", "district", "child", "girl", "boy", "local", "vegetable", "fish",
                             "maternity", "municipal", "junior", "community", "health", "zilla", "rythu"})


# ---------------------------------------------------------------------------------------------
# Matching helpers
# ---------------------------------------------------------------------------------------------
@lru_cache(maxsize=8)
def _compiled(table_name):
    """A term table normalised exactly like complaint text: ((lemmas, weight, display, extra), ...)."""
    if table_name == "impacts":
        rows = [(normalize_phrase(term), weight, term, impact_type)
                for impact_type, terms in IMPACT_LEXICON.items() for term, weight in terms.items()]
    else:
        table = {"urgency": URGENCY_TERMS, "escalation": ESCALATION_TERMS, "magnitude": MAGNITUDE_TERMS,
                 "minor": MINOR_TERMS}[table_name]
        rows = [(normalize_phrase(term), weight, term, None) for term, weight in table.items()]
    return tuple(sorted((r for r in rows if r[0]), key=lambda r: -len(r[0])))


class _Text:
    """Lemma sequence with clause boundaries, as used by every rule in this module."""

    def __init__(self, prep):
        self.lemmas = prep["lemmas"]
        self.clause_starts = list(prep.get("clause_starts") or [])

    def clause_start(self, position):
        index = bisect_right(self.clause_starts, position)
        return self.clause_starts[index - 1] if index else 0

    def matches(self, lemmas, allow_gap):
        """(start, end) spans where ``lemmas`` occur; two-word terms may skip <= MAX_GAP words."""
        seq, size, hits = self.lemmas, len(lemmas), []
        for start, token in enumerate(seq):
            if token != lemmas[0]:
                continue
            if tuple(seq[start:start + size]) == lemmas:
                hits.append((start, start + size))
            elif allow_gap and size == 2:
                for gap in range(1, MAX_GAP + 1):
                    end = start + gap + 1
                    if end < len(seq) and seq[end] == lemmas[1] and self.clause_start(end) <= start:
                        hits.append((start, end + 1))
                        break
        return hits

    def negated(self, start):
        """True when a negator precedes ``start`` within the window and the same clause."""
        lower = max(self.clause_start(start), start - NEGATION_WINDOW)
        for position in range(start - 1, lower - 1, -1):
            token = self.lemmas[position]
            if token in SCOPE_BREAKERS:
                return False
            if token in NEGATORS:
                return True
        return False


def _noisy_or(weights):
    product = 1.0
    for weight in weights:
        product *= 1.0 - max(0.0, min(1.0, weight))
    return 1.0 - product


def _term_hits(text, table_name):
    """Matched (weight, display, start) for a simple term table, longest first, no overlaps."""
    covered, hits = set(), []
    for lemmas, weight, display, _ in _compiled(table_name):
        for start, end in text.matches(lemmas, allow_gap=False):
            if covered.isdisjoint(range(start, end)):
                covered.update(range(start, end))
                hits.append((weight, display, start))
                break
    return hits


# ---------------------------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------------------------
def detect_impacts(text):
    """``{type: {"score", "evidence", "terms"}}`` with negation-aware noisy-OR scores."""
    found = {t: {"weights": [], "evidence": [], "terms": set()} for t in IMPACT_TYPES}
    covered = {t: set() for t in IMPACT_TYPES}
    for lemmas, weight, display, impact_type in _compiled("impacts"):
        for start, end in text.matches(lemmas, allow_gap=True):
            if not covered[impact_type].isdisjoint(range(start, end)):
                continue
            covered[impact_type].update(range(start, end))
            negated = IMPACT_TYPES[impact_type][2] and lemmas[0] not in NEGATORS and text.negated(start)
            entry = found[impact_type]
            entry["weights"].append(weight * (NEGATED_FACTOR if negated else 1.0))
            if not negated:
                entry["terms"].add(display)
            label = f"{display} (negated)" if negated else display
            if label not in entry["evidence"]:
                entry["evidence"].append(label)
            break
    return {t: {"score": _noisy_or(v["weights"]), "evidence": v["evidence"], "terms": v["terms"]}
            for t, v in found.items()}


def parse_duration_days(lemmas):
    """Longest duration mentioned ("for 2 weeks" -> 14, "since yesterday" -> 1), in days, or 0."""
    best = 0.0
    for i, token in enumerate(lemmas):
        if token in UNIT_DAYS and i > 0:
            previous = lemmas[i - 1]
            amount = None
            if previous.isdigit():
                amount = int(previous)
            elif previous in NUMBER_WORDS:
                amount = NUMBER_WORDS[previous]
            elif i > 1 and previous in {"more", "last", "past"} and lemmas[i - 2].isdigit():
                amount = int(lemmas[i - 2])
            if amount is not None and 0 < amount < 1000:
                best = max(best, amount * UNIT_DAYS[token])
        if i + 1 < len(lemmas):
            fixed = FIXED_DURATIONS.get((token, lemmas[i + 1]))
            if fixed:
                best = max(best, fixed)
    return best


def find_locations(lemmas):
    """Sensitive places with an adjacent modifier / part, in order of appearance, de-duplicated."""
    mentions = []
    heads = sorted(PLACE_HEADS, key=len, reverse=True)
    i = 0
    while i < len(lemmas):
        for head in heads:
            if tuple(lemmas[i:i + len(head)]) == head:
                start, end = i, i + len(head)
                if start > 0 and lemmas[start - 1] in PLACE_MODIFIERS and lemmas[start - 1] not in head:
                    start -= 1
                if end < len(lemmas) and lemmas[end] in PLACE_PARTS and lemmas[end] not in head:
                    end += 1
                phrase = " ".join(lemmas[start:end])
                if not any(phrase in m for m in mentions):
                    mentions = [m for m in mentions if m not in phrase] + [phrase]
                i = end - 1
                break
        i += 1
    return mentions


def base_severity(category, categories=None):
    """Category base severity in [0, 1] (DB value when provided, else the documented default)."""
    for item in categories or []:
        if isinstance(item, dict) and item.get("slug") == category and item.get("base_severity") is not None:
            try:
                return max(0.0, min(1.0, float(item["base_severity"]) / 100.0))
            except (TypeError, ValueError):
                break
    return DEFAULT_BASE_SEVERITY.get(category, UNKNOWN_BASE_SEVERITY) / 100.0


def assess_impact(prep, *, category=None, categories=None, thresholds=None):
    """Impact / urgency / location / severity-hint analysis of a preprocessed complaint.

    Returns ``{"impacts": [{type, label, score, evidence}], "primary_impact", "safety_score",
    "urgency_score", "severity_hint", "severity_hint_score", "location_mentions", "signals"}``.
    """
    text = _Text(prep)
    detected = detect_impacts(text)

    vulnerable = []
    for position, token in enumerate(text.lemmas):
        if token in VULNERABLE and not text.negated(position) and VULNERABLE[token] not in vulnerable:
            vulnerable.append(VULNERABLE[token])
    hazard_label = CLASS_LABELS.get(category, str(category or "")).split(" / ")[0].lower()
    if vulnerable and category in SAFETY_HAZARD_CATEGORIES:
        entry = detected["public_safety"]
        entry["score"] = _noisy_or([entry["score"], 0.5])
        entry["evidence"].append(f"{hazard_label} close to {vulnerable[0]}")
    elif vulnerable and category in HEALTH_HAZARD_CATEGORIES:
        entry = detected["health"]
        entry["score"] = _noisy_or([entry["score"], 0.35])
        entry["evidence"].append(f"{vulnerable[0]} exposed to {hazard_label}")

    # Rank by importance-weighted score; on ties the more important impact type comes first.
    ranked = sorted(((detected[t]["score"] * importance, importance, t)
                     for t, (_, importance, _) in IMPACT_TYPES.items()), reverse=True)
    impacts = [{"type": t, "label": IMPACT_TYPES[t][0], "score": round(detected[t]["score"], 2),
                "evidence": detected[t]["evidence"][:5]}
               for _, _, t in ranked if detected[t]["score"] >= 0.15]
    harm = ranked[0][0]
    breadth = ranked[1][0]
    safety = detected["public_safety"]["score"]

    urgency_hits = _term_hits(text, "urgency")
    escalation_hits = _term_hits(text, "escalation")
    duration_days = parse_duration_days(text.lemmas)
    duration_score = 0.75 * (1.0 - math.exp(-duration_days / 21.0)) if duration_days else 0.0
    urgency = _noisy_or([w for w, _, _ in urgency_hits] + [w for w, _, _ in escalation_hits]
                        + [duration_score, 0.5 * safety])

    magnitude = 0.0
    for weight, _, start in _term_hits(text, "magnitude"):
        boosted = weight + (0.15 if start > 0 and text.lemmas[start - 1] in INTENSIFIERS else 0.0)
        magnitude = max(magnitude, min(1.0, boosted))
    minor = max([w for w, _, _ in _term_hits(text, "minor")] or [0.0])

    base = base_severity(category, categories) if category else UNKNOWN_BASE_SEVERITY / 100.0
    hint = 0.50 * base + 0.30 * harm + 0.08 * breadth + 0.06 * urgency + 0.06 * magnitude - 0.10 * minor
    critical_terms = sorted(detected["public_safety"]["terms"] & CRITICAL_HAZARDS)
    if critical_terms:
        hint = max(hint, 0.78 if vulnerable else 0.55)
    hint = max(0.0, min(1.0, hint))
    return {
        "impacts": impacts,
        "primary_impact": impacts[0]["label"] if impacts else None,
        "safety_score": round(safety, 2),
        "urgency_score": round(urgency, 2),
        "severity_hint": score_to_level(hint * 100.0, thresholds),
        "severity_hint_score": round(hint, 2),
        "location_mentions": find_locations(text.lemmas),
        "signals": {
            "category_base_severity": round(base, 2),
            "harm": round(harm, 2),
            "breadth": round(breadth, 2),
            "critical_hazards": critical_terms,
            "vulnerable": vulnerable,
            "duration_days": round(duration_days, 1),
            "urgency_terms": [d for _, d, _ in urgency_hits],
            "escalation_terms": [d for _, d, _ in escalation_hits],
            "magnitude": round(magnitude, 2),
            "minor": round(minor, 2),
        },
    }
