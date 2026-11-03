/** Photo-only client port v2, derived from the audited Editor v1. No HTTP routes or backend implementation. */
export const PHOTO_LIBRARY_CONTRACT_VERSION = 2 as const;
export const PHOTO_LIMITS = {
  quotaBytes: 5 * 1024 ** 3,
  maxFileBytes: 200 * 1024 ** 2,
  maxPixels: 100_000_000,
  browserDirectMaxPixels: 40_000_000,
  workingCopyMaxEdge: 2560,
  previewMaxEdge: 1280,
  thumbnailMaxEdge: 512,
  maxMaskBytes: 8 * 1024 ** 2,
  maxMaskEdge: 4096,
  maxRecipeBytes: 1024 ** 2,
  maxVersionsBytes: 4 * 1024 ** 2,
  maxRecipeBodyBytes: 2 * 1024 ** 2,
  maxVersionsBodyBytes: 5 * 1024 ** 2,
  maxOtherBodyBytes: 64 * 1024,
  maxVersions: 100,
  maxJsonDepth: 32,
  maxFileNameBytes: 255,
  maxVersionNameBytes: 255,
  maxIdempotencyKeyBytes: 128,
  listMaxCount: 60,
  maxPageBytes: 4 * 1024 ** 2,
  maxWorkingCopyMetaBytes: 64 * 1024,
  lookupMaxCount: 100,
  reservationLifetimeSeconds: 30 * 60,
  completionGraceSeconds: 60 * 60,
  downloadTicketMaxSeconds: 10 * 60,
  cursorLifetimeSeconds: 15 * 60,
} as const;

/** Opaque stable NIHO account ID, not an email, spot ID or pairwise OAuth sub. */
export type UserId = string;
/** Server-issued opaque resource IDs. No UUID format or authorization capability is implied. */
export type LibraryId = string;
export type PhotoId = string;
export type AssetId = string;
export type UploadId = string;
export type JobId = string;
export type RecipeConflictId = string;
/** Lowercase 64-character hex; numbers below must be finite safe integers. */
export type Sha256 = string;
export type Instant = string;
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export type JsonObject = { readonly [key: string]: Json };

/** Server-internal port, never deserialized from the public request. */
export interface VerifiedPhotoActor {
  readonly userId: UserId;
  readonly sessionId: string;
  /** Server-issued parent-session/connection revocation generation. Normal credential refresh keeps
   * this logical scope stable; revalidate its active generation before committing a mutation.
   */
  readonly sessionEpoch: string;
  readonly transport: "browser-session" | "mac-bearer";
  readonly expiresAt: Instant;
}

export type PhotoFormat = "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw";
export interface FormatCapability {
  readonly format: PhotoFormat;
  readonly extensions: readonly string[];
  /** True only after a server decoder/provider is installed and accepted. */
  readonly ingest: boolean;
  readonly workingCopy: boolean;
}

export interface RenderCapability {
  readonly sdkVersion: string;
  readonly crateVersion: string;
  readonly manifestSha256: Sha256;
  readonly settingsVersions: readonly number[];
  readonly engines: readonly string[];
  readonly features: readonly string[];
  readonly maskKinds: readonly string[];
  readonly maskSurfaces: boolean;
}

export interface PhotoCapabilities {
  readonly formats: readonly FormatCapability[];
  readonly renderer: RenderCapability;
  readonly edits: boolean;
  readonly versions: boolean;
  readonly maskSurfaces: boolean;
  /** Detection and native export are host/runtime capabilities, not server promises. */
  readonly albums: false;
  readonly publicSharing: false;
}

/** C02 computes the editing intersection once; hosts must not substitute server promises for runtime proof. */
export interface PhotoCapabilityContext {
  readonly server: PhotoCapabilities;
  readonly host: RenderCapability;
}

/** User-visible binary quota; reproducible derivatives and bounded JSON are overhead. */
export interface QuotaUsage {
  readonly quotaBytes: number;
  /** All retained originals + mask surfaces, including pending physical purge. */
  readonly usedBytes: number;
  readonly originalBytes: number;
  readonly maskBytes: number;
  /** Included in usedBytes until the immutable generation is confirmed deleted. */
  readonly pendingPurgeBytes: number;
  /** Includes verification leases; never expire it while a stale worker can commit. */
  readonly reservedBytes: number;
  readonly availableBytes: number;
}

export interface PersonalPhotoLibrary {
  readonly contractVersion: 2;
  readonly id: LibraryId;
  readonly owner: { readonly type: "user"; readonly userId: UserId };
  readonly state: "active" | "deleting";
  readonly revision: number;
  readonly usage: QuotaUsage;
  readonly limits: typeof PHOTO_LIMITS;
  readonly capabilities: PhotoCapabilities;
}

export type AssetKind = "original" | "mask" | "thumbnail" | "preview" | "working-copy";
/** Locator/credential-free metadata. Content is read through content.get. */
export interface PhotoAsset {
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

export type MediaState =
  /** Persisted original whose durable outbox item has not produced a worker job yet. */
  | { readonly state: "pending" }
  | { readonly state: "queued" | "processing"; readonly jobId: JobId }
  | {
      readonly state: "ready";
      readonly thumbnail: PhotoAsset;
      readonly preview: PhotoAsset;
      readonly workingCopy: WorkingCopy | null;
      readonly recipeRevision: number;
      readonly rendererManifestSha256: Sha256;
    }
  | { readonly state: "failed" | "unsupported"; readonly code: "decoder_failed" | "renderer_unavailable" | "unsupported_settings" };

export interface WorkingCopy {
  readonly asset: PhotoAsset;
  readonly baseVersion: string;
  readonly encoding: "png16" | "jpeg8";
  /** Same metadata passed to the pinned SDK's openWorkingCopy; never a preview substitute. */
  readonly meta: JsonObject;
}

/** Preserve the complete JSON. Unknown versions/features are read-only to older clients. */
export interface RecipeDocument {
  readonly revision: number;
  readonly settings: JsonObject & { readonly v: number; readonly engine: string };
  readonly settingsSha256: Sha256;
  readonly baseVersion: string | null;
  /** Hash IDs referenced by settings; all must belong to this photo and exist before CAS. */
  readonly maskSurfaceIds: readonly Sha256[];
  readonly updatedAt: Instant;
}

export interface Photo {
  readonly id: PhotoId;
  readonly libraryId: LibraryId;
  /** Original is durably verified. Media processing is an independent state. */
  readonly storageState: "stored";
  readonly lifecycle: "active";
  readonly fileName: string;
  readonly format: PhotoFormat;
  /** SDK-neutrality check of settings, not simply revision > 0. Unknown settings count as edited. */
  readonly hasEdits: boolean;
  readonly addedAt: Instant;
  readonly capturedAt: Instant | null;
  /** EXIF orientation applied once; original bytes and EXIF remain unchanged. */
  readonly width: number;
  readonly height: number;
  readonly original: PhotoAsset;
  readonly recipe: RecipeDocument;
  readonly media: MediaState;
}

export interface PhotoListQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: "added-desc" | "captured-desc";
  /** Repeated query parameter: formats=heic&formats=heif. */
  readonly formats?: readonly PhotoFormat[];
  readonly edited?: boolean;
  readonly editable?: boolean;
}
/** Owner-only detail, never included in list responses or derivative EXIF. */
export interface PhotoInfo {
  readonly camera?: { readonly make: string | null; readonly model: string | null } | null;
  readonly lens?: string | null;
  readonly iso?: number | null;
  readonly exposureTimeSeconds?: number | null;
  readonly fNumber?: number | null;
  readonly focalLengthMm?: number | null;
  readonly capturedAt?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly gps?: { readonly latitude: number; readonly longitude: number } | null;
}
export interface PhotoPage {
  readonly items: readonly Photo[];
  readonly nextCursor: string | null;
  readonly libraryRevision: number;
  readonly usage: QuotaUsage;
}
export interface PhotoLookupMatch {
  readonly sha256: Sha256;
  readonly photoId: PhotoId;
  readonly recipeRevision: number;
}

export type UploadTarget =
  | { readonly kind: "original"; readonly fileName: string; readonly format: PhotoFormat }
  | { readonly kind: "mask"; readonly photoId: PhotoId };
export interface StartUploadRequest {
  readonly target: UploadTarget;
  readonly sizeBytes: number;
  readonly sha256: Sha256;
  readonly contentType: string;
}
/** Bearer material: response memory only. Never persist/log/cache this object. */
export interface UploadTicket {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Instant;
  readonly resumeOffsetBytes: number;
}
export type StoredUploadResult =
  | { readonly kind: "original"; readonly photo: Photo }
  | { readonly kind: "mask"; readonly photoId: PhotoId; readonly asset: PhotoAsset };
export type Upload = {
  readonly id: UploadId;
  readonly target: UploadTarget;
  readonly sizeBytes: number;
  readonly sha256: Sha256;
  readonly expiresAt: Instant;
} & (
  | { readonly state: "reserved"; readonly uploadedBytes: number }
  | { readonly state: "verifying"; readonly jobId: JobId }
  | { readonly state: "stored"; readonly result: StoredUploadResult }
  | { readonly state: "cancelled" | "expired" }
  | { readonly state: "rejected"; readonly code: "content_rejected" | "unsupported_format" | "pixel_limit_exceeded" }
);
export type StartUploadResponse =
  /** On replay the current upload may be verifying/stored; no stale bearer is replayed. */
  | { readonly kind: "upload"; readonly upload: Upload; readonly ticket: UploadTicket | null }
  | { readonly kind: "existing"; readonly photo: Photo };
export interface MutationReceipt<T> {
  readonly value: T;
  readonly replayed: boolean;
}
export interface NamedVersion {
  readonly id: string;
  readonly name: string;
  readonly kind: "named" | "auto";
  readonly recipe: RecipeDocument;
  readonly createdAt: Instant;
}
export interface VersionSet {
  readonly revision: number;
  readonly versions: readonly NamedVersion[];
}
/** Server-retained stale recipe write; content stays recoverable until its photo is purged. */
export interface RecipeCandidate {
  readonly settings: RecipeDocument["settings"];
  readonly baseVersion: string | null;
  readonly settingsSha256: Sha256;
  readonly maskSurfaceIds: readonly Sha256[];
}
export interface RecipeConflict {
  readonly id: RecipeConflictId;
  /** Revision the writer edited from. */
  readonly expectedRevision: number;
  /** Current recipe revision observed atomically when the stale write arrived. */
  readonly currentRevision: number;
  /** Full stale payload, preserved without normalization. */
  readonly conflictingRecipe: RecipeCandidate;
  /** Exact winning branch at conflict time, retained after later recipe writes. */
  readonly currentRecipe: RecipeDocument;
  readonly createdAt: Instant;
  readonly resolution: "adopt" | "keep-current" | null;
  readonly resolvedAt: Instant | null;
  /** New active recipe revision after adoption, or the retained current revision after keep-current. */
  readonly resultingRevision: number | null;
}
export interface RecipeConflictPage {
  readonly items: readonly RecipeConflict[];
  readonly nextCursor: string | null;
  readonly currentRevision: number;
}
export interface RecipeConflictResolution {
  readonly conflict: RecipeConflict;
  /** The active recipe after the explicit owner choice. */
  readonly recipe: RecipeDocument;
}
export const PHOTO_ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  origin_rejected: 403,
  not_found: 404,
  quota_exceeded: 409,
  revision_conflict: 409,
  idempotency_conflict: 409,
  upload_state_conflict: 409,
  photo_deleted: 410,
  account_deleting: 409,
  upload_expired: 410,
  cursor_expired: 410,
  request_too_large: 413,
  unsupported_format: 415,
  range_not_satisfiable: 416,
  content_rejected: 422,
  pixel_limit_exceeded: 422,
  unsupported_settings: 422,
  missing_mask_surface: 422,
  rate_limited: 429,
  temporarily_unavailable: 503,
} as const;
export type PhotoErrorCode = keyof typeof PHOTO_ERROR_STATUS;
export interface PhotoErrorEnvelope {
  readonly error: {
    readonly code: PhotoErrorCode;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly currentRevision?: number;
    /** Set when a stale recipes.put payload was durably retained for owner choice. */
    readonly conflictId?: RecipeConflictId;
    readonly retryAfterSeconds?: number;
  };
}

/** Arrange values are synthetic inputs for future HTTP/DB conformance runners. */
export interface PhotoContractCase {
  readonly id: string;
  readonly operation: PhotoOperation;
  readonly actor: "user-a" | "user-b" | "none" | "revoked";
  readonly request: JsonObject;
  readonly arrange: JsonObject;
  readonly expected: {
    readonly status: number;
    readonly code?: PhotoErrorCode;
    readonly invariants: readonly string[];
  };
}

type Id = { readonly photoId: PhotoId };
type UploadRef = { readonly uploadId: UploadId };
type Empty = Readonly<Record<string, never>>;
type Operation<Request, Response> = { readonly request: Request; readonly response: Response };
/** One bounded contiguous range; the transport alone produces/parses HTTP headers. */
export interface PhotoByteRange {
  readonly start: number;
  readonly endInclusive?: number;
}
export interface PhotoContent {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  /** Hash of the complete immutable asset, not a digest of an individual range. */
  readonly sha256: Sha256;
  readonly totalBytes: number;
  readonly range: { readonly start: number; readonly endInclusive: number };
}
/** All request objects are closed except opaque recipe/working-copy JSON. */
export interface PhotoOperationMap {
  readonly "library.get": Operation<Empty, PersonalPhotoLibrary>;
  readonly "photos.list": Operation<PhotoListQuery, PhotoPage>;
  readonly "photos.get": Operation<Id, Photo>;
  readonly "photos.info": Operation<Id, PhotoInfo>;
  readonly "photos.lookup": Operation<{ readonly sha256s: readonly Sha256[] }, { readonly matches: readonly PhotoLookupMatch[] }>;
  readonly "uploads.start": Operation<StartUploadRequest, MutationReceipt<StartUploadResponse>>;
  readonly "uploads.get": Operation<UploadRef, Upload>;
  readonly "uploads.renew": Operation<UploadRef, { readonly upload: Extract<Upload, { readonly state: "reserved" }>; readonly ticket: UploadTicket }>;
  readonly "uploads.complete": Operation<UploadRef, MutationReceipt<Upload>>;
  readonly "uploads.cancel": Operation<UploadRef, MutationReceipt<Upload>>;
  /** Stream and verified asset/range metadata; never buffer a whole original just to normalize HTTP. */
  readonly "content.get": Operation<Id & { readonly assetId: AssetId; readonly range?: PhotoByteRange }, PhotoContent>;
  readonly "masks.get": Operation<Id & { readonly surfaceId: Sha256 }, PhotoAsset>;
  readonly "recipes.put": Operation<Id & {
    readonly expectedRevision: number;
    readonly settings: RecipeDocument["settings"];
    readonly baseVersion: string | null;
  }, MutationReceipt<Photo>>;
  readonly "versions.get": Operation<Id, VersionSet>;
  readonly "versions.put": Operation<Id & {
    readonly expectedRevision: number;
    readonly versions: readonly NamedVersion[];
  }, MutationReceipt<VersionSet>>;
  readonly "recipe-conflicts.list": Operation<Id & { readonly cursor?: string; readonly limit?: number }, RecipeConflictPage>;
  /** Direct owner-bound lookup of both retained branches, independent of list cursor/page count. */
  readonly "recipe-conflicts.get": Operation<Id & { readonly conflictId: RecipeConflictId }, RecipeConflict>;
  readonly "recipe-conflicts.resolve": Operation<Id & {
    readonly conflictId: RecipeConflictId;
    readonly expectedRevision: number;
    readonly decision: "adopt" | "keep-current";
  }, MutationReceipt<RecipeConflictResolution>>;
  readonly "media.ensure": Operation<Id & { readonly recipeRevision: number }, MutationReceipt<MediaState>>;
  /** Resolve only after physical deletion and quota release are confirmed. No restore operation. */
  readonly "photos.delete": Operation<Id, { readonly state: "purged" }>;
}
export type PhotoOperation = keyof PhotoOperationMap;

/** Issued by a trusted host. These are selectors/fences, never server authority. */
export interface PhotoSessionScope {
  readonly actorId: UserId;
  readonly libraryId: LibraryId;
  /** From the verified session snapshot, never a client-chosen authorization value. */
  readonly sessionEpoch: VerifiedPhotoActor["sessionEpoch"];
}

/** Future adapter boundary; every call is bound to the captured owner/session epoch. */
export type PhotoMutationOperation = "uploads.start" | "uploads.complete" | "uploads.cancel" | "recipes.put" | "versions.put" | "recipe-conflicts.resolve" | "media.ensure" | "photos.delete";
export type PhotoRequestOptions<K extends PhotoOperation> = { readonly signal: AbortSignal } &
  (K extends PhotoMutationOperation ? { readonly idempotencyKey: string } : { readonly idempotencyKey?: never });
export interface PersonalPhotoCloudClient {
  readonly scope: PhotoSessionScope;
  /** Trusted transport compares captured scope with the verified actor before dispatch and after response.
   * BFF/native forwards the bound credential, not a body owner/epoch; the backend checks the server
   * session's generation/revocation before a write commits. Local scope changes also abort readers.
   */
  request<K extends PhotoOperation>(operation: K, request: PhotoOperationMap[K]["request"], options: PhotoRequestOptions<K>): Promise<PhotoOperationMap[K]["response"]>;
  dispose(): void;
}
