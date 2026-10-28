#!/usr/bin/env python3
"""Run the Rust port of candidate A (#128) natively and as wasm, check it against sky_a.py.

Builds nothing: pass the binaries built as the header of sky_a.rs shows.
For every `<input>/<id>.png` writes `<out>/<id>.png` from the native build,
times native (least of `--repeats`, peak RSS) and wasm (bench_a.mjs), and
compares both with the Python output in `--python-out` (agreement of the
masks cut at 0.5, mean absolute difference in 0..255).

  python3 bench_a.py --input <dir> --native <sky_a_native> --wasm <sky_a.wasm> --python-out <dir> --out <dir>
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--native", required=True, type=Path)
    ap.add_argument("--wasm", required=True, type=Path)
    ap.add_argument("--python-out", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--repeats", type=int, default=5)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = {}
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp)
        for png in sorted(args.input.glob("*.png")):
            img = Image.open(png).convert("RGB")
            meta = png.with_suffix(".json")
            ev = json.loads(meta.read_text()).get("ev100") if meta.exists() else None
            (raw / f"{png.stem}.rgb").write_bytes(img.tobytes())
            (raw / f"{png.stem}.meta.json").write_text(json.dumps({"w": img.width, "h": img.height, "ev100": ev}))
            gray = raw / f"{png.stem}.native.gray"
            run = subprocess.run(
                ["/usr/bin/time", "-l", str(args.native), str(raw / f"{png.stem}.rgb"), str(img.width), str(img.height),
                 "nan" if ev is None else str(ev), str(gray), str(args.repeats)],
                capture_output=True, text=True, check=True)
            rss = int(re.search(r"(\d+)\s+maximum resident set size", run.stderr).group(1))
            native = np.frombuffer(gray.read_bytes(), np.uint8).reshape(img.height, img.width)
            Image.fromarray(native, mode="L").save(args.out / png.name)
            rows[png.stem] = {"nativeSeconds": json.loads(run.stdout)["seconds"], "nativePeakRssBytes": rss}
        wasm = json.loads(subprocess.run(["node", str(HERE / "bench_a.mjs"), str(args.wasm), str(raw), str(raw),
                                          str(args.repeats)], capture_output=True, text=True, check=True).stdout)
        for sid, row in rows.items():
            w, h = Image.open(args.out / f"{sid}.png").size
            native = np.asarray(Image.open(args.out / f"{sid}.png"))
            wasm_out = np.frombuffer((raw / f"{sid}.gray").read_bytes(), np.uint8).reshape(h, w)
            py = np.asarray(Image.open(args.python_out / f"{sid}.png").convert("L"))
            row.update(wasmSeconds=wasm[sid]["seconds"], wasmMemoryBytes=wasm[sid]["memoryBytes"],
                       wasmEqualsNative=bool((wasm_out == native).all()),
                       agreeWithPython=float(((native >= 128) == (py >= 128)).mean()),
                       meanAbsDiffPython=float(np.abs(native.astype(int) - py.astype(int)).mean()))
    (args.out / "bench.json").write_text(json.dumps(rows, indent=1))
    keys = ["nativeSeconds", "wasmSeconds", "agreeWithPython", "meanAbsDiffPython"]
    print(json.dumps({k: float(np.median([r[k] for r in rows.values()])) for k in keys}))
    print(json.dumps({"minAgree": min(r["agreeWithPython"] for r in rows.values()),
                      "wasmEqualsNative": all(r["wasmEqualsNative"] for r in rows.values()),
                      "maxNativeRss": max(r["nativePeakRssBytes"] for r in rows.values()),
                      "maxWasmMemory": max(r["wasmMemoryBytes"] for r in rows.values())}))


if __name__ == "__main__":
    main()
