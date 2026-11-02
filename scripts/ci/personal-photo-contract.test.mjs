import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PHOTO_ERROR_STATUS, PHOTO_LIBRARY_CONTRACT_VERSION, PHOTO_LIMITS } from "../../packages/photo-library-contract/src/v2.ts";
import {
  emptyLibrary, fullLibrary, futureRecipePhoto, library, maskedPhoto, pendingMediaPhoto, recipe, recipeConflict, responses,
} from "../../packages/photo-library-contract/fixtures/v2.ts";

const load = async (name) => JSON.parse(await readFile(new URL(`../../packages/photo-library-contract/${name}`, import.meta.url), "utf8"));
const vectors = await load("fixtures/security-cases.json");
const coverage = await load("operation-coverage.json");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("Photo fixtures have one coverage entry per operation and do not claim a live connection", () => {
  assert.equal(PHOTO_LIBRARY_CONTRACT_VERSION, 2);
  assert.equal(vectors.contractVersion, 2);
  assert.equal(vectors.syntheticOnly, true);
  assert.equal(coverage.productionAcceptance, "not-performed");
  assert.deepEqual(Object.keys(coverage.operations).sort(), [...Object.keys(responses), "content.get"].sort());
  for (const row of Object.values(coverage.operations)) {
    assert.equal(row.photoWiring, "not-connected");
    assert(["implemented", "partial", "missing"].includes(row.backend));
    assert([195, 196, 197].includes(row.issue));
    assert(row.evidence.length > 20);
  }
  assert.equal(coverage.operations["library.get"].backend, "missing");
  assert.equal(coverage.operations["masks.get"].backend, "missing");
});

test("quota includes originals, masks, reservations and physical purge only once", () => {
  assert.equal(PHOTO_LIMITS.quotaBytes, 5_368_709_120);
  assert.equal(PHOTO_LIMITS.maxFileBytes, 209_715_200);
  assert.equal(PHOTO_LIMITS.reservationLifetimeSeconds, 1800);
  assert.equal(PHOTO_LIMITS.completionGraceSeconds, 3600);
  assert.equal(PHOTO_LIMITS.listMaxCount, 60);
  const pending = { ...library.usage, pendingPurgeBytes: library.usage.originalBytes };
  for (const usage of [library.usage, emptyLibrary.usage, fullLibrary.usage, pending]) {
    for (const value of Object.values(usage)) assert(Number.isSafeInteger(value) && value >= 0);
    assert.equal(usage.usedBytes, usage.originalBytes + usage.maskBytes);
    assert.equal(usage.availableBytes, usage.quotaBytes - usage.usedBytes - usage.reservedBytes);
    assert(usage.pendingPurgeBytes <= usage.usedBytes);
  }
  assert.equal(fullLibrary.usage.availableBytes, 0);
});

test("Photo deletion contract contains no trash, restore or queued-success substitution", () => {
  assert.deepEqual(responses["photos.delete"], { state: "purged" });
  for (const obsolete of ["photos.trash", "photos.restore", "photos.purge", "jobs.get"]) {
    assert(!(obsolete in responses));
    assert(!vectors.cases.some((item) => item.operation === obsolete));
  }
  const fail = vectors.cases.find((item) => item.id === "delete-physical-failure");
  assert.equal(fail.expected.code, "temporarily_unavailable");
  assert(fail.expected.invariants.includes("pending_purge_retains_quota"));
});

test("full recipes, mask references and conflicting branches survive fixtures unchanged", () => {
  assert.equal(digest(recipe.settings), recipe.settingsSha256);
  assert.equal(digest(recipeConflict.conflictingRecipe.settings), recipeConflict.conflictingRecipe.settingsSha256);
  assert.equal(digest(recipeConflict.currentRecipe.settings), recipeConflict.currentRecipe.settingsSha256);
  assert.equal(digest(futureRecipePhoto.recipe.settings), futureRecipePhoto.recipe.settingsSha256);
  assert.equal(maskedPhoto.recipe.maskSurfaceIds[0], maskedPhoto.recipe.settings.masks[0].surface.id);
  assert.equal(pendingMediaPhoto.storageState, "stored");
  assert.equal(pendingMediaPhoto.media.state, "pending");
  const mac = structuredClone(responses["photos.get"]);
  const iphone = structuredClone(responses["photos.get"]);
  mac.recipe.settings.exposure = 2;
  assert.equal(iphone.recipe.settings.exposure, 0);
});

test("adversarial expectations cover the changed product boundaries", async () => {
  const ids = vectors.cases.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of vectors.cases) {
    assert(item.operation in coverage.operations, item.id);
    assert(item.expected.invariants.length > 0, item.id);
    if (item.expected.code) assert.equal(PHOTO_ERROR_STATUS[item.expected.code], item.expected.status, item.id);
  }
  for (const id of ["owner-in-request", "foreign-photo", "foreign-original", "quota-concurrent-loser", "mask-quota-concurrent", "changed-idempotency-payload", "generation-race", "complete-after-expiry", "recipe-conflict-adopt", "recipe-conflict-keep-current", "missing-mask", "unknown-recipe", "same-actor-new-epoch", "delete-immediate", "delete-physical-failure", "complete-after-delete", "stale-media-after-delete", "cancel-original-stored"]) assert(ids.includes(id), id);
  const tooLarge = vectors.cases.find((item) => item.id === "file-limit");
  assert.equal(tooLarge.request.sizeBytes, PHOTO_LIMITS.maxFileBytes + 1);
  const provenance = await load("provenance.json");
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  for (const source of provenance.sources) assert.match(source.sha256, /^[a-f0-9]{64}$/);
});

test("critical conformance vectors retain their boundary inputs and observable outcomes", () => {
  const get = (id) => vectors.cases.find((item) => item.id === id);
  const boundary = get("quota-boundary");
  assert.equal(boundary.arrange.usedBytes + boundary.arrange.reservedBytes + boundary.request.sizeBytes, PHOTO_LIMITS.quotaBytes);
  assert.equal(boundary.expected.status, 201);
  const loser = get("quota-concurrent-loser");
  assert(loser.arrange.usedBytes + loser.arrange.reservedBytes + loser.request.sizeBytes > PHOTO_LIMITS.quotaBytes);
  assert.deepEqual(loser.expected, { status: 409, code: "quota_exceeded", invariants: ["one_reservation_wins", "no_negative_balance"] });
  assert.deepEqual(get("complete-after-delete").expected, { status: 404, code: "not_found", invariants: ["no_resurrection", "no_quota_release_twice"] });
  assert.notEqual(get("same-actor-new-epoch").arrange.capturedEpoch, get("same-actor-new-epoch").arrange.currentEpoch);
  assert.deepEqual(get("same-actor-new-epoch").expected, { status: 401, code: "unauthenticated", invariants: ["abort_old_transport", "discard_old_result", "isolate_drafts"] });
  const unknown = get("unknown-recipe");
  assert.deepEqual(unknown.request.settings.futureField, { keep: [1, "opaque"] });
  assert.deepEqual(unknown.expected, { status: 422, code: "unsupported_settings", invariants: ["opaque_read_preserved", "no_downgrade"] });
});
