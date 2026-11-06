/**
 * Wire for the shared-album membership and invite operations (B05 #246). Routes are the contract's user table
 * (`SHARING_ROUTES` under `/cloud/sharing/v1`, B00): IDs as opaque path segments, page fields as query parameters,
 * the rest as a closed JSON body, the `Idempotency-Key` header for mutations and the same capture headers as the
 * personal v2 wire. The invite secret travels in the body of `POST /invites/join` only, never in a URL.
 *
 * Every response is validated before it reaches the UI. People are `{ displayName, isSelf }` only: a response that
 * carries another member's user ID, email or any other field is rejected rather than shown.
 *
 * The capture headers are fences for the trusted BFF to compare with its verified same-origin session; they are never
 * authorization by themselves. The BFF verifies the session first and the backend derives the role from its ledger.
 */
import { PersonalPhotoCloudError } from "../errors";
import { JSON_LIMITS, isOpaqueWireId, isValidIdempotencyKey } from "../wire";

import {
  ALBUM_PERMISSIONS,
  MEMBER_ROLES,
  SHARING_CLOUD_PATH_PREFIX,
  SHARING_ERROR_STATUS,
  SHARING_LIMITS,
  SharingRouteError,
  encodePendingInviteRequest,
  encodeSharingRequest,
  findUnexpectedRequestFields,
  type Album,
  type AlbumRole,
  type InviteJoinRecord,
  type InviteJoinResult,
  type InviteLink,
  type Membership,
  type PersonLabel,
  type SharingErrorCode,
  type SharingErrorEnvelope,
  type SharingOperation,
  type SharingOperationMap,
  type SharingRouteMethod,
} from "./contract";

export { SHARING_CLOUD_PATH_PREFIX };

/** The operations this client sends (B05). Album and item operations belong to B12 and are not routed here. */
export const SHARED_ALBUM_MEMBERSHIP_OPERATIONS = [
  "invites.list",
  "invites.create",
  "invites.revoke",
  "invites.join",
  "members.list",
  "members.changeRole",
  "members.remove",
  "members.leave",
] as const;
export type SharedAlbumMembershipOperation = (typeof SHARED_ALBUM_MEMBERSHIP_OPERATIONS)[number];

const MUTATIONS: ReadonlySet<SharedAlbumMembershipOperation> = new Set([
  "invites.create",
  "invites.revoke",
  "invites.join",
  "members.changeRole",
  "members.remove",
  "members.leave",
]);
const ALBUM_ROLE_SET: ReadonlySet<string> = new Set<AlbumRole>(["owner", "contributor", "viewer"]);
const MEMBER_ROLE_SET: ReadonlySet<string> = new Set(MEMBER_ROLES);
const MEMBERSHIP_STATES: ReadonlySet<string> = new Set(["active", "left", "removed"]);
const SECRET_MAX_BYTES = 512;
const DISPLAY_NAME_MAX_CODE_POINTS = 200;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const textEncoder = new TextEncoder();

export function isSharedAlbumMembershipOperation(value: unknown): value is SharedAlbumMembershipOperation {
  return typeof value === "string" && (SHARED_ALBUM_MEMBERSHIP_OPERATIONS as readonly string[]).includes(value);
}

export function isSharedAlbumMembershipMutation(operation: SharedAlbumMembershipOperation): boolean {
  return MUTATIONS.has(operation);
}

export interface EncodedSharingRequest<Op extends string = SharedAlbumMembershipOperation> {
  readonly operation: Op;
  readonly method: SharingRouteMethod;
  /** Full same-origin path, with the encoded query when the route has one. */
  readonly path: string;
  /** The closed JSON body, or null for GET/DELETE routes. */
  readonly body: Uint8Array<ArrayBuffer> | null;
  readonly idempotencyKey: string | null;
}

/**
 * Validates and encodes one request. A malformed request is never sent; like the personal v2 wire it fails locally
 * with `PersonalPhotoCloudError("invalid_response")`. Operations outside B05 fail with `unsupported`.
 */
export function encodeMembershipRequest(operation: string, request: unknown, idempotencyKey: string | undefined): EncodedSharingRequest {
  if (!isSharedAlbumMembershipOperation(operation)) throw new PersonalPhotoCloudError("unsupported");
  validateMembershipRequest(operation, request);
  return encodeRoutedRequest(operation, request, MUTATIONS.has(operation), idempotencyKey);
}

/** A validated request placed by the contract's route table; mutations carry their key, reads none. */
export function encodeRoutedRequest<Op extends SharingOperation>(
  operation: Op,
  request: unknown,
  mutation: boolean,
  idempotencyKey: string | undefined,
): EncodedSharingRequest<Op> {
  if (mutation ? !isValidIdempotencyKey(idempotencyKey) : idempotencyKey !== undefined) invalidRequest();
  let route: ReturnType<typeof encodeSharingRequest>;
  try {
    route = encodeSharingRequest(operation, request as SharingOperationMap[Op]["request"]);
  } catch (error) {
    if (error instanceof SharingRouteError) invalidRequest();
    throw error;
  }
  // The table and this client must agree on which operations are mutations.
  if (route.idempotencyKey !== mutation) invalidRequest();
  return {
    operation,
    method: route.method,
    path: route.query === "" ? route.path : `${route.path}?${route.query}`,
    body: route.body === null ? null : textEncoder.encode(JSON.stringify(route.body)),
    idempotencyKey: mutation ? (idempotencyKey as string) : null,
  };
}

/**
 * `invites.joinPending` (B00 `PENDING_INVITE_ROUTES`): the BFF opens its pending-invite cookie and joins with it. The
 * body is `{}`; the secret never passes through the page again. Not keyed: the cookie is gone after one attempt.
 */
export function encodePendingInviteJoin(): EncodedSharingRequest<"invites.joinPending"> {
  const route = encodePendingInviteRequest("invites.joinPending", {});
  if (route.idempotencyKey || route.query !== "" || route.method !== "POST") invalidRequest();
  return {
    operation: "invites.joinPending",
    method: route.method,
    path: route.path,
    body: textEncoder.encode(JSON.stringify(route.body ?? {})),
    idempotencyKey: null,
  };
}

/** Closed shape (B00 `findUnexpectedRequestFields`) plus the value rules the server re-checks. */
export function validateMembershipRequest(operation: SharedAlbumMembershipOperation, request: unknown): void {
  if (!isRecord(request) || findUnexpectedRequestFields(operation, request).length > 0) invalidRequest();
  const value = request;
  const required = (key: string): unknown => {
    if (!Object.hasOwn(value, key)) invalidRequest();
    return value[key];
  };
  if (operation === "invites.join") {
    if (!isSecret(required("secret"))) invalidRequest();
    return;
  }
  if (!isOpaqueWireId(required("albumId"))) invalidRequest();
  switch (operation) {
    case "invites.create":
      if (!MEMBER_ROLE_SET.has(String(required("role")))) invalidRequest();
      return;
    case "invites.revoke":
      if (!isOpaqueWireId(required("inviteLinkId"))) invalidRequest();
      return;
    case "members.list":
      if (value.cursor !== undefined && !isOpaqueWireId(value.cursor)) invalidRequest();
      if (value.limit !== undefined && !integerBetween(value.limit, 1, SHARING_LIMITS.memberListMaxCount)) invalidRequest();
      return;
    case "members.changeRole":
      if (!isOpaqueWireId(required("membershipId")) || !safeNonNegative(required("expectedRevision")) || !MEMBER_ROLE_SET.has(String(required("role")))) {
        invalidRequest();
      }
      return;
    case "members.remove":
      if (!isOpaqueWireId(required("membershipId"))) invalidRequest();
      return;
    case "invites.list":
    case "members.leave":
      return;
  }
}

export function membershipResponseLimit(operation: SharedAlbumMembershipOperation): number {
  return operation === "members.list" || operation === "invites.list" ? JSON_LIMITS.list : JSON_LIMITS.success;
}

/** Sharing error envelope (B00 `SharingErrorEnvelope`); the code must match the HTTP status. */
export function parseSharingError(value: unknown, status: number): SharingErrorEnvelope {
  const root = exactRecord(value, ["error"], ["error"]);
  const error = exactRecord(root.error, ["code", "requestId", "retryable", "currentRevision", "retryAfterSeconds", "storage"], ["code", "requestId", "retryable"]);
  const code = error.code;
  if (typeof code !== "string" || !Object.hasOwn(SHARING_ERROR_STATUS, code) || SHARING_ERROR_STATUS[code as SharingErrorCode] !== status) invalidResponse();
  if (!isOpaqueWireId(error.requestId) || typeof error.retryable !== "boolean") invalidResponse();
  if (error.currentRevision !== undefined && !safeNonNegative(error.currentRevision)) invalidResponse();
  if (error.retryAfterSeconds !== undefined && !safeNonNegative(error.retryAfterSeconds)) invalidResponse();
  if (error.storage !== undefined) {
    if (code !== "quota_exceeded") invalidResponse();
    const storage = exactRecord(error.storage, ["availableBytes", "requiredBytes"], ["availableBytes", "requiredBytes"]);
    if (!safeNonNegative(storage.availableBytes) || !safeNonNegative(storage.requiredBytes)) invalidResponse();
  }
  return root as unknown as SharingErrorEnvelope;
}

export function isSharingErrorEnvelope(value: unknown): value is SharingErrorEnvelope {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" && Object.hasOwn(SHARING_ERROR_STATUS, value.error.code);
}

/** Checks a decoded success body against the request it answers. Returns the typed response or throws. */
export function validateMembershipResponse<K extends SharedAlbumMembershipOperation>(
  operation: K,
  request: SharingOperationMap[K]["request"],
  raw: unknown,
): SharingOperationMap[K]["response"] {
  const albumId = (request as { readonly albumId?: string }).albumId;
  switch (operation) {
    case "invites.list": {
      const body = exactRecord(raw, ["links", "joins"], ["links", "joins"]);
      if (!Array.isArray(body.links) || !Array.isArray(body.joins)) invalidResponse();
      body.links.forEach((link) => validateInviteLink(link, albumId as string));
      body.joins.forEach(validateJoinRecord);
      return raw as SharingOperationMap[K]["response"];
    }
    case "invites.create": {
      const receipt = validateReceipt(raw);
      const created = exactRecord(receipt.value, ["link", "secret"], ["link", "secret"]);
      const link = validateInviteLink(created.link, albumId as string);
      const role = (request as SharingOperationMap["invites.create"]["request"]).role;
      if (link.role !== role || link.revoked) invalidResponse();
      // The secret comes only in the first response; a replay must not resend it.
      if (receipt.replayed ? created.secret !== null : !isSecret(created.secret)) invalidResponse();
      return raw as SharingOperationMap[K]["response"];
    }
    case "invites.revoke": {
      const receipt = validateReceipt(raw);
      const link = validateInviteLink(receipt.value, albumId as string);
      if (link.id !== (request as SharingOperationMap["invites.revoke"]["request"]).inviteLinkId || !link.revoked) invalidResponse();
      return raw as SharingOperationMap[K]["response"];
    }
    case "invites.join":
      validateJoinResult(validateReceipt(raw).value);
      return raw as SharingOperationMap[K]["response"];
    case "members.list": {
      const page = exactRecord(raw, ["items", "nextCursor"], ["items", "nextCursor"]);
      if (!Array.isArray(page.items) || page.items.length > SHARING_LIMITS.memberListMaxCount) invalidResponse();
      if (page.nextCursor !== null && !isOpaqueWireId(page.nextCursor)) invalidResponse();
      const members = page.items.map((item) => validateMembership(item, albumId as string));
      if (members.filter((member) => member.member.isSelf).length > 1) invalidResponse();
      return raw as SharingOperationMap[K]["response"];
    }
    case "members.changeRole": {
      const membership = validateMembership(validateReceipt(raw).value, albumId as string);
      const change = request as SharingOperationMap["members.changeRole"]["request"];
      if (membership.id !== change.membershipId || membership.role !== change.role || membership.state !== "active") invalidResponse();
      return raw as SharingOperationMap[K]["response"];
    }
    case "members.remove": {
      const membership = validateMembership(validateReceipt(raw).value, albumId as string);
      if (membership.id !== (request as SharingOperationMap["members.remove"]["request"]).membershipId || membership.state !== "removed") invalidResponse();
      return raw as SharingOperationMap[K]["response"];
    }
    case "members.leave": {
      const membership = validateMembership(validateReceipt(raw).value, albumId as string);
      if (membership.state !== "left" || !membership.member.isSelf) invalidResponse();
      return raw as SharingOperationMap[K]["response"];
    }
  }
  return invalidResponse();
}

// ---------------------------------------------------------------------------------------------------------
// Response shapes

/** The value of a join: `invites.join` wraps it in a receipt, `invites.joinPending` returns it as is. */
export function validateJoinResult(value: unknown): InviteJoinResult {
  const result = exactRecord(value, ["album", "membership", "joined"], ["album", "membership", "joined"]);
  const album = validateAlbum(result.album);
  const membership = validateMembership(result.membership, album.id);
  if (typeof result.joined !== "boolean" || membership.state !== "active" || !membership.member.isSelf || membership.role !== album.access.role) {
    invalidResponse();
  }
  // A new join always records the link it came through; the owner never joins.
  if (result.joined && (membership.joinedVia === null || membership.role === "owner")) invalidResponse();
  return value as InviteJoinResult;
}

/** The only person shape a response may carry. Extra keys (user ID, email, spot ID) are rejected. */
export function validatePersonLabel(value: unknown): PersonLabel {
  const person = exactRecord(value, ["displayName", "isSelf"], ["displayName", "isSelf"]);
  if (typeof person.displayName !== "string" || person.displayName.trim().length === 0 || [...person.displayName].length > DISPLAY_NAME_MAX_CODE_POINTS) {
    invalidResponse();
  }
  if (typeof person.isSelf !== "boolean") invalidResponse();
  return person as unknown as PersonLabel;
}

export function validateInviteLink(value: unknown, albumId: string): InviteLink {
  const keys = ["id", "albumId", "role", "createdBy", "createdAt", "expiresAt", "revoked", "revokedAt", "joinCount"];
  const link = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(link.id) || link.albumId !== albumId || !MEMBER_ROLE_SET.has(String(link.role))) invalidResponse();
  validatePersonLabel(link.createdBy);
  if (!isInstant(link.createdAt) || !isInstant(link.expiresAt) || Date.parse(link.expiresAt) <= Date.parse(link.createdAt)) invalidResponse();
  if (typeof link.revoked !== "boolean" || (link.revoked ? !isInstant(link.revokedAt) : link.revokedAt !== null)) invalidResponse();
  if (link.revoked && Date.parse(link.revokedAt as string) < Date.parse(link.createdAt)) invalidResponse();
  if (!safeNonNegative(link.joinCount)) invalidResponse();
  return link as unknown as InviteLink;
}

export function validateJoinRecord(value: unknown): InviteJoinRecord {
  const keys = ["inviteLinkId", "membershipId", "member", "joinedAt"];
  const record = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(record.inviteLinkId) || !isOpaqueWireId(record.membershipId) || !isInstant(record.joinedAt)) invalidResponse();
  validatePersonLabel(record.member);
  return record as unknown as InviteJoinRecord;
}

export function validateMembership(value: unknown, albumId: string): Membership {
  const keys = ["id", "albumId", "member", "role", "state", "revision", "joinedAt", "endedAt", "joinedVia"];
  const membership = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(membership.id) || membership.albumId !== albumId || !ALBUM_ROLE_SET.has(String(membership.role))) invalidResponse();
  validatePersonLabel(membership.member);
  if (!MEMBERSHIP_STATES.has(String(membership.state)) || !safeNonNegative(membership.revision) || !isInstant(membership.joinedAt)) invalidResponse();
  if (membership.state === "active" ? membership.endedAt !== null : !isInstant(membership.endedAt)) invalidResponse();
  if (membership.endedAt !== null && Date.parse(membership.endedAt as string) < Date.parse(membership.joinedAt)) invalidResponse();
  if (membership.joinedVia !== null && !isOpaqueWireId(membership.joinedVia)) invalidResponse();
  // The owner never joins through a link and never leaves or is removed.
  if (membership.role === "owner" && (membership.joinedVia !== null || membership.state !== "active")) invalidResponse();
  return membership as unknown as Membership;
}

export function validateAlbum(value: unknown): Album {
  const keys = ["id", "owner", "name", "revision", "createdAt", "updatedAt", "itemCount", "memberCount", "cover", "access"];
  const album = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(album.id) || typeof album.name !== "string" || album.name.trim().length === 0) invalidResponse();
  if ([...album.name].length > SHARING_LIMITS.albumNameMaxCodePoints) invalidResponse();
  validatePersonLabel(album.owner);
  if (!safeNonNegative(album.revision) || !isInstant(album.createdAt) || !isInstant(album.updatedAt) || !safeNonNegative(album.itemCount)) invalidResponse();
  // Active members including the owner, so at least one.
  if (!safeNonNegative(album.memberCount) || album.memberCount < 1) invalidResponse();
  if (album.cover !== null) {
    const cover = exactRecord(album.cover, ["itemId", "renditionId"], ["itemId", "renditionId"]);
    if (!isOpaqueWireId(cover.itemId) || !isOpaqueWireId(cover.renditionId)) invalidResponse();
  }
  const accessKeys = ["role", "membershipRevision", "permissions", "preparation"];
  const access = exactRecord(album.access, accessKeys, accessKeys);
  if (!ALBUM_ROLE_SET.has(String(access.role)) || !safeNonNegative(access.membershipRevision)) invalidResponse();
  // Display hints must be exactly the contract's table for the role; anything else is a broken or forged response.
  const expected = ALBUM_PERMISSIONS[access.role as AlbumRole] as Readonly<Record<string, boolean>>;
  const permissions = exactRecord(access.permissions, Object.keys(expected), Object.keys(expected));
  if (Object.entries(expected).some(([action, allowed]) => permissions[action] !== allowed)) invalidResponse();
  if ((album.owner as PersonLabel).isSelf !== (access.role === "owner")) invalidResponse();
  if (access.preparation !== null) {
    const preparation = exactRecord(access.preparation, ["prepared", "total"], ["prepared", "total"]);
    if (!safeNonNegative(preparation.prepared) || !safeNonNegative(preparation.total) || preparation.prepared > preparation.total) invalidResponse();
  }
  return album as unknown as Album;
}

export function validateReceipt(value: unknown): { readonly value: unknown; readonly replayed: boolean } {
  const receipt = exactRecord(value, ["value", "replayed"], ["value", "replayed"]);
  if (typeof receipt.replayed !== "boolean") invalidResponse();
  return { value: receipt.value, replayed: receipt.replayed };
}

// ---------------------------------------------------------------------------------------------------------
// Shared checks (also used by the album and item wire)

export function exactRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalidResponse();
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key)) || required.some((key) => !Object.hasOwn(value, key))) invalidResponse();
  return value;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** An invite secret as the wire accepts it (opaque, at most 512 bytes, no spaces or control characters). */
export function isSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && textEncoder.encode(value).byteLength <= SECRET_MAX_BYTES && !/[\p{Cc}\p{Cf}\s]/u.test(value);
}
export function isInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}
export function safeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function integerBetween(value: unknown, min: number, max: number): value is number {
  return safeNonNegative(value) && value >= min && value <= max;
}
/** Same local failure as the personal v2 wire for a request that must not be sent. */
export function invalidRequest(): never {
  throw new PersonalPhotoCloudError("invalid_response");
}
export function invalidResponse(): never {
  throw new PersonalPhotoCloudError("invalid_response");
}
