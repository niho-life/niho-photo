import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFullExport,
  buildMetadataManifest,
  createHostedReplicaSync,
  manifestSha256,
  parsePortableManifest,
  planRestore,
} from "../src/index.ts";
import { sha256Hex } from "../src/shared.ts";
import { LIBRARY, OWNER } from "../test-support/canonical.ts";
import { bytesOf, editRequest, maskSettings, seeded, signal } from "./helpers.mjs";

const CREATED = "2026-11-07T00:00:00.000Z";

async function exported() {
  const context = await seeded({ k1: "synthetic original one", k2: "synthetic original two", k3: "synthetic original three" });
  const { canonical, ids, store } = context;
  const mask = bytesOf("synthetic mask");
  const surfaceId = await sha256Hex(mask);
  await canonical.putMask(ids.k1, mask);
  await canonical.putRecipe(editRequest(canonical, ids.k1, maskSettings(surfaceId)), "op-1");
  canonical.defineAlbum("synthetic-album", "Synthetic", [{ itemId: "synthetic-item-1", photoId: ids.k1 }, { itemId: "synthetic-item-2", photoId: ids.k2 }]);
  canonical.exclude(ids.k3);
  await createHostedReplicaSync({ client: canonical.client(), store }).sync({ canonicalRevision: canonical.revision, signal });
  const manifest = await buildMetadataManifest({ store, library: { id: LIBRARY }, createdAt: CREATED, signal });
  return { ...context, manifest, mask, surfaceId };
}

test("a metadata export carries recipes, masks, albums and hashes, and nothing that grants access", async () => {
  const { manifest, ids, surfaceId, canonical } = await exported();
  assert.deepEqual(parsePortableManifest(structuredClone(manifest)), manifest);
  assert.equal(manifest.mode, "metadata");
  assert.deepEqual(manifest.photos.map((photo) => photo.photoId).sort(), [ids.k1, ids.k2].sort(), "excluded photos are not exported");
  const k1 = manifest.photos.find((photo) => photo.photoId === ids.k1);
  assert.deepEqual(k1.recipe, canonical.recipeOf(ids.k1));
  assert.deepEqual(k1.masks, [{ surfaceId, sizeBytes: 14 }]);
  assert.deepEqual(k1.original, { included: false, sha256: canonical.photoOf(ids.k1).source.sha256 });
  assert.deepEqual(manifest.engines, ["niho-14"]);
  assert.deepEqual(manifest.albums[0].items.map((item) => [item.kind, item.source]), [
    ["ownerPhoto", { kind: "libraryPhoto", libraryId: LIBRARY, photoId: ids.k1 }],
    ["ownerPhoto", { kind: "libraryPhoto", libraryId: LIBRARY, photoId: ids.k2 }],
  ]);
  const json = JSON.stringify(manifest).toLowerCase();
  for (const word of ["token", "secret", "session", "member", "ticket", "credential", "https://"]) assert(!json.includes(word), word);
  assert.equal(await manifestSha256(manifest), await manifestSha256(structuredClone(manifest)));
});

test("an export with access material or a member's source is rejected", async () => {
  const { manifest } = await exported();
  const reject = (mutate) => {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() => parsePortableManifest(copy), { code: "invalid_request" });
  };
  reject((copy) => { copy.memberships = [{ role: "contributor" }]; });
  reject((copy) => { copy.inviteSecret = "synthetic"; });
  reject((copy) => { copy.photos[0].uploadTicket = { url: "https://upload.example.test/x" }; });
  reject((copy) => { copy.albums[0].items.push({ itemId: "x", kind: "memberEdit", source: { kind: "devicePhoto", deviceSourceRef: "d" }, renditionSha256: null }); });
  reject((copy) => { copy.photos[0].original.included = true; });
  reject((copy) => { copy.photos.push(structuredClone(copy.photos[0])); });
  reject((copy) => { copy.format = "other"; });
});

test("a full export includes only originals and masks that match their hashes", async () => {
  const { manifest, scanner, ids, mask } = await exported();
  scanner.files.set("k2", bytesOf("synthetic original twX"));
  const written = [];
  const localKeyOf = { [ids.k1]: "k1", [ids.k2]: "k2" };
  const result = await buildFullExport({
    manifest,
    readOriginal: async (photo) => scanner.files.get(localKeyOf[photo.photoId]) ?? null,
    readMask: async () => mask,
    sink: { add: async (path, bytes) => { written.push([path, bytes.byteLength]); } },
    signal,
  });
  assert.deepEqual(result.missingOriginals, [ids.k2], "a changed original is reported, not exported");
  assert.equal(result.manifest.mode, "full");
  assert.deepEqual(result.manifest.photos.map((photo) => photo.original.included), manifest.photos.map((photo) => photo.photoId === ids.k1));
  assert.deepEqual(written.map(([path]) => path.split("/")[0]), ["originals", "masks", "manifest.json"]);
  assert.deepEqual(parsePortableManifest(result.manifest), result.manifest);
});

test("restore keeps newer NIHO data, checks hashes and masks, and never restores access", async () => {
  const { manifest, canonical, ids } = await exported();
  const target = { libraryId: LIBRARY, ownerId: OWNER, lifecycle: "active" };
  const ids2 = (() => { let n = 0; return (kind) => `synthetic-new-${kind}-${++n}`; })();

  assert.deepEqual(planRestore({ manifest, actorId: "synthetic-user-b", target, current: canonical.restoreView(), newId: ids2 }), { ok: false, code: "not_found" });
  assert.deepEqual(planRestore({ manifest, actorId: null, target, current: canonical.restoreView(), newId: ids2 }), { ok: false, code: "unauthenticated" });

  // NIHO moved on after the snapshot: the older snapshot never downgrades it.
  await canonical.putRecipe(editRequest(canonical, ids.k1, maskSettings(manifest.photos.find((p) => p.photoId === ids.k1).recipe.maskSurfaceIds[0], 0.9)), "op-2");
  canonical.defineAlbum("synthetic-album", "Synthetic renamed", [{ itemId: "synthetic-item-1", photoId: ids.k1 }]);
  const plan = planRestore({ manifest, actorId: OWNER, target, current: canonical.restoreView(), newId: ids2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "restore");
  assert.deepEqual(plan.photos.map((photo) => [photo.photoId ?? photo.targetPhotoId, photo.action]).sort(), [[ids.k1, "keepNewer"], [ids.k2, "unchanged"]].sort());
  assert.deepEqual(plan.albums.map((album) => album.action), ["keepNewer"]);
  assert.deepEqual(plan.report, { libraryId: LIBRARY, restoredPhotos: 0, restoredAlbums: 0, keptNewer: 2, membershipsRestored: 0, mismatches: [] });

  // NIHO lost a photo and holds different bytes for another: restore the first, report the second.
  const lossy = {
    photo: (photoId) => photoId === ids.k1 ? null : { sourceSha256: "0".repeat(64), recipeRevision: 0 },
    album: () => null,
  };
  const recovered = planRestore({ manifest, actorId: OWNER, target, current: lossy, newId: ids2 });
  assert.deepEqual(recovered.photos.map((photo) => photo.action).sort(), ["mismatch", "restore"]);
  assert.deepEqual(recovered.report.mismatches, [{ photoId: ids.k2, reason: "hash_mismatch" }]);
  assert.equal(recovered.albums[0].action, "restore");
  assert.deepEqual(recovered.albums[0].items, [{ itemId: "synthetic-item-1", photoId: ids.k1 }, { itemId: "synthetic-item-2", photoId: ids.k2 }]);
  assert.equal(recovered.report.membershipsRestored, 0);

  const maskless = structuredClone(manifest);
  maskless.photos.find((photo) => photo.photoId === ids.k1).masks = [];
  const missing = planRestore({ manifest: maskless, actorId: OWNER, target, current: lossy, newId: ids2 });
  assert.deepEqual(missing.report.mismatches.find((item) => item.photoId === ids.k1), { photoId: ids.k1, reason: "mask_missing" });
});

test("an export from another library is imported with new IDs and links back to nothing", async () => {
  const { manifest, canonical } = await exported();
  let n = 0;
  const plan = planRestore({
    manifest,
    actorId: "synthetic-user-b",
    target: { libraryId: "synthetic-library-other", ownerId: "synthetic-user-b", lifecycle: "active" },
    current: canonical.restoreView(),
    newId: (kind) => `synthetic-new-${kind}-${++n}`,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "import");
  const targets = plan.photos.map((photo) => photo.targetPhotoId);
  assert(targets.every((id) => id.startsWith("synthetic-new-photo-")));
  assert(plan.albums.every((album) => album.targetAlbumId.startsWith("synthetic-new-album-")));
  assert(plan.albums[0].items.every((item) => item.itemId.startsWith("synthetic-new-item-") && targets.includes(item.photoId)));
  const original = new Set([...manifest.photos.map((photo) => photo.photoId), ...manifest.albums.map((album) => album.albumId)]);
  assert(!JSON.stringify([plan.photos.map((photo) => photo.targetPhotoId), plan.albums.map((album) => [album.targetAlbumId, album.items])]).split('"').some((value) => original.has(value)));
  assert.equal(plan.report.membershipsRestored, 0);
  assert.equal(plan.report.libraryId, "synthetic-library-other");
});
