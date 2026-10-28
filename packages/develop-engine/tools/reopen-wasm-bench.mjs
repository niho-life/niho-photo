// Research only (lane 2 of #125 / #129): what reopening the same photo costs in
// the wasm, as the editor's worker drives it, with the photo's Developer freed
// (today) or kept (the #129 proposal). Every trial is a fresh Node process.
//
//   node tools/reopen-wasm-bench.mjs paired --pkg <dir> --png <p> --meta <m> \
//     [--trials 6] [--presets id,id] [--modes fresh,retained,thumb] --out <file>
//   node tools/reopen-wasm-bench.mjs walk --pkg <dir> --png <p> --meta <m> --retain 0|1 [--photos 30]
//
// <dir>: wasm-bindgen --target web output (niho_develop_wasm.js / _bg.wasm).
// Reopen scenario (1280 = the loupe): open -> first (Final) ["back to the grid"]
// -> fresh: free + open again | retained: keep it | thumb: keep it and draw the
// preset's preview on thumbnail(256) at 96px first (the "見本の 1 枚目で兼ねる"
// prefetch) -> reopenFirst (Final, same settings) -> exposure (+0.3, Final)
// -> preset (the given preset on the exposed settings, Final) -> rest (the
// other presets, Final each).
// walk: N photos one after another (open, first, exposure, preset) keeping
// `retain` earlier Developers alive; the wasm memory after each photo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const UI_MAX = 1280;

async function loadBuild(dir) {
  const wasmBytes = readFileSync(join(dir, "niho_develop_wasm_bg.wasm"));
  const glue = join(mkdtempSync(join(tmpdir(), "niho-reopen-")), "niho_develop_wasm.mjs");
  copyFileSync(join(dir, "niho_develop_wasm.js"), glue);
  const pkg = await import(pathToFileURL(glue).href);
  const exports = pkg.initSync({ module: wasmBytes });
  return { pkg, exports };
}

function baseSettings(pkg) {
  const neutral = JSON.parse(pkg.neutralSettings());
  return { ...neutral, engine: flag("--engine", "niho-11"), look: flag("--look", "niho-standard-5") };
}

function presetSettings(pkg, preset, base, asShot) {
  return JSON.parse(pkg.applyPreset(preset.xmp, JSON.stringify(base), 1, asShot)).settings;
}

async function run() {
  const { pkg, exports } = await loadBuild(resolve(flag("--pkg")));
  const png = readFileSync(resolve(flag("--png")));
  const meta = readFileSync(resolve(flag("--meta")), "utf8");
  const how = flag("--mode", "fresh");
  const presets = JSON.parse(pkg.builtinPresets());
  const first = presets.find((p) => p.id === flag("--preset")) ?? presets[0];
  const steps = [];
  const record = (step, ms, frame) => {
    steps.push({
      step,
      ms,
      memory: exports.memory.buffer.byteLength,
      ...(frame && {
        size: `${frame.width}x${frame.height}`,
        rgbaSha256: createHash("sha256").update(frame.rgba).digest("hex"),
      }),
    });
  };
  const timed = (fn) => {
    const start = performance.now();
    const value = fn();
    return [value, performance.now() - start];
  };
  const open = () => pkg.Developer.openWorkingCopy(png, meta);
  let base = baseSettings(pkg);
  let [developer, ms] = timed(open);
  record("open", ms);
  let frame;
  [frame, ms] = timed(() => developer.render(JSON.stringify(base), UI_MAX, false));
  record("first", ms, frame);
  const asShot = developer.asShotWhite();
  if (how === "fresh") {
    [developer, ms] = timed(() => {
      developer.free();
      return open();
    });
    record("reopen", ms);
  }
  const exposed = { ...base, exposure: base.exposure + 0.3 };
  const presetJson = JSON.stringify(presetSettings(pkg, first, exposed, asShot));
  if (how === "prepared" || how === "preparedAll") {
    // The worker's idle prefetch: the photo's analysis, then colorful's (another CNR).
    [frame, ms] = timed(() => developer.prepareAnalysis(JSON.stringify(base)));
    record("prepareAnalysis", ms);
    if (how === "preparedAll") {
      const colorful = presets.find((p) => p.id === "niho-colorful");
      const json = JSON.stringify(presetSettings(pkg, colorful, base, asShot));
      [frame, ms] = timed(() => developer.prepareAnalysis(json));
      record("prepareAnalysisCnr25", ms);
    }
    frame = undefined;
  }
  if (how === "thumb") {
    [frame, ms] = timed(() => {
      const thumbnail = developer.thumbnail(256);
      const f = thumbnail.render(presetJson, 96, false);
      thumbnail.free();
      return f;
    });
    record("prefetch", ms, frame);
  }
  [frame, ms] = timed(() => developer.render(JSON.stringify(base), UI_MAX, false));
  record("reopenFirst", ms, frame);
  [frame, ms] = timed(() => developer.render(JSON.stringify(exposed), UI_MAX, false));
  record("exposure", ms, frame);
  [frame, ms] = timed(() => developer.render(presetJson, UI_MAX, false));
  record("preset", ms, frame);
  for (const other of presets.filter((p) => p.id !== first.id)) {
    const json = JSON.stringify(presetSettings(pkg, other, exposed, asShot));
    [frame, ms] = timed(() => developer.render(json, UI_MAX, false));
    record(`preset:${other.id}`, ms, frame);
  }
  // A color-only change after a preset (Final's local pass is drawn again when cube Q's statistics move).
  const pastel = presetSettings(pkg, presets.find((p) => p.id === "niho-pastel"), exposed, asShot);
  [frame, ms] = timed(() => developer.render(JSON.stringify(pastel), UI_MAX, false));
  record("pastelAgain", ms, frame);
  [frame, ms] = timed(() => developer.render(JSON.stringify({ ...pastel, vibrance: pastel.vibrance + 20 }), UI_MAX, false));
  record("pastelVibrance", ms, frame);
  process.stdout.write(JSON.stringify({ mode: how, preset: first.id, steps }));
}

async function walk() {
  const { pkg, exports } = await loadBuild(resolve(flag("--pkg")));
  const png = readFileSync(resolve(flag("--png")));
  const meta = readFileSync(resolve(flag("--meta")), "utf8");
  const retain = Number(flag("--retain", "0"));
  const photos = Number(flag("--photos", "30"));
  const presets = JSON.parse(pkg.builtinPresets());
  const base = baseSettings(pkg);
  const kept = [];
  const memory = [];
  let current = null;
  for (let i = 0; i < photos; i++) {
    if (current) kept.push(current);
    // Free what goes over the limit before decoding the next photo.
    while (kept.length > retain) kept.shift().free();
    current = pkg.Developer.openWorkingCopy(png, meta);
    const asShot = current.asShotWhite();
    current.render(JSON.stringify(base), UI_MAX, false);
    if (flag("--prepare", "0") === "1") {
      const colorful = presets.find((p) => p.id === "niho-colorful");
      current.prepareAnalysis(JSON.stringify(base));
      current.prepareAnalysis(JSON.stringify(presetSettings(pkg, colorful, base, asShot)));
    }
    const exposed = { ...base, exposure: 0.3 };
    current.render(JSON.stringify(exposed), UI_MAX, false);
    const preset = presets[i % presets.length];
    current.render(JSON.stringify(presetSettings(pkg, preset, exposed, asShot)), UI_MAX, false);
    memory.push(exports.memory.buffer.byteLength);
  }
  process.stdout.write(JSON.stringify({ retain, prepare: flag("--prepare", "0"), photos, memory, rss: process.memoryUsage().rss }));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function paired() {
  const trials = Number(flag("--trials", "6"));
  const modes = flag("--modes", "fresh,retained,thumb").split(",");
  const pkgArgs = ["--pkg", flag("--pkg"), "--png", flag("--png"), "--meta", flag("--meta")];
  const presetIds = flag("--presets", null)?.split(",") ?? [undefined];
  const runs = [];
  for (const preset of presetIds) {
    for (let trial = 0; trial < trials; trial++) {
      const order = trial % 2 ? [...modes].reverse() : modes;
      for (const how of order) {
        const child = spawnSync(
          process.execPath,
          [script, "run", ...pkgArgs, "--mode", how, ...(preset ? ["--preset", preset] : [])],
          { encoding: "utf8", maxBuffer: 64 << 20 },
        );
        if (child.status !== 0) throw new Error(child.stderr);
        runs.push({ trial, ...JSON.parse(child.stdout) });
      }
    }
  }
  const summary = {};
  for (const run of runs) {
    for (const step of run.steps) {
      const key = `${run.preset}|${step.step}|${run.mode}`;
      (summary[key] ??= { ms: [], memory: [], hashes: new Set() }).ms.push(step.ms);
      summary[key].memory.push(step.memory);
      if (step.rgbaSha256) summary[key].hashes.add(step.rgbaSha256);
    }
  }
  const rows = Object.entries(summary).map(([key, value]) => {
    const [preset, step, how] = key.split("|");
    return {
      preset,
      step,
      mode: how,
      medianMs: median(value.ms),
      rangeMs: [Math.min(...value.ms), Math.max(...value.ms)],
      memory: Math.max(...value.memory),
      hashes: [...value.hashes],
    };
  });
  // Same pixels: every mode's frames of a step have one and the same hash.
  const identical = {};
  for (const row of rows) {
    const k = `${row.preset}|${row.step}`;
    (identical[k] ??= new Set());
    for (const h of row.hashes) identical[k].add(h);
  }
  const mismatches = Object.entries(identical)
    .filter(([, set]) => set.size > 1)
    .map(([k]) => k);
  writeFileSync(resolve(flag("--out")), JSON.stringify({ rows, mismatches, runs }, null, 1));
  for (const row of rows) {
    console.log(
      `${row.preset} ${row.step.padEnd(28)} ${row.mode.padEnd(9)} ${row.medianMs.toFixed(0).padStart(6)} ms ` +
        `[${row.rangeMs.map((v) => v.toFixed(0)).join("-")}] ${(row.memory / 1e6).toFixed(0)} MB`,
    );
  }
  console.log(`pixel mismatches: ${mismatches.length ? mismatches.join(", ") : "none"}`);
}

if (mode === "run") await run();
else if (mode === "walk") await walk();
else if (mode === "paired") paired();
else throw new Error("usage: reopen-wasm-bench.mjs paired|run|walk ... (see the header)");
