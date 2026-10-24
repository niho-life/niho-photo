// Timings of the layered mask render in wasm (docs/local-adjustments.md「性能の目安と測り方」, #66): the scenarios of
// crates/niho-develop/examples/mask_timing.rs on the same synthetic inputs, through the wasm Developer as the editor's
// worker drives it (single thread, Node's wasm SIMD). No private photos and no npm dependencies.
//
//   cargo run --release -p niho-develop --example mask_timing -- --dump <inputs>
//   cargo +1.98.1 build --release --config .cargo/config.toml --target wasm32-unknown-unknown -p niho-develop-wasm
//   wasm-bindgen --target web --out-dir <pkg> target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
//   node tools/mask-wasm-bench.mjs <pkg> <inputs> [--source raster|raw|all] [--trials 3] [--drag <px>]
//
// One JSON line per (source, masks, delta), each measured in its own Node process (a cold wasm instance): the least of
// `trials` runs per timing (other load on the machine only adds time) and the wasm linear memory after them (it never
// shrinks: the case's high-water). `--drag` is the long edge of the Interactive frames (default 1280; the editor draws 640
// while a mask is active). dragGlobalFirst is the first frame of the global drag (it draws the layers, #92), and
// dragGlobalFast the mean of 6 more frames moving Contrast by 10 each.
// Node on a Mac is a reference environment, not a browser / device performance claim.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const [pkgDir, inputsDir, ...rest] = process.argv.slice(2);
if (!pkgDir || !inputsDir) throw new Error("usage: mask-wasm-bench.mjs <pkg> <inputs> [--source s] [--trials n]");
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const only = flag("--source", "all");
const trials = Number(flag("--trials", "3"));
const one = flag("--one", null);
const DRAG = Number(flag("--drag", "1280"));

// Through a .mjs copy: the build directory has no "type": "module".
const glue = join(mkdtempSync(join(tmpdir(), "niho-mask-bench-")), "niho_develop_wasm.mjs");
copyFileSync(join(resolve(pkgDir), "niho_develop_wasm.js"), glue);
const pkg = await import(pathToFileURL(glue).href);
const exports = pkg.initSync({ module: readFileSync(join(resolve(pkgDir), "niho_develop_wasm_bg.wasm")) });

const UI = 1280;
const DRAG_FRAMES = 6;
const raster = readFileSync(join(inputsDir, "raster.png"));
const rawPng = readFileSync(join(inputsDir, "raw.png"));
const rawMeta = readFileSync(join(inputsDir, "raw.json"), "utf8");

const GLOBAL = {
  raster: { v: 5, engine: "niho-10", look: "niho-standard-1", base: null, highlights: -30, shadows: 20, contrast: 10, vibrance: 10 },
  raw: { v: 5, engine: "niho-11", look: "niho-standard-5", base: null, exposure: -0.2, highlights: -40, shadows: 20, contrast: 10 },
};
const DELTAS = [
  ["cube", "saturation", 20],
  ["exposure", "exposure", -0.7],
  ["spatial", "clarity", 25],
];
const SHAPES = [
  { kind: "linear", zero: { x: 0.5, y: 0.55 }, full: { x: 0.5, y: 0.2 } },
  { kind: "radial", center: { x: 0.63, y: 0.66 }, radius: { x: 0.15, y: 0.22 }, angle: 10, feather: 50 },
  { kind: "radial", invert: true, center: { x: 0.5, y: 0.5 }, radius: { x: 0.45, y: 0.5 }, angle: 0, feather: 80 },
];

function adjust(kind, key, value) {
  const a = { [key]: value };
  if (kind === "spatial") Object.assign(a, { texture: 20, shadows: 25, highlights: -30 });
  if (kind === "cube") a.contrast = 15;
  return a;
}

/** The settings JSON with `count` masks; the first one's dragged key moved by `step`. */
function settings(source, count, [kind, key, value], step, contrast) {
  const s = { ...GLOBAL[source], contrast };
  if (count > 0) {
    s.masks = SHAPES.slice(0, count).map((shape, i) => ({
      ...shape,
      id: `m${i}`,
      adjust: adjust(kind, key, i === 0 ? value + step * Math.sign(value) * 0.02 : value * 0.5),
    }));
  }
  return JSON.stringify(s);
}

const open = (source) =>
  source === "raster" ? new pkg.Developer(raster, 0) : pkg.Developer.openWorkingCopy(rawPng, rawMeta);
const timed = (fn) => {
  const start = performance.now();
  fn();
  return Math.round((performance.now() - start) * 10) / 10;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function scenario(source, count, delta) {
  const contrast = GLOBAL[source].contrast;
  const moved = (i) => (count === 0 ? settings(source, 0, delta, 0, contrast + i) : settings(source, count, delta, i, contrast));
  let developer = open(source);
  const first = timed(() => developer.render(settings(source, count, delta, 0, contrast), UI, false));
  const dragFirst = timed(() => developer.render(moved(1), DRAG, true));
  const dragMask = median(Array.from({ length: DRAG_FRAMES }, (_, i) => timed(() => developer.render(moved(i + 2), DRAG, true))));
  const release = timed(() => developer.render(moved(1 + DRAG_FRAMES), UI, false));
  const global = Array.from({ length: DRAG_FRAMES }, (_, i) =>
    timed(() => developer.render(settings(source, count, delta, 1 + DRAG_FRAMES, contrast + i + 1), DRAG, true)),
  );
  const dragGlobalFirst = global[0];
  const dragGlobal = median(global);
  const fast = Array.from({ length: DRAG_FRAMES }, (_, i) =>
    timed(() =>
      developer.render(settings(source, count, delta, 1 + DRAG_FRAMES, contrast + DRAG_FRAMES + 10 * (i + 1)), DRAG, true),
    ),
  );
  const dragGlobalFast = Math.round((fast.reduce((a, b) => a + b, 0) / fast.length) * 10) / 10;
  developer.free();
  developer = open(source);
  const full = timed(() => developer.render(settings(source, count, delta, 0, contrast), 0, false));
  developer.free();
  return { first, dragFirst, dragMask, dragGlobal, dragGlobalFirst, dragGlobalFast, release, full };
}

if (one) {
  const [source, count, name] = one.split(":");
  const delta = DELTAS.find(([kind]) => kind === name);
  const best = {};
  for (let t = 0; t < trials; t++) {
    for (const [k, v] of Object.entries(scenario(source, Number(count), delta))) best[k] = Math.min(best[k] ?? Infinity, v);
  }
  console.log(
    JSON.stringify({
      source,
      masks: Number(count),
      delta: name,
      trials,
      dragPx: DRAG,
      firstMs: best.first,
      dragFirstMs: best.dragFirst,
      dragMaskMs: best.dragMask,
      dragGlobalMs: best.dragGlobal,
      dragGlobalFirstMs: best.dragGlobalFirst,
      dragGlobalFastMs: best.dragGlobalFast,
      releaseMs: best.release,
      fullMs: best.full,
      memoryMiB: Math.round(exports.memory.buffer.byteLength / 1048576),
      engine: pkg.version(),
    }),
  );
} else {
  for (const source of ["raster", "raw"]) {
    if (only !== "all" && only !== source) continue;
    for (const [name] of DELTAS) {
      for (let count = 0; count <= 3; count++) {
        if (count === 0 && name !== "cube") continue;
        const child = spawnSync(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            pkgDir,
            inputsDir,
            "--one",
            `${source}:${count}:${name}`,
            "--trials",
            String(trials),
            "--drag",
            String(DRAG),
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
        );
        if (child.status !== 0) throw new Error(`${source} ${count} ${name} failed`);
        process.stdout.write(child.stdout);
      }
    }
  }
}
