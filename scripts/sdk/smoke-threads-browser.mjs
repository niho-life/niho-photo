#!/usr/bin/env node
// スレッドの wasm（#151）を Chrome headless で確かめる（Mac Studio などの手元。CI では回さない）。
//
//   node scripts/sdk/smoke-threads-browser.mjs --runtime <build-develop-engine-runtime.mjs の output>
//     [--threads 4,8] [--trials 5] [--chrome <Chrome の実行ファイル>] [--timing-photo <png> --timing-meta <json>] [--output <json>]
//
// 1. 一致: COOP / COEP のページ（crossOriginIsolated）の Worker で、1 本の wasm と、スレッドの wasm を
//    initThreadPool(n) した版が、全 engine の代表の設定（tests/render_identity.rs と同じ合成の写真・設定。離した画と
//    drag の画）で同じ RGBA の SHA-256 を返す
// 2. 速さ: 最初の Final（1280）・露光・同梱プリセット 3 本を、1 本と n スレッドで trials 回（毎回新しい Chrome）測り、
//    中央値と wasm のメモリの高水位を出す。写真は --timing-photo（署名つき RAW の作業コピーと meta）、無ければ合成
// 3. 分離なし: COOP / COEP の無いページでは crossOriginIsolated が false で、スレッドの版は pool を起こせない
//    （Worker は分離を見てから 1 本へ読み分ける前提）。1 本は同じ画を描く
//
// 配るのは runtime の manifest に書かれたファイルだけ（release の置き場と同じ平らな名前）。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".png": "image/png", ".ts": "text/plain" };

// ---- 合成の写真（tests/render_identity.rs と同じ形。PNG の圧縮の違いは画素に出ない） ----

function encodePng(width, height, { colorType, bitDepth }, sample) {
  const channels = colorType === 6 ? 4 : 3;
  const bytesPerSample = bitDepth / 8;
  const stride = width * channels * bytesPerSample + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const values = sample(x, y);
      for (let c = 0; c < channels; c += 1) {
        const offset = y * stride + 1 + (x * channels + c) * bytesPerSample;
        if (bytesPerSample === 2) raw.writeUInt16BE(values[c], offset);
        else raw[offset] = values[c];
      }
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 空と暗い地面・彩度の高い物・ノイズ（8 bit sRGB）。 */
function rasterPhoto() {
  const pixels = [];
  let state = 0x5bd1e995;
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < 160; x += 1) {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      const noise = (state % 9) - 4;
      const sky = y < 45;
      const object = (x - 100) ** 2 + (y - 80) ** 2 < 300;
      const [r, g, b] = sky ? [150 + Math.floor(x / 4), 190 + y, 245] : object ? [180, 50, 40] : [30 + Math.floor(x / 6), 40 + Math.floor(y / 8), 20];
      pixels.push([r, g, b].map((value) => Math.min(255, Math.max(0, value + noise))).concat(255));
    }
  }
  return encodePng(160, 120, { colorType: 6, bitDepth: 8 }, (x, y) => pixels[y * 160 + x]);
}

/** linear ProPhoto（白飛び・彩度の高い面・影）。160×120 を width×height へ引き伸ばし、大きい写真には細かい揺らぎを足す。 */
function linearPixel(width, height, x, y) {
  const u = (x * 160) / width;
  const v = (y * 120) / height;
  if (u >= 60 && u < 120 && v >= 10 && v < 50) return u < 90 ? [1.25, 1.25, 1.25] : [2.5, 2.4, 2.2];
  if ((u - 40) ** 2 + (v - 85) ** 2 < 250) return [0.42, 0.05, 0.03];
  const ripple = width > 160 ? 0.01 * Math.sin(x * 0.37) * Math.cos(y * 0.23) : 0;
  return [-0.02 + u / 600 + ripple, 0.03 + v / 700, 0.02 + (u + v) / 1500].map(Math.fround);
}

function unsignedWorkingCopy() {
  return encodePng(160, 120, { colorType: 2, bitDepth: 16 }, (x, y) =>
    linearPixel(160, 120, x, y).map((value) => Math.round(Math.pow(Math.min(1, Math.max(0, Math.min(1, Math.max(0, value)) / 2)), 1 / 1.8) * 65535)),
  );
}

function roundTiesEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction > 0.5 ? floor + 1 : fraction < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
}

/** 署名つき RAW の作業コピー（signed-gamma18-v1）と meta。 */
function signedWorkingCopy(width, height) {
  let maxAbs = 1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (const value of linearPixel(width, height, x, y)) maxAbs = Math.max(maxAbs, Math.abs(value));
  const ceiling = 2 ** Math.ceil(Math.log2(maxAbs));
  const png = encodePng(width, height, { colorType: 2, bitDepth: 16 }, (x, y) =>
    linearPixel(width, height, x, y).map((value) => roundTiesEven(32768 + (value < 0 ? -1 : 1) * Math.pow(Math.abs(value) / ceiling, 1 / 1.8) * 32767)),
  );
  const meta = `{"kind":"raw","baselineEV":-0.25,"asShotWhite":{"x":0.3127,"y":0.329,"temperature":5500,"tint":0},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{"kind":"signed-gamma18-v1","ceiling":${ceiling}}}`;
  return { png, meta };
}

// ---- ページと Worker（Worker の中で描く。アプリの現像の Worker と同じ置き方） ----

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>threads smoke</title>
<script type="module">
  const worker = new Worker("./worker.js" + location.search, { type: "module" });
  const send = (result) => fetch("./result", { method: "POST", body: JSON.stringify(result) });
  worker.onmessage = (event) => send(event.data);
  worker.onerror = (event) => send({ error: String(event.message) });
</script>
`;

const WORKER_JS = String.raw`
const params = new URL(self.location.href).searchParams;
const task = params.get("task");
const mode = params.get("mode");
const threads = Number(params.get("threads") ?? "0");
const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const hash = async (rgba) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rgba.slice())), (b) => b.toString(16).padStart(2, "0")).join("");
const errorText = (error) => String(error?.message ?? error).slice(0, 300);

async function load(manifest, which) {
  const files = which === "threads" ? manifest.threads.files : manifest.files;
  const names = Object.keys(files);
  const js = names.find((name) => name.endsWith(".js") && !name.includes("_worker-"));
  const wasm = names.find((name) => name.endsWith(".wasm"));
  const glue = await import("./engine/" + js);
  const start = performance.now();
  const exports = await glue.default({ module_or_path: "./engine/" + wasm });
  return { glue, exports, initMs: performance.now() - start };
}

function look(engine) {
  if (engine === "niho-1" || engine === "niho-2") return "niho-interim-1";
  return { "niho-3": "niho-standard-2", "niho-4": "niho-standard-3", "niho-5": "niho-standard-4", "niho-7": "niho-standard-5", "niho-11": "niho-standard-5" }[engine] ?? "niho-standard-1";
}

const MASKED = { v: 5, base: null, shadows: 25, vibrance: 10,
  geometry: { rotate: 90, angle: 3.5, crop: { left: 0.05, top: 0.08, right: 0.93, bottom: 0.95 } },
  masks: [
    { id: "sky", kind: "linear", zero: { x: 0.5, y: 0.45 }, full: { x: 0.52, y: 0.1 }, adjust: { exposure: -0.9, highlights: -40, saturation: 15 } },
    { id: "object", kind: "radial", invert: true, center: { x: 0.62, y: 0.66 }, radius: { x: 0.2, y: 0.25 }, angle: -25, feather: 45, adjust: { clarity: 30, relativeTemperature: -20, hsl: ["red", { saturation: -30 }] } },
  ] };

function cases(glue, engine) {
  const base = { ...JSON.parse(glue.neutralSettings()), engine, look: look(engine) };
  const busy = { ...base, exposure: 0.2, contrast: 18, highlights: -60, shadows: 40, whites: 10, blacks: -8, texture: 12, clarity: 15, dehaze: 10, vibrance: 12, saturation: 5 };
  const list = [["exposure", { ...base, exposure: 0.3 }], ["busy", busy], ["colorNoise", { ...busy, colorNoiseReduction: 25, colorNoiseReductionDetail: 50, colorNoiseReductionSmoothness: 50 }]];
  for (const preset of JSON.parse(glue.builtinPresets())) {
    try {
      list.push([preset.id, { ...JSON.parse(glue.presetSettings(preset.xmp, JSON.stringify(busy))).settings, engine, look: look(engine) }]);
    } catch {}
  }
  list.push(["masked", { ...MASKED, engine, look: look(engine) }]);
  return list;
}

const PHOTOS = [
  ["raster", ["niho-1", "niho-2", "niho-6", "niho-8", "niho-10", "niho-12", "niho-13", "niho-14"]],
  ["rasterCopy", ["niho-6", "niho-10", "niho-14"]],
  ["legacy", ["niho-1", "niho-14"]],
  ["signed", ["niho-3", "niho-4", "niho-5", "niho-7", "niho-11"]],
];

async function identity(glue) {
  const data = {
    raster: await fetchBytes("./data/raster.png"),
    unsigned: await fetchBytes("./data/unsigned.png"),
    signed: await fetchBytes("./data/signed.png"),
    signedMeta: await (await fetch("./data/signed.json")).text(),
  };
  const open = (photo) => {
    if (photo === "raster") return new glue.Developer(data.raster, 0);
    if (photo === "rasterCopy") return glue.Developer.openWorkingCopy(data.unsigned, '{"kind":"raster","iccSha256":"sRGB"}');
    if (photo === "legacy") return glue.Developer.openWorkingCopy(data.unsigned, '{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}');
    return glue.Developer.openWorkingCopy(data.signed, data.signedMeta);
  };
  const lines = [];
  let frames = 0;
  for (const [photo, engines] of PHOTOS) {
    for (const engine of engines) {
      let developer;
      try {
        developer = open(photo);
      } catch (error) {
        lines.push(photo + " " + engine + " open refused");
        continue;
      }
      for (const [name, settings] of cases(glue, engine)) {
        const renders = name === "busy" || name === "masked" ? [[0, false], [96, true]] : [[0, false]];
        for (const [size, interactive] of renders) {
          try {
            const frame = developer.render(JSON.stringify(settings), size, interactive);
            lines.push(photo + " " + engine + " " + name + " " + size + " " + frame.width + "x" + frame.height + " " + (await hash(frame.rgba)));
            frames += 1;
          } catch (error) {
            lines.push(photo + " " + engine + " " + name + " " + size + " refused");
          }
        }
      }
      developer.free();
    }
  }
  return { lines, frames };
}

async function timing(glue, exports) {
  const steps = [];
  const record = async (step, start, frame) => steps.push({ step, ms: performance.now() - start, memory: exports.memory.buffer.byteLength, ...(frame && { rgbaSha256: await hash(frame.rgba) }) });
  const [png, meta] = [await fetchBytes("./data/timing.png"), await (await fetch("./data/timing.json")).text()];
  let start = performance.now();
  const developer = glue.Developer.openWorkingCopy(png, meta);
  await record("open", start);
  const base = { ...JSON.parse(glue.neutralSettings()), engine: "niho-11", look: "niho-standard-5" };
  const asShot = developer.asShotWhite();
  const presets = JSON.parse(glue.builtinPresets());
  const render = async (step, settings) => {
    const begin = performance.now();
    const frame = developer.render(JSON.stringify(settings), 1280, false);
    await record(step, begin, frame);
  };
  await render("first", base);
  const exposed = { ...base, exposure: 0.3 };
  await render("exposure", exposed);
  for (const id of ["niho-bluesky2", "niho-pastel", "niho-colorful"]) {
    await render("preset:" + id, JSON.parse(glue.applyPreset(presets.find((preset) => preset.id === id).xmp, JSON.stringify(exposed), 1, asShot)).settings);
  }
  return steps;
}

try {
  const manifest = await (await fetch("./engine/manifest.json")).json();
  const result = { task, mode, threads, crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, cores: navigator.hardwareConcurrency, ua: navigator.userAgent };
  if (task === "probe") {
    // 分離の無いページ: スレッドの版は読めても pool を起こせない（Worker は分離を見て 1 本を読む）
    try {
      const threaded = await load(manifest, "threads");
      result.threadsInit = "ok";
      try {
        await Promise.race([threaded.glue.initThreadPool(2), new Promise((_, reject) => setTimeout(() => reject(new Error("initThreadPool が 20 秒で終わらない")), 20000))]);
        result.threadPool = "ok";
      } catch (error) {
        result.threadPool = errorText(error);
      }
    } catch (error) {
      result.threadsInit = errorText(error);
    }
    const single = await load(manifest, "single");
    const developer = new single.glue.Developer(await fetchBytes("./data/raster.png"), 0);
    const settings = { ...JSON.parse(single.glue.neutralSettings()), engine: "niho-14", exposure: 0.3 };
    result.singleRgbaSha256 = await hash(developer.render(JSON.stringify(settings), 0, false).rgba);
  } else {
    const loaded = await load(manifest, mode);
    result.initMs = loaded.initMs;
    if (mode === "threads") {
      const start = performance.now();
      await loaded.glue.initThreadPool(threads);
      result.poolMs = performance.now() - start;
    }
    if (task === "identity") Object.assign(result, await identity(loaded.glue));
    else result.steps = await timing(loaded.glue, loaded.exports);
    result.memory = loaded.exports.memory.buffer.byteLength;
  }
  self.postMessage(result);
} catch (error) {
  self.postMessage({ task, mode, threads, error: String(error?.stack ?? error).slice(0, 2000) });
}
`;

// ---- サーバーと Chrome ----

function readRuntime(runtimeDirectory) {
  const manifests = readdirSync(runtimeDirectory).filter((name) => /^manifest-\d+\.\d+\.\d+\.json$/u.test(name));
  if (manifests.length !== 1) throw new Error("runtime の置き場に manifest がちょうど 1 つ必要です");
  const manifestBytes = readFileSync(path.join(runtimeDirectory, manifests[0]));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!manifest.threads?.files) throw new Error("runtime の manifest にスレッドの版がありません");
  const files = new Map([["manifest.json", manifestBytes]]);
  for (const [name, expected] of [...Object.entries(manifest.files), ...Object.entries(manifest.threads.files)]) {
    const bytes = readFileSync(path.join(runtimeDirectory, name));
    if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error(`runtime のファイルが manifest と合いません: ${name}`);
    files.set(name, bytes);
  }
  return { manifest, files };
}

async function serve({ isolated, engineFiles, dataFiles, url, chrome, timeoutMs }) {
  let finish;
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  const server = createServer(async (request, response) => {
    const headers = { "Cache-Control": "no-store", ...(isolated ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {}) };
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && pathname === "/result") {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.writeHead(204, headers).end();
      finish(JSON.parse(body));
      return;
    }
    const body = pathname === "/" ? Buffer.from(INDEX_HTML) : pathname === "/worker.js" ? Buffer.from(WORKER_JS) : pathname.startsWith("/engine/") ? engineFiles.get(pathname.slice(8)) : pathname.startsWith("/data/") ? dataFiles.get(pathname.slice(6)) : undefined;
    if (!body) {
      response.writeHead(404, headers).end();
      return;
    }
    const type = pathname === "/" ? "text/html" : (TYPES[path.extname(pathname)] ?? "application/octet-stream");
    response.writeHead(200, { ...headers, "Content-Type": type }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = mkdtempSync(path.join(tmpdir(), "niho-threads-smoke-chrome-"));
  const browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/${url}`], { stdio: "ignore" });
  const timer = setTimeout(() => finish({ error: `timeout ${timeoutMs}ms` }), timeoutMs);
  try {
    return await result;
  } finally {
    clearTimeout(timer);
    browser.kill();
    await new Promise((resolve) => (browser.exitCode !== null ? resolve() : browser.once("exit", resolve)));
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${name} に値が必要です`);
  return argv[index + 1];
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

export async function smokeThreadsBrowser({ runtimeDirectory, threadCounts = [4, 8], trials = 5, chrome = DEFAULT_CHROME, timingPhoto, timingMeta, log = console.log }) {
  const { manifest, files: engineFiles } = readRuntime(runtimeDirectory);
  const signed = signedWorkingCopy(160, 120);
  const timing = timingPhoto ? { png: readFileSync(timingPhoto), meta: readFileSync(timingMeta, "utf8") } : signedWorkingCopy(2560, 1706);
  const dataFiles = new Map([
    ["raster.png", rasterPhoto()],
    ["unsigned.png", unsignedWorkingCopy()],
    ["signed.png", signed.png],
    ["signed.json", Buffer.from(signed.meta)],
    ["timing.png", timing.png],
    ["timing.json", Buffer.from(timing.meta)],
  ]);
  const run = (isolated, query, timeoutMs = 600_000) => serve({ isolated, engineFiles, dataFiles, url: `?${new URLSearchParams(query)}`, chrome, timeoutMs });
  const modes = [["single", 0], ...threadCounts.map((count) => ["threads", count])];
  const failures = [];
  const report = { engine: manifest.engine, version: manifest.version, sizes: {}, identity: {}, timing: {}, probe: null };
  for (const [kind, files] of [["single", manifest.files], ["threads", manifest.threads.files]]) report.sizes[kind] = Object.fromEntries(Object.entries(files).map(([name, { bytes }]) => [name, bytes]));

  // 1. 一致
  let reference;
  for (const [mode, threads] of modes) {
    const result = await run(true, { task: "identity", mode, threads });
    const label = mode === "single" ? "1 本" : `${threads} スレッド`;
    if (result.error) {
      failures.push(`${label}: ${result.error}`);
      continue;
    }
    if (!result.crossOriginIsolated) failures.push(`${label}: crossOriginIsolated が false`);
    const digest = createHash("sha256").update(result.lines.join("\n")).digest("hex");
    report.identity[label] = { frames: result.frames, lines: result.lines.length, digest, initMs: result.initMs, poolMs: result.poolMs, memory: result.memory };
    if (!reference) reference = result.lines;
    else {
      const differ = result.lines.filter((line, index) => line !== reference[index]);
      if (differ.length || result.lines.length !== reference.length) failures.push(`${label}: 1 本と違う画 ${differ.length} 件（例: ${differ[0] ?? "行の数"}）`);
    }
    log(`一致 ${label}: ${result.frames} 枚・${result.lines.length} 行 digest ${digest.slice(0, 16)}（init ${result.initMs?.toFixed(0)}ms${result.poolMs !== undefined ? `・pool ${result.poolMs.toFixed(0)}ms` : ""}）`);
  }

  // 2. 速さ
  for (const [mode, threads] of modes) {
    const label = mode === "single" ? "1 本" : `${threads} スレッド`;
    const runs = [];
    for (let trial = 0; trial < trials; trial += 1) {
      const result = await run(true, { task: "timing", mode, threads }, 300_000);
      if (result.error) failures.push(`速さ ${label}: ${result.error}`);
      else runs.push(result);
    }
    if (!runs.length) continue;
    report.timing[label] = Object.fromEntries(runs[0].steps.map(({ step }) => {
      const samples = runs.map((result) => result.steps.find((item) => item.step === step));
      return [step, { medianMs: Math.round(median(samples.map((item) => item.ms))), maxMemory: Math.max(...samples.map((item) => item.memory)), rgbaSha256: [...new Set(samples.map((item) => item.rgbaSha256).filter(Boolean))] }];
    }));
    log(`速さ ${label}（${runs.length} 回の中央値・cores ${runs[0].cores}）: ${Object.entries(report.timing[label]).map(([step, value]) => `${step} ${value.medianMs}ms`).join(" / ")}・メモリ ${(Math.max(...Object.values(report.timing[label]).map((value) => value.maxMemory)) / 1e6).toFixed(0)}MB`);
  }
  const singleTiming = report.timing["1 本"];
  for (const [label, steps] of Object.entries(report.timing)) {
    for (const [step, value] of Object.entries(steps)) {
      if (value.rgbaSha256.length > 1 || (singleTiming && JSON.stringify(value.rgbaSha256) !== JSON.stringify(singleTiming[step]?.rgbaSha256))) failures.push(`速さ ${label} ${step}: 1 本と違う画`);
    }
  }

  // 3. 分離なし
  const probe = await run(false, { task: "probe" });
  report.probe = probe;
  const referenceLine = reference?.find((line) => line.startsWith("raster niho-14 exposure 0 "));
  if (probe.error) failures.push(`分離なし: ${probe.error}`);
  else {
    if (probe.crossOriginIsolated !== false) failures.push("分離なし: crossOriginIsolated が false ではありません");
    if (probe.threadPool === "ok") failures.push("分離なし: スレッドの pool が起きました（分離を見ずに読める前提になってしまう）");
    if (referenceLine && !referenceLine.endsWith(probe.singleRgbaSha256)) failures.push("分離なし: 1 本の画が分離ありの 1 本と違う");
    log(`分離なし: crossOriginIsolated=${probe.crossOriginIsolated} SharedArrayBuffer=${probe.sharedArrayBuffer} スレッドの init=${probe.threadsInit} pool=${probe.threadPool ?? "-"} 1 本の画=${referenceLine?.endsWith(probe.singleRgbaSha256) ? "同じ" : "?"}`);
  }
  report.failures = failures;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const runtimeDirectory = option(argv, "--runtime");
    if (!runtimeDirectory) throw new Error("使い方: smoke-threads-browser.mjs --runtime <engine runtime の置き場> [--threads 4,8] [--trials 5] [--chrome <path>] [--timing-photo <png> --timing-meta <json>] [--output <json>]");
    const timingPhoto = option(argv, "--timing-photo");
    const timingMeta = option(argv, "--timing-meta");
    if (Boolean(timingPhoto) !== Boolean(timingMeta)) throw new Error("--timing-photo と --timing-meta は組で渡してください");
    const report = await smokeThreadsBrowser({
      runtimeDirectory: path.resolve(runtimeDirectory),
      threadCounts: option(argv, "--threads", "4,8").split(",").map(Number),
      trials: Number(option(argv, "--trials", "5")),
      chrome: option(argv, "--chrome", DEFAULT_CHROME),
      timingPhoto: timingPhoto && path.resolve(timingPhoto),
      timingMeta: timingMeta && path.resolve(timingMeta),
    });
    const output = option(argv, "--output");
    if (output) writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length) {
      console.error(["スレッドの wasm の確認に失敗しました:", ...report.failures.map((line) => `  - ${line}`)].join("\n"));
      process.exitCode = 1;
    } else console.log("スレッドの wasm: 1 本と同じ画・分離なしでは 1 本を読む前提を確かめました");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "スレッドの wasm の確認に失敗しました");
    process.exitCode = 1;
  }
}
