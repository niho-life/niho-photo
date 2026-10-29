#!/usr/bin/env python3
"""Score sky maps against the reference masks of #128.

For every method directory (8 bit grey PNG per scene, any size; resized to the
reference size bilinearly and cut at 0.5) and every scene of `scenes.json`:

- IoU of the sky. A scene with no sky in the reference and none predicted
  counts as 1; `falseSky` is the predicted sky share of the frame there.
- Boundary F (Perazzi et al. 2016): precision and recall of the sky edge
  pixels within `--tol` pixels of the other edge. The frame of the photo is
  not an edge.

Prints per-category means as a Markdown table and writes `results.json`.

  python3 evaluate.py --work <private work dir> --scenes <scenes.json> --method A=<dir> --method B-L=<dir> ...
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

CATEGORY_JA = {
    "clear": "快晴", "overcast": "曇り", "sunset": "夕焼け", "branches": "木の枝", "buildings": "建物",
    "wires": "電線", "water": "水面の映り込み", "window": "室内の窓", "nosky": "空なし",
}


def load_mask(path: Path, w: int, h: int) -> np.ndarray:
    img = Image.open(path).convert("L")
    if img.size != (w, h):
        img = img.resize((w, h), Image.BILINEAR)
    return np.asarray(img) >= 128


def edge(mask: np.ndarray) -> np.ndarray:
    padded = np.pad(mask, 1, mode="edge")
    eroded = ndimage.binary_erosion(padded, structure=np.ones((3, 3), bool), border_value=1)[1:-1, 1:-1]
    return mask & ~eroded


def boundary_f(pred: np.ndarray, ref: np.ndarray, tol: float) -> float:
    pe, re = edge(pred), edge(ref)
    if not pe.any() and not re.any():
        return 1.0
    if not pe.any() or not re.any():
        return 0.0
    near_ref = ndimage.distance_transform_edt(~re) <= tol
    near_pred = ndimage.distance_transform_edt(~pe) <= tol
    precision = (pe & near_ref).sum() / pe.sum()
    recall = (re & near_pred).sum() / re.sum()
    return 0.0 if precision + recall == 0 else float(2 * precision * recall / (precision + recall))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--scenes", required=True, type=Path)
    ap.add_argument("--method", action="append", required=True, help="NAME=DIR")
    ap.add_argument("--tol", type=float, default=3.0)
    ap.add_argument("--reference", default="reference", help="reference dir name under --work")
    ap.add_argument("--results", default="results.json")
    args = ap.parse_args()
    scenes = json.loads(args.scenes.read_text())
    methods = dict(m.split("=", 1) for m in args.method)
    results: dict[str, dict[str, dict]] = {}
    for scene in scenes:
        ref_img = Image.open(args.work / args.reference / f"{scene['id']}.png").convert("L")
        w, h = ref_img.size
        ref = np.asarray(ref_img) >= 128
        for name, d in methods.items():
            pred = load_mask(Path(d) / f"{scene['id']}.png", w, h)
            union = (pred | ref).sum()
            row = {
                "iou": 1.0 if union == 0 else float((pred & ref).sum() / union),
                "boundaryF": boundary_f(pred, ref, args.tol),
                "skyShare": float(ref.mean()),
            }
            if not ref.any():
                row["falseSky"] = float(pred.mean())
            results.setdefault(name, {})[scene["id"]] = row
    (args.work / args.results).write_text(json.dumps(results, indent=1))

    cats = [c for c in CATEGORY_JA if any(c in s["categories"] for s in scenes)]
    names = list(methods)
    header = "| 場面の種類 | 件数 | " + " | ".join(f"{n} IoU | {n} F" for n in names) + " |"
    print(header)
    print("|" + "---|" * (2 + 2 * len(names)))
    for cat in [None, *cats]:
        ids = [s["id"] for s in scenes if cat is None or cat in s["categories"]]
        cells = []
        for n in names:
            cells.append(f"{np.mean([results[n][i]['iou'] for i in ids]):.3f}")
            cells.append(f"{np.mean([results[n][i]['boundaryF'] for i in ids]):.3f}")
        label = "全体" if cat is None else CATEGORY_JA[cat]
        print(f"| {label} | {len(ids)} | " + " | ".join(cells) + " |")
    no_sky_ids = [s["id"] for s in scenes if "nosky" in s["categories"]]
    for name in names:
        false_count = sum(results[name][sid].get("falseSky", 0.0) > 0 for sid in no_sky_ids)
        print(f"{name}: 空なし誤検出 {false_count}/{len(no_sky_ids)}")


if __name__ == "__main__":
    main()
