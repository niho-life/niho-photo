// How long 「空」 takes in wasm (niho-photo#141, docs/local-adjustments.md「空の検出」): the steps of
// crates/niho-develop/examples/sky_timing.rs through the wasm Developer as the editor's worker drives it (single
// thread, Node's wasm SIMD). The model is a private run of #158 (<run>/layout.json, <run>/weights.f32); nothing of it
// is in the repo. No npm dependencies.
//
//   cargo +1.98.1 build --release --config .cargo/config.toml --target wasm32-unknown-unknown -p niho-develop-wasm
//   wasm-bindgen --target web --out-dir <pkg> target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
//   node tools/sky-wasm-bench.mjs <pkg> <run> [--photo <JPEG/PNG>] [--trials 5]
//
// One JSON line. `load` is setSkyModel (reading the model into wasm). For each trial a new Developer opens the photo
// (at most 2560 on the long side) and renders its editor frame (Final 1280), untimed; `press` is the first
// Developer.detectSky (the working image at 1024, the model, the PNG) and `again` a second one. Without --photo the
// photo is sky_timing.rs's synthetic 3:2 one, drawn the same way (the time depends on the photo's shape, not on what it
// shows). Node on a Mac is a reference environment for the browser's wasm, not a device claim.
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [pkgDir, runDir, ...rest] = process.argv.slice(2);
if (!pkgDir || !runDir) throw new Error("usage: sky-wasm-bench.mjs <pkg> <run> [--photo p] [--trials n]");
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const trials = Number(flag("--trials", "5"));
const photoPath = flag("--photo", null);

// Through a .mjs copy: the build directory has no "type": "module".
const glue = join(mkdtempSync(join(tmpdir(), "niho-sky-bench-")), "niho_develop_wasm.mjs");
copyFileSync(join(resolve(pkgDir), "niho_develop_wasm.js"), glue);
const pkg = await import(pathToFileURL(glue).href);
pkg.initSync({ module: readFileSync(join(resolve(pkgDir), "niho_develop_wasm_bg.wasm")) });

const SETTINGS = JSON.stringify({ v: 1, engine: "niho-14", look: "niho-standard-1", base: null });
const EDITOR = JSON.stringify({
  v: 1,
  engine: "niho-14",
  look: "niho-standard-1",
  base: null,
  exposure: 0.3,
  contrast: 10,
  shadows: 20,
});

/** The synthetic 3:2 photo of sky_timing.rs (2560 x 1707: a blue sky over textured ground) as PNG. */
function syntheticPhoto() {
  const [w, h] = [2560, 1707];
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (y < Math.floor((h * 2) / 5)) data.set([110, 160, 235 - Math.floor(y / 8), 255], i);
      else {
        const n = (x * 7 + y * 13) % 50;
        data.set([90 + n, 80 + Math.floor(n / 2), 50, 255], i);
      }
    }
  }
  return encodeRgbaPng(data, w, h);
}

/** RGBA -> an 8-bit RGBA PNG, uncompressed (zlib stored blocks; CRC-32 and Adler-32 by hand). */
function encodeRgbaPng(rgba, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const blocks = [];
  for (let at = 0; at < raw.length; at += 65535) {
    const part = raw.subarray(at, Math.min(at + 65535, raw.length));
    const head = new Uint8Array(5);
    head[0] = at + part.length >= raw.length ? 1 : 0;
    head[1] = part.length & 0xff;
    head[2] = part.length >> 8;
    head[3] = ~part.length & 0xff;
    head[4] = (~part.length >> 8) & 0xff;
    blocks.push(head, part);
  }
  let a = 1;
  let b = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  const zlib = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adler]);
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
}

const ms = (t) => Math.round((performance.now() - t) * 10) / 10;
const median = (values) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];

const photo = photoPath ? new Uint8Array(readFileSync(photoPath)) : syntheticPhoto();
const layout = readFileSync(join(runDir, "layout.json"), "utf8");
const weights = new Uint8Array(readFileSync(join(runDir, "weights.f32")));
let t = performance.now();
const model = JSON.parse(pkg.setSkyModel(layout, weights));
const load = ms(t);

const press = [];
const again = [];
let surface = "";
for (let trial = 0; trial < trials; trial++) {
  const developer = new pkg.Developer(photo, 2560);
  developer.render(EDITOR, 1280, false);
  t = performance.now();
  const found = developer.detectSky(SETTINGS);
  press.push(ms(t));
  t = performance.now();
  developer.detectSky(SETTINGS);
  again.push(ms(t));
  if (found) surface = `${found.width}x${found.height}`;
  developer.free();
}
console.log(
  JSON.stringify({
    model,
    node: process.version,
    surface,
    loadMs: load,
    pressMs: median(press),
    againMs: median(again),
    press,
    again,
  }),
);
