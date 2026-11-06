import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PHOTO_ERROR_STATUS, PHOTO_LIBRARY_CONTRACT_VERSION, PHOTO_LIMITS } from "../../photo-library-contract/src/v2.ts";
import { library as personalLibrary, maskedPhoto } from "../../photo-library-contract/fixtures/v2.ts";
import {
  ALBUM_ACTIONS, ALBUM_ITEM_KINDS, ALBUM_ITEM_PENDING_REASONS, ALBUM_ITEM_PENDING_TRANSITIONS, ALBUM_ITEM_STATES,
  ALBUM_ITEM_TRANSITIONS, ALBUM_PERMISSIONS, ALBUM_ROLES,
  CONNECTOR_OPERATION_ACCESS, CONNECTOR_REQUEST_SHAPES, DEFAULT_LIBRARY_KIND, FULL_RESOLUTION_EXPORT_TRANSITIONS, HOST_CONNECTOR_STATES,
  HOST_CONNECTOR_TRANSITIONS, LIBRARY_KINDS, MEMBERSHIP_TRANSITIONS, MEMBER_ROLES, PHOTO_LIBRARY_SHARING_CONTRACT_VERSION,
  RENDER_JOB_TRANSITIONS, RENDITION_METADATA_FIELDS, SHARING_ERROR_RECOVERY, SHARING_ERROR_STATUS, SHARING_LIMITS,
  SHARING_OPERATION_ACCESS, SHARING_REQUEST_SHAPES,
} from "../src/v1.ts";
import {
  checkAlbumName, checkCursor, compareIdempotency, decideReplicaPull, compareRenderBinding, decideAddPhoto, decideAlbumAction, decideHostedRecipeSave,
  decideJoin, decideLibraryAccess, decideMembershipChange, decidePairingApproval, decideRenderCommit, decideReplaceStart,
  decideUploadCommit, decideUploadRenew, findDisallowedRenditionMetadata, findForbiddenMetadata, itemStateAfterAdderRevoked, findUnexpectedConnectorFields, findUnexpectedRequestFields, inviteLinkStatus,
  nextAlbumItemState, nextPendingReason, nextRenderJobState,
  projectAlbumItem, quotaExceededError, sanitizeRenditionMetadata,
} from "../src/policy.ts";
import {
  PERSONAL_V2_COMPATIBILITY, PersonalV2CompatibilityError, nihoCloudLibraryFromPersonalV2, personalV2ScopeFor,
  renderBindingFromPersonalV2,
} from "../src/compat-v2.ts";
import * as fixtures from "../fixtures/v1.ts";

const load = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
const vectors = await load("fixtures/security-cases.json");
const coverage = await load("operation-coverage.json");
const userOperations = Object.keys(SHARING_OPERATION_ACCESS);
const connectorOperations = Object.keys(CONNECTOR_OPERATION_ACCESS);
const STREAM_OPERATIONS = ["hostedPhotos.content", "exports.content", "portability.content", "albumItems.download", "connector.getReplicaContent"];
const CREATE_OPERATIONS = new Set(["albums.create", "albumItems.addPhoto", "albumItems.addFile", "invites.create", "connectors.approvePairing"]);

test("UI vocabulary is exactly the identifiers agreed with the B08 session", () => {
  assert.equal(PHOTO_LIBRARY_SHARING_CONTRACT_VERSION, 1);
  assert.deepEqual(LIBRARY_KINDS, ["nihoCloud", "hostedMac", "thisMac"]);
  assert.equal(DEFAULT_LIBRARY_KIND, "nihoCloud");
  assert.deepEqual(ALBUM_ROLES, ["owner", "contributor", "viewer"]);
  assert.deepEqual(MEMBER_ROLES, ["contributor", "viewer"]);
  assert.deepEqual(ALBUM_ITEM_KINDS, ["ownerPhoto", "memberEdit", "fileUpload"]);
  assert.deepEqual(ALBUM_ITEM_STATES, ["preparing", "published", "updatePending", "removed"]);
  assert.deepEqual(HOST_CONNECTOR_STATES, ["online", "sleeping", "unreachable"]);
  assert.deepEqual(ALBUM_ITEM_PENDING_REASONS, ["rendering", "waitingForHost", "waitingForDevice", "sourceChanged", "quotaExceeded"]);
  assert.equal(SHARING_LIMITS.albumNameMaxCodePoints, 100);
  assert.deepEqual(Object.keys(fixtures.albumForViewer.owner).sort(), ["displayName", "isSelf"]);
  for (const key of ["role", "expiresAt", "revoked"]) assert(key in fixtures.inviteLink, key);
  assert.equal(SHARING_LIMITS.inviteLinkLifetimeSeconds, 7 * 24 * 60 * 60);
  assert.equal(Date.parse(fixtures.inviteLink.expiresAt) - Date.parse(fixtures.inviteLink.createdAt), SHARING_LIMITS.inviteLinkLifetimeSeconds * 1000);
});

test("permission table matches Epic §10 row by row", () => {
  const rows = {
    view: [true, true, true],
    download: [true, true, true],
    addItem: [true, true, false],
    replaceOwnItem: [true, true, false],
    removeOwnItem: [true, true, false],
    removeOthersItem: [true, false, false],
    editOthersPhoto: [false, false, false],
    readOthersSource: [false, false, false],
    manageInvites: [true, false, false],
    changeRole: [true, false, false],
    removeMember: [true, false, false],
    renameAlbum: [true, false, false],
    deleteAlbum: [true, false, false],
    leave: [false, true, true],
  };
  assert.deepEqual(Object.keys(rows).sort(), [...ALBUM_ACTIONS].sort());
  for (const [action, expected] of Object.entries(rows)) {
    assert.deepEqual(ALBUM_ROLES.map((role) => ALBUM_PERMISSIONS[role][action]), expected, action);
  }
  for (const album of [fixtures.albumForOwner, fixtures.albumForContributor, fixtures.albumForViewer]) {
    assert.deepEqual(album.access.permissions, ALBUM_PERMISSIONS[album.access.role]);
  }
});

test("every operation has one access rule, closed request keys, an owner Issue and a typed fixture", () => {
  assert.equal(coverage.contractVersion, 1);
  assert.equal(coverage.productionAcceptance, "not-performed");
  assert.deepEqual(Object.keys(coverage.operations).sort(), [...userOperations, ...connectorOperations].sort());
  for (const [operation, row] of Object.entries(coverage.operations)) {
    assert([242, 244, 246, 248, 254].includes(row.issue), operation);
    assert.equal(row.backend, "missing", operation);
    assert.equal(row.wiring, "not-connected", operation);
    assert(row.evidence.length > 10, operation);
  }
  assert.deepEqual(Object.keys(SHARING_REQUEST_SHAPES).sort(), [...userOperations].sort());
  assert.deepEqual(Object.keys(CONNECTOR_REQUEST_SHAPES).sort(), [...connectorOperations].sort());
  assert.equal(SHARING_OPERATION_ACCESS["albumItems.addPhoto"].requiresOwnSource, true);
  assert.deepEqual(Object.keys(fixtures.responses).sort(), userOperations.filter((op) => !STREAM_OPERATIONS.includes(op)).sort());
  assert.deepEqual(Object.keys(fixtures.connectorResponses).sort(), connectorOperations.filter((op) => !STREAM_OPERATIONS.includes(op)).sort());
  for (const [operation, access] of Object.entries(SHARING_OPERATION_ACCESS)) {
    if (access.scope === "album") assert(access.action === "removeItem" || ALBUM_ACTIONS.includes(access.action), operation);
  }
  for (const value of Object.values(CONNECTOR_OPERATION_ACCESS)) assert.notEqual(value.actor, "user");
});

test("state machines are closed, removed items and finished jobs are terminal", () => {
  const tables = [
    [ALBUM_ITEM_TRANSITIONS, ALBUM_ITEM_STATES],
    [RENDER_JOB_TRANSITIONS, ["queued", "waitingForHost", "claimed", "committed", "failed", "superseded", "cancelled"]],
    [MEMBERSHIP_TRANSITIONS, ["active", "left", "removed"]],
    [HOST_CONNECTOR_TRANSITIONS, HOST_CONNECTOR_STATES],
    [FULL_RESOLUTION_EXPORT_TRANSITIONS, ["waitingForHost", "rendering", "ready", "failed", "expired"]],
    [ALBUM_ITEM_PENDING_TRANSITIONS, ALBUM_ITEM_PENDING_REASONS],
  ];
  for (const [table, states] of tables) {
    assert.deepEqual(Object.keys(table).sort(), [...states].sort());
    for (const row of Object.values(table)) for (const next of Object.values(row)) assert(states.includes(next));
  }
  assert.deepEqual(ALBUM_ITEM_TRANSITIONS.removed, {});
  for (const event of ["renditionCommitted", "sourceUpdated", "remove"]) assert.equal(nextAlbumItemState("removed", event), null);
  assert.equal(nextAlbumItemState("preparing", "sourceUpdated"), null);
  assert.equal(nextAlbumItemState("updatePending", "renditionCommitted"), "published");
  for (const state of ["committed", "superseded", "cancelled"]) assert.deepEqual(RENDER_JOB_TRANSITIONS[state], {});
  assert.equal(nextRenderJobState("superseded", "commit"), null);
  assert.equal(nextRenderJobState("claimed", "leaseExpired"), "queued");
  assert.equal(MEMBERSHIP_TRANSITIONS.active.leave, "left");
  // 準備中（容量不足）: only freed capacity (or a changed source) ends the wait.
  assert.equal(nextPendingReason("rendering", "quotaExceeded"), "quotaExceeded");
  assert.equal(nextPendingReason("quotaExceeded", "quotaFreed"), "rendering");
  assert.equal(nextPendingReason("quotaExceeded", "hostOnline"), null);
  assert.equal(nextPendingReason("quotaExceeded", "deviceOnline"), null);
  assert.equal(nextPendingReason("quotaExceeded", "sourceChanged"), "sourceChanged");
  assert.equal(nextPendingReason("waitingForHost", "quotaFreed"), null);
});

test("per-viewer projection hides preparing items, sources and storage state", () => {
  const { snapshots, ownerView, contributorView, viewerView, USERS } = fixtures;
  const views = [
    [{ userId: USERS.owner, role: "owner" }, ownerView],
    [{ userId: USERS.contributor, role: "contributor" }, contributorView],
    [{ userId: USERS.viewer, role: "viewer" }, viewerView],
  ];
  for (const [viewer, expected] of views) {
    assert.deepEqual(Object.keys(expected).sort(), ["memberItem", "ownerItem", "preparingItem", "quotaPreparingItem", "quotaUpdateItem"]);
    for (const key of Object.keys(expected)) {
      assert.deepEqual(projectAlbumItem(snapshots[key], viewer), expected[key], `${viewer.role}:${key}`);
    }
  }
  assert.equal(ownerView.ownerItem.addedBy.isSelf, true);
  assert.equal(ownerView.memberItem.addedBy.isSelf, false);
  assert.equal(contributorView.memberItem.addedBy.isSelf, true);
  const forbidden = ["renditionBinding", "recipe", "libraryKind", "storage", "connector", "fileName", "path"];
  for (const view of [contributorView, viewerView]) {
    const json = JSON.stringify(view);
    for (const key of forbidden) assert(!json.includes(`"${key}"`), key);
  }
  assert(!JSON.stringify(viewerView).includes(fixtures.IDS.hostedLibrary));
  assert(!JSON.stringify(fixtures.albumForViewer).includes(fixtures.IDS.hostedLibrary));
  // No response carries a user ID of another member; people are display names, isSelf and membership IDs.
  const memberFacing = JSON.stringify([
    ownerView, contributorView, viewerView, fixtures.albumForOwner, fixtures.albumForViewer, fixtures.albumForContributor,
    fixtures.removedItem, fixtures.responses["albums.list"], fixtures.responses["albumItems.list"], fixtures.responses["members.list"],
    fixtures.responses["invites.list"], fixtures.responses["invites.join"], fixtures.responses["members.changeRole"],
    fixtures.responses["members.remove"], fixtures.responses["members.leave"], fixtures.responses["invites.create"],
  ]);
  for (const userId of Object.values(USERS)) assert(!memberFacing.includes(userId), userId);
  assert(!memberFacing.includes('"userId"'));
});

test("renditions carry only the metadata allow-list", () => {
  assert.deepEqual(Object.keys(fixtures.renditionMetadata).sort(), [...RENDITION_METADATA_FIELDS].sort());
  for (const rendition of [fixtures.rendition, fixtures.memberRendition, fixtures.fileRendition]) {
    assert.deepEqual(findForbiddenMetadata(rendition.metadata), []);
  }
  const memberFacing = {
    albumForViewer: fixtures.albumForViewer, albumForContributor: fixtures.albumForContributor, viewerView: fixtures.viewerView,
    contributorView: fixtures.contributorView, items: fixtures.responses["albumItems.list"], members: fixtures.responses["members.list"],
    joined: fixtures.responses["invites.join"], removed: fixtures.removedItem,
  };
  assert.deepEqual(findForbiddenMetadata(memberFacing), []);
  const decoded = {
    capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00", colorProfile: "displayP3",
    GPSLatitude: 35.3, BodySerialNumber: "synthetic", LensSerialNumber: "synthetic", DocumentName: "synthetic",
    Make: "synthetic", Model: "synthetic", nested: { xmpMM: { DerivedFrom: "synthetic" } }, CameraOwnerName: "synthetic",
  };
  assert.deepEqual(sanitizeRenditionMetadata(decoded), {
    capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00", colorProfile: "displayP3", orientation: 1,
  });
  const categories = findForbiddenMetadata(decoded).map((hit) => `${hit.category}:${hit.key}`).sort();
  assert.deepEqual(categories, [
    "location:GPSLatitude", "path:DocumentName", "path:nested.xmpMM.DerivedFrom", "serial:BodySerialNumber",
    "serial:CameraOwnerName", "serial:LensSerialNumber",
  ]);
  assert.deepEqual(sanitizeRenditionMetadata({ capturedAt: "2026:11:01 09:30:00", capturedAtOffset: "+09:00" }), {
    capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1,
  });
  assert.deepEqual(findForbiddenMetadata(sanitizeRenditionMetadata(decoded)), []);
  // 確定は許可した項目だけ: 位置・シリアル・パス以外の項目も拒否し、作り直した metadata は通す
  const disallowed = findDisallowedRenditionMetadata(decoded).map((hit) => `${hit.category}:${hit.key}`).sort();
  assert.deepEqual(disallowed, [
    "location:GPSLatitude", "notAllowed:Make", "notAllowed:Model", "path:DocumentName", "path:nested.xmpMM.DerivedFrom",
    "serial:BodySerialNumber", "serial:CameraOwnerName", "serial:LensSerialNumber",
  ]);
  assert.deepEqual(findDisallowedRenditionMetadata(sanitizeRenditionMetadata(decoded)), []);
  assert.deepEqual(findDisallowedRenditionMetadata(fixtures.renditionMetadata), []);
  for (const bad of [{ orientation: 6 }, { colorProfile: "AdobeRGB" }, { capturedAt: "2026:11:01 09:30:00" }, { Software: "synthetic" }, { capturedAt: { nested: true } }]) {
    assert.equal(findDisallowedRenditionMetadata(bad).length, 1, JSON.stringify(bad));
  }
});

test("an adder who loses the right to add drops additions in progress and reverts pending replacements", () => {
  const item = (state, adder) => ({ state, addedBy: fixtures.PEOPLE[adder] });
  const revoked = fixtures.USERS.contributor;
  assert.equal(itemStateAfterAdderRevoked(item("preparing", "contributor"), revoked), "removed");
  assert.equal(itemStateAfterAdderRevoked(item("updatePending", "contributor"), revoked), "published");
  assert.equal(itemStateAfterAdderRevoked(item("published", "contributor"), revoked), "published");
  assert.equal(itemStateAfterAdderRevoked(item("removed", "contributor"), revoked), "removed");
  assert.equal(itemStateAfterAdderRevoked(item("preparing", "owner"), revoked), "preparing", "other people's items do not change");
  for (const [state, next] of Object.entries(ALBUM_ITEM_TRANSITIONS)) {
    if (state !== "removed") assert.ok("adderRevoked" in next, state);
  }
});

test("the personal v2 contract stays unchanged and only maps one way", () => {
  const before = structuredClone(personalLibrary);
  const projected = nihoCloudLibraryFromPersonalV2(personalLibrary);
  assert.deepEqual(personalLibrary, before);
  assert.equal(PHOTO_LIBRARY_CONTRACT_VERSION, 2);
  assert.equal(PHOTO_LIMITS.quotaBytes, 5 * 1024 ** 3);
  assert.equal(personalLibrary.capabilities.albums, false);
  assert.equal(personalLibrary.capabilities.publicSharing, false);
  assert.deepEqual(projected, {
    contractVersion: 1, kind: "nihoCloud", id: personalLibrary.id, owner: { type: "user", userId: personalLibrary.owner.userId },
    lifecycle: "active", metadataRevision: personalLibrary.revision, metadataAuthority: "niho", originals: "niho", port: "personalCloudV2",
  });
  assert(!("usage" in projected));
  assert.equal(PERSONAL_V2_COMPATIBILITY.personalQuotaScope, "nihoCloudOriginalsAndMasks");
  assert.notEqual(fixtures.sharedStorage.quotaBytes, PHOTO_LIMITS.quotaBytes);
  assert.throws(() => nihoCloudLibraryFromPersonalV2({ ...personalLibrary, capabilities: { ...personalLibrary.capabilities, albums: true } }), PersonalV2CompatibilityError);
  assert.throws(() => nihoCloudLibraryFromPersonalV2({ ...personalLibrary, contractVersion: 3 }), PersonalV2CompatibilityError);

  const actor = { userId: fixtures.USERS.owner, sessionId: "synthetic-session", sessionEpoch: "synthetic-epoch", transport: "browser-session", expiresAt: fixtures.LATER };
  assert.deepEqual(personalV2ScopeFor(projected, actor), { actorId: actor.userId, libraryId: personalLibrary.id, sessionEpoch: "synthetic-epoch" });
  assert.equal(personalV2ScopeFor(projected, { ...actor, userId: fixtures.USERS.contributor }), null);
  assert.equal(personalV2ScopeFor(fixtures.hostedLibrary, actor), null);
  assert.equal(personalV2ScopeFor({ contractVersion: 1, kind: "thisMac", id: "device", metadataAuthority: "device", originals: "device", port: "localDevice" }, actor), null);
  assert.equal(personalV2ScopeFor({ ...projected, lifecycle: "deleting" }, actor), null);

  const bound = renderBindingFromPersonalV2(maskedPhoto, personalLibrary.capabilities.renderer);
  assert.deepEqual(bound, {
    sourceGeneration: 1, sourceSha256: maskedPhoto.original.sha256, recipeRevision: maskedPhoto.recipe.revision,
    settingsSha256: maskedPhoto.recipe.settingsSha256, engine: maskedPhoto.recipe.settings.engine,
    rendererManifestSha256: personalLibrary.capabilities.renderer.manifestSha256, maskSurfaceIds: maskedPhoto.recipe.maskSurfaceIds,
  });
  assert.throws(() => renderBindingFromPersonalV2(maskedPhoto, { ...personalLibrary.capabilities.renderer, engines: ["niho-1"] }), PersonalV2CompatibilityError);
});

test("shared storage is a separate owner pool with exact arithmetic", () => {
  const usage = fixtures.sharedStorage;
  for (const value of Object.values(usage)) if (typeof value === "number") assert(Number.isSafeInteger(value) && value >= 0);
  assert.equal(usage.usedBytes, usage.previewBytes + usage.maskBytes + usage.renditionBytes + usage.exportStagingBytes);
  assert.equal(usage.availableBytes, usage.quotaBytes - usage.usedBytes - usage.reservedBytes);
  assert.equal(usage.owner.userId, fixtures.USERS.owner);
  const need = { availableBytes: 0, requiredBytes: 8 * 1024 ** 2 };
  assert.deepEqual(quotaExceededError("member", "synthetic-request", need), fixtures.memberQuotaError.error);
  assert.deepEqual(quotaExceededError("owner", "synthetic-request", need), fixtures.ownerQuotaError.error);
});

test("generation ordering never accepts an equal-revision binding with different inputs", () => {
  assert.equal(compareRenderBinding(fixtures.nextBinding, fixtures.binding), "newer");
  assert.equal(compareRenderBinding(fixtures.binding, fixtures.nextBinding), "older");
  assert.equal(compareRenderBinding(fixtures.binding, { ...fixtures.binding }), "same");
  assert.equal(compareRenderBinding({ ...fixtures.binding, rendererManifestSha256: "0".repeat(64) }, fixtures.binding), "different");
  assert.equal(compareRenderBinding({ ...fixtures.binding, sourceGeneration: 2, recipeRevision: 0 }, fixtures.binding), "newer");
  assert.equal(inviteLinkStatus(fixtures.inviteLink, fixtures.TIME), "usable");
  assert.equal(inviteLinkStatus(fixtures.inviteLink, fixtures.INVITE_EXPIRES), "expired");
  assert.equal(inviteLinkStatus(fixtures.revokedInviteLink, fixtures.TIME), "revoked");
});

test("closed requests reject unexpected fields at any depth", () => {
  const rendition = {
    sizeBytes: 1, sha256: "a".repeat(64), contentType: "image/jpeg", width: 1, height: 1,
    metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 },
  };
  assert.deepEqual(findUnexpectedRequestFields("albumItems.addFile", { albumId: "a", rendition }), []);
  assert.deepEqual(findUnexpectedRequestFields("albumItems.addFile", { albumId: "a", rendition: { ...rendition, metadata: { ...rendition.metadata, GPSLatitude: 1 } } }), ["rendition.metadata.GPSLatitude"]);
  assert.deepEqual(findUnexpectedRequestFields("albumItems.addPhoto", { albumId: "a", source: { kind: "libraryPhoto", libraryId: "l", photoId: "p", ownerId: "u" } }), ["source.ownerId"]);
  assert.deepEqual(findUnexpectedRequestFields("albumItems.addPhoto", { albumId: "a", source: { kind: "unknown" } }), ["source.kind"]);
  assert.deepEqual(findUnexpectedRequestFields("albumItems.addPhoto", { albumId: "a", source: { kind: "devicePhoto", deviceSourceRef: "d", binding: { ...fixtures.binding, maskSurfaceIds: [{ path: "x" }] }, rendition } }), ["source.binding.maskSurfaceIds[0]"]);
  assert.deepEqual(findUnexpectedRequestFields("albums.get", JSON.parse('{"albumId":"a","__proto__":{"role":"owner"}}')), ["__proto__"]);
  assert.deepEqual(findUnexpectedRequestFields("albums.get", { albumId: { nested: true } }), ["albumId"]);
  // Recipe settings stay open JSON for the #196 validator; unknown fields are preserved, not rejected here.
  assert.deepEqual(findUnexpectedRequestFields("hostedRecipes.put", {
    libraryId: "l", photoId: "p", expectedRevision: 1, sourceGeneration: 1, baseVersion: null,
    settings: { v: 99, engine: "synthetic-future-engine", futureField: { keep: [1] } },
  }), []);
  assert.deepEqual(findUnexpectedConnectorFields("renderJobs.startOutput", { jobId: "j", leaseToken: "t", output: { kind: "preview", sizeBytes: 1, sha256: "a", contentType: "image/jpeg", width: 1, height: 1, metadata: {} } }), ["output.metadata"]);
  let deep = { leaf: 1 };
  for (let index = 0; index < 40; index++) deep = { nested: deep };
  assert(findForbiddenMetadata(deep).some((hit) => hit.category === "unverifiable"));
});

test("commit decisions bind the executor, the job's verified upload and the latest replace intent", () => {
  const job = fixtures.renderJob;
  const base = {
    job, actor: job.executor, claimedGeneration: 1, executor: { lifecycle: "active", credentialGeneration: 1 },
    upload: { jobId: job.id, kind: "rendition", state: "uploaded", width: 6000, height: 4000 }, bytesMetadata: fixtures.renditionMetadata,
    desired: job.binding, now: fixtures.TIME,
    item: { state: "updatePending", revision: job.purpose.itemRevision, adder: { userId: fixtures.USERS.owner, membership: fixtures.memberships.owner } },
  };
  assert.deepEqual(decideRenderCommit(base), { ok: true });
  assert.deepEqual(decideRenderCommit({ ...base, actor: { kind: "userDevice", userId: fixtures.USERS.owner } }), { ok: false, code: "not_found" });
  assert.deepEqual(decideRenderCommit({ ...base, upload: null }), { ok: false, code: "not_found" });
  assert.deepEqual(decideRenderCommit({ ...base, desired: fixtures.binding }), { ok: false, code: "stale_render" });
  // Only the full-resolution size NIHO expects is published; a superseded output never commits.
  assert.deepEqual(decideRenderCommit({ ...base, upload: { ...base.upload, width: 3000, height: 2000 } }), { ok: false, code: "content_rejected" });
  assert.deepEqual(decideRenderCommit({ ...base, upload: { ...base.upload, width: undefined, height: undefined } }), { ok: false, code: "content_rejected" });
  assert.deepEqual(decideRenderCommit({ ...base, upload: { ...base.upload, state: "superseded" } }), { ok: false, code: "stale_render" });

  const viewer = { userId: fixtures.USERS.contributor, membership: fixtures.memberships.contributor };
  const item = { ...fixtures.snapshots.memberItem, addedBy: fixtures.PEOPLE.contributor, inRequestedAlbum: true };
  const newer = { ...fixtures.snapshots.memberItem.renditionBinding, recipeRevision: 3 };
  const newest = { ...newer, recipeRevision: 4 };
  const content = (binding) => ({ kind: "deviceRender", binding, rendition: {} });
  assert.deepEqual(decideReplaceStart(viewer, { ...item, addedBy: viewer.userId }, { expectedRevision: 1, content: content(newer) }), { ok: true });
  const pending = { ...item, addedBy: viewer.userId, pendingUpload: { uploadId: "u-newest", binding: newest } };
  assert.deepEqual(decideReplaceStart(viewer, pending, { expectedRevision: 1, content: content(newer) }), { ok: false, code: "stale_render" });
  const commit = (uploadId) => decideUploadCommit({
    viewer, item: { ...fixtures.snapshots.memberItem, pendingUpload: { uploadId: "u-newest", binding: newest } },
    upload: { id: uploadId, targetItemRevision: 2, expiresAt: fixtures.LATER, state: "reserved", sizeBytes: 8, uploadedBytes: 8 }, bytesMetadata: {}, now: fixtures.TIME,
  });
  assert.deepEqual(commit("u-older"), { ok: false, code: "stale_render" });
  assert.deepEqual(commit("u-newest"), { ok: true });

  assert.deepEqual(decideAddPhoto(viewer, { kind: "libraryPhoto" }, { ownerId: fixtures.USERS.owner, lifecycle: "active" }), { ok: false, code: "not_found" });
  assert.deepEqual(decideAddPhoto(viewer, { kind: "libraryPhoto" }, { ownerId: viewer.userId, lifecycle: "active" }), { ok: true });
  assert.deepEqual(decideAddPhoto({ userId: fixtures.USERS.viewer, membership: fixtures.memberships.viewer }, { kind: "libraryPhoto" }, { ownerId: fixtures.USERS.viewer, lifecycle: "active" }), { ok: false, code: "role_forbidden" });
});

test("error codes have one status and one recovery each", () => {
  assert.deepEqual(Object.keys(SHARING_ERROR_RECOVERY).sort(), Object.keys(SHARING_ERROR_STATUS).sort());
  for (const status of Object.values(SHARING_ERROR_STATUS)) assert(status >= 400 && status < 600);
  for (const code of ["not_found", "item_removed", "invite_unavailable"]) assert.notEqual(SHARING_ERROR_RECOVERY[code], "retrySameKey");
  assert.equal(SHARING_ERROR_RECOVERY.stale_render, "discardResult");
  assert.equal(SHARING_ERROR_RECOVERY.temporarily_unavailable, "retrySameKey");
  // v2 と同じ意味のコードは同じ名前・同じ status
  assert.equal(SHARING_ERROR_STATUS.upload_state_conflict, PHOTO_ERROR_STATUS.upload_state_conflict);
  assert.equal(SHARING_ERROR_STATUS.upload_expired, PHOTO_ERROR_STATUS.upload_expired);
});

// ---------------------------------------------------------------------------------------------------------
// Conformance vectors evaluated through the reference policy.

const actorId = (label) => vectors.actors[label] ?? null;
const unexpected = (operation, request) => operation in SHARING_REQUEST_SHAPES
  ? findUnexpectedRequestFields(operation, request)
  : findUnexpectedConnectorFields(operation, request);
const success = (operation, created) => ({ status: created ? 201 : 200 });
const fromDecision = (decision, operation) => decision.ok ? success(operation, CREATE_OPERATIONS.has(operation)) : { status: SHARING_ERROR_STATUS[decision.code], code: decision.code };

function evaluate(vector) {
  const { arrange, operation, request } = vector;
  const userId = actorId(vector.actor);
  switch (vector.check) {
    case "session":
      return fromDecision(userId ? { ok: true } : { ok: false, code: "unauthenticated" }, operation);
    case "addPhoto":
      return fromDecision(decideAddPhoto({ userId, membership: arrange.membership }, request.source, arrange.library), operation);
    case "replaceStart":
      return fromDecision(decideReplaceStart({ userId, membership: arrange.membership }, arrange.item, request), operation);
    case "albumAction":
      return fromDecision(decideAlbumAction({ userId, membership: arrange.membership }, SHARING_OPERATION_ACCESS[operation].action, arrange.target), operation);
    case "membershipChange": {
      const change = { "members.changeRole": "changeRole", "members.remove": "removeMember", "members.leave": "leave" }[operation];
      return fromDecision(decideMembershipChange({ userId, membership: arrange.membership }, change, arrange.target), operation);
    }
    case "libraryAccess":
      return fromDecision(decideLibraryAccess(userId, arrange.library), operation);
    case "pairing":
      return fromDecision(decidePairingApproval({ actorId: userId, pairing: arrange.pairing, target: request.target, targetOwnerId: arrange.targetOwnerId, now: arrange.now }), operation);
    case "join": {
      const decision = decideJoin({ actorId: userId, link: arrange.link, album: arrange.album, existing: arrange.existing, lastRemovedAt: arrange.lastRemovedAt, now: arrange.now });
      return decision.ok ? success(operation, decision.joined) : fromDecision(decision, operation);
    }
    case "cursor":
      return fromDecision(checkCursor(arrange.cursor, arrange.current, arrange.now), operation);
    case "idempotency": {
      const result = compareIdempotency(arrange.stored, arrange.incoming);
      if (result === "conflict") return fromDecision({ ok: false, code: "idempotency_conflict" }, operation);
      return success(operation, result === "new" && CREATE_OPERATIONS.has(operation));
    }
    case "renderCommit":
      return fromDecision(decideRenderCommit(arrange), operation);
    case "uploadCommit":
      return fromDecision(decideUploadCommit(arrange), operation);
    case "uploadRenew":
      return fromDecision(decideUploadRenew(arrange), operation);
    case "adderRevoked":
      return { status: 200, itemState: itemStateAfterAdderRevoked(arrange.item, actorId(arrange.revoked)) };
    case "revision":
      return fromDecision(arrange.expectedRevision === arrange.currentRevision ? { ok: true } : { ok: false, code: "revision_conflict" }, operation);
    case "hostedSave": {
      const decision = decideHostedRecipeSave(arrange);
      return decision.ok
        ? { ...success(operation, CREATE_OPERATIONS.has(operation)), replica: decision.replica }
        : fromDecision(decision, operation);
    }
    case "visibility": {
      const projected = projectAlbumItem(fixtures.snapshots[arrange.snapshot], { userId, role: arrange.role });
      return fromDecision(projected ? { ok: true } : { ok: false, code: "not_found" }, operation);
    }
    case "replicaPull":
      return fromDecision(decideReplicaPull({ sinceRevision: request.sinceRevision, ...arrange }), operation);
    case "albumName":
      return fromDecision(checkAlbumName(request.name), operation);
    case "closedRequest":
      return fromDecision(unexpected(operation, request).length ? { ok: false, code: "invalid_request" } : { ok: true }, operation);
    case "quota": {
      const error = quotaExceededError(arrange.audience, "synthetic-request", { availableBytes: arrange.availableBytes, requiredBytes: arrange.requiredBytes });
      assert.equal("storage" in error, arrange.audience === "owner", vector.id);
      return fromDecision({ ok: false, code: error.code }, operation);
    }
    default:
      throw new Error(`unknown check ${vector.check}`);
  }
}

test("every conformance vector matches the reference policy", () => {
  assert.equal(vectors.contractVersion, 1);
  assert.equal(vectors.syntheticOnly, true);
  const ids = vectors.cases.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const vector of vectors.cases) {
    assert(vector.operation in coverage.operations, vector.id);
    assert(vector.expected.invariants.length > 0, vector.id);
    if (vector.expected.code) assert.equal(SHARING_ERROR_STATUS[vector.expected.code], vector.expected.status, vector.id);
    if (vector.check !== "closedRequest") assert.deepEqual(unexpected(vector.operation, vector.request), [], vector.id);
    const actual = evaluate(vector);
    const expected = vector.expected.code
      ? { status: vector.expected.status, code: vector.expected.code }
      : {
        status: vector.expected.status,
        ...(vector.expected.replica ? { replica: vector.expected.replica } : {}),
        ...(vector.expected.itemState ? { itemState: vector.expected.itemState } : {}),
      };
    assert.deepEqual(actual, expected, vector.id);
  }
});

test("B00 negative categories are all present", () => {
  const ids = new Set(vectors.cases.map((item) => item.id));
  const required = {
    otherOwnerOrAlbum: ["foreign-album", "other-album-item", "member-reads-owner-library", "member-adds-owner-library-photo", "pairing-into-foreign-library", "member-edits-owner-photo", "job-other-executor", "job-upload-of-other-job"],
    viewerAdds: ["viewer-adds-photo", "viewer-adds-file"],
    othersItemRemoval: ["contributor-removes-others-item", "owner-replaces-member-item"],
    afterRevocation: ["removed-member-adds", "left-member-adds", "commit-after-removal", "commit-after-demotion", "job-after-adder-removed"],
    staleCursorJobRevision: ["cursor-after-role-change", "albums-cursor-after-membership-change", "cursor-expired", "stale-job-recipe", "superseded-job", "job-lease-expired", "rename-stale", "replace-stale-revision", "device-render-older", "superseded-replace-commit", "replace-start-older-than-pending", "hosted-save-old-source"],
    unknownResultResend: ["add-unknown-result-replay", "changed-payload-same-key", "join-unknown-result-replay", "invite-create-replay", "job-commit-replay", "pairing-start-replay"],
    inviteLinks: ["join-expired-link", "join-revoked-link", "join-unknown-secret", "join-unauthenticated", "join-removed-old-link", "join-old-link-after-rejoin-and-leave"],
    metadata: ["rendition-with-location", "rendition-with-serial", "rendition-with-path", "job-output-with-location", "location-in-rendition-request"],
    closedRequests: ["owner-in-request", "path-in-add-source", "unknown-source-kind", "path-in-index-entry"],
    quotaWait: ["quota-wait-visible-to-adder", "quota-wait-hidden-from-viewer", "quota-wait-reason-hidden-from-member", "member-album-full"],
    albumNames: ["album-name-101-code-points", "album-name-100-emoji", "album-name-blank"],
    hostedReplica: [
      "hosted-save-missing-mask", "hosted-save-online-unacknowledged", "hosted-save-acknowledged-replay",
      "replica-pull-compacted", "replica-pull-ahead-of-niho", "replica-pull-snapshot",
    ],
    renderOutputs: ["job-full-resolution-output", "job-downscaled-output", "job-superseded-output", "claim-unknown-result-replay"],
    adderRevoked: [
      "removed-adder-preparing-dropped", "demoted-adder-pending-replace-reverts", "left-adder-published-stays", "revoked-adder-other-item-unchanged",
      "renew-after-removal", "renew-after-demotion",
    ],
    metadataAllowList: ["rendition-with-camera-model", "rendition-with-software", "rendition-with-rotated-orientation", "job-output-with-lens", "rendition-allowed-only"],
    uploadState: ["commit-before-bytes", "job-commit-before-bytes", "renew-reserved-upload", "renew-committed-upload", "renew-expired-upload", "renew-older-upload"],
  };
  for (const [category, list] of Object.entries(required)) for (const id of list) assert(ids.has(id), `${category}:${id}`);
});
