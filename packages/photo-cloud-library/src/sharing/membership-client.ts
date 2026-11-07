/**
 * Same-origin client for the shared-album membership and invite operations (B05 #246), on the shared HTTP core
 * (`sharing-http.ts`): the verified-session scope fence, capture headers, header deadline and bounded JSON reader of
 * the personal v2 transport. It never retries by itself; `createSharedAlbumMembership` replays with the same key.
 */
import { JSON_LIMITS } from "../wire";

import type { InviteJoinResult, SharingOperationMap, SharingRequestOptions, SharingSessionScope } from "./contract";
import {
  encodeMembershipRequest,
  encodePendingInviteJoin,
  isSharedAlbumMembershipOperation,
  membershipResponseLimit,
  validateJoinResult,
  validateMembershipResponse,
  type SharedAlbumMembershipOperation,
} from "./membership-wire";
import { createSharingHttpClient, type CreateSharingHttpClientOptions } from "./sharing-http";

/** The B05 slice of the contract's `PhotoLibrarySharingClient` (album, item and render operations are other issues). */
export interface SharedAlbumMembershipClient {
  readonly scope: SharingSessionScope;
  request<K extends SharedAlbumMembershipOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
  /**
   * `invites.joinPending`: joins with the invite the BFF holds for this browser (opened before signing in). Never
   * retried: the BFF deletes its cookie after one attempt, so a lost answer means reading the album list again.
   */
  joinPending(signal: AbortSignal): Promise<InviteJoinResult>;
  dispose(): void;
}

export type CreateBrowserSharedAlbumMembershipClientOptions = CreateSharingHttpClientOptions;

type MembershipWireOperation = SharedAlbumMembershipOperation | "invites.joinPending";

export function createBrowserSharedAlbumMembershipClient(options: CreateBrowserSharedAlbumMembershipClientOptions): SharedAlbumMembershipClient {
  const core = createSharingHttpClient<MembershipWireOperation>(options, {
    supports: (operation): operation is MembershipWireOperation => operation === "invites.joinPending" || isSharedAlbumMembershipOperation(operation),
    encode: (operation, request, key) => (operation === "invites.joinPending" ? encodePendingInviteJoin() : encodeMembershipRequest(operation, request, key)),
    responseLimit: (operation) => (operation === "invites.joinPending" ? JSON_LIMITS.success : membershipResponseLimit(operation)),
    validate: (operation, request, raw) => (operation === "invites.joinPending" ? validateJoinResult(raw) : validateMembershipResponse(operation, request as never, raw)),
  });
  return {
    scope: core.scope,
    async request(operation, request, requestOptions) {
      const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
      return (await core.send(operation, request, requestOptions.signal, key)) as never;
    },
    async joinPending(signal) {
      return (await core.send("invites.joinPending", {}, signal, undefined)) as InviteJoinResult;
    },
    dispose: () => core.dispose(),
  };
}
