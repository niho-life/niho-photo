import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostedReplicaSync } from "../src/index.ts";
import { assertMirrors, bytesOf, editRequest, maskSettings, seeded, signal } from "./helpers.mjs";

const ALLOWED = new Set(["connector.pullReplica", "connector.getReplicaContent", "connector.ackReplica"]);

test("saves made while the Mac sleeps reach the replica on wake, as a diff from its own revision", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store });
  assert.deepEqual(sync.status(), { canonicalRevision: null, replicaRevision: 0, state: "unknown" });
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  assertMirrors(canonical, store);
  const beforeSleep = store.snapshot().revision;

  canonical.connectorState = "sleeping";
  const saved = await canonical.putRecipe(editRequest(canonical, ids.k1, { exposure: 0.5 }), "save-1");
  assert.equal(saved.value.durability, "niho");
  assert.equal(saved.value.replica, "pendingHost");
  await canonical.putRecipe(editRequest(canonical, ids.k2, { exposure: -0.3 }), "save-2");
  assert.equal(store.snapshot().revision, beforeSleep, "nothing reaches the Mac while it sleeps");

  canonical.connectorState = "online";
  canonical.calls.length = 0;
  store.applied.length = 0;
  const woke = await sync.sync({ canonicalRevision: canonical.revision, signal });
  assert.equal(woke.mode, "diff");
  assert.equal(woke.appliedChanges, 2);
  assert.equal(store.applied[0].fromRevision, beforeSleep, "the diff starts from the replica's own revision");
  assert.deepEqual(sync.status(), { canonicalRevision: canonical.revision, replicaRevision: canonical.revision, state: "current" });
  assert.equal(canonical.acknowledgedRevision, canonical.revision);
  assertMirrors(canonical, store);
  for (const call of canonical.calls) assert(ALLOWED.has(call), call);
});

test("the replica never writes back; a replica ahead of NIHO is rebuilt, not promoted", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store });
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  const canonicalBefore = { revision: canonical.revision, state: canonical.state() };
  const recipe = (await store.get("recipe", ids.k1)).body.recipe;
  store.tamperRecord({ revision: canonical.revision + 9, op: "upsert", entity: "recipe", id: ids.k1, body: { recipe: { ...recipe, revision: 99 }, recipeSourceGeneration: 1 } });
  store.tamperRevision(canonical.revision + 9);

  canonical.calls.length = 0;
  const result = await sync.sync({ canonicalRevision: canonical.revision, signal });
  assert.equal(result.mode, "snapshot");
  assertMirrors(canonical, store);
  assert.equal(canonical.revision, canonicalBefore.revision, "NIHO is not written");
  assert.deepEqual(canonical.state(), canonicalBefore.state);
  for (const call of canonical.calls) assert(ALLOWED.has(call), call);
});

test("a compacted journal rebuilds from a snapshot; a failed rebuild keeps the previous replica", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store, pageLimit: 2 });
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  const oldReplica = store.snapshot();

  canonical.defineAlbum("synthetic-album-old", "Synthetic", [{ itemId: "synthetic-item-old", photoId: ids.k1 }]);
  canonical.deleteAlbum("synthetic-album-old");
  const surfaceId = await canonical.putMask(ids.k1, bytesOf("synthetic mask"));
  await canonical.putRecipe(editRequest(canonical, ids.k1, maskSettings(surfaceId)), "save-mask");
  canonical.compact(canonical.revision);

  canonical.corruptMaskContent = true;
  await assert.rejects(sync.sync({ canonicalRevision: canonical.revision, signal }), { code: "integrity_mismatch" });
  assert.deepEqual(store.snapshot(), oldReplica, "an interrupted rebuild leaves the old replica intact");
  assert.equal(sync.status().state, "behind");

  canonical.corruptMaskContent = false;
  const rebuilt = await sync.sync({ canonicalRevision: canonical.revision, signal });
  assert.equal(rebuilt.mode, "snapshot");
  assertMirrors(canonical, store);
  assert.equal(await store.get("albumDefinition", "synthetic-album-old"), null);
  assert.deepEqual(await store.maskBytes(`${ids.k1}:${surfaceId}`), bytesOf("synthetic mask"));
});

test("mask bytes are verified; a corrupt mask leaves the whole page unapplied", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store });
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  const before = store.snapshot().revision;
  await canonical.putMask(ids.k2, bytesOf("synthetic mask two"));
  canonical.corruptMaskContent = true;
  await assert.rejects(sync.sync({ canonicalRevision: canonical.revision, signal }), { code: "integrity_mismatch" });
  assert.equal(store.snapshot().revision, before);
  canonical.corruptMaskContent = false;
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  assertMirrors(canonical, store);
});

test("a disk failure mid-sync resumes from the durable revision with a CAS chain", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store, pageLimit: 1 });
  let applies = 0;
  const apply = store.apply.bind(store);
  store.apply = async (batch) => {
    if (++applies === 3) throw new Error("synthetic disk failure");
    return apply(batch);
  };
  await canonical.putRecipe(editRequest(canonical, ids.k1, { exposure: 1 }), "save-1");
  await assert.rejects(sync.sync({ canonicalRevision: canonical.revision, signal }));
  const partial = store.snapshot().revision;
  assert(partial > 0 && partial < canonical.revision, "pages applied before the failure stay durable");
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  assertMirrors(canonical, store);
  for (let index = 1; index < store.applied.length; index++) {
    assert.equal(store.applied[index].fromRevision, store.applied[index - 1].toRevision);
  }
});

test("a lost ack is acknowledged again with the same key", async () => {
  const { canonical, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store });
  canonical.nextFault = "dropResponseAfterCommit";
  const first = await sync.sync({ canonicalRevision: canonical.revision, signal });
  assert.equal(first.acknowledged, false);
  assert.equal(canonical.acknowledgedRevision, canonical.revision, "the ack was recorded even though its response was lost");
  const second = await sync.sync({ canonicalRevision: canonical.revision, signal });
  assert.equal(second.mode, "unchanged");
  assert.equal(second.acknowledged, true);
});

test("deletions and late NIHO changes during a sync converge to NIHO", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store });
  canonical.defineAlbum("synthetic-album", "Synthetic", [{ itemId: "synthetic-item-1", photoId: ids.k1 }]);
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  canonical.deleteAlbum("synthetic-album");
  canonical.exclude(ids.k2);
  // The heartbeat reported an older revision; the pull still converges to what NIHO holds now.
  const result = await sync.sync({ canonicalRevision: canonical.revision - 1, signal });
  assert.equal(result.replicaRevision, canonical.revision);
  assertMirrors(canonical, store);
  assert.equal(await store.get("albumDefinition", "synthetic-album"), null);
  assert.notEqual(await store.get("exclusion", ids.k2), null);
});
