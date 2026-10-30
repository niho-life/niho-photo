#!/usr/bin/env python3
"""Train NIHO's own sky segmentation model for #158 (from scratch; no pretrained weights).

Input: the photo at long edge `--long` (384..512; sRGB 0..1, 3 channels). With `--inputs rgb-ev`
2 more channels carry the exposure: the pixel's scene brightness (EV at ISO 100, (ev - 12) / 4,
from EXIF) and a flag that the exposure is known (EXIF-less photos get 0 / 0). Only use them
when photos with and without exposure have the same mix of sky and no-sky scenes: otherwise the
flag alone predicts the label. Output: sky logits at 1/2 size. A small U-Net (stride-2 stem,
4 levels, 3x3 convolutions + BatchNorm + ReLU) for a future wasm integration; the prediction
helper snaps the upsampled map to the photo with a guided filter. `train` writes the input
settings to `<run>/config.json`; `predict` and `export` read them from there. For the provenance
of a model, `train` writes `<run>/run.json` (command, data and split digests, code hashes, commit,
best epoch) and `export` writes `<run>/export.json` (hashes of what it wrote and what it read).

  python3 train_sky.py train  --data <dir with input/ label/> [--epochs 60] [--inputs rgb] [--long 512] --out <run dir>
  python3 train_sky.py predict --run <run dir> --input <dir of PNG (+ .json ev100)> --out <dir>
  python3 train_sky.py export --run <run dir>     # BatchNorm folded, f32 LE weights + layout JSON
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import resource
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sky_math import guided_filter, srgb_to_lab  # noqa: E402

CH = (16, 32, 48, 64)
INPUTS = {"rgb": 3, "rgb-ev": 5}
# runs written before config.json existed: long edge 384 with the exposure channels
LEGACY_CONFIG = {"long": 384, "inputs": "rgb-ev"}


def conv_bn(cin: int, cout: int, stride: int = 1) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, stride, 1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class SkyNet(nn.Module):
    def __init__(self, inputs: str = "rgb-ev") -> None:
        super().__init__()
        c1, c2, c3, c4 = CH
        self.stem = nn.Sequential(conv_bn(INPUTS[inputs], c1, 2), conv_bn(c1, c1))  # 1/2
        self.enc2 = nn.Sequential(conv_bn(c1, c2, 2), conv_bn(c2, c2))         # 1/4
        self.enc3 = nn.Sequential(conv_bn(c2, c3, 2), conv_bn(c3, c3))         # 1/8
        self.enc4 = nn.Sequential(conv_bn(c3, c4, 2), conv_bn(c4, c4))         # 1/16
        self.ctx = nn.Sequential(conv_bn(c4, c4, 2), conv_bn(c4, c4))          # 1/32 (whole-photo context)
        self.dec4 = conv_bn(c4 + c4, c4)
        self.dec3 = conv_bn(c4 + c3, c3)
        self.dec2 = conv_bn(c3 + c2, c2)
        self.dec1 = conv_bn(c2 + c1, c1)
        self.head = nn.Conv2d(c1, 1, 3, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        s1 = self.stem(x)
        s2 = self.enc2(s1)
        s3 = self.enc3(s2)
        s4 = self.enc4(s3)
        c = self.ctx(s4)
        up = lambda t, ref: F.interpolate(t, size=ref.shape[-2:], mode="bilinear", align_corners=False)  # noqa: E731
        d4 = self.dec4(torch.cat([up(c, s4), s4], 1))
        d3 = self.dec3(torch.cat([up(d4, s3), s3], 1))
        d2 = self.dec2(torch.cat([up(d3, s2), s2], 1))
        d1 = self.dec1(torch.cat([up(d2, s1), s1], 1))
        return self.head(d1)


def features(rgb: np.ndarray, ev100: float | None, inputs: str) -> np.ndarray:
    """(3 or 5, h, w) float32 from an sRGB uint8 photo already at the model size."""
    x = rgb.astype(np.float32) / 255.0
    if inputs == "rgb":
        return np.ascontiguousarray(x.transpose(2, 0, 1))
    if ev100 is not None and math.isfinite(ev100):
        lum = srgb_to_lab(x)[..., 0] / 100.0
        lin = np.where(lum > 0.08, ((lum + 0.16) / 1.16) ** 3, lum / 9.033)
        ev = ev100 + np.log2(np.maximum(lin, 1e-4) / 0.18)
        evc = np.clip((ev - 12.0) / 4.0, -3.0, 3.0).astype(np.float32)
        known = np.ones_like(evc)
    else:
        evc = np.zeros(x.shape[:2], np.float32)
        known = np.zeros(x.shape[:2], np.float32)
    return np.concatenate([x.transpose(2, 0, 1), evc[None], known[None]], 0)


def model_size(w: int, h: int, long: int) -> tuple[int, int]:
    s = long / max(w, h)
    # multiples of 32 so every level halves cleanly
    return max(32, round(w * s / 32) * 32), max(32, round(h * s / 32) * 32)


def load_ev(path: Path) -> float | None:
    meta = path.with_suffix(".json")
    if not meta.exists():
        return None
    v = json.loads(meta.read_text()).get("ev100")
    if type(v) not in (int, float):
        return None
    try:
        ev = float(v)
    except OverflowError:
        return None
    return ev if math.isfinite(ev) else None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def provenance(args, cfg: dict, items: list, train: list, val: list) -> dict:
    here = Path(__file__).resolve().parent
    pairs = "\n".join(f"{img.stem} {sha256(img)} {sha256(label)}" for img, label in items)
    optional = {"ledger": args.data / "ledger.jsonl", "validationIds": args.validation_ids, "sampleWeights": args.sample_weights}
    try:
        commit = subprocess.run(["git", "-C", str(here), "rev-parse", "HEAD"], capture_output=True, text=True,
                                check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        commit = None
    return {
        "command": sys.argv, "config": cfg, "seed": args.seed, "epochs": args.epochs,
        "images": len(items), "train": len(train), "validation": len(val),
        # one line per image: stem, input hash, label hash
        "dataSha256": hashlib.sha256(pairs.encode()).hexdigest(),
        **{f"{k}Sha256": sha256(v) for k, v in optional.items() if v and Path(v).exists()},
        "code": {name: sha256(here / name) for name in ("train_sky.py", "sky_math.py")},
        "commit": commit, "torch": torch.__version__,
    }


def load_config(run: Path) -> dict:
    path = run / "config.json"
    cfg = json.loads(path.read_text()) if path.exists() else dict(LEGACY_CONFIG)
    if cfg.get("inputs") not in INPUTS or not 32 <= int(cfg.get("long", 0)) <= 1024:
        raise ValueError(f"unsupported run config {cfg}")
    return cfg


def draw_wires(img: Image.Image) -> Image.Image:
    """Overhead wires: 1-6 sagging dark lines across the upper frame, 1-2 px at the model size.

    Street photos have wires across the sky, and labels cut from segments leave a gap of
    not-sky along each wire, so a model learns that sky crossed by lines is not sky. The
    label is kept: a line this thin is below the label's resolution (half the model size).
    """
    w, h = img.size
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    for _ in range(random.randint(1, 6)):
        y0, y1 = random.uniform(0, 0.7 * h), random.uniform(0, 0.7 * h)
        sag = random.uniform(0, 0.12 * h)
        t = np.linspace(0, 1, 48)
        xs = -0.1 * w + 1.2 * w * t
        ys = y0 + (y1 - y0) * t + 4 * sag * t * (1 - t)
        tone = random.randint(15, 90)
        draw.line(list(zip(xs.tolist(), ys.tolist())), fill=(tone, tone, tone, random.randint(150, 255)),
                  width=random.choice((1, 1, 2)))
    return Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")


class Data(torch.utils.data.Dataset):
    def __init__(self, items: list[tuple[Path, Path]], train: bool, cfg: dict) -> None:
        self.items, self.train, self.cfg = items, train, cfg

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        img_path, label_path = self.items[i]
        with Image.open(img_path) as im, Image.open(label_path) as lb:
            img = im.convert("RGB")
            label = lb.convert("L").resize(img.size, Image.BILINEAR)
        ev = load_ev(img_path)
        w, h = img.size
        if self.train:
            # random crop of 70-100 % keeping the aspect, flips, exposure / colour jitter
            s = random.uniform(0.7, 1.0)
            cw, ch = int(w * s), int(h * s)
            x0, y0 = random.randint(0, w - cw), random.randint(0, h - ch)
            img, label = img.crop((x0, y0, x0 + cw, y0 + ch)), label.crop((x0, y0, x0 + cw, y0 + ch))
            if random.random() < 0.5:
                img, label = img.transpose(Image.FLIP_LEFT_RIGHT), label.transpose(Image.FLIP_LEFT_RIGHT)
        mw, mh = model_size(*img.size, self.cfg["long"])
        img = img.resize((mw, mh), Image.BILINEAR)
        if self.train and random.random() < self.cfg.get("wires", 0.0):
            img = draw_wires(img)
        lab = np.asarray(label.resize((mw // 2, mh // 2), Image.BILINEAR), np.float32) / 255.0
        rgb = np.asarray(img).astype(np.float32)
        if self.train:
            gain = 2 ** random.uniform(-0.7, 0.7)  # exposure change; the EV moves the other way
            srgb = rgb / 255.0
            linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
            linear = np.clip(linear * gain * np.array([random.uniform(0.9, 1.1) for _ in range(3)]), 0, 1)
            rgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055) * 255.0
            if ev is not None:
                ev = ev - math.log2(gain)
            if random.random() < 0.2:
                ev = None  # learn to work without EXIF too
        x = features(rgb.astype(np.uint8), ev, self.cfg["inputs"])
        return torch.from_numpy(x), torch.from_numpy(lab[None])


def collate(batch):
    # photos differ in aspect: pad to the batch's largest size (label padding ignored via weight)
    H = max(x.shape[1] for x, _ in batch)
    W = max(x.shape[2] for x, _ in batch)
    xs, ys, ws = [], [], []
    for x, y in batch:
        px, py = W - x.shape[2], H - x.shape[1]
        xs.append(F.pad(x, (0, px, 0, py)))
        ys.append(F.pad(y, (0, px // 2, 0, py // 2)))
        m = torch.zeros_like(ys[-1])
        m[:, : y.shape[1], : y.shape[2]] = 1
        ws.append(m)
    return torch.stack(xs), torch.stack(ys), torch.stack(ws)


def cmd_train(args) -> None:
    # data loader workers hold pipes and shared memory; a 256-file soft limit stops long runs
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    want = 4096 if hard == resource.RLIM_INFINITY else min(4096, hard)
    if soft != resource.RLIM_INFINITY and soft < want:
        resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    if not 384 <= args.long <= 512 or args.long % 32:
        raise ValueError("--long must be a multiple of 32 in 384..512")
    if not 0 <= args.wire_aug <= 1:
        raise ValueError("--wire-aug must be a probability")
    cfg = {"long": args.long, "inputs": args.inputs, "wires": args.wire_aug}
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    items = []
    for label in sorted((args.data / "label").glob("*.png")):
        img = args.data / "input" / label.name
        if img.exists():
            items.append((img, label))
    metadata_count = sum(load_ev(img) is not None for img, _ in items)
    print(f"exposure metadata {metadata_count}/{len(items)}")
    if args.inputs == "rgb-ev" and args.expect_ev_count is not None and metadata_count != args.expect_ev_count:
        raise ValueError(f"exposure metadata count differs from --expect-ev-count ({metadata_count} != {args.expect_ev_count})")
    if args.validation_ids:
        val_ids = json.loads(args.validation_ids.read_text())
        if not isinstance(val_ids, list) or not val_ids or any(not isinstance(i, str) for i in val_ids):
            raise ValueError("--validation-ids must be a nonempty JSON array of image stems")
        if len(val_ids) != len(set(val_ids)):
            raise ValueError("--validation-ids contains duplicate stems")
        known = {img.stem for img, _ in items}
        if unknown := set(val_ids) - known:
            raise ValueError(f"--validation-ids contains {len(unknown)} unknown stems")
        val_set = set(val_ids)
        val = [item for item in items if item[0].stem in val_set]
        train = [item for item in items if item[0].stem not in val_set]
    else:
        random.shuffle(items)
        n_val = max(20, len(items) // 20)
        val, train = items[:n_val], items[n_val:]
        print("warning: random validation split is only a training signal; use an independent scene holdout for acceptance")
    if not train or not val:
        raise ValueError("training and validation must each contain at least one image")
    print(f"train {len(train)} val {len(val)}")
    weights = None
    if args.sample_weights:
        table = json.loads(args.sample_weights.read_text())
        if not isinstance(table, dict) or any(type(v) not in (int, float) or not 0 < v <= 100 for v in table.values()):
            raise ValueError("--sample-weights must map image stems to weights in (0, 100]")
        weights = [float(table.get(img.stem, 1.0)) for img, _ in train]
    dev = torch.device(args.device)
    net = SkyNet(cfg["inputs"]).to(dev)
    print("parameters", sum(p.numel() for p in net.parameters()), "config", cfg)
    opt = torch.optim.AdamW(net.parameters(), lr=3e-3, weight_decay=1e-4)
    sampler = torch.utils.data.WeightedRandomSampler(weights, len(train)) if weights else None
    loader = torch.utils.data.DataLoader(Data(train, True, cfg), batch_size=16, shuffle=sampler is None, sampler=sampler,
                                         num_workers=6, collate_fn=collate, persistent_workers=True)
    vloader = torch.utils.data.DataLoader(Data(val, False, cfg), batch_size=16, num_workers=4, collate_fn=collate,
                                          persistent_workers=True)
    steps = args.epochs * len(loader)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps, pct_start=0.1)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "config.json").write_text(json.dumps(cfg))
    record = provenance(args, cfg, items, train, val)
    (args.out / "run.json").write_text(json.dumps(record, indent=1))
    best = 1e9
    for epoch in range(args.epochs):
        net.train()
        t0, tot = time.time(), 0.0
        for x, y, w in loader:
            x, y, w = x.to(dev), y.to(dev), w.to(dev)
            logit = net(x)
            bce = F.binary_cross_entropy_with_logits(logit, y, weight=w)
            p = torch.sigmoid(logit) * w
            dice = 1 - (2 * (p * y).sum() + 1) / (p.sum() + (y * w).sum() + 1)
            loss = bce + 0.5 * dice
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
        net.eval()
        inter = union = 0.0
        with torch.no_grad():
            for x, y, w in vloader:
                p = (torch.sigmoid(net(x.to(dev))) > 0.5).float() * w.to(dev)
                t = (y.to(dev) > 0.5).float() * w.to(dev)
                inter += (p * t).sum().item()
                union += ((p + t) > 0).float().sum().item()
        viou = inter / max(union, 1)
        print(f"epoch {epoch + 1} loss {tot / len(loader):.4f} val IoU {viou:.4f} {time.time() - t0:.0f}s", flush=True)
        if -viou < best:
            best = -viou
            torch.save(net.state_dict(), args.out / "best.pt")
            record.update(bestEpoch=epoch + 1, bestValidationIoU=round(viou, 4))
    torch.save(net.state_dict(), args.out / "last.pt")
    (args.out / "run.json").write_text(json.dumps(record, indent=1))


def predict_one(net: SkyNet, rgb: np.ndarray, ev: float | None, dev, cfg: dict) -> np.ndarray:
    h0, w0 = rgb.shape[:2]
    mw, mh = model_size(w0, h0, cfg["long"])
    small = np.asarray(Image.fromarray(rgb).resize((mw, mh), Image.BILINEAR))
    x = torch.from_numpy(features(small, ev, cfg["inputs"]))[None].to(dev)
    with torch.no_grad():
        p = torch.sigmoid(net(x))[0, 0].cpu().numpy()
    up = np.asarray(Image.fromarray(p.astype(np.float32), mode="F").resize((w0, h0), Image.BILINEAR))
    guide = srgb_to_lab(rgb.astype(np.float32) / 255.0)[..., 0] / 100.0
    r = max(2, round(max(w0, h0) / 256))
    return np.clip(guided_filter(guide, up.astype(np.float32), r, 1e-3), 0, 1)


def cmd_predict(args) -> None:
    dev = torch.device(args.device)
    cfg = load_config(args.run)
    net = SkyNet(cfg["inputs"]).to(dev)
    net.load_state_dict(torch.load(args.run / args.weights, map_location=dev))
    net.eval()
    args.out.mkdir(parents=True, exist_ok=True)
    times = {}
    for path in sorted(args.input.glob("*.png")):
        with Image.open(path) as im:
            rgb = np.asarray(im.convert("RGB"))
        t = time.perf_counter()
        prob = predict_one(net, rgb, load_ev(path), dev, cfg)
        times[path.stem] = time.perf_counter() - t
        Image.fromarray(np.round(prob * 255).astype(np.uint8), mode="L").save(args.out / path.name)
    (args.out / "timing.json").write_text(json.dumps(times, indent=1))
    print(f"{len(times)} -> {args.out}")


def cmd_export(args) -> None:
    """Fold BatchNorm into each convolution; write weights.f32 (little endian) + layout.json."""
    cfg = load_config(args.run)
    net = SkyNet(cfg["inputs"])
    net.load_state_dict(torch.load(args.run / args.weights, map_location="cpu"))
    net.eval()
    layers, blobs = [], []
    offset = 0

    def add(name: str, conv: nn.Conv2d, bn: nn.BatchNorm2d | None, relu: bool) -> None:
        nonlocal offset
        w = conv.weight.detach().double()
        b = conv.bias.detach().double() if conv.bias is not None else torch.zeros(w.shape[0], dtype=torch.float64)
        if bn is not None:
            scale = bn.weight.detach().double() / torch.sqrt(bn.running_var.double() + bn.eps)
            w = w * scale[:, None, None, None]
            b = (b - bn.running_mean.double()) * scale + bn.bias.detach().double()
        wf, bf = w.float().numpy().ravel(), b.float().numpy().ravel()
        layers.append({"name": name, "in": int(w.shape[1]), "out": int(w.shape[0]), "stride": int(conv.stride[0]),
                       "relu": relu, "weights": offset, "bias": offset + wf.size})
        blobs.extend([wf, bf])
        offset += wf.size + bf.size

    def seq(name: str, s: nn.Sequential) -> None:
        for k, block in enumerate(s):
            add(f"{name}.{k}", block[0], block[1], True)

    for name in ("stem", "enc2", "enc3", "enc4", "ctx"):
        seq(name, getattr(net, name))
    for name in ("dec4", "dec3", "dec2", "dec1"):
        block = getattr(net, name)
        add(name, block[0], block[1], True)
    add("head", net.head, None, False)
    data = np.concatenate(blobs).astype("<f4")
    (args.run / "weights.f32").write_bytes(data.tobytes())
    (args.run / "layout.json").write_text(json.dumps({"long": cfg["long"], "inputs": cfg["inputs"], "channels": CH, "floats": int(data.size),
                                                      "layers": layers}, indent=1))
    read = {name: sha256(args.run / name) for name in (args.weights, "config.json", "run.json") if (args.run / name).exists()}
    (args.run / "export.json").write_text(json.dumps({
        "read": read,
        "wrote": {name: sha256(args.run / name) for name in ("weights.f32", "layout.json")},
        "code": sha256(Path(__file__).resolve()),
    }, indent=1))
    print(f"{len(layers)} layers, {data.size} floats ({data.nbytes} bytes)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", required=True, type=Path)
    t.add_argument("--out", required=True, type=Path)
    t.add_argument("--epochs", type=int, default=60)
    t.add_argument("--inputs", choices=sorted(INPUTS), default="rgb",
                   help="rgb-ev adds the exposure channels (needs exposure on sky and no-sky photos alike)")
    t.add_argument("--long", type=int, default=384, help="model long edge, multiple of 32 in 384..512")
    t.add_argument("--seed", type=int, default=0)
    t.add_argument("--sample-weights", type=Path, help="JSON object: image stem -> sampling weight (default 1)")
    t.add_argument("--wire-aug", type=float, default=0.0, help="probability of drawing synthetic wires on a training photo")
    t.add_argument("--device", default="mps")
    t.add_argument("--validation-ids", type=Path, help="JSON array of image stems from distinct capture groups")
    t.add_argument("--expect-ev-count", type=int, help="expected number of photos with exposure sidecars; abort on mismatch")
    p = sub.add_parser("predict")
    p.add_argument("--run", required=True, type=Path)
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--weights", default="best.pt")
    p.add_argument("--device", default="mps")
    e = sub.add_parser("export")
    e.add_argument("--run", required=True, type=Path)
    e.add_argument("--weights", default="best.pt")
    args = ap.parse_args()
    {"train": cmd_train, "predict": cmd_predict, "export": cmd_export}[args.cmd](args)


if __name__ == "__main__":
    main()
