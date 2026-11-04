import test from "node:test";
import assert from "node:assert/strict";
import { selectCloudRenderInput, isCurrentCloudPreview } from "../src/index.ts";

const hash = (letter) => letter.repeat(64);
const recipe = {
  revision: 4,
  settings: { v: 9, engine: "niho-14", base: null, unknown: { preserve: true } },
  settingsSha256: hash("a"), baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-01T00:00:00Z",
};
const original = { id: "opaque-original", kind: "original", sha256: hash("b"), sizeBytes: 100,
  contentType: "image/jpeg", width: 4, height: 3 };
const thumbnail = { id: "thumb", kind: "thumbnail", sha256: hash("c"), sizeBytes: 100,
  contentType: "image/png", width: 4, height: 3 };
const preview = { id: "preview", kind: "preview", sha256: hash("d"), sizeBytes: 100,
  contentType: "image/png", width: 4, height: 3 };
const photo = {
  id: "opaque-photo", libraryId: "opaque-library", storageState: "stored", lifecycle: "active",
  fileName: "synthetic.jpg", format: "jpeg", hasEdits: true, addedAt: "2026-11-01T00:00:00Z", capturedAt: null,
  width: 4, height: 3, original, recipe,
  media: { state: "ready", thumbnail, preview, workingCopy: null, recipeRevision: 3, rendererManifestSha256: hash("e") },
};
const limits = { recipeWritable: true, maxBytes: 1024, maxPixels: 100 };

test("direct selector snapshots metadata and stale preview is not current", () => {
  const selected = selectCloudRenderInput(photo, limits);
  assert.equal(selected.state, "ready");
  assert.equal(selected.input.kind, "original");
  assert.equal(selected.input.exportMaxEdge, 4);
  assert.equal(isCurrentCloudPreview(photo, hash("e")), false);
  original.width = 9;
  assert.equal(selected.input.asset.width, 4);
  original.width = 4;
  assert.equal(Object.isFrozen(selected.input), true);
});

test("unknown/read-only recipe is unavailable without downgrade", () => {
  assert.deepEqual(selectCloudRenderInput(photo, { ...limits, recipeWritable: false }), {
    state: "unavailable", reason: "unsupported_settings",
  });
});

test("saved base requires the exact canonical working copy but ignores stale derivative revision", () => {
  const meta = { kind: "raw", baselineEV: 0.2, nested: { keep: [1, true] } };
  const work = { asset: { id: "work", kind: "working-copy", sha256: hash("f"), sizeBytes: 200,
    contentType: "image/png", width: 4, height: 3 }, baseVersion: "raw.synthetic.v1", encoding: "png16", meta };
  const based = {
    ...photo,
    format: "raw",
    recipe: { ...recipe, baseVersion: work.baseVersion, settings: { ...recipe.settings, base: work.baseVersion } },
    media: { ...photo.media, workingCopy: work, recipeRevision: 2 },
  };
  const selected = selectCloudRenderInput(based, limits);
  assert.equal(selected.state, "ready");
  assert.equal(selected.input.kind, "workingCopy");
  assert.equal(selected.input.exportMaxEdge, 4);
  meta.nested.keep[0] = 99;
  assert.equal(selected.input.meta.nested.keep[0], 1);
  const mismatch = { ...based, recipe: { ...based.recipe, baseVersion: "raw.other" } };
  assert.deepEqual(selectCloudRenderInput(mismatch, limits), { state: "unavailable", reason: "base_unavailable" });
});

test("RAW without a saved canonical base never falls back to raster original", () => {
  const raw = { ...photo, format: "raw", original: { ...original, contentType: "application/octet-stream" } };
  assert.deepEqual(selectCloudRenderInput(raw, limits), { state: "unavailable", reason: "base_unavailable" });
});

test("current preview requires exact manifest/revision and bounded valid assets", () => {
  const current = { ...photo, media: { ...photo.media, recipeRevision: recipe.revision } };
  assert.equal(isCurrentCloudPreview(current, hash("e")), true);
  assert.equal(isCurrentCloudPreview({ ...current, media: { ...current.media, preview: { ...preview, width: 1281 } } }, hash("e")), false);
  assert.equal(isCurrentCloudPreview(current, hash("f")), false);

  const baseVersion = "raw.synthetic.v1";
  const working = { asset: { id: "preview-work", kind: "working-copy", sha256: hash("f"), sizeBytes: 200,
    contentType: "image/png", width: 4, height: 3 }, baseVersion, encoding: "png16", meta: { kind: "raw" } };
  const based = {
    ...current,
    format: "raw",
    recipe: { ...recipe, baseVersion, settings: { ...recipe.settings, base: baseVersion } },
    media: { ...current.media, workingCopy: working },
  };
  assert.equal(isCurrentCloudPreview(based, hash("e")), true);
  assert.equal(isCurrentCloudPreview({ ...based, media: { ...based.media, workingCopy: null } }, hash("e")), false);
  assert.equal(isCurrentCloudPreview({ ...based, media: { ...based.media, workingCopy: { ...working, baseVersion: "other" } } }, hash("e")), false);
});

test("opaque IDs are bounded without assuming UUID syntax", () => {
  assert.equal(selectCloudRenderInput({ ...photo, id: "not-a-uuid" }, limits).state, "ready");
  assert.deepEqual(selectCloudRenderInput({ ...photo, id: `bad-${"x".repeat(600)}` }, limits), {
    state: "unavailable", reason: "invalid_metadata",
  });
});

test("recipe and working-copy metadata use their distinct C00 byte limits", () => {
  const largeSettings = {
    ...recipe.settings,
    c02ValidatedPayload: "x".repeat(70 * 1024),
    preservedNodes: Array.from({ length: 9_000 }, (_, index) => index % 2),
  };
  const largeRecipePhoto = { ...photo, recipe: { ...recipe, settings: largeSettings } };
  assert.equal(selectCloudRenderInput(largeRecipePhoto, limits).state, "ready");

  const baseVersion = "raw.synthetic.v1";
  const work = {
    asset: { id: "work-large-meta", kind: "working-copy", sha256: hash("f"), sizeBytes: 200,
      contentType: "image/png", width: 4, height: 3 },
    baseVersion,
    encoding: "png16",
    meta: { kind: "raw", payload: "m".repeat(65 * 1024) },
  };
  const based = { ...photo, format: "raw",
    recipe: { ...recipe, baseVersion, settings: { ...recipe.settings, base: baseVersion } },
    media: { ...photo.media, workingCopy: work } };
  assert.deepEqual(selectCloudRenderInput(based, limits), { state: "unavailable", reason: "invalid_metadata" });
});

test("working-copy host budget failures remain input_limit", () => {
  const baseVersion = "raw.synthetic.v2";
  const work = {
    asset: { id: "work-budget", kind: "working-copy", sha256: hash("f"), sizeBytes: 200,
      contentType: "image/png", width: 4, height: 3 },
    baseVersion,
    encoding: "png16",
    meta: { kind: "raw", baselineEV: 0.2 },
  };
  const based = { ...photo, format: "raw",
    recipe: { ...recipe, baseVersion, settings: { ...recipe.settings, base: baseVersion } },
    media: { ...photo.media, workingCopy: work } };
  assert.deepEqual(selectCloudRenderInput(based, { ...limits, maxBytes: 199 }), {
    state: "unavailable", reason: "input_limit",
  });
  assert.deepEqual(selectCloudRenderInput(based, { ...limits, maxPixels: 11 }), {
    state: "unavailable", reason: "input_limit",
  });
});

test("malformed public metadata is rejected safely without encoding fallback", () => {
  const invalid = [
    { ...photo, storageState: "missing" },
    { ...photo, lifecycle: "deleted" },
    { ...photo, original: { ...original, kind: "preview" } },
    { ...photo, original: { ...original, contentType: "image/png" } },
    { ...photo, width: Number.NaN },
    { ...photo, recipe: undefined },
    { ...photo, format: "raw", media: undefined },
    { ...photo, media: { state: "future-state" } },
  ];
  for (const candidate of invalid) {
    assert.doesNotThrow(() => selectCloudRenderInput(candidate, limits));
    assert.deepEqual(selectCloudRenderInput(candidate, limits), { state: "unavailable", reason: "invalid_metadata" });
  }

  const baseVersion = "raw.synthetic.v3";
  const badEncoding = { ...photo, format: "raw",
    recipe: { ...recipe, baseVersion, settings: { ...recipe.settings, base: baseVersion } },
    media: { ...photo.media, workingCopy: {
      asset: { id: "work-encoding", kind: "working-copy", sha256: hash("f"), sizeBytes: 200,
        contentType: "image/jpeg", width: 4, height: 3 },
      baseVersion, encoding: "future8", meta: { kind: "raster" },
    } } };
  assert.deepEqual(selectCloudRenderInput(badEncoding, limits), {
    state: "unavailable", reason: "invalid_metadata",
  });
  assert.deepEqual(selectCloudRenderInput({ ...badEncoding, media: { state: "ready" } }, limits), {
    state: "unavailable", reason: "invalid_metadata",
  });
  assert.equal(isCurrentCloudPreview({ ...photo, media: undefined }, hash("e")), false);
  assert.deepEqual(selectCloudRenderInput(photo, null), { state: "unavailable", reason: "invalid_metadata" });
  assert.equal(isCurrentCloudPreview({ ...photo, lifecycle: "purged", media: { ...photo.media, recipeRevision: recipe.revision } }, hash("e")), false);
});
