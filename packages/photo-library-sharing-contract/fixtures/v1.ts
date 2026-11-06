import {
  HASH as V2_HASH,
  IDS as V2_IDS,
  adoptedConflictRecipe,
  adoptedRecipeConflict,
  library as personalLibrary,
  maskedPhoto,
  recipeConflict,
  recipeConflictPage,
} from "../../photo-library-contract/fixtures/v2.ts";
import { nihoCloudLibraryFromPersonalV2 } from "../src/compat-v2.ts";
import { ALBUM_PERMISSIONS } from "../src/v1.ts";
import type {
  Album,
  AlbumItem,
  AlbumItemSnapshot,
  ClaimedRenderJob,
  ConnectorOperationMap,
  FullResolutionExport,
  HostConnector,
  HostedMacLibrary,
  HostedPhoto,
  InviteLink,
  LedgerPerson,
  Membership,
  PersonLabel,
  PreviewAsset,
  RecipeDocument,
  RenderBinding,
  RenderJob,
  Rendition,
  RenditionMetadata,
  RenditionUpload,
  SharedStorageUsage,
  SharingErrorEnvelope,
  SharingOperationMap,
  SourceIdentity,
  UploadTicket,
  UserId,
} from "../src/v1.ts";

/** Synthetic metadata only. Not decoder fixtures, live API evidence or production authorization. */
export const TIME = "2026-11-07T00:00:00.000Z";
export const LATER = "2026-11-07T00:10:00.000Z";
export const INVITE_EXPIRES = "2026-11-14T00:00:00.000Z";

export const USERS = {
  owner: V2_IDS.userA,
  contributor: "synthetic-user-contributor",
  viewer: "synthetic-user-viewer",
  outsider: V2_IDS.userB,
} as const;
/** Server-held identities. Responses carry only `label(person, viewer)`. */
export const PEOPLE = {
  owner: { userId: USERS.owner, displayName: "Synthetic Owner" },
  contributor: { userId: USERS.contributor, displayName: "Synthetic Contributor" },
  viewer: { userId: USERS.viewer, displayName: "Synthetic Viewer" },
} as const satisfies Record<string, LedgerPerson>;
/** How `person` appears to `viewer`: display name and isSelf, never the user ID. */
export const label = (person: LedgerPerson, viewer: UserId): PersonLabel => ({
  displayName: person.displayName, isSelf: person.userId === viewer,
});

export const IDS = {
  nihoLibrary: V2_IDS.library,
  hostedLibrary: "synthetic-library-hosted",
  connector: "synthetic-connector",
  pairing: "synthetic-pairing",
  photo: "synthetic-hosted-photo",
  album: "synthetic-album-a",
  otherAlbum: "synthetic-album-b",
  ownerItem: "synthetic-item-owner-photo",
  memberItem: "synthetic-item-member-edit",
  fileItem: "synthetic-item-file",
  preparingItem: "synthetic-item-preparing",
  quotaPreparingItem: "synthetic-item-quota-preparing",
  quotaUpdateItem: "synthetic-item-quota-update",
  quotaRendition: "synthetic-rendition-4",
  ownerMembership: "synthetic-membership-owner",
  contributorMembership: "synthetic-membership-contributor",
  viewerMembership: "synthetic-membership-viewer",
  rendition: "synthetic-rendition-1",
  memberRendition: "synthetic-rendition-2",
  fileRendition: "synthetic-rendition-3",
  preview: "synthetic-preview",
  invite: "synthetic-invite",
  job: "synthetic-render-job",
  export: "synthetic-export",
  portableExport: "synthetic-portable-export",
  upload: "synthetic-rendition-upload",
  outputUpload: "synthetic-output-upload",
  deviceSource: "synthetic-device-source",
} as const;
export const HASH = {
  source: V2_HASH.original,
  preview: V2_HASH.preview,
  mask: V2_HASH.mask,
  manifest: V2_HASH.manifest,
  rendition: "e".repeat(64),
  memberRendition: "1".repeat(64),
  fileRendition: "2".repeat(64),
  quotaRendition: "9".repeat(64),
  thumbnail: "f".repeat(64),
  query: "3".repeat(64),
  payload: "4".repeat(64),
  changedPayload: "5".repeat(64),
  manifestExport: "6".repeat(64),
  deviceSource: "7".repeat(64),
} as const;

const ticket = (path: string): UploadTicket => ({
  url: `https://upload.example.test/${path}`, method: "PUT", headers: {}, expiresAt: LATER, resumeOffsetBytes: 0,
});

// --- Libraries -------------------------------------------------------------------------------------------

export const renderer = personalLibrary.capabilities.renderer;
/** The personal v2 library seen through the compat adapter; v2 itself is unchanged. */
export const nihoLibrary = nihoCloudLibraryFromPersonalV2(personalLibrary);
export const connector: HostConnector = {
  id: IDS.connector, owner: { type: "user", userId: USERS.owner }, libraryId: IDS.hostedLibrary, platform: "macos",
  displayName: "Synthetic Mac", lifecycle: "active", credentialGeneration: 1, state: "online", lastSeenAt: TIME,
  renderer, transport: "outboundOnly",
};
export const sleepingConnector: HostConnector = { ...connector, state: "sleeping" };
export const revokedConnector: HostConnector = { ...connector, lifecycle: "revoked", credentialGeneration: 2, state: "unreachable" };
export const hostedLibrary: HostedMacLibrary = {
  contractVersion: 1, kind: "hostedMac", id: IDS.hostedLibrary, owner: { type: "user", userId: USERS.owner },
  lifecycle: "active", metadataRevision: 12, metadataAuthority: "niho", originals: "hostedMac", port: "hostedLibraryV1",
  connector, replica: { acknowledgedRevision: 12, state: "current" },
  index: { state: "ready", indexedCount: 1, discoveredCount: 1 },
};
export const sleepingHostedLibrary: HostedMacLibrary = {
  ...hostedLibrary, metadataRevision: 13, connector: sleepingConnector,
  replica: { acknowledgedRevision: 12, state: "pendingHost" },
};

// --- Hosted photos ---------------------------------------------------------------------------------------

export const source: SourceIdentity = {
  generation: 1, sha256: HASH.source, sizeBytes: 25 * 1024 ** 2, format: "raw", width: 6000, height: 4000,
};
/** Edited recipe with a mask, reused from the v2 full-recipe fixture (#196). */
export const editedRecipe: RecipeDocument = maskedPhoto.recipe;
export const savedRecipe: RecipeDocument = { ...editedRecipe, revision: 2 };
export const binding: RenderBinding = {
  sourceGeneration: 1, sourceSha256: HASH.source, recipeRevision: editedRecipe.revision,
  settingsSha256: editedRecipe.settingsSha256, engine: editedRecipe.settings.engine,
  rendererManifestSha256: HASH.manifest, maskSurfaceIds: editedRecipe.maskSurfaceIds,
};
export const nextBinding: RenderBinding = { ...binding, recipeRevision: savedRecipe.revision };
export const previewAsset: PreviewAsset = {
  id: IDS.preview, sha256: HASH.preview, sizeBytes: 65536, contentType: "image/jpeg", width: 1280, height: 853,
  fullResolution: false,
};
export const hostedPhoto: HostedPhoto = {
  libraryId: IDS.hostedLibrary, id: IDS.photo, lifecycle: "active", availability: "available",
  fileName: "synthetic-hosted.rw2", capturedAt: TIME, addedAt: TIME, source, recipe: editedRecipe,
  recipeSourceGeneration: 1, workingCopy: null, preview: { state: "ready", asset: previewAsset, binding },
};
/** Saved in NIHO while the Mac sleeps; the replica catches up later. */
export const savedWhileAsleep = {
  photo: { ...hostedPhoto, recipe: savedRecipe }, durability: "niho", replica: "pendingHost",
} as const satisfies SharingOperationMap["hostedRecipes.put"]["response"]["value"];
export const sourceChangedPhoto: HostedPhoto = {
  ...hostedPhoto, source: { ...source, generation: 2, sha256: null }, preview: { state: "pending" },
};

// --- Renditions and album items ---------------------------------------------------------------------------

export const renditionMetadata: RenditionMetadata = {
  capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00", colorProfile: "sRGB", orientation: 1,
};
const renditionOf = (id: string, sha256: string, itemRevision: number): Rendition => ({
  id, itemRevision, metadata: renditionMetadata, createdAt: TIME,
  asset: { sha256, sizeBytes: 8 * 1024 ** 2, contentType: "image/jpeg", width: 6000, height: 4000, fullResolution: true },
  thumbnail: { sha256: HASH.thumbnail, sizeBytes: 16384, contentType: "image/jpeg", width: 512, height: 341 },
});
export const rendition = renditionOf(IDS.rendition, HASH.rendition, 1);
export const memberRendition = renditionOf(IDS.memberRendition, HASH.memberRendition, 1);
export const fileRendition = renditionOf(IDS.fileRendition, HASH.fileRendition, 1);

export const quotaRendition = renditionOf(IDS.quotaRendition, HASH.quotaRendition, 1);

const ownerSource = { kind: "libraryPhoto", libraryId: IDS.hostedLibrary, photoId: IDS.photo } as const;
const deviceSource = { kind: "devicePhoto", deviceSourceRef: IDS.deviceSource } as const;
const deviceBinding: RenderBinding = { ...binding, sourceSha256: HASH.deviceSource };

/** Server-held items (never returned directly). */
export const snapshots = {
  ownerItem: {
    id: IDS.ownerItem, albumId: IDS.album, kind: "ownerPhoto", addedBy: PEOPLE.owner, addedAt: TIME, revision: 1,
    state: "updatePending", source: ownerSource,
    rendition, renditionBinding: binding, pendingReason: "waitingForHost", removedAt: null, pendingUpload: null,
  },
  memberItem: {
    id: IDS.memberItem, albumId: IDS.album, kind: "memberEdit", addedBy: PEOPLE.contributor, addedAt: TIME, revision: 1,
    state: "published", source: deviceSource,
    rendition: memberRendition, renditionBinding: deviceBinding, pendingReason: null, removedAt: null, pendingUpload: null,
  },
  fileItem: {
    id: IDS.fileItem, albumId: IDS.album, kind: "fileUpload", addedBy: PEOPLE.contributor, addedAt: TIME, revision: 1,
    state: "published", source: null, rendition: fileRendition, renditionBinding: null, pendingReason: null, removedAt: null,
    pendingUpload: null,
  },
  preparingItem: {
    id: IDS.preparingItem, albumId: IDS.album, kind: "memberEdit", addedBy: PEOPLE.contributor, addedAt: TIME, revision: 0,
    state: "preparing", source: deviceSource, rendition: null, renditionBinding: null, pendingReason: "rendering", removedAt: null,
    pendingUpload: { uploadId: "synthetic-initial-upload", binding: deviceBinding },
  },
  /** 準備中（容量不足）: the first rendition could not be reserved in the album owner's storage. */
  quotaPreparingItem: {
    id: IDS.quotaPreparingItem, albumId: IDS.album, kind: "memberEdit", addedBy: PEOPLE.contributor, addedAt: TIME, revision: 0,
    state: "preparing", source: deviceSource, rendition: null, renditionBinding: null, pendingReason: "quotaExceeded", removedAt: null,
    pendingUpload: { uploadId: "synthetic-quota-upload", binding: deviceBinding },
  },
  /** A replacement waits for capacity; members keep seeing the previous rendition. */
  quotaUpdateItem: {
    id: IDS.quotaUpdateItem, albumId: IDS.album, kind: "ownerPhoto", addedBy: PEOPLE.owner, addedAt: TIME, revision: 1,
    state: "updatePending", source: ownerSource, rendition: quotaRendition, renditionBinding: binding,
    pendingReason: "quotaExceeded", removedAt: null, pendingUpload: null,
  },
} as const satisfies Record<string, AlbumItemSnapshot>;

const common = (snapshot: AlbumItemSnapshot, viewer: UserId) => ({
  id: snapshot.id, albumId: snapshot.albumId, kind: snapshot.kind, addedBy: label(snapshot.addedBy, viewer),
  addedAt: snapshot.addedAt, revision: snapshot.revision,
});

/** Expected projections of `snapshots` for the album owner. */
export const ownerView = {
  ownerItem: {
    ...common(snapshots.ownerItem, USERS.owner), source: ownerSource, state: "updatePending", rendition, pendingReason: "waitingForHost",
  },
  memberItem: { ...common(snapshots.memberItem, USERS.owner), source: null, state: "published", rendition: memberRendition },
  preparingItem: { ...common(snapshots.preparingItem, USERS.owner), source: null, state: "preparing", rendition: null, pendingReason: "rendering" },
  quotaPreparingItem: {
    ...common(snapshots.quotaPreparingItem, USERS.owner), source: null, state: "preparing", rendition: null, pendingReason: "quotaExceeded",
  },
  quotaUpdateItem: {
    ...common(snapshots.quotaUpdateItem, USERS.owner), source: ownerSource, state: "updatePending", rendition: quotaRendition,
    pendingReason: "quotaExceeded",
  },
} as const satisfies Record<string, AlbumItem>;
/** A viewer never sees preparing items, pending reasons or sources. */
export const viewerView = {
  ownerItem: { ...common(snapshots.ownerItem, USERS.viewer), source: null, state: "published", rendition },
  memberItem: { ...common(snapshots.memberItem, USERS.viewer), source: null, state: "published", rendition: memberRendition },
  preparingItem: null,
  quotaPreparingItem: null,
  quotaUpdateItem: { ...common(snapshots.quotaUpdateItem, USERS.viewer), source: null, state: "published", rendition: quotaRendition },
} as const satisfies Record<string, AlbumItem | null>;
/** The adder sees its own source and waiting reason; another member's pending update looks published. */
export const contributorView = {
  ownerItem: { ...common(snapshots.ownerItem, USERS.contributor), source: null, state: "published", rendition },
  memberItem: { ...common(snapshots.memberItem, USERS.contributor), source: deviceSource, state: "published", rendition: memberRendition },
  preparingItem: {
    ...common(snapshots.preparingItem, USERS.contributor), source: deviceSource, state: "preparing", rendition: null, pendingReason: "rendering",
  },
  quotaPreparingItem: {
    ...common(snapshots.quotaPreparingItem, USERS.contributor), source: deviceSource, state: "preparing", rendition: null,
    pendingReason: "quotaExceeded",
  },
  quotaUpdateItem: { ...common(snapshots.quotaUpdateItem, USERS.contributor), source: null, state: "published", rendition: quotaRendition },
} as const satisfies Record<string, AlbumItem>;
export const removedItem: AlbumItem = {
  ...ownerView.memberItem, state: "removed", rendition: null, removedAt: LATER,
};

// --- Albums and membership --------------------------------------------------------------------------------

export const albumForOwner: Album = {
  id: IDS.album, owner: label(PEOPLE.owner, USERS.owner), name: "Synthetic shared album", revision: 4, createdAt: TIME, updatedAt: TIME,
  itemCount: 4, cover: { itemId: IDS.ownerItem, renditionId: IDS.rendition },
  access: { role: "owner", membershipRevision: 1, permissions: ALBUM_PERMISSIONS.owner, preparation: { prepared: 4, total: 6 } },
};
export const albumForViewer: Album = {
  ...albumForOwner, owner: label(PEOPLE.owner, USERS.viewer),
  access: { role: "viewer", membershipRevision: 2, permissions: ALBUM_PERMISSIONS.viewer, preparation: null },
};
export const albumForContributor: Album = {
  ...albumForOwner, owner: label(PEOPLE.owner, USERS.contributor),
  access: { role: "contributor", membershipRevision: 3, permissions: ALBUM_PERMISSIONS.contributor, preparation: { prepared: 2, total: 4 } },
};
const membership = (id: string, person: LedgerPerson, role: Membership["role"], revision: number, viewer: UserId): Membership => ({
  id, albumId: IDS.album, member: label(person, viewer), role, state: "active", revision, joinedAt: TIME, endedAt: null,
  joinedVia: role === "owner" ? null : IDS.invite,
});
/** As listed to the album owner. Rows are addressed by membership ID. */
export const memberships = {
  owner: membership(IDS.ownerMembership, PEOPLE.owner, "owner", 1, USERS.owner),
  contributor: membership(IDS.contributorMembership, PEOPLE.contributor, "contributor", 3, USERS.owner),
  viewer: membership(IDS.viewerMembership, PEOPLE.viewer, "viewer", 2, USERS.owner),
} as const;
export const removedMembership: Membership = { ...memberships.contributor, state: "removed", revision: 4, endedAt: LATER };
/** The viewer's own membership after leaving. */
export const leftMembership: Membership = {
  ...membership(IDS.viewerMembership, PEOPLE.viewer, "viewer", 3, USERS.viewer), state: "left", endedAt: LATER,
};
export const inviteLink: InviteLink = {
  id: IDS.invite, albumId: IDS.album, role: "contributor", createdBy: label(PEOPLE.owner, USERS.owner), createdAt: TIME,
  expiresAt: INVITE_EXPIRES, revoked: false, revokedAt: null, joinCount: 2,
};
export const revokedInviteLink: InviteLink = { ...inviteLink, revoked: true, revokedAt: LATER };

// --- Storage, render jobs, exports -----------------------------------------------------------------------

/** Separate owner-charged pool; its quota is server policy, not the personal 5 GiB. */
export const sharedStorage: SharedStorageUsage = {
  owner: { type: "user", userId: USERS.owner }, quotaBytes: 1024 ** 3,
  usedBytes: 65536 + 4096 + 3 * 8 * 1024 ** 2, previewBytes: 65536, maskBytes: 4096, renditionBytes: 3 * 8 * 1024 ** 2,
  exportStagingBytes: 0, reservedBytes: 8 * 1024 ** 2, availableBytes: 1024 ** 3 - 65536 - 4096 - 4 * 8 * 1024 ** 2,
};
export const renderJob: RenderJob = {
  id: IDS.job, purpose: { kind: "albumItem", albumId: IDS.album, itemId: IDS.ownerItem, itemRevision: 1 },
  executor: { kind: "hostedMac", connectorId: IDS.connector }, photo: { libraryId: IDS.hostedLibrary, photoId: IDS.photo },
  binding: nextBinding, recipe: savedRecipe, state: "claimed", attempt: 1, createdAt: TIME, leaseExpiresAt: LATER, failure: null,
  expectedOutput: { width: 6000, height: 4000 },
};
export const claimedJob: ClaimedRenderJob = {
  job: renderJob, lease: { jobId: IDS.job, leaseToken: "synthetic-lease", expiresAt: LATER },
};
export const waitingExport: FullResolutionExport = {
  id: IDS.export, libraryId: IDS.hostedLibrary, photoId: IDS.photo, binding: nextBinding, state: "waitingForHost",
  asset: null, expiresAt: null, failure: null,
};
export const readyExport: FullResolutionExport = {
  ...waitingExport, state: "ready", asset: rendition.asset, expiresAt: "2026-11-08T00:00:00.000Z",
};
export const renditionUpload: RenditionUpload = {
  id: IDS.upload, albumId: IDS.album, itemId: IDS.fileItem, targetItemRevision: 2, sizeBytes: fileRendition.asset.sizeBytes,
  sha256: HASH.fileRendition, expiresAt: LATER, state: "reserved", uploadedBytes: 0,
};

export const memberQuotaError: SharingErrorEnvelope = {
  error: { code: "quota_exceeded", requestId: "synthetic-request", retryable: false },
};
export const ownerQuotaError: SharingErrorEnvelope = {
  error: {
    code: "quota_exceeded", requestId: "synthetic-request", retryable: false,
    storage: { availableBytes: 0, requiredBytes: 8 * 1024 ** 2 },
  },
};

/** Port expectations for every non-stream user operation. No live API or backend claim. */
export const responses = {
  "libraries.list": { items: [nihoLibrary, hostedLibrary] },
  "libraries.get": hostedLibrary,
  "storage.get": sharedStorage,
  "connectors.approvePairing": { value: connector, replayed: false },
  "connectors.get": connector,
  "connectors.revoke": { value: revokedConnector, replayed: false },
  "hostedPhotos.list": { items: [hostedPhoto], nextCursor: null, libraryRevision: hostedLibrary.metadataRevision },
  "hostedPhotos.get": hostedPhoto,
  "hostedPhotos.info": { camera: null, lens: null, iso: null, width: 6000, height: 4000, gps: null },
  "hostedPhotos.exclude": { value: { ...hostedPhoto, lifecycle: "excluded" }, replayed: false },
  "hostedMasks.startUpload": {
    value: {
      upload: {
        id: "synthetic-mask-upload", libraryId: IDS.hostedLibrary, photoId: IDS.photo, surfaceId: HASH.mask,
        sizeBytes: 4096, expiresAt: LATER, state: "reserved",
      },
      ticket: ticket("synthetic-mask"),
    },
    replayed: false,
  },
  "hostedMasks.completeUpload": {
    value: {
      id: "synthetic-mask-upload", libraryId: IDS.hostedLibrary, photoId: IDS.photo, surfaceId: HASH.mask,
      sizeBytes: 4096, expiresAt: LATER, state: "stored",
    },
    replayed: false,
  },
  "hostedRecipes.put": { value: savedWhileAsleep, replayed: false },
  "hostedRecipeConflicts.list": recipeConflictPage,
  "hostedRecipeConflicts.get": recipeConflict,
  "hostedRecipeConflicts.resolve": { value: { conflict: adoptedRecipeConflict, recipe: adoptedConflictRecipe }, replayed: false },
  "exports.request": { value: waitingExport, replayed: false },
  "exports.get": readyExport,
  "portability.export": {
    value: { id: IDS.portableExport, libraryId: IDS.hostedLibrary, mode: "metadata", state: "preparing", manifestSha256: null, expiresAt: null },
    replayed: false,
  },
  "portability.get": {
    id: IDS.portableExport, libraryId: IDS.hostedLibrary, mode: "metadata", state: "ready",
    manifestSha256: HASH.manifestExport, expiresAt: "2026-11-08T00:00:00.000Z",
  },
  "portability.restore": {
    value: { libraryId: IDS.hostedLibrary, restoredPhotos: 1, restoredAlbums: 1, keptNewer: 0, membershipsRestored: 0, mismatches: [] },
    replayed: false,
  },
  "albums.list": { items: [albumForViewer], nextCursor: null },
  "albums.get": albumForOwner,
  "albums.create": { value: { ...albumForOwner, revision: 1, itemCount: 0, cover: null, access: { ...albumForOwner.access, preparation: null } }, replayed: false },
  "albums.rename": { value: { ...albumForOwner, revision: 5, name: "Synthetic renamed album" }, replayed: false },
  "albums.delete": { value: { albumId: IDS.album, state: "deleted" }, replayed: false },
  "albumItems.list": { items: [viewerView.ownerItem, viewerView.memberItem], nextCursor: null, albumRevision: 4, membershipRevision: 2 },
  "albumItems.get": ownerView.ownerItem,
  "albumItems.addPhoto": {
    value: {
      item: {
        ...ownerView.ownerItem, id: "synthetic-item-new", revision: 0, state: "preparing", rendition: null, pendingReason: "waitingForHost",
      },
      upload: null,
    },
    replayed: false,
  },
  "albumItems.addFile": {
    value: {
      item: { ...ownerView.preparingItem, kind: "fileUpload", source: null, revision: 0 },
      upload: { upload: { ...renditionUpload, itemId: IDS.preparingItem, targetItemRevision: 1 }, ticket: ticket("synthetic-file") },
    },
    replayed: false,
  },
  "albumItems.replace": {
    value: { item: ownerView.memberItem, upload: { upload: renditionUpload, ticket: ticket("synthetic-replace") } },
    replayed: false,
  },
  "albumItems.commitUpload": { value: { ...ownerView.memberItem, revision: 2, rendition: { ...memberRendition, itemRevision: 2 } }, replayed: false },
  "albumItems.cancelUpload": { value: { ...renditionUpload, state: "cancelled" }, replayed: false },
  "albumItems.remove": { value: removedItem, replayed: false },
  "invites.list": {
    links: [inviteLink],
    joins: [{ inviteLinkId: IDS.invite, membershipId: IDS.contributorMembership, member: label(PEOPLE.contributor, USERS.owner), joinedAt: TIME }],
  },
  "invites.create": { value: { link: { ...inviteLink, joinCount: 0 }, secret: "synthetic-invite-secret" }, replayed: false },
  "invites.revoke": { value: revokedInviteLink, replayed: false },
  "invites.join": {
    value: {
      album: albumForContributor,
      membership: membership(IDS.contributorMembership, PEOPLE.contributor, "contributor", 3, USERS.contributor),
      joined: true,
    },
    replayed: false,
  },
  "members.list": { items: [memberships.owner, memberships.contributor, memberships.viewer], nextCursor: null },
  "members.changeRole": { value: { ...memberships.contributor, role: "viewer", revision: 4 }, replayed: false },
  "members.remove": { value: removedMembership, replayed: false },
  "members.leave": { value: leftMembership, replayed: false },
} satisfies {
  readonly [K in Exclude<keyof SharingOperationMap, "hostedPhotos.content" | "exports.content" | "portability.content" | "albumItems.download">]: SharingOperationMap[K]["response"];
};

export const connectorResponses = {
  "connector.startPairing": { value: { pairingId: IDS.pairing, userCode: "SYN-0000", expiresAt: LATER }, replayed: false },
  "connector.pollPairing": { state: "approved", connector, credentialGeneration: 1 },
  "connector.rotateCredential": { value: { credentialGeneration: 2 }, replayed: false },
  "connector.heartbeat": { serverTime: TIME, metadataRevision: hostedLibrary.metadataRevision, queuedJobs: 1 },
  "connector.putIndex": {
    value: { results: [{ localKey: "synthetic-local-key", photoId: IDS.photo, state: "unchanged" }] }, replayed: false,
  },
  "connector.pullReplica": {
    sinceRevision: 12,
    changes: [{ revision: 13, op: "upsert", entity: "recipe", id: IDS.photo, body: { recipe: savedRecipe, recipeSourceGeneration: 1 } }],
    nextRevision: 13, complete: true, cursor: null,
  },
  "connector.ackReplica": { value: { acknowledgedRevision: 13, state: "current" }, replayed: false },
  "connector.startWorkingCopyUpload": {
    value: {
      upload: {
        id: "synthetic-working-copy-upload", photoId: IDS.photo, sourceGeneration: 1, sha256: HASH.payload,
        sizeBytes: 8192, contentType: "image/png", expiresAt: LATER, state: "reserved",
      },
      ticket: ticket("synthetic-working-copy"),
    },
    replayed: false,
  },
  "connector.completeWorkingCopyUpload": {
    value: {
      photoId: IDS.photo, sourceGeneration: 1,
      workingCopy: {
        asset: { id: "synthetic-working-copy-asset", kind: "working-copy", sha256: HASH.payload, sizeBytes: 8192, contentType: "image/png", width: 6000, height: 4000 },
        baseVersion: "niho-sdk-197", encoding: "png16", meta: { synthetic: true },
      },
    },
    replayed: false,
  },
  "renderJobs.claim": { value: { jobs: [claimedJob] }, replayed: false },
  "renderJobs.renewOutput": { uploadId: IDS.outputUpload, expiresAt: LATER, ticket: ticket("synthetic-output-renewed") },
  "renderJobs.startOutput": {
    value: { uploadId: IDS.outputUpload, expiresAt: LATER, ticket: ticket("synthetic-output") }, replayed: false,
  },
  "renderJobs.commit": { value: { ...renderJob, state: "committed", leaseExpiresAt: null }, replayed: false },
  "renderJobs.fail": { value: { ...renderJob, state: "failed", leaseExpiresAt: null, failure: "source_missing" }, replayed: false },
} satisfies {
  readonly [K in Exclude<keyof ConnectorOperationMap, "connector.getReplicaContent">]: ConnectorOperationMap[K]["response"];
};
