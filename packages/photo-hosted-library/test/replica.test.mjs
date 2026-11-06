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

test("compaction during a snapshot restarts it from the beginning", async () => {
  const { canonical, ids, store } = await seeded({ k1: "one", k2: "two", k3: "three", k4: "four" });
  canonical.defineAlbum("synthetic-album", "Synthetic", [{ itemId: "synthetic-item-1", photoId: ids.k1 }]);
  canonical.compact(canonical.revision);
  store.tamperRevision(canonical.revision + 1);
  const sync = createHostedReplicaSync({ client: canonical.client(), store, pageLimit: 2 });
  let pulls = 0;
  canonical.afterPull = () => {
    // After the first snapshot page, an album is deleted and NIHO compacts its tombstones.
    if (++pulls === 1) {
      canonical.deleteAlbum("synthetic-album");
      canonical.compact(canonical.revision);
    }
  };
  const result = await sync.sync({ canonicalRevision: canonical.revision, signal });
  assert.equal(result.mode, "snapshot");
  assert(pulls > 2, "the snapshot restarted after its cursor was invalidated");
  assertMirrors(canonical, store);
  assert.equal(await store.get("albumDefinition", "synthetic-album"), null);
});

test("a deletion during a snapshot reaches the staged replica through its cursor", async () => {
  const { canonical, ids, store } = await seeded({ k1: "one", k2: "two", k3: "three" });
  canonical.defineAlbum("synthetic-album", "Synthetic", [{ itemId: "synthetic-item-1", photoId: ids.k1 }]);
  store.tamperRevision(canonical.revision + 1);
  const sync = createHostedReplicaSync({ client: canonical.client(), store, pageLimit: 2 });
  let pulls = 0;
  canonical.afterPull = () => { if (++pulls === 1) canonical.deleteAlbum("synthetic-album"); };
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  assertMirrors(canonical, store);
});

test("a stale heartbeat never triggers a rebuild of a replica that is already ahead of it", async () => {
  const { canonical, ids, store } = await seeded();
  const sync = createHostedReplicaSync({ client: canonical.client(), store });
  const staleHeartbeat = canonical.revision;
  await canonical.putRecipe(editRequest(canonical, ids.k1, { exposure: 0.3 }), "save-1");
  await sync.sync({ canonicalRevision: canonical.revision, signal });
  store.applied.length = 0;
  for (let index = 0; index < 2; index++) {
    const result = await sync.sync({ canonicalRevision: staleHeartbeat, signal });
    assert.equal(result.mode, "unchanged");
    assert.equal(result.replicaRevision, canonical.revision);
  }
  assert.equal(store.applied.length, 0);
  assert.deepEqual(sync.status(), { canonicalRevision: canonical.revision, replicaRevision: canonical.revision, state: "current" });
});

test("malformed pages are rejected without touching the replica", async () => {
  const { canonical, store } = await seeded();
  await createHostedReplicaSync({ client: canonical.client(), store }).sync({ canonicalRevision: canonical.revision, signal });
  const durable = store.snapshot();
  const since = durable.revision;
  const upsert = (revision) => ({ revision, op: "upsert", entity: "exclusion", id: "synthetic-photo", body: { excludedAt: "2026-11-07T00:00:00.000Z" } });
  const pages = {
    wrongSince: { sinceRevision: since - 1, changes: [], nextRevision: since + 1, complete: true, cursor: null },
    oldChange: { sinceRevision: since, changes: [upsert(since)], nextRevision: since + 1, complete: true, cursor: null },
    reversed: { sinceRevision: since, changes: [upsert(since + 2), upsert(since + 1)], nextRevision: since + 2, complete: true, cursor: null },
    duplicate: { sinceRevision: since, changes: [upsert(since + 1), upsert(since + 1)], nextRevision: since + 1, complete: true, cursor: null },
    beyondNext: { sinceRevision: since, changes: [upsert(since + 3)], nextRevision: since + 2, complete: true, cursor: null },
    stalled: { sinceRevision: since, changes: [], nextRevision: since, complete: false, cursor: null },
    cursorOnDiff: { sinceRevision: since, changes: [], nextRevision: since + 1, complete: true, cursor: "synthetic" },
  };
  for (const [name, page] of Object.entries(pages)) {
    const client = { request: async (operation) => (operation === "connector.pullReplica" ? page : { value: {}, replayed: false }) };
    const sync = createHostedReplicaSync({ client, store });
    await assert.rejects(sync.sync({ canonicalRevision: since + 2, signal }), { code: "invalid_response" }, name);
    assert.deepEqual(store.snapshot(), durable, name);
  }
});
