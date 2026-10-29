// Timings of the editor's released frames in wasm (#150): the steps of crates/niho-develop/examples/stage_timing.rs
// (the first Final 1280 of a new Developer, Exposure +0.3, the bundled presets bluesky2 / pastel / colorful, back to
// pastel) on the same synthetic inputs, through the wasm Developer as the editor's worker drives it (single thread,
// Node's wasm SIMD). No private photos and no npm dependencies.
//
//   cargo run --release -p niho-develop --example stage_timing -- --dump <inputs>
//   cargo +1.98.1 build --release --config .cargo/config.toml --target wasm32-unknown-unknown -p niho-develop-wasm
//   wasm-bindgen --target web --out-dir <pkg> target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
//   node tools/stage-wasm-bench.mjs <pkg> <inputs> [--photo raster|rasterCopy|legacy|signed|all] [--trials 3]
//
// One JSON line per photo, each measured in its own Node process (a cold wasm instance): the least of `trials` runs per
// step (a new Developer each run; other load on the machine only adds time), the first 16 hex digits of each frame's
// RGBA SHA-256 (the same as the native example's) and the wasm linear memory after them (its high-water).
// Node on a Mac is a reference environment, not a browser / device performance claim.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const [pkgDir, inputsDir, ...rest] = process.argv.slice(2);
if (!pkgDir || !inputsDir) throw new Error("usage: stage-wasm-bench.mjs <pkg> <inputs> [--photo p] [--trials n]");
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const only = flag("--photo", "all");
const trials = Number(flag("--trials", "3"));
const one = flag("--one", null);
const UI = 1280;
const PHOTOS = ["raster", "rasterCopy", "legacy", "signed"];

if (one) {
  // Through a .mjs copy: the build directory has no "type": "module".
  const glue = join(mkdtempSync(join(tmpdir(), "niho-stage-bench-")), "niho_develop_wasm.mjs");
  copyFileSync(join(resolve(pkgDir), "niho_develop_wasm.js"), glue);
  const pkg = await import(pathToFileURL(glue).href);
  const exports = pkg.initSync({ module: readFileSync(join(resolve(pkgDir), "niho_develop_wasm_bg.wasm")) });
  const png = readFileSync(join(inputsDir, `${one}.png`));
  const { meta, steps } = JSON.parse(readFileSync(join(inputsDir, `${one}.json`), "utf8"));
  const best = {};
  const sha = {};
  for (let t = 0; t < trials; t++) {
    const developer = meta === null ? new pkg.Developer(png, 0) : pkg.Developer.openWorkingCopy(png, meta);
    for (const [label, settings] of steps) {
      const start = performance.now();
      const frame = developer.render(settings, UI, false);
      const ms = Math.round((performance.now() - start) * 10) / 10;
      const digest = createHash("sha256").update(frame.rgba).digest("hex").slice(0, 16);
      if (sha[label] !== undefined && sha[label] !== digest) throw new Error(`${one} ${label}: other bytes on run ${t}`);
      sha[label] = digest;
      best[label] = Math.min(best[label] ?? Infinity, ms);
    }
    developer.free();
  }
  console.log(
    JSON.stringify({
      photo: one,
      trials,
      ms: best,
      sha256: sha,
      memoryMiB: Math.round(exports.memory.buffer.byteLength / 1048576),
      engine: pkg.version(),
    }),
  );
} else {
  for (const photo of PHOTOS) {
    if (only !== "all" && only !== photo) continue;
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), pkgDir, inputsDir, "--one", photo, "--trials", String(trials)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    if (child.status !== 0) throw new Error(`${photo} failed`);
    process.stdout.write(child.stdout);
  }
}
