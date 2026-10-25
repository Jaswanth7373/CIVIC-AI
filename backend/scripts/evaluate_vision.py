"""Evaluate the CivicAI vision module on the generated sample images.

Usage (from ``backend/``)::

    venv/Scripts/python.exe scripts/evaluate_vision.py
    venv/Scripts/python.exe scripts/evaluate_vision.py --include-unchanged --min-accuracy 0.8

Every image listed in ``sample_data/images/manifest.json`` is analysed with
``ai.vision.analyze_image(path, filename_hint=None)`` - **no filename hints**, so the score reflects
what the technique sees in the pixels. The script prints

* top-1 accuracy,
* per-class precision / recall / F1 and macro averages,
* a confusion matrix (rows = true class, columns = predicted class),
* localisation quality (IoU of the predicted box with the ground-truth defect box),
* mean confidence and processing time,

and writes everything (plus per-image predictions) to ``sample_data/vision_eval.json``.

The technique used is whatever ``MODEL_MODE`` selects (demo heuristics by default; set
``MODEL_MODE=production`` to evaluate CLIP / YOLO). The synthetic photos are far easier than real
street photos - the demo technique is labelled "Demo AI Mode" for exactly that reason.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from ai.config import CIVIC_CLASSES, get_model_mode  # noqa: E402
from ai.vision import analyze_image  # noqa: E402
from ai.vision.postprocessing import box_iou  # noqa: E402

IMAGES_DIR = BACKEND_DIR / "sample_data" / "images"
OUTPUT = BACKEND_DIR / "sample_data" / "vision_eval.json"


def load_samples(images_dir: Path, include_unchanged: bool) -> list[dict]:
    """``[{"path", "file", "label", "box"}]`` from the manifest (or a folder scan when it is missing)."""
    manifest = images_dir / "manifest.json"
    samples = []
    if manifest.is_file():
        for entry in json.loads(manifest.read_text(encoding="utf-8"))["images"]:
            samples.append({"file": entry["file"], "label": entry["label"], "box": entry.get("box")})
            if include_unchanged and entry.get("unchanged"):
                samples.append({"file": entry["unchanged"], "label": entry["label"], "box": entry.get("unchanged_box")})
    else:
        for slug in CIVIC_CLASSES:
            for path in sorted((images_dir / slug).glob("*.jpg")):
                samples.append({"file": f"{slug}/{path.name}", "label": slug, "box": None})
    for sample in samples:
        sample["path"] = images_dir / sample["file"]
    return [s for s in samples if s["path"].is_file()]


def evaluate(samples: list[dict]) -> dict:
    predictions = []
    for sample in samples:
        result = analyze_image(sample["path"], filename_hint=None)
        iou, localised = None, None
        if sample["box"] and result["category"] == sample["label"]:
            boxes = [o["box"] for o in result["detected_objects"] if o["label"] == sample["label"]]
            localised = bool(boxes)   # the "other" class has no defect box by design
            if boxes:
                iou = max(box_iou(b, sample["box"]) for b in boxes)
        predictions.append({
            "file": sample["file"], "label": sample["label"], "predicted": result["category"],
            "confidence": result["confidence"], "iou": None if iou is None else round(iou, 3), "localised": localised,
            "processing_time_ms": result["processing_time_ms"], "model_version": result["model_version"],
            "is_demo": result["is_demo"], "fallback_reason": result["fallback_reason"],
        })
    return summarise(predictions)


def summarise(predictions: list[dict]) -> dict:
    labels = list(CIVIC_CLASSES) + sorted({p["predicted"] for p in predictions} - set(CIVIC_CLASSES))
    index = {label: i for i, label in enumerate(labels)}
    matrix = [[0] * len(labels) for _ in labels]
    for p in predictions:
        matrix[index[p["label"]]][index[p["predicted"]]] += 1
    per_class = {}
    for label in labels:
        i = index[label]
        tp = matrix[i][i]
        support = sum(matrix[i])
        predicted = sum(row[i] for row in matrix)
        precision = tp / predicted if predicted else 0.0
        recall = tp / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        if support or predicted:
            per_class[label] = {"precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3),
                                "support": support}
    evaluated = [c for c in per_class.values() if c["support"]]
    correct = [p for p in predictions if p["predicted"] == p["label"]]
    wrong = [p for p in predictions if p["predicted"] != p["label"]]
    ious = [p["iou"] for p in correct if p["iou"] is not None]

    def mean(values):
        return round(sum(values) / len(values), 3) if values else None

    first = predictions[0] if predictions else {}
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mode": get_model_mode(),
        "model_version": first.get("model_version"),
        "is_demo": first.get("is_demo"),
        "fallback_reason": first.get("fallback_reason"),
        "filename_hints": False,
        "images": len(predictions),
        "accuracy": round(len(correct) / len(predictions), 4) if predictions else 0.0,
        "macro_precision": mean([c["precision"] for c in evaluated]),
        "macro_recall": mean([c["recall"] for c in evaluated]),
        "macro_f1": mean([c["f1"] for c in evaluated]),
        "per_class": per_class,
        "confusion_matrix": {"labels": labels, "rows": "true class", "columns": "predicted class", "matrix": matrix},
        "mean_confidence_correct": mean([p["confidence"] for p in correct]),
        "mean_confidence_wrong": mean([p["confidence"] for p in wrong]),
        "localisation": {"mean_iou": mean(ious), "iou_at_least_0_5": mean([1.0 if v >= 0.5 else 0.0 for v in ious]),
                         "evaluated": len(ious), "without_box": sum(1 for p in correct if p["localised"] is False)},
        "mean_processing_ms": mean([p["processing_time_ms"] for p in predictions]),
        "predictions": predictions,
    }


def print_report(report: dict) -> None:
    labels = report["confusion_matrix"]["labels"]
    short = {label: label[:7] for label in labels}
    print(f"\nCivicAI vision evaluation - mode={report['mode']}  model={report['model_version']}  "
          f"(filename hints: off)")
    if report["fallback_reason"]:
        print(f"Fallback reason: {report['fallback_reason']}")
    print(f"Images: {report['images']}   Top-1 accuracy: {report['accuracy']:.1%}   "
          f"Macro P/R/F1: {report['macro_precision']:.3f} / {report['macro_recall']:.3f} / {report['macro_f1']:.3f}")
    print("\nPer class:")
    print(f"  {'class':<14}{'precision':>10}{'recall':>9}{'f1':>8}{'support':>9}")
    for label, m in report["per_class"].items():
        print(f"  {label:<14}{m['precision']:>10.3f}{m['recall']:>9.3f}{m['f1']:>8.3f}{m['support']:>9}")
    print("\nConfusion matrix (rows = true, columns = predicted):")
    print("  " + " " * 14 + "".join(f"{short[l]:>8}" for l in labels))
    for label, row in zip(labels, report["confusion_matrix"]["matrix"]):
        print(f"  {label:<14}" + "".join(f"{v:>8}" for v in row))
    loc = report["localisation"]
    if loc["evaluated"]:
        print(f"\nLocalisation (correct predictions with a ground-truth box): mean IoU {loc['mean_iou']:.3f}, "
              f"IoU >= 0.5 for {loc['iou_at_least_0_5']:.0%} of {loc['evaluated']}"
              + (f"; {loc['without_box']} correct predictions have no box by design (class 'other')"
                 if loc["without_box"] else ""))
    print(f"Mean confidence: correct {report['mean_confidence_correct']}, wrong {report['mean_confidence_wrong']}; "
          f"mean processing time {report['mean_processing_ms']} ms/image")
    wrong = [p for p in report["predictions"] if p["predicted"] != p["label"]]
    if wrong:
        print("\nMisclassified:")
        for p in wrong:
            print(f"  {p['file']:<40} true={p['label']:<13} predicted={p['predicted']:<13} conf={p['confidence']:.2f}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate ai.vision on the generated sample images.")
    parser.add_argument("--images", type=Path, default=IMAGES_DIR, help="folder with manifest.json")
    parser.add_argument("--output", type=Path, default=OUTPUT, help="where to write the JSON report")
    parser.add_argument("--include-unchanged", action="store_true",
                        help="also evaluate the re-shot 'unchanged' images (same labels, different camera/light)")
    parser.add_argument("--min-accuracy", type=float, default=0.0,
                        help="exit with status 1 when the accuracy is below this value (for CI)")
    args = parser.parse_args(argv)

    samples = load_samples(args.images, args.include_unchanged)
    if not samples:
        print(f"No sample images found in {args.images}. Run scripts/generate_sample_images.py first.")
        return 1
    started = time.perf_counter()
    report = evaluate(samples)
    report["wall_time_s"] = round(time.perf_counter() - started, 1)
    print_report(report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8", newline="\n")
    print(f"\nReport written to {args.output}")
    if report["accuracy"] < args.min_accuracy:
        print(f"Accuracy {report['accuracy']:.1%} is below the required {args.min_accuracy:.0%}.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
