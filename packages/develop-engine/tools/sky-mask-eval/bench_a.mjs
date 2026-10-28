// Times the wasm build of sky_a.rs (#128) in Node: a cold instance per photo, the least of `repeats` runs, and the
// wasm linear memory after them (it never shrinks: the high-water). Node's wasm on a Mac is a reference environment,
// not a browser / device claim. No npm dependencies.
//
//   node bench_a.mjs <sky_a.wasm> <dir with <id>.rgb + <id>.meta.json> <out dir> [repeats]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const [wasmPath, dir, outDir, repeatsArg] = process.argv.slice(2);
const repeats = Number(repeatsArg ?? "5");
const bytes = readFileSync(wasmPath);
const results = {};
for (const name of readdirSync(dir).filter((f) => f.endsWith(".rgb")).sort()) {
  const id = name.slice(0, -4);
  const meta = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), "utf8"));
  const rgb = readFileSync(join(dir, name));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { memory, alloc, sky_a: sky } = instance.exports;
  const n = meta.w * meta.h;
  const inPtr = alloc(rgb.length);
  new Uint8Array(memory.buffer, inPtr, rgb.length).set(rgb);
  const outPtr = alloc(n);
  let best = Infinity;
  let flags = 0;
  for (let k = 0; k < repeats; k += 1) {
    const t = performance.now();
    flags = sky(inPtr, meta.w, meta.h, meta.ev100 ?? NaN, outPtr);
    best = Math.min(best, performance.now() - t);
  }
  writeFileSync(join(outDir, `${id}.gray`), new Uint8Array(memory.buffer, outPtr, n));
  results[id] = { seconds: best / 1000, flags, memoryBytes: memory.buffer.byteLength };
}
console.log(JSON.stringify(results));
