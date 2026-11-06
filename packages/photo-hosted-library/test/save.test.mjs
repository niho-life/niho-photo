import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostedReplicaSync } from "../src/index.ts";
import { sha256Hex } from "../src/shared.ts";
import { assertMirrors, bytesOf, editRequest, indexEntry, maskSettings, seeded, signal } from "./helpers.mjs";

// The synthetic canonical store applies the B00 decisions (decideHostedRecipeSave, compareIdempotency). These tests pin
// the save semantics the private service must keep; resending reuses the #196 operation identity (same key, same body).

test("a save lost before commit is applied once when the same operation is resent", async () => {
  const { canonical, ids } = await seeded();
  const request = editRequest(canonical, ids.k1, { exposure: 0.4 });
  const before = canonical.revision;
  canonical.nextFault = "failBeforeCommit";
  await assert.rejects(canonical.putRecipe(request, "op-1"), (error) => !("code" in error));
  assert.equal(canonical.revision, before);
  assert.equal(canonical.recipeOf(ids.k1).revision, 0);
  const saved = await canonical.putRecipe(request, "op-1");
  assert.equal(saved.replayed, false);
  assert.equal(canonical.recipeOf(ids.k1).revision, 1);
});

test("a save whose response was lost is recovered by the same operation, not saved twice", async () => {
  const { canonical, ids, store } = await seeded();
  const request = editRequest(canonical, ids.k1, { exposure: 0.4 });
  canonical.nextFault = "dropResponseAfterCommit";
  await assert.rejects(canonical.putRecipe(request, "op-1"));
  const committed = canonical.revision;
  assert.equal(canonical.recipeOf(ids.k1).revision, 1, "the save was durable before the response was lost");
  const recovered = await canonical.putRecipe(request, "op-1");
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.value.recipe.revision, 1);
  assert.equal(canonical.revision, committed, "the replay wrote nothing");
  await assert.rejects(canonical.putRecipe({ ...request, settings: { ...request.settings, exposure: 0.9 } }, "op-1"), { code: "idempotency_conflict" });
  // A different edit with a new key but the old base is a conflict; it never hides the saved one.
  await assert.rejects(canonical.putRecipe({ ...request, settings: { ...request.settings, exposure: 0.9 } }, "op-2"), { code: "revision_conflict" });
  assert.equal(canonical.recipeOf(ids.k1).settings.exposure, 0.4);
  await createHostedReplicaSync({ client: canonical.client(), store }).sync({ canonicalRevision: canonical.revision, signal });
  assertMirrors(canonical, store);
});

test("nothing is saved until every referenced mask is stored in NIHO", async () => {
  const { canonical, ids, store } = await seeded();
  const mask = bytesOf("synthetic mask surface");
  const id = await sha256Hex(mask);
  const before = canonical.revision;
  await assert.rejects(canonical.putRecipe(editRequest(canonical, ids.k1, maskSettings(id)), "op-mask"), { code: "missing_mask_surface" });
  assert.equal(canonical.revision, before, "a recipe with a missing reference is not partially saved");
  assert.equal(canonical.recipeOf(ids.k1).revision, 0);

  await canonical.putMask(ids.k1, mask);
  const saved = await canonical.putRecipe(editRequest(canonical, ids.k1, maskSettings(id)), "op-mask-2");
  assert.deepEqual(saved.value.recipe.maskSurfaceIds, [id]);
  await createHostedReplicaSync({ client: canonical.client(), store }).sync({ canonicalRevision: canonical.revision, signal });
  assertMirrors(canonical, store);
  assert.deepEqual(await store.maskBytes(`${ids.k1}:${id}`), mask);
});

test("a recipe edited against an older source generation is a conflict after the original changes", async () => {
  const { canonical, ids } = await seeded();
  const stale = editRequest(canonical, ids.k1, { exposure: 0.2 });
  const changed = await canonical.putIndex([await indexEntry("k1", "synthetic original one, edited elsewhere")]);
  assert.equal(changed[0].state, "updated");
  assert.equal(canonical.photoOf(ids.k1).source.generation, 2);
  await assert.rejects(canonical.putRecipe(stale, "op-old-base"), { code: "revision_conflict" });
  const fresh = await canonical.putRecipe(editRequest(canonical, ids.k1, { exposure: 0.2 }), "op-new-base");
  assert.equal(fresh.value.recipe.revision, 1);
});

test("an original still arriving never overwrites or bumps the recorded identity", async () => {
  const { canonical, ids } = await seeded();
  const known = canonical.photoOf(ids.k1).source;
  const arriving = await canonical.putIndex([await indexEntry("k1", "partial", { hashed: false })]);
  assert.equal(arriving[0].state, "unchanged");
  assert.deepEqual(canonical.photoOf(ids.k1).source, known);

  const added = await canonical.putIndex([await indexEntry("k9", "synthetic new original", { hashed: false })]);
  const photoId = added[0].photoId;
  assert.equal(canonical.photoOf(photoId).source.sha256, null);
  const hashed = await canonical.putIndex([await indexEntry("k9", "synthetic new original")]);
  assert.equal(hashed[0].state, "updated");
  assert.equal(canonical.photoOf(photoId).source.generation, 1, "filling a lazy hash is the same generation");
});

test("late index entries and saves for an excluded photo never revive it", async () => {
  const { canonical, ids } = await seeded();
  canonical.exclude(ids.k2);
  const before = { revision: canonical.revision, photo: canonical.photoOf(ids.k2) };
  const late = await canonical.putIndex([await indexEntry("k2", "synthetic original two, rescanned")]);
  assert.equal(late[0].state, "excluded");
  assert.equal(canonical.revision, before.revision);
  assert.deepEqual(canonical.photoOf(ids.k2), before.photo);
  await assert.rejects(canonical.putRecipe(editRequest(canonical, ids.k2, { exposure: 1 }), "op-late"), { code: "not_found" });
});
