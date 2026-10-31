#!/usr/bin/env python3
"""Run the exported sky U-Net from weights.f32 + layout.json alone (NumPy, no PyTorch) and compare
with the parity fixtures that `train_sky.py export` writes (#158).

This is the reference for another implementation (Rust/wasm): the network is

  stem.0 (stride 2) -> stem.1 -> enc2.0 (2) -> enc2.1 -> enc3.0 (2) -> enc3.1 -> enc4.0 (2) -> enc4.1
  -> ctx.0 (2) -> ctx.1; dec4 = conv(cat(up(ctx, enc4), enc4)), dec3 = conv(cat(up(dec4, enc3), enc3)),
  dec2 = conv(cat(up(dec3, enc2), enc2)), dec1 = conv(cat(up(dec2, stem), stem)), head = conv(dec1)

with 3x3 convolutions (zero padding 1, BatchNorm already folded into the weights), ReLU on every
layer but the head, and `up` a bilinear resize to the skip's size with align_corners=False. The input
is the photo resized to the model size, sRGB 0..1 in channel-first order (plus two zero channels for
`rgb-ev` runs without exposure); the output is sky logits at half the model size.

  python3 reference_forward.py --run <run dir>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def conv3x3(x: np.ndarray, w: np.ndarray, b: np.ndarray, stride: int) -> np.ndarray:
    """x (C, H, W), w (O, C, 3, 3), zero padding 1."""
    c, h, wd = x.shape
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    oh, ow = (h - 1) // stride + 1, (wd - 1) // stride + 1
    cols = np.empty((c, 3, 3, oh, ow), np.float32)
    for dy in range(3):
        for dx in range(3):
            cols[:, dy, dx] = xp[:, dy:dy + stride * oh:stride, dx:dx + stride * ow:stride]
    return np.tensordot(w, cols, axes=([1, 2, 3], [0, 1, 2])) + b[:, None, None]


def resize_bilinear(x: np.ndarray, h: int, w: int) -> np.ndarray:
    """Bilinear resize of (C, H, W) with align_corners=False."""
    def taps(n_out: int, n_in: int):
        s = np.clip((np.arange(n_out) + 0.5) * n_in / n_out - 0.5, 0, None)
        i0 = np.minimum(np.floor(s).astype(int), n_in - 1)
        return i0, np.minimum(i0 + 1, n_in - 1), (s - i0).astype(np.float32)
    y0, y1, fy = taps(h, x.shape[1])
    x0, x1, fx = taps(w, x.shape[2])
    top = x[:, y0][:, :, x0] * (1 - fx) + x[:, y0][:, :, x1] * fx
    bottom = x[:, y1][:, :, x0] * (1 - fx) + x[:, y1][:, :, x1] * fx
    return top * (1 - fy)[None, :, None] + bottom * fy[None, :, None]


def forward(weights: np.ndarray, layout: dict, x: np.ndarray) -> np.ndarray:
    layers = {layer["name"]: layer for layer in layout["layers"]}

    def run(name: str, t: np.ndarray) -> np.ndarray:
        layer = layers[name]
        n = layer["out"] * layer["in"] * 9
        w = weights[layer["weights"]:layer["weights"] + n].reshape(layer["out"], layer["in"], 3, 3)
        b = weights[layer["bias"]:layer["bias"] + layer["out"]]
        y = conv3x3(t, w, b, layer["stride"])
        return np.maximum(y, 0) if layer["relu"] else y

    def pair(name: str, t: np.ndarray) -> np.ndarray:
        return run(f"{name}.1", run(f"{name}.0", t))

    def merge(name: str, low: np.ndarray, skip: np.ndarray) -> np.ndarray:
        return run(name, np.concatenate([resize_bilinear(low, *skip.shape[1:]), skip]))

    s1 = pair("stem", x)
    s2 = pair("enc2", s1)
    s3 = pair("enc3", s2)
    s4 = pair("enc4", s3)
    d4 = merge("dec4", pair("ctx", s4), s4)
    d3 = merge("dec3", d4, s3)
    d2 = merge("dec2", d3, s2)
    d1 = merge("dec1", d2, s1)
    return run("head", d1)[0]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--run", required=True, type=Path, help="run dir after `train_sky.py export`")
    ap.add_argument("--tolerance", type=float, default=1e-3, help="largest allowed logit difference")
    args = ap.parse_args()
    weights = np.fromfile(args.run / "weights.f32", "<f4")
    layout = json.loads((args.run / "layout.json").read_text())
    worst = 0.0
    for fixture in json.loads((args.run / "fixtures/fixtures.json").read_text()):
        w, h = fixture["input"]
        rgb = np.fromfile(args.run / f"{fixture['stem']}.input.u8", np.uint8).reshape(h, w, 3)
        x = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)
        if layout.get("inputs") == "rgb-ev":
            x = np.concatenate([x, np.zeros((2, h, w), np.float32)])
        lw, lh = fixture["logits"]
        expected = np.fromfile(args.run / f"{fixture['stem']}.logits.f32", "<f4").reshape(lh, lw)
        diff = float(np.abs(forward(weights, layout, x) - expected).max())
        worst = max(worst, diff)
        print(f"{fixture['stem']}: largest logit difference {diff:.2e}")
    print(f"worst {worst:.2e} ({'ok' if worst <= args.tolerance else 'over the tolerance'})")
    if worst > args.tolerance:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
