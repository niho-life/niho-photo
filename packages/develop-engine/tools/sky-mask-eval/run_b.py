#!/usr/bin/env python3
"""Candidate B of #128: COCO panoptic models (Mask2Former / DETR) as a sky map.

Evaluation only. The weights are fetched into the local Hugging Face cache of
the machine that runs this (Mac Studio) and never enter the repository.

The sky probability is the semantic score of `sky-other-merged` (COCO
panoptic category 187; sum over queries of class probability x mask probability, the same score the
models' own semantic post-processing takes the argmax of), divided by the sum
over all classes, then resized to the input size.

  python3 run_b.py --model facebook/mask2former-swin-large-coco-panoptic \
      --input <dir of PNG> --out <dir> [--long-edge 1024] [--device mps|cpu] [--half]
"""
from __future__ import annotations

import argparse
import json
import resource
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from transformers import AutoImageProcessor, DetrForSegmentation, Mask2FormerForUniversalSegmentation


def sync(device: str) -> None:
    if device == "mps":
        torch.mps.synchronize()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", required=True)
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--long-edge", type=int, default=1024, help="model input long edge (shortest edge follows)")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--half", action="store_true")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    is_detr = "detr" in args.model
    cls = DetrForSegmentation if is_detr else Mask2FormerForUniversalSegmentation
    t_load = time.perf_counter()
    processor = AutoImageProcessor.from_pretrained(args.model)
    model = cls.from_pretrained(args.model).eval().to(args.device)
    dtype = torch.float16 if args.half else torch.float32
    model = model.to(dtype)
    load_s = time.perf_counter() - t_load
    if is_detr:
        # The DETR panoptic config carries COCO-stuff names, but the model predicts COCO
        # panoptic category ids, where 187 is sky-other-merged (it wins the sky of every
        # photo; the config's own "sky-other" at 157 never fires).
        sky_id = 187
    else:
        labels = model.config.id2label
        sky = [int(k) for k, v in labels.items() if v == "sky-other-merged"]
        if len(sky) != 1:
            raise SystemExit(f"expected one sky label, got {[labels[k] for k in sky]}")
        sky_id = sky[0]
    params = sum(p.numel() for p in model.parameters())

    paths = sorted(args.input.glob("*.png"))
    timing: dict[str, dict] = {}
    for warm, path in [(True, paths[0])] * 2 + [(False, p) for p in paths]:
        img = Image.open(path).convert("RGB")
        w, h = img.size
        s = args.long_edge / max(w, h)
        # Multiples of 32 so no processor pads (the mask then covers exactly the photo).
        iw, ih = max(32, round(w * s / 32) * 32), max(32, round(h * s / 32) * 32)
        t0 = time.perf_counter()
        inputs = processor(images=img.resize((iw, ih), Image.BICUBIC), return_tensors="pt",
                           do_resize=False)
        pixel = inputs["pixel_values"].to(args.device, dtype)
        extra = {"pixel_mask": inputs["pixel_mask"].to(args.device)} if "pixel_mask" in inputs else {}
        with torch.inference_mode():
            out = model(pixel_values=pixel, **extra)
            logits = out.logits if is_detr else out.class_queries_logits
            masks = out.pred_masks if is_detr else out.masks_queries_logits
            cls_p = logits.float().softmax(-1)[0, :, :-1]  # drop "no object"
            mask_p = masks.float()[0].sigmoid()
            seg = torch.einsum("qc,qhw->chw", cls_p, mask_p)
            prob = seg[sky_id] / seg.sum(0).clamp_min(1e-6)
            prob = F.interpolate(prob[None, None], size=(h, w), mode="bilinear", align_corners=False)[0, 0]
            arr = prob.clamp(0, 1).cpu().numpy()
        sync(args.device)
        dt = time.perf_counter() - t0
        if warm:
            continue
        Image.fromarray(np.round(arr * 255).astype(np.uint8), mode="L").save(args.out / path.name)
        timing[path.stem] = {"seconds": dt, "inputSize": [iw, ih]}

    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # bytes on macOS
    summary = {
        "model": args.model,
        "device": args.device,
        "dtype": str(dtype),
        "longEdge": args.long_edge,
        "parameters": params,
        "loadSeconds": load_s,
        "peakRssBytes": peak_rss,
        "mpsDriverBytes": torch.mps.driver_allocated_memory() if args.device == "mps" else None,
        "medianSeconds": float(np.median([t["seconds"] for t in timing.values()])),
        "images": timing,
    }
    (args.out / "timing.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "images"}))


if __name__ == "__main__":
    main()
