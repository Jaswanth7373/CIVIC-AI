"""Import real photographs of one civic-issue category into the demo's real sample set.

Usage (from ``backend/``)::

    venv/Scripts/python.exe scripts/import_real_photos.py road_crack ../real_photos/road_crack

Input folder (any file names; JPEG, PNG or WebP)::

    <photo>.jpg                  a photo of the issue
    repaired/<photo>.jpg         optional: the SAME spot after the repair (same file stem as the issue photo)
    annotations.json             optional: {"source": "<credit>",
                                            "photos": {"<photo>.jpg": {"severity": "minor|standard|severe",
                                                                       "box": [x1, y1, x2, y2],
                                                                       "keywords": ["dog"],
                                                                       "title": "...", "author": "...",
                                                                       "license": "CC BY 4.0", "license_url": "...",
                                                                       "source_url": "..."}}}

Output (``backend/sample_data/real_images/``)::

    <slug>/<slug>_<nn>.jpg       the issue photo (longest side at most 1024 px)
    after/<slug>_<nn>_after.jpg  the repaired photo, when one was supplied
    manifest.json                every file, its label, source file, severity, defect box and credit
    CREDITS.md                   author, licence and source of every photo (the attribution CC licences require)

Every photo is re-encoded without metadata (no GPS position, capture time or camera model) after its EXIF
orientation is applied. Re-importing a category replaces its previous photos; other categories are kept.
``keywords`` limit a photo to complaints whose description mentions one of them (a stray-dog photo never
illustrates a complaint about a broken bench).
``manage.py seed_demo`` uses these photos instead of the generated ones (``sample_data/images``) for every
category that has real photos. The generated set stays untouched: the AI tests and the vision evaluation use it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from PIL import Image, ImageOps  # noqa: E402

from ai.config import CIVIC_CLASSES  # noqa: E402

OUT_DIR = BACKEND_DIR / "sample_data" / "real_images"
MAX_SIDE = 1024
JPEG_QUALITY = 88
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
SEVERITIES = ("minor", "standard", "severe")
#: Per-photo annotation keys copied into the manifest.
NOTE_KEYS = ("severity", "box", "keywords", "title", "author", "license", "license_url", "source_url")


def natural_key(path):
    """"photo_9" before "photo_10"."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def photos_in(folder):
    if not folder.is_dir():
        return []
    return sorted((p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES), key=natural_key)


def save_clean(source, target, max_side, quality):
    """Upright, at most ``max_side`` px, RGB JPEG without any metadata."""
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, "JPEG", quality=quality, optimize=True)
        return image.size


def load_annotations(folder):
    path = folder / "annotations.json"
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    for name, note in data.get("photos", {}).items():
        if note.get("severity") not in (None, *SEVERITIES):
            raise ValueError(f"{name}: severity must be one of {', '.join(SEVERITIES)}")
        box = note.get("box")
        if box is not None and not (len(box) == 4 and 0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1):
            raise ValueError(f"{name}: box must be normalised [x1, y1, x2, y2] with x1 < x2 and y1 < y2")
        keywords = note.get("keywords")
        if keywords is not None and not (isinstance(keywords, list) and all(isinstance(k, str) and k.strip()
                                                                             for k in keywords)):
            raise ValueError(f"{name}: keywords must be a list of words")
    return data


def import_category(label, source, out, max_side=MAX_SIDE, quality=JPEG_QUALITY, credit=None):
    """Replace the real photos of ``label`` with the photos in ``source``; returns the new manifest entries."""
    photos = photos_in(source)
    if not photos:
        raise ValueError(f"No photos (.jpg, .jpeg, .png, .webp) in {source}")
    annotations = load_annotations(source)
    notes = annotations.get("photos", {})
    repaired = {p.stem: p for p in photos_in(source / "repaired")}

    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    for stale in (out / label).glob("*.jpg"):
        stale.unlink()
    for stale in (out / "after").glob(f"{label}_*_after.jpg"):
        stale.unlink()

    entries = []
    for index, photo in enumerate(photos, start=1):
        stem = f"{label}_{index:02d}"
        width, height = save_clean(photo, out / label / f"{stem}.jpg", max_side, quality)
        entry = {"id": f"real_{stem}", "label": label, "index": index, "file": f"{label}/{stem}.jpg",
                 "width": width, "height": height, "source_file": photo.name}
        if photo.stem in repaired:
            save_clean(repaired[photo.stem], out / "after" / f"{stem}_after.jpg", max_side, quality)
            entry["after"] = f"after/{stem}_after.jpg"
        note = notes.get(photo.name, {})
        for key in NOTE_KEYS:
            if note.get(key) is not None:
                entry[key] = note[key]
        entries.append(entry)

    images = [item for item in manifest.get("images", []) if item["label"] != label] + entries
    sources = {key: value for key, value in manifest.get("sources", {}).items() if key != label}
    if credit or annotations.get("source"):
        sources[label] = credit or annotations["source"]
    manifest = {
        "generator": "scripts/import_real_photos.py",
        "description": "Real photographs used by seed_demo instead of the generated sample photos of their "
                       "category. 'after' (optional) is the same spot after the repair. 'severity' and 'box' "
                       "(normalised [x1, y1, x2, y2] defect region) are manual annotations; 'author', 'license' and "
                       "'source_url' credit the photo (see CREDITS.md).",
        "max_side": max_side,
        "jpeg_quality": quality,
        "sources": dict(sorted(sources.items())),
        "images": sorted(images, key=lambda item: (item["label"], item["index"])),
    }
    out.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (out / "CREDITS.md").write_text(credits_markdown(manifest), encoding="utf-8")
    return entries


def credits_markdown(manifest):
    """CREDITS.md: who took every photo, under which licence, and where it comes from."""
    lines = ["# Credits for the real sample photos", "",
             "Generated by `scripts/import_real_photos.py` from `manifest.json`; do not edit by hand. The photos were",
             "downscaled and their metadata removed; nothing else was changed.", ""]
    for label in sorted({item["label"] for item in manifest["images"]}):
        lines += [f"## {label}", ""]
        if manifest["sources"].get(label):
            lines += [f"Source: {manifest['sources'][label]}", ""]
        lines += ["| File | Original | Author | Licence |", "| --- | --- | --- | --- |"]
        for item in (item for item in manifest["images"] if item["label"] == label):
            original = item.get("title") or item["source_file"]
            if item.get("source_url"):
                original = f"[{original}]({item['source_url']})"
            licence = item.get("license") or "see source"
            if item.get("license_url"):
                licence = f"[{licence}]({item['license_url']})"
            cells = [item["file"], original, item.get("author") or "see source", licence]
            lines.append("| " + " | ".join(cell.replace("|", "\\|").replace("\n", " ") for cell in cells) + " |")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("label", choices=CIVIC_CLASSES, help="category slug, e.g. road_crack")
    parser.add_argument("source", type=Path, help="folder with the photos (see the module docstring)")
    parser.add_argument("--out", type=Path, default=OUT_DIR, help="output folder (default sample_data/real_images)")
    parser.add_argument("--max-side", type=int, default=MAX_SIDE, help="longest side in pixels (default 1024)")
    parser.add_argument("--quality", type=int, default=JPEG_QUALITY, help="JPEG quality (default 88)")
    parser.add_argument("--credit", help="where the photos come from (overrides annotations.json 'source')")
    args = parser.parse_args(argv)
    try:
        entries = import_category(args.label, args.source, args.out, args.max_side, args.quality, args.credit)
    except ValueError as exc:
        parser.error(str(exc))
    with_after = sum(1 for entry in entries if "after" in entry)
    size_mb = sum((args.out / entry["file"]).stat().st_size for entry in entries) / 1e6
    print(f"Imported {len(entries)} {args.label} photos ({size_mb:.1f} MB, {with_after} with a repaired photo) "
          f"into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
