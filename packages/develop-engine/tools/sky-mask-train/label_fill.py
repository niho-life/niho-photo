#!/usr/bin/env python3
"""Candidate labels with the sky seen through foliage and between structures added (#158).

Labels cut from image segments keep a tree, a mesh of wires or a lattice as one solid
not-sky region, so a model trained on them learns that the sky never shows through them.
For each label with sky, this adds the pixels whose colour is within `--delta` (Lab) of the
label's own sky (k-means of the inner flat sky, 3 colours) in the upper `--rows` of the frame:

- a connected piece touching the labelled sky, smaller than 5 % of the frame;
- an isolated piece smaller than 1 % of the frame that lies within `--reach` (share of the
  long edge) of the labelled sky and is ringed by texture (lightness std >= 6), such as a gap
  between leaves.

Pieces far from the sky or in plain surroundings stay as they are. The result is a candidate:
sea, haze over mountains, a sea of clouds and blue walls or signs can match the sky's colour,
so review each one against the photo (larger additions in full, smaller ones by sample)
before training on it.

  python3 label_fill.py --data <dir with input/ label/> --out <dir> [--ids <ids.json>] [--delta 6]

Writes `<out>/<id>.png` (0 / 255) for every label with sky and `<out>/stats.json`
({id: {"base": sky share, "added": added share}}).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sky_math import box, srgb_to_lab  # noqa: E402


def kmeans(x: np.ndarray, k: int, iters: int = 12) -> np.ndarray:
    """Lloyd's k-means on at most 20000 rows (deterministic start: evenly spaced rows)."""
    if len(x) > 20000:
        x = x[np.linspace(0, len(x) - 1, 20000).astype(int)]
    c = x[np.linspace(0, len(x) - 1, min(k, len(x))).astype(int)].copy()
    for _ in range(iters):
        nearest = ((x[:, None] - c[None]) ** 2).sum(-1).argmin(1)
        for j in range(len(c)):
            if (nearest == j).any():
                c[j] = x[nearest == j].mean(0)
    return c


def fill(rgb: np.ndarray, sky: np.ndarray, delta: float, rows: float, reach: float) -> np.ndarray | None:
    """The label with the sky-coloured pieces added, or None when the label has too little flat sky."""
    h, w = sky.shape
    lab = srgb_to_lab(rgb)
    lightness = lab[..., 0]
    gy, gx = np.gradient(lightness)
    inner = ndimage.binary_erosion(sky, iterations=5) & (np.hypot(gx, gy) < 2.0)
    if inner.sum() < 200:
        return None
    colours = kmeans(lab[inner], 3)
    dist = np.sqrt(((lab[..., None, :] - colours[None, None]) ** 2).sum(-1).min(-1))
    cand = (dist < delta) & ~sky
    cand[int(rows * h):] = False
    pieces, n = ndimage.label(cand, structure=np.ones((3, 3), bool))
    if not n:
        return sky.copy()
    idx = np.arange(1, n + 1)
    area = ndimage.sum_labels(cand, pieces, idx) / (h * w)
    touches = ndimage.maximum(ndimage.binary_dilation(sky, iterations=2), pieces, idx) > 0
    near = ndimage.minimum(ndimage.distance_transform_edt(~sky), pieces, idx) <= reach * max(h, w)
    mean = box(lightness, 4)
    std = np.sqrt(np.maximum(box(lightness * lightness, 4) - mean * mean, 0))
    add = np.zeros(n + 1, bool)
    for k, sl in enumerate(ndimage.find_objects(pieces), start=1):
        if touches[k - 1] and area[k - 1] < 0.05:
            add[k] = True
        elif area[k - 1] < 0.01 and near[k - 1]:
            piece = pieces[sl] == k
            ring = ndimage.binary_dilation(piece, iterations=4) & ~piece
            add[k] = bool(ring.any()) and std[sl][ring].mean() >= 6
    return sky | add[pieces]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--ids", type=Path, help="JSON array of image stems (default: every label)")
    ap.add_argument("--delta", type=float, default=6.0, help="largest Lab distance to a sky colour")
    ap.add_argument("--rows", type=float, default=0.8, help="upper share of the frame searched")
    ap.add_argument("--reach", type=float, default=0.1, help="isolated pieces lie this close to the sky")
    args = ap.parse_args()
    stems = (json.loads(args.ids.read_text()) if args.ids
             else sorted(p.stem for p in (args.data / "label").glob("*.png")))
    args.out.mkdir(parents=True, exist_ok=True)
    stats = {}
    for stem in stems:
        with Image.open(args.data / "input" / f"{stem}.png") as im:
            rgb = np.asarray(im.convert("RGB"))
        h, w = rgb.shape[:2]
        with Image.open(args.data / "label" / f"{stem}.png") as lb:
            sky = np.asarray(lb.convert("L").resize((w, h), Image.BILINEAR)) >= 128
        if sky.mean() < 0.02:
            continue
        result = fill(rgb, sky, args.delta, args.rows, args.reach)
        if result is None:
            continue
        Image.fromarray((result * 255).astype(np.uint8), mode="L").save(args.out / f"{stem}.png")
        stats[stem] = {"base": float(sky.mean()), "added": float((result & ~sky).mean())}
    (args.out / "stats.json").write_text(json.dumps(stats, indent=1))
    print(f"{len(stats)} labels; {sum(v['added'] > 0.003 for v in stats.values())} with more than 0.3 % added, "
          f"{sum(v['added'] > 0.02 for v in stats.values())} with more than 2 %")


if __name__ == "__main__":
    main()
