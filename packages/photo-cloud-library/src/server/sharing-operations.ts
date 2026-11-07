/**
 * The shared-album operations the BFF forwards, each checked with the same request and response rules as the client
 * that sends it. An operation of the route table that is not listed here is closed (`not_found`): its client is not
 * in public source yet, so there is nothing to check its answers against.
 */
import { SHARING_LIMITS, type SharingOperation } from "../sharing/contract";
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

/** Every operation this package can check, forwarded by default. */
export const SHARING_PROXY_OPERATIONS: SharingProxyOperations = Object.freeze({
  ...SHARED_ALBUM_MEMBERSHIP_PROXY_OPERATIONS,
});
