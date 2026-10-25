"""Train the CivicAI YOLOv8 civic-issue detector and install it for ``MODEL_MODE=production``.

Usage (from ``backend/``)::

    venv/Scripts/python.exe scripts/train_yolo.py --data ai/vision/dataset.yaml --epochs 100
    venv/Scripts/python.exe scripts/train_yolo.py --check-only                  # validate the dataset only
    venv/Scripts/python.exe scripts/train_yolo.py --prepare-samples --epochs 20  # pipeline test (synthetic)
    venv/Scripts/python.exe scripts/train_yolo.py --data ai/vision/dataset.yaml --export onnx

What it does

1. Checks that ``ultralytics`` is installed (``pip install -r requirements-ml.txt``) and explains how to
   fix it if not. ``--check-only`` and ``--prepare-samples`` work without it.
2. Resolves the dataset YAML (a relative ``path`` is taken relative to the YAML file) and validates every
   label file: 5 numbers per line, class id in range, coordinates normalised to 0..1.
3. Fine-tunes a COCO-pretrained YOLOv8 model (``--model yolov8n.pt`` is downloaded automatically). This is
   *transfer learning*: the backbone already recognises edges, textures and shapes, so a few hundred
   labelled photos per class are enough to learn the civic classes.
4. Copies the best checkpoint (highest validation mAP@0.5:0.95) to ``ml_models/yolo/civicai_yolov8.pt``
   (= ``YOLO_WEIGHTS``), where ``ai.vision`` picks it up automatically in production mode, and writes a
   small JSON summary next to it.
5. Prints validation precision, recall, mAP@0.5 and mAP@0.5:0.95, and optionally exports the model
   (``--export onnx`` / ``torchscript`` / ``openvino`` ...).

Recommended public datasets (convert to YOLO format and remap the class ids to ``ai/vision/dataset.yaml``)

* **RDD2022** - Road Damage Detection 2022 (Arya et al., CRDDC'22): ~47,000 road images from India,
  Japan, Czech Republic, Norway, USA and China. D00 longitudinal / D10 transverse / D20 alligator cracks
  -> ``road_crack``; D40 potholes -> ``pothole``.
* **Roboflow Universe pothole datasets** (e.g. "Pothole Detection", several hundred annotated photos)
  -> ``pothole``.
* **TACO** - Trash Annotations in Context (Proenca & Simoes, 2020): ~1,500 images, 60 litter classes; merge
  all classes -> ``garbage``.
* **Open Images V7** - "Street light" and "Tree" boxes (relabel fallen / blocking trees by hand)
  -> ``streetlight`` / ``fallen_tree``.
* **Roboflow Universe manhole / flooded-road / water-leak sets** -> ``open_manhole`` / ``drainage`` /
  ``water_leak``.
* **CivicAI's own data** - complaint photos whose category an officer or admin confirmed (box them with a
  tool such as CVAT or Label Studio and export "YOLO 1.1").

Put the converted data in ``ml_models/datasets/civicai/{images,labels}/{train,val}`` (the default ``path``
of ``ai/vision/dataset.yaml``) and run this script. ``--prepare-samples`` instead exports the generated
synthetic sample photos (``sample_data/``) with their ground-truth boxes to YOLO format - useful to test
the training pipeline end to end, not to train a model for real photos.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from ai.config import CIVIC_CLASSES, DEVICE, MODEL_PATH, YOLO_WEIGHTS  # noqa: E402

DEFAULT_DATA = BACKEND_DIR / "ai" / "vision" / "dataset.yaml"
SAMPLES_DIR = BACKEND_DIR / "sample_data"
RUNS_DIR = MODEL_PATH / "yolo" / "runs"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}

ULTRALYTICS_HELP = """\
The 'ultralytics' package (YOLOv8) is not installed in this Python environment.

Install the deep-learning requirements and run the script again:
    venv/Scripts/python.exe -m pip install -r requirements-ml.txt
or just the detector library:
    venv/Scripts/python.exe -m pip install "ultralytics>=8.3"

Until then CivicAI keeps working: in MODEL_MODE=production the vision module falls back to CLIP zero-shot
classification (or the demo OpenCV heuristics) and reports the fallback reason."""


# ------------------------------------------------------------------------------------------------------
# Dataset helpers (no ultralytics needed)
# ------------------------------------------------------------------------------------------------------
def load_yaml(path: Path) -> dict:
    try:
        import yaml
    except ImportError:
        sys.exit("PyYAML is required to read the dataset file: venv/Scripts/python.exe -m pip install pyyaml")
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def resolve_dataset(yaml_path: Path) -> tuple[dict, Path]:
    """Load a YOLO dataset YAML; return it with ``path`` made absolute (relative to the YAML file)."""
    data = load_yaml(yaml_path)
    root = Path(str(data.get("path") or "."))
    if not root.is_absolute():
        root = (yaml_path.parent / root).resolve()
    data["path"] = str(root)
    names = data.get("names") or {}
    data["names"] = {int(k): str(v) for k, v in names.items()} if isinstance(names, dict) else dict(enumerate(names))
    return data, root


def label_path(image: Path) -> Path:
    """Ultralytics convention: ``.../images/<sub>/x.jpg`` -> ``.../labels/<sub>/x.txt`` (last 'images')."""
    parts = list(image.parts)
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "images":
            parts[i] = "labels"
            break
    return Path(*parts).with_suffix(".txt")


def split_images(root: Path, entry) -> list[Path]:
    """Images of one split: a folder (searched recursively), a .txt list of image paths, or a list of those."""
    if not entry:
        return []
    if isinstance(entry, (list, tuple)):
        return [img for item in entry for img in split_images(root, item)]
    source = Path(str(entry))
    source = source if source.is_absolute() else root / source
    if source.is_dir():
        return sorted(p for p in source.rglob("*") if p.suffix.lower() in IMAGE_EXTS)
    if source.suffix == ".txt" and source.is_file():
        images = []
        for line in source.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            path = Path(line)
            if line.startswith("./"):   # relative to the list file, as Ultralytics does
                path = source.parent / line[2:]
            elif not path.is_absolute():
                path = root / path
            images.append(path.resolve())
        return images
    return []


def check_dataset(data: dict, root: Path) -> bool:
    """Print a per-split summary and validate every label line; returns True when training can start."""
    n_classes = len(data["names"])
    ok = True
    print(f"Dataset root: {root}")
    print(f"Classes ({n_classes}): " + ", ".join(f"{i}={n}" for i, n in sorted(data["names"].items())))
    for split in ("train", "val", "test"):
        images = split_images(root, data.get(split))
        if not images:
            if split in ("train", "val"):
                print(f"  {split:<5} no images found ({data.get(split)!r})")
                ok = False
            continue
        counts = [0] * n_classes
        missing_images = backgrounds = 0
        problems = []
        for image in images:
            if not image.is_file():
                missing_images += 1
                continue
            lbl = label_path(image)
            lines = lbl.read_text(encoding="utf-8").split("\n") if lbl.is_file() else []
            lines = [ln for ln in lines if ln.strip()]
            if not lines:
                backgrounds += 1
            for number, line in enumerate(lines, 1):
                parts = line.split()
                try:
                    cls = int(parts[0])
                    coords = [float(v) for v in parts[1:]]
                except (ValueError, IndexError):
                    problems.append(f"{lbl.name}:{number} is not '<class> <x> <y> <w> <h>'")
                    continue
                if len(coords) != 4 or not 0 <= cls < n_classes:
                    problems.append(f"{lbl.name}:{number} has class {cls} or {len(coords)} coordinates")
                elif not all(0.0 <= v <= 1.0 for v in coords) or coords[2] <= 0 or coords[3] <= 0:
                    problems.append(f"{lbl.name}:{number} coordinates must be normalised to 0..1")
                else:
                    counts[cls] += 1
        print(f"  {split:<5} {len(images)} images ({backgrounds} background, {missing_images} missing), objects per "
              "class: " + ", ".join(f"{data['names'][i]}={c}" for i, c in enumerate(counts)))
        for problem in problems[:10]:
            print(f"        ! {problem}")
        if problems or missing_images:
            ok = False
    return ok


def prepare_samples() -> Path:
    """Export the synthetic sample photos to YOLO format; returns the dataset YAML path.

    Writes ``sample_data/labels/**.txt`` (one box per issue photo, empty files for the repaired "after"
    photos = background examples), ``sample_data/yolo/{train,val}.txt`` (scene index % 5 == 0 -> val, so
    the three photos of one scene never leak across splits) and ``sample_data/yolo/civicai_samples.yaml``.
    """
    manifest_path = SAMPLES_DIR / "images" / "manifest.json"
    if not manifest_path.is_file():
        sys.exit("No sample images found - run scripts/generate_sample_images.py first.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    class_ids = {name: i for i, name in enumerate(CIVIC_CLASSES)}
    yolo_dir = SAMPLES_DIR / "yolo"
    yolo_dir.mkdir(parents=True, exist_ok=True)
    splits = {"train": [], "val": []}
    for entry in manifest["images"]:
        split = "val" if entry["index"] % 5 == 0 else "train"
        for file, box in ((entry["file"], entry["box"]), (entry["unchanged"], entry["unchanged_box"]),
                          (entry["after"], None)):
            image = SAMPLES_DIR / "images" / file
            lbl = label_path(image)
            lbl.parent.mkdir(parents=True, exist_ok=True)
            if box:
                x1, y1, x2, y2 = box
                lbl.write_text(f"{class_ids[entry['label']]} {(x1 + x2) / 2:.6f} {(y1 + y2) / 2:.6f} "
                               f"{x2 - x1:.6f} {y2 - y1:.6f}\n", encoding="utf-8", newline="\n")
            else:
                lbl.write_text("", encoding="utf-8", newline="\n")
            splits[split].append("./" + os.path.relpath(image, yolo_dir).replace("\\", "/"))
    for split, lines in splits.items():
        (yolo_dir / f"{split}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    names = "\n".join(f"  {i}: {name}" for i, name in enumerate(CIVIC_CLASSES))
    yaml_path = yolo_dir / "civicai_samples.yaml"
    yaml_path.write_text(
        "# Synthetic CivicAI sample photos in YOLO format (generated by scripts/train_yolo.py --prepare-samples).\n"
        "# Pipeline test only - a detector for real photos needs real photos (see scripts/train_yolo.py).\n"
        f"path: ..\ntrain: yolo/train.txt\nval: yolo/val.txt\nnames:\n{names}\n",
        encoding="utf-8", newline="\n",
    )
    print(f"Prepared {len(splits['train'])} training and {len(splits['val'])} validation images -> {yaml_path}")
    return yaml_path


# ------------------------------------------------------------------------------------------------------
# Training (needs ultralytics)
# ------------------------------------------------------------------------------------------------------
def require_ultralytics():
    """Return the ``ultralytics.YOLO`` class, or ``None`` after printing installation help."""
    try:
        from ultralytics import YOLO
    except ImportError:
        print(ULTRALYTICS_HELP)
        return None
    return YOLO


def train(args, data: dict, yolo_cls) -> int:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    resolved_yaml = RUNS_DIR / f"{args.name}_data.yaml"
    import yaml

    resolved_yaml.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8", newline="\n")
    device = args.device or DEVICE
    print(f"Fine-tuning {args.model} for {args.epochs} epochs at {args.imgsz}px on {device} ...")
    model = yolo_cls(args.model)
    model.train(data=str(resolved_yaml), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=device,
                project=str(RUNS_DIR), name=args.name, exist_ok=True, patience=args.patience,
                workers=args.workers, seed=args.seed)
    best = Path(model.trainer.best)
    if not best.is_file():
        print(f"Training finished but no best checkpoint was written ({best}).")
        return 1
    YOLO_WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, YOLO_WEIGHTS)
    print(f"Installed {best} -> {YOLO_WEIGHTS}")

    trained = yolo_cls(str(YOLO_WEIGHTS))
    metrics = trained.val(data=str(resolved_yaml), imgsz=args.imgsz, device=device, split="val")
    summary = {
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_model": args.model, "data": str(args.data), "epochs": args.epochs, "imgsz": args.imgsz,
        "classes": [data["names"][i] for i in sorted(data["names"])],
        "metrics": {"precision": round(float(metrics.box.mp), 4), "recall": round(float(metrics.box.mr), 4),
                    "mAP50": round(float(metrics.box.map50), 4), "mAP50_95": round(float(metrics.box.map), 4)},
    }
    YOLO_WEIGHTS.with_suffix(".json").write_text(json.dumps(summary, indent=2), encoding="utf-8", newline="\n")
    m = summary["metrics"]
    print(f"Validation: precision {m['precision']:.3f}  recall {m['recall']:.3f}  mAP@0.5 {m['mAP50']:.3f}  "
          f"mAP@0.5:0.95 {m['mAP50_95']:.3f}")
    if args.export:
        exported = trained.export(format=args.export, imgsz=args.imgsz)
        print(f"Exported {args.export} model: {exported}")
    print("Set MODEL_MODE=production to use the detector in CivicAI.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Train the CivicAI YOLOv8 civic-issue detector.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="dataset YAML (default ai/vision/dataset.yaml)")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640, help="training image size (square, letterboxed)")
    parser.add_argument("--model", default="yolov8n.pt",
                        help="starting checkpoint: yolov8n/s/m/l/x.pt (COCO-pretrained, downloaded automatically)")
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default=None, help="'cpu', '0' for the first GPU ... (default: AI_DEVICE)")
    parser.add_argument("--patience", type=int, default=30, help="early-stopping patience in epochs")
    parser.add_argument("--workers", type=int, default=2, help="data-loader worker processes")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--name", default="civicai_yolov8", help="run name under ml_models/yolo/runs/")
    parser.add_argument("--export", default=None, help="also export the trained model, e.g. onnx or torchscript")
    parser.add_argument("--check-only", action="store_true", help="validate the dataset and exit (no training)")
    parser.add_argument("--prepare-samples", action="store_true",
                        help="export sample_data/ to YOLO format and use it as the dataset (pipeline test)")
    args = parser.parse_args(argv)

    if args.prepare_samples:
        args.data = prepare_samples()
    data_path = args.data if args.data.is_absolute() else (Path.cwd() / args.data)
    if not data_path.is_file():
        data_path = BACKEND_DIR / args.data
    if not data_path.is_file():
        print(f"Dataset file not found: {args.data}")
        return 1
    data, root = resolve_dataset(data_path)
    valid = check_dataset(data, root)
    if args.check_only:
        print("Dataset OK." if valid else "Dataset has problems - fix them before training.")
        return 0 if valid else 1
    yolo_cls = require_ultralytics()
    if not valid:
        print("Dataset has problems - fix them (see the summary above) before training.")
    if yolo_cls is None or not valid:
        return 1
    return train(args, data, yolo_cls)


if __name__ == "__main__":
    sys.exit(main())
