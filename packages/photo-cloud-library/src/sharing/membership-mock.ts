/**
 * Synthetic in-memory shared-album server for development and tests (B05 #246, B12 #254). Not an authorization layer
 * and never selected by a production host: the real ledger, credentials, storage and rate limits live behind the
 * existing private boundary. Every decision is the contract's reference policy (B00 `./policy`), so the mock and the
 * conformance vectors cannot drift apart.
 *
 * - Membership and invite links (B05).
 * - Albums and items (B12): the owner's library photos, a member's own edited photos and finished JPEG files. A library
 *   photo is rendered by its adder's own device through render jobs (B07); a device render or a file is uploaded. At
 *   commit the server re-decodes the upload and rebuilds it with the allowed metadata only, so a location in a direct
 *   upload never reaches the album. Saving a newer recipe on a library photo re-renders its items; until the new
 *   rendition commits, other members keep seeing the previous one.
 * - Storage is charged to the album owner: every upload and render output reserves before it starts, and the reserve is
 *   released on cancel, failure, supersede, removal and album deletion. A full storage holds render jobs
 *   (準備中（容量不足）) and resumes them when capacity frees.
 * - Removing an item or deleting an album never touches the adder's original or the owner's library photo.
 *
 * It is separate from the photo-level link sharing (`cloudSharing`) mock and knows nothing about share links.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readJpegPixelSize } from "niho-photo-editing/image-bytes-metadata";

import { PersonalPhotoCloudError } from "../errors";
import { jpegMetadataRecord, renditionMetadataViolations, stripJpegMetadata } from "../render-executor/jpeg-metadata";
import type { RenderExecutorTransport } from "../render-executor/render-executor";
import type { RenderOutputUploader } from "../render-executor/ticket-upload";
import { PHOTO_CAPTURE_HEADERS, PHOTO_CONTENT_HEADERS, PHOTO_IDEMPOTENCY_HEADER, isOpaqueWireId, isValidIdempotencyKey } from "../wire";

import { isSharedAlbumItemOperation, validateAlbumItemRequest } from "./album-wire";
import {
  MEMBER_ROLES,
  SHARING_ERROR_STATUS,
  SHARING_LIMITS,
  SharingRouteError,
  canonical,
  checkAlbumName,
  checkCursor,
  compareIdempotency,
  decideAddPhoto,
  decideAlbumAction,
  decideJoin,
  decideMembershipChange,
  decidePendingInviteJoin,
  decideRenderCommit,
  decideReplaceStart,
  decideUploadCommit,
  decideUploadRenew,
  decodePendingInviteRequest,
  decodeSharingRequest,
  findUnexpectedPendingInviteFields,
  findUnexpectedRequestFields,
  holdPendingInvite,
  itemStateAfterAdderRevoked,
  matchPendingInviteRoute,
  matchSharingRoute,
  nextAlbumItemState,
  nextPendingReason,
  permissionsFor,
  personLabel,
  projectAlbumItem,
  quotaExceededError,
  type AddPhotoSource,
  type Album,
  type AlbumItem,
  type AlbumItemPendingReason,
  type AlbumItemSnapshot,
  type AlbumRole,
  type ClaimedRenderJob,
  type IdempotencyRecord,
  type Instant,
  type InviteJoinResult,
  type InviteLink,
  type InviteSecret,
  type LedgerPerson,
  type MemberJoinedEvent,
  type MemberRole,
  type Membership,
  type MembershipState,
  type MutationReceipt,
  type PendingInvite,
  type PendingInviteHeld,
  type PhotoByteRange,
  type PhotoContent,
  type RecipeDocument,
  type RenderBinding,
  type RenderExecutor,
  type RenderExecutorOperation,
  type RenderExecutorOperationMap,
  type RenderJob,
  type RenderFailureCode,
  type Rendition,
  type RenditionMetadata,
  type RenditionUpload,
  type RenditionUploadRequest,
  type ReplaceContent,
  type SharingErrorCode,
  type SharingErrorEnvelope,
  type SharingOperationMap,
  type SharingRequestOptions,
  type SharingSessionScope,
  type UserId,
} from "./contract";
import {
  SHARED_ALBUM_MEMBERSHIP_OPERATIONS,
  isSecret,
  isSharedAlbumMembershipOperation,
  validateMembershipRequest,
} from "./membership-wire";

export const SHARED_ALBUM_MOCK_OPERATIONS = [
  ...SHARED_ALBUM_MEMBERSHIP_OPERATIONS,
  "storage.get",
  "albums.list",
  "albums.get",
  "albums.create",
  "albums.rename",
  "albums.delete",
  "albumItems.list",
  "albumItems.get",
  "albumItems.addPhoto",
  "albumItems.addFile",
  "albumItems.replace",
  "albumItems.commitUpload",
  "albumItems.cancelUpload",
  "albumItems.renewUpload",
  "albumItems.remove",
] as const;
export type SharedAlbumMockOperation = (typeof SHARED_ALBUM_MOCK_OPERATIONS)[number];

const MUTATIONS: ReadonlySet<string> = new Set([
  "invites.create", "invites.revoke", "invites.join", "members.changeRole", "members.remove", "members.leave",
  "albums.create", "albums.rename", "albums.delete", "albumItems.addPhoto", "albumItems.addFile", "albumItems.replace",
  "albumItems.commitUpload", "albumItems.cancelUpload", "albumItems.remove",
]);

/** Tickets of this mock point at a synthetic bucket on the trusted provider origin, so the real ticket uploader works. */
export const SHARED_ALBUM_MOCK_TICKET_PREFIX = "https://storage.googleapis.com/synthetic-album-uploads/";

export interface SharedAlbumMockUser {
  readonly userId: UserId;
  readonly displayName: string;
}

export interface CreateSharedAlbumMockServerOptions {
  readonly users: readonly SharedAlbumMockUser[];
  /** ms clock (default Date.now). */
  readonly now?: () => number;
  /** Invite secret generator (default: 128 random bits, base64url). */
  readonly newSecret?: () => InviteSecret;
  /** Failed joins allowed per user within the window before `rate_limited` (default 10 per 10 minutes). */
  readonly joinAttemptLimit?: { readonly failures: number; readonly windowSeconds: number };
  /** Shared storage of every album owner, in bytes (default 1 GiB); change it with `setQuotaBytes`. */
  readonly quotaBytes?: number;
  readonly leaseSeconds?: number;
}

export interface SharedAlbumMockClient {
  readonly scope: SharingSessionScope;
  request<K extends SharedAlbumMockOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
  download(request: SharingOperationMap["albumItems.download"]["request"], signal: AbortSignal): Promise<PhotoContent>;
  /** `invites.joinPending` against this mock's stand-in for the BFF (see `holdPendingInvite`). */
  joinPending(signal: AbortSignal): Promise<InviteJoinResult>;
  dispose(): void;
}

/** A photo in a user's own library: its current binding, the exact recipe and NIHO's full-resolution size. */
export interface SharedAlbumMockLibraryPhoto {
  readonly ownerId: UserId;
  readonly libraryId: string;
  readonly photoId: string;
  readonly binding: RenderBinding;
  readonly recipe: RecipeDocument;
  readonly expectedOutput?: { readonly width: number; readonly height: number } | null;
}

export interface SharedAlbumMockServer {
  /** A signed-in user's session, or `null` for a signed-out visitor. */
  clientFor(actorId: UserId | null): SharedAlbumMockClient;
  /**
   * Handler for the contract's user routes (`SHARING_ROUTES` under `/cloud/sharing/v1`) so the browser client can be
   * exercised end to end. The actor comes from the capture header; this is a test stand-in for the verified session,
   * not authorization.
   */
  readonly fetch: typeof fetch;
  /**
   * Stand-in for the BFF's pending-invite cookie of one browser (`invites.holdPending`): the next `joinPending` uses it
   * under the contract's rules (`decidePendingInviteJoin`). `actorId` is who was signed in when holding, or null.
   */
  holdPendingInvite(secret: InviteSecret, actorId?: UserId | null): PendingInviteHeld;
  /** Owner notifications (`MemberJoinedEvent`) in delivery order. */
  memberJoinedEvents(ownerId: UserId): readonly MemberJoinedEvent[];
  /** The next mutation commits but its answer is lost (network failure), to exercise same-key replay. */
  loseNextResponse(): void;

  /** Uploads to this mock's tickets (album uploads and render outputs). */
  readonly uploader: RenderOutputUploader;
  /** The render-job protocol for one user's signed-in device (B07 executor transport). */
  renderTransportFor(userId: UserId): RenderExecutorTransport;
  /** The device that holds the user's originals went offline / came back. Claiming implies online. */
  setDeviceOnline(userId: UserId, online: boolean): void;
  /** Registers a photo in a user's own library (the original stays on that user's device). */
  addLibraryPhoto(photo: SharedAlbumMockLibraryPhoto): void;
  /** The owner saved a newer recipe: album items of this photo re-render on the owner's device. */
  saveLibraryRecipe(photo: SharedAlbumMockLibraryPhoto): void;
  /** Whether the original is still in the user's library (removal and deletion never touch it). */
  hasLibraryPhoto(libraryId: string, photoId: string): boolean;
  setQuotaBytes(ownerId: UserId, bytes: number): void;
  /** Bytes committed to renditions and bytes reserved by unfinished uploads, for one album owner. */
  storageOf(ownerId: UserId): { readonly usedBytes: number; readonly reservedBytes: number };
  /** The stored bytes of an item's current rendition (rebuilt by the server at commit). */
  renditionBytes(itemId: string): Uint8Array | null;
  /** Server-side item record (for assertions; never returned to clients as is). */
  item(itemId: string): AlbumItemSnapshot;
  renderJobs(): readonly { readonly id: string; readonly itemId: string | null; readonly state: RenderJob["state"]; readonly failure: RenderFailureCode | null }[];
  /** Counts of calls by operation (for tests). */
  calls(operation: string): number;
}

type AlbumRecord = {
  readonly id: string;
  readonly owner: LedgerPerson;
  name: string;
  revision: number;
  readonly createdAt: Instant;
  updatedAt: Instant;
  deleted: boolean;
};
type MembershipRecord = {
  readonly id: string;
  readonly albumId: string;
  readonly userId: UserId;
  role: AlbumRole;
  state: MembershipState;
  revision: number;
  joinedAt: Instant;
  endedAt: Instant | null;
  joinedVia: string | null;
};
type LinkRecord = {
  readonly id: string;
  readonly albumId: string;
  readonly role: MemberRole;
  readonly createdBy: UserId;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  revoked: boolean;
  revokedAt: Instant | null;
  joinCount: number;
};
/** An album upload (add or replace) with the reservation it holds while reserved. */
type UploadRecord = {
  upload: RenditionUpload;
  readonly rendition: RenditionUploadRequest;
  readonly addedBy: UserId;
  readonly ownerId: UserId;
  readonly binding: RenderBinding | null;
  bytes: Uint8Array | null;
};
type DesiredRender = { readonly binding: RenderBinding; readonly recipe: RecipeDocument; readonly expectedOutput: { readonly width: number; readonly height: number } | null };
type JobRecord = { job: RenderJob; leaseToken: string | null; readonly seq: number; blockedForQuota: boolean; readonly ownerId: UserId };
type OutputRecord = {
  readonly id: string;
  readonly jobId: string;
  readonly ownerId: UserId;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly metadata: RenditionMetadata;
  readonly expiresAtMs: number;
  state: "reserved" | "uploaded" | "rejected" | "superseded" | "released";
  bytes: Uint8Array | null;
};
type StoredMutation = { readonly record: IdempotencyRecord; readonly response: unknown };

const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;
const DEFAULT_QUOTA_BYTES = 1024 ** 3;
const THUMBNAIL_EDGE = SHARING_LIMITS.thumbnailMaxEdge;

export function createSharedAlbumMockServer(options: CreateSharedAlbumMockServerOptions): SharedAlbumMockServer {
  const clock = options.now ?? Date.now;
  const instant = (ms = clock()): Instant => new Date(ms).toISOString();
  const newSecret = options.newSecret ?? randomSecret;
  const joinLimit = options.joinAttemptLimit ?? { failures: 10, windowSeconds: 10 * 60 };
  const leaseMs = (options.leaseSeconds ?? SHARING_LIMITS.renderLeaseMaxSeconds) * 1000;
  const people = new Map(options.users.map((user) => [user.userId, { userId: user.userId, displayName: user.displayName } satisfies LedgerPerson]));
  const albums = new Map<string, AlbumRecord>();
  const memberships = new Map<string, MembershipRecord>();
  const links = new Map<string, LinkRecord>();
  const linkBySecretDigest = new Map<string, string>();
  const joins: { inviteLinkId: string; membershipId: string; userId: UserId; joinedAt: Instant }[] = [];
  const items = new Map<string, AlbumItemSnapshot>();
  const desired = new Map<string, DesiredRender>();
  const uploads = new Map<string, UploadRecord>();
  const renditionStore = new Map<string, Uint8Array>();
  const libraries = new Map<string, { readonly ownerId: UserId; readonly photos: Map<string, DesiredRender> }>();
  const jobs = new Map<string, JobRecord>();
  const outputs = new Map<string, OutputRecord>();
  const quotas = new Map<UserId, number>();
  const deviceOnline = new Map<UserId, boolean>();
  const lastRemovedAt = new Map<string, Instant>();
  const events = new Map<UserId, MemberJoinedEvent[]>();
  const failedJoins = new Map<UserId, number[]>();
  const stored = new Map<string, StoredMutation>();
  const renderStored = new Map<string, StoredMutation>();
  const cursors = new Map<string, { readonly binding: Parameters<typeof checkCursor>[0]; readonly offset: number }>();
  const callCounts = new Map<string, number>();
  let sequence = 0;
  let loseNext = false;
  /** The one browser's pending-invite cookie and the pending IDs already used (the BFF's copied-cookie rule). */
  let heldInvite: PendingInvite | null = null;
  const usedPendingIds = new Set<string>();

  const nextId = (prefix: string): string => `mock-${prefix}-${++sequence}`;
  const fail = (code: SharingErrorCode, extra: Partial<SharingErrorEnvelope["error"]> = {}): never => {
    throw { error: { code, requestId: nextId("request"), retryable: code === "rate_limited" || code === "temporarily_unavailable", ...extra } } satisfies SharingErrorEnvelope;
  };
  const decided = (decision: { readonly ok: true } | { readonly ok: false; readonly code: SharingErrorCode }): void => {
    if (!decision.ok) fail(decision.code);
  };
  const person = (userId: UserId): LedgerPerson => people.get(userId) ?? fail("not_found");
  const membershipKey = (albumId: string, userId: UserId): string => `${albumId}\u001f${userId}`;
  const membershipOf = (albumId: string, userId: UserId): MembershipRecord | null => memberships.get(membershipKey(albumId, userId)) ?? null;
  const viewerOf = (albumId: string, userId: UserId) => {
    const membership = membershipOf(albumId, userId);
    return { userId, membership: membership ? { role: membership.role, state: membership.state, revision: membership.revision } : null };
  };
  const albumOr404 = (albumId: string): AlbumRecord => {
    const album = albums.get(albumId);
    return album && !album.deleted ? album : fail("not_found");
  };
  const digest = (value: string): string => bytesToHex(sha256(new TextEncoder().encode(value)));
  const roleOf = (albumId: string, userId: UserId): AlbumRole => membershipOf(albumId, userId)?.role ?? "viewer";

  // -------------------------------------------------------------------------------------------------------
  // Owner storage

  const quotaOf = (ownerId: UserId): number => quotas.get(ownerId) ?? options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  function usedBytes(ownerId: UserId): number {
    let total = 0;
    for (const item of items.values()) {
      const album = albums.get(item.albumId);
      if (album && !album.deleted && album.owner.userId === ownerId && item.state !== "removed" && item.rendition) total += item.rendition.asset.sizeBytes;
    }
    return total;
  }
  function reservedBytes(ownerId: UserId): number {
    let total = 0;
    const now = clock();
    for (const record of uploads.values()) {
      if (record.ownerId === ownerId && record.upload.state === "reserved" && now < Date.parse(record.upload.expiresAt)) total += record.upload.sizeBytes;
    }
    for (const output of outputs.values()) {
      if (output.ownerId === ownerId && (output.state === "reserved" || output.state === "uploaded") && now < output.expiresAtMs) total += output.sizeBytes;
    }
    return total;
  }
  const availableBytes = (ownerId: UserId): number => Math.max(0, quotaOf(ownerId) - usedBytes(ownerId) - reservedBytes(ownerId));
  /** Owners see the numbers; other members only learn that the album is full (B00 `quotaExceededError`). */
  function requireCapacity(album: AlbumRecord, actor: UserId, bytes: number): void {
    const available = availableBytes(album.owner.userId);
    if (bytes <= available) return;
    throw { error: quotaExceededError(album.owner.userId === actor ? "owner" : "member", nextId("request"), { availableBytes: available, requiredBytes: bytes }) };
  }
  /** Capacity freed: render jobs held for storage go back to the queue and their items back to rendering. */
  function capacityFreed(ownerId: UserId): void {
    for (const record of jobs.values()) {
      if (!record.blockedForQuota || record.ownerId !== ownerId) continue;
      record.blockedForQuota = false;
      if (record.job.purpose.kind === "albumItem") setPending(record.job.purpose.itemId, "quotaFreed");
    }
  }
  function releaseUpload(record: UploadRecord, state: "cancelled" | "rejected" | "expired"): void {
    if (record.upload.state !== "reserved") return;
    record.upload = { ...record.upload, state };
    capacityFreed(record.ownerId);
  }

  // -------------------------------------------------------------------------------------------------------
  // Items

  function setItem(next: AlbumItemSnapshot): AlbumItemSnapshot {
    items.set(next.id, next);
    return next;
  }
  /** Applies a pending-reason event (B00 ALBUM_ITEM_PENDING_TRANSITIONS); undefined transitions keep the reason. */
  function setPending(itemId: string, event: Parameters<typeof nextPendingReason>[1]): void {
    const item = items.get(itemId);
    if (!item || item.pendingReason === null || (item.state !== "preparing" && item.state !== "updatePending")) return;
    const reason = nextPendingReason(item.pendingReason, event);
    if (reason) setItem({ ...item, pendingReason: reason });
  }
  function projectItem(item: AlbumItemSnapshot, viewer: UserId): AlbumItem | null {
    return projectAlbumItem(item, { userId: viewer, role: roleOf(item.albumId, viewer) });
  }
  function visibleItems(albumId: string, viewer: UserId, role: AlbumRole): AlbumItem[] {
    return [...items.values()]
      .filter((item) => item.albumId === albumId && item.state !== "removed")
      .map((item) => projectAlbumItem(item, { userId: viewer, role }))
      .filter((item): item is AlbumItem => item !== null);
  }
  /** Removes an item from the album only: its jobs stop and its reservations are released. Originals stay. */
  function removeItem(item: AlbumItemSnapshot): AlbumItemSnapshot {
    if (item.state === "removed") return item;
    endJobs((record) => record.job.purpose.kind === "albumItem" && record.job.purpose.itemId === item.id, "cancelled");
    for (const record of uploads.values()) if (record.upload.itemId === item.id) releaseUpload(record, "cancelled");
    if (item.rendition) renditionStore.delete(item.rendition.id);
    desired.delete(item.id);
    const removed = setItem({ ...item, state: "removed", rendition: null, removedAt: instant(), pendingUpload: null, pendingReason: null });
    const album = albums.get(item.albumId);
    if (album) capacityFreed(album.owner.userId);
    return removed;
  }
  /**
   * The adder left, was removed, or lost add/replace permission: unpublished additions are dropped with their jobs
   * and reservations; published items stay (Epic §3) and keep their last rendition, pending updates included.
   */
  function endUnpublishedAdds(albumId: string, userId: UserId): void {
    for (const item of items.values()) {
      if (item.albumId !== albumId) continue;
      // B00 `adderRevoked`: an addition in progress is dropped, a pending replacement falls back to the last rendition.
      const next = itemStateAfterAdderRevoked(item, userId);
      if (next === item.state) continue;
      if (next === "removed") {
        removeItem(item);
        continue;
      }
      endJobs((record) => record.job.purpose.kind === "albumItem" && record.job.purpose.itemId === item.id, "cancelled");
      for (const record of uploads.values()) if (record.upload.itemId === item.id) releaseUpload(record, "cancelled");
      desired.delete(item.id);
      setItem({ ...item, state: next, pendingReason: null, pendingUpload: null });
    }
  }
  /** A rebuilt rendition: server-side re-decode of the uploaded bytes with the allowed metadata only. */
  function buildRendition(bytes: Uint8Array, metadata: RenditionMetadata, itemRevision: number): Rendition {
    const id = nextId("rendition");
    renditionStore.set(id, bytes);
    const size = readJpegPixelSize(bytes) ?? { width: 1, height: 1 };
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(size.width, size.height));
    const digestHex = bytesToHex(sha256(bytes));
    return {
      id, itemRevision,
      asset: { sha256: digestHex, sizeBytes: bytes.byteLength, contentType: "image/jpeg", width: size.width, height: size.height, fullResolution: true },
      // The synthetic thumbnail is the rendition itself (a real server derives a downscale from the rendition only).
      thumbnail: { sha256: digestHex, sizeBytes: bytes.byteLength, contentType: "image/jpeg", width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) },
      metadata: { capturedAt: metadata.capturedAt, capturedAtOffset: metadata.capturedAtOffset, colorProfile: metadata.colorProfile, orientation: 1 },
      createdAt: instant(),
    };
  }
  function publish(item: AlbumItemSnapshot, rendition: Rendition, binding: RenderBinding | null): AlbumItemSnapshot {
    if (item.rendition) renditionStore.delete(item.rendition.id);
    const state = nextAlbumItemState(item.state, "renditionCommitted") ?? fail("stale_render");
    return setItem({ ...item, state, revision: rendition.itemRevision, rendition, renditionBinding: binding, pendingReason: null, pendingUpload: null });
  }
  function startUpload(album: AlbumRecord, actor: UserId, item: AlbumItemSnapshot, rendition: RenditionUploadRequest, binding: RenderBinding | null) {
    const now = clock();
    const upload: RenditionUpload = {
      id: nextId("upload"), albumId: album.id, itemId: item.id, targetItemRevision: item.revision + 1, sizeBytes: rendition.sizeBytes,
      sha256: rendition.sha256, expiresAt: instant(now + UPLOAD_LIFETIME_MS), state: "reserved", uploadedBytes: 0,
    };
    uploads.set(upload.id, { upload, rendition, addedBy: actor, ownerId: album.owner.userId, binding, bytes: null });
    return {
      upload,
      ticket: { url: `${SHARED_ALBUM_MOCK_TICKET_PREFIX}${upload.id}`, method: "PUT" as const, headers: { "Content-Type": "image/jpeg" }, expiresAt: upload.expiresAt, resumeOffsetBytes: 0 },
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Render jobs on the adder's device

  const deviceIsOnline = (userId: UserId): boolean => deviceOnline.get(userId) ?? true;
  function endJobs(match: (record: JobRecord) => boolean, state: "superseded" | "cancelled"): void {
    for (const record of jobs.values()) {
      if ((record.job.state === "queued" || record.job.state === "claimed" || record.job.state === "waitingForHost") && match(record)) {
        record.job = { ...record.job, state, leaseExpiresAt: null };
        record.leaseToken = null;
        releaseOutputs(record.job.id, "released");
      }
    }
  }
  function releaseOutputs(jobId: string, state: "superseded" | "released"): void {
    for (const output of outputs.values()) {
      if (output.jobId === jobId && (output.state === "reserved" || output.state === "uploaded")) {
        output.state = state;
        capacityFreed(output.ownerId);
      }
    }
  }
  /** Queues a render of the item's current desired binding on its adder's device, superseding older jobs. */
  function enqueueRender(item: AlbumItemSnapshot, album: AlbumRecord, photo: { readonly libraryId: string; readonly photoId: string }): void {
    const want = desired.get(item.id);
    if (!want) return;
    endJobs((record) => record.job.purpose.kind === "albumItem" && record.job.purpose.itemId === item.id, "superseded");
    const id = nextId("job");
    jobs.set(id, {
      job: {
        id, purpose: { kind: "albumItem", albumId: album.id, itemId: item.id, itemRevision: item.revision },
        executor: { kind: "userDevice", userId: item.addedBy.userId }, photo, binding: want.binding, recipe: want.recipe, state: "queued",
        attempt: 0, createdAt: instant(), leaseExpiresAt: null, failure: null, expectedOutput: want.expectedOutput,
      },
      leaseToken: null, seq: sequence, blockedForQuota: false, ownerId: album.owner.userId,
    });
  }
  function claimedRecord(executor: RenderExecutor, jobId: string, leaseToken: string): JobRecord {
    const record = jobs.get(jobId);
    if (!record || canonical(record.job.executor) !== canonical(executor) || record.leaseToken !== leaseToken) return fail("not_found");
    if (record.job.state !== "claimed") return fail("stale_render");
    if (clock() >= Date.parse(record.job.leaseExpiresAt as string)) return fail("lease_expired");
    return record;
  }
  function executeRender<K extends RenderExecutorOperation>(executor: RenderExecutor & { readonly kind: "userDevice" }, operation: K, request: RenderExecutorOperationMap[K]["request"]): unknown {
    switch (operation) {
      case "renderJobs.claim": {
        const { maxJobs = 1, purposes, prefer } = request as RenderExecutorOperationMap["renderJobs.claim"]["request"];
        setDeviceOnline(executor.userId, true);
        for (const record of jobs.values()) {
          if (record.job.state === "claimed" && clock() >= Date.parse(record.job.leaseExpiresAt as string)) {
            record.job = { ...record.job, state: "queued", leaseExpiresAt: null };
            record.leaseToken = null;
            releaseOutputs(record.job.id, "released");
          }
        }
        const preferred = new Set(prefer?.photoIds ?? []);
        const claimed = [...jobs.values()]
          .filter((record) => record.job.state === "queued" && !record.blockedForQuota && canonical(record.job.executor) === canonical(executor))
          .filter((record) => purposes === undefined || purposes.includes(record.job.purpose.kind))
          .sort((a, b) => Number(preferred.has(b.job.photo.photoId)) - Number(preferred.has(a.job.photo.photoId)) || a.seq - b.seq)
          .slice(0, Math.max(1, Math.min(maxJobs, 32)));
        return {
          value: {
            jobs: claimed.map((record): ClaimedRenderJob => {
              record.leaseToken = nextId("lease");
              record.job = { ...record.job, state: "claimed", attempt: record.job.attempt + 1, leaseExpiresAt: instant(clock() + leaseMs) };
              return { job: record.job, lease: { jobId: record.job.id, leaseToken: record.leaseToken, expiresAt: record.job.leaseExpiresAt as string } };
            }),
          },
          replayed: false,
        };
      }
      case "renderJobs.startOutput": {
        const { jobId, leaseToken, output } = request as RenderExecutorOperationMap["renderJobs.startOutput"]["request"];
        const record = claimedRecord(executor, jobId, leaseToken);
        if (record.job.purpose.kind !== "albumItem" || output.kind !== "rendition") return fail("invalid_request");
        const item = items.get(record.job.purpose.itemId);
        if (!item || item.state === "removed") return fail("item_removed");
        if (output.sizeBytes > availableBytes(record.ownerId)) {
          // Not a failure: the job waits (準備中（容量不足）) and comes back when capacity frees.
          setPending(item.id, "quotaExceeded");
          record.blockedForQuota = true;
          record.job = { ...record.job, state: "queued", leaseExpiresAt: null };
          record.leaseToken = null;
          const album = albums.get(item.albumId) as AlbumRecord;
          throw { error: quotaExceededError(album.owner.userId === executor.userId ? "owner" : "member", nextId("request"), { availableBytes: availableBytes(record.ownerId), requiredBytes: output.sizeBytes }) };
        }
        // A new output supersedes the job's previous one and releases its reservation at once.
        releaseOutputs(jobId, "superseded");
        const stored: OutputRecord = {
          id: nextId("output"), jobId, ownerId: record.ownerId, sizeBytes: output.sizeBytes, sha256: output.sha256, metadata: output.metadata,
          expiresAtMs: clock() + UPLOAD_LIFETIME_MS, state: "reserved", bytes: null,
        };
        outputs.set(stored.id, stored);
        return { value: { uploadId: stored.id, expiresAt: instant(stored.expiresAtMs), ticket: outputTicket(stored) }, replayed: false };
      }
      case "renderJobs.renewOutput": {
        const { jobId, leaseToken, uploadId } = request as RenderExecutorOperationMap["renderJobs.renewOutput"]["request"];
        claimedRecord(executor, jobId, leaseToken);
        const stored = outputs.get(uploadId);
        if (!stored || stored.jobId !== jobId || stored.state !== "reserved") return fail("not_found");
        if (clock() >= stored.expiresAtMs) return fail("upload_expired");
        return { uploadId, expiresAt: instant(stored.expiresAtMs), ticket: outputTicket(stored) };
      }
      case "renderJobs.commit": {
        const { jobId, leaseToken, uploadId } = request as RenderExecutorOperationMap["renderJobs.commit"]["request"];
        const record = jobs.get(jobId);
        if (!record || record.leaseToken !== leaseToken) return fail("not_found");
        const output = outputs.get(uploadId);
        const purpose = record.job.purpose;
        const item = purpose.kind === "albumItem" ? items.get(purpose.itemId) ?? null : null;
        const decoded = output?.bytes ? readJpegPixelSize(output.bytes) : null;
        const now = clock();
        // Server re-decode: an output with anything outside the rendition allow-list (comments, camera make/model,
        // vendor blocks, trailing bytes — not only location, serials and paths) is never published.
        if (output?.bytes && renditionMetadataViolations(output.bytes).length > 0) {
          output.state = "rejected";
          capacityFreed(output.ownerId);
        }
        decided(decideRenderCommit({
          job: record.job,
          actor: executor,
          claimedGeneration: 1,
          executor: { lifecycle: "active", credentialGeneration: 1 },
          upload: output && output.state !== "released"
            ? {
                jobId: output.jobId, kind: "rendition",
                state: output.state === "superseded" ? "superseded" : now >= output.expiresAtMs ? "expired" : output.state === "uploaded" ? "uploaded" : output.state === "rejected" ? "rejected" : "reserved",
                ...(decoded ? { width: decoded.width, height: decoded.height } : {}),
              }
            : null,
          bytesMetadata: output?.bytes ? jpegMetadataRecord(output.bytes) : {},
          desired: item && item.state !== "removed" ? desired.get(item.id)?.binding ?? null : null,
          item: { state: item?.state ?? null, revision: item?.revision ?? 0, adder: item ? viewerOf(item.albumId, item.addedBy.userId) : { userId: "", membership: null } },
          now: instant(now),
        }));
        const accepted = output as OutputRecord;
        record.job = { ...record.job, state: "committed", leaseExpiresAt: null };
        record.leaseToken = null;
        accepted.state = "released";
        releaseOutputs(jobId, "released");
        const target = item as AlbumItemSnapshot;
        publish(target, buildRendition(accepted.bytes as Uint8Array, accepted.metadata, target.revision + 1), record.job.binding);
        return { value: record.job, replayed: false };
      }
      case "renderJobs.fail": {
        const { jobId, leaseToken, code } = request as RenderExecutorOperationMap["renderJobs.fail"]["request"];
        const record = claimedRecord(executor, jobId, leaseToken);
        record.job = { ...record.job, state: "failed", failure: code, leaseExpiresAt: null };
        record.leaseToken = null;
        releaseOutputs(jobId, "released");
        return { value: record.job, replayed: false };
      }
    }
    return fail("invalid_request");
  }
  function outputTicket(output: OutputRecord) {
    return { url: `${SHARED_ALBUM_MOCK_TICKET_PREFIX}${output.id}`, method: "PUT" as const, headers: { "Content-Type": "image/jpeg" }, expiresAt: instant(output.expiresAtMs), resumeOffsetBytes: 0 };
  }
  function setDeviceOnline(userId: UserId, online: boolean): void {
    if (deviceIsOnline(userId) === online) return;
    deviceOnline.set(userId, online);
    for (const record of jobs.values()) {
      if (record.job.purpose.kind !== "albumItem" || canonical(record.job.executor) !== canonical({ kind: "userDevice", userId })) continue;
      if (record.job.state === "queued" || record.job.state === "claimed") setPending(record.job.purpose.itemId, online ? "deviceOnline" : "deviceOffline");
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Projections and paging

  function projectMembership(record: MembershipRecord, viewer: UserId): Membership {
    return {
      id: record.id, albumId: record.albumId, member: personLabel(person(record.userId), viewer), role: record.role, state: record.state,
      revision: record.revision, joinedAt: record.joinedAt, endedAt: record.endedAt, joinedVia: record.joinedVia,
    };
  }
  function projectLink(record: LinkRecord, viewer: UserId): InviteLink {
    return {
      id: record.id, albumId: record.albumId, role: record.role, createdBy: personLabel(person(record.createdBy), viewer),
      createdAt: record.createdAt, expiresAt: record.expiresAt, revoked: record.revoked, revokedAt: record.revokedAt, joinCount: record.joinCount,
    };
  }
  function projectAlbum(album: AlbumRecord, viewer: UserId): Album {
    const membership = membershipOf(album.id, viewer);
    if (!membership || membership.state !== "active") return fail("not_found");
    const visible = visibleItems(album.id, viewer, membership.role);
    const published = visible.filter((item) => item.state === "published" || item.state === "updatePending");
    const preparing = visible.length - published.length;
    const cover = published[0]?.rendition ? { itemId: published[0].id, renditionId: published[0].rendition.id } : null;
    return {
      id: album.id, owner: personLabel(album.owner, viewer), name: album.name, revision: album.revision,
      createdAt: album.createdAt, updatedAt: album.updatedAt, itemCount: published.length,
      memberCount: [...memberships.values()].filter((entry) => entry.albumId === album.id && entry.state === "active").length, cover,
      access: {
        role: membership.role, membershipRevision: membership.revision, permissions: permissionsFor(membership.role),
        preparation: preparing > 0 ? { prepared: published.length, total: visible.length } : null,
      },
    };
  }
  function page<T>(
    actor: UserId,
    scope: Parameters<typeof checkCursor>[0]["scope"],
    query: { readonly cursor?: string; readonly limit?: number },
    max: number,
    all: readonly T[],
  ): { readonly items: readonly T[]; readonly nextCursor: string | null } {
    const limit = query.limit ?? max;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) fail("invalid_request");
    const queryDigest = digest(canonical({ limit }));
    let offset = 0;
    if (query.cursor !== undefined) {
      const cursor = cursors.get(query.cursor) ?? fail("invalid_cursor");
      decided(checkCursor(cursor.binding, { actorId: actor, scope, queryDigest }, instant()));
      offset = cursor.offset;
    }
    const slice = all.slice(offset, offset + limit);
    let nextCursor: string | null = null;
    if (offset + limit < all.length) {
      nextCursor = nextId("cursor");
      cursors.set(nextCursor, { binding: { actorId: actor, scope, queryDigest, issuedAt: instant() }, offset: offset + limit });
    }
    return { items: slice, nextCursor };
  }
  /** Account-level access revision: changes with every join, leave, removal, role change and album deletion. */
  function accessRevision(actor: UserId): number {
    let total = 0;
    for (const membership of memberships.values()) {
      if (membership.userId !== actor) continue;
      total += membership.revision + 1;
      if (albums.get(membership.albumId)?.deleted) total += 1;
    }
    return total;
  }
  function addEvent(ownerId: UserId, event: MemberJoinedEvent): void {
    events.set(ownerId, [...(events.get(ownerId) ?? []), event]);
  }
  function recentFailures(actor: UserId): number[] {
    const since = clock() - joinLimit.windowSeconds * 1000;
    const recent = (failedJoins.get(actor) ?? []).filter((at) => at > since);
    failedJoins.set(actor, recent);
    return recent;
  }

  // -------------------------------------------------------------------------------------------------------
  // Operations

  /** One operation for one signed-in actor. Returns the plain response; idempotency is handled by the caller. */
  function execute(actor: UserId, operation: SharedAlbumMockOperation, request: Record<string, unknown>): unknown {
    switch (operation) {
      case "storage.get": {
        const used = usedBytes(actor);
        const reserved = reservedBytes(actor);
        return {
          owner: { type: "user", userId: actor }, quotaBytes: quotaOf(actor), usedBytes: used, previewBytes: 0, maskBytes: 0, renditionBytes: used,
          exportStagingBytes: 0, reservedBytes: reserved, availableBytes: Math.max(0, quotaOf(actor) - used - reserved),
        };
      }
      case "albums.list": {
        const mine = [...albums.values()]
          .filter((album) => !album.deleted && membershipOf(album.id, actor)?.state === "active")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        const result = page(actor, { kind: "albums", accessRevision: accessRevision(actor) }, request, SHARING_LIMITS.listMaxCount, mine);
        return { items: result.items.map((album) => projectAlbum(album, actor)), nextCursor: result.nextCursor };
      }
      case "albums.create": {
        decided(checkAlbumName(String(request.name)));
        const owner = person(actor);
        const now = instant();
        const album: AlbumRecord = { id: nextId("album"), owner, name: String(request.name), revision: 1, createdAt: now, updatedAt: now, deleted: false };
        albums.set(album.id, album);
        memberships.set(membershipKey(album.id, actor), {
          id: nextId("membership"), albumId: album.id, userId: actor, role: "owner", state: "active", revision: 1, joinedAt: now,
          endedAt: null, joinedVia: null,
        });
        return { value: projectAlbum(album, actor), replayed: false };
      }
      case "albums.get": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "view"));
        return projectAlbum(album, actor);
      }
      case "albums.rename": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "renameAlbum"));
        decided(checkAlbumName(String(request.name)));
        if (request.expectedRevision !== album.revision) fail("revision_conflict", { currentRevision: album.revision });
        album.name = String(request.name);
        album.revision += 1;
        album.updatedAt = instant();
        return { value: projectAlbum(album, actor), replayed: false };
      }
      case "albums.delete": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "deleteAlbum"));
        if (request.expectedRevision !== album.revision) fail("revision_conflict", { currentRevision: album.revision });
        // Renditions go; originals, the owner's library and members' devices are untouched.
        for (const item of items.values()) if (item.albumId === album.id) removeItem(item);
        album.deleted = true;
        album.revision += 1;
        capacityFreed(album.owner.userId);
        return { value: { albumId: album.id, state: "deleted" }, replayed: false };
      }
      case "invites.list": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "manageInvites"));
        const albumLinks = [...links.values()].filter((link) => link.albumId === album.id);
        const linkIds = new Set(albumLinks.map((link) => link.id));
        return {
          links: albumLinks.map((link) => projectLink(link, actor)),
          joins: joins.filter((join) => linkIds.has(join.inviteLinkId)).map((join) => ({
            inviteLinkId: join.inviteLinkId, membershipId: join.membershipId, member: personLabel(person(join.userId), actor), joinedAt: join.joinedAt,
          })),
        };
      }
      case "invites.create": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "manageInvites"));
        if (!(MEMBER_ROLES as readonly string[]).includes(String(request.role))) fail("invalid_request");
        const now = clock();
        const link: LinkRecord = {
          id: nextId("invite"), albumId: album.id, role: request.role as MemberRole, createdBy: actor, createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + SHARING_LIMITS.inviteLinkLifetimeSeconds * 1000).toISOString(), revoked: false, revokedAt: null, joinCount: 0,
        };
        const secret = newSecret();
        links.set(link.id, link);
        // Only a digest is kept; the secret itself leaves in this one response.
        linkBySecretDigest.set(digest(secret), link.id);
        return { value: { link: projectLink(link, actor), secret }, replayed: false };
      }
      case "invites.revoke": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "manageInvites"));
        const link = links.get(String(request.inviteLinkId));
        if (!link || link.albumId !== album.id) return fail("not_found");
        if (!link.revoked) {
          link.revoked = true;
          link.revokedAt = instant();
        }
        return { value: projectLink(link, actor), replayed: false };
      }
      case "invites.join": {
        if (recentFailures(actor).length >= joinLimit.failures) fail("rate_limited", { retryAfterSeconds: joinLimit.windowSeconds });
        const linkId = linkBySecretDigest.get(digest(String(request.secret)));
        const link = linkId === undefined ? null : links.get(linkId) ?? null;
        const found = link ? albums.get(link.albumId) ?? null : null;
        const album = found && !found.deleted ? found : null;
        const existing = album ? membershipOf(album.id, actor) : null;
        const decision = decideJoin({
          actorId: actor,
          link: link && album ? projectLink(link, album.owner.userId) : null,
          album: album ? { ownerId: album.owner.userId, lifecycle: "active" } : null,
          existing: existing ? { role: existing.role, state: existing.state } : null,
          lastRemovedAt: album ? lastRemovedAt.get(membershipKey(album.id, actor)) ?? null : null,
          now: instant(),
        });
        if (!decision.ok) {
          failedJoins.set(actor, [...recentFailures(actor), clock()]);
          return fail(decision.code);
        }
        const target = album as AlbumRecord;
        const accepted = link as LinkRecord;
        let membership = existing;
        if (decision.joined) {
          const now = instant();
          if (membership) {
            // left/removed → active (MEMBERSHIP_TRANSITIONS): same row, the link's role, a new revision.
            membership.role = accepted.role;
            membership.state = "active";
            membership.revision += 1;
            membership.joinedAt = now;
            membership.endedAt = null;
            membership.joinedVia = accepted.id;
          } else {
            membership = {
              id: nextId("membership"), albumId: target.id, userId: actor, role: accepted.role, state: "active", revision: 1, joinedAt: now,
              endedAt: null, joinedVia: accepted.id,
            };
            memberships.set(membershipKey(target.id, actor), membership);
          }
          accepted.joinCount += 1;
          joins.push({ inviteLinkId: accepted.id, membershipId: membership.id, userId: actor, joinedAt: now });
          addEvent(target.owner.userId, {
            kind: "memberJoined", albumId: target.id, membershipId: membership.id, member: personLabel(person(actor), target.owner.userId),
            role: accepted.role, inviteLinkId: accepted.id, at: now,
          });
        }
        const current = membership ?? (membershipOf(target.id, actor) as MembershipRecord);
        return {
          value: { album: projectAlbum(target, actor), membership: projectMembership(current, actor), joined: decision.joined },
          replayed: false,
        };
      }
      case "members.list": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        decided(decideAlbumAction(viewer, "view"));
        const active = [...memberships.values()]
          .filter((membership) => membership.albumId === album.id && membership.state === "active")
          .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
        const result = page(actor, { kind: "members", albumId: album.id, membershipRevision: viewer.membership?.revision ?? 0 }, request, SHARING_LIMITS.memberListMaxCount, active);
        return { items: result.items.map((membership) => projectMembership(membership, actor)), nextCursor: result.nextCursor };
      }
      case "members.changeRole":
      case "members.remove":
      case "members.leave": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        if (operation === "members.changeRole" && !(MEMBER_ROLES as readonly string[]).includes(String(request.role))) fail("invalid_request");
        const target = operation === "members.leave"
          ? membershipOf(album.id, actor)
          : [...memberships.values()].find((membership) => membership.albumId === album.id && membership.id === request.membershipId) ?? null;
        const change = operation === "members.changeRole" ? "changeRole" : operation === "members.remove" ? "removeMember" : "leave";
        decided(decideMembershipChange(viewer, change, {
          userId: target?.userId ?? "",
          membership: target ? { role: target.role, state: target.state, revision: target.revision } : null,
          ...(operation === "members.changeRole" ? { expectedRevision: request.expectedRevision as number } : {}),
        }));
        const record = target as MembershipRecord;
        const now = instant();
        if (operation === "members.changeRole") {
          record.role = request.role as MemberRole;
        } else {
          record.state = operation === "members.remove" ? "removed" : "left";
          record.endedAt = now;
          // Kept per album and user; survives later rejoins and leaves (decideJoin).
          if (operation === "members.remove") lastRemovedAt.set(membershipKey(album.id, record.userId), now);
        }
        record.revision += 1;
        if (record.state !== "active" || !permissionsFor(record.role).addItem) endUnpublishedAdds(album.id, record.userId);
        return { value: projectMembership(record, actor), replayed: false };
      }
      case "albumItems.addPhoto": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        const source = request.source as AddPhotoSource;
        const library = source.kind === "libraryPhoto" ? libraries.get(source.libraryId) ?? null : null;
        decided(decideAddPhoto(viewer, source, library ? { ownerId: library.ownerId, lifecycle: "active" } : null));
        const photo = source.kind === "libraryPhoto" ? library?.photos.get(source.photoId) ?? fail("not_found") : null;
        if (source.kind === "devicePhoto") requireCapacity(album, actor, source.rendition.sizeBytes);
        const kind = album.owner.userId === actor ? "ownerPhoto" : "memberEdit";
        const base: AlbumItemSnapshot = {
          id: nextId("item"), albumId: album.id, kind, addedBy: person(actor), addedAt: instant(), revision: 0, state: "preparing",
          source: source.kind === "libraryPhoto"
            ? { kind: "libraryPhoto", libraryId: source.libraryId, photoId: source.photoId }
            : { kind: "devicePhoto", deviceSourceRef: source.deviceSourceRef },
          rendition: null, renditionBinding: null, pendingReason: "rendering", removedAt: null, pendingUpload: null,
        };
        if (source.kind === "libraryPhoto") {
          const item = setItem({ ...base, pendingReason: deviceIsOnline(actor) ? "rendering" : "waitingForDevice" });
          desired.set(item.id, photo as DesiredRender);
          enqueueRender(item, album, { libraryId: source.libraryId, photoId: source.photoId });
          return { value: { item: projectItem(item, actor), upload: null }, replayed: false };
        }
        const start = startUpload(album, actor, base, source.rendition, source.binding);
        const item = setItem({ ...base, pendingUpload: { uploadId: start.upload.id, binding: source.binding } });
        return { value: { item: projectItem(item, actor), upload: start }, replayed: false };
      }
      case "albumItems.addFile": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "addItem"));
        const rendition = request.rendition as RenditionUploadRequest;
        requireCapacity(album, actor, rendition.sizeBytes);
        const base: AlbumItemSnapshot = {
          id: nextId("item"), albumId: album.id, kind: "fileUpload", addedBy: person(actor), addedAt: instant(), revision: 0, state: "preparing",
          source: null, rendition: null, renditionBinding: null, pendingReason: "rendering", removedAt: null, pendingUpload: null,
        };
        const start = startUpload(album, actor, base, rendition, null);
        const item = setItem({ ...base, pendingUpload: { uploadId: start.upload.id, binding: null } });
        return { value: { item: projectItem(item, actor), upload: start }, replayed: false };
      }
      case "albumItems.replace": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        const found = items.get(String(request.itemId)) ?? null;
        const content = request.content as ReplaceContent;
        decided(decideReplaceStart(viewer, found ? { ...found, addedBy: found.addedBy.userId, inRequestedAlbum: found.albumId === album.id } : null, {
          expectedRevision: request.expectedRevision as number,
          content,
        }));
        const item = found as AlbumItemSnapshot;
        requireCapacity(album, actor, content.rendition.sizeBytes);
        // The newest intent wins: an older pending upload is superseded and its reservation released.
        for (const record of uploads.values()) if (record.upload.itemId === item.id) releaseUpload(record, "cancelled");
        const binding = content.kind === "deviceRender" ? content.binding : null;
        const start = startUpload(album, actor, item, content.rendition, binding);
        const state = item.state === "published" ? (nextAlbumItemState(item.state, "sourceUpdated") ?? item.state) : item.state;
        const next = setItem({ ...item, state, pendingReason: "rendering", pendingUpload: { uploadId: start.upload.id, binding } });
        return { value: { item: projectItem(next, actor), upload: start }, replayed: false };
      }
      case "albumItems.commitUpload": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        const record = uploads.get(String(request.uploadId));
        if (!record || record.upload.albumId !== album.id) return fail("not_found");
        const item = items.get(record.upload.itemId) ?? null;
        // Re-checked at commit time: removal, leaving or demotion after the upload started wins (Epic §10).
        const first = decideUploadCommit({ viewer, item, upload: record.upload, bytesMetadata: {}, now: instant() });
        if (!first.ok) {
          // Bytes still missing is not final (continue the upload, then commit); every other refusal ends the upload.
          if (first.code !== "upload_state_conflict") releaseUpload(record, first.code === "upload_expired" ? "expired" : "cancelled");
          return fail(first.code);
        }
        if (!record.bytes) return fail("upload_state_conflict");
        // Re-decode: the stored rendition is rebuilt with the frame, tables and scans only; its size must match.
        const rebuilt = stripJpegMetadata(record.bytes);
        const decoded = rebuilt ? readJpegPixelSize(rebuilt) : null;
        if (!rebuilt || !decoded || decoded.width !== record.rendition.width || decoded.height !== record.rendition.height) {
          releaseUpload(record, "rejected");
          return fail("content_rejected");
        }
        decided(decideUploadCommit({ viewer, item, upload: record.upload, bytesMetadata: jpegMetadataRecord(rebuilt), now: instant() }));
        const current = item as AlbumItemSnapshot;
        record.upload = { ...record.upload, state: "committed", uploadedBytes: record.upload.sizeBytes };
        const published = publish(current, buildRendition(rebuilt, record.rendition.metadata, record.upload.targetItemRevision), record.binding);
        capacityFreed(album.owner.userId);
        return { value: projectItem(published, actor), replayed: false };
      }
      case "albumItems.renewUpload": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        const record = uploads.get(String(request.uploadId));
        if (!record || record.upload.albumId !== album.id) return fail("not_found");
        decided(decideUploadRenew({ viewer, item: items.get(record.upload.itemId) ?? null, upload: record.upload, now: instant() }));
        // The same upload and reservation; the provider keeps what it already holds.
        return {
          upload: record.upload,
          ticket: { url: `${SHARED_ALBUM_MOCK_TICKET_PREFIX}${record.upload.id}`, method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: record.upload.expiresAt, resumeOffsetBytes: record.upload.uploadedBytes },
        };
      }
      case "albumItems.cancelUpload": {
        const album = albumOr404(String(request.albumId));
        decided(decideAlbumAction(viewerOf(album.id, actor), "view"));
        const record = uploads.get(String(request.uploadId));
        // Only the uploader may cancel; anyone else's upload is indistinguishable from a missing one.
        if (!record || record.upload.albumId !== album.id || record.addedBy !== actor) return fail("not_found");
        if (record.upload.state === "reserved") {
          releaseUpload(record, "cancelled");
          const item = items.get(record.upload.itemId);
          if (item && item.pendingUpload?.uploadId === record.upload.id) {
            // An abandoned replace leaves the published rendition as it was; an abandoned add stays preparing.
            const restore = item.state === "updatePending" ? { state: "published" as const, pendingReason: null } : {};
            setItem({ ...item, ...restore, pendingUpload: null });
          }
        }
        return { value: record.upload, replayed: false };
      }
      case "albumItems.get":
      case "albumItems.remove": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        // Looked up across all albums: an item ID from another album is indistinguishable from a missing one.
        const item = items.get(String(request.itemId));
        const target = item ? { addedBy: item.addedBy.userId, state: item.state, inRequestedAlbum: item.albumId === album.id } : undefined;
        if (!target) {
          decided(decideAlbumAction(viewer, "view"));
          return fail("not_found");
        }
        decided(decideAlbumAction(viewer, operation === "albumItems.get" ? "view" : "removeItem", target));
        const snapshot = operation === "albumItems.remove" ? removeItem(item as AlbumItemSnapshot) : (item as AlbumItemSnapshot);
        const projected = projectItem(snapshot, actor);
        if (!projected) return fail("not_found");
        return operation === "albumItems.get" ? projected : { value: projected, replayed: false };
      }
      case "albumItems.list": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        decided(decideAlbumAction(viewer, "view"));
        const role = viewer.membership?.role as AlbumRole;
        const membershipRevision = viewer.membership?.revision ?? 0;
        const result = page(actor, { kind: "album", albumId: album.id, membershipRevision }, request, SHARING_LIMITS.listMaxCount, visibleItems(album.id, actor, role));
        return { items: result.items, nextCursor: result.nextCursor, albumRevision: album.revision, membershipRevision };
      }
    }
    return fail("invalid_request");
  }

  /** The full rendition or its thumbnail, for every role that may view the item. */
  function download(actor: UserId | null, request: SharingOperationMap["albumItems.download"]["request"]): { bytes: Uint8Array; total: number; range: { start: number; endInclusive: number }; partial: boolean; sha256: string } {
    callCounts.set("albumItems.download", (callCounts.get("albumItems.download") ?? 0) + 1);
    if (actor === null || !people.has(actor)) return fail("unauthenticated");
    if (!isOpaqueWireId(request.albumId) || !isOpaqueWireId(request.itemId) || !isOpaqueWireId(request.renditionId) || (request.variant !== "full" && request.variant !== "thumbnail")) {
      return fail("invalid_request");
    }
    const album = albumOr404(request.albumId);
    const viewer = viewerOf(album.id, actor);
    const item = items.get(request.itemId);
    if (!item) {
      decided(decideAlbumAction(viewer, "view"));
      return fail("not_found");
    }
    decided(decideAlbumAction(viewer, "download", { addedBy: item.addedBy.userId, state: item.state, inRequestedAlbum: item.albumId === album.id }));
    const projected = projectItem(item, actor);
    if (!projected?.rendition || projected.rendition.id !== request.renditionId) return fail("not_found");
    const bytes = renditionStore.get(request.renditionId) ?? fail("not_found");
    const total = bytes.byteLength;
    const start = request.range?.start ?? 0;
    const endInclusive = Math.min(request.range?.endInclusive ?? total - 1, total - 1);
    if (!Number.isSafeInteger(start) || start < 0 || endInclusive < start) return fail("invalid_request");
    return { bytes: bytes.subarray(start, endInclusive + 1), total, range: { start, endInclusive }, partial: request.range !== undefined, sha256: projected.rendition.asset.sha256 };
  }

  /** Request validation, idempotency and the lost-response switch around `execute`. */
  function dispatch(actor: UserId | null, operation: string, request: unknown, key: string | undefined): unknown {
    if (!isMockOperation(operation)) throw new PersonalPhotoCloudError("unsupported");
    callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
    if (actor === null || !people.has(actor)) return fail("unauthenticated");
    // The server re-validates everything a modified client could send: closed shape, required fields, scalar types,
    // opaque IDs and the idempotency key rules (the same rules the browser client applies before sending).
    if (!validMockRequest(operation, request)) return fail("invalid_request");
    const mutation = MUTATIONS.has(operation);
    if (mutation ? !isValidIdempotencyKey(key) : key !== undefined) return fail("invalid_request");
    if (!mutation) return execute(actor, operation, request as Record<string, unknown>);
    const albumId = (request as { readonly albumId?: unknown }).albumId;
    const record: IdempotencyRecord = {
      actor: { kind: "user", userId: actor },
      // A join is replayed per account (the album is not known before the secret resolves).
      scope: typeof albumId === "string" ? { kind: "album", albumId } : { kind: "account" },
      operation: operation as IdempotencyRecord["operation"],
      key: key as string,
      payloadSha256: digest(canonical(request)),
    };
    const identity = canonical({ actor: record.actor, scope: record.scope, operation: record.operation, key: record.key });
    const previous = stored.get(identity) ?? null;
    const comparison = compareIdempotency(previous?.record ?? null, record);
    if (comparison === "conflict") return fail("idempotency_conflict");
    let response: unknown;
    if (comparison === "replay" && previous) {
      response = replayOf(operation, previous.response);
    } else {
      response = execute(actor, operation, request as Record<string, unknown>);
      stored.set(identity, { record, response: structuredClone(response) });
    }
    if (loseNext) {
      loseNext = false;
      throw new PersonalPhotoCloudError("unavailable");
    }
    return response;
  }

  function holdPending(secret: InviteSecret, actorId: UserId | null = null): PendingInviteHeld {
    if (!isSecret(secret)) fail("invalid_request");
    // A new hold replaces the previous one.
    heldInvite = holdPendingInvite({ id: nextId("pending"), secret, actorId, now: instant() });
    return { expiresAt: heldInvite.expiresAt };
  }

  /** The BFF's `invites.joinPending`: decide, delete the cookie (unless signed out), then the normal `invites.join`. */
  function joinPending(actorId: UserId | null): InviteJoinResult {
    const pending = heldInvite;
    const decision = decidePendingInviteJoin({ actorId, pending, consumed: pending !== null && usedPendingIds.has(pending.id), now: instant() });
    if (decision.clearCookie) heldInvite = null;
    if (!decision.ok) return fail(decision.code);
    const used = pending as PendingInvite;
    usedPendingIds.add(used.id);
    const receipt = dispatch(actorId, "invites.join", { secret: used.secret }, `pending-invite-${used.id}`) as MutationReceipt<InviteJoinResult>;
    return receipt.value;
  }

  function clientFor(actorId: UserId | null): SharedAlbumMockClient {
    let disposed = false;
    const live = (signal: AbortSignal): void => {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
    };
    return {
      scope: Object.freeze({ actorId: actorId ?? "", sessionEpoch: "mock-session" }),
      async request(operation, request, requestOptions) {
        live(requestOptions.signal);
        const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
        // Responses are copied so callers never share the server's objects.
        return structuredClone(dispatch(actorId, operation, structuredClone(request), key)) as never;
      },
      async download(request, signal) {
        live(signal);
        const served = download(actorId, structuredClone(request));
        return { body: new Blob([served.bytes.slice()]).stream(), contentType: "image/jpeg", sha256: served.sha256, totalBytes: served.total, range: served.range };
      },
      async joinPending(signal) {
        if (disposed) throw new PersonalPhotoCloudError("disposed");
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        return structuredClone(joinPending(actorId));
      },
      dispose() {
        disposed = true;
      },
    };
  }

  function renderTransportFor(userId: UserId): RenderExecutorTransport {
    const executor = { kind: "userDevice", userId } as const;
    return {
      async request(operation, request, requestOptions) {
        callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
        if (requestOptions.signal.aborted) throw requestOptions.signal.reason instanceof Error ? requestOptions.signal.reason : new DOMException("Aborted", "AbortError");
        const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
        if (operation === "renderJobs.renewOutput") {
          if (key !== undefined) return fail("invalid_request");
          return structuredClone(executeRender(executor, operation, request)) as never;
        }
        if (!isValidIdempotencyKey(key)) return fail("invalid_request");
        const record = {
          actor: { kind: "user", userId }, scope: { kind: "account" }, operation, key, payloadSha256: digest(canonical(request)),
        } as unknown as IdempotencyRecord;
        const identity = canonical({ userId, operation, key });
        const previous = renderStored.get(identity) ?? null;
        const comparison = compareIdempotency(previous?.record ?? null, record);
        if (comparison === "conflict") return fail("idempotency_conflict");
        if (comparison === "replay" && previous) {
          const value = (previous.response as { value: Record<string, unknown> }).value;
          if (operation === "renderJobs.claim") {
            // The same jobs and leases, while they are still held.
            const held = (value.jobs as readonly ClaimedRenderJob[]).filter((claimed) => {
              const job = jobs.get(claimed.job.id);
              return job?.job.state === "claimed" && job.leaseToken === claimed.lease.leaseToken;
            });
            return structuredClone({ value: { jobs: held }, replayed: true }) as never;
          }
          return structuredClone({ value: operation === "renderJobs.startOutput" ? { ...value, ticket: null } : value, replayed: true }) as never;
        }
        const response = executeRender(executor, operation, request);
        renderStored.set(identity, { record, response: structuredClone(response) });
        return structuredClone(response) as never;
      },
    };
  }

  const uploader: RenderOutputUploader = {
    async upload(ticket, bytes, contentType, signal) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      const id = ticket.url.startsWith(SHARED_ALBUM_MOCK_TICKET_PREFIX) ? ticket.url.slice(SHARED_ALBUM_MOCK_TICKET_PREFIX.length) : "";
      const digestHex = bytesToHex(sha256(bytes));
      const album = uploads.get(id);
      if (album) {
        if (album.upload.state !== "reserved" || contentType !== "image/jpeg" || clock() >= Date.parse(album.upload.expiresAt)) throw new TypeError("synthetic upload refused");
        if (bytes.byteLength !== album.upload.sizeBytes || digestHex !== album.upload.sha256) throw new TypeError("synthetic upload hash mismatch");
        album.bytes = bytes.slice();
        album.upload = { ...album.upload, uploadedBytes: bytes.byteLength };
        return;
      }
      const output = outputs.get(id);
      if (!output || output.state !== "reserved" || contentType !== "image/jpeg") throw new TypeError("synthetic upload refused");
      if (bytes.byteLength !== output.sizeBytes || digestHex !== output.sha256) {
        output.state = "rejected";
        throw new TypeError("synthetic upload hash mismatch");
      }
      output.bytes = bytes.slice();
      output.state = "uploaded";
    },
  };

  const handleFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request
      ? (init === undefined ? input : new Request(input, init))
      : new Request(new URL(String(input), "https://photo.example.test"), init);
    const url = new URL(request.url);
    const pendingRoute = matchPendingInviteRoute(request.method, url.pathname);
    if (pendingRoute !== null) return await handlePending(request, url, pendingRoute);
    const matched = matchSharingRoute(request.method, url.pathname);
    if (matched === null || !(isMockOperation(matched.operation) || matched.operation === "albumItems.download")) {
      return jsonResponse(404, { error: { code: "not_found", requestId: nextId("request"), retryable: false } });
    }
    const operation = matched.operation;
    const actor = request.headers.get(PHOTO_CAPTURE_HEADERS.actorId);
    const key = request.headers.get(PHOTO_IDEMPOTENCY_HEADER) ?? undefined;
    const invalid = (): Response => jsonResponse(400, { error: { code: "invalid_request", requestId: nextId("request"), retryable: false } });
    let decoded: unknown;
    try {
      const text = await request.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      const range = operation === "albumItems.download" ? parseRangeHeader(request.headers.get("Range")) : null;
      if (range === undefined) return invalid();
      // Placement (path, query, body) is the route table's; values are checked again by `dispatch`.
      decoded = decodeSharingRequest(operation, { params: matched.params, query: url.searchParams, body, range });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SharingRouteError) return invalid();
      throw error;
    }
    try {
      if (operation === "albumItems.download") {
        const served = download(actor, decoded as SharingOperationMap["albumItems.download"]["request"]);
        const headers = new Headers({
          "Content-Type": "image/jpeg", "Content-Length": String(served.bytes.byteLength),
          [PHOTO_CONTENT_HEADERS.sha256]: served.sha256, [PHOTO_CONTENT_HEADERS.totalBytes]: String(served.total),
        });
        if (served.partial) headers.set("Content-Range", `bytes ${served.range.start}-${served.range.endInclusive}/${served.total}`);
        return new Response(served.bytes.slice(), { status: served.partial ? 206 : 200, headers });
      }
      return jsonResponse(200, dispatch(actor, operation, decoded, key));
    } catch (error) {
      if (error instanceof PersonalPhotoCloudError && error.code === "unavailable") throw new TypeError("Failed to fetch");
      if (isEnvelope(error)) return jsonResponse(SHARING_ERROR_STATUS[error.error.code], error);
      throw error;
    }
  };

  /** The pending-invite routes of the BFF, for the browser client in development (one cookie jar, no encryption). */
  async function handlePending(request: Request, url: URL, route: NonNullable<ReturnType<typeof matchPendingInviteRoute>>): Promise<Response> {
    const actor = request.headers.get(PHOTO_CAPTURE_HEADERS.actorId);
    const envelope = (code: SharingErrorCode): Response => jsonResponse(SHARING_ERROR_STATUS[code], { error: { code, requestId: nextId("request"), retryable: false } });
    let decoded: Record<string, unknown>;
    try {
      if (request.headers.has(PHOTO_IDEMPOTENCY_HEADER)) return envelope("invalid_request");
      const text = await request.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      decoded = decodePendingInviteRequest(route.operation, { params: route.params, query: url.searchParams, body, range: null }) as Record<string, unknown>;
      if (findUnexpectedPendingInviteFields(route.operation, decoded).length > 0) return envelope("invalid_request");
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SharingRouteError) return envelope("invalid_request");
      throw error;
    }
    try {
      if (route.operation === "invites.holdPending") return jsonResponse(200, holdPending(decoded.secret as InviteSecret, actor));
      return jsonResponse(200, joinPending(actor));
    } catch (error) {
      if (error instanceof PersonalPhotoCloudError && error.code === "unavailable") throw new TypeError("Failed to fetch");
      if (isEnvelope(error)) return jsonResponse(SHARING_ERROR_STATUS[error.error.code], error);
      throw error;
    }
  }

  return {
    clientFor,
    fetch: handleFetch,
    holdPendingInvite: (secret, actorId) => structuredClone(holdPending(secret, actorId ?? null)),
    memberJoinedEvents: (ownerId) => [...(events.get(ownerId) ?? [])],
    loseNextResponse: () => {
      loseNext = true;
    },
    uploader,
    renderTransportFor,
    setDeviceOnline,
    addLibraryPhoto(photo) {
      const library = libraries.get(photo.libraryId) ?? { ownerId: photo.ownerId, photos: new Map<string, DesiredRender>() };
      if (library.ownerId !== photo.ownerId) throw new Error("synthetic library belongs to another user");
      library.photos.set(photo.photoId, { binding: photo.binding, recipe: photo.recipe, expectedOutput: photo.expectedOutput ?? null });
      libraries.set(photo.libraryId, library);
    },
    saveLibraryRecipe(photo) {
      const library = libraries.get(photo.libraryId);
      if (!library || library.ownerId !== photo.ownerId) throw new Error("unknown synthetic library photo");
      const want: DesiredRender = { binding: photo.binding, recipe: photo.recipe, expectedOutput: photo.expectedOutput ?? null };
      library.photos.set(photo.photoId, want);
      for (const item of items.values()) {
        const source = item.source;
        if (item.state === "removed" || source?.kind !== "libraryPhoto" || source.libraryId !== photo.libraryId || source.photoId !== photo.photoId) continue;
        // published → updatePending; a preparing item keeps preparing with the new binding.
        const state = item.state === "preparing" ? "preparing" : nextAlbumItemState(item.state, "sourceUpdated") ?? item.state;
        const reason: AlbumItemPendingReason = deviceIsOnline(item.addedBy.userId) ? "rendering" : "waitingForDevice";
        const next = setItem({ ...item, state, pendingReason: reason });
        desired.set(item.id, want);
        enqueueRender(next, albums.get(item.albumId) as AlbumRecord, { libraryId: photo.libraryId, photoId: photo.photoId });
      }
    },
    hasLibraryPhoto: (libraryId, photoId) => libraries.get(libraryId)?.photos.has(photoId) ?? false,
    setQuotaBytes(ownerId, bytes) {
      quotas.set(ownerId, bytes);
      capacityFreed(ownerId);
    },
    storageOf: (ownerId) => ({ usedBytes: usedBytes(ownerId), reservedBytes: reservedBytes(ownerId) }),
    renditionBytes(itemId) {
      const rendition = items.get(itemId)?.rendition;
      return rendition ? renditionStore.get(rendition.id) ?? null : null;
    },
    item(itemId) {
      return structuredClone(items.get(itemId) ?? fail("not_found"));
    },
    renderJobs: () => [...jobs.values()].map((record) => ({
      id: record.job.id, itemId: record.job.purpose.kind === "albumItem" ? record.job.purpose.itemId : null, state: record.job.state, failure: record.job.failure,
    })),
    calls: (operation) => callCounts.get(operation) ?? 0,
  };
}

/** A replayed answer: same value, `replayed: true`, and no bearer secrets or tickets the first answer carried. */
function replayOf(operation: SharedAlbumMockOperation, response: unknown): unknown {
  const receipt = response as { readonly value: Record<string, unknown> };
  if (operation === "invites.create") return { value: { ...receipt.value, secret: null }, replayed: true };
  if (operation === "albumItems.addFile" || operation === "albumItems.addPhoto" || operation === "albumItems.replace") {
    const upload = receipt.value.upload as Record<string, unknown> | null;
    return { value: { ...receipt.value, upload: upload ? { ...upload, ticket: null } : null }, replayed: true };
  }
  return { ...receipt, replayed: true };
}

/** Closed shape plus required fields and value types for every operation the mock serves. */
function validMockRequest(operation: SharedAlbumMockOperation, request: unknown): request is Record<string, unknown> {
  if (typeof request !== "object" || request === null || Array.isArray(request) || findUnexpectedRequestFields(operation, request).length > 0) return false;
  try {
    if (isSharedAlbumMembershipOperation(operation)) validateMembershipRequest(operation, request);
    else if (isSharedAlbumItemOperation(operation)) validateAlbumItemRequest(operation, request);
    else return false;
    return true;
  } catch {
    return false;
  }
}

/** `Range: bytes=start-end` → range; no header → null; anything else → undefined (invalid). */
function parseRangeHeader(value: string | null): PhotoByteRange | null | undefined {
  if (value === null) return null;
  const match = /^bytes=(\d{1,15})-(\d{0,15})$/u.exec(value);
  if (!match) return undefined;
  return match[2] === "" ? { start: Number(match[1]) } : { start: Number(match[1]), endInclusive: Number(match[2]) };
}

function isMockOperation(value: string): value is SharedAlbumMockOperation {
  return (SHARED_ALBUM_MOCK_OPERATIONS as readonly string[]).includes(value);
}
function isEnvelope(value: unknown): value is SharingErrorEnvelope {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as { error: { code?: unknown } }).error?.code === "string";
}
function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
/** 128 random bits (B00 `inviteSecretMinBits`), base64url without padding. */
function randomSecret(): InviteSecret {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
