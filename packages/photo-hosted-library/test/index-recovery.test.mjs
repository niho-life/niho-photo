import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostedReplicaSync, recoverLocalIndex } from "../src/index.ts";
import { sha256Hex } from "../src/shared.ts";
import { MemoryReplicaStore } from "../test-support/memory.ts";
import { bytesOf, editRequest, indexEntry, maskSettings, seeded, signal } from "./helpers.mjs";

const FILES = {
  k1: "synthetic original one",
  k2: "synthetic original two",
  k3: "synthetic original three",
  k4: "synthetic original four",
  k5: "synthetic original five",
  k6: "synthetic original six",
  k7: "synthetic original seven",
};

/** NIHO holds photos, an edited recipe with a mask and an album; the Mac lost its local index. */
async function scenario() {
  const context = await seeded(FILES);
  const { canonical, scanner, ids } = context;
  await canonical.putIndex([await indexEntry("k8", "synthetic original eight", { hashed: false })]);
  scanner.files.set("k8", bytesOf("synthetic original eight"));
  const mask = bytesOf("synthetic mask");
  const surfaceId = await sha256Hex(mask);
  await canonical.putMask(ids.k1, mask);
  await canonical.putRecipe(editRequest(canonical, ids.k1, maskSettings(surfaceId)), "op-1");
  canonical.defineAlbum("synthetic-album", "Synthetic", [{ itemId: "synthetic-item-1", photoId: ids.k1 }, { itemId: "synthetic-item-2", photoId: ids.k2 }]);
  canonical.exclude(ids.k6);
  await createHostedReplicaSync({ client: canonical.client(), store: context.store }).sync({ canonicalRevision: canonical.revision, signal });

  // What the Mac finds after the index was deleted.
  scanner.files.set("k2", bytesOf("synthetic original twX"));
  scanner.files.set("k3", bytesOf("synthetic original three, but longer"));
  scanner.files.delete("k5");
  scanner.unreadable.add("k7");
  return { ...context, surfaceId };
}

test("a lost index is rebuilt from NIHO and the originals; only exact matches are relinked", async () => {
  const { canonical, scanner, store, ids } = await scenario();
  const report = await recoverLocalIndex({ store, scanner, signal });
  const byKey = Object.fromEntries(report.entries.map((entry) => [entry.localKey, entry]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(byKey).map(([key, entry]) => [key, [entry.state, entry.reason]])),
    {
      k1: ["relinked", null],
      k2: ["sourceMismatch", "hash"],
      k3: ["sourceMismatch", "size"],
      k4: ["relinked", null],
      k5: ["sourceUnavailable", "missing"],
      k6: ["excluded", null],
      k7: ["sourceUnavailable", "unreadable"],
      k8: ["sourceMismatch", "unverifiable"],
    },
  );
  // Recovery never invents generations: relinked photos keep NIHO's source and recipe binding.
  for (const entry of report.entries) {
    const photo = canonical.photoOf(entry.photoId);
    assert.equal(entry.sourceGeneration, photo.source.generation);
    assert.equal(entry.recipeRevision, canonical.recipeOf(entry.photoId).revision);
    assert(entry.recipeSourceGeneration <= entry.sourceGeneration);
  }
  assert.equal(byKey.k1.recipeRevision, 1);
  assert.deepEqual(byKey.k1.missingMasks, []);
  assert.equal(report.recipes, 8);
  assert.equal(report.albums, 1);
  assert.deepEqual(report.masks, { verified: 1, missing: 0 });
  assert.equal(report.replicaRevision, canonical.revision);
  assert(!scanner.calls.some((call) => call.endsWith(":k6")), "an excluded original is not touched");
  assert(!scanner.calls.includes("hash:k3"), "a size mismatch needs no hash");
  assert.deepEqual(
    Object.fromEntries(report.indexEntries.map((entry) => [entry.localKey, entry.availability])),
    { k1: "available", k2: "sourceMismatch", k3: "sourceMismatch", k4: "available", k5: "missing", k7: "missing", k8: "sourceMismatch" },
  );
  const k2 = report.indexEntries.find((entry) => entry.localKey === "k2");
  assert.deepEqual(k2.source, canonical.photoOf(ids.k2).source, "a mismatch reports NIHO's identity, not the new bytes");
});

test("an unmounted volume makes originals unavailable, never deleted or mismatched", async () => {
  const { store, scanner } = await scenario();
  scanner.unmounted = true;
  scanner.unreadable.clear();
  const report = await recoverLocalIndex({ store, scanner, signal });
  for (const entry of report.entries) {
    if (entry.state === "excluded") continue;
    assert.deepEqual([entry.state, entry.reason], ["sourceUnavailable", "unmounted"]);
  }
  assert(report.indexEntries.every((entry) => entry.availability === "volumeUnmounted"));
  assert(!scanner.calls.some((call) => call.startsWith("hash:")));
});

test("missing mask bytes in the replica are reported, not fabricated", async () => {
  const { store, scanner, ids, surfaceId } = await scenario();
  store.dropMaskBytes(`${ids.k1}:${surfaceId}`);
  const report = await recoverLocalIndex({ store, scanner, signal });
  assert.deepEqual(report.masks, { verified: 0, missing: 1 });
  assert.deepEqual(report.entries.find((entry) => entry.photoId === ids.k1).missingMasks, [surfaceId]);
});

test("recovery needs a replica and stops when aborted", async () => {
  const { scanner } = await scenario();
  await assert.rejects(recoverLocalIndex({ store: new MemoryReplicaStore(), scanner, signal }), { code: "incomplete_replica" });
  const { store } = await scenario();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recoverLocalIndex({ store, scanner, signal: controller.signal }), { code: "aborted" });
});
