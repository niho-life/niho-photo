import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createPinnedMediaProvider } from "../src/server/index.ts";
import { loadVerifiedContract, loadVerifiedDevelopRuntime } from "../src/server/runtime.ts";
import { inspectPng } from "../src/server/png.ts";
import { CloudMediaError } from "../src/types.ts";
import { syntheticPng } from "./synthetic-png.mjs";
import { syntheticOrientedJpeg } from "./synthetic-jpeg.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const clone = (value) => structuredClone(value);

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type); const length = Buffer.alloc(4); const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
function syntheticPng16() {
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 16; header[9] = 2;
  const row = Buffer.alloc(13); [10000, 18000, 26000, 22000, 14000, 7000].forEach((value, index) => row.writeUInt16BE(value, 1 + index * 2));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(row)), chunk("IEND", Buffer.alloc(0))]);
}

function recipeFor(settings, masks = []) {
  const text = canonical(settings);
  return { revision: 3, settings, settingsSha256: digest(text), baseVersion: settings.base ?? null,
    maskSurfaceIds: masks, updatedAt: "2026-11-01T00:00:00Z" };
}

function makeRequest({ bytes, format, settings, masks = [], workingCopy = null, readAsset, dimensions } = {}) {
  const width = dimensions?.width ?? (format === "jpeg" ? 1 : workingCopy?.asset.width ?? 8);
  const height = dimensions?.height ?? (format === "jpeg" ? 2 : workingCopy?.asset.height ?? 8);
  const original = { id: "opaque-original", kind: "original", sha256: digest(bytes), sizeBytes: bytes.length,
    contentType: format === "jpeg" ? "image/jpeg" : "image/png", width, height };
  const recipe = recipeFor(settings, masks.map((entry) => entry.surfaceId));
  const mediaWorkingCopy = workingCopy && { asset: workingCopy.asset, baseVersion: workingCopy.baseVersion,
    encoding: workingCopy.encoding, meta: workingCopy.meta };
  const photo = {
    id: "opaque-photo", libraryId: "opaque-library", storageState: "stored", lifecycle: "active",
    fileName: "synthetic", format, hasEdits: true, addedAt: "2026-11-01T00:00:00Z", capturedAt: null,
    width, height, original, recipe,
    media: workingCopy ? { state: "ready", thumbnail: { ...original, id: "t", kind: "thumbnail" },
      preview: { ...original, id: "p", kind: "preview" }, workingCopy: mediaWorkingCopy, recipeRevision: 2,
      rendererManifestSha256: "c".repeat(64) } : { state: "pending" },
  };
  const input = workingCopy ? {
    kind: "workingCopy", photoId: photo.id, libraryId: photo.libraryId, originalSha256: original.sha256,
    originalAssetId: original.id, asset: workingCopy.asset, exportMaxEdge: Math.max(workingCopy.asset.width, workingCopy.asset.height),
    encoding: workingCopy.encoding, baseVersion: workingCopy.baseVersion, meta: workingCopy.meta,
  } : {
    kind: "original", format, photoId: photo.id, libraryId: photo.libraryId, originalSha256: original.sha256,
    originalAssetId: original.id, asset: original, exportMaxEdge: Math.max(width, height),
  };
  const data = new Map([[input.asset.id, workingCopy?.bytes ?? bytes], ...masks.map((entry) => [entry.asset.id, entry.bytes])]);
  return {
    source: { ownerId: "opaque-owner", originalGeneration: "generation-1", lifecycleGeneration: 1, photo },
    input,
    masks: masks.map(({ surfaceId, asset }) => ({ surfaceId, asset })),
    readAsset: readAsset ?? (async (asset) => (async function* () {
      const value = data.get(asset.id); yield value.subarray(0, Math.max(1, Math.floor(value.length / 2))); yield value.subarray(Math.max(1, Math.floor(value.length / 2)));
    })()),
    signal: new AbortController().signal,
  };
}

function validator(recipe) {
  return { canonicalSettings: canonical(recipe.settings), settingsSha256: recipe.settingsSha256,
    baseVersion: recipe.baseVersion, maskSurfaceIds: [...recipe.maskSurfaceIds] };
}

test("real pinned SDK renders crop and exact mask surface without changing the full recipe", async () => {
  const scratchRoot = await mkdtemp(join(tmpdir(), "niho-cloud-provider-test-"));
  try {
    const { runtime } = await loadVerifiedDevelopRuntime();
    const base = { ...JSON.parse(runtime.neutralSettings()), v: 9 };
    const geometry = { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 0.5, bottom: 1 } };
    const input = syntheticPng(8, 8);
    const maskBytes = runtime.encodeMaskSurface(8, 8, new Uint8Array(64).fill(255));
    const surfaceId = runtime.maskSurfaceId(maskBytes);
    assert.equal(surfaceId, digest(maskBytes));
    const mask = { surfaceId, bytes: maskBytes, asset: { id: "opaque-mask-asset", kind: "mask", sha256: surfaceId,
      sizeBytes: maskBytes.length, contentType: "image/png", width: 8, height: 8 } };
    const unmaskedSettings = { ...base, geometry };
    const maskedSettings = { ...base, geometry, masks: [{ id: "synthetic-sky", kind: "sky",
      surface: { id: surfaceId, width: 8, height: 8 }, adjust: { exposure: 1 } }] };
    const before = clone(maskedSettings);
    const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 10_000, maxInputBytes: 1024 ** 2,
      maxMaskTotalBytes: 1024 ** 2, validateRecipe: validator });
    const plain = await provider.render(makeRequest({ bytes: input, format: "png", settings: unmaskedSettings }));
    const masked = await provider.render(makeRequest({ bytes: input, format: "png", settings: maskedSettings, masks: [mask] }));
    assert.deepEqual(maskedSettings, before);
    assert.equal(masked.renderer.sdkVersion, "0.1.9");
    assert.equal(masked.renderer.crateVersion, "0.27.0");
    assert.equal(masked.renderer.maskSurfaces, true);
    assert.equal(masked.renderer.features.includes("geometry"), true);
    assert.equal(masked.renderer.features.includes("masks"), true);
    assert.equal(masked.renderer.features.some((feature) => /sky|detect/i.test(feature)), false);
    assert.deepEqual(masked.assets.map((asset) => [asset.width, asset.height]), [[4, 8], [4, 8]]);
    assert.notEqual(plain.assets.find((asset) => asset.kind === "preview").sha256,
      masked.assets.find((asset) => asset.kind === "preview").sha256);

    const substitutedId = "e".repeat(64);
    const wrongRelationship = { ...mask, surfaceId: substitutedId };
    const wrongSettings = { ...base, geometry, masks: [{ id: "synthetic-sky", kind: "sky",
      surface: { id: substitutedId, width: 8, height: 8 }, adjust: { exposure: 1 } }] };
    await assert.rejects(provider.render(makeRequest({ bytes: input, format: "png", settings: wrongSettings,
      masks: [wrongRelationship] })), (error) => error.code === "invalid_input");

    const substitutedBytes = Uint8Array.from(maskBytes, (value, index) => index === maskBytes.length - 1 ? value ^ 1 : value);
    const substitutedRequest = makeRequest({ bytes: input, format: "png", settings: maskedSettings, masks: [mask],
      readAsset: async (requested) => (async function* () {
        yield requested.kind === "mask" ? substitutedBytes : input;
      })() });
    await assert.rejects(provider.render(substitutedRequest), (error) => error.code === "content_mismatch");
    assert.deepEqual(await readdir(scratchRoot), []);
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
});

test("real SDK handles EXIF orientation once and jpeg8 uses the raster path", async () => {
  const scratchRoot = await mkdtemp(join(tmpdir(), "niho-cloud-provider-jpeg-"));
  try {
    const { runtime } = await loadVerifiedDevelopRuntime();
    const contract = await loadVerifiedContract();
    const directSettings = { ...JSON.parse(runtime.neutralSettings()), v: 9 };
    const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 10_000, maxInputBytes: 1024 ** 2,
      maxMaskTotalBytes: 0, validateRecipe: validator });
    const direct = await provider.render(makeRequest({ bytes: syntheticOrientedJpeg, format: "jpeg", settings: directSettings }));
    assert.deepEqual(direct.assets.map((asset) => [asset.width, asset.height]), [[1, 2], [1, 2]]);

    const rasterBytes = runtime.exportJpeg(syntheticPng(2, 1), canonical(directSettings), 2560, 0.9, 40_000_000);
    const directRaster = await provider.render(makeRequest({ bytes: rasterBytes, format: "jpeg", settings: directSettings,
      dimensions: { width: 2, height: 1 } }));
    const baseVersion = "raster.synthetic.v1";
    const meta = { kind: "raster", iccSha256: "sRGB" };
    const workingSettings = contract.developSettingsOnWorkingCopy(directSettings, baseVersion, meta);
    const workAsset = { id: "work-jpeg", kind: "working-copy", sha256: digest(rasterBytes), sizeBytes: rasterBytes.length,
      contentType: "image/jpeg", width: 2, height: 1 };
    const work = { asset: workAsset, baseVersion, encoding: "jpeg8", meta, bytes: rasterBytes };
    const rendered = await provider.render(makeRequest({ bytes: rasterBytes, format: "jpeg", settings: workingSettings, workingCopy: work }));
    assert.deepEqual(rendered.assets.map((asset) => [asset.width, asset.height]), [[2, 1], [2, 1]]);
    assert.deepEqual(rendered.assets.map((asset) => asset.sha256), directRaster.assets.map((asset) => asset.sha256));
    let readOversizedMeta = false;
    const oversized = { ...work, meta: { ...meta, opaque: "x".repeat(64 * 1024) } };
    await assert.rejects(provider.render(makeRequest({ bytes: rasterBytes, format: "jpeg", settings: workingSettings,
      workingCopy: oversized, readAsset: async () => {
        readOversizedMeta = true;
        return (async function* () { yield rasterBytes; })();
      } })), (error) => error.code === "invalid_input");
    assert.equal(readOversizedMeta, false);
    assert.deepEqual(await readdir(scratchRoot), []);
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
});

test("original PNG EXIF orientation is applied once and metadata is removed from outputs", async () => {
  const scratchRoot = await mkdtemp(join(tmpdir(), "niho-cloud-provider-png-exif-"));
  try {
    const original = syntheticPng(2, 1);
    const tiff = Buffer.from("49492a0008000000010012010300010000000600000000000000", "hex");
    const bytes = Buffer.concat([original.subarray(0, 33), chunk("eXIf", tiff), original.subarray(33)]);
    const { runtime } = await loadVerifiedDevelopRuntime();
    assert.deepEqual(runtime.imageSize(bytes), { width: 1, height: 2 });
    const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 10_000, maxInputBytes: 1024 ** 2,
      maxMaskTotalBytes: 0, validateRecipe: validator });
    const result = await provider.render(makeRequest({ bytes, format: "png",
      settings: { ...JSON.parse(runtime.neutralSettings()), v: 9 }, dimensions: { width: 1, height: 2 } }));
    assert.deepEqual(result.assets.map((asset) => [asset.width, asset.height]), [[1, 2], [1, 2]]);
    for (const output of result.assets) {
      assert.deepEqual(inspectPng(output.bytes, { output: true }).chunks, ["IHDR", "sRGB", "IDAT", "IEND"]);
    }
    const manyChunks = Buffer.concat([original.subarray(0, -12),
      ...Array.from({ length: 300 }, () => chunk("IDAT", Buffer.alloc(0))), original.subarray(-12)]);
    assert.ok(inspectPng(manyChunks).chunks.length > 256);
    const fragmented = await provider.render(makeRequest({ bytes: manyChunks, format: "png",
      settings: { ...JSON.parse(runtime.neutralSettings()), v: 9 }, dimensions: { width: 2, height: 1 } }));
    assert.deepEqual(fragmented.assets.map((asset) => [asset.width, asset.height]), [[2, 1], [2, 1]]);
    assert.deepEqual(await readdir(scratchRoot), []);
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
});

test("png16 full metadata changes pixels and malformed metadata is rejected", async () => {
  const scratchRoot = await mkdtemp(join(tmpdir(), "niho-cloud-provider-png16-"));
  try {
    const { runtime } = await loadVerifiedDevelopRuntime();
    const contract = await loadVerifiedContract();
    const baseVersion = "raw.synthetic.v1";
    const base = { ...JSON.parse(runtime.neutralSettings()), v: 9 };
    const meta = { kind: "raw", baselineEV: 0.2, asShotWhite: { x: 0.3324, y: 0.3474, temperature: 5400, tint: 4 },
      dcpSha256: "a".repeat(64), lookTableIncluded: true };
    const settings = contract.developSettingsOnWorkingCopy(base, baseVersion, meta);
    const bytes = syntheticPng16();
    const asset = { id: "work-png16", kind: "working-copy", sha256: digest(bytes), sizeBytes: bytes.length,
      contentType: "image/png", width: 2, height: 1 };
    const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 10_000, maxInputBytes: 1024 ** 2,
      maxMaskTotalBytes: 0, validateRecipe: validator });
    const first = await provider.render(makeRequest({ bytes, format: "png", settings,
      workingCopy: { asset, baseVersion, encoding: "png16", meta, bytes } }));
    const shifted = { ...meta, baselineEV: 0.7 };
    const second = await provider.render(makeRequest({ bytes, format: "png", settings,
      workingCopy: { asset, baseVersion, encoding: "png16", meta: shifted, bytes } }));
    assert.notEqual(first.assets[1].sha256, second.assets[1].sha256);
    await assert.rejects(provider.render(makeRequest({ bytes, format: "png", settings,
      workingCopy: { asset, baseVersion, encoding: "png16", meta: { ...meta, asShotWhite: { x: 0.3 } }, bytes } })),
    (error) => error.code === "decoder_failed" || error.code === "unsupported_settings");
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
});

test("wrong bytes, deadline and cleanup are bounded", async (t) => {
  const scratchRoot = await mkdtemp(join(tmpdir(), "niho-cloud-provider-hostile-"));
  try {
    const { runtime } = await loadVerifiedDevelopRuntime();
    const settings = { ...JSON.parse(runtime.neutralSettings()), v: 9 };
    await t.test("wrong bytes hash", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 1000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const request = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings });
      request.source.photo.width = 2; request.source.photo.height = 1; request.source.photo.original.width = 2; request.source.photo.original.height = 1;
      request.input.asset.width = 2; request.input.asset.height = 1; request.input.exportMaxEdge = 2;
      request.readAsset = async () => (async function* () { yield Uint8Array.of(1, 2, 3); })();
      await assert.rejects(provider.render(request), (error) => error.code === "content_mismatch");
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("hostile unresolved iterator", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 20, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const request = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings,
        readAsset: async () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => new Promise(() => {}) }; } }) });
      request.source.photo.width = 2; request.source.photo.height = 1; request.source.photo.original.width = 2; request.source.photo.original.height = 1;
      request.input.asset.width = 2; request.input.asset.height = 1; request.input.exportMaxEdge = 2;
      const started = Date.now();
      await assert.rejects(provider.render(request), (error) => error.code === "timeout");
      assert.ok(Date.now() - started < 1000);
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("caller abort during hostile iterator", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 1000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const abort = new AbortController();
      const request = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings,
        readAsset: async () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => new Promise(() => {}) }; } }) });
      request.source.photo.width = 2; request.source.photo.height = 1; request.source.photo.original.width = 2; request.source.photo.original.height = 1;
      request.input.asset.width = 2; request.input.asset.height = 1; request.input.exportMaxEdge = 2; request.signal = abort.signal;
      const pending = provider.render(request);
      setTimeout(() => abort.abort(), 10);
      await assert.rejects(pending, (error) => error.code === "cancelled");
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("late readAsset iterable is returned after cancellation", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 1000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const abort = new AbortController();
      let resolveRead;
      let readStarted;
      let returned = 0;
      const started = new Promise((resolve) => { readStarted = resolve; });
      const deferred = new Promise((resolve) => { resolveRead = resolve; });
      const request = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings,
        readAsset: async () => { readStarted(); return deferred; } });
      request.source.photo.width = 2; request.source.photo.height = 1; request.source.photo.original.width = 2; request.source.photo.original.height = 1;
      request.input.asset.width = 2; request.input.asset.height = 1; request.input.exportMaxEdge = 2; request.signal = abort.signal;
      const pending = provider.render(request);
      await started;
      abort.abort(new Error("synthetic-private-abort"));
      await assert.rejects(pending, (error) => error.code === "cancelled" && error.message === "photo-cloud-media: cancelled");
      resolveRead({ [Symbol.asyncIterator]() { return { next: async () => ({ done: true }), return() { returned += 1; throw new Error("synthetic return detail"); } }; } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(returned, 1);
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("external errors and abort reasons have fixed messages", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 1000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const known = new CloudMediaError("invalid_input");
      known.message = "synthetic-upstream-private-detail";
      const knownRequest = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings,
        readAsset: async () => { throw known; } });
      knownRequest.source.photo.width = 2; knownRequest.source.photo.height = 1;
      knownRequest.source.photo.original.width = 2; knownRequest.source.photo.original.height = 1;
      knownRequest.input.asset.width = 2; knownRequest.input.asset.height = 1; knownRequest.input.exportMaxEdge = 2;
      await assert.rejects(provider.render(knownRequest),
        (error) => error.code === "invalid_input" && error.message === "photo-cloud-media: invalid_input");

      const unknown = new CloudMediaError("invalid_input");
      unknown.message = "synthetic-upstream-private-detail";
      unknown.code = "synthetic-private-code";
      const unknownRequest = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings,
        readAsset: async () => { throw unknown; } });
      unknownRequest.source.photo.width = 2; unknownRequest.source.photo.height = 1;
      unknownRequest.source.photo.original.width = 2; unknownRequest.source.photo.original.height = 1;
      unknownRequest.input.asset.width = 2; unknownRequest.input.asset.height = 1; unknownRequest.input.exportMaxEdge = 2;
      await assert.rejects(provider.render(unknownRequest),
        (error) => error.code === "renderer_unavailable" && error.message === "photo-cloud-media: renderer_unavailable");

      const abort = new AbortController();
      const reason = new CloudMediaError("invalid_input");
      reason.message = "synthetic-abort-private-detail";
      abort.abort(reason);
      const abortRequest = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings });
      abortRequest.source.photo.width = 2; abortRequest.source.photo.height = 1;
      abortRequest.source.photo.original.width = 2; abortRequest.source.photo.original.height = 1;
      abortRequest.input.asset.width = 2; abortRequest.input.asset.height = 1; abortRequest.input.exportMaxEdge = 2;
      abortRequest.signal = abort.signal;
      await assert.rejects(provider.render(abortRequest),
        (error) => error.code === "cancelled" && error.message === "photo-cloud-media: cancelled");
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("factory options and request metadata are captured before paused reads", async () => {
      let resolveRead;
      let readStarted;
      const started = new Promise((resolve) => { readStarted = resolve; });
      const options = { scratchRoot, timeoutMs: 5000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator };
      const provider = createPinnedMediaProvider(options);
      const inputBytes = syntheticPng(2, 1);
      const request = makeRequest({ bytes: inputBytes, format: "png", settings,
        readAsset: async () => {
          readStarted();
          return new Promise((resolve) => { resolveRead = () => resolve((async function* () { yield inputBytes; })()); });
        } });
      request.source.photo.width = 2; request.source.photo.height = 1;
      request.source.photo.original.width = 2; request.source.photo.original.height = 1;
      request.input.asset.width = 2; request.input.asset.height = 1; request.input.exportMaxEdge = 2;
      const capturedInputHash = request.input.asset.sha256;
      const capturedSettingsHash = request.source.photo.recipe.settingsSha256;
      const pending = provider.render(request);
      await started;
      options.scratchRoot = join(scratchRoot, "mutated-root");
      options.timeoutMs = 1;
      options.maxInputBytes = 1;
      options.validateRecipe = () => { throw new Error("mutated validator"); };
      request.source.photo.recipe.settings.exposure = 99;
      request.source.photo.recipe.settingsSha256 = "f".repeat(64);
      request.source.photo.original.sha256 = "e".repeat(64);
      request.input.asset.sha256 = "d".repeat(64);
      resolveRead();
      const result = await pending;
      assert.equal(result.identity.inputAsset.sha256, capturedInputHash);
      assert.equal(result.identity.settingsSha256, capturedSettingsHash);
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("non-callable recipe validator is rejected at factory creation", () => {
      assert.throws(() => createPinnedMediaProvider({ scratchRoot, timeoutMs: 1000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: null }), /invalid provider options/);
    });
    await t.test("abort terminates an active isolated renderer", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 5000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const abort = new AbortController();
      const request = makeRequest({ bytes: syntheticPng(8, 8), format: "png", settings });
      request.signal = abort.signal;
      const pending = provider.render(request);
      setTimeout(() => abort.abort(), 20);
      await assert.rejects(pending, (error) => error.code === "cancelled");
      assert.deepEqual(await readdir(scratchRoot), []);
    });
    await t.test("one factory rejects concurrent overload", async () => {
      const provider = createPinnedMediaProvider({ scratchRoot, timeoutMs: 1000, maxInputBytes: 1024,
        maxMaskTotalBytes: 0, validateRecipe: validator });
      const abort = new AbortController();
      const request = makeRequest({ bytes: syntheticPng(2, 1), format: "png", settings,
        readAsset: async () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => new Promise(() => {}) }; } }) });
      request.source.photo.width = 2; request.source.photo.height = 1; request.source.photo.original.width = 2; request.source.photo.original.height = 1;
      request.input.asset.width = 2; request.input.asset.height = 1; request.input.exportMaxEdge = 2; request.signal = abort.signal;
      const first = provider.render(request);
      await assert.rejects(provider.render(request), (error) => error.code === "renderer_unavailable");
      abort.abort();
      await assert.rejects(first, (error) => error.code === "cancelled");
      assert.deepEqual(await readdir(scratchRoot), []);
    });
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
});
