"""Train and evaluate the CivicAI complaint text classifier (and evaluate the other NLP components).

Usage (from ``backend/``)::

    venv/Scripts/python.exe scripts/train_text_classifier.py --mode demo
    venv/Scripts/python.exe scripts/train_text_classifier.py --mode production   # needs sentence-transformers

Steps
    1. Stratified 80/20 split of ``ai/nlp/data/complaint_corpus.csv`` (``random_state=42``): fit on
       80%, report accuracy, macro-F1, a per-class classification report and the confusion matrix
       on the held-out 20%.
    2. Train on the *full* corpus and save the cached model used at runtime
       (``ml_models/nlp/text_clf_demo.joblib`` / ``text_clf_st.joblib``).
    3. Generalisation check of that deployed model on ``complaint_challenge.csv`` - 90 hand-written
       complaints never used for training - alone and with keyword blending using the default
       category keywords (the lists ``init_civicai`` seeds, BUILD_SPEC section 1).
    4. Sentiment evaluation on ``feedback_corpus.csv`` (development set) and
       ``feedback_challenge.csv`` (held-out) with the technique of the selected mode.
    5. Agreement of the text severity hint with the corpus ``severity`` column, then everything is
       written to ``ml_models/nlp/report_<mode>.json``.

The template corpus is synthetic, so its hold-out score mostly measures template coverage; the
challenge-set numbers are the honest estimate of performance on unseen phrasing.
"""
import argparse
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# Default category keywords (BUILD_SPEC section 1) - used only to evaluate keyword blending.
DEFAULT_CATEGORY_KEYWORDS = {
    "pothole": ["pothole", "pit", "crater", "gaddha", "khadda", "broken road"],
    "garbage": ["garbage", "trash", "waste", "dump", "kachra", "chetta"],
    "drainage": ["drain", "sewage", "waterlogging", "flooded", "nala", "overflow"],
    "streetlight": ["streetlight", "light not working", "dark", "pole", "bulb", "current", "bijli", "electric wire"],
    "water_leak": ["leak", "pipeline", "burst", "water wastage", "paani", "tap"],
    "open_manhole": ["manhole", "open drain cover", "uncovered"],
    "road_crack": ["crack", "damaged road", "uneven", "broken asphalt"],
    "fallen_tree": ["tree", "branch", "fallen", "uprooted", "chettu", "obstruction", "blocked road"],
    "other": [],
}
LEVELS = ["low", "medium", "high", "critical"]


def parse_args():
    parser = argparse.ArgumentParser(description="Train and evaluate the CivicAI text classifier.")
    parser.add_argument("--mode", choices=["demo", "production"], default="demo",
                        help="demo = TF-IDF + logistic regression; production = Sentence-Transformer + logistic regression")
    parser.add_argument("--test-size", type=float, default=0.2, help="hold-out fraction (default 0.2)")
    parser.add_argument("--seed", type=int, default=42, help="random_state of the stratified split")
    return parser.parse_args()


def confusion_table(labels, matrix):
    width = max(len(label) for label in labels)
    short = [label[:7] for label in labels]
    lines = [" " * (width + 2) + " ".join(f"{s:>7}" for s in short)]
    for label, row in zip(labels, matrix):
        lines.append(f"{label:>{width}}  " + " ".join(f"{v:>7}" for v in row))
    return "\n".join(lines)


def metrics(y_true, y_pred, labels):
    from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score

    return {
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 4),
        "macro_f1": round(float(f1_score(y_true, y_pred, labels=labels, average="macro", zero_division=0)), 4),
        "weighted_f1": round(float(f1_score(y_true, y_pred, labels=labels, average="weighted", zero_division=0)), 4),
        "per_class": {
            label: {k: round(float(v), 4) for k, v in values.items()}
            for label, values in classification_report(y_true, y_pred, labels=labels, output_dict=True,
                                                       zero_division=0).items()
            if label in labels
        },
        "confusion_matrix": {"labels": labels,
                             "matrix": confusion_matrix(y_true, y_pred, labels=labels).tolist()},
        "_report": classification_report(y_true, y_pred, labels=labels, digits=3, zero_division=0),
    }


def print_metrics(title, result):
    print(f"\n=== {title} ===")
    print(f"accuracy {result['accuracy']:.4f} | macro-F1 {result['macro_f1']:.4f} | weighted-F1 {result['weighted_f1']:.4f}")
    print(result["_report"])
    print("confusion matrix (rows = true, columns = predicted):")
    print(confusion_table(result["confusion_matrix"]["labels"], result["confusion_matrix"]["matrix"]))


def strip_private(result):
    return {k: v for k, v in result.items() if not k.startswith("_")}


def main():
    args = parse_args()
    os.environ["MODEL_MODE"] = args.mode  # every ai.* module reads the mode at call time
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    import numpy as np
    import sklearn
    from sklearn.model_selection import train_test_split

    from ai.config import MODEL_PATH
    from ai.nlp import backends, classifier
    from ai.nlp.corpus import (COMPLAINT_CORPUS, file_sha256, load_challenge, load_feedback,
                               load_feedback_challenge, preprocessed_complaints)
    from ai.nlp.impact import assess_impact
    from ai.nlp.sentiment import analyze_sentiment
    from ai.nlp.text_preprocessor import preprocess

    started = time.perf_counter()
    rows, preps = preprocessed_complaints()
    labels = [r["label"] for r in rows]
    classes = sorted(set(labels))
    print(f"CivicAI text classifier - mode={args.mode}")
    print(f"Corpus: {COMPLAINT_CORPUS.name}, {len(rows)} rows, {len(classes)} classes "
          f"({', '.join(f'{c}={labels.count(c)}' for c in classes)})")

    encoder = None
    if args.mode == "production":
        backend = backends.sentence_transformer()
        if not backend.ok:
            print(f"ERROR: production embedder unavailable: {backend.error}")
            print("Install requirements-ml.txt (sentence-transformers) or run with --mode demo.")
            return 2
        encoder = backend.model
        print(f"Embedder: {backend.name} (loaded in {backend.load_seconds:.1f}s)")

    # 1. stratified hold-out ------------------------------------------------------------------
    indices = np.arange(len(rows))
    train_idx, test_idx = train_test_split(indices, test_size=args.test_size, stratify=labels,
                                           random_state=args.seed)
    def probabilities(model, items):
        if args.mode == "demo":
            return model.predict_proba([classifier.features(p) for p in items])
        return model.predict_proba(classifier.encode_canonical(encoder, items))

    def predict(model, items):
        return [str(model.classes_[i]) for i in probabilities(model, items).argmax(axis=1)]

    t0 = time.perf_counter()
    train_preps = [preps[i] for i in train_idx]
    train_labels = [labels[i] for i in train_idx]
    if args.mode == "demo":
        split_model = classifier.train_demo(train_preps, train_labels)
    else:
        split_model = classifier.train_production(train_preps, train_labels, encoder)
    train_seconds = time.perf_counter() - t0
    test_preps = [preps[i] for i in test_idx]
    y_test = [labels[i] for i in test_idx]
    y_pred = predict(split_model, test_preps)
    holdout = metrics(y_test, y_pred, classes)
    holdout["misclassified"] = [
        {"text": rows[i]["text"], "true": t, "predicted": p}
        for i, t, p in zip(test_idx, y_test, y_pred) if t != p
    ][:20]
    print_metrics(f"Stratified hold-out ({len(train_idx)} train / {len(test_idx)} test, "
                  f"trained in {train_seconds:.2f}s)", holdout)

    # 2. full-corpus training (the deployed model) ---------------------------------------------
    t0 = time.perf_counter()
    model, info = classifier.load_or_train(args.mode, encoder, force=True)
    full_seconds = time.perf_counter() - t0
    cache_path = classifier.model_dir() / (classifier.DEMO_FILE if args.mode == "demo" else classifier.PRODUCTION_FILE)
    print(f"\nTrained on the full corpus ({info['rows']} rows) in {full_seconds:.2f}s -> {cache_path}")

    # 3. hand-written challenge set (deployed model) --------------------------------------------
    challenge_rows = load_challenge()
    challenge_preps = [preprocess(r["text"]) for r in challenge_rows]
    y_challenge = [r["label"] for r in challenge_rows]
    challenge_pred = predict(model, challenge_preps)
    challenge = metrics(y_challenge, challenge_pred, classes)
    categories = [{"slug": slug, "name": slug, "keywords": kws} for slug, kws in DEFAULT_CATEGORY_KEYWORDS.items()]
    model_classes = [str(c) for c in model.classes_]
    blended_pred = []
    for prep, row_proba in zip(challenge_preps, probabilities(model, challenge_preps)):
        hits = classifier.keyword_scores(prep, categories, tuple(model_classes))
        blended = classifier.blend_keyword_scores(dict(zip(model_classes, map(float, row_proba))), hits)
        blended_pred.append(max(blended, key=blended.get))
    blended = metrics(y_challenge, blended_pred, classes)
    challenge["accuracy_with_keywords"] = blended["accuracy"]
    challenge["macro_f1_with_keywords"] = blended["macro_f1"]
    challenge["misclassified"] = [
        {"text": r["text"], "true": t, "predicted": p, "predicted_with_keywords": b}
        for r, t, p, b in zip(challenge_rows, y_challenge, challenge_pred, blended_pred) if t != p or t != b
    ]
    print_metrics(f"Hand-written challenge set ({len(challenge_rows)} unseen complaints, deployed model only)",
                  challenge)
    print(f"with default category keyword blending: accuracy {blended['accuracy']:.4f}, "
          f"macro-F1 {blended['macro_f1']:.4f}")
    for item in challenge["misclassified"]:
        print(f"  [{item['true']} -> {item['predicted']} / kw {item['predicted_with_keywords']}] {item['text']}")

    # 4. sentiment ------------------------------------------------------------------------------
    sentiment_report = {}
    sentiment_labels = ["positive", "neutral", "negative"]
    for name, loader in (("feedback_corpus", load_feedback), ("feedback_challenge", load_feedback_challenge)):
        feedback = loader()
        t0 = time.perf_counter()
        outputs = [analyze_sentiment(r["text"]) for r in feedback]
        seconds = time.perf_counter() - t0
        result = metrics([r["label"] for r in feedback], [o["label"] for o in outputs], sentiment_labels)
        result["rows"] = len(feedback)
        result["method"] = outputs[0]["method"] if outputs else None
        result["model_version"] = outputs[0]["model_version"] if outputs else None
        result["fallback_reason"] = outputs[0].get("fallback_reason") if outputs else None
        result["seconds"] = round(seconds, 2)
        result["errors"] = [
            {"text": r["text"], "true": r["label"], "predicted": o["label"], "score": o["score"]}
            for r, o in zip(feedback, outputs) if r["label"] != o["label"]
        ]
        title = "Sentiment - development set" if name == "feedback_corpus" else "Sentiment - held-out set"
        print_metrics(f"{title} ({name}.csv, {len(feedback)} rows, method={result['method']})", result)
        sentiment_report[name] = strip_private(result)

    # 5. severity hint agreement + report -------------------------------------------------------
    exact = within_one = 0
    severity_conf = [[0] * 4 for _ in LEVELS]
    for row, prep in zip(rows, preps):
        hint = assess_impact(prep, category=row["label"])["severity_hint"]
        true_i, pred_i = LEVELS.index(row["severity"]), LEVELS.index(hint)
        severity_conf[true_i][pred_i] += 1
        exact += true_i == pred_i
        within_one += abs(true_i - pred_i) <= 1
    severity = {"exact_accuracy": round(exact / len(rows), 4), "within_one_level": round(within_one / len(rows), 4),
                "confusion_matrix": {"labels": LEVELS, "matrix": severity_conf}}
    print("\n=== Text severity hint vs corpus severity labels ===")
    print(f"exact {severity['exact_accuracy']:.4f} | within one level {severity['within_one_level']:.4f}")
    print(confusion_table(LEVELS, severity_conf))

    report = {
        "mode": args.mode,
        "model_version": classifier.MODEL_VERSION_DEMO if args.mode == "demo" else classifier.production_model_version(),
        "technique": classifier.DEMO_TECHNIQUE if args.mode == "demo" else classifier.PRODUCTION_TECHNIQUE,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "accuracy": holdout["accuracy"],
        "macro_f1": holdout["macro_f1"],
        "corpus": {"file": COMPLAINT_CORPUS.name, "rows": len(rows), "sha256": file_sha256(COMPLAINT_CORPUS),
                   "class_counts": {c: labels.count(c) for c in classes}},
        "split": {"test_size": args.test_size, "random_state": args.seed, "stratified": True,
                  "train_rows": int(len(train_idx)), "test_rows": int(len(test_idx)),
                  "train_seconds": round(train_seconds, 2)},
        "holdout": strip_private(holdout),
        "challenge": strip_private(challenge),
        "sentiment": sentiment_report,
        "severity_hint": severity,
        "full_training": {"rows": info["rows"], "seconds": round(full_seconds, 2), "cache": str(cache_path)},
        "environment": {"python": platform.python_version(), "scikit_learn": sklearn.__version__,
                        "numpy": np.__version__},
        "seconds_total": round(time.perf_counter() - started, 2),
    }
    report_path = MODEL_PATH / "nlp" / f"report_{args.mode}.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nReport written to {report_path}")
    print(f"Total time {report['seconds_total']:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
