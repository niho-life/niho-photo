// The wasm linear memory a photo editor worker holds (#155): the editor's holdings (the open photo, the kept photo,
// the analysis made ahead, the preset thumbnails' session) and the one-off work beside them (a large export, the
// analysis helper), each scenario in its own Node process (a cold single-thread wasm instance, as the Web Worker).
// The linear memory never shrinks, so its byteLength after a step is the high-water so far: the physical memory the
// worker keeps until it ends. No private photos and no npm dependencies.
//
//   cargo run --release -p niho-develop --example stage_timing -- --photo signed --dump <inputs>
//   cargo +1.98.1 build --release --config .cargo/config.toml --target wasm32-unknown-unknown -p niho-develop-wasm
//   wasm-bindgen --target web --out-dir <pkg> target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
//   node tools/memory-budget-bench.mjs <pkg> <inputs> --jpeg fixtures/public-raw/dc-s5-owner-camera.jpg \
//     [--scenario <name>|all] [--trials 2]
//
// One JSON line per scenario: every step's high-water (the most of `trials` runs: a run only adds memory) and RSS,
// and the RGBA SHA-256 of the frames that the same settings draw in more than one scenario (the policy must not change
// the pixels). Node on a Mac is a reference environment, not a browser / device claim.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [pkgDir, inputsDir, ...rest] = process.argv.slice(2);
if (!pkgDir || !inputsDir) throw new Error("usage: memory-budget-bench.mjs <pkg> <inputs> --jpeg <photo> [--scenario s]");
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const jpegPath = flag("--jpeg", null);
const only = flag("--scenario", "all");
const trials = Number(flag("--trials", "2"));
const one = flag("--one", null);

const UI = 1280;
const PRESET_THUMBNAIL = 96;
// The editor's steady holdings, then what large exports add with the holdings kept / released first.
const STEADY = ["open", "first", "drag", "ahead", "thumb", "keep", "first", "ahead", "thumb"];
const SCENARIOS = {
  active: ["open", "first", "drag"],
  activeAhead: ["open", "first", "drag", "ahead"],
  activeThumb: ["open", "first", "drag", "thumb"],
  steadyNoKept: ["open", "first", "drag", "ahead", "thumb", "replace", "first", "ahead", "thumb"],
  steady: STEADY,
  exportWcHeavyRetain: [...STEADY, "exportWcHeavy"],
  exportWcHeavyEvict: [...STEADY, "evict", "exportWcHeavy"],
  exportJpegHeavyRetain: [...STEADY, "exportJpegHeavy"],
  exportJpegHeavyEvict: [...STEADY, "evict", "exportJpegHeavy"],
  aloneExportWc2048: ["exportWc2048"],
  aloneExportWcHeavy: ["exportWcHeavy"],
  aloneExportJpeg2048: ["exportJpeg2048"],
  aloneExportJpeg: ["exportJpeg"],
  aloneExportJpegHeavy: ["exportJpegHeavy"],
  helper: ["helper"],
};

/** Every correction a large export can carry (#134's heaviest case): masks, detail, geometry, heal and lens. */
function heavySettings(base) {
  return {
    ...base,
    v: Math.max(9, base.v ?? 1),
    masks: [
      { id: "m1", kind: "linear", zero: { x: 0.5, y: 0.1 }, full: { x: 0.5, y: 0.45 }, adjust: { exposure: -0.6 } },
      {
        id: "m2",
        kind: "radial",
        invert: true,
        center: { x: 0.5, y: 0.5 },
        radius: { x: 0.35, y: 0.25 },
        angle: 10,
        feather: 50,
        adjust: { exposure: -0.4, saturation: -20 },
      },
      { id: "m3", kind: "linear", zero: { x: 0.1, y: 0.9 }, full: { x: 0.4, y: 0.6 }, adjust: { highlights: -30 } },
    ],
    detail: {
      sharpening: { amount: 60, radius: 1, detail: 25, masking: 10 },
      luminanceNoiseReduction: 30,
      colorNoiseReduction: 25,
    },
    geometry: { perspective: { vertical: -10 }, constrain: true },
    heal: [{ id: "h1", mode: "remove", radius: 0.03, feather: 0.5, points: [[0.3, 0.4], [0.35, 0.42]] }],
    lens: { distortion: 10, removeChromaticAberration: true, defringe: { purple: { amount: 20 } } },
  };
}

if (one) {
  // Through a .mjs copy: the build directory has no "type": "module".
  const glue = join(mkdtempSync(join(tmpdir(), "niho-memory-bench-")), "niho_develop_wasm.mjs");
  copyFileSync(join(resolve(pkgDir), "niho_develop_wasm.js"), glue);
  const pkg = await import(pathToFileURL(glue).href);
  const exports = pkg.initSync({ module: readFileSync(join(resolve(pkgDir), "niho_develop_wasm_bg.wasm")) });
  const png = readFileSync(join(inputsDir, "signed.png"));
  const { meta } = JSON.parse(readFileSync(join(inputsDir, "signed.json"), "utf8"));
  const jpeg = jpegPath ? readFileSync(jpegPath) : null;
  const openWc = () => pkg.Developer.openWorkingCopy(png, meta);
  let active = null;
  let kept = null;
  let thumbnail = null;
  const neutral = JSON.parse(pkg.neutralSettings());
  const base = { ...neutral, engine: "niho-11", look: "niho-standard-5" };
  const baseJson = JSON.stringify(base);
  const presets = JSON.parse(pkg.builtinPresets());
  let asShot = null;
  const preset = (id) =>
    JSON.stringify(JSON.parse(pkg.applyPreset(presets.find((p) => p.id === id).xmp, baseJson, 1, asShot)).settings);
  const heavy = JSON.stringify(heavySettings(base));
  // A JPEG opens on the neutral settings' engine and look.
  const heavyRaster = JSON.stringify(heavySettings(neutral));
  const plainRaster = JSON.stringify(neutral);
  for (const [name, json] of [["heavy", heavy], ["heavyRaster", heavyRaster]]) {
    const issues = JSON.parse(pkg.validateSettings(json));
    if (issues.length) throw new Error(`${name} settings: ${JSON.stringify(issues)}`);
  }
  const digest = (frame) => createHash("sha256").update(frame.rgba).digest("hex").slice(0, 16);
  const frames = {};
  const free = (developer) => developer?.free();
  const exportOnce = (open, settings, maxDimension) => {
    const temp = open();
    try {
      const frame = temp.render(settings, maxDimension, false);
      return `${frame.width}x${frame.height}:${digest(frame)}`;
    } finally {
      temp.free();
    }
  };
  const steps = {
    open: () => {
      active = openWc();
      asShot ??= active.asShotWhite();
    },
    first: () => {
      frames.first = digest(active.render(baseJson, UI, false));
    },
    drag: () => {
      for (let i = 1; i <= 3; i++) active.render(JSON.stringify({ ...base, exposure: 0.1 * i }), UI, true);
      frames.dragFinal = digest(active.render(JSON.stringify({ ...base, exposure: 0.3 }), UI, false));
    },
    // The worker's #129 ahead: the colorful preset's analysis (CNR 25) beside the open settings' one.
    ahead: () => active.prepareAnalysis(preset("niho-colorful")),
    thumb: () => {
      free(thumbnail);
      thumbnail = active.thumbnail(256);
      const hash = createHash("sha256");
      for (const p of presets) hash.update(thumbnail.render(preset(p.id), PRESET_THUMBNAIL, false).rgba);
      frames.thumbnails = hash.digest("hex").slice(0, 16);
    },
    // releaseDeveloper: the kept photo drops its thumbnail session and the analysis made ahead.
    keep: () => {
      free(thumbnail);
      thumbnail = null;
      active.releaseAnalysisAhead();
      free(kept);
      kept = active;
      active = openWc();
    },
    // The mobile profile: nothing kept, the open photo is freed before the next one decodes.
    replace: () => {
      free(thumbnail);
      thumbnail = null;
      free(active);
      active = openWc();
    },
    // What the worker releases before a large export: the thumbnail session, the kept photo, the analysis ahead.
    evict: () => {
      free(thumbnail);
      thumbnail = null;
      free(kept);
      kept = null;
      active.releaseAnalysisAhead();
    },
    exportWc2048: () => {
      frames.exportWc2048 = exportOnce(openWc, baseJson, 2048);
    },
    exportWcHeavy: () => {
      frames.exportWcHeavy = exportOnce(openWc, heavy, 2560);
    },
    exportJpeg2048: () => {
      frames.exportJpeg2048 = exportOnce(() => new pkg.Developer(jpeg, 4096), plainRaster, 2048);
    },
    exportJpeg: () => {
      frames.exportJpeg = exportOnce(() => new pkg.Developer(jpeg, 4096), plainRaster, 4096);
    },
    exportJpegHeavy: () => {
      frames.exportJpegHeavy = exportOnce(() => new pkg.Developer(jpeg, 4096), heavyRaster, 4096);
    },
    // The analysis helper (#155): the same working copy opened again, its analysis made into bytes.
    helper: () => {
      const helper = openWc();
      asShot ??= helper.asShotWhite();
      const bytes = helper.exportAnalysis(preset("niho-colorful"));
      frames.helperBytes = bytes?.byteLength ?? 0;
      helper.free();
    },
  };
  const out = [];
  for (const step of SCENARIOS[one]) {
    if ((step.startsWith("exportJpeg") || step === "exportJpeg") && !jpeg) throw new Error("--jpeg is required");
    const start = performance.now();
    steps[step]();
    out.push({
      step,
      ms: Math.round(performance.now() - start),
      memoryMiB: Math.round(exports.memory.buffer.byteLength / 1048576),
      rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    });
  }
  free(thumbnail);
  free(kept);
  free(active);
  console.log(JSON.stringify({ scenario: one, steps: out, frames, engine: pkg.version() }));
} else {
  for (const scenario of Object.keys(SCENARIOS)) {
    if (only !== "all" && only !== scenario) continue;
    const runs = [];
    for (let t = 0; t < trials; t++) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), pkgDir, inputsDir, "--one", scenario, ...(jpegPath ? ["--jpeg", jpegPath] : [])],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (child.status !== 0) throw new Error(`${scenario} failed`);
      runs.push(JSON.parse(child.stdout));
    }
    for (const run of runs.slice(1)) {
      if (JSON.stringify(run.frames) !== JSON.stringify(runs[0].frames)) throw new Error(`${scenario}: other bytes`);
    }
    const steps = runs[0].steps.map((step, i) => ({
      ...step,
      ms: Math.min(...runs.map((run) => run.steps[i].ms)),
      memoryMiB: Math.max(...runs.map((run) => run.steps[i].memoryMiB)),
      rssMiB: Math.max(...runs.map((run) => run.steps[i].rssMiB)),
    }));
    console.log(JSON.stringify({ ...runs[0], steps, trials }));
  }
}
