import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PHOTO_LIBRARY_CONTRACT_VERSION, PHOTO_LIMITS } from "../../photo-library-contract/src/v2.ts";
import { library as personalLibrary, maskedPhoto } from "../../photo-library-contract/fixtures/v2.ts";
import {
  ALBUM_ACTIONS, ALBUM_ITEM_KINDS, ALBUM_ITEM_STATES, ALBUM_ITEM_TRANSITIONS, ALBUM_PERMISSIONS, ALBUM_ROLES,
  CONNECTOR_OPERATION_ACCESS, DEFAULT_LIBRARY_KIND, FULL_RESOLUTION_EXPORT_TRANSITIONS, HOST_CONNECTOR_STATES,
  HOST_CONNECTOR_TRANSITIONS, LIBRARY_KINDS, MEMBERSHIP_TRANSITIONS, MEMBER_ROLES, PHOTO_LIBRARY_SHARING_CONTRACT_VERSION,
  RENDER_JOB_TRANSITIONS, RENDITION_METADATA_FIELDS, SHARING_ERROR_RECOVERY, SHARING_ERROR_STATUS, SHARING_LIMITS,
  SHARING_OPERATION_ACCESS, SHARING_REQUEST_KEYS,
} from "../src/v1.ts";
import {
  checkCursor, compareIdempotency, compareRenderBinding, decideAlbumAction, decideHostedRecipeSave, decideJoin,
  decideLibraryAccess, decideMembershipChange, decidePairingApproval, decideRenderCommit, decideUploadCommit,
  findForbiddenMetadata, findUnexpectedRequestFields, inviteLinkStatus, nextAlbumItemState, nextRenderJobState,
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
const STREAM_OPERATIONS = ["hostedPhotos.content", "exports.content", "albumItems.download"];
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
  assert.deepEqual(Object.keys(SHARING_REQUEST_KEYS).sort(), [...userOperations].sort());
  assert.deepEqual(Object.keys(fixtures.responses).sort(), userOperations.filter((op) => !STREAM_OPERATIONS.includes(op)).sort());
  assert.deepEqual(Object.keys(fixtures.connectorResponses).sort(), [...connectorOperations].sort());
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
});

test("per-viewer projection hides preparing items, sources and storage state", () => {
  const { snapshots, ownerView, contributorView, viewerView, USERS } = fixtures;
  const views = [
    [{ userId: USERS.owner, role: "owner" }, ownerView],
    [{ userId: USERS.contributor, role: "contributor" }, contributorView],
    [{ userId: USERS.viewer, role: "viewer" }, viewerView],
  ];
  for (const [viewer, expected] of views) {
    for (const key of ["ownerItem", "memberItem", "preparingItem"]) {
      assert.deepEqual(projectAlbumItem(snapshots[key], viewer), expected[key], `${viewer.role}:${key}`);
    }
  }
  const forbidden = ["renditionBinding", "recipe", "libraryKind", "storage", "connector", "fileName", "path"];
  for (const view of [contributorView, viewerView]) {
    const json = JSON.stringify(view);
    for (const key of forbidden) assert(!json.includes(`"${key}"`), key);
  }
  assert(!JSON.stringify(viewerView).includes(fixtures.IDS.hostedLibrary));
  assert(!JSON.stringify(fixtures.albumForViewer).includes(fixtures.IDS.hostedLibrary));
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
  assert.equal(usage.usedBytes, usage.previewBytes + usage.renditionBytes + usage.exportStagingBytes);
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

test("error codes have one status and one recovery each", () => {
  assert.deepEqual(Object.keys(SHARING_ERROR_RECOVERY).sort(), Object.keys(SHARING_ERROR_STATUS).sort());
  for (const status of Object.values(SHARING_ERROR_STATUS)) assert(status >= 400 && status < 600);
  for (const code of ["not_found", "item_removed", "invite_unavailable"]) assert.notEqual(SHARING_ERROR_RECOVERY[code], "retrySameKey");
  assert.equal(SHARING_ERROR_RECOVERY.stale_render, "discardResult");
  assert.equal(SHARING_ERROR_RECOVERY.temporarily_unavailable, "retrySameKey");
});

// ---------------------------------------------------------------------------------------------------------
// Conformance vectors evaluated through the reference policy.

const actorId = (label) => vectors.actors[label] ?? null;
const success = (operation, created) => ({ status: created ? 201 : 200 });
const fromDecision = (decision, operation) => decision.ok ? success(operation, CREATE_OPERATIONS.has(operation)) : { status: SHARING_ERROR_STATUS[decision.code], code: decision.code };

function evaluate(vector) {
  const { arrange, operation, request } = vector;
  const userId = actorId(vector.actor);
  switch (vector.check) {
    case "session":
      return fromDecision(userId ? { ok: true } : { ok: false, code: "unauthenticated" }, operation);
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
      const decision = decideJoin({ actorId: userId, link: arrange.link, album: arrange.album, existing: arrange.existing, now: arrange.now });
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
    case "revision":
      return fromDecision(arrange.expectedRevision === arrange.currentRevision ? { ok: true } : { ok: false, code: "revision_conflict" }, operation);
    case "hostedSave":
      return fromDecision(decideHostedRecipeSave(arrange), operation);
    case "visibility": {
      const projected = projectAlbumItem(fixtures.snapshots[arrange.snapshot], { userId, role: arrange.role });
      return fromDecision(projected ? { ok: true } : { ok: false, code: "not_found" }, operation);
    }
    case "closedRequest":
      return fromDecision(findUnexpectedRequestFields(operation, request).length ? { ok: false, code: "invalid_request" } : { ok: true }, operation);
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
    if (vector.check !== "closedRequest" && vector.operation in SHARING_REQUEST_KEYS) {
      assert.deepEqual(findUnexpectedRequestFields(vector.operation, vector.request), [], vector.id);
    }
    const actual = evaluate(vector);
    assert.deepEqual(actual, vector.expected.code ? { status: vector.expected.status, code: vector.expected.code } : { status: vector.expected.status }, vector.id);
  }
});

test("B00 negative categories are all present", () => {
  const ids = new Set(vectors.cases.map((item) => item.id));
  const required = {
    otherOwnerOrAlbum: ["foreign-album", "other-album-item", "member-reads-owner-library", "member-adds-owner-library-photo", "pairing-into-foreign-library", "member-edits-owner-photo"],
    viewerAdds: ["viewer-adds-photo", "viewer-adds-file"],
    othersItemRemoval: ["contributor-removes-others-item", "owner-replaces-member-item"],
    afterRevocation: ["removed-member-adds", "left-member-adds", "commit-after-removal", "commit-after-demotion", "job-after-adder-removed"],
    staleCursorJobRevision: ["cursor-after-role-change", "cursor-expired", "stale-job-recipe", "superseded-job", "job-lease-expired", "rename-stale", "replace-stale-revision", "device-render-older", "hosted-save-old-source"],
    unknownResultResend: ["add-unknown-result-replay", "changed-payload-same-key", "join-unknown-result-replay", "invite-create-replay", "job-commit-replay"],
    inviteLinks: ["join-expired-link", "join-revoked-link", "join-unknown-secret", "join-unauthenticated", "join-removed-old-link"],
    metadata: ["rendition-with-location", "rendition-with-serial", "rendition-with-path"],
  };
  for (const [category, list] of Object.entries(required)) for (const id of list) assert(ids.has(id), `${category}:${id}`);
});
