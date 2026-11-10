/**
 * Same-origin client for albums, album items and the owner's shared storage (B12 #254), on the shared HTTP core:
 * the verified-session scope fence, capture headers, header deadline, bounded JSON and bounded content stream of the
 * personal v2 transport. It never retries by itself; `createSharedAlbumItems` replays with the same key.
 */
import {
  albumItemResponseLimit,
  encodeAlbumItemRequest,
  isSharedAlbumItemOperation,
  validateAlbumItemResponse,
  validateDownloadRequest,
  type SharedAlbumItemOperation,
} from "./album-wire";
import type { PhotoContent, SharingOperationMap, SharingRequestOptions, SharingSessionScope } from "./contract";
import { encodeRoutedRequest } from "./membership-wire";
import {
  createSharingClientOnTransport,
  createSharingHttpClient,
  type CreateSharingHttpClientOptions,
  type SharingHttpClient,
  type SharingTransport,
  type SharingWire,
} from "./sharing-http";

export interface SharedAlbumClient {
  readonly scope: SharingSessionScope;
  request<K extends SharedAlbumItemOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
  /** The full-size rendition or its thumbnail as a bounded stream (`albumItems.download`). */
  download(request: SharingOperationMap["albumItems.download"]["request"], signal: AbortSignal): Promise<PhotoContent>;
  dispose(): void;
}

export type CreateBrowserSharedAlbumClientOptions = CreateSharingHttpClientOptions;

const ALBUM_ITEM_WIRE: SharingWire<SharedAlbumItemOperation> = {
  supports: isSharedAlbumItemOperation,
  encode: encodeAlbumItemRequest,
  responseLimit: albumItemResponseLimit,
  validate: (operation, request, raw) => validateAlbumItemResponse(operation, request as never, raw),
};

export function createBrowserSharedAlbumClient(options: CreateBrowserSharedAlbumClientOptions): SharedAlbumClient {
  return albumClientOn(createSharingHttpClient<SharedAlbumItemOperation>(options, ALBUM_ITEM_WIRE));
}

/** The same client on another transport (the Mac app's native session). */
export function createSharedAlbumClientOnTransport(transport: SharingTransport): SharedAlbumClient {
  return albumClientOn(createSharingClientOnTransport(transport, ALBUM_ITEM_WIRE));
}

function albumClientOn(core: SharingHttpClient<SharedAlbumItemOperation>): SharedAlbumClient {
  return {
    scope: core.scope,
    async request(operation, request, requestOptions) {
      const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
      return (await core.send(operation, request, requestOptions.signal, key)) as never;
    },
    async download(request, signal) {
      validateDownloadRequest(request);
      // The route places IDs in the path and the variant in the query; the range travels as the Range header.
      const encoded = encodeRoutedRequest("albumItems.download", request, false, undefined);
      return await core.stream(encoded, request.range, signal);
    },
    dispose: () => core.dispose(),
  };
}
