/**
 * Same-origin client for the shared-album membership and invite operations (B05 #246). It reuses the personal v2
 * transport pieces rather than a second implementation: the verified-session scope fence (`PersonalPhotoScope`, bound
 * to the session only because albums span libraries), the capture headers, the header deadline and the bounded JSON
 * reader. Like the v2 client it never retries by itself; `createSharedAlbumMembership` replays with the same key.
 */
import { PersonalPhotoCloudError } from "../errors";
import { linkedAbortController } from "../await";
import { fetchWithHeaderDeadline, requestInit } from "../browser/client";
import { PersonalPhotoScope } from "../scope";
import type { PersonalPhotoCloudIdentity } from "../types";
import { JSON_LIMITS, readBoundedJson } from "../wire";

import type { SharingOperationMap, SharingRequestOptions, SharingSessionScope } from "./contract";
import {
  encodeMembershipRequest,
  isSharingErrorEnvelope,
  membershipResponseLimit,
  parseSharingError,
  validateMembershipResponse,
  type SharedAlbumMembershipOperation,
} from "./membership-wire";

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

export interface CreateBrowserSharedAlbumMembershipClientOptions {
  /** The verified session (the same identity the personal client uses). */
  readonly identity: PersonalPhotoCloudIdentity;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function createBrowserSharedAlbumMembershipClient(options: CreateBrowserSharedAlbumMembershipClientOptions): SharedAlbumMembershipClient {
  const actor = options.identity.getSnapshot();
  const now = options.now ?? Date.now;
  if (actor === null || actor.transport !== "browser-session" || Date.parse(actor.expiresAt) <= now()) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const lifecycle = new AbortController();
  let disposed = false;
  let scope: PersonalPhotoScope<null>;

  const client: SharedAlbumMembershipClient = {
    scope: Object.freeze({ actorId: actor.userId, sessionEpoch: actor.sessionEpoch }),
    async request<K extends SharedAlbumMembershipOperation>(
      operation: K,
      request: SharingOperationMap[K]["request"],
      requestOptions: SharingRequestOptions<K>,
    ): Promise<SharingOperationMap[K]["response"]> {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      const scoped = scope.begin(requestOptions.signal);
      const link = linkedAbortController(scoped.signal, lifecycle.signal);
      try {
        const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
        const encoded = encodeMembershipRequest(operation, request, key);
        const capture = options.identity.getSnapshot();
        if (capture === null) throw new PersonalPhotoCloudError("scope_changed");
        const response = await fetchWithHeaderDeadline(
          fetchFn,
          encoded.path,
          requestInit(capture, "POST", encoded.body, null, encoded.idempotencyKey, link.controller.signal),
          scoped.signal,
          link.controller,
        );
        scoped.assertCurrent();
        if (response.status < 200 || response.status >= 300) {
          const { value } = await readBoundedJson(response, JSON_LIMITS.error, scoped.signal);
          throw parseSharingError(value, response.status);
        }
        if (response.status !== 200) throw new PersonalPhotoCloudError("invalid_response");
        const { value } = await readBoundedJson(response, membershipResponseLimit(operation), scoped.signal);
        scoped.assertCurrent();
        return validateMembershipResponse(operation, request, value);
      } catch (error) {
        // The server no longer accepts this session: fence it so no further request uses the old scope.
        if (isSharingErrorEnvelope(error) && error.error.code === "unauthenticated") scope.invalidateAuthentication();
        throw error;
      } finally {
        link.dispose();
        scoped.release();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
      scope.dispose();
    },
  };
  scope = new PersonalPhotoScope<null>(client, options.identity, now);
  return client;
}
