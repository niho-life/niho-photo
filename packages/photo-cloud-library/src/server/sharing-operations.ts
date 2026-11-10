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
import type { RenderExecutorOperation } from "../render-executor/contract";
import { RENDER_JOB_OPERATIONS, renderJobResponseLimit, validateRenderJobRequest, validateRenderJobResponse } from "../render-executor/render-wire";
import {
  SHARED_ALBUM_MEMBERSHIP_OPERATIONS,
  membershipResponseLimit,
  validateMembershipRequest,
  validateMembershipResponse,
} from "../sharing/membership-wire";

/** An upload ticket in a success answer: it must point at the trusted provider for exactly this upload. */
export interface SharingProxyTicket {
  readonly ticket: unknown;
  /** The only content type the upload may declare (omitted: any image type the ticket check accepts). */
  readonly contentType?: string;
  /** The upload's size, or its upper bound when the answer does not carry it. */
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
export type SharingProxyOperations = Readonly<Partial<Record<SharingOperation | RenderExecutorOperation, SharingProxyOperation>>>;

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

/** The output ticket of a render job: a new output's (the declared size and type) or a renewed one's (bounded). */
function renderJobTickets(operation: RenderExecutorOperation, request: Record<string, unknown>, raw: unknown): readonly SharingProxyTicket[] {
  if (operation === "renderJobs.startOutput") {
    const start = (raw as { readonly value: { readonly ticket: unknown } }).value;
    // A replay carries no bearer ticket again.
    if (start.ticket === null) return [];
    const output = request.output as { readonly sizeBytes: number; readonly contentType: string };
    return [{ ticket: start.ticket, contentType: output.contentType, sizeBytes: output.sizeBytes }];
  }
  if (operation === "renderJobs.renewOutput") {
    return [{ ticket: (raw as { readonly ticket: unknown }).ticket, sizeBytes: SHARING_LIMITS.fileUploadMaxBytes }];
  }
  return [];
}

/** Render jobs on the signed-in user's own device (B07 #248). */
export const RENDER_JOB_PROXY_OPERATIONS: SharingProxyOperations = Object.freeze(Object.fromEntries(
  RENDER_JOB_OPERATIONS.map((operation) => [operation, Object.freeze({
    kind: "json",
    validateRequest: (request: Record<string, unknown>) => validateRenderJobRequest(operation, request),
    requestLimit: SHARING_LIMITS.maxOtherBodyBytes,
    responseLimit: renderJobResponseLimit(operation),
    validateResponse: (request: Record<string, unknown>, raw: unknown) => {
      validateRenderJobResponse(operation, request as never, raw);
    },
    tickets: (request: Record<string, unknown>, raw: unknown) => renderJobTickets(operation, request, raw),
  } satisfies SharingProxyJsonOperation)]),
));

/** Every operation this package can check, forwarded by default. */
export const SHARING_PROXY_OPERATIONS: SharingProxyOperations = Object.freeze({
  ...SHARED_ALBUM_MEMBERSHIP_PROXY_OPERATIONS,
  ...SHARED_ALBUM_ITEM_PROXY_OPERATIONS,
  ...RENDER_JOB_PROXY_OPERATIONS,
});
