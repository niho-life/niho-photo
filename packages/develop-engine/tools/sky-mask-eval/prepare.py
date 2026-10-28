#!/usr/bin/env python3
"""Evaluation inputs of #128 from a private scene list.

`scenes.json` (private, next to the work dir — never in the repository):
  [{"id": "s01", "source": "<path relative to --pool>", "categories": ["clear", "branches"]}, ...]

Writes `<work>/input/<id>.png`: EXIF orientation applied, long edge `--size`,
sRGB 8 bit, no metadata. Beside it `<id>.json` keeps only the exposure the
product also reads from the file (`ev100` from ExposureTime, FNumber, ISO;
null when any is missing).

  python3 prepare.py --pool <private pool dir> --scenes <scenes.json> --work <private work dir> [--size 1024]
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pool import load_any  # noqa: E402


def ev100(path: Path) -> float | None:
    """EV at ISO 100 of the capture: log2(N^2 / t) - log2(ISO / 100)."""
    out = subprocess.run(["exiftool", "-n", "-j", "-ExposureTime", "-FNumber", "-ISO", str(path)],
                         capture_output=True, text=True, check=False).stdout
    tags = json.loads(out)[0] if out.strip() else {}
    t, n, iso = tags.get("ExposureTime"), tags.get("FNumber"), tags.get("ISO")
    if not all(isinstance(v, (int, float)) and v > 0 for v in (t, n, iso)):
        return None
    return math.log2(n * n / t) - math.log2(iso / 100)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pool", required=True, type=Path)
    ap.add_argument("--scenes", required=True, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--size", type=int, default=1024)
    args = ap.parse_args()
    out = args.work / "input"
    out.mkdir(parents=True, exist_ok=True)
    scenes = json.loads(args.scenes.read_text())
    for scene in scenes:
        img = load_any(args.pool / scene["source"], 1 << 16)
        s = args.size / max(img.size)
        img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
        Image.frombytes("RGB", img.size, img.tobytes()).save(out / f"{scene['id']}.png")
        (out / f"{scene['id']}.json").write_text(json.dumps({"ev100": ev100(args.pool / scene["source"])}))
    print(f"{len(scenes)} scenes -> {out}")


if __name__ == "__main__":
    main()
