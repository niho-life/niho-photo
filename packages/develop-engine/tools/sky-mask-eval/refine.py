#!/usr/bin/env python3
"""Snap a method's sky map to the photo's edges with the guided filter of sky_a.py (#128).

B's maps come from a 1/4-size mask; the product would refine them the way A
refines its own, so this is the "B + guided filter" variant of the table.

  python3 refine.py --input <dir of photos> --map <method dir> --out <dir>
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sky_a import guided_filter, srgb_to_lab  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--map", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for path in sorted(args.input.glob("*.png")):
        rgb = np.asarray(Image.open(path).convert("RGB"))
        h, w = rgb.shape[:2]
        m = Image.open(args.map / path.name).convert("L").resize((w, h), Image.BILINEAR)
        p = np.asarray(m).astype(np.float32) / 255.0
        guide = srgb_to_lab(rgb)[..., 0] / 100.0
        r = max(2, round(max(w, h) / 256))
        out = np.clip(guided_filter(guide, p, r, 1e-3), 0.0, 1.0)
        Image.fromarray(np.round(out * 255).astype(np.uint8), mode="L").save(args.out / path.name)
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
