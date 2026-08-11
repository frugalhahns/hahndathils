#!/usr/bin/env python3
"""Normalize anything dropped into photos/ so the gallery can actually show it.

Per file:
  - HEIC/HEIF -> JPEG (Safari renders HEIC, Chrome and Firefox do not)
  - downscale so the long edge is at most MAX_EDGE
  - apply EXIF orientation, then save without EXIF, which also drops GPS tags
  - rename to <EXIF timestamp>-<original stem>.jpg so newest-first sorting works

Processed filenames are recorded in photos/.processed.json so a second run is a
no-op. Without that the workflow's own commit would re-trigger itself.
"""

import json
import os
import sys

from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    print("! pillow-heif missing, HEIC files will be skipped", file=sys.stderr)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS = os.path.join(ROOT, "photos")
LEDGER = os.path.join(PHOTOS, ".processed.json")

MAX_EDGE = 1600
QUALITY = 82
SOURCE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}
EXIF_DATETIME_ORIGINAL = 36867


def load_ledger():
    try:
        with open(LEDGER) as f:
            return set(json.load(f))
    except Exception:
        return set()


def exif_prefix(img):
    """'2026:08:14 09:31:02' -> '20260814-093102'. Empty string if absent."""
    try:
        exif = img.getexif()
        raw = exif.get(EXIF_DATETIME_ORIGINAL) or exif.get(306)  # 306 = DateTime
        if not raw:
            return ""
        date, _, clock = str(raw).strip().partition(" ")
        return f"{date.replace(':', '')}-{clock.replace(':', '')}"
    except Exception:
        return ""


def unique(path):
    stem, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(path):
        path = f"{stem}-{n}{ext}"
        n += 1
    return path


def main():
    if not os.path.isdir(PHOTOS):
        print("no photos/ directory")
        return

    done = load_ledger()
    changed = False

    for name in sorted(os.listdir(PHOTOS)):
        src = os.path.join(PHOTOS, name)
        if name.startswith(".") or not os.path.isfile(src):
            continue
        if name in done:
            continue
        if os.path.splitext(name)[1].lower() not in SOURCE_EXT:
            print(f"  skip (not an image): {name}")
            continue

        try:
            with Image.open(src) as img:
                prefix = exif_prefix(img)
                img = ImageOps.exif_transpose(img)  # honor rotation before stripping
                img = img.convert("RGB")
                img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

                stem = os.path.splitext(name)[0]
                out_name = f"{prefix}-{stem}.jpg" if prefix else f"{stem}.jpg"
                dst = os.path.join(PHOTOS, out_name)
                if os.path.abspath(dst) != os.path.abspath(src):
                    dst = unique(dst)
                # No exif= argument, so EXIF (including GPS) is not written out.
                img.save(dst, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        except Exception as e:
            print(f"  ! failed {name}: {e}", file=sys.stderr)
            continue

        if os.path.abspath(dst) != os.path.abspath(src):
            os.remove(src)
        kb = os.path.getsize(dst) // 1024
        print(f"  {name} -> {os.path.basename(dst)} ({kb} KB)")
        done.add(os.path.basename(dst))
        changed = True

    if changed:
        with open(LEDGER, "w") as f:
            json.dump(sorted(done), f, indent=1)
        print(f"processed, ledger now {len(done)} files")
    else:
        print("nothing new to process")


if __name__ == "__main__":
    main()
