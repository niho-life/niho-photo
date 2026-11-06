/**
 * Album and item actions for the shared-album UI (B12 #254) on top of an album client.
 *
 * - Three ways to add: the adder's own library photo (`addLibraryPhotos`, rendered later on the device that holds it),
 *   a photo this device has rendered with the B07 renderer (`addDevicePhoto`), and a finished JPEG (`addFile`).
 * - One idempotency key per server call of a user action. A lost answer is replayed with the same key, so an add is
 *   never applied twice. An add or replace answer that arrives only as a replay carries no upload ticket: that upload
 *   is cancelled and the same content is started again on the same item, so no second item appears.
 * - Every started upload ends committed or released: an interrupted upload, a refused commit or a cancelled action
 *   cancels the upload (the album owner's reservation is released) and removes an add that never published.
 * - Direct files are cleaned on this device before upload (`prepareAlbumFile`): only capture time and its offset are
 *   kept, everything else (location, serials, paths, thumbnails, colour profiles) is dropped. The server rebuilds the
 *   file again at commit; this step only keeps those bytes from ever leaving the device.
 * - Removing items never touches originals or the owner's library. Saving downloads the full-size renditions.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readJpegPixelSize } from "niho-photo-editing/image-bytes-metadata";

import { PersonalPhotoCloudError } from "../errors";
import { readJpegCaptureFields, stripJpegMetadata } from "../render-executor/jpeg-metadata";
import type { FinishedOutput } from "../render-executor/render-output";
import type { RenderOutputUploader } from "../render-executor/ticket-upload";

import type { SharedAlbumItemOperation } from "./album-wire";
import {
  SHARING_LIMITS,
  sanitizeRenditionMetadata,
  type Album,
  type AlbumId,
  type AlbumItem,
  type AlbumItemId,
  type AlbumItemMutation,
  type AlbumItemPage,
  type AlbumPage,
  type DeviceSourceRef,
  type LibraryId,
  type PhotoContent,
  type PhotoId,
  type RenderBinding,
  type RenditionUploadRequest,
  type ReplaceContent,
  type SharedStorageUsage,
  type SharingErrorCode,
  type SharingOperationMap,
  type SharingRequestOptions,
} from "./contract";
import { abortableSleep, replayDelay } from "./membership";
import { isSharingErrorEnvelope } from "./membership-wire";

export type SharedAlbumItemsTransport = {
  request<K extends SharedAlbumItemOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
  download(request: SharingOperationMap["albumItems.download"]["request"], signal: AbortSignal): Promise<PhotoContent>;
};

export interface CreateSharedAlbumItemsOptions {
  readonly client: SharedAlbumItemsTransport;
  /** Puts bytes behind an upload ticket (the B07 ticket uploader: trusted origin, chunks, resume offset). */
  readonly uploader: RenderOutputUploader;
  /** Fresh key per server call. Default: `crypto.randomUUID()`. */
  readonly newIdempotencyKey?: () => string;
  /** Attempts per call including the first (default 3). */
  readonly maxAttempts?: number;
  /** Longest server-requested wait that is retried automatically (default 5 s). */
  readonly maxAutomaticRetryAfterSeconds?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Bytes ready to upload and the request that declares them. */
export interface PreparedAlbumFile {
  readonly bytes: Uint8Array;
  readonly rendition: RenditionUploadRequest;
}

/** Why a file cannot be added as it is. The host converts or rejects it; nothing was sent. */
export type SharedAlbumFileProblem = "notJpeg" | "tooLarge" | "tooManyPixels" | "notUpright";
export class SharedAlbumFileError extends Error {
  constructor(readonly problem: SharedAlbumFileProblem) {
    super(problem);
    this.name = "SharedAlbumFileError";
  }
}

export type SharedAlbumItemResult =
  | { readonly target: string; readonly ok: true; readonly item: AlbumItem }
  | { readonly target: string; readonly ok: false; readonly error: unknown };

export interface SharedAlbumItems {
  listAlbums(page: { readonly cursor?: string; readonly limit?: number }, signal: AbortSignal): Promise<AlbumPage>;
  getAlbum(albumId: AlbumId, signal: AbortSignal): Promise<Album>;
  createAlbum(name: string, signal: AbortSignal): Promise<Album>;
  renameAlbum(albumId: AlbumId, expectedRevision: number, name: string, signal: AbortSignal): Promise<Album>;
  /** Removes the album's renditions only; originals, libraries and members' devices are untouched. */
  deleteAlbum(albumId: AlbumId, expectedRevision: number, signal: AbortSignal): Promise<void>;
  /** The signed-in user's own shared storage (as an album owner). */
  storage(signal: AbortSignal): Promise<SharedStorageUsage>;
  listItems(albumId: AlbumId, page: { readonly cursor?: string; readonly limit?: number }, signal: AbortSignal): Promise<AlbumItemPage>;
  getItem(albumId: AlbumId, itemId: AlbumItemId, signal: AbortSignal): Promise<AlbumItem>;
  /** The adder's own library photos; each becomes a preparing item rendered on the device that holds it. */
  addLibraryPhotos(
    albumId: AlbumId,
    photos: readonly { readonly libraryId: LibraryId; readonly photoId: PhotoId }[],
    signal: AbortSignal,
  ): Promise<readonly SharedAlbumItemResult[]>;
  /** A photo this device rendered (B07 `renderFinishedOutput`) from an original only it holds. */
  addDevicePhoto(
    albumId: AlbumId,
    input: { readonly deviceSourceRef: DeviceSourceRef; readonly binding: RenderBinding; readonly file: PreparedAlbumFile },
    signal: AbortSignal,
  ): Promise<AlbumItem>;
  /** A finished JPEG (prepare it with `prepareAlbumFile`). */
  addFile(albumId: AlbumId, file: PreparedAlbumFile, signal: AbortSignal): Promise<AlbumItem>;
  /** Manual replacement of the adder's own file item. */
  replaceFile(albumId: AlbumId, item: Pick<AlbumItem, "id" | "revision">, file: PreparedAlbumFile, signal: AbortSignal): Promise<AlbumItem>;
  /** A newer device render of the adder's own device photo (after a recipe save on that device). */
  replaceDeviceRender(
    albumId: AlbumId,
    item: Pick<AlbumItem, "id" | "revision">,
    input: { readonly binding: RenderBinding; readonly file: PreparedAlbumFile },
    signal: AbortSignal,
  ): Promise<AlbumItem>;
  /** Several items at once (own items; the owner also others'). Each item reports its own result. */
  removeItems(albumId: AlbumId, itemIds: readonly AlbumItemId[], signal: AbortSignal): Promise<readonly SharedAlbumItemResult[]>;
  /**
   * Saves several published items at full size: each stream is checked against the rendition's hash by `save`'s
   * caller-provided sink, which must consume or cancel it. Items without a finished rendition report `not_found`.
   */
  saveItems(
    albumId: AlbumId,
    items: readonly AlbumItem[],
    save: (item: AlbumItem, content: PhotoContent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<readonly SharedAlbumItemResult[]>;
}

const DEFAULT_ATTEMPTS = 3;
/** Fresh uploads started when every answer carrying the ticket was lost; each ticketless one is cancelled. */
const MAX_TICKET_RECOVERIES = 2;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/u;
/** Answers after which an upload can never commit, so its reservation and an unpublished add are released. */
const TERMINAL_COMMIT_CODES: ReadonlySet<SharingErrorCode> = new Set([
  "content_rejected", "upload_expired", "item_removed", "not_found", "role_forbidden", "stale_render", "revision_conflict", "invalid_request",
]);

export function createSharedAlbumItems(options: CreateSharedAlbumItemsOptions): SharedAlbumItems {
  const newKey = options.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_ATTEMPTS));
  const maxRetryAfter = options.maxAutomaticRetryAfterSeconds ?? 5;
  const sleep = options.sleep ?? abortableSleep;

  /** Replays the same request (and key) while the failure only means "the answer was lost or delayed". */
  async function send<K extends SharedAlbumItemOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    signal: AbortSignal,
    mutation: boolean,
  ): Promise<SharingOperationMap[K]["response"]> {
    const key = mutation ? newKey() : null;
    for (let attempt = 1; ; attempt += 1) {
      const requestOptions = (key === null ? { signal } : { signal, idempotencyKey: key }) as unknown as SharingRequestOptions<K>;
      try {
        return await options.client.request(operation, request, requestOptions);
      } catch (error) {
        if (signal.aborted || attempt >= maxAttempts) throw error;
        const wait = replayDelay(error, attempt, maxRetryAfter);
        if (wait === null) throw error;
        await sleep(wait, signal);
      }
    }
  }

  /** Releases an upload that will never commit, and removes an add that never published. Best effort. */
  async function abandon(albumId: AlbumId, uploadId: string, addedItemId: AlbumItemId | null): Promise<void> {
    // Not tied to the action's signal: a cancelled action must still release what it reserved.
    const cleanup = new AbortController().signal;
    try {
      await send("albumItems.cancelUpload", { albumId, uploadId }, cleanup, true);
    } catch {
      // Already committed, cancelled or expired: the server releases expired reservations itself.
    }
    if (addedItemId === null) return;
    try {
      await send("albumItems.remove", { albumId, itemId: addedItemId }, cleanup, true);
    } catch {
      // Gone already, or no longer ours to remove.
    }
  }

  /** add/replace → upload → commit, ending either committed or released (see the module notes). */
  async function uploadAndCommit(
    albumId: AlbumId,
    start: () => Promise<AlbumItemMutation>,
    again: (item: AlbumItem) => ReplaceContent,
    file: PreparedAlbumFile,
    adding: boolean,
    signal: AbortSignal,
  ): Promise<AlbumItem> {
    let mutation = await start();
    const addedItemId = adding ? mutation.item.id : null;
    for (let recovery = 0; mutation.upload?.ticket === null; recovery += 1) {
      const lost = mutation.upload;
      // The answer that carried the bearer ticket was lost; the replay has none. Abandon that upload and start the
      // same content on the same item (a replace), so no second item is created.
      await abandon(albumId, lost.upload.id, null);
      if (recovery >= MAX_TICKET_RECOVERIES) {
        if (addedItemId !== null) await abandon(albumId, lost.upload.id, addedItemId);
        throw new PersonalPhotoCloudError("unavailable");
      }
      const item = mutation.item;
      mutation = (await send("albumItems.replace", { albumId, itemId: item.id, expectedRevision: item.revision, content: again(item) }, signal, true)).value;
    }
    const upload = mutation.upload;
    if (!upload || !upload.ticket) throw new PersonalPhotoCloudError("invalid_response");
    try {
      await options.uploader.upload(upload.ticket, file.bytes, file.rendition.contentType, signal);
    } catch (error) {
      await abandon(albumId, upload.upload.id, addedItemId);
      throw error;
    }
    try {
      return (await send("albumItems.commitUpload", { albumId, uploadId: upload.upload.id }, signal, true)).value;
    } catch (error) {
      // Only a definite refusal is cleaned up; a commit whose answer was lost may have published.
      if (signal.aborted || (isSharingErrorEnvelope(error) && TERMINAL_COMMIT_CODES.has(error.error.code))) {
        await abandon(albumId, upload.upload.id, addedItemId);
      }
      throw error;
    }
  }

  async function each<T>(targets: readonly T[], name: (target: T) => string, run: (target: T) => Promise<AlbumItem>, signal: AbortSignal): Promise<SharedAlbumItemResult[]> {
    const results: SharedAlbumItemResult[] = [];
    for (const target of targets) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      try {
        results.push({ target: name(target), ok: true, item: await run(target) });
      } catch (error) {
        if (signal.aborted) throw error;
        results.push({ target: name(target), ok: false, error });
      }
    }
    return results;
  }

  return {
    listAlbums: async (page, signal) => await send("albums.list", page, signal, false),
    getAlbum: async (albumId, signal) => await send("albums.get", { albumId }, signal, false),
    createAlbum: async (name, signal) => (await send("albums.create", { name }, signal, true)).value,
    renameAlbum: async (albumId, expectedRevision, name, signal) => (await send("albums.rename", { albumId, expectedRevision, name }, signal, true)).value,
    async deleteAlbum(albumId, expectedRevision, signal) {
      await send("albums.delete", { albumId, expectedRevision }, signal, true);
    },
    storage: async (signal) => await send("storage.get", {}, signal, false),
    listItems: async (albumId, page, signal) => await send("albumItems.list", { albumId, ...page }, signal, false),
    getItem: async (albumId, itemId, signal) => await send("albumItems.get", { albumId, itemId }, signal, false),
    async addLibraryPhotos(albumId, photos, signal) {
      // The same photo picked twice in one selection is added once.
      const unique = [...new Map(photos.map((photo) => [`${photo.libraryId}\u001f${photo.photoId}`, photo])).values()];
      return await each(unique, (photo) => photo.photoId, async (photo) => {
        const source = { kind: "libraryPhoto" as const, libraryId: photo.libraryId, photoId: photo.photoId };
        return (await send("albumItems.addPhoto", { albumId, source }, signal, true)).value.item;
      }, signal);
    },
    async addDevicePhoto(albumId, input, signal) {
      const source = { kind: "devicePhoto" as const, deviceSourceRef: input.deviceSourceRef, binding: input.binding, rendition: input.file.rendition };
      return await uploadAndCommit(
        albumId,
        async () => (await send("albumItems.addPhoto", { albumId, source }, signal, true)).value,
        () => ({ kind: "deviceRender", binding: input.binding, rendition: input.file.rendition }),
        input.file,
        true,
        signal,
      );
    },
    async addFile(albumId, file, signal) {
      return await uploadAndCommit(
        albumId,
        async () => (await send("albumItems.addFile", { albumId, rendition: file.rendition }, signal, true)).value,
        () => ({ kind: "file", rendition: file.rendition }),
        file,
        true,
        signal,
      );
    },
    async replaceFile(albumId, item, file, signal) {
      const content: ReplaceContent = { kind: "file", rendition: file.rendition };
      return await uploadAndCommit(
        albumId,
        async () => (await send("albumItems.replace", { albumId, itemId: item.id, expectedRevision: item.revision, content }, signal, true)).value,
        () => content,
        file,
        false,
        signal,
      );
    },
    async replaceDeviceRender(albumId, item, input, signal) {
      const content: ReplaceContent = { kind: "deviceRender", binding: input.binding, rendition: input.file.rendition };
      return await uploadAndCommit(
        albumId,
        async () => (await send("albumItems.replace", { albumId, itemId: item.id, expectedRevision: item.revision, content }, signal, true)).value,
        () => content,
        input.file,
        false,
        signal,
      );
    },
    async removeItems(albumId, itemIds, signal) {
      return await each([...new Set(itemIds)], (itemId) => itemId, async (itemId) => (await send("albumItems.remove", { albumId, itemId }, signal, true)).value, signal);
    },
    async saveItems(albumId, items, save, signal) {
      return await each(items, (item) => item.id, async (item) => {
        if (item.rendition === null) throw { error: { code: "not_found", requestId: "local", retryable: false } };
        const content = await options.client.download({ albumId, itemId: item.id, renditionId: item.rendition.id, variant: "full" }, signal);
        // The stream must be the rendition the item names; anything else is not saved.
        if (content.sha256 !== item.rendition.asset.sha256 || content.totalBytes !== item.rendition.asset.sizeBytes) {
          await content.body.cancel().catch(() => undefined);
          throw new PersonalPhotoCloudError("invalid_response");
        }
        await save(item, content);
        return item;
      }, signal);
    },
  };
}

/**
 * A finished JPEG ready for `addFile`/`replaceFile`, cleaned on this device: every APPn and comment is dropped and
 * only the capture time and its offset are declared. A JPEG that relies on EXIF orientation is refused (its pixels are
 * not upright and the orientation tag is not kept); the host turns it upright with the engine first.
 */
export function prepareAlbumFile(bytes: Uint8Array): PreparedAlbumFile {
  if (bytes.byteLength === 0 || bytes.byteLength > SHARING_LIMITS.fileUploadMaxBytes) throw new SharedAlbumFileError("tooLarge");
  const capture = readJpegCaptureFields(bytes);
  const clean = capture ? stripJpegMetadata(bytes) : null;
  const size = clean ? readJpegPixelSize(clean) : null;
  if (!capture || !clean || !size) throw new SharedAlbumFileError("notJpeg");
  if (capture.orientation !== null && capture.orientation !== 1) throw new SharedAlbumFileError("notUpright");
  if (size.width * size.height > SHARING_LIMITS.renditionMaxPixels) throw new SharedAlbumFileError("tooManyPixels");
  const metadata = sanitizeRenditionMetadata({
    capturedAt: capture.capturedAt,
    capturedAtOffset: capture.capturedAtOffset !== null && OFFSET_PATTERN.test(capture.capturedAtOffset) ? capture.capturedAtOffset : null,
    colorProfile: "sRGB",
  });
  return {
    bytes: clean,
    rendition: { sizeBytes: clean.byteLength, sha256: bytesToHex(sha256(clean)), contentType: "image/jpeg", width: size.width, height: size.height, metadata },
  };
}

/** A device render from the B07 renderer (`renderFinishedOutput`, kind rendition) as an album upload. */
export function deviceRenderFile(output: FinishedOutput): PreparedAlbumFile {
  if (output.request.kind !== "rendition") throw new SharedAlbumFileError("notJpeg");
  const { sizeBytes, sha256: digest, contentType, width, height, metadata } = output.request;
  return { bytes: output.bytes, rendition: { sizeBytes, sha256: digest, contentType, width, height, metadata } };
}
