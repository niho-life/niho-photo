/**
 * Synthetic in-memory shared-album server for development and tests (B05 #246). Not an authorization layer and never
 * selected by a production host: the real ledger, credentials and rate limits live behind the existing private
 * boundary. Every decision here is the contract's reference policy (B00 `./policy`), so the mock and the conformance
 * vectors cannot drift apart.
 *
 * Covers the membership and invite operations, plus the minimum of albums and items needed to show that membership
 * changes gate access (create/get an album; add, commit, get, list and remove a file item). It is separate from the
 * photo-level link sharing (`cloudSharing`) mock and knows nothing about share links.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { PersonalPhotoCloudError } from "../errors";
import { PHOTO_CAPTURE_HEADERS, PHOTO_IDEMPOTENCY_HEADER, isOpaqueWireId, isValidIdempotencyKey } from "../wire";

import {
  MEMBER_ROLES,
  SHARING_ERROR_STATUS,
  SHARING_LIMITS,
  SharingRouteError,
  canonical,
  checkAlbumName,
  checkCursor,
  compareIdempotency,
  decideAlbumAction,
  decideJoin,
  decideMembershipChange,
  decidePendingInviteJoin,
  decideUploadCommit,
  decodePendingInviteRequest,
  decodeSharingRequest,
  findUnexpectedPendingInviteFields,
  findUnexpectedRequestFields,
  holdPendingInvite,
  matchPendingInviteRoute,
  matchSharingRoute,
  permissionsFor,
  personLabel,
  projectAlbumItem,
  type Album,
  type AlbumItem,
  type AlbumItemSnapshot,
  type AlbumRole,
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
  type RenditionUpload,
  type RenditionUploadRequest,
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
  "albums.create",
  "albums.get",
  "albumItems.list",
  "albumItems.get",
  "albumItems.addFile",
  "albumItems.commitUpload",
  "albumItems.remove",
] as const;
export type SharedAlbumMockOperation = (typeof SHARED_ALBUM_MOCK_OPERATIONS)[number];

const MUTATIONS: ReadonlySet<string> = new Set([
  "invites.create", "invites.revoke", "invites.join", "members.changeRole", "members.remove", "members.leave",
  "albums.create", "albumItems.addFile", "albumItems.commitUpload", "albumItems.remove",
]);

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
}

export interface SharedAlbumMockClient {
  readonly scope: SharingSessionScope;
  request<K extends SharedAlbumMockOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
  /** `invites.joinPending` against this mock's stand-in for the BFF (see `holdPendingInvite`). */
  joinPending(signal: AbortSignal): Promise<InviteJoinResult>;
  dispose(): void;
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
  /** Puts bytes behind one of this mock's upload tickets (a commit needs every byte, B00 `upload_state_conflict`). */
  readonly uploader: { upload(ticket: { readonly url: string }, bytes: Uint8Array, contentType: string, signal: AbortSignal): Promise<void> };
}

/** Tickets of this mock point at a synthetic bucket on the trusted provider origin. */
export const SHARED_ALBUM_MOCK_TICKET_PREFIX = "https://storage.googleapis.com/synthetic-album-uploads/";

type AlbumRecord = {
  readonly id: string;
  readonly owner: LedgerPerson;
  readonly name: string;
  revision: number;
  readonly createdAt: Instant;
  updatedAt: Instant;
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
type UploadRecord = { upload: RenditionUpload; readonly rendition: RenditionUploadRequest; readonly addedBy: UserId };
type StoredMutation = { readonly record: IdempotencyRecord; readonly response: unknown };

const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;

export function createSharedAlbumMockServer(options: CreateSharedAlbumMockServerOptions): SharedAlbumMockServer {
  const clock = options.now ?? Date.now;
  const instant = (): Instant => new Date(clock()).toISOString();
  const newSecret = options.newSecret ?? randomSecret;
  const joinLimit = options.joinAttemptLimit ?? { failures: 10, windowSeconds: 10 * 60 };
  const people = new Map(options.users.map((user) => [user.userId, { userId: user.userId, displayName: user.displayName } satisfies LedgerPerson]));
  const albums = new Map<string, AlbumRecord>();
  const memberships = new Map<string, MembershipRecord>();
  const links = new Map<string, LinkRecord>();
  const linkBySecretDigest = new Map<string, string>();
  const joins: { inviteLinkId: string; membershipId: string; userId: UserId; joinedAt: Instant }[] = [];
  const items = new Map<string, AlbumItemSnapshot>();
  const uploads = new Map<string, UploadRecord>();
  const lastRemovedAt = new Map<string, Instant>();
  const events = new Map<UserId, MemberJoinedEvent[]>();
  const failedJoins = new Map<UserId, number[]>();
  const stored = new Map<string, StoredMutation>();
  const cursors = new Map<string, { readonly binding: Parameters<typeof checkCursor>[0]; readonly offset: number }>();
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
  const albumOr404 = (albumId: string): AlbumRecord => albums.get(albumId) ?? fail("not_found");
  const digest = (value: string): string => bytesToHex(sha256(new TextEncoder().encode(value)));

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
  function visibleItems(albumId: string, viewer: UserId, role: AlbumRole): AlbumItem[] {
    return [...items.values()]
      .filter((item) => item.albumId === albumId && item.state !== "removed")
      .map((item) => projectAlbumItem(item, { userId: viewer, role }))
      .filter((item): item is AlbumItem => item !== null);
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
  function addEvent(ownerId: UserId, event: MemberJoinedEvent): void {
    events.set(ownerId, [...(events.get(ownerId) ?? []), event]);
  }
  function recentFailures(actor: UserId): number[] {
    const since = clock() - joinLimit.windowSeconds * 1000;
    const recent = (failedJoins.get(actor) ?? []).filter((at) => at > since);
    failedJoins.set(actor, recent);
    return recent;
  }

  /** One operation for one signed-in actor. Returns the plain response; idempotency is handled by the caller. */
  function execute(actor: UserId, operation: SharedAlbumMockOperation, request: Record<string, unknown>): unknown {
    switch (operation) {
      case "albums.create": {
        decided(checkAlbumName(String(request.name)));
        const owner = person(actor);
        const now = instant();
        const album: AlbumRecord = { id: nextId("album"), owner, name: String(request.name), revision: 1, createdAt: now, updatedAt: now };
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
        const album = link ? albums.get(link.albumId) ?? null : null;
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
        return { value: projectMembership(record, actor), replayed: false };
      }
      case "albumItems.addFile": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        decided(decideAlbumAction(viewer, "addItem"));
        const rendition = request.rendition as RenditionUploadRequest;
        const now = clock();
        const uploadId = nextId("upload");
        const item: AlbumItemSnapshot = {
          id: nextId("item"), albumId: album.id, kind: "fileUpload", addedBy: person(actor), addedAt: new Date(now).toISOString(), revision: 0,
          state: "preparing", source: null, rendition: null, renditionBinding: null, pendingReason: "rendering", removedAt: null,
          pendingUpload: { uploadId, binding: null },
        };
        const upload: RenditionUpload = {
          id: uploadId, albumId: album.id, itemId: item.id, targetItemRevision: 1, sizeBytes: rendition.sizeBytes, sha256: rendition.sha256,
          expiresAt: new Date(now + UPLOAD_LIFETIME_MS).toISOString(), state: "reserved", uploadedBytes: 0,
        };
        items.set(item.id, item);
        uploads.set(uploadId, { upload, rendition, addedBy: actor });
        const role = viewer.membership?.role as AlbumRole;
        return {
          value: {
            item: projectAlbumItem(item, { userId: actor, role }),
            upload: {
              upload,
              ticket: { url: `${SHARED_ALBUM_MOCK_TICKET_PREFIX}${uploadId}`, method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: upload.expiresAt, resumeOffsetBytes: 0 },
            },
          },
          replayed: false,
        };
      }
      case "albumItems.commitUpload": {
        const album = albumOr404(String(request.albumId));
        const viewer = viewerOf(album.id, actor);
        const record = uploads.get(String(request.uploadId));
        if (!record || record.upload.albumId !== album.id) return fail("not_found");
        const item = items.get(record.upload.itemId) ?? null;
        // Re-checked at commit time: removal, leaving or demotion after the upload started wins (Epic §10).
        decided(decideUploadCommit({ viewer, item, upload: record.upload, bytesMetadata: {}, now: instant() }));
        const current = item as AlbumItemSnapshot;
        const now = instant();
        const published: AlbumItemSnapshot = {
          ...current, state: "published", revision: record.upload.targetItemRevision, pendingReason: null, pendingUpload: null,
          rendition: {
            id: nextId("rendition"), itemRevision: record.upload.targetItemRevision,
            asset: { sha256: record.rendition.sha256, sizeBytes: record.rendition.sizeBytes, contentType: "image/jpeg", width: record.rendition.width, height: record.rendition.height, fullResolution: true },
            thumbnail: { sha256: record.rendition.sha256, sizeBytes: Math.min(record.rendition.sizeBytes, 65536), contentType: "image/jpeg", width: 256, height: 256 },
            metadata: record.rendition.metadata, createdAt: now,
          },
        };
        items.set(published.id, published);
        record.upload = { ...record.upload, state: "committed", uploadedBytes: record.upload.sizeBytes };
        return { value: projectAlbumItem(published, { userId: actor, role: viewer.membership?.role as AlbumRole }), replayed: false };
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
        let snapshot = item as AlbumItemSnapshot;
        if (operation === "albumItems.remove" && snapshot.state !== "removed") {
          snapshot = { ...snapshot, state: "removed", rendition: null, removedAt: instant(), pendingUpload: null, pendingReason: null };
          items.set(snapshot.id, snapshot);
        }
        const projected = projectAlbumItem(snapshot, { userId: actor, role: viewer.membership?.role as AlbumRole });
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

  /** Request validation, idempotency and the lost-response switch around `execute`. */
  function dispatch(actor: UserId | null, operation: string, request: unknown, key: string | undefined): unknown {
    if (!isMockOperation(operation)) throw new PersonalPhotoCloudError("unsupported");
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
      stored.set(identity, { record, response });
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
    return {
      scope: Object.freeze({ actorId: actorId ?? "", sessionEpoch: "mock-session" }),
      async request(operation, request, requestOptions) {
        if (disposed) throw new PersonalPhotoCloudError("disposed");
        if (requestOptions.signal.aborted) throw requestOptions.signal.reason instanceof Error ? requestOptions.signal.reason : new DOMException("Aborted", "AbortError");
        const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
        // Responses are copied so callers never share the server's objects.
        return structuredClone(dispatch(actorId, operation, structuredClone(request), key)) as never;
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

  const handleFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request
      ? (init === undefined ? input : new Request(input, init))
      : new Request(new URL(String(input), "https://photo.example.test"), init);
    const url = new URL(request.url);
    const pendingRoute = matchPendingInviteRoute(request.method, url.pathname);
    if (pendingRoute !== null) return await handlePending(request, url, pendingRoute);
    const matched = matchSharingRoute(request.method, url.pathname);
    if (matched === null || !isMockOperation(matched.operation)) return jsonResponse(404, { error: { code: "not_found", requestId: nextId("request"), retryable: false } });
    const operation = matched.operation;
    const actor = request.headers.get(PHOTO_CAPTURE_HEADERS.actorId);
    const key = request.headers.get(PHOTO_IDEMPOTENCY_HEADER) ?? undefined;
    const invalid = (): Response => jsonResponse(400, { error: { code: "invalid_request", requestId: nextId("request"), retryable: false } });
    let decoded: unknown;
    try {
      const text = await request.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      // Placement (path, query, body) is the route table's; values are checked again by `dispatch`.
      decoded = decodeSharingRequest(operation, { params: matched.params, query: url.searchParams, body, range: null });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SharingRouteError) return invalid();
      throw error;
    }
    try {
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

  const uploader: SharedAlbumMockServer["uploader"] = {
    async upload(ticket, bytes, contentType, signal) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      const id = ticket.url.startsWith(SHARED_ALBUM_MOCK_TICKET_PREFIX) ? ticket.url.slice(SHARED_ALBUM_MOCK_TICKET_PREFIX.length) : "";
      const record = uploads.get(id);
      if (!record || record.upload.state !== "reserved" || contentType !== "image/jpeg" || clock() >= Date.parse(record.upload.expiresAt)) {
        throw new TypeError("synthetic upload refused");
      }
      if (bytes.byteLength !== record.upload.sizeBytes || bytesToHex(sha256(bytes)) !== record.upload.sha256) throw new TypeError("synthetic upload hash mismatch");
      record.upload = { ...record.upload, uploadedBytes: bytes.byteLength };
    },
  };

  return {
    clientFor,
    fetch: handleFetch,
    holdPendingInvite: (secret, actorId) => structuredClone(holdPending(secret, actorId ?? null)),
    uploader,
    memberJoinedEvents: (ownerId) => [...(events.get(ownerId) ?? [])],
    loseNextResponse: () => {
      loseNext = true;
    },
  };
}

/** A replayed answer: same value, `replayed: true`, and no bearer secrets or tickets the first answer carried. */
function replayOf(operation: SharedAlbumMockOperation, response: unknown): unknown {
  const receipt = response as { readonly value: Record<string, unknown> };
  if (operation === "invites.create") return { value: { ...receipt.value, secret: null }, replayed: true };
  if (operation === "albumItems.addFile") {
    const upload = receipt.value.upload as Record<string, unknown> | null;
    return { value: { ...receipt.value, upload: upload ? { ...upload, ticket: null } : null }, replayed: true };
  }
  return { ...receipt, replayed: true };
}

/** Closed shape plus required fields and value types for every operation the mock serves. */
function validMockRequest(operation: SharedAlbumMockOperation, request: unknown): request is Record<string, unknown> {
  if (typeof request !== "object" || request === null || Array.isArray(request) || findUnexpectedRequestFields(operation, request).length > 0) return false;
  if (isSharedAlbumMembershipOperation(operation)) {
    try {
      validateMembershipRequest(operation, request);
      return true;
    } catch {
      return false;
    }
  }
  const value = request as Record<string, unknown>;
  const optionalId = (key: string): boolean => value[key] === undefined || isOpaqueWireId(value[key]);
  switch (operation) {
    case "albums.create":
      return typeof value.name === "string";
    case "albums.get":
      return isOpaqueWireId(value.albumId);
    case "albumItems.list":
      return isOpaqueWireId(value.albumId) && optionalId("cursor") && (value.limit === undefined || Number.isSafeInteger(value.limit));
    case "albumItems.get":
    case "albumItems.remove":
      return isOpaqueWireId(value.albumId) && isOpaqueWireId(value.itemId);
    case "albumItems.commitUpload":
      return isOpaqueWireId(value.albumId) && isOpaqueWireId(value.uploadId);
    case "albumItems.addFile":
      return isOpaqueWireId(value.albumId) && validRendition(value.rendition);
  }
  return false;
}

function validRendition(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const rendition = value as Record<string, unknown>;
  const positive = (field: unknown): boolean => Number.isSafeInteger(field) && (field as number) > 0;
  const metadata = rendition.metadata as Record<string, unknown> | null | undefined;
  return positive(rendition.sizeBytes) && (rendition.sizeBytes as number) <= SHARING_LIMITS.fileUploadMaxBytes
    && typeof rendition.sha256 === "string" && /^[0-9a-f]{64}$/u.test(rendition.sha256)
    && rendition.contentType === "image/jpeg" && positive(rendition.width) && positive(rendition.height)
    && typeof metadata === "object" && metadata !== null
    && (metadata.capturedAt === null || typeof metadata.capturedAt === "string")
    && (metadata.capturedAtOffset === null || typeof metadata.capturedAtOffset === "string")
    && (metadata.colorProfile === "sRGB" || metadata.colorProfile === "displayP3") && metadata.orientation === 1;
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
