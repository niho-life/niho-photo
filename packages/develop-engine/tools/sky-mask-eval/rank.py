#!/usr/bin/env python3
"""Shortlist scenes per kind for #128 with CLIP text-image similarity.

Only narrows a large private library down to a few contact sheets a person
looks at; it plays no part in the reference masks or the scores. Writes, per
kind, a sheet of the top `--top` photos and `shortlist.json`
(kind -> [[number, relative path, score], ...]).

  python3 rank.py --pool <private dir> --out <private dir>/shortlist [--model openai/clip-vit-large-patch14]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from PIL import Image, ImageDraw
from transformers import CLIPModel, CLIPProcessor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pool import JPEG, RAW, load_any  # noqa: E402

KINDS = {
    "clear": "a photo of a clear blue sky above a town",
    "overcast": "a photo taken outdoors under a grey overcast sky",
    "sunset": "a photo of an orange sunset sky",
    "branches": "bare tree branches against the sky",
    "buildings": "buildings against the sky",
    "wires": "power lines and utility poles against the sky",
    "water": "the sky reflected in calm water",
    "window": "a room interior with a window showing the sky outside",
    "nosky": "a photo of a plain bright wall indoors",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pool", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--model", default="openai/clip-vit-large-patch14")
    ap.add_argument("--top", type=int, default=24)
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in args.pool.rglob("*") if p.is_file() and p.suffix.lower() in JPEG | RAW)
    model = CLIPModel.from_pretrained(args.model).eval().to(args.device)
    proc = CLIPProcessor.from_pretrained(args.model)
    with torch.inference_mode():
        text = proc(text=list(KINDS.values()), return_tensors="pt", padding=True).to(args.device)
        feats, kept, t = [], [], None
        for k in range(0, len(files), 32):
            batch, names = [], []
            for p in files[k:k + 32]:
                try:
                    batch.append(load_any(p, 336))
                    names.append(p)
                except Exception as exc:  # noqa: BLE001
                    print(f"skip {p}: {exc}")
            if not batch:
                continue
            # The full forward returns both embeddings projected and normalised.
            out = model(**text, pixel_values=proc(images=batch, return_tensors="pt")["pixel_values"].to(args.device))
            feats.append(out.image_embeds.cpu())
            t = out.text_embeds.cpu()
            kept += names
        sims = torch.cat(feats) @ t.T  # (N, kinds)
    # Rank each photo by how much more it matches a kind than its own mean.
    rel = sims - sims.mean(1, keepdim=True)
    shortlist = {}
    for j, kind in enumerate(KINDS):
        order = torch.argsort(rel[:, j], descending=True)[: args.top].tolist()
        shortlist[kind] = [[i, str(kept[i].relative_to(args.pool)), float(rel[i, j])] for i in order]
        cell = 248
        sheet = Image.new("RGB", (8 * cell, ((len(order) + 7) // 8) * (cell + 14)), (40, 40, 40))
        draw = ImageDraw.Draw(sheet)
        for n, i in enumerate(order):
            x, y = (n % 8) * cell + 4, (n // 8) * (cell + 14) + 4
            sheet.paste(load_any(kept[i], 240), (x, y))
            draw.text((x, y + 241), f"{kind} {i}", fill=(255, 255, 0))
        sheet.save(args.out / f"{kind}.jpg", quality=80)
    (args.out / "shortlist.json").write_text(json.dumps(shortlist, ensure_ascii=False, indent=1))
    print(f"{len(kept)} photos ranked -> {args.out}")


if __name__ == "__main__":
    main()
