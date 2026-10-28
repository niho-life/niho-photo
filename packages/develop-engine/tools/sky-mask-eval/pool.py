#!/usr/bin/env python3
"""Contact sheets of a private photo pool, for picking the sky-mask scenes (#128).

Walks `--pool` for JPEG files (RAW files are read through their embedded
preview with exiftool), writes numbered contact sheets and `index.json`
(number -> relative path). Everything stays under `--out`, which must be a
private directory: the owner's photos never go to the repository, an Issue,
a PR or a CI log.

  python3 pool.py --pool <private pool dir> --out <private work dir>/sheets [--cols 8 --rows 6 --thumb 240]
"""
from __future__ import annotations

import argparse
import io
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

try:  # phone photos (HEIC); optional
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

JPEG = {".jpg", ".jpeg", ".heic"}
RAW = {".arw", ".rw2", ".dng", ".nef", ".cr3", ".raf"}


def load_any(path: Path, max_side: int) -> Image.Image:
    if path.suffix.lower() in RAW:
        data = b""
        for tag in ("-JpgFromRaw", "-PreviewImage"):
            data = subprocess.run(["exiftool", "-b", tag, str(path)], capture_output=True, check=False).stdout
            if data:
                break
        if not data:
            raise ValueError("no embedded preview")
        img = Image.open(io.BytesIO(data))
        orientation = subprocess.run(
            ["exiftool", "-n", "-s3", "-Orientation", str(path)], capture_output=True, text=True, check=False
        ).stdout.strip()
        rotate = {"3": 180, "6": 270, "8": 90}.get(orientation)
        img = img.rotate(rotate, expand=True) if rotate else img
    else:
        img = ImageOps.exif_transpose(Image.open(path))
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pool", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--rows", type=int, default=6)
    ap.add_argument("--thumb", type=int, default=240)
    args = ap.parse_args()

    files = sorted(
        p for p in args.pool.rglob("*")
        if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in JPEG | RAW
    )
    args.out.mkdir(parents=True, exist_ok=True)
    per_sheet = args.cols * args.rows
    cell = args.thumb + 8
    index: dict[str, str] = {}
    sheet_no = 0
    for start in range(0, len(files), per_sheet):
        sheet = Image.new("RGB", (args.cols * cell, args.rows * (cell + 14)), (40, 40, 40))
        draw = ImageDraw.Draw(sheet)
        for k, path in enumerate(files[start:start + per_sheet]):
            number = start + k
            try:
                thumb = load_any(path, args.thumb)
            except Exception as exc:  # noqa: BLE001 - a broken file only loses its cell
                print(f"skip {path}: {exc}")
                continue
            x, y = (k % args.cols) * cell + 4, (k // args.cols) * (cell + 14) + 4
            sheet.paste(thumb, (x, y))
            draw.text((x, y + args.thumb + 1), str(number), fill=(255, 255, 0))
            index[str(number)] = str(path.relative_to(args.pool))
        sheet.save(args.out / f"sheet-{sheet_no:02d}.jpg", quality=80)
        sheet_no += 1
    (args.out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print(f"{len(index)} photos, {sheet_no} sheets -> {args.out}")


if __name__ == "__main__":
    main()
