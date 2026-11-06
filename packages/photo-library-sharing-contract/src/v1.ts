/**
 * Photo library storage + shared album port v1 (Epic #240 / B00 #241).
 *
 * Additive to `@niho/photo-personal-cloud-contract` v2, which stays unchanged and personal-only. This is a
 * client/connector port: no HTTP routes, DB schema, storage locators, credentials or production enablement.
 * Shared shapes from #195 (upload ticket, content stream), #196 (full recipe, conflicts) and #197 (renderer
 * capability) are reused from v2 rather than redefined.
 */
import { PHOTO_LIMITS } from "../../photo-library-contract/src/v2.ts";
import type {
  AssetId,
  Instant,
  JsonObject,
  LibraryId,
  MutationReceipt,
  PhotoAsset,
  PhotoByteRange,
  PhotoContent,
  PhotoFormat,
  PhotoId,
  PhotoInfo,
  RecipeConflict,
  RecipeConflictId,
  RecipeConflictPage,
  RecipeConflictResolution,
  RecipeDocument,
  RenderCapability,
  Sha256,
  UploadId,
  UploadTicket,
  UserId,
  VerifiedPhotoActor,
  WorkingCopy,
} from "../../photo-library-contract/src/v2.ts";

export type {
  AssetId,
  Instant,
  JsonObject,
  LibraryId,
  MutationReceipt,
  PhotoAsset,
  PhotoByteRange,
  PhotoContent,
  PhotoFormat,
  PhotoId,
  PhotoInfo,
  RecipeConflict,
  RecipeConflictId,
  RecipeConflictPage,
  RecipeConflictResolution,
  RecipeDocument,
  RenderCapability,
  Sha256,
  UploadId,
  UploadTicket,
  UserId,
  VerifiedPhotoActor,
  WorkingCopy,
};

export const PHOTO_LIBRARY_SHARING_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------------------------------------
// Vocabulary shared with the UI (B08). Changing a value is a breaking contract change.

/** Storage kinds. `nihoCloud` is the default and is never asked for at first run (Epic §1). */
export const LIBRARY_KINDS = ["nihoCloud", "hostedMac", "thisMac"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export const DEFAULT_LIBRARY_KIND = "nihoCloud" as const satisfies LibraryKind;

/** owner / contributor (写真を追加できる) / viewer (見るだけ). */
export const ALBUM_ROLES = ["owner", "contributor", "viewer"] as const;
export type AlbumRole = (typeof ALBUM_ROLES)[number];
/** Roles an invite link or a role change may grant. Ownership transfer is out of scope (Epic §2). */
export const MEMBER_ROLES = ["contributor", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** ownerPhoto: added by the album owner. memberEdit: a member's own edited photo. fileUpload: a finished file. */
export const ALBUM_ITEM_KINDS = ["ownerPhoto", "memberEdit", "fileUpload"] as const;
export type AlbumItemKind = (typeof ALBUM_ITEM_KINDS)[number];
export const ALBUM_ITEM_STATES = ["preparing", "published", "updatePending", "removed"] as const;
export type AlbumItemState = (typeof ALBUM_ITEM_STATES)[number];

/** online: recent heartbeat. sleeping: the Mac announced sleep. unreachable: heartbeat overdue. */
export const HOST_CONNECTOR_STATES = ["online", "sleeping", "unreachable"] as const;
export type HostConnectorState = (typeof HOST_CONNECTOR_STATES)[number];

/** Work that waits for the hosted Mac. Listing, recipe saves and album changes never wait (Epic §7). */
export const HOST_DEFERRED_WORK = ["fullResolutionExport", "ownerPhotoRendition"] as const;
export type HostDeferredWork = (typeof HOST_DEFERRED_WORK)[number];

/** Client-side bounds. Servers re-validate against modified clients. */
export const SHARING_LIMITS = {
  inviteLinkLifetimeSeconds: 7 * 24 * 60 * 60,
  inviteSecretMinBits: 128,
  pairingLifetimeSeconds: 10 * 60,
  /** Counted in Unicode code points, the same rule as the server. Blank names are rejected. */
  albumNameMaxCodePoints: 100,
  listMaxCount: PHOTO_LIMITS.listMaxCount,
  memberListMaxCount: 100,
  cursorLifetimeSeconds: PHOTO_LIMITS.cursorLifetimeSeconds,
  maxIdempotencyKeyBytes: PHOTO_LIMITS.maxIdempotencyKeyBytes,
  maxOtherBodyBytes: PHOTO_LIMITS.maxOtherBodyBytes,
  downloadTicketMaxSeconds: PHOTO_LIMITS.downloadTicketMaxSeconds,
  fileUploadMaxBytes: PHOTO_LIMITS.maxFileBytes,
  renditionMaxPixels: PHOTO_LIMITS.maxPixels,
  thumbnailMaxEdge: PHOTO_LIMITS.thumbnailMaxEdge,
  renderLeaseMaxSeconds: 15 * 60,
  /** Photos a claim may name as currently on screen. */
  claimPreferMaxPhotos: 60,
  exportStagingMaxSeconds: 24 * 60 * 60,
} as const;

/** v1 accepts finished JPEG files only; hosts convert other formats before upload. */
export const FILE_UPLOAD_CONTENT_TYPES = ["image/jpeg"] as const;

// ---------------------------------------------------------------------------------------------------------
// Identity. All IDs are server-issued opaque strings and never an authorization capability.

export type AlbumId = string;
export type AlbumItemId = string;
export type RenditionId = string;
export type InviteLinkId = string;
export type ConnectorId = string;
export type PairingId = string;
export type RenderJobId = string;
export type ExportId = string;
export type PortableExportId = string;
/** Bearer secret embedded in an invite link. Returned once by `invites.create`; never listed, logged or persisted. */
export type InviteSecret = string;
/** Opaque value only the adder's own device can resolve. NIHO stores it and shows it to the adder only. */
export type DeviceSourceRef = string;

export interface UserRef {
  readonly type: "user";
  readonly userId: UserId;
}
export type MembershipId = string;
/**
 * Person as shown in responses: a display name kept after the member leaves (Epic §3) and whether it is the
 * viewer. Never another member's user ID, email or spot ID; member rows are addressed by MembershipId.
 */
export interface PersonLabel {
  readonly displayName: string;
  readonly isSelf: boolean;
}
/** Server-held identity behind a PersonLabel. Never returned in a response. */
export interface LedgerPerson {
  readonly userId: UserId;
  readonly displayName: string;
}

/** Server-internal; never deserialized from a request. Users reuse the v2 verified actor and its session epoch. */
export type VerifiedSharingActor =
  | { readonly kind: "user"; readonly user: VerifiedPhotoActor }
  | { readonly kind: "connector"; readonly connector: VerifiedConnectorActor };
/** Device credential of a hosted Mac, distinct from NIHO login tokens. */
export interface VerifiedConnectorActor {
  readonly connectorId: ConnectorId;
  readonly ownerUserId: UserId;
  readonly libraryId: LibraryId;
  /** Revalidated before every commit. Revocation or re-pairing bumps it and fences older credentials. */
  readonly credentialGeneration: number;
  readonly transport: "connector-bearer";
  readonly expiresAt: Instant;
}

// ---------------------------------------------------------------------------------------------------------
// Library and hosted Mac

interface ServerLibraryCommon {
  readonly contractVersion: 1;
  readonly id: LibraryId;
  readonly owner: UserRef;
  readonly lifecycle: "active" | "deleting";
  /** Revision of NIHO-held metadata: recipes, masks, album definitions and the index. */
  readonly metadataRevision: number;
  /** Server libraries always keep the canonical metadata in NIHO (Epic §4). */
  readonly metadataAuthority: "niho";
}
export interface NihoCloudLibrary extends ServerLibraryCommon {
  readonly kind: "nihoCloud";
  readonly originals: "niho";
  /** Photos, recipes, masks and the 5 GiB pool keep using the unchanged personal v2 port. */
  readonly port: "personalCloudV2";
}
export interface HostedMacLibrary extends ServerLibraryCommon {
  readonly kind: "hostedMac";
  /** Originals stay in read-only roots on the Mac. NIHO holds previews and metadata, never a full copy. */
  readonly originals: "hostedMac";
  readonly port: "hostedLibraryV1";
  /** null before pairing completes. A revoked connector stays visible with lifecycle "revoked". */
  readonly connector: HostConnector | null;
  readonly replica: LibraryReplicaStatus;
  readonly index: LibraryIndexStatus;
}
/** Local library on this device. Usable without sign-in; never listed or stored by NIHO. */
export interface ThisMacLibrary {
  readonly contractVersion: 1;
  readonly kind: "thisMac";
  /** Device-local identifier; never sent to NIHO as authority. */
  readonly id: LibraryId;
  readonly metadataAuthority: "device";
  readonly originals: "device";
  readonly port: "localDevice";
}
export type ServerLibrary = NihoCloudLibrary | HostedMacLibrary;
export type Library = ServerLibrary | ThisMacLibrary;

/** The Mac keeps a replica of NIHO metadata. The replica never overwrites NIHO. */
export interface LibraryReplicaStatus {
  readonly acknowledgedRevision: number;
  /** pendingHost: saved in NIHO, the Mac will catch up after it wakes. Saving never waits for this. */
  readonly state: "current" | "pendingHost";
}
export interface LibraryIndexStatus {
  readonly state: "indexing" | "ready" | "paused";
  readonly indexedCount: number;
  /** Grows while scanning. Excluded photos are never counted. */
  readonly discoveredCount: number;
}

export interface HostConnector {
  readonly id: ConnectorId;
  readonly owner: UserRef;
  readonly libraryId: LibraryId;
  /** Initial release is macOS only. Other platforms (B11) reuse this protocol with a new value. */
  readonly platform: "macos";
  readonly displayName: string;
  readonly lifecycle: "active" | "revoked";
  readonly credentialGeneration: number;
  readonly state: HostConnectorState;
  readonly lastSeenAt: Instant | null;
  /** #197 runtime declaration reported by the connector; null until reported. Never a server promise. */
  readonly renderer: RenderCapability | null;
  /** v1 connectors only dial out to NIHO. There is no inbound address, tunnel or relay (B04 is phase 2). */
  readonly transport: "outboundOnly";
}

/**
 * Short-lived one-time pairing started by the connector and approved by the owner in NIHO. The connector creates a
 * random poll secret and a random device credential and sends only their SHA-256: no bearer ever travels from NIHO,
 * so every lost response can be replayed.
 */
export interface ConnectorPairingStart {
  readonly pairingId: PairingId;
  /** Short code shown on the Mac and confirmed by the signed-in owner. */
  readonly userCode: string;
  readonly expiresAt: Instant;
}
export type ConnectorPairingTarget =
  | { readonly kind: "newLibrary"; readonly name: string }
  | { readonly kind: "existingLibrary"; readonly libraryId: LibraryId };
/**
 * After approval the connector authenticates with the credential whose SHA-256 it registered at start (kept in the
 * OS keychain; never logs, journals or UI). Polling an approved pairing repeats the same answer until it expires.
 */
export type ConnectorPairingPoll =
  | { readonly state: "pending"; readonly expiresAt: Instant }
  | { readonly state: "approved"; readonly connector: HostConnector; readonly credentialGeneration: number };
/**
 * Rotation registers the next connector-generated credential by hash. Once committed the previous credential is
 * fenced; a connector that lost the response tries the next credential first, then replays with the previous one.
 */
export interface ConnectorCredentialRotation {
  readonly credentialGeneration: number;
}

// ---------------------------------------------------------------------------------------------------------
// Photos, recipes and previews in a hosted Mac library

export interface SourceIdentity {
  /** Increments whenever the bytes behind the photo change outside NIHO. */
  readonly generation: number;
  /** Lazily computed by the connector; null until this generation is hashed. */
  readonly sha256: Sha256 | null;
  readonly sizeBytes: number;
  readonly format: PhotoFormat;
  /** Oriented pixel size once known. */
  readonly width: number | null;
  readonly height: number | null;
}
/**
 * An unmounted volume is never treated as deletion. sourceMismatch: the bytes at the registered key no longer match
 * the recorded hash/generation (for example after the local index was rebuilt); never relinked automatically.
 */
export type SourceAvailability = "available" | "volumeUnmounted" | "missing" | "sourceMismatch";

/** Exact inputs a preview, rendition or export was produced from (Epic §8, §9). */
export interface RenderBinding {
  readonly sourceGeneration: number;
  readonly sourceSha256: Sha256;
  readonly recipeRevision: number;
  readonly settingsSha256: Sha256;
  readonly engine: string;
  readonly rendererManifestSha256: Sha256;
  /** Mask identity: the recipe's referenced mask surface hashes. */
  readonly maskSurfaceIds: readonly Sha256[];
}

/** Reduced working image. Never presented or exported as full resolution. */
export interface PreviewAsset {
  readonly id: AssetId;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly contentType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly fullResolution: false;
}
export type PreviewState =
  | { readonly state: "pending" }
  | { readonly state: "waitingForHost" }
  | { readonly state: "rendering"; readonly jobId: RenderJobId }
  /** Compare binding.recipeRevision with the photo's recipe; an older preview is shown as older, never as current. */
  | { readonly state: "ready"; readonly asset: PreviewAsset; readonly binding: RenderBinding }
  | { readonly state: "failed"; readonly code: "decoder_failed" | "unsupported_format" | "renderer_unavailable" };

export interface HostedPhoto {
  readonly libraryId: LibraryId;
  readonly id: PhotoId;
  /** excluded: removed from the list only. Originals stay; a rescan does not revive it. */
  readonly lifecycle: "active" | "excluded";
  readonly availability: SourceAvailability;
  /** Base name for the owner only. Never a path. */
  readonly fileName: string;
  readonly capturedAt: Instant | null;
  readonly addedAt: Instant;
  readonly source: SourceIdentity;
  /** #196 full recipe; unknown fields are preserved. */
  readonly recipe: RecipeDocument;
  /** Source generation the recipe was saved against. A newer source never silently reuses an older recipe. */
  readonly recipeSourceGeneration: number;
  /** Canonical base working copy for this source generation (#197 shape). */
  readonly workingCopy: (WorkingCopy & { readonly sourceGeneration: number }) | null;
  readonly preview: PreviewState;
}
export interface HostedPhotoPage {
  readonly items: readonly HostedPhoto[];
  readonly nextCursor: string | null;
  readonly libraryRevision: number;
}
/** Saving is complete once NIHO holds it; the Mac replica may lag (Epic §8). */
export interface HostedRecipeSave {
  readonly photo: HostedPhoto;
  readonly durability: "niho";
  readonly replica: LibraryReplicaStatus["state"];
}

/** Owner-only full-resolution export rendered by the hosted Mac into short-lived staging (Epic §9). */
export interface FullResolutionExport {
  readonly id: ExportId;
  readonly libraryId: LibraryId;
  readonly photoId: PhotoId;
  readonly binding: RenderBinding;
  readonly state: "waitingForHost" | "rendering" | "ready" | "failed" | "expired";
  readonly asset: RenditionAsset | null;
  /** Staging is deleted at this time. */
  readonly expiresAt: Instant | null;
  readonly failure: RenderFailureCode | null;
}

// ---------------------------------------------------------------------------------------------------------
// Albums, items and renditions

export const ALBUM_ACTIONS = [
  "view",
  "download",
  "addItem",
  "replaceOwnItem",
  "removeOwnItem",
  "removeOthersItem",
  "editOthersPhoto",
  "readOthersSource",
  "manageInvites",
  "changeRole",
  "removeMember",
  "renameAlbum",
  "deleteAlbum",
  "leave",
] as const;
export type AlbumAction = (typeof ALBUM_ACTIONS)[number];
export type AlbumPermissionSet = { readonly [A in AlbumAction]: boolean };

/**
 * Epic §10. The server derives the role from its own ledger on every request; clients use this table only to
 * decide what to show. editOthersPhoto/readOthersSource (補正・元データ・補正値・mask) are granted to no role in v1.
 */
export const ALBUM_PERMISSIONS = {
  owner: {
    view: true, download: true, addItem: true, replaceOwnItem: true, removeOwnItem: true, removeOthersItem: true,
    editOthersPhoto: false, readOthersSource: false, manageInvites: true, changeRole: true, removeMember: true,
    renameAlbum: true, deleteAlbum: true, leave: false,
  },
  contributor: {
    view: true, download: true, addItem: true, replaceOwnItem: true, removeOwnItem: true, removeOthersItem: false,
    editOthersPhoto: false, readOthersSource: false, manageInvites: false, changeRole: false, removeMember: false,
    renameAlbum: false, deleteAlbum: false, leave: true,
  },
  viewer: {
    view: true, download: true, addItem: false, replaceOwnItem: false, removeOwnItem: false, removeOthersItem: false,
    editOthersPhoto: false, readOthersSource: false, manageInvites: false, changeRole: false, removeMember: false,
    renameAlbum: false, deleteAlbum: false, leave: true,
  },
} as const satisfies { readonly [R in AlbumRole]: AlbumPermissionSet };

export interface AlbumAccess {
  readonly role: AlbumRole;
  /** The viewer's membership revision. Cursors are bound to it. */
  readonly membershipRevision: number;
  /** Display hints from ALBUM_PERMISSIONS; the server re-checks every request. */
  readonly permissions: AlbumPermissionSet;
  /** Items the viewer may see while preparing (owner: every item, others: their own). null when none. */
  readonly preparation: { readonly prepared: number; readonly total: number } | null;
}
export interface AlbumCover {
  readonly itemId: AlbumItemId;
  readonly renditionId: RenditionId;
}
/** Every field is computed from items the viewer may see. No library, storage kind or unshared counts. */
export interface Album {
  readonly id: AlbumId;
  readonly owner: PersonLabel;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  /** Published items visible to every member. */
  readonly itemCount: number;
  readonly cover: AlbumCover | null;
  readonly access: AlbumAccess;
}
export interface AlbumPage {
  readonly items: readonly Album[];
  readonly nextCursor: string | null;
}

/** Only these fields survive into a rendition (Epic §9). Orientation is baked into the pixels. */
export const RENDITION_METADATA_FIELDS = ["capturedAt", "capturedAtOffset", "colorProfile", "orientation"] as const;
export interface RenditionMetadata {
  /** Local capture time without a zone, e.g. 2026-11-01T09:30:00. */
  readonly capturedAt: string | null;
  /** Recorded UTC offset, e.g. +09:00. */
  readonly capturedAtOffset: string | null;
  readonly colorProfile: "sRGB" | "displayP3";
  readonly orientation: 1;
}
/**
 * Normalized key fragments (lowercase, alphanumerics only) that must never reach a rendition, an album response
 * or a download: location, equipment serials and source paths. Everything outside the allow-list is dropped too.
 */
export const FORBIDDEN_RENDITION_METADATA = {
  location: ["gps", "latitude", "longitude", "altitude", "location", "geotag"],
  serial: ["serial", "imageuniqueid", "ownername"],
  path: ["path", "filename", "documentname", "sourcefile", "derivedfrom", "directory"],
} as const;
export type ForbiddenMetadataCategory = keyof typeof FORBIDDEN_RENDITION_METADATA;

export interface RenditionAsset {
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly contentType: "image/jpeg";
  readonly width: number;
  readonly height: number;
  /** A preview or downscale is never published as a rendition (Epic §9). */
  readonly fullResolution: true;
}
export interface ThumbnailAsset {
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly contentType: "image/jpeg";
  readonly width: number;
  readonly height: number;
}
/** One stored rendition per item revision, regardless of how many members can see it. */
export interface Rendition {
  readonly id: RenditionId;
  readonly itemRevision: number;
  readonly asset: RenditionAsset;
  /** Derived from the rendition only; carries no additional metadata. */
  readonly thumbnail: ThumbnailAsset;
  readonly metadata: RenditionMetadata;
  readonly createdAt: Instant;
}

/** Adder-only reference to the original. NIHO never resolves a device reference or compares sources across users. */
export type AlbumItemSource =
  | { readonly kind: "libraryPhoto"; readonly libraryId: LibraryId; readonly photoId: PhotoId }
  | { readonly kind: "devicePhoto"; readonly deviceSourceRef: DeviceSourceRef };
/**
 * Why an item is preparing or waiting for an update. Shown to the album owner and the adder only; other members see
 * the previous rendition as published. quotaExceeded is 準備中（容量不足）: the rendition could not be reserved in the
 * album owner's storage, and rendering resumes when capacity frees.
 */
export const ALBUM_ITEM_PENDING_REASONS = ["rendering", "waitingForHost", "waitingForDevice", "sourceChanged", "quotaExceeded"] as const;
export type AlbumItemPendingReason = (typeof ALBUM_ITEM_PENDING_REASONS)[number];

interface AlbumItemCommon {
  readonly id: AlbumItemId;
  readonly albumId: AlbumId;
  readonly kind: AlbumItemKind;
  /** Kept after the adder leaves or is removed (Epic §3). */
  readonly addedBy: PersonLabel;
  readonly addedAt: Instant;
  /** 0 while preparing; every committed rendition creates the next revision. */
  readonly revision: number;
  /** Adder only. null for everyone else and for fileUpload items. */
  readonly source: AlbumItemSource | null;
}
export type AlbumItem =
  | (AlbumItemCommon & { readonly state: "preparing"; readonly rendition: null; readonly pendingReason: AlbumItemPendingReason })
  | (AlbumItemCommon & { readonly state: "published"; readonly rendition: Rendition })
  | (AlbumItemCommon & {
      readonly state: "updatePending";
      readonly rendition: Rendition;
      readonly pendingReason: AlbumItemPendingReason;
    })
  /** Tombstone for current members holding the ID. Lists never include it; late uploads/jobs never revive it. */
  | (AlbumItemCommon & { readonly state: "removed"; readonly rendition: null; readonly removedAt: Instant });
export interface AlbumItemPage {
  readonly items: readonly AlbumItem[];
  readonly nextCursor: string | null;
  readonly albumRevision: number;
  readonly membershipRevision: number;
}

/** Server-held logical item. Never returned directly; see `projectAlbumItem` in ./policy. */
export interface AlbumItemSnapshot {
  readonly id: AlbumItemId;
  readonly albumId: AlbumId;
  readonly kind: AlbumItemKind;
  readonly addedBy: LedgerPerson;
  readonly addedAt: Instant;
  readonly revision: number;
  readonly state: AlbumItemState;
  readonly source: AlbumItemSource | null;
  readonly rendition: Rendition | null;
  /** Binding of the current rendition; null for fileUpload items. Never projected to members. */
  readonly renditionBinding: RenderBinding | null;
  readonly pendingReason: AlbumItemPendingReason | null;
  readonly removedAt: Instant | null;
  /**
   * Latest accepted add/replace intent. Starting another replace supersedes it, and only this upload may commit,
   * so an older replace that finishes late never overwrites a newer one.
   */
  readonly pendingUpload: { readonly uploadId: UploadId; readonly binding: RenderBinding | null } | null;
}

/** Declared by the uploading host; the server re-validates bytes, dimensions and metadata before publishing. */
export interface RenditionUploadRequest {
  readonly sizeBytes: number;
  readonly sha256: Sha256;
  readonly contentType: (typeof FILE_UPLOAD_CONTENT_TYPES)[number];
  readonly width: number;
  readonly height: number;
  readonly metadata: RenditionMetadata;
}
export interface RenditionUpload {
  readonly id: UploadId;
  readonly albumId: AlbumId;
  readonly itemId: AlbumItemId;
  /** Item revision this upload creates when committed. */
  readonly targetItemRevision: number;
  readonly sizeBytes: number;
  readonly sha256: Sha256;
  readonly expiresAt: Instant;
  readonly state: "reserved" | "verifying" | "committed" | "cancelled" | "expired" | "rejected";
  readonly uploadedBytes: number;
}
export interface RenditionUploadStart {
  readonly upload: RenditionUpload;
  /** #195 bearer ticket; null on replay. Response memory only. */
  readonly ticket: UploadTicket | null;
}
export type AddPhotoSource =
  /** The adder's own NIHO-known photo. NIHO schedules the render on the device holding the original. */
  | { readonly kind: "libraryPhoto"; readonly libraryId: LibraryId; readonly photoId: PhotoId }
  /** The adder's device already rendered a local photo and uploads the rendition. */
  | {
      readonly kind: "devicePhoto";
      readonly deviceSourceRef: DeviceSourceRef;
      readonly binding: RenderBinding;
      readonly rendition: RenditionUploadRequest;
    };
export type ReplaceContent =
  /** Manual replacement of a fileUpload item. */
  | { readonly kind: "file"; readonly rendition: RenditionUploadRequest }
  /** Re-render of a devicePhoto item after the adder saved a new recipe. libraryPhoto items update automatically. */
  | { readonly kind: "deviceRender"; readonly binding: RenderBinding; readonly rendition: RenditionUploadRequest };
export interface AlbumItemMutation {
  readonly item: AlbumItem;
  readonly upload: RenditionUploadStart | null;
}

// ---------------------------------------------------------------------------------------------------------
// Membership and invite links

export type MembershipState = "active" | "left" | "removed";
export interface Membership {
  /** Opaque per-album ID used to change or remove this member. Not derived from the user ID. */
  readonly id: MembershipId;
  readonly albumId: AlbumId;
  readonly member: PersonLabel;
  readonly role: AlbumRole;
  /** left: the member left. removed: the owner removed the member. */
  readonly state: MembershipState;
  readonly revision: number;
  readonly joinedAt: Instant;
  readonly endedAt: Instant | null;
  readonly joinedVia: InviteLinkId | null;
}
export interface MembershipPage {
  readonly items: readonly Membership[];
  readonly nextCursor: string | null;
}
/** Reusable by several people until it expires (7 days) or the owner revokes it (Epic §3). */
export interface InviteLink {
  readonly id: InviteLinkId;
  readonly albumId: AlbumId;
  readonly role: MemberRole;
  readonly createdBy: PersonLabel;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly revoked: boolean;
  readonly revokedAt: Instant | null;
  readonly joinCount: number;
}
export type InviteLinkStatus = "usable" | "expired" | "revoked";
export interface InviteJoinRecord {
  readonly inviteLinkId: InviteLinkId;
  readonly membershipId: MembershipId;
  readonly member: PersonLabel;
  readonly joinedAt: Instant;
}
export interface InviteLinkCreated {
  readonly link: InviteLink;
  /** Only in the first response. null on replay; revoke that link and create another. */
  readonly secret: InviteSecret | null;
}
export interface InviteJoinResult {
  readonly album: Album;
  readonly membership: Membership;
  /** false when the actor was already an active member; the role is unchanged. */
  readonly joined: boolean;
}
/** Owner-facing event on every join. The delivery channel is outside this contract. */
export interface MemberJoinedEvent {
  readonly kind: "memberJoined";
  readonly albumId: AlbumId;
  readonly membershipId: MembershipId;
  readonly member: PersonLabel;
  readonly role: MemberRole;
  readonly inviteLinkId: InviteLinkId;
  readonly at: Instant;
}

// ---------------------------------------------------------------------------------------------------------
// Owner-charged storage outside the personal v2 pool

/**
 * Hosted previews, renditions and export staging, charged to the library/album owner (Epic §3). `quotaBytes` is
 * server policy decided under Epic §14 and is never defaulted to the personal v2 5 GiB pool. Members never see it.
 */
export interface SharedStorageUsage {
  readonly owner: UserRef;
  readonly quotaBytes: number;
  /** previewBytes + maskBytes + renditionBytes + exportStagingBytes. */
  readonly usedBytes: number;
  readonly previewBytes: number;
  /** Mask surfaces of hosted libraries; unlike previews they cannot be regenerated. */
  readonly maskBytes: number;
  readonly renditionBytes: number;
  readonly exportStagingBytes: number;
  readonly reservedBytes: number;
  /** quotaBytes - usedBytes - reservedBytes. */
  readonly availableBytes: number;
}

// ---------------------------------------------------------------------------------------------------------
// Render jobs (preview, rendition, export) on the device that holds the original

export type RenderJobPurpose =
  /** itemRevision: the item revision this job replaces; the commit creates itemRevision + 1. */
  | { readonly kind: "albumItem"; readonly albumId: AlbumId; readonly itemId: AlbumItemId; readonly itemRevision: number }
  | { readonly kind: "preview" }
  | { readonly kind: "export"; readonly exportId: ExportId };
export type RenderExecutor =
  | { readonly kind: "hostedMac"; readonly connectorId: ConnectorId }
  /** The adder's own signed-in device (Mac app or browser) that holds the original. */
  | { readonly kind: "userDevice"; readonly userId: UserId };
export type RenderJobState = "queued" | "waitingForHost" | "claimed" | "committed" | "failed" | "superseded" | "cancelled";
export type RenderFailureCode =
  | "decoder_failed"
  | "unsupported_format"
  | "unsupported_settings"
  | "renderer_unavailable"
  | "source_missing"
  | "source_changed"
  | "full_resolution_unavailable"
  | "input_limit";
export interface RenderJob {
  readonly id: RenderJobId;
  readonly purpose: RenderJobPurpose;
  readonly executor: RenderExecutor;
  readonly photo: { readonly libraryId: LibraryId; readonly photoId: PhotoId };
  readonly binding: RenderBinding;
  /** Exact recipe to render (#196). Executors never substitute another revision. */
  readonly recipe: RecipeDocument;
  readonly state: RenderJobState;
  readonly attempt: number;
  readonly createdAt: Instant;
  readonly leaseExpiresAt: Instant | null;
  readonly failure: RenderFailureCode | null;
  /**
   * Full-resolution size of a rendition, computed by NIHO from the source size and the recipe geometry with the
   * engine's own rule. The commit decodes the uploaded bytes and rejects any other size (content_rejected). null for
   * previews and when the source size is not known yet.
   */
  readonly expectedOutput: { readonly width: number; readonly height: number } | null;
}
/** One claim. leaseToken is bearer material for this claim only; memory only. */
export interface RenderLease {
  readonly jobId: RenderJobId;
  readonly leaseToken: string;
  readonly expiresAt: Instant;
}
export interface ClaimedRenderJob {
  readonly job: RenderJob;
  readonly lease: RenderLease;
}
export type RenderOutputRequest =
  | ({ readonly kind: "rendition" } & RenditionUploadRequest)
  | {
      readonly kind: "preview";
      readonly sizeBytes: number;
      readonly sha256: Sha256;
      readonly contentType: PreviewAsset["contentType"];
      readonly width: number;
      readonly height: number;
    };
/**
 * One output upload of a claimed job, with its storage reservation. A replay of the same startOutput returns
 * `ticket: null`: continue that upload with renderJobs.renewOutput, or start another output with a new key, which
 * supersedes this one and releases its reservation at once. A failed job or an expired lease releases it too.
 */
export interface RenderOutputUploadStart {
  readonly uploadId: UploadId;
  readonly expiresAt: Instant;
  /** #195 bearer ticket; null on replay. */
  readonly ticket: UploadTicket | null;
}

// ---------------------------------------------------------------------------------------------------------
// Connector protocol (outbound only: every call is initiated by the Mac)

export interface IndexEntry {
  /** Connector-derived opaque key for a regular file under a registered root. Never a path or inode. */
  readonly localKey: string;
  /** Base name for the owner only. */
  readonly fileName: string;
  readonly source: SourceIdentity;
  readonly capturedAt: Instant | null;
  readonly availability: SourceAvailability;
}
export interface IndexResult {
  readonly localKey: string;
  readonly photoId: PhotoId;
  /** excluded entries stay excluded; a rescan never revives them. */
  readonly state: "added" | "updated" | "unchanged" | "excluded";
}
/** NIHO metadata replicated to the hosted Mac (Epic §4). The replica is a copy; it never becomes canonical. */
export type ReplicaEntity = "photo" | "recipe" | "mask" | "albumDefinition" | "exclusion";
/** Canonical index record of one photo. localKey is the connector's own opaque key, never a path. */
export interface ReplicaPhotoRecord {
  readonly localKey: string;
  readonly fileName: string;
  readonly source: SourceIdentity;
  readonly capturedAt: Instant | null;
  readonly addedAt: Instant;
}
export interface ReplicaRecipeRecord {
  readonly recipe: RecipeDocument;
  readonly recipeSourceGeneration: number;
}
/** Mask bytes are fetched with connector.getReplicaContent and verified against surfaceId (their SHA-256). */
export interface ReplicaMaskRecord {
  readonly photoId: PhotoId;
  readonly surfaceId: Sha256;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
}
/** The owner's album definition restricted to this library's photos: no members, renditions or other sources. */
export interface ReplicaAlbumDefinition {
  readonly name: string;
  readonly revision: number;
  readonly items: readonly { readonly itemId: AlbumItemId; readonly photoId: PhotoId }[];
}
export interface ReplicaExclusion {
  readonly excludedAt: Instant;
}
type ReplicaUpsert<Entity extends ReplicaEntity, Body> = {
  readonly revision: number;
  readonly op: "upsert";
  readonly entity: Entity;
  /** Opaque per entity: photoId for photo/recipe/exclusion, albumId for albums, a server key for masks. */
  readonly id: string;
  readonly body: Body;
};
export type ReplicaChange =
  | ReplicaUpsert<"photo", ReplicaPhotoRecord>
  | ReplicaUpsert<"recipe", ReplicaRecipeRecord>
  | ReplicaUpsert<"mask", ReplicaMaskRecord>
  | ReplicaUpsert<"albumDefinition", ReplicaAlbumDefinition>
  | ReplicaUpsert<"exclusion", ReplicaExclusion>
  | { readonly revision: number; readonly op: "delete"; readonly entity: ReplicaEntity; readonly id: string };
/**
 * Changes after sinceRevision in revision order, up to nextRevision; deletions arrive as tombstones. A
 * sinceRevision older than the retained tombstones (or ahead of NIHO) is replica_reset_required.
 * sinceRevision 0 is a snapshot of the current state: continue it with the returned cursor (and sinceRevision 0)
 * until complete. A snapshot cursor outlived by compaction is replica_reset_required and the snapshot restarts.
 */
export interface ReplicaPage {
  readonly sinceRevision: number;
  readonly changes: readonly ReplicaChange[];
  readonly nextRevision: number;
  readonly complete: boolean;
  /** Snapshot continuation only; null for diffs and on the last snapshot page. */
  readonly cursor: string | null;
}

/** Mask surface of a hosted photo uploaded to NIHO before a recipe that references it can be saved. */
export interface HostedMaskUpload {
  readonly id: UploadId;
  readonly libraryId: LibraryId;
  readonly photoId: PhotoId;
  readonly surfaceId: Sha256;
  readonly sizeBytes: number;
  readonly expiresAt: Instant;
  readonly state: "reserved" | "verifying" | "stored" | "cancelled" | "expired" | "rejected";
}

/** Metadata sent before the connector uploads canonical working-copy bytes. The server assigns the asset ID/kind. */
export type HostedWorkingCopyInput = Omit<WorkingCopy, "asset"> & { readonly asset: Omit<PhotoAsset, "id" | "kind"> };
export interface HostedWorkingCopyUpload {
  readonly id: UploadId;
  readonly photoId: PhotoId;
  readonly sourceGeneration: number;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly expiresAt: Instant;
  readonly state: "reserved" | "verifying" | "stored" | "cancelled" | "expired" | "rejected";
}
export interface HostedWorkingCopyCommit {
  readonly photoId: PhotoId;
  readonly sourceGeneration: number;
  readonly workingCopy: WorkingCopy;
}

// ---------------------------------------------------------------------------------------------------------
// Portability (owner-only, B01)

/** Never in an export: credentials, upload/download tickets, sessions, invite secrets or membership grants. */
export const PORTABLE_EXPORT_EXCLUDES = ["credentials", "tickets", "sessions", "inviteSecrets", "memberships"] as const;
export interface PortablePhoto {
  readonly photoId: PhotoId;
  readonly source: SourceIdentity;
  readonly recipe: RecipeDocument;
  readonly recipeSourceGeneration: number;
  readonly masks: readonly { readonly surfaceId: Sha256; readonly sizeBytes: number }[];
  readonly original: { readonly included: boolean; readonly sha256: Sha256 | null };
}
export type PortableAlbumItem =
  /** Added by the exporting album owner; the owner's own source reference may be exported. */
  | { readonly itemId: AlbumItemId; readonly kind: "ownerPhoto"; readonly source: AlbumItemSource | null; readonly renditionSha256: Sha256 | null }
  /** Added by a member or as a finished file. A member's source reference is never exported. */
  | { readonly itemId: AlbumItemId; readonly kind: "memberEdit" | "fileUpload"; readonly source: null; readonly renditionSha256: Sha256 | null };
export interface PortableAlbum {
  readonly albumId: AlbumId;
  readonly name: string;
  readonly revision: number;
  readonly items: readonly PortableAlbumItem[];
}
export interface PortableLibraryManifest {
  readonly format: "niho-photo-library";
  readonly formatVersion: 1;
  /** metadata: references and hashes only. full: originals included. */
  readonly mode: "metadata" | "full";
  readonly library: { readonly id: LibraryId; readonly kind: ServerLibrary["kind"]; readonly metadataRevision: number };
  readonly createdAt: Instant;
  readonly engines: readonly string[];
  readonly photos: readonly PortablePhoto[];
  readonly albums: readonly PortableAlbum[];
}
export interface PortableExport {
  readonly id: PortableExportId;
  readonly libraryId: LibraryId;
  readonly mode: PortableLibraryManifest["mode"];
  readonly state: "preparing" | "ready" | "failed" | "expired";
  readonly manifestSha256: Sha256 | null;
  readonly expiresAt: Instant | null;
}
export interface RestoreReport {
  readonly libraryId: LibraryId;
  readonly restoredPhotos: number;
  readonly restoredAlbums: number;
  /** Items where NIHO already held something newer; a restore never downgrades a recipe or album. */
  readonly keptNewer: number;
  /** Access is re-read from the current ledger. A snapshot never grants membership. */
  readonly membershipsRestored: 0;
  readonly mismatches: readonly { readonly photoId: PhotoId; readonly reason: "hash_mismatch" | "source_missing" | "mask_missing" }[];
}

// ---------------------------------------------------------------------------------------------------------
// Errors and recovery

export const SHARING_ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  origin_rejected: 403,
  role_forbidden: 403,
  not_found: 404,
  revision_conflict: 409,
  idempotency_conflict: 409,
  quota_exceeded: 409,
  stale_render: 409,
  lease_expired: 409,
  account_deleting: 409,
  item_removed: 410,
  invite_unavailable: 410,
  pairing_unavailable: 410,
  upload_expired: 410,
  cursor_expired: 410,
  replica_reset_required: 410,
  request_too_large: 413,
  unsupported_format: 415,
  content_rejected: 422,
  unsupported_settings: 422,
  missing_mask_surface: 422,
  rate_limited: 429,
  temporarily_unavailable: 503,
} as const;
export type SharingErrorCode = keyof typeof SHARING_ERROR_STATUS;

/**
 * What the client does next. A lost response is not a code: replay the same operation with the same key and
 * payload, and accept the server's `replayed` receipt instead of starting a new operation.
 */
export type SharingRecovery =
  | "retrySameKey"
  | "reauthenticate"
  | "refreshAccess"
  | "refreshAndDecide"
  | "restartList"
  | "discardResult"
  | "askOwner"
  | "restartPairing"
  | "resyncReplica"
  | "fixRequest"
  | "stop";
export const SHARING_ERROR_RECOVERY = {
  invalid_request: "fixRequest",
  invalid_cursor: "restartList",
  unauthenticated: "reauthenticate",
  origin_rejected: "stop",
  role_forbidden: "refreshAccess",
  not_found: "refreshAccess",
  revision_conflict: "refreshAndDecide",
  idempotency_conflict: "stop",
  quota_exceeded: "stop",
  stale_render: "discardResult",
  lease_expired: "discardResult",
  account_deleting: "stop",
  item_removed: "refreshAccess",
  invite_unavailable: "askOwner",
  pairing_unavailable: "restartPairing",
  upload_expired: "fixRequest",
  cursor_expired: "restartList",
  replica_reset_required: "resyncReplica",
  request_too_large: "fixRequest",
  unsupported_format: "fixRequest",
  content_rejected: "fixRequest",
  unsupported_settings: "stop",
  missing_mask_surface: "fixRequest",
  rate_limited: "retrySameKey",
  temporarily_unavailable: "retrySameKey",
} as const satisfies { readonly [C in SharingErrorCode]: SharingRecovery };

export interface SharingErrorEnvelope {
  readonly error: {
    readonly code: SharingErrorCode;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly currentRevision?: number;
    readonly retryAfterSeconds?: number;
    /** Album owner only. Members receive quota_exceeded without numbers (「アルバムがいっぱいです」). */
    readonly storage?: { readonly availableBytes: number; readonly requiredBytes: number };
  };
}

// ---------------------------------------------------------------------------------------------------------
// Operations

type Empty = Readonly<Record<string, never>>;
type Operation<Request, Response> = { readonly request: Request; readonly response: Response };
type Page = { readonly cursor?: string; readonly limit?: number };
type AlbumRef = { readonly albumId: AlbumId };
type ItemRef = AlbumRef & { readonly itemId: AlbumItemId };
type HostedPhotoRef = { readonly libraryId: LibraryId; readonly photoId: PhotoId };

/** Signed-in user operations. Every request object is closed; owner, role and locators are never accepted as proof. */
export interface SharingOperationMap {
  readonly "libraries.list": Operation<Empty, { readonly items: readonly ServerLibrary[] }>;
  readonly "libraries.get": Operation<{ readonly libraryId: LibraryId }, ServerLibrary>;
  readonly "storage.get": Operation<Empty, SharedStorageUsage>;
  readonly "connectors.approvePairing": Operation<
    { readonly userCode: string; readonly target: ConnectorPairingTarget },
    MutationReceipt<HostConnector>
  >;
  readonly "connectors.get": Operation<{ readonly connectorId: ConnectorId }, HostConnector>;
  /** Stops access and fences the credential. Originals on the Mac are never deleted. */
  readonly "connectors.revoke": Operation<{ readonly connectorId: ConnectorId }, MutationReceipt<HostConnector>>;

  readonly "hostedPhotos.list": Operation<
    { readonly libraryId: LibraryId; readonly sort?: "added-desc" | "captured-desc" } & Page,
    HostedPhotoPage
  >;
  readonly "hostedPhotos.get": Operation<HostedPhotoRef, HostedPhoto>;
  readonly "hostedPhotos.info": Operation<HostedPhotoRef, PhotoInfo>;
  /** Previews and working copies only. Originals are not served from NIHO in v1 (B04). */
  readonly "hostedPhotos.content": Operation<
    HostedPhotoRef & { readonly assetId: AssetId; readonly range?: PhotoByteRange },
    PhotoContent
  >;
  readonly "hostedPhotos.exclude": Operation<HostedPhotoRef, MutationReceipt<HostedPhoto>>;
  readonly "hostedMasks.startUpload": Operation<
    HostedPhotoRef & { readonly surfaceId: Sha256; readonly sizeBytes: number; readonly width: number; readonly height: number },
    MutationReceipt<{ readonly upload: HostedMaskUpload; readonly ticket: UploadTicket | null }>
  >;
  readonly "hostedMasks.completeUpload": Operation<HostedPhotoRef & { readonly uploadId: UploadId }, MutationReceipt<HostedMaskUpload>>;
  /** Saved only when every referenced mask is stored (missing_mask_surface otherwise); never partially. */
  readonly "hostedRecipes.put": Operation<
    HostedPhotoRef & {
      readonly expectedRevision: number;
      readonly sourceGeneration: number;
      readonly settings: RecipeDocument["settings"];
      readonly baseVersion: string | null;
    },
    MutationReceipt<HostedRecipeSave>
  >;
  readonly "hostedRecipeConflicts.list": Operation<HostedPhotoRef & Page, RecipeConflictPage>;
  readonly "hostedRecipeConflicts.get": Operation<HostedPhotoRef & { readonly conflictId: RecipeConflictId }, RecipeConflict>;
  readonly "hostedRecipeConflicts.resolve": Operation<
    HostedPhotoRef & {
      readonly conflictId: RecipeConflictId;
      readonly expectedRevision: number;
      readonly decision: "adopt" | "keep-current";
    },
    MutationReceipt<RecipeConflictResolution>
  >;
  readonly "exports.request": Operation<HostedPhotoRef & { readonly recipeRevision: number }, MutationReceipt<FullResolutionExport>>;
  readonly "exports.get": Operation<{ readonly exportId: ExportId }, FullResolutionExport>;
  readonly "exports.content": Operation<{ readonly exportId: ExportId; readonly range?: PhotoByteRange }, PhotoContent>;
  readonly "portability.export": Operation<
    { readonly libraryId: LibraryId; readonly mode: PortableLibraryManifest["mode"] },
    MutationReceipt<PortableExport>
  >;
  readonly "portability.get": Operation<{ readonly exportId: PortableExportId }, PortableExport>;
  /** Owner-only byte stream for the ready portable archive, including its manifest. */
  readonly "portability.content": Operation<{ readonly exportId: PortableExportId; readonly range?: PhotoByteRange }, PhotoContent>;
  readonly "portability.restore": Operation<
    { readonly libraryId: LibraryId; readonly manifestSha256: Sha256 },
    MutationReceipt<RestoreReport>
  >;

  readonly "albums.list": Operation<Page, AlbumPage>;
  readonly "albums.get": Operation<AlbumRef, Album>;
  readonly "albums.create": Operation<{ readonly name: string }, MutationReceipt<Album>>;
  readonly "albums.rename": Operation<AlbumRef & { readonly expectedRevision: number; readonly name: string }, MutationReceipt<Album>>;
  /** Removes renditions. Originals, the owner's library and members' devices are untouched. */
  readonly "albums.delete": Operation<
    AlbumRef & { readonly expectedRevision: number },
    MutationReceipt<{ readonly albumId: AlbumId; readonly state: "deleted" }>
  >;

  readonly "albumItems.list": Operation<AlbumRef & Page, AlbumItemPage>;
  readonly "albumItems.get": Operation<ItemRef, AlbumItem>;
  readonly "albumItems.addPhoto": Operation<AlbumRef & { readonly source: AddPhotoSource }, MutationReceipt<AlbumItemMutation>>;
  readonly "albumItems.addFile": Operation<AlbumRef & { readonly rendition: RenditionUploadRequest }, MutationReceipt<AlbumItemMutation>>;
  readonly "albumItems.replace": Operation<
    ItemRef & { readonly expectedRevision: number; readonly content: ReplaceContent },
    MutationReceipt<AlbumItemMutation>
  >;
  /** Revalidates the adder's current role, the item and the target revision before publishing. */
  readonly "albumItems.commitUpload": Operation<AlbumRef & { readonly uploadId: UploadId }, MutationReceipt<AlbumItem>>;
  readonly "albumItems.cancelUpload": Operation<AlbumRef & { readonly uploadId: UploadId }, MutationReceipt<RenditionUpload>>;
  /** Removes the item from the album only. The adder's original and the owner's library photo stay. */
  readonly "albumItems.remove": Operation<ItemRef, MutationReceipt<AlbumItem>>;
  /** Full-size rendition or its thumbnail, as a bounded stream. */
  readonly "albumItems.download": Operation<
    ItemRef & { readonly renditionId: RenditionId; readonly variant: "full" | "thumbnail"; readonly range?: PhotoByteRange },
    PhotoContent
  >;

  readonly "invites.list": Operation<
    AlbumRef,
    { readonly links: readonly InviteLink[]; readonly joins: readonly InviteJoinRecord[] }
  >;
  readonly "invites.create": Operation<AlbumRef & { readonly role: MemberRole }, MutationReceipt<InviteLinkCreated>>;
  readonly "invites.revoke": Operation<AlbumRef & { readonly inviteLinkId: InviteLinkId }, MutationReceipt<InviteLink>>;
  /** Requires a signed-in user. Rate limited. */
  readonly "invites.join": Operation<{ readonly secret: InviteSecret }, MutationReceipt<InviteJoinResult>>;
  readonly "members.list": Operation<AlbumRef & Page, MembershipPage>;
  readonly "members.changeRole": Operation<
    AlbumRef & { readonly membershipId: MembershipId; readonly expectedRevision: number; readonly role: MemberRole },
    MutationReceipt<Membership>
  >;
  readonly "members.remove": Operation<AlbumRef & { readonly membershipId: MembershipId }, MutationReceipt<Membership>>;
  readonly "members.leave": Operation<AlbumRef, MutationReceipt<Membership>>;
}
export type SharingOperation = keyof SharingOperationMap;

/** Called by the hosted Mac connector (outbound) or by a signed-in device that holds an original. */
export interface RenderExecutorOperationMap {
  /**
   * purposes: only jobs this executor can run (for example, a connector without a renderer takes previews only).
   * prefer: photos on screen right now, served first when they have queued jobs; a hint, never authority.
   * A claim is keyed: replaying it returns the same jobs and leases while they are still held, so a lost response
   * does not strand jobs until their leases expire.
   */
  readonly "renderJobs.claim": Operation<
    {
      readonly maxJobs?: number;
      readonly purposes?: readonly RenderJobPurpose["kind"][];
      readonly prefer?: { readonly photoIds: readonly PhotoId[] };
    },
    MutationReceipt<{ readonly jobs: readonly ClaimedRenderJob[] }>
  >;
  /** A fresh ticket for the same output upload (resume offset included); the reservation is unchanged. */
  readonly "renderJobs.renewOutput": Operation<
    { readonly jobId: RenderJobId; readonly leaseToken: string; readonly uploadId: UploadId },
    { readonly uploadId: UploadId; readonly expiresAt: Instant; readonly ticket: UploadTicket }
  >;
  readonly "renderJobs.startOutput": Operation<
    { readonly jobId: RenderJobId; readonly leaseToken: string; readonly output: RenderOutputRequest },
    MutationReceipt<RenderOutputUploadStart>
  >;
  /** Rejected unless the job binding still equals the target's current binding (no stale overwrite). */
  readonly "renderJobs.commit": Operation<
    { readonly jobId: RenderJobId; readonly leaseToken: string; readonly uploadId: UploadId },
    MutationReceipt<RenderJob>
  >;
  readonly "renderJobs.fail": Operation<
    { readonly jobId: RenderJobId; readonly leaseToken: string; readonly code: RenderFailureCode },
    MutationReceipt<RenderJob>
  >;
}
export type RenderExecutorOperation = keyof RenderExecutorOperationMap;
export type RenderExecutorMutationOperation = Exclude<RenderExecutorOperation, "renderJobs.renewOutput">;
export type RenderExecutorRequestOptions<K extends RenderExecutorOperation> = { readonly signal: AbortSignal } &
  (K extends RenderExecutorMutationOperation ? { readonly idempotencyKey: string } : { readonly idempotencyKey?: never });

/** Hosted Mac connector protocol. The connector initiates every call; NIHO never connects to the Mac. */
export interface ConnectorOperationMap extends RenderExecutorOperationMap {
  /** Unauthenticated and rate limited; creates no library or credential until the owner approves. */
  readonly "connector.startPairing": Operation<
    { readonly platform: "macos"; readonly displayName: string; readonly pollSecretSha256: Sha256; readonly credentialSha256: Sha256 },
    MutationReceipt<ConnectorPairingStart>
  >;
  /** Presents the poll secret whose SHA-256 was registered at start. */
  readonly "connector.pollPairing": Operation<{ readonly pairingId: PairingId; readonly pollSecret: string }, ConnectorPairingPoll>;
  readonly "connector.rotateCredential": Operation<
    { readonly nextCredentialSha256: Sha256 },
    MutationReceipt<ConnectorCredentialRotation>
  >;
  readonly "connector.heartbeat": Operation<
    {
      readonly state: Exclude<HostConnectorState, "unreachable">;
      readonly renderer: RenderCapability | null;
      readonly replicaRevision: number;
    },
    { readonly serverTime: Instant; readonly metadataRevision: number; readonly queuedJobs: number }
  >;
  readonly "connector.putIndex": Operation<{ readonly entries: readonly IndexEntry[] }, MutationReceipt<{ readonly results: readonly IndexResult[] }>>;
  readonly "connector.pullReplica": Operation<
    { readonly sinceRevision: number; readonly limit?: number; readonly cursor?: string },
    ReplicaPage
  >;
  /** Acknowledges a NIHO revision. The replica never writes back over NIHO. */
  readonly "connector.ackReplica": Operation<{ readonly revision: number }, MutationReceipt<LibraryReplicaStatus>>;
  /** Mask bytes for the replica, verified against the surface SHA-256. Originals never travel this way. */
  readonly "connector.getReplicaContent": Operation<
    { readonly entity: "mask"; readonly id: string; readonly range?: PhotoByteRange },
    PhotoContent
  >;
  /** Upload the SDK's canonical working-copy bytes and opening metadata for the exact source generation. */
  readonly "connector.startWorkingCopyUpload": Operation<
    { readonly photoId: PhotoId; readonly sourceGeneration: number; readonly workingCopy: HostedWorkingCopyInput },
    MutationReceipt<{ readonly upload: HostedWorkingCopyUpload; readonly ticket: UploadTicket | null }>
  >;
  /** Publishes the uploaded copy only if its source generation still matches the hosted photo. */
  readonly "connector.completeWorkingCopyUpload": Operation<
    { readonly photoId: PhotoId; readonly uploadId: UploadId },
    MutationReceipt<HostedWorkingCopyCommit>
  >;
}
export type ConnectorOperation = keyof ConnectorOperationMap;

export type SharingMutationOperation = {
  [K in SharingOperation]: SharingOperationMap[K]["response"] extends MutationReceipt<unknown> ? K : never;
}[SharingOperation];
export type ConnectorMutationOperation = {
  [K in ConnectorOperation]: ConnectorOperationMap[K]["response"] extends MutationReceipt<unknown> ? K : never;
}[ConnectorOperation];

export type SharingRequestOptions<K extends SharingOperation> = { readonly signal: AbortSignal } &
  (K extends SharingMutationOperation ? { readonly idempotencyKey: string } : { readonly idempotencyKey?: never });
export type ConnectorRequestOptions<K extends ConnectorOperation> = { readonly signal: AbortSignal } &
  (K extends ConnectorMutationOperation ? { readonly idempotencyKey: string } : { readonly idempotencyKey?: never });

/** Issued by a trusted host from the verified session. Selectors/fences only, never server authority. */
export interface SharingSessionScope {
  readonly actorId: UserId;
  readonly sessionEpoch: VerifiedPhotoActor["sessionEpoch"];
}
/** Albums span libraries, so the scope is the user session, not a library. */
export interface PhotoLibrarySharingClient {
  readonly scope: SharingSessionScope;
  request<K extends SharingOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
  /** Same executor protocol as the connector, restricted to jobs whose executor is this user's device. */
  render<K extends RenderExecutorOperation>(
    operation: K,
    request: RenderExecutorOperationMap[K]["request"],
    options: RenderExecutorRequestOptions<K>,
  ): Promise<RenderExecutorOperationMap[K]["response"]>;
  dispose(): void;
}
export interface HostConnectorClient {
  readonly scope: { readonly connectorId: ConnectorId; readonly libraryId: LibraryId; readonly credentialGeneration: number } | null;
  request<K extends ConnectorOperation>(
    operation: K,
    request: ConnectorOperationMap[K]["request"],
    options: ConnectorRequestOptions<K>,
  ): Promise<ConnectorOperationMap[K]["response"]>;
  dispose(): void;
}

/**
 * Who may call each operation. `album` operations resolve the role from the server ledger; `removeItem`
 * resolves to removeOwnItem/removeOthersItem by the item's adder.
 */
export type OperationAccess =
  | { readonly actor: "user"; readonly scope: "self" }
  | { readonly actor: "user"; readonly scope: "libraryOwner" }
  /** requiresOwnSource: a libraryPhoto source must belong to the actor (album roles never reach another library). */
  | { readonly actor: "user"; readonly scope: "album"; readonly action: AlbumAction | "removeItem"; readonly requiresOwnSource?: true }
  | { readonly actor: "user"; readonly scope: "inviteSecret" }
  | { readonly actor: "connectorOrUserDevice"; readonly scope: "renderExecutor" }
  | { readonly actor: "anonymousConnector"; readonly scope: "pairing" }
  | { readonly actor: "connector"; readonly scope: "ownLibrary" };

export const SHARING_OPERATION_ACCESS = {
  "libraries.list": { actor: "user", scope: "self" },
  "libraries.get": { actor: "user", scope: "libraryOwner" },
  "storage.get": { actor: "user", scope: "self" },
  "connectors.approvePairing": { actor: "user", scope: "self" },
  "connectors.get": { actor: "user", scope: "libraryOwner" },
  "connectors.revoke": { actor: "user", scope: "libraryOwner" },
  "hostedPhotos.list": { actor: "user", scope: "libraryOwner" },
  "hostedPhotos.get": { actor: "user", scope: "libraryOwner" },
  "hostedPhotos.info": { actor: "user", scope: "libraryOwner" },
  "hostedPhotos.content": { actor: "user", scope: "libraryOwner" },
  "hostedPhotos.exclude": { actor: "user", scope: "libraryOwner" },
  "hostedMasks.startUpload": { actor: "user", scope: "libraryOwner" },
  "hostedMasks.completeUpload": { actor: "user", scope: "libraryOwner" },
  "hostedRecipes.put": { actor: "user", scope: "libraryOwner" },
  "hostedRecipeConflicts.list": { actor: "user", scope: "libraryOwner" },
  "hostedRecipeConflicts.get": { actor: "user", scope: "libraryOwner" },
  "hostedRecipeConflicts.resolve": { actor: "user", scope: "libraryOwner" },
  "exports.request": { actor: "user", scope: "libraryOwner" },
  "exports.get": { actor: "user", scope: "libraryOwner" },
  "exports.content": { actor: "user", scope: "libraryOwner" },
  "portability.export": { actor: "user", scope: "libraryOwner" },
  "portability.get": { actor: "user", scope: "libraryOwner" },
  "portability.content": { actor: "user", scope: "libraryOwner" },
  "portability.restore": { actor: "user", scope: "libraryOwner" },
  "albums.list": { actor: "user", scope: "self" },
  "albums.get": { actor: "user", scope: "album", action: "view" },
  "albums.create": { actor: "user", scope: "self" },
  "albums.rename": { actor: "user", scope: "album", action: "renameAlbum" },
  "albums.delete": { actor: "user", scope: "album", action: "deleteAlbum" },
  "albumItems.list": { actor: "user", scope: "album", action: "view" },
  "albumItems.get": { actor: "user", scope: "album", action: "view" },
  "albumItems.addPhoto": { actor: "user", scope: "album", action: "addItem", requiresOwnSource: true },
  "albumItems.addFile": { actor: "user", scope: "album", action: "addItem" },
  "albumItems.replace": { actor: "user", scope: "album", action: "replaceOwnItem" },
  "albumItems.commitUpload": { actor: "user", scope: "album", action: "addItem" },
  "albumItems.cancelUpload": { actor: "user", scope: "album", action: "view" },
  "albumItems.remove": { actor: "user", scope: "album", action: "removeItem" },
  "albumItems.download": { actor: "user", scope: "album", action: "download" },
  "invites.list": { actor: "user", scope: "album", action: "manageInvites" },
  "invites.create": { actor: "user", scope: "album", action: "manageInvites" },
  "invites.revoke": { actor: "user", scope: "album", action: "manageInvites" },
  "invites.join": { actor: "user", scope: "inviteSecret" },
  "members.list": { actor: "user", scope: "album", action: "view" },
  "members.changeRole": { actor: "user", scope: "album", action: "changeRole" },
  "members.remove": { actor: "user", scope: "album", action: "removeMember" },
  "members.leave": { actor: "user", scope: "album", action: "leave" },
} as const satisfies { readonly [K in SharingOperation]: OperationAccess };

export const CONNECTOR_OPERATION_ACCESS = {
  "connector.startPairing": { actor: "anonymousConnector", scope: "pairing" },
  "connector.pollPairing": { actor: "anonymousConnector", scope: "pairing" },
  "connector.rotateCredential": { actor: "connector", scope: "ownLibrary" },
  "connector.heartbeat": { actor: "connector", scope: "ownLibrary" },
  "connector.putIndex": { actor: "connector", scope: "ownLibrary" },
  "connector.pullReplica": { actor: "connector", scope: "ownLibrary" },
  "connector.ackReplica": { actor: "connector", scope: "ownLibrary" },
  "connector.getReplicaContent": { actor: "connector", scope: "ownLibrary" },
  "connector.startWorkingCopyUpload": { actor: "connector", scope: "ownLibrary" },
  "connector.completeWorkingCopyUpload": { actor: "connector", scope: "ownLibrary" },
  "renderJobs.claim": { actor: "connectorOrUserDevice", scope: "renderExecutor" },
  "renderJobs.startOutput": { actor: "connectorOrUserDevice", scope: "renderExecutor" },
  "renderJobs.renewOutput": { actor: "connectorOrUserDevice", scope: "renderExecutor" },
  "renderJobs.commit": { actor: "connectorOrUserDevice", scope: "renderExecutor" },
  "renderJobs.fail": { actor: "connectorOrUserDevice", scope: "renderExecutor" },
} as const satisfies { readonly [K in ConnectorOperation]: OperationAccess };

/**
 * Closed request schema. Keys outside the shape at any depth are invalid_request, never ignored. "open" marks
 * opaque recipe JSON that the #196 recipe validator checks instead. Tagged unions are keyed by `kind`.
 */
export type RequestShape =
  | "value"
  | "open"
  | { readonly fields: RequestFields }
  | { readonly items: RequestShape }
  | { readonly variants: { readonly [kind: string]: RequestFields } };
export type RequestFields = { readonly [key: string]: RequestShape };

const PAGE_FIELDS = { cursor: "value", limit: "value" } as const satisfies RequestFields;
const HOSTED_PHOTO_FIELDS = { libraryId: "value", photoId: "value" } as const satisfies RequestFields;
const RANGE_SHAPE = { fields: { start: "value", endInclusive: "value" } } as const satisfies RequestShape;
const RENDITION_UPLOAD_FIELDS = {
  sizeBytes: "value", sha256: "value", contentType: "value", width: "value", height: "value",
  metadata: { fields: { capturedAt: "value", capturedAtOffset: "value", colorProfile: "value", orientation: "value" } },
} as const satisfies RequestFields;
const RENDITION_UPLOAD_SHAPE = { fields: RENDITION_UPLOAD_FIELDS } as const satisfies RequestShape;
const BINDING_SHAPE = {
  fields: {
    sourceGeneration: "value", sourceSha256: "value", recipeRevision: "value", settingsSha256: "value", engine: "value",
    rendererManifestSha256: "value", maskSurfaceIds: { items: "value" },
  },
} as const satisfies RequestShape;
const RENDER_CAPABILITY_SHAPE = {
  fields: {
    sdkVersion: "value", crateVersion: "value", manifestSha256: "value", settingsVersions: { items: "value" },
    engines: { items: "value" }, features: { items: "value" }, maskKinds: { items: "value" }, maskSurfaces: "value",
  },
} as const satisfies RequestShape;
const SOURCE_SHAPE = {
  fields: { generation: "value", sha256: "value", sizeBytes: "value", format: "value", width: "value", height: "value" },
} as const satisfies RequestShape;

type ShapeMap<Map extends { readonly [K in keyof Map]: { readonly request: unknown } }> = {
  readonly [K in keyof Map]: { readonly [P in keyof Map[K]["request"]]-?: RequestShape };
};

export const SHARING_REQUEST_SHAPES = {
  "libraries.list": {},
  "libraries.get": { libraryId: "value" },
  "storage.get": {},
  "connectors.approvePairing": {
    userCode: "value",
    target: { variants: { newLibrary: { name: "value" }, existingLibrary: { libraryId: "value" } } },
  },
  "connectors.get": { connectorId: "value" },
  "connectors.revoke": { connectorId: "value" },
  "hostedPhotos.list": { libraryId: "value", sort: "value", ...PAGE_FIELDS },
  "hostedPhotos.get": HOSTED_PHOTO_FIELDS,
  "hostedPhotos.info": HOSTED_PHOTO_FIELDS,
  "hostedPhotos.content": { ...HOSTED_PHOTO_FIELDS, assetId: "value", range: RANGE_SHAPE },
  "hostedPhotos.exclude": HOSTED_PHOTO_FIELDS,
  "hostedMasks.startUpload": { ...HOSTED_PHOTO_FIELDS, surfaceId: "value", sizeBytes: "value", width: "value", height: "value" },
  "hostedMasks.completeUpload": { ...HOSTED_PHOTO_FIELDS, uploadId: "value" },
  "hostedRecipes.put": { ...HOSTED_PHOTO_FIELDS, expectedRevision: "value", sourceGeneration: "value", settings: "open", baseVersion: "value" },
  "hostedRecipeConflicts.list": { ...HOSTED_PHOTO_FIELDS, ...PAGE_FIELDS },
  "hostedRecipeConflicts.get": { ...HOSTED_PHOTO_FIELDS, conflictId: "value" },
  "hostedRecipeConflicts.resolve": { ...HOSTED_PHOTO_FIELDS, conflictId: "value", expectedRevision: "value", decision: "value" },
  "exports.request": { ...HOSTED_PHOTO_FIELDS, recipeRevision: "value" },
  "exports.get": { exportId: "value" },
  "exports.content": { exportId: "value", range: RANGE_SHAPE },
  "portability.export": { libraryId: "value", mode: "value" },
  "portability.get": { exportId: "value" },
  "portability.content": { exportId: "value", range: RANGE_SHAPE },
  "portability.restore": { libraryId: "value", manifestSha256: "value" },
  "albums.list": PAGE_FIELDS,
  "albums.get": { albumId: "value" },
  "albums.create": { name: "value" },
  "albums.rename": { albumId: "value", expectedRevision: "value", name: "value" },
  "albums.delete": { albumId: "value", expectedRevision: "value" },
  "albumItems.list": { albumId: "value", ...PAGE_FIELDS },
  "albumItems.get": { albumId: "value", itemId: "value" },
  "albumItems.addPhoto": {
    albumId: "value",
    source: {
      variants: {
        libraryPhoto: { libraryId: "value", photoId: "value" },
        devicePhoto: { deviceSourceRef: "value", binding: BINDING_SHAPE, rendition: RENDITION_UPLOAD_SHAPE },
      },
    },
  },
  "albumItems.addFile": { albumId: "value", rendition: RENDITION_UPLOAD_SHAPE },
  "albumItems.replace": {
    albumId: "value", itemId: "value", expectedRevision: "value",
    content: {
      variants: {
        file: { rendition: RENDITION_UPLOAD_SHAPE },
        deviceRender: { binding: BINDING_SHAPE, rendition: RENDITION_UPLOAD_SHAPE },
      },
    },
  },
  "albumItems.commitUpload": { albumId: "value", uploadId: "value" },
  "albumItems.cancelUpload": { albumId: "value", uploadId: "value" },
  "albumItems.remove": { albumId: "value", itemId: "value" },
  "albumItems.download": { albumId: "value", itemId: "value", renditionId: "value", variant: "value", range: RANGE_SHAPE },
  "invites.list": { albumId: "value" },
  "invites.create": { albumId: "value", role: "value" },
  "invites.revoke": { albumId: "value", inviteLinkId: "value" },
  "invites.join": { secret: "value" },
  "members.list": { albumId: "value", ...PAGE_FIELDS },
  "members.changeRole": { albumId: "value", membershipId: "value", expectedRevision: "value", role: "value" },
  "members.remove": { albumId: "value", membershipId: "value" },
  "members.leave": { albumId: "value" },
} as const satisfies ShapeMap<SharingOperationMap>;

export const CONNECTOR_REQUEST_SHAPES = {
  "connector.startPairing": { platform: "value", displayName: "value", pollSecretSha256: "value", credentialSha256: "value" },
  "connector.pollPairing": { pairingId: "value", pollSecret: "value" },
  "connector.rotateCredential": { nextCredentialSha256: "value" },
  "connector.heartbeat": { state: "value", renderer: RENDER_CAPABILITY_SHAPE, replicaRevision: "value" },
  "connector.putIndex": {
    entries: { items: { fields: { localKey: "value", fileName: "value", source: SOURCE_SHAPE, capturedAt: "value", availability: "value" } } },
  },
  "connector.pullReplica": { sinceRevision: "value", limit: "value", cursor: "value" },
  "connector.ackReplica": { revision: "value" },
  "connector.getReplicaContent": { entity: "value", id: "value", range: RANGE_SHAPE },
  "connector.startWorkingCopyUpload": {
    photoId: "value", sourceGeneration: "value",
    workingCopy: { fields: {
      baseVersion: "value", encoding: "value", meta: "open",
      asset: { fields: { sha256: "value", sizeBytes: "value", contentType: "value", width: "value", height: "value" } },
    } },
  },
  "connector.completeWorkingCopyUpload": { photoId: "value", uploadId: "value" },
  "renderJobs.claim": { maxJobs: "value", purposes: { items: "value" }, prefer: { fields: { photoIds: { items: "value" } } } },
  "renderJobs.renewOutput": { jobId: "value", leaseToken: "value", uploadId: "value" },
  "renderJobs.startOutput": {
    jobId: "value", leaseToken: "value",
    output: {
      variants: {
        rendition: RENDITION_UPLOAD_FIELDS,
        preview: { sizeBytes: "value", sha256: "value", contentType: "value", width: "value", height: "value" },
      },
    },
  },
  "renderJobs.commit": { jobId: "value", leaseToken: "value", uploadId: "value" },
  "renderJobs.fail": { jobId: "value", leaseToken: "value", code: "value" },
} as const satisfies ShapeMap<ConnectorOperationMap>;

// ---------------------------------------------------------------------------------------------------------
// State transitions. Missing entries are rejected transitions.

export type AlbumItemEvent = "renditionCommitted" | "sourceUpdated" | "remove";
/** removed is terminal: late uploads and jobs never revive an item (Epic §11). */
export const ALBUM_ITEM_TRANSITIONS = {
  preparing: { renditionCommitted: "published", remove: "removed" },
  published: { renditionCommitted: "published", sourceUpdated: "updatePending", remove: "removed" },
  updatePending: { renditionCommitted: "published", sourceUpdated: "updatePending", remove: "removed" },
  removed: {},
} as const satisfies { readonly [S in AlbumItemState]: { readonly [E in AlbumItemEvent]?: AlbumItemState } };

/**
 * Why a preparing/updatePending item waits. Missing entries are rejected; quotaExceeded only clears when capacity
 * frees (or the source changes), never because a host came online.
 */
export type AlbumItemPendingEvent =
  | "hostOffline"
  | "hostOnline"
  | "deviceOffline"
  | "deviceOnline"
  | "sourceChanged"
  | "recipeSaved"
  | "quotaExceeded"
  | "quotaFreed";
export const ALBUM_ITEM_PENDING_TRANSITIONS = {
  rendering: { hostOffline: "waitingForHost", deviceOffline: "waitingForDevice", sourceChanged: "sourceChanged", quotaExceeded: "quotaExceeded" },
  waitingForHost: { hostOnline: "rendering", sourceChanged: "sourceChanged" },
  waitingForDevice: { deviceOnline: "rendering", sourceChanged: "sourceChanged" },
  sourceChanged: { recipeSaved: "rendering" },
  quotaExceeded: { quotaFreed: "rendering", sourceChanged: "sourceChanged" },
} as const satisfies {
  readonly [R in AlbumItemPendingReason]: { readonly [E in AlbumItemPendingEvent]?: AlbumItemPendingReason };
};

export type RenderJobEvent =
  | "claim"
  | "executorOffline"
  | "executorOnline"
  | "commit"
  | "fail"
  | "retry"
  | "leaseExpired"
  | "supersede"
  | "cancel";
export const RENDER_JOB_TRANSITIONS = {
  queued: { claim: "claimed", executorOffline: "waitingForHost", supersede: "superseded", cancel: "cancelled" },
  waitingForHost: { executorOnline: "queued", supersede: "superseded", cancel: "cancelled" },
  claimed: { commit: "committed", fail: "failed", leaseExpired: "queued", supersede: "superseded", cancel: "cancelled" },
  failed: { retry: "queued", supersede: "superseded", cancel: "cancelled" },
  committed: {},
  superseded: {},
  cancelled: {},
} as const satisfies { readonly [S in RenderJobState]: { readonly [E in RenderJobEvent]?: RenderJobState } };

export type MembershipEvent = "changeRole" | "leave" | "remove" | "join";
/** A removed member may rejoin only through a link created after the removal (see decideJoin). */
export const MEMBERSHIP_TRANSITIONS = {
  active: { changeRole: "active", leave: "left", remove: "removed" },
  left: { join: "active" },
  removed: { join: "active" },
} as const satisfies { readonly [S in MembershipState]: { readonly [E in MembershipEvent]?: MembershipState } };

export type HostConnectorEvent = "heartbeat" | "announceSleep" | "heartbeatOverdue";
export const HOST_CONNECTOR_TRANSITIONS = {
  online: { heartbeat: "online", announceSleep: "sleeping", heartbeatOverdue: "unreachable" },
  sleeping: { heartbeat: "online", heartbeatOverdue: "unreachable" },
  unreachable: { heartbeat: "online", announceSleep: "sleeping" },
} as const satisfies { readonly [S in HostConnectorState]: { readonly [E in HostConnectorEvent]?: HostConnectorState } };

export type FullResolutionExportEvent = "hostOnline" | "hostOffline" | "commit" | "fail" | "expire";
export const FULL_RESOLUTION_EXPORT_TRANSITIONS = {
  waitingForHost: { hostOnline: "rendering", expire: "expired" },
  rendering: { hostOffline: "waitingForHost", commit: "ready", fail: "failed" },
  ready: { expire: "expired" },
  failed: {},
  expired: {},
} as const satisfies {
  readonly [S in FullResolutionExport["state"]]: { readonly [E in FullResolutionExportEvent]?: FullResolutionExport["state"] };
};

// ---------------------------------------------------------------------------------------------------------
// Logical server records used by conformance runners. Servers seal them; clients never construct them.

/** Content of an opaque list cursor. Bound to actor, scope, query and membership revision (Epic §6). */
export interface CursorBinding {
  readonly actorId: UserId;
  readonly scope:
    /** accessRevision: account-level revision of the actor's memberships (join, leave, removal, role change). */
    | { readonly kind: "albums"; readonly accessRevision: number }
    | { readonly kind: "album"; readonly albumId: AlbumId; readonly membershipRevision: number }
    | { readonly kind: "members"; readonly albumId: AlbumId; readonly membershipRevision: number }
    | { readonly kind: "library"; readonly libraryId: LibraryId };
  readonly queryDigest: Sha256;
  readonly issuedAt: Instant;
}
/** Replay identity of a mutation: actor + scope + operation + key. The payload digest decides replay vs conflict. */
export interface IdempotencyRecord {
  readonly actor:
    | { readonly kind: "user"; readonly userId: UserId }
    | { readonly kind: "connector"; readonly connectorId: ConnectorId }
    /** Anonymous pairing start: the registered poll-secret hash stands in for the actor. */
    | { readonly kind: "pairingAttempt"; readonly pollSecretSha256: Sha256 };
  readonly scope:
    | { readonly kind: "account" }
    | { readonly kind: "pairing" }
    | { readonly kind: "album"; readonly albumId: AlbumId }
    | { readonly kind: "library"; readonly libraryId: LibraryId };
  readonly operation: SharingMutationOperation | ConnectorMutationOperation;
  readonly key: string;
  readonly payloadSha256: Sha256;
}
