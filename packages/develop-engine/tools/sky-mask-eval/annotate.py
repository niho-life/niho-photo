#!/usr/bin/env python3
"""Reference (correct) sky masks of #128 and the sheets to review them.

The reference is drawn by hand on top of a starting mask, then its edge is
decided by colour, so it does not inherit the starting mask's edge:

1. Start: a method's map cut at 0.5 (`base`), or empty.
2. Hand polygons (`sky`, `ground`) force pixels to sky / not sky.
3. `decide` polygons (sky through foliage or windows): each pixel takes the
   nearer of the scene's sky colours (k-means of the flat sky, 3) and ground
   colours (k-means of the ground within 60 px, 6), in Lab. With `thin`, sky
   pixels 8 L darker than the flat sky around them (wires, poles, twigs) are
   not sky.
4. A band of `band` px around the resulting edge: each pixel takes the class
   whose local mean colour (window radius `radius`) is nearer.

`annotations.json` (private): {"<scene id>": {"base": "<method dir name>" | null,
  "sky": [[[x, y], ...], ...], "ground": [...], "decide": [...], "thin": false, "band": 6, "radius": 20}}
with x, y in 0..1 of the photo.

  python3 annotate.py build  --work <dir> --annotations <json> [--only s01,s02]
  python3 annotate.py review --work <dir> --scenes <json> --mask reference [--mask <method dir> ...] --out <dir>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate import edge  # noqa: E402
from sky_a import box, srgb_to_lab  # noqa: E402


def polygon_mask(polys: list, w: int, h: int) -> np.ndarray:
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    for poly in polys:
        draw.polygon([(x * w, y * h) for x, y in poly], fill=255)
    return np.asarray(img) > 0


def kmeans(x: np.ndarray, k: int, iters: int = 12) -> np.ndarray:
    """Lloyd's k-means on at most 20000 rows (deterministic start: evenly spaced rows)."""
    if len(x) > 20000:
        x = x[np.linspace(0, len(x) - 1, 20000).astype(int)]
    k = min(k, len(x))
    c = x[np.linspace(0, len(x) - 1, k).astype(int)].copy()
    for _ in range(iters):
        nearest = ((x[:, None, :] - c[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            if (nearest == j).any():
                c[j] = x[nearest == j].mean(0)
    return c


def build_one(rgb: np.ndarray, start: np.ndarray, ann: dict) -> np.ndarray:
    h, w = start.shape
    lab = srgb_to_lab(rgb)
    force_sky = polygon_mask(ann.get("sky", []), w, h)
    force_ground = polygon_mask(ann.get("ground", []), w, h)
    m = start.copy()
    m[force_sky] = True
    m[force_ground] = False
    forced = force_sky | force_ground

    gy, gx = np.gradient(lab[..., 0])
    flat = np.hypot(gx, gy) < 2.0
    # `decide` polygons (sky seen through foliage or windows): each pixel takes the
    # nearer of the scene's sky colours and the ground colours around the polygon.
    region = polygon_mask(ann.get("decide", []), w, h) & ~forced
    if region.any():
        sky_s = (ndimage.binary_erosion(m, iterations=3) & flat & ~force_ground) | force_sky
        near = ndimage.binary_dilation(region, iterations=60)
        ground_s = (ndimage.binary_erosion(~m, iterations=3) & near & ~force_sky) | (force_ground & near)
        if sky_s.any() and ground_s.any():
            cs, cg = kmeans(lab[sky_s], 3), kmeans(lab[ground_s], 6)
            px = lab[region]
            d_sky = ((px[:, None, :] - cs[None]) ** 2).sum(-1).min(1)
            d_ground = ((px[:, None, :] - cg[None]) ** 2).sum(-1).min(1)
            m[region] = d_sky < d_ground
    # `thin`: wires, poles and twigs crossing the sky are darker than the sky around
    # them; a sky pixel 8 L below the local mean of the flat sky (radius 15) is not sky.
    if ann.get("thin"):
        flat_sky = (ndimage.binary_erosion(m, iterations=2) & flat).astype(np.float32)
        n = box(flat_sky, 15)
        local = box(lab[..., 0] * flat_sky, 15) / np.maximum(n, 1e-6)
        m &= ~((n > 0.05) & (lab[..., 0] < local - 8.0) & ~force_sky)

    # The edge: a band around it takes the nearer local mean colour (window radius `radius`).
    band = int(ann.get("band", 6))
    if band > 0:
        undecided = ndimage.binary_dilation(edge(m) | edge(~m), iterations=band) & ~forced
        r = int(ann.get("radius", 20))
        known_sky = (m & ~undecided).astype(np.float32)
        known_ground = (~m & ~undecided).astype(np.float32)
        n_sky, n_ground = box(known_sky, r), box(known_ground, r)
        dist_sky = np.zeros((h, w), np.float32)
        dist_ground = np.zeros((h, w), np.float32)
        for k in range(3):
            c = lab[..., k]
            mean_sky = box(c * known_sky, r) / np.maximum(n_sky, 1e-6)
            mean_ground = box(c * known_ground, r) / np.maximum(n_ground, 1e-6)
            dist_sky += (c - mean_sky) ** 2
            dist_ground += (c - mean_ground) ** 2
        has_both = (n_sky > 1e-3) & (n_ground > 1e-3)
        m = np.where(undecided & has_both, dist_sky < dist_ground, m)
    return m


def cmd_build(args: argparse.Namespace) -> None:
    anns = json.loads(args.annotations.read_text())
    only = set(args.only.split(",")) if args.only else None
    out = args.work / args.reference
    out.mkdir(parents=True, exist_ok=True)
    for sid, ann in anns.items():
        if only and sid not in only:
            continue
        rgb = np.asarray(Image.open(args.work / "input" / f"{sid}.png").convert("RGB"))
        h, w = rgb.shape[:2]
        if ann.get("base"):
            base = Image.open(args.work / ann["base"] / f"{sid}.png").convert("L").resize((w, h), Image.BILINEAR)
            start = np.asarray(base) >= 128
        else:
            start = np.zeros((h, w), bool)
        ref = build_one(rgb, start, {**ann, "thin": False} if args.coarse else ann)
        Image.fromarray((ref * 255).astype(np.uint8), mode="L").save(out / f"{sid}.png")
        print(f"{sid}: sky {ref.mean():.3f}")


def overlay(rgb: np.ndarray, mask: np.ndarray, grid: bool) -> Image.Image:
    out = rgb.astype(np.float32).copy()
    tint = np.array([255, 0, 200], np.float32)
    out[mask] = 0.55 * out[mask] + 0.45 * tint
    out[edge(mask) | edge(~mask)] = (255, 255, 0)
    img = Image.fromarray(out.astype(np.uint8))
    if grid:
        draw = ImageDraw.Draw(img)
        w, h = img.size
        for k in range(1, 10):
            draw.line([(k * w / 10, 0), (k * w / 10, h)], fill=(0, 255, 255), width=1)
            draw.line([(0, k * h / 10), (w, k * h / 10)], fill=(0, 255, 255), width=1)
            draw.text((k * w / 10 + 2, 2), f"{k / 10:.1f}", fill=(0, 255, 255))
            draw.text((2, k * h / 10 + 2), f"{k / 10:.1f}", fill=(0, 255, 255))
    return img


def cmd_review(args: argparse.Namespace) -> None:
    scenes = json.loads(args.scenes.read_text())
    if args.only:
        keep = set(args.only.split(","))
        scenes = [s for s in scenes if s["id"] in keep]
    args.out.mkdir(parents=True, exist_ok=True)
    tile = args.tile
    for s in scenes:
        rgb_img = Image.open(args.work / "input" / f"{s['id']}.png").convert("RGB")
        scale = tile / max(rgb_img.size)
        size = (round(rgb_img.width * scale), round(rgb_img.height * scale))
        rgb = np.asarray(rgb_img.resize(size, Image.LANCZOS))
        panels = [Image.fromarray(rgb)] if args.with_photo else []
        for name in args.mask:
            m = Image.open(args.work / name / f"{s['id']}.png").convert("L").resize(size, Image.BILINEAR)
            panels.append(overlay(rgb, np.asarray(m) >= 128, grid=args.grid))
        sheet = Image.new("RGB", (size[0] * len(panels) + 4 * (len(panels) - 1), size[1] + 14), (30, 30, 30))
        draw = ImageDraw.Draw(sheet)
        labels = (["photo"] if args.with_photo else []) + args.mask
        for k, (p, label) in enumerate(zip(panels, labels)):
            sheet.paste(p, (k * (size[0] + 4), 14))
            draw.text((k * (size[0] + 4) + 2, 1), f"{s['id']} {label}", fill=(255, 255, 255))
        sheet.save(args.out / f"{s['id']}.jpg", quality=85)
    print(f"{len(scenes)} sheets -> {args.out}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--work", required=True, type=Path)
    b.add_argument("--annotations", required=True, type=Path)
    b.add_argument("--only")
    b.add_argument("--reference", default="reference", help="output dir name under --work")
    b.add_argument("--coarse", action="store_true", help="ignore `thin` (wires and twigs count as sky)")
    r = sub.add_parser("review")
    r.add_argument("--work", required=True, type=Path)
    r.add_argument("--scenes", required=True, type=Path)
    r.add_argument("--mask", action="append", default=[])
    r.add_argument("--out", required=True, type=Path)
    r.add_argument("--only")
    r.add_argument("--tile", type=int, default=640)
    r.add_argument("--grid", action="store_true")
    r.add_argument("--with-photo", action="store_true")
    args = ap.parse_args()
    {"build": cmd_build, "review": cmd_review}[args.cmd](args)


if __name__ == "__main__":
    main()
