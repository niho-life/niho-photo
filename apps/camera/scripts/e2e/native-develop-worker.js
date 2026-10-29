// #152 の E2E（native-develop.sh）: Mac アプリの Worker の中から、同じ合成の写真を native の sidecar（niho-develop:// への同期の XHR →
// `niho-develop-render serve`）と同梱の wasm で描き、画素が同じかと時間（5 回の中央値）を比べる。本文の形は
// packages/photo-editing/src/develop-engine/develop-engine-native-glue.ts と同じ（u32 LE の header の長さ・JSON・binary）。
const describe = (error) => String(error?.message ?? error);
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;
const CLIENT = "0123456789abcdef0123456789abcdef";

function encodeBody(header, blobs = []) {
  const headerBytes = new TextEncoder().encode(JSON.stringify({ ...header, blobs: blobs.map((blob) => blob.byteLength) }));
  const body = new Uint8Array(4 + headerBytes.byteLength + blobs.reduce((sum, blob) => sum + blob.byteLength, 0));
  new DataView(body.buffer).setUint32(0, headerBytes.byteLength, true);
  body.set(headerBytes, 4);
  let offset = 4 + headerBytes.byteLength;
  for (const blob of blobs) {
    body.set(blob, offset);
    offset += blob.byteLength;
  }
  return body;
}

function decodeBody(buffer) {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
  const blobs = [];
  let offset = 4 + headerLength;
  for (const length of header.blobs ?? []) {
    blobs.push(new Uint8Array(buffer, offset, length));
    offset += length;
  }
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === "blob") return blobs[value.blob];
      return Object.fromEntries(keys.map((key) => [key, resolve(value[key])]));
    }
    return value;
  };
  return { ...header, result: resolve(header.result) };
}

function nativeCall(method, args = [], extra = {}) {
  const blobs = [];
  const encoded = args.map((arg) => {
    if (arg instanceof Uint8Array) {
      blobs.push(arg);
      return { blob: blobs.length - 1 };
    }
    return arg === undefined ? null : arg;
  });
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `niho-develop://localhost/${method}`, false);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("X-Niho-Develop-Client", CLIENT);
  xhr.send(encodeBody({ args: encoded, ...extra }, blobs));
  if (xhr.status !== 200) throw new Error(`${method}: HTTP ${xhr.status}`);
  const reply = decodeBody(xhr.response);
  if (!reply.ok) throw new Error(`${method}: ${reply.code ?? ""} ${reply.error}`);
  return reply.result;
}

/** 合成の写真（なだらかな色・細かい模様・暗部）を PNG にする（実写真は使わない）。 */
async function syntheticPhoto(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  let state = 0x6d2b79f5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const noise = ((state >>> 0) % 9) - 4;
      const index = (y * width + x) * 4;
      const sky = y < height * 0.4;
      image.data[index] = Math.max(0, Math.min(255, (sky ? 120 : 40) + (x * 90) / width + noise));
      image.data[index + 1] = Math.max(0, Math.min(255, (sky ? 170 : 60) + (y * 40) / height + noise));
      image.data[index + 2] = Math.max(0, Math.min(255, (sky ? 235 : 30) + ((x + y) % 32) + noise));
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function timed(runs, action) {
  const times = [];
  let last;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    last = action();
    times.push(performance.now() - started);
  }
  return { result: last, medianMs: round(median(times)), maxMs: round(Math.max(...times)) };
}

self.onmessage = async (event) => {
  const { jsUrl, wasmUrl, engine, runs = 5 } = event.data;
  const out = { protocol: self.location.protocol };
  try {
    const helloStarted = performance.now();
    out.hello = nativeCall("hello");
    out.hello.ms = round(performance.now() - helloStarted);
    out.hello.methods = out.hello.methods?.length;

    const wasm = await import(jsUrl);
    await wasm.default({ module_or_path: wasmUrl });
    out.wasmVersion = wasm.version();
    out.nativeVersion = nativeCall("version");

    const photo = await syntheticPhoto(2560, 1707);
    // 新規の編集の既定の engine で描く（neutralSettings の engine は互換の niho-1）
    const neutral = JSON.stringify({ ...JSON.parse(wasm.neutralSettings()), engine });
    const presets = JSON.parse(wasm.builtinPresets()).slice(0, 3);
    const exposure = JSON.stringify({ ...JSON.parse(neutral), exposure: 0.5 });
    const cases = [
      ["neutral", neutral],
      ["exposure", exposure],
      ...presets.map((preset) => [`preset:${preset.id}`, JSON.parse(wasm.applyPreset(preset.xmp, neutral, 1, null)).settings]),
    ].map(([label, settings]) => [label, typeof settings === "string" ? settings : JSON.stringify(settings)]);

    const opened = timed(1, () => nativeCall("Developer.new", [photo, 2560], { client: CLIENT }));
    const wasmOpened = timed(1, () => new wasm.Developer(photo, 2560));
    out.open = { nativeMs: opened.medianMs, wasmMs: wasmOpened.medianMs };
    const handle = opened.result.handle;
    const developer = wasmOpened.result;
    out.cases = [];
    for (const [label, settings] of cases) {
      for (const interactive of [false, true]) {
        const native = timed(runs, () => nativeCall("Developer.render", [settings, 1280, interactive], { handle }));
        const browser = timed(runs, () => developer.render(settings, 1280, interactive));
        out.cases.push({
          label,
          quality: interactive ? "interactive" : "final",
          width: native.result.width,
          height: native.result.height,
          samePixels: sameBytes(native.result.rgba, browser.result.rgba),
          nativeMs: native.medianMs,
          wasmMs: browser.medianMs,
        });
      }
    }
    const nativeJpeg = timed(1, () => nativeCall("exportJpeg", [photo, exposure, 2048, 90, null]));
    const wasmJpeg = timed(1, () => wasm.exportJpeg(photo, exposure, 2048, 90, undefined));
    out.exportJpeg = { sameBytes: sameBytes(nativeJpeg.result, wasmJpeg.result), nativeMs: nativeJpeg.medianMs, wasmMs: wasmJpeg.medianMs };
    nativeCall("Developer.free", [], { handle });
    developer.free();
    out.released = nativeCall("releaseClient", [], { client: CLIENT });
  } catch (error) {
    out.error = describe(error);
  }
  self.postMessage(out);
};
