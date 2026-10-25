"""Unit tests for ai.nlp (no Django). Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_nlp -v

Demo-mode tests exercise the real models (TF-IDF classifier trained from the bundled corpus, the
TF-IDF embedder, the lexicon sentiment analyser). Production code paths are exercised with
``unittest.mock`` stand-ins for the sentence-transformer / transformers backends so the suite stays
fast and offline; a separate test checks the graceful fallback when those backends fail to load.
"""
import csv
import math
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from ai.common import reset_registry
from ai.config import CIVIC_CLASSES
from ai.nlp import analyze_text, backends, classifier, describe_models, embedding, impact, keyword_extractor, sentiment
from ai.nlp.corpus import COMPLAINT_CORPUS, FEEDBACK_CORPUS, load_complaints, load_feedback
from ai.nlp.data import build_corpus
from ai.nlp.text_preprocessor import correct_spelling, lemmatize, preprocess

SPEC_EXAMPLE = "Large pothole near the school entrance causing traffic problems."
CONTRACT_KEYS = {
    "category", "confidence", "probabilities", "keywords", "impacts", "primary_impact", "safety_score",
    "urgency_score", "severity_hint", "severity_hint_score", "location_mentions", "clean_text", "language",
    "model_version", "mode", "is_demo", "explanation", "processing_time_ms",
}
STRAY = {"slug": "stray_animals", "name": "Stray Animals", "keywords": ["stray dog", "dogs", "monkey"]}
DEFAULT_CATEGORIES = [
    {"slug": "pothole", "name": "Roads / Potholes", "keywords": ["pothole", "pit", "crater", "gaddha", "khadda", "broken road"], "base_severity": 60},
    {"slug": "garbage", "name": "Garbage / Waste", "keywords": ["garbage", "trash", "waste", "dump", "kachra", "chetta"], "base_severity": 40},
    {"slug": "other", "name": "Other", "keywords": [], "base_severity": 30},
]
_saved_mode = None


def setUpModule():
    global _saved_mode
    _saved_mode = os.environ.get("MODEL_MODE")
    os.environ["MODEL_MODE"] = "demo"


def tearDownModule():
    if _saved_mode is None:
        os.environ.pop("MODEL_MODE", None)
    else:
        os.environ["MODEL_MODE"] = _saved_mode
    reset_registry()


class TextPreprocessorTests(unittest.TestCase):
    def test_contract_keys_and_cleanup(self):
        result = preprocess("Isn't anyone fixing the POTHOLE?? See https://example.com/x 😡 #civic")
        self.assertTrue({"clean", "tokens", "normalized", "language"} <= set(result))
        self.assertNotIn("http", result["clean"])
        self.assertNotIn("😡", result["clean"])
        self.assertIn("is not", result["clean"])
        self.assertIn("civic", result["clean"].split())
        self.assertEqual(result["clean"], result["clean"].lower())

    def test_hinglish_and_telugu_synonyms(self):
        cases = {
            "gaddha": "pothole", "kachra": "garbage", "chetta": "garbage", "nala": "drain",
            "bijli": "electricity", "current": "electricity", "paani": "water", "neeru": "water", "chettu": "tree",
        }
        for word, expected in cases.items():
            with self.subTest(word=word):
                self.assertEqual(preprocess(f"{word} problem")["normalized"].split()[0], expected)
        self.assertEqual(preprocess("road pe bada gaddha hai school ke paas")["normalized"],
                         "road large pothole school near")

    def test_language_identification(self):
        self.assertEqual(preprocess(SPEC_EXAMPLE)["language"], "en")
        self.assertEqual(preprocess("road pe bada gaddha hai school ke paas")["language"], "hi-en")
        self.assertEqual(preprocess("school daggara pedda gunta undi")["language"], "te-en")
        self.assertEqual(preprocess("सड़क पर बड़ा गड्ढा है")["language"], "hi")
        self.assertEqual(preprocess("")["language"], "und")

    def test_spelling_and_lemmatisation(self):
        self.assertEqual(correct_spelling("pothol"), "pothole")
        self.assertEqual(correct_spelling("garbge"), "garbage")
        self.assertEqual(correct_spelling("garage"), "garage")
        self.assertEqual(lemmatize("potholes"), "pothole")
        self.assertEqual(lemmatize("children"), "child")
        self.assertEqual(lemmatize("bus"), "bus")
        self.assertEqual(lemmatize("status"), "status")

    def test_clause_starts(self):
        result = preprocess("No streetlight, accidents happen daily")
        self.assertEqual(result["clause_starts"], [2])
        self.assertEqual(len(result["lemmas"]), len(result["canonical_tokens"]))


class AnalyzeTextTests(unittest.TestCase):
    def test_contract_keys(self):
        result = analyze_text(SPEC_EXAMPLE)
        self.assertTrue(CONTRACT_KEYS <= set(result), CONTRACT_KEYS - set(result))
        self.assertEqual(result["mode"], "demo")
        self.assertTrue(result["is_demo"])
        self.assertEqual(result["model_version"], "demo-tfidf-logreg-1.0")
        self.assertIsInstance(result["processing_time_ms"], int)
        self.assertAlmostEqual(sum(result["probabilities"].values()), 1.0, places=3)
        self.assertEqual(set(CIVIC_CLASSES), set(result["probabilities"]))

    def test_spec_example(self):
        result = analyze_text(SPEC_EXAMPLE, categories=DEFAULT_CATEGORIES)
        self.assertEqual(result["category"], "pothole")
        self.assertEqual(result["severity_hint"], "high")
        self.assertEqual(result["primary_impact"], "Public Safety")
        for keyword in ("pothole", "school", "traffic"):
            self.assertIn(keyword, result["keywords"])
        self.assertIn("school entrance", result["location_mentions"])
        self.assertEqual(result["clean_text"], "large pothole near school entrance causing traffic problems")
        self.assertTrue(result["explanation"].startswith(
            "Demo AI Mode: TF-IDF + logistic regression classified the text as Pothole ("))
        self.assertIn("potential impact: Public Safety", result["explanation"])
        self.assertGreater(result["confidence"], 0.6)

    def test_hinglish_complaint(self):
        result = analyze_text("road pe bada gaddha hai school ke paas")
        self.assertEqual(result["category"], "pothole")
        self.assertEqual(result["language"], "hi-en")
        self.assertIn("gaddha", result["explanation"])

    def test_romanised_telugu_complaints(self):
        self.assertEqual(analyze_text("school daggara pedda gunta undi")["category"], "pothole")
        self.assertEqual(analyze_text("maa veedhi lo 3 rojulu ga neellu raavatledu")["category"], "water_leak")

    def test_category_examples(self):
        cases = {
            "Garbage not collected for a week near the market": "garbage",
            "Drain overflowing and sewage water on the road": "drainage",
            "Streetlight not working at night, lane is dark": "streetlight",
            "Drinking water pipeline burst, water wasted": "water_leak",
            "Manhole cover missing in the middle of the road": "open_manhole",
            "Long cracks on the newly laid road surface": "road_crack",
            "A big tree fell on the road after the storm": "fallen_tree",
            "Loudspeakers playing very loud late at night": "other",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(analyze_text(text)["category"], expected)

    def test_admin_category_keywords_win(self):
        result = analyze_text("Stray dogs attacking children near park", categories=[STRAY] + DEFAULT_CATEGORIES)
        self.assertEqual(result["category"], "stray_animals")
        self.assertIn("stray_animals", result["keyword_matches"])
        self.assertTrue(set(CIVIC_CLASSES) | {"stray_animals"} <= set(result["probabilities"]))
        self.assertAlmostEqual(sum(result["probabilities"].values()), 1.0, places=3)
        self.assertIn("Stray Animals", result["explanation"])

    def test_admin_keyword_does_not_override_clear_prediction(self):
        result = analyze_text("Huge pothole on the road near the dog park", categories=[STRAY])
        self.assertEqual(result["category"], "pothole")
        self.assertGreater(result["probabilities"]["stray_animals"], 0.0)

    def test_empty_text_is_handled(self):
        result = analyze_text("")
        self.assertEqual(result["category"], "other")
        self.assertEqual(result["keywords"], [])
        self.assertAlmostEqual(result["confidence"], 1 / len(CIVIC_CLASSES), places=3)

    def test_determinism(self):
        first = analyze_text(SPEC_EXAMPLE, categories=[STRAY])
        second = analyze_text(SPEC_EXAMPLE, categories=[STRAY])
        first.pop("processing_time_ms")
        second.pop("processing_time_ms")
        self.assertEqual(first, second)


class ClassifierCacheTests(unittest.TestCase):
    def test_cache_written_reused_and_retrained_when_stale(self):
        tmp = tempfile.mkdtemp()
        try:
            with mock.patch.object(classifier, "model_dir", return_value=Path(tmp)):
                _, first = classifier.load_or_train("demo")
                self.assertEqual(first["source"], "trained")
                self.assertTrue(os.path.exists(os.path.join(tmp, classifier.DEMO_FILE)))
                _, second = classifier.load_or_train("demo")
                self.assertEqual(second["source"], "cache")
                with mock.patch.object(classifier, "_fingerprint", return_value="corpus-changed"):
                    _, third = classifier.load_or_train("demo")
                self.assertEqual(third["source"], "trained")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_blend_moves_other_mass_to_admin_category(self):
        blended = classifier.blend_keyword_scores({"other": 0.8, "pothole": 0.2},
                                                  {"stray_animals": (0.78, ["stray dog"])})
        self.assertGreater(blended["stray_animals"], blended["other"])
        self.assertAlmostEqual(sum(blended.values()), 1.0)


class EmbedderTests(unittest.TestCase):
    def test_similarity_targets(self):
        embedder = embedding.get_text_embedder()
        self.assertTrue(embedder.is_demo)
        self.assertGreaterEqual(embedder.similarity("Large pothole near school.", "Big road pothole outside school."), 0.6)
        self.assertLessEqual(embedder.similarity("Garbage not collected for a week", "Streetlight not working at night"), 0.3)

    def test_encode_is_l2_normalised(self):
        vectors = embedding.get_text_embedder().encode(["Open manhole on main road", "Tree fell on the road", ""])
        norms = np.linalg.norm(vectors, axis=1)
        self.assertAlmostEqual(float(norms[0]), 1.0, places=4)
        self.assertAlmostEqual(float(norms[1]), 1.0, places=4)
        self.assertEqual(float(norms[2]), 0.0)
        sims = embedding.get_text_embedder().batch_similarity("Large pothole near school", ["Big pothole outside school", "Noise at night"])
        self.assertGreater(sims[0], sims[1])


class KeywordTests(unittest.TestCase):
    def test_spec_keywords(self):
        keywords = keyword_extractor.extract_keywords(SPEC_EXAMPLE)
        for keyword in ("pothole", "school", "traffic"):
            self.assertIn(keyword, keywords)
        self.assertEqual(keywords, [k.lower() for k in keywords])

    def test_top_k_and_empty(self):
        self.assertLessEqual(len(keyword_extractor.extract_keywords(
            "Garbage dumped near the vegetable market for 2 weeks, smell and mosquitoes everywhere", top_k=3)), 3)
        self.assertEqual(keyword_extractor.extract_keywords(""), [])
        self.assertIn("live wire", keyword_extractor.extract_keywords("A live wire is hanging from the pole near the bus stop"))


class ImpactTests(unittest.TestCase):
    def _impact(self, text, category):
        return impact.assess_impact(preprocess(text), category=category)

    def test_negation_counts_partially(self):
        negated = self._impact("There has been no accident yet on this road", "pothole")["safety_score"]
        happened = self._impact("There has been an accident on this road", "pothole")["safety_score"]
        self.assertGreater(negated, 0.0)
        self.assertLess(negated, happened)

    def test_clause_ends_negation_scope(self):
        result = self._impact("No streetlight, accidents happen daily near the junction", "streetlight")
        evidence = result["impacts"][0]["evidence"]
        self.assertIn("accident", evidence)
        self.assertNotIn("accident (negated)", evidence)

    def test_critical_hazard_near_vulnerable_people(self):
        result = self._impact("Live wire hanging near the school gate, children pass daily", "streetlight")
        self.assertEqual(result["severity_hint"], "critical")
        self.assertIn("school gate", result["location_mentions"])

    def test_urgency_from_duration_and_escalation(self):
        plain = self._impact("Garbage not collected", "garbage")["urgency_score"]
        urgent = self._impact("Garbage not collected for 3 weeks, complained many times, please act urgently",
                              "garbage")
        self.assertGreater(urgent["urgency_score"], plain + 0.4)
        self.assertEqual(urgent["signals"]["duration_days"], 21)

    def test_impact_types_and_ordering(self):
        result = self._impact("Dirty water is entering the houses and mosquitoes are breeding", "drainage")
        types = [i["type"] for i in result["impacts"]]
        self.assertEqual(types[0], "health")
        self.assertIn("property", types)
        self.assertTrue(all(set(i) == {"type", "label", "score", "evidence"} for i in result["impacts"]))


class SentimentTests(unittest.TestCase):
    def test_contract_keys(self):
        result = sentiment.analyze_sentiment("Good work")
        for key in ("label", "score", "confidence", "model_version", "mode", "is_demo", "method", "explanation"):
            self.assertIn(key, result)
        self.assertEqual(result["model_version"], "demo-lexicon-sentiment-1.0")
        self.assertTrue(-1.0 <= result["score"] <= 1.0)

    def test_spec_examples(self):
        positive = sentiment.analyze_sentiment("The issue was resolved quickly.")
        self.assertEqual(positive["label"], "positive")
        self.assertEqual(positive["method"], "lexicon")
        self.assertTrue(positive["explanation"].startswith("Demo AI Mode"))
        self.assertEqual(sentiment.analyze_sentiment("Still not fixed after 3 weeks, useless")["label"], "negative")
        rating_only = sentiment.analyze_sentiment("", rating=3)
        self.assertEqual(rating_only["label"], "neutral")
        self.assertEqual(rating_only["method"], "rating_only")
        self.assertEqual(sentiment.analyze_sentiment("   ", rating=1)["label"], "negative")

    def test_rating_conflict_keeps_text_label(self):
        alone = sentiment.analyze_sentiment("Still not fixed, useless")
        conflict = sentiment.analyze_sentiment("Still not fixed, useless", rating=5)
        self.assertEqual(conflict["label"], "negative")
        self.assertLess(conflict["confidence"], alone["confidence"])
        self.assertEqual(conflict["rating_agreement"], "conflict")
        self.assertIn("rating", conflict["explanation"])

    def test_neutral_text_follows_rating(self):
        result = sentiment.analyze_sentiment("The officer visited the site today.", rating=5)
        self.assertEqual(result["label"], "positive")
        self.assertEqual(result["rating_agreement"], "rating_decided")

    def test_negation_contrast_and_hinglish(self):
        self.assertEqual(sentiment.analyze_sentiment("Not bad at all, they fixed it in a day.")["label"], "positive")
        self.assertEqual(sentiment.analyze_sentiment(
            "They resolved it quickly but it broke again within a week.")["label"], "negative")
        self.assertEqual(sentiment.analyze_sentiment("They did not even inspect the site.")["label"], "negative")
        self.assertEqual(sentiment.analyze_sentiment("Bahut accha kaam kiya, thank you")["label"], "positive")
        self.assertEqual(sentiment.analyze_sentiment("Bilkul bekar kaam, kuch nahi hua")["label"], "negative")

    def test_demo_accuracy_on_feedback_corpus(self):
        rows = load_feedback()
        correct = sum(sentiment.analyze_sentiment(r["text"])["label"] == r["label"] for r in rows)
        self.assertGreaterEqual(correct / len(rows), 0.8)


class CorpusTests(unittest.TestCase):
    def test_complaint_corpus_shape(self):
        rows = load_complaints()
        counts = {c: 0 for c in CIVIC_CLASSES}
        for row in rows:
            counts[row["label"]] += 1
            self.assertIn(row["severity"], ("low", "medium", "high", "critical"))
        self.assertEqual(set(counts), set(CIVIC_CLASSES))
        self.assertTrue(all(n >= 70 for n in counts.values()), counts)

    def test_feedback_corpus_shape(self):
        rows = load_feedback()
        self.assertGreaterEqual(len(rows), 150)
        self.assertEqual({r["label"] for r in rows}, {"positive", "neutral", "negative"})

    def test_generator_reproduces_committed_csv(self):
        with open(COMPLAINT_CORPUS, encoding="utf-8", newline="") as handle:
            committed = [tuple(row) for row in list(csv.reader(handle))[1:]]
        self.assertEqual(committed, build_corpus.generate_complaints())
        with open(FEEDBACK_CORPUS, encoding="utf-8", newline="") as handle:
            committed_feedback = [tuple(row) for row in list(csv.reader(handle))[1:]]
        self.assertEqual(committed_feedback, build_corpus.generate_feedback())


class DescribeModelsTests(unittest.TestCase):
    def test_entries(self):
        analyze_text(SPEC_EXAMPLE)
        models = describe_models()
        self.assertEqual([m["name"] for m in models],
                         ["nlp.text_classifier", "nlp.embedder", "nlp.sentiment", "nlp.keywords"])
        for entry in models:
            self.assertEqual(set(entry), {"name", "task", "framework", "version", "status", "is_demo", "detail"})
            self.assertIn(entry["status"], ("active", "available", "fallback", "not_installed", "weights_missing", "error"))
        self.assertEqual(models[0]["status"], "active")

    def test_warm_up_loads_every_component(self):
        from ai.nlp import warm_up

        self.assertEqual({m["status"] for m in warm_up()}, {"active"})


class _FakeEncoder:
    """Deterministic stand-in for SentenceTransformer: hashed bag-of-words, L2-normalised."""

    def encode(self, texts, **kwargs):
        from sklearn.feature_extraction.text import HashingVectorizer

        matrix = HashingVectorizer(n_features=256, alternate_sign=False, norm="l2").transform(list(texts))
        return matrix.toarray().astype(np.float32)

    def get_embedding_dimension(self):
        return 256


def _fake_sentiment_pipeline(text, **kwargs):
    lowered = text.lower()
    positive = 0.9 if "thank" in lowered or "good" in lowered else 0.05
    negative = 0.9 if "useless" in lowered or "worst" in lowered else 0.05
    neutral = max(0.0, 1.0 - positive - negative)
    return [[{"label": "negative", "score": negative}, {"label": "neutral", "score": neutral},
             {"label": "positive", "score": positive}]]


class ProductionModeTests(unittest.TestCase):
    """Production code paths with mocked backends (no downloads)."""

    def setUp(self):
        self._mode = os.environ.get("MODEL_MODE")
        os.environ["MODEL_MODE"] = "production"
        self._tmp = tempfile.mkdtemp()
        self._dir = mock.patch.object(classifier, "model_dir", return_value=Path(self._tmp))
        self._dir.start()
        reset_registry()

    def tearDown(self):
        self._dir.stop()
        shutil.rmtree(self._tmp, ignore_errors=True)
        os.environ["MODEL_MODE"] = self._mode or "demo"
        reset_registry()

    def test_graceful_fallback_when_models_unavailable(self):
        failed = backends.Backend(name="fake/model", model=None, error="ImportError: no sentence_transformers")
        failed_sentiment = backends.Backend(name="fake/sentiment", model=None, error="OSError: offline")
        with mock.patch.object(backends, "sentence_transformer", return_value=failed), \
                mock.patch.object(backends, "sentiment_pipeline", return_value=failed_sentiment):
            result = analyze_text(SPEC_EXAMPLE)
            self.assertEqual(result["mode"], "production")
            self.assertTrue(result["is_demo"])
            self.assertEqual(result["category"], "pothole")
            self.assertIn("ImportError", result["fallback_reason"])
            self.assertIn("demo technique", result["explanation"])
            feedback = sentiment.analyze_sentiment("The issue was resolved quickly.")
            self.assertEqual(feedback["method"], "lexicon")
            self.assertEqual(feedback["label"], "positive")
            self.assertIn("offline", feedback["fallback_reason"])
            embedder = embedding.get_text_embedder()
            self.assertTrue(embedder.is_demo)
            self.assertIn("unavailable", embedder.fallback_reason)
            statuses = {m["name"]: m["status"] for m in describe_models()}
            self.assertEqual(statuses["nlp.text_classifier"], "fallback")
            self.assertEqual(statuses["nlp.sentiment"], "fallback")

    def test_production_paths_with_mocked_models(self):
        encoder = backends.Backend(name="sentence-transformers/all-MiniLM-L6-v2", model=_FakeEncoder())
        pipe = backends.Backend(name="cardiffnlp/twitter-roberta-base-sentiment-latest", model=_fake_sentiment_pipeline)
        with mock.patch.object(backends, "sentence_transformer", return_value=encoder), \
                mock.patch.object(backends, "sentiment_pipeline", return_value=pipe):
            result = analyze_text(SPEC_EXAMPLE, categories=[STRAY])
            self.assertFalse(result["is_demo"])
            self.assertIsNone(result["fallback_reason"])
            self.assertTrue(result["model_version"].startswith("st-"))
            self.assertIn(result["category"], result["probabilities"])
            self.assertTrue(result["keywords"])
            self.assertTrue(os.path.exists(os.path.join(self._tmp, classifier.PRODUCTION_FILE)))
            embedder = embedding.get_text_embedder()
            self.assertFalse(embedder.is_demo)
            self.assertEqual(embedder.encode(["a pothole", "garbage"]).shape, (2, 256))
            happy = sentiment.analyze_sentiment("Good work, thank you")
            self.assertEqual((happy["label"], happy["method"]), ("positive", "transformer"))
            self.assertTrue(math.isclose(happy["score"], 0.85, abs_tol=1e-6))
            conflict = sentiment.analyze_sentiment("useless, worst", rating=5)
            self.assertEqual((conflict["label"], conflict["rating_agreement"]), ("negative", "conflict"))
            statuses = {m["name"]: (m["status"], m["is_demo"]) for m in describe_models()}
            self.assertEqual(statuses["nlp.text_classifier"], ("active", False))
            self.assertEqual(statuses["nlp.sentiment"], ("active", False))


if __name__ == "__main__":
    unittest.main()
