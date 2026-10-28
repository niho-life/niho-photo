#!/usr/bin/env python3
"""Candidate A of #128: a NIHO-owned sky estimate (no learned weights).

Prototype only (not shipped). It keeps to operations that port directly to
Rust / wasm: box filters, a separable blur, a least-squares fit of a few
coefficients, one breadth-first flood fill and a guided filter.

1. Analysis size (long edge `ANALYSIS`): Lab-like colour, local texture and
   position.
2. Seed: smooth, bright, sky-coloured pixels in the upper part, kept only
   where they connect to the top edge. With the capture's exposure (EXIF
   ExposureTime, FNumber, ISO: `<photo>.json` from prepare.py) "bright" is the
   pixel's scene brightness (EV 12 and up, or clipped); without it, bright
   for the photo.
3. Sky colour field: the sky's colour changes smoothly over the frame, so fit
   L, a, b ~ (1, x, y, x*y, y^2) on the seed and measure each pixel's distance
   to the colour the sky would have there.
4. Region growing from the seed through smooth pixels that match the field,
   plus isolated pixels that match it tightly (sky seen through branches and
   window frames).
5. Output size: the field is evaluated per pixel, combined with the upsampled
   region, then a guided filter on the photo snaps the edge.

  python3 sky_a.py --input <dir of PNG> --out <dir> [--size 1024]
"""
from __future__ import annotations

import argparse
import json
import time
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ANALYSIS = 384


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB uint8 / float 0..1 (H, W, 3) -> CIE Lab (D65), float32."""
    c = rgb.astype(np.float32)
    if c.max() > 1.0:
        c /= 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], np.float32)
    xyz = lin @ m.T
    xyz /= np.array([0.95047, 1.0, 1.08883], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    lab = np.empty_like(f)
    lab[..., 0] = 116.0 * f[..., 1] - 16.0
    lab[..., 1] = 500.0 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200.0 * (f[..., 1] - f[..., 2])
    return lab


def box(img: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)^2 window with edge clamping (integral image)."""
    pad = np.pad(img, ((r + 1, r), (r + 1, r)), mode="edge").astype(np.float64)
    s = pad.cumsum(0).cumsum(1)
    k = 2 * r + 1
    out = s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]
    return (out / (k * k)).astype(np.float32)


def guided_filter(guide: np.ndarray, src: np.ndarray, r: int, eps: float) -> np.ndarray:
    """He et al. guided filter with a grey guide."""
    mean_i = box(guide, r)
    mean_p = box(src, r)
    cov_ip = box(guide * src, r) - mean_i * mean_p
    var_i = box(guide * guide, r) - mean_i * mean_i
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    return box(a, r) * guide + box(b, r)


def resize(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    mode = Image.BILINEAR
    if arr.ndim == 2:
        return np.asarray(Image.fromarray(arr.astype(np.float32), mode="F").resize((w, h), mode))
    return np.stack([resize(arr[..., k], w, h) for k in range(arr.shape[2])], axis=-1)


def design(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    return np.stack([np.ones_like(xs), xs, ys, xs * ys, ys * ys], axis=-1)


def flood_from_top(allowed: np.ndarray) -> np.ndarray:
    """Pixels of `allowed` reachable from the top row (4-neighbour)."""
    h, w = allowed.shape
    seen = np.zeros_like(allowed)
    q: deque[tuple[int, int]] = deque()
    for x in np.flatnonzero(allowed[0]):
        seen[0, x] = True
        q.append((0, int(x)))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and allowed[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def grow(seed: np.ndarray, allowed: np.ndarray) -> np.ndarray:
    h, w = allowed.shape
    seen = seed & allowed
    q = deque(zip(*np.nonzero(seen)))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and allowed[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def sky_probability(rgb: np.ndarray, out_w: int, out_h: int, ev100: float | None = None) -> tuple[np.ndarray, dict]:
    h0, w0 = rgb.shape[:2]
    scale = ANALYSIS / max(h0, w0)
    aw, ah = max(1, round(w0 * scale)), max(1, round(h0 * scale))
    small = resize(rgb.astype(np.float32) / 255.0, aw, ah)
    lab = srgb_to_lab(small)
    lum = lab[..., 0] / 100.0
    lin_y = np.where(lum > 0.08, ((lum + 0.16) / 1.16) ** 3, lum / 9.033)

    # Texture: mean gradient magnitude over a small window, relative to the photo.
    gy, gx = np.gradient(lum)
    grad = np.sqrt(gx * gx + gy * gy)
    texture = box(grad, 2)
    tex_ref = float(np.percentile(texture, 60)) + 1e-4
    smooth = texture < 0.35 * tex_ref + 0.004
    soft = texture < 2.0 * tex_ref + 0.01  # clouds: textured but without hard edges

    ys, xs = np.mgrid[0:ah, 0:aw].astype(np.float32)
    yn, xn = ys / max(ah - 1, 1), xs / max(aw - 1, 1)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    hue = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360.0
    blue = (hue > 190) & (hue < 300) & (chroma > 8)
    neutral = chroma < 12
    warm = ((hue < 90) | (hue > 300)) & (chroma > 12) & (lum > 0.45)  # dusk: orange / pink
    clipped = lin_y > 0.9
    if ev100 is not None:
        # Scene brightness of the pixel (EV at ISO 100; mid grey = the capture's EV).
        # Daylight sky is EV 12-16; lit walls indoors stay near 8-11.
        pixel_ev = ev100 + np.log2(np.maximum(lin_y, 1e-4) / 0.18)
        bright = (pixel_ev >= 12.0) | clipped
    else:
        bright = lum > max(0.6, float(np.percentile(lum, 75)))
    bright_neutral = neutral & bright & (lum > max(0.6, float(np.percentile(lum, 70))))
    colour_ok = (blue & (lum > 0.35)) | bright_neutral | (warm & bright)
    candidate = smooth & colour_ok & bright & (yn < 0.75)
    seed = flood_from_top(candidate)
    info: dict = {"seedFraction": float(seed.mean()), "ev100": ev100}

    if seed.sum() < 0.01 * aw * ah:
        # No sky that reaches the top: windows, or no sky at all. Fall back to
        # smooth blue or clipped pixels anywhere in the upper half.
        seed = smooth & bright & (blue | (neutral & clipped)) & (yn < 0.5)
        info["fallbackSeed"] = True
        if seed.sum() < 0.005 * aw * ah:
            info["noSky"] = True
            return np.zeros((out_h, out_w), np.float32), info

    # Sky colour field fitted on the seed (no extrapolation below / above it).
    y_lo, y_hi = float(yn[seed].min()), float(yn[seed].max())
    a = design(xn[seed], yn[seed])
    coef, *_ = np.linalg.lstsq(a, lab[seed], rcond=None)
    weights = np.array([0.5, 1.0, 1.0], np.float32)
    pred = design(xn, np.clip(yn, y_lo, y_hi)) @ coef
    dist = np.sqrt(((lab - pred) ** 2 * weights).sum(-1))
    spread = min(float(np.percentile(dist[seed], 90)) + 1.5, 10.0)
    info["spread"] = spread

    # Clouds: near-colourless and among the brightest, textured but without hard edges.
    cloud = bright & soft & (chroma < 7) & (lum > max(0.72, float(np.percentile(lum, 80))))
    allowed = bright & ((dist < 2.2 * spread) & (texture < 0.6 * tex_ref + 0.006) | cloud)
    region = grow(seed, allowed)
    rows = np.flatnonzero(region.any(1))
    lowest = (rows.max() / max(ah - 1, 1) + 0.05) if rows.size else 0.0
    isolated = (dist < 0.8 * spread) & bright & ~region & (yn <= lowest)
    region_f = (region | isolated).astype(np.float32)

    # Output size: per-pixel field distance and the upsampled region.
    big = rgb.astype(np.float32) / 255.0
    if (big.shape[1], big.shape[0]) != (out_w, out_h):
        big = resize(big, out_w, out_h)
    big_lab = srgb_to_lab(big)
    oy, ox = np.mgrid[0:out_h, 0:out_w].astype(np.float32)
    big_pred = design(ox / max(out_w - 1, 1), np.clip(oy / max(out_h - 1, 1), y_lo, y_hi)) @ coef
    big_dist = np.sqrt(((big_lab - big_pred) ** 2 * weights).sum(-1))
    colour_p = np.clip((2.0 * spread - big_dist) / (1.5 * spread), 0.0, 1.0)
    region_up = resize(region_f, out_w, out_h)
    # Inside the region trust it, near its edge let the colour decide.
    near_edge = (region_up > 0.02) & (region_up < 0.98)
    p = np.where(near_edge, 0.5 * region_up + 0.5 * colour_p, region_up)
    guide = big_lab[..., 0] / 100.0
    r = max(2, round(max(out_w, out_h) / 256))
    p = guided_filter(guide, p.astype(np.float32), r, 1e-3)
    return np.clip(p, 0.0, 1.0), info


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--no-ev", action="store_true", help="ignore the exposure (photos without EXIF)")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    timing = {}
    for path in sorted(args.input.glob("*.png")):
        rgb = np.asarray(Image.open(path).convert("RGB"))
        meta = path.with_suffix(".json")
        ev = json.loads(meta.read_text()).get("ev100") if meta.exists() and not args.no_ev else None
        t0 = time.perf_counter()
        prob, info = sky_probability(rgb, rgb.shape[1], rgb.shape[0], ev)
        dt = time.perf_counter() - t0
        Image.fromarray(np.round(prob * 255).astype(np.uint8), mode="L").save(args.out / path.name)
        timing[path.stem] = {"seconds": dt, **info}
    (args.out / "timing.json").write_text(json.dumps(timing, indent=1))
    print(f"{len(timing)} images -> {args.out}")


if __name__ == "__main__":
    main()
