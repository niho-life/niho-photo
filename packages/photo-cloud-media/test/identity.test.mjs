import test from "node:test";
import assert from "node:assert/strict";
import { createMediaIdentity, mediaIdentityKey, matchesMediaSource, verifyExactBytes } from "../src/server/index.ts";
import { createHash } from "node:crypto";

const h = (x) => x.repeat(64);
const original = { id: "original", kind: "original", sha256: h("a"), sizeBytes: 10, contentType: "image/jpeg", width: 2, height: 1 };
const settings = { v: 1, engine: "niho-14", base: null };
const settingsHash = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
const validated = { canonicalSettings: JSON.stringify(settings), settingsSha256: settingsHash, baseVersion: null, maskSurfaceIds: [] };
const photo = {
  id: "photo", libraryId: "library", storageState: "stored", lifecycle: "active", fileName: "x.jpg", format: "jpeg",
  hasEdits: false, addedAt: "2026-11-01T00:00:00Z", capturedAt: null, width: 2, height: 1, original,
  recipe: { revision: 1, settings, settingsSha256: settingsHash, baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-01T00:00:00Z" },
  media: { state: "pending" },
};
const source = { ownerId: "owner", originalGeneration: "generation-1", lifecycleGeneration: 1, photo };
const direct = { kind: "original", format: "jpeg", photoId: "photo", libraryId: "library", originalSha256: h("a"),
  originalAssetId: "original", asset: original, exportMaxEdge: 2 };
const manifest = h("c");

function basedFixture() {
  const workAsset = { id: "work", kind: "working-copy", sha256: h("f"), sizeBytes: 20,
    contentType: "image/png", width: 2, height: 1 };
  const meta = { kind: "raw", baselineEV: 0.2 };
  const input = { ...direct, kind: "workingCopy", encoding: "png16", asset: workAsset,
    baseVersion: "raw.v1", meta };
  const basedSettings = { ...settings, base: "raw.v1" };
  const canonicalSettings = JSON.stringify(basedSettings);
  const basedHash = createHash("sha256").update(canonicalSettings).digest("hex");
  const basedRecipe = { ...validated, canonicalSettings, settingsSha256: basedHash, baseVersion: "raw.v1" };
  const basedSource = { ...source, photo: { ...photo,
    recipe: { ...photo.recipe, baseVersion: "raw.v1", settings: basedSettings, settingsSha256: basedHash },
    media: { state: "ready", thumbnail: { ...original, id: "thumb", kind: "thumbnail" },
      preview: { ...original, id: "preview", kind: "preview" },
      workingCopy: { asset: workAsset, baseVersion: "raw.v1", encoding: "png16", meta },
      recipeRevision: 0, rendererManifestSha256: manifest } } };
  return { input, recipe: basedRecipe, source: basedSource };
}

test("identity is frozen and matches an unchanged source", () => {
  const identity = createMediaIdentity(source, direct, validated, manifest);
  assert.equal(Object.isFrozen(identity), true);
  assert.match(mediaIdentityKey(identity), /^[a-f0-9]{64}$/);
  assert.equal(matchesMediaSource(identity, source, direct, validated), true);
});

test("identity key changes across every publication fence", () => {
  const base = mediaIdentityKey(createMediaIdentity(source, direct, validated, manifest));
  const variants = [
    [{ ...source, ownerId: "owner-2" }, direct, validated, manifest],
    [{ ...source, originalGeneration: "generation-2" }, direct, validated, manifest],
    [{ ...source, lifecycleGeneration: 2 }, direct, validated, manifest],
    [{ ...source, photo: { ...photo, recipe: { ...photo.recipe, revision: 2 } } }, direct, validated, manifest],
    [{ ...source, photo: { ...photo, recipe: { ...photo.recipe, maskSurfaceIds: [h("d")] } } }, direct,
      { ...validated, maskSurfaceIds: [h("d")] }, manifest],
    [source, direct, validated, h("e")],
  ];
  for (const args of variants) assert.notEqual(mediaIdentityKey(createMediaIdentity(...args)), base);

  const workAsset = { id: "work", kind: "working-copy", sha256: h("f"), sizeBytes: 20, contentType: "image/png", width: 2, height: 1 };
  const work = { ...direct, kind: "workingCopy", encoding: "png16", asset: workAsset,
    baseVersion: "raw.v1", meta: { kind: "raw", baselineEV: 0.2 } };
  const basedSettings = { ...settings, base: "raw.v1" };
  const basedCanonical = JSON.stringify(basedSettings);
  const basedHash = createHash("sha256").update(basedCanonical).digest("hex");
  const based = { ...validated, canonicalSettings: basedCanonical, settingsSha256: basedHash, baseVersion: "raw.v1" };
  const basedSource = { ...source, photo: { ...photo,
    recipe: { ...photo.recipe, baseVersion: "raw.v1", settings: basedSettings, settingsSha256: basedHash },
    media: { state: "ready", thumbnail: { ...original, id: "thumb", kind: "thumbnail" },
      preview: { ...original, id: "preview", kind: "preview" },
      workingCopy: { asset: workAsset, baseVersion: "raw.v1", encoding: "png16", meta: work.meta },
      recipeRevision: 0, rendererManifestSha256: manifest } } };
  const first = mediaIdentityKey(createMediaIdentity(basedSource, work, based, manifest));
  assert.notEqual(first, base);
  const changedWork = { ...work, meta: { kind: "raw", baselineEV: 0.7 } };
  const changedSource = { ...basedSource, photo: { ...basedSource.photo, media: { ...basedSource.photo.media,
    workingCopy: { ...basedSource.photo.media.workingCopy, meta: changedWork.meta } } } };
  assert.notEqual(mediaIdentityKey(createMediaIdentity(changedSource, changedWork, based, manifest)), first);
});

test("pure pinned-byte verifier rejects size and digest changes", () => {
  const bytes = Uint8Array.of(1, 2, 3);
  const expected = { sizeBytes: 3, sha256: createHash("sha256").update(bytes).digest("hex") };
  assert.equal(verifyExactBytes(bytes, expected), true);
  assert.equal(verifyExactBytes(Uint8Array.of(1, 2, 4), expected), false);
  assert.equal(verifyExactBytes(bytes, { ...expected, sizeBytes: 4 }), false);
});

test("matchesMediaSource rejects every changed current publication fence", () => {
  const identity = createMediaIdentity(source, direct, validated, manifest);
  const changedSettings = { ...settings, exposure: 0.75 };
  const changedCanonical = JSON.stringify(changedSettings);
  const changedHash = createHash("sha256").update(changedCanonical).digest("hex");
  const changedRecipeSource = { ...source, photo: { ...photo, recipe: { ...photo.recipe,
    settings: changedSettings, settingsSha256: changedHash } } };
  assert.equal(matchesMediaSource(identity, changedRecipeSource, direct, validated), false);

  const currentMask = h("d");
  const changedMaskSource = { ...source, photo: { ...photo, recipe: { ...photo.recipe,
    maskSurfaceIds: [currentMask] } } };
  assert.equal(matchesMediaSource(identity, changedMaskSource, direct, validated), false);
  assert.equal(matchesMediaSource(identity, { ...source, photo: { ...photo, lifecycle: "deleted" } }, direct, validated), false);

  const changedOriginal = { ...original, id: "new-original", sha256: h("e") };
  const changedAssetSource = { ...source, originalGeneration: "generation-2", photo: { ...photo,
    original: changedOriginal } };
  assert.equal(matchesMediaSource(identity, changedAssetSource, direct, validated), false);

  const based = basedFixture();
  assert.equal(matchesMediaSource(identity, based.source, direct, validated), false);
  const basedIdentity = createMediaIdentity(based.source, based.input, based.recipe, manifest);
  const changedMeta = { kind: "raw", baselineEV: 0.9 };
  const metaSource = { ...based.source, photo: { ...based.source.photo, media: { ...based.source.photo.media,
    workingCopy: { ...based.source.photo.media.workingCopy, meta: changedMeta } } } };
  assert.equal(matchesMediaSource(basedIdentity, metaSource, based.input, based.recipe), false);
  const changedWorkAsset = { ...based.input.asset, id: "new-work", sha256: h("b") };
  const workSource = { ...based.source, photo: { ...based.source.photo, media: { ...based.source.photo.media,
    workingCopy: { ...based.source.photo.media.workingCopy, asset: changedWorkAsset } } } };
  assert.equal(matchesMediaSource(basedIdentity, workSource, based.input, based.recipe), false);
});

test("public identity helpers reject malformed kinds, encodings, hashes and MIME coherence", () => {
  assert.throws(() => createMediaIdentity(source, { ...direct, kind: "future" }, validated, manifest), /invalid identity/);
  assert.throws(() => createMediaIdentity(source, { ...direct, asset: { ...original, contentType: "image/png" } }, validated, manifest), /invalid identity/);

  const based = basedFixture();
  assert.throws(() => createMediaIdentity(based.source, { ...based.input, encoding: "future16" }, based.recipe, manifest), /invalid identity/);
  assert.throws(() => createMediaIdentity(based.source, { ...based.input,
    asset: { ...based.input.asset, contentType: "image/jpeg" } }, based.recipe, manifest), /invalid identity/);

  const invalidMaskSource = { ...source, photo: { ...photo, recipe: { ...photo.recipe, maskSurfaceIds: ["not-a-hash"] } } };
  assert.throws(() => createMediaIdentity(invalidMaskSource, direct,
    { ...validated, maskSurfaceIds: ["not-a-hash"] }, manifest), /invalid identity/);

  const identity = createMediaIdentity(source, direct, validated, manifest);
  assert.throws(() => mediaIdentityKey({ ...identity, maskSurfaceIds: ["not-a-hash"] }), /invalid identity/);
  assert.throws(() => mediaIdentityKey({ ...identity, encoding: "future" }), /invalid identity/);
  assert.throws(() => mediaIdentityKey({ ...identity,
    inputAsset: { ...identity.inputAsset, contentType: "image/png" } }), /invalid identity/);
});
