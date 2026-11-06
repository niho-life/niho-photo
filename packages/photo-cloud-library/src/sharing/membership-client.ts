/**
 * Same-origin client for the shared-album membership and invite operations (B05 #246), on the shared HTTP core
 * (`sharing-http.ts`): the verified-session scope fence, capture headers, header deadline and bounded JSON reader of
 * the personal v2 transport. It never retries by itself; `createSharedAlbumMembership` replays with the same key.
 */
import type { SharingOperationMap, SharingRequestOptions, SharingSessionScope } from "./contract";
import {
  encodeMembershipRequest,
  isSharedAlbumMembershipOperation,
  membershipResponseLimit,
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
  dispose(): void;
}

export type CreateBrowserSharedAlbumMembershipClientOptions = CreateSharingHttpClientOptions;

export function createBrowserSharedAlbumMembershipClient(options: CreateBrowserSharedAlbumMembershipClientOptions): SharedAlbumMembershipClient {
  const core = createSharingHttpClient<SharedAlbumMembershipOperation>(options, {
    supports: isSharedAlbumMembershipOperation,
    encode: encodeMembershipRequest,
    responseLimit: membershipResponseLimit,
    validate: (operation, request, raw) => validateMembershipResponse(operation, request as never, raw),
  });
  return {
    scope: core.scope,
    async request(operation, request, requestOptions) {
      const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
      return (await core.send(operation, request, requestOptions.signal, key)) as never;
    },
    dispose: () => core.dispose(),
  };
}
