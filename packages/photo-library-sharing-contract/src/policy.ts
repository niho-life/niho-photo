/**
 * Reference decisions for the v1 contract. Pure functions shared by conformance runners, servers and hosts.
 * Hosts may use them to decide what to show; only the server ledger grants access.
 */
import {
  ALBUM_ITEM_TRANSITIONS,
  ALBUM_PERMISSIONS,
  FORBIDDEN_RENDITION_METADATA,
  RENDER_JOB_TRANSITIONS,
  SHARING_LIMITS,
  SHARING_REQUEST_KEYS,
} from "./v1.ts";
import type {
  AlbumAction,
  AlbumItem,
  AlbumItemEvent,
  AlbumItemSnapshot,
  AlbumItemState,
  AlbumPermissionSet,
  AlbumRole,
  ConnectorPairingTarget,
  CursorBinding,
  ForbiddenMetadataCategory,
  HostConnectorState,
  IdempotencyRecord,
  Instant,
  InviteLink,
  InviteLinkStatus,
  Membership,
  RenderBinding,
  RenderJob,
  RenderJobEvent,
  RenderJobState,
  RenderOutputRequest,
  RenditionMetadata,
  RenditionUpload,
  SharingErrorCode,
  SharingErrorEnvelope,
  SharingOperation,
  UserId,
} from "./v1.ts";

export type Decision = { readonly ok: true } | { readonly ok: false; readonly code: SharingErrorCode };
const allow: Decision = { ok: true };
const deny = (code: SharingErrorCode): Decision => ({ ok: false, code });
const time = (value: Instant): number => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError("invalid instant");
  return ms;
};

// ---------------------------------------------------------------------------------------------------------
// Requests and libraries

/** Keys outside the closed request shape (owner, role, revision or locator claims included). */
export function findUnexpectedRequestFields(operation: SharingOperation, request: Readonly<Record<string, unknown>>): readonly string[] {
  const allowed: readonly string[] = SHARING_REQUEST_KEYS[operation];
  return Object.keys(request).filter((key) => !allowed.includes(key));
}

/** Library-scoped operations are owner-only. Album membership never grants access to the owner's library. */
export function decideLibraryAccess(
  actorId: UserId | null,
  library: { readonly ownerId: UserId; readonly lifecycle: "active" | "deleting" } | null,
): Decision {
  if (!actorId) return deny("unauthenticated");
  if (!library || library.ownerId !== actorId) return deny("not_found");
  return library.lifecycle === "active" ? allow : deny("account_deleting");
}

/**
 * Hosted recipe saves complete in NIHO whatever the Mac is doing (Epic §8). A save edited against an older
 * recipe revision or source generation is a conflict, never a silent reuse on new bytes.
 */
export function decideHostedRecipeSave(input: {
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly sourceGeneration: number;
  readonly currentSourceGeneration: number;
  readonly connectorState: HostConnectorState | null;
}): { readonly ok: true; readonly replica: "current" | "pendingHost" } | { readonly ok: false; readonly code: SharingErrorCode } {
  if (input.expectedRevision !== input.currentRevision || input.sourceGeneration !== input.currentSourceGeneration) {
    return { ok: false, code: "revision_conflict" };
  }
  return { ok: true, replica: input.connectorState === "online" ? "current" : "pendingHost" };
}

/** One-time, short-lived pairing bound to the approving owner. Another owner's library is indistinguishable from missing. */
export function decidePairingApproval(input: {
  readonly actorId: UserId | null;
  readonly pairing: { readonly state: "pending" | "approved" | "consumed"; readonly expiresAt: Instant } | null;
  readonly target: ConnectorPairingTarget;
  /** Owner of target.libraryId, or null when it does not exist. */
  readonly targetOwnerId: UserId | null;
  readonly now: Instant;
}): Decision {
  if (!input.actorId) return deny("unauthenticated");
  if (!input.pairing || input.pairing.state !== "pending" || time(input.now) >= time(input.pairing.expiresAt)) {
    return deny("pairing_unavailable");
  }
  if (input.target.kind === "existingLibrary" && input.targetOwnerId !== input.actorId) return deny("not_found");
  return allow;
}

/** Album owners see capacity numbers; other members get the code alone (「アルバムがいっぱいです」). */
export function quotaExceededError(
  audience: "owner" | "member",
  requestId: string,
  storage: { readonly availableBytes: number; readonly requiredBytes: number },
): SharingErrorEnvelope["error"] {
  const base = { code: "quota_exceeded", requestId, retryable: false } as const;
  return audience === "owner" ? { ...base, storage } : base;
}

// ---------------------------------------------------------------------------------------------------------
// Album access

/** The viewer's own ledger entry for one album; null when the viewer never was a member. */
export interface AlbumViewer {
  readonly userId: UserId;
  readonly membership: Pick<Membership, "role" | "state" | "revision"> | null;
}
export interface AlbumTarget {
  readonly addedBy: UserId;
  readonly state: AlbumItemState;
  /** The item belongs to the album named in the request. */
  readonly inRequestedAlbum: boolean;
}

export function permissionsFor(role: AlbumRole): AlbumPermissionSet {
  return ALBUM_PERMISSIONS[role];
}

/** Preparing items are visible to the album owner and the adder only (Epic §9). */
export function canSeeItem(item: Pick<AlbumTarget, "addedBy" | "state">, viewer: { readonly userId: UserId; readonly role: AlbumRole }): boolean {
  return item.state !== "preparing" || viewer.role === "owner" || item.addedBy === viewer.userId;
}

/**
 * Non-members, ended memberships, other albums' items and hidden items are indistinguishable from missing (404).
 * An active member whose role lacks the action gets role_forbidden (403).
 */
export function decideAlbumAction(viewer: AlbumViewer, action: AlbumAction | "removeItem", target?: AlbumTarget): Decision {
  const membership = viewer.membership;
  if (!membership || membership.state !== "active") return deny("not_found");
  const needsTarget = action === "removeItem" || action === "replaceOwnItem";
  if (needsTarget && !target) return deny("invalid_request");
  if (target) {
    if (!target.inRequestedAlbum || !canSeeItem(target, { userId: viewer.userId, role: membership.role })) return deny("not_found");
    if (target.state === "removed" && action !== "view" && action !== "removeItem") return deny("item_removed");
  }
  const own = target?.addedBy === viewer.userId;
  // Replacing someone else's item is never allowed; the owner may only remove it.
  if (action === "replaceOwnItem" && !own) return deny("role_forbidden");
  const resolved: AlbumAction = action === "removeItem" ? (own ? "removeOwnItem" : "removeOthersItem") : action;
  return ALBUM_PERMISSIONS[membership.role][resolved] ? allow : deny("role_forbidden");
}

/** Owner-only membership changes. The owner cannot be demoted, removed or leave; ownership transfer is out of scope. */
export function decideMembershipChange(
  viewer: AlbumViewer,
  change: "changeRole" | "removeMember" | "leave",
  target: { readonly userId: UserId; readonly membership: Pick<Membership, "role" | "state" | "revision"> | null; readonly expectedRevision?: number },
): Decision {
  const membership = viewer.membership;
  if (!membership || membership.state !== "active") return deny("not_found");
  if (change === "leave") return membership.role === "owner" ? deny("role_forbidden") : allow;
  if (!ALBUM_PERMISSIONS[membership.role][change]) return deny("role_forbidden");
  if (!target.membership || target.membership.state !== "active") return deny("not_found");
  if (target.membership.role === "owner" || target.userId === viewer.userId) return deny("role_forbidden");
  if (change === "changeRole" && target.expectedRevision !== target.membership.revision) return deny("revision_conflict");
  return allow;
}

/**
 * Per-viewer projection of a server item. Returns null when the viewer must not see it.
 * - source: adder only. - pendingReason: owner and adder only; others see the previous rendition as published.
 */
export function projectAlbumItem(snapshot: AlbumItemSnapshot, viewer: { readonly userId: UserId; readonly role: AlbumRole }): AlbumItem | null {
  const adder = snapshot.addedBy.userId === viewer.userId;
  if (!canSeeItem({ addedBy: snapshot.addedBy.userId, state: snapshot.state }, viewer)) return null;
  const common = {
    id: snapshot.id,
    albumId: snapshot.albumId,
    kind: snapshot.kind,
    addedBy: snapshot.addedBy,
    addedAt: snapshot.addedAt,
    revision: snapshot.revision,
    source: adder ? snapshot.source : null,
  };
  const privileged = adder || viewer.role === "owner";
  switch (snapshot.state) {
    case "preparing":
      return { ...common, state: "preparing", rendition: null, pendingReason: snapshot.pendingReason ?? "rendering" };
    case "published":
      if (!snapshot.rendition) throw new TypeError("published item without rendition");
      return { ...common, state: "published", rendition: snapshot.rendition };
    case "updatePending":
      if (!snapshot.rendition) throw new TypeError("updatePending item without rendition");
      return privileged
        ? { ...common, state: "updatePending", rendition: snapshot.rendition, pendingReason: snapshot.pendingReason ?? "rendering" }
        : { ...common, state: "published", rendition: snapshot.rendition };
    case "removed":
      if (!snapshot.removedAt) throw new TypeError("removed item without removedAt");
      return { ...common, state: "removed", rendition: null, removedAt: snapshot.removedAt };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Invite links

export function inviteLinkStatus(link: Pick<InviteLink, "expiresAt" | "revoked">, now: Instant): InviteLinkStatus {
  if (link.revoked) return "revoked";
  return time(now) >= time(link.expiresAt) ? "expired" : "usable";
}

export interface JoinContext {
  /** null when not signed in. */
  readonly actorId: UserId | null;
  /** null when the secret matches no link. */
  readonly link: InviteLink | null;
  readonly album: { readonly ownerId: UserId; readonly lifecycle: "active" | "deleting" } | null;
  /** The actor's previous membership in the link's album, if any. */
  readonly existing: Pick<Membership, "role" | "state" | "endedAt"> | null;
  readonly now: Instant;
}
export type JoinDecision =
  | { readonly ok: true; readonly joined: boolean; readonly role: AlbumRole }
  | { readonly ok: false; readonly code: SharingErrorCode };

/**
 * Unknown, expired, revoked and blocked links share one answer (「このリンクは使えません」). A member removed by the
 * owner can rejoin only through a link created after the removal. Leaving does not block rejoining.
 */
export function decideJoin(context: JoinContext): JoinDecision {
  if (!context.actorId) return { ok: false, code: "unauthenticated" };
  const { link, album, existing } = context;
  if (!link || !album || album.lifecycle !== "active") return { ok: false, code: "invite_unavailable" };
  if (inviteLinkStatus(link, context.now) !== "usable") return { ok: false, code: "invite_unavailable" };
  if (album.ownerId === context.actorId) return { ok: true, joined: false, role: "owner" };
  if (existing?.state === "active") return { ok: true, joined: false, role: existing.role };
  if (existing?.state === "removed" && (!existing.endedAt || time(existing.endedAt) >= time(link.createdAt))) {
    return { ok: false, code: "invite_unavailable" };
  }
  return { ok: true, joined: true, role: link.role };
}

// ---------------------------------------------------------------------------------------------------------
// Cursors and idempotency

/** A cursor is reusable only by the same actor, scope, query and membership revision, within its lifetime. */
export function checkCursor(cursor: CursorBinding, current: Omit<CursorBinding, "issuedAt">, now: Instant): Decision {
  if (time(now) - time(cursor.issuedAt) > SHARING_LIMITS.cursorLifetimeSeconds * 1000) return deny("cursor_expired");
  if (cursor.actorId !== current.actorId || cursor.queryDigest !== current.queryDigest) return deny("invalid_cursor");
  return canonical(cursor.scope) === canonical(current.scope) ? allow : deny("invalid_cursor");
}

export function idempotencyIdentity(record: IdempotencyRecord): string {
  return canonical({ actor: record.actor, scope: record.scope, operation: record.operation, key: record.key });
}

/** Same identity + same payload replays the stored result; a changed payload is a conflict; anything else is new. */
export function compareIdempotency(stored: IdempotencyRecord | null, incoming: IdempotencyRecord): "new" | "replay" | "conflict" {
  if (!stored || idempotencyIdentity(stored) !== idempotencyIdentity(incoming)) return "new";
  return stored.payloadSha256 === incoming.payloadSha256 ? "replay" : "conflict";
}

// ---------------------------------------------------------------------------------------------------------
// Generations, render jobs and upload commits

/**
 * Ordering of two bindings for the same photo. older/newer compare (sourceGeneration, recipeRevision);
 * "different" means the same generation/revision with different inputs, which is never accepted.
 */
export function compareRenderBinding(candidate: RenderBinding, current: RenderBinding): "same" | "older" | "newer" | "different" {
  if (candidate.sourceGeneration !== current.sourceGeneration) {
    return candidate.sourceGeneration < current.sourceGeneration ? "older" : "newer";
  }
  if (candidate.recipeRevision !== current.recipeRevision) {
    return candidate.recipeRevision < current.recipeRevision ? "older" : "newer";
  }
  return canonical(candidate) === canonical(current) ? "same" : "different";
}

export function nextAlbumItemState(state: AlbumItemState, event: AlbumItemEvent): AlbumItemState | null {
  const row: { readonly [E in AlbumItemEvent]?: AlbumItemState } = ALBUM_ITEM_TRANSITIONS[state];
  return row[event] ?? null;
}

export function nextRenderJobState(state: RenderJobState, event: RenderJobEvent): RenderJobState | null {
  const row: { readonly [E in RenderJobEvent]?: RenderJobState } = RENDER_JOB_TRANSITIONS[state];
  return row[event] ?? null;
}

export interface RenderCommitContext {
  readonly job: Pick<RenderJob, "binding" | "state" | "leaseExpiresAt" | "purpose">;
  /** Credential generation captured when the job was claimed. */
  readonly claimedGeneration: number;
  readonly executor: { readonly lifecycle: "active" | "revoked"; readonly credentialGeneration: number };
  readonly output: Pick<RenderOutputRequest, "kind">;
  /** The binding the target needs now; null when the target photo is gone. */
  readonly desired: RenderBinding | null;
  /** For album items: the item's current state (null when missing) and the adder's ledger entry. */
  readonly item?: { readonly state: AlbumItemState | null; readonly revision: number; readonly adder: AlbumViewer };
  readonly now: Instant;
}

/** Commit only the exact current binding, by a live executor and lease, for a target that still accepts it. */
export function decideRenderCommit(context: RenderCommitContext): Decision {
  const { job, executor } = context;
  if (executor.lifecycle !== "active" || executor.credentialGeneration !== context.claimedGeneration) return deny("unauthenticated");
  if (job.state !== "claimed") return deny("stale_render");
  if (!job.leaseExpiresAt || time(context.now) >= time(job.leaseExpiresAt)) return deny("lease_expired");
  const expectedOutput = job.purpose.kind === "preview" ? "preview" : "rendition";
  if (context.output.kind !== expectedOutput) return deny("content_rejected");
  if (job.purpose.kind === "albumItem") {
    const item = context.item;
    if (!item || item.state === null) return deny("not_found");
    if (item.state === "removed") return deny("item_removed");
    const adder = item.adder.membership;
    if (!adder || adder.state !== "active") return deny("not_found");
    if (!ALBUM_PERMISSIONS[adder.role].addItem) return deny("role_forbidden");
    if (item.revision !== job.purpose.itemRevision) return deny("stale_render");
  }
  if (!context.desired || compareRenderBinding(job.binding, context.desired) !== "same") return deny("stale_render");
  return allow;
}

export interface UploadCommitContext {
  readonly viewer: AlbumViewer;
  /** null when the item no longer exists or belongs to another album. */
  readonly item: Pick<AlbumItemSnapshot, "addedBy" | "state" | "revision" | "renditionBinding"> | null;
  readonly upload: Pick<RenditionUpload, "targetItemRevision" | "expiresAt" | "state">;
  /** Present for device renders: the binding the device rendered. */
  readonly binding?: RenderBinding;
  /** Metadata actually found in the uploaded bytes by the server validator. */
  readonly bytesMetadata: Readonly<Record<string, unknown>>;
  readonly now: Instant;
}

/**
 * Re-checks everything at commit time (Epic §10): current membership and role, the item, the target revision,
 * the generation order and the published metadata. Removal, leaving or demotion before commit wins.
 */
export function decideUploadCommit(context: UploadCommitContext): Decision {
  const membership = context.viewer.membership;
  if (!membership || membership.state !== "active") return deny("not_found");
  const item = context.item;
  if (!item || item.addedBy.userId !== context.viewer.userId) return deny("not_found");
  if (item.state === "removed") return deny("item_removed");
  const action: AlbumAction = item.state === "preparing" ? "addItem" : "replaceOwnItem";
  if (!ALBUM_PERMISSIONS[membership.role][action]) return deny("role_forbidden");
  if (context.upload.state !== "reserved" && context.upload.state !== "verifying") return deny("upload_expired");
  if (time(context.now) >= time(context.upload.expiresAt)) return deny("upload_expired");
  // Every committed rendition creates the next item revision; a preparing item starts at revision 0.
  if (context.upload.targetItemRevision !== item.revision + 1) return deny("revision_conflict");
  if (context.binding && item.renditionBinding && compareRenderBinding(context.binding, item.renditionBinding) !== "newer") {
    return deny("stale_render");
  }
  return findForbiddenMetadata(context.bytesMetadata).length ? deny("content_rejected") : allow;
}

// ---------------------------------------------------------------------------------------------------------
// Rendition metadata (Epic §9)

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;

/** Allow-list extraction: everything except capture time and colour profile is dropped. */
export function sanitizeRenditionMetadata(input: Readonly<Record<string, unknown>>): RenditionMetadata {
  const capturedAt = typeof input.capturedAt === "string" && LOCAL_TIME.test(input.capturedAt) ? input.capturedAt : null;
  const offset = typeof input.capturedAtOffset === "string" && OFFSET.test(input.capturedAtOffset) ? input.capturedAtOffset : null;
  return {
    capturedAt,
    capturedAtOffset: capturedAt ? offset : null,
    colorProfile: input.colorProfile === "displayP3" ? "displayP3" : "sRGB",
    orientation: 1,
  };
}

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds forbidden keys at any depth. Used on decoded metadata of uploaded bytes before publication. */
export function findForbiddenMetadata(
  record: Readonly<Record<string, unknown>>,
): readonly { readonly key: string; readonly category: ForbiddenMetadataCategory }[] {
  const found: { key: string; category: ForbiddenMetadataCategory }[] = [];
  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (depth > 32 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [category, fragments] of Object.entries(FORBIDDEN_RENDITION_METADATA) as [ForbiddenMetadataCategory, readonly string[]][]) {
        if (fragments.some((fragment) => normalized.includes(fragment))) {
          found.push({ key: path, category });
          break;
        }
      }
      visit(child, path, depth + 1);
    }
  };
  visit(record, "", 0);
  return found;
}

// ---------------------------------------------------------------------------------------------------------

/** Stable JSON with sorted keys for identity comparison. */
export function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}
