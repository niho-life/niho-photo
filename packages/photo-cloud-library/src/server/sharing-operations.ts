/**
 * The shared-album operations the BFF forwards, each checked with the same request and response rules as the client
 * that sends it. An operation of the route table that is not listed here is closed (`not_found`): its client is not
 * in public source yet, so there is nothing to check its answers against.
 */
import {
  SHARED_ALBUM_ITEM_OPERATIONS,
  albumItemResponseLimit,
  validateAlbumItemRequest,
  validateAlbumItemResponse,
  validateDownloadRequest,
  type SharedAlbumItemOperation,
} from "../sharing/album-wire";
import { FILE_UPLOAD_CONTENT_TYPES, SHARING_LIMITS, type SharingOperation } from "../sharing/contract";
import {
  SHARED_ALBUM_MEMBERSHIP_OPERATIONS,
  membershipResponseLimit,
  validateMembershipRequest,
  validateMembershipResponse,
} from "../sharing/membership-wire";

/** An upload ticket in a success answer: it must point at the trusted provider for exactly this upload. */
export interface SharingProxyTicket {
  readonly ticket: unknown;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface SharingProxyJsonOperation {
  readonly kind: "json";
  /** Value rules for the decoded request (the client's own validator). Throws when the request must not be sent. */
  readonly validateRequest: (request: Record<string, unknown>) => void;
  /** Largest request body in bytes, counted before parsing. */
  readonly requestLimit: number;
  /** Largest success body in bytes, counted before parsing. */
  readonly responseLimit: number;
  /** Throws unless the decoded success body answers this request. */
  readonly validateResponse: (request: Record<string, unknown>, raw: unknown) => void;
  /** Upload tickets the answer carries, after `validateResponse` accepted it. */
  readonly tickets?: (request: Record<string, unknown>, raw: unknown) => readonly SharingProxyTicket[];
}

/** A GET answered by a bounded content stream (v2 `content.get` rules: 200 whole or 206 for the requested range). */
export interface SharingProxyContentOperation {
  readonly kind: "content";
  readonly validateRequest: (request: Record<string, unknown>) => void;
  /** The only content type the stream may have. */
  readonly contentType: string;
}

export type SharingProxyOperation = SharingProxyJsonOperation | SharingProxyContentOperation;
export type SharingProxyOperations = Readonly<Partial<Record<SharingOperation, SharingProxyOperation>>>;

/** Membership and invites (B05 #246). */
export const SHARED_ALBUM_MEMBERSHIP_PROXY_OPERATIONS: SharingProxyOperations = Object.freeze(Object.fromEntries(
  SHARED_ALBUM_MEMBERSHIP_OPERATIONS.map((operation) => [operation, Object.freeze({
    kind: "json",
    validateRequest: (request: Record<string, unknown>) => validateMembershipRequest(operation, request),
    requestLimit: SHARING_LIMITS.maxOtherBodyBytes,
    responseLimit: membershipResponseLimit(operation),
    validateResponse: (request: Record<string, unknown>, raw: unknown) => {
      validateMembershipResponse(operation, request as never, raw);
    },
  } satisfies SharingProxyJsonOperation)]),
));

/** The finished files of an album are JPEG only (B00 `FILE_UPLOAD_CONTENT_TYPES`). */
const RENDITION_CONTENT_TYPE = FILE_UPLOAD_CONTENT_TYPES[0];

/** The tickets of an album item answer: a new upload's (add, replace) or a renewed one's. */
function albumItemTickets(operation: SharedAlbumItemOperation, raw: unknown): readonly SharingProxyTicket[] {
  const record = raw as Record<string, unknown>;
  if (operation === "albumItems.renewUpload") {
    const upload = record.upload as { readonly sizeBytes: number };
    return [{ ticket: record.ticket, contentType: RENDITION_CONTENT_TYPE, sizeBytes: upload.sizeBytes }];
  }
  if (operation !== "albumItems.addPhoto" && operation !== "albumItems.addFile" && operation !== "albumItems.replace") return [];
  const start = ((record.value as Record<string, unknown>).upload ?? null) as { readonly upload: { readonly sizeBytes: number }; readonly ticket: unknown } | null;
  // No upload (a library photo is rendered by its device) or a replay (no bearer ticket again).
  if (start === null || start.ticket === null) return [];
  return [{ ticket: start.ticket, contentType: RENDITION_CONTENT_TYPE, sizeBytes: start.upload.sizeBytes }];
}

/** Albums, album items and the owner's shared storage (B12 #254). */
export const SHARED_ALBUM_ITEM_PROXY_OPERATIONS: SharingProxyOperations = Object.freeze({
  ...Object.fromEntries(SHARED_ALBUM_ITEM_OPERATIONS.map((operation) => [operation, Object.freeze({
    kind: "json",
    validateRequest: (request: Record<string, unknown>) => validateAlbumItemRequest(operation, request),
    requestLimit: SHARING_LIMITS.maxOtherBodyBytes,
    responseLimit: albumItemResponseLimit(operation),
    validateResponse: (request: Record<string, unknown>, raw: unknown) => {
      validateAlbumItemResponse(operation, request as never, raw);
    },
    tickets: (_request: Record<string, unknown>, raw: unknown) => albumItemTickets(operation, raw),
  } satisfies SharingProxyJsonOperation)])),
  "albumItems.download": Object.freeze({
    kind: "content",
    validateRequest: (request: Record<string, unknown>) => validateDownloadRequest(request),
    contentType: RENDITION_CONTENT_TYPE,
  } satisfies SharingProxyContentOperation),
});

/** Every operation this package can check, forwarded by default. */
export const SHARING_PROXY_OPERATIONS: SharingProxyOperations = Object.freeze({
  ...SHARED_ALBUM_MEMBERSHIP_PROXY_OPERATIONS,
  ...SHARED_ALBUM_ITEM_PROXY_OPERATIONS,
});
