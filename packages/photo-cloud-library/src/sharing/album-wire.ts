/**
 * Wire for albums, album items and the owner's shared storage (B12 #254), on the contract's route table like the
 * membership wire. Requests are closed and checked before they are sent; answers are checked before they reach the UI:
 * people are display labels only, an item's original reference reaches its adder only, renditions carry only the
 * allowed metadata, and upload tickets appear only in the first answer (a replay has none).
 */
import { PersonalPhotoCloudError } from "../errors";
import { JSON_LIMITS, isOpaqueWireId } from "../wire";

import {
  ALBUM_ITEM_PENDING_REASONS,
  FILE_UPLOAD_CONTENT_TYPES,
  SHARING_LIMITS,
  checkAlbumName,
  findUnexpectedRequestFields,
  type AlbumItem,
  type Rendition,
  type RenditionUpload,
  type SharingOperationMap,
} from "./contract";
import {
  encodeRoutedRequest,
  exactRecord,
  integerBetween,
  invalidRequest,
  invalidResponse,
  isInstant,
  isRecord,
  safeNonNegative,
  validateAlbum,
  validatePersonLabel,
  validateReceipt,
  type EncodedSharingRequest,
} from "./membership-wire";

/** JSON operations of this client. `albumItems.download` is a content stream (see the album client). */
export const SHARED_ALBUM_ITEM_OPERATIONS = [
  "storage.get",
  "albums.list",
  "albums.get",
  "albums.create",
  "albums.rename",
  "albums.delete",
  "albumItems.list",
  "albumItems.get",
  "albumItems.addPhoto",
  "albumItems.addFile",
  "albumItems.replace",
  "albumItems.commitUpload",
  "albumItems.cancelUpload",
  "albumItems.remove",
] as const;
export type SharedAlbumItemOperation = (typeof SHARED_ALBUM_ITEM_OPERATIONS)[number];

const MUTATIONS: ReadonlySet<SharedAlbumItemOperation> = new Set([
  "albums.create",
  "albums.rename",
  "albums.delete",
  "albumItems.addPhoto",
  "albumItems.addFile",
  "albumItems.replace",
  "albumItems.commitUpload",
  "albumItems.cancelUpload",
  "albumItems.remove",
]);
const ITEM_KINDS: ReadonlySet<string> = new Set(["ownerPhoto", "memberEdit", "fileUpload"]);
const PENDING_REASONS: ReadonlySet<string> = new Set(ALBUM_ITEM_PENDING_REASONS);
const UPLOAD_STATES: ReadonlySet<string> = new Set(["reserved", "verifying", "committed", "cancelled", "expired", "rejected"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/u;
const ENGINE_MAX_LENGTH = 64;

export function isSharedAlbumItemOperation(value: unknown): value is SharedAlbumItemOperation {
  return typeof value === "string" && (SHARED_ALBUM_ITEM_OPERATIONS as readonly string[]).includes(value);
}

export function encodeAlbumItemRequest(operation: string, request: unknown, idempotencyKey: string | undefined): EncodedSharingRequest<SharedAlbumItemOperation> {
  if (!isSharedAlbumItemOperation(operation)) throw new PersonalPhotoCloudError("unsupported");
  validateAlbumItemRequest(operation, request);
  return encodeRoutedRequest(operation, request, MUTATIONS.has(operation), idempotencyKey);
}

export function albumItemResponseLimit(operation: SharedAlbumItemOperation): number {
  return operation === "albums.list" || operation === "albumItems.list" ? JSON_LIMITS.list : JSON_LIMITS.success;
}

/** Closed shape (B00 `findUnexpectedRequestFields`) plus the value rules the server re-checks. */
export function validateAlbumItemRequest(operation: SharedAlbumItemOperation, request: unknown): void {
  if (!isRecord(request) || findUnexpectedRequestFields(operation, request).length > 0) invalidRequest();
  const value = request;
  const required = (key: string): unknown => {
    if (!Object.hasOwn(value, key)) invalidRequest();
    return value[key];
  };
  const page = (): void => {
    if (value.cursor !== undefined && !isOpaqueWireId(value.cursor)) invalidRequest();
    if (value.limit !== undefined && !integerBetween(value.limit, 1, SHARING_LIMITS.listMaxCount)) invalidRequest();
  };
  switch (operation) {
    case "storage.get":
      return;
    case "albums.list":
      page();
      return;
    case "albums.create": {
      const name = required("name");
      if (typeof name !== "string" || !checkAlbumName(name).ok) invalidRequest();
      return;
    }
    default:
      break;
  }
  if (!isOpaqueWireId(required("albumId"))) invalidRequest();
  switch (operation) {
    case "albums.get":
      return;
    case "albums.rename": {
      const name = required("name");
      if (!safeNonNegative(required("expectedRevision")) || typeof name !== "string" || !checkAlbumName(name).ok) invalidRequest();
      return;
    }
    case "albums.delete":
      if (!safeNonNegative(required("expectedRevision"))) invalidRequest();
      return;
    case "albumItems.list":
      page();
      return;
    case "albumItems.get":
    case "albumItems.remove":
      if (!isOpaqueWireId(required("itemId"))) invalidRequest();
      return;
    case "albumItems.addPhoto": {
      const source = required("source");
      if (!isRecord(source)) invalidRequest();
      if (source.kind === "libraryPhoto") {
        if (!isOpaqueWireId(source.libraryId) || !isOpaqueWireId(source.photoId)) invalidRequest();
      } else if (source.kind === "devicePhoto") {
        if (!isOpaqueWireId(source.deviceSourceRef)) invalidRequest();
        checkBinding(source.binding);
        checkRenditionRequest(source.rendition);
      } else {
        invalidRequest();
      }
      return;
    }
    case "albumItems.addFile":
      checkRenditionRequest(required("rendition"));
      return;
    case "albumItems.replace": {
      if (!isOpaqueWireId(required("itemId")) || !safeNonNegative(required("expectedRevision"))) invalidRequest();
      const content = required("content");
      if (!isRecord(content)) invalidRequest();
      if (content.kind === "file") {
        checkRenditionRequest(content.rendition);
      } else if (content.kind === "deviceRender") {
        checkBinding(content.binding);
        checkRenditionRequest(content.rendition);
      } else {
        invalidRequest();
      }
      return;
    }
    case "albumItems.commitUpload":
    case "albumItems.cancelUpload":
      if (!isOpaqueWireId(required("uploadId"))) invalidRequest();
      return;
  }
}

/** Checks a decoded success body against the request it answers. Returns the typed response or throws. */
export function validateAlbumItemResponse<K extends SharedAlbumItemOperation>(
  operation: K,
  request: SharingOperationMap[K]["request"],
  raw: unknown,
): SharingOperationMap[K]["response"] {
  const albumId = (request as { readonly albumId?: string }).albumId as string;
  const done = raw as SharingOperationMap[K]["response"];
  switch (operation) {
    case "storage.get": {
      validateStorage(raw);
      return done;
    }
    case "albums.list": {
      const page = exactRecord(raw, ["items", "nextCursor"], ["items", "nextCursor"]);
      if (!Array.isArray(page.items) || page.items.length > SHARING_LIMITS.listMaxCount) invalidResponse();
      if (page.nextCursor !== null && !isOpaqueWireId(page.nextCursor)) invalidResponse();
      page.items.forEach(validateAlbum);
      return done;
    }
    case "albums.get": {
      if (validateAlbum(raw).id !== albumId) invalidResponse();
      return done;
    }
    case "albums.create": {
      const album = validateAlbum(validateReceipt(raw).value);
      const name = (request as SharingOperationMap["albums.create"]["request"]).name;
      if (album.access.role !== "owner" || album.name !== name) invalidResponse();
      return done;
    }
    case "albums.rename": {
      const album = validateAlbum(validateReceipt(raw).value);
      const rename = request as SharingOperationMap["albums.rename"]["request"];
      if (album.id !== albumId || album.name !== rename.name || album.revision <= rename.expectedRevision) invalidResponse();
      return done;
    }
    case "albums.delete": {
      const deleted = exactRecord(validateReceipt(raw).value, ["albumId", "state"], ["albumId", "state"]);
      if (deleted.albumId !== albumId || deleted.state !== "deleted") invalidResponse();
      return done;
    }
    case "albumItems.list": {
      const keys = ["items", "nextCursor", "albumRevision", "membershipRevision"];
      const page = exactRecord(raw, keys, keys);
      if (!Array.isArray(page.items) || page.items.length > SHARING_LIMITS.listMaxCount) invalidResponse();
      if (page.nextCursor !== null && !isOpaqueWireId(page.nextCursor)) invalidResponse();
      if (!safeNonNegative(page.albumRevision) || !safeNonNegative(page.membershipRevision)) invalidResponse();
      // Lists never include removed tombstones.
      for (const item of page.items) if (validateAlbumItem(item, albumId).state === "removed") invalidResponse();
      return done;
    }
    case "albumItems.get": {
      if (validateAlbumItem(raw, albumId).id !== (request as SharingOperationMap["albumItems.get"]["request"]).itemId) invalidResponse();
      return done;
    }
    case "albumItems.addPhoto":
    case "albumItems.addFile":
    case "albumItems.replace": {
      validateItemMutation(operation, request, raw, albumId);
      return done;
    }
    case "albumItems.commitUpload": {
      const item = validateAlbumItem(validateReceipt(raw).value, albumId);
      if (item.state !== "published" && item.state !== "updatePending") invalidResponse();
      if (!item.addedBy.isSelf) invalidResponse();
      return done;
    }
    case "albumItems.cancelUpload": {
      const upload = validateUpload(validateReceipt(raw).value, albumId);
      if (upload.id !== (request as SharingOperationMap["albumItems.cancelUpload"]["request"]).uploadId || upload.state !== "cancelled") invalidResponse();
      return done;
    }
    case "albumItems.remove": {
      const item = validateAlbumItem(validateReceipt(raw).value, albumId);
      if (item.id !== (request as SharingOperationMap["albumItems.remove"]["request"]).itemId || item.state !== "removed") invalidResponse();
      return done;
    }
  }
  return invalidResponse();
}

/** `albumItems.download`: a closed request for one rendition (full or thumbnail), optionally a byte range. */
export function validateDownloadRequest(request: unknown): asserts request is SharingOperationMap["albumItems.download"]["request"] {
  if (!isRecord(request) || findUnexpectedRequestFields("albumItems.download", request).length > 0) invalidRequest();
  if (!isOpaqueWireId(request.albumId) || !isOpaqueWireId(request.itemId) || !isOpaqueWireId(request.renditionId)) invalidRequest();
  if (request.variant !== "full" && request.variant !== "thumbnail") invalidRequest();
  if (request.range !== undefined) {
    const range = request.range;
    if (!isRecord(range) || !safeNonNegative(range.start)) invalidRequest();
    if (range.endInclusive !== undefined && !(safeNonNegative(range.endInclusive) && range.endInclusive >= (range.start as number))) invalidRequest();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Request parts

function checkRenditionRequest(value: unknown): void {
  if (!isRecord(value)) invalidRequest();
  const rendition = value;
  if (!integerBetween(rendition.sizeBytes, 1, SHARING_LIMITS.fileUploadMaxBytes)) invalidRequest();
  if (typeof rendition.sha256 !== "string" || !SHA256.test(rendition.sha256)) invalidRequest();
  if (!(FILE_UPLOAD_CONTENT_TYPES as readonly unknown[]).includes(rendition.contentType)) invalidRequest();
  if (!integerBetween(rendition.width, 1, SHARING_LIMITS.renditionMaxPixels) || !integerBetween(rendition.height, 1, SHARING_LIMITS.renditionMaxPixels)) invalidRequest();
  if ((rendition.width as number) * (rendition.height as number) > SHARING_LIMITS.renditionMaxPixels) invalidRequest();
  if (!isRenditionMetadata(rendition.metadata)) invalidRequest();
}

function checkBinding(value: unknown): void {
  if (!isRecord(value)) invalidRequest();
  const binding = value;
  if (!safeNonNegative(binding.sourceGeneration) || !safeNonNegative(binding.recipeRevision)) invalidRequest();
  for (const key of ["sourceSha256", "settingsSha256", "rendererManifestSha256"]) {
    if (typeof binding[key] !== "string" || !SHA256.test(binding[key] as string)) invalidRequest();
  }
  if (typeof binding.engine !== "string" || binding.engine.length === 0 || binding.engine.length > ENGINE_MAX_LENGTH) invalidRequest();
  if (!Array.isArray(binding.maskSurfaceIds) || !binding.maskSurfaceIds.every(isOpaqueWireId)) invalidRequest();
}

function isRenditionMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "capturedAt,capturedAtOffset,colorProfile,orientation") return false;
  if (value.capturedAt !== null && !(typeof value.capturedAt === "string" && LOCAL_TIME.test(value.capturedAt))) return false;
  if (value.capturedAtOffset !== null && !(typeof value.capturedAtOffset === "string" && OFFSET.test(value.capturedAtOffset))) return false;
  return (value.colorProfile === "sRGB" || value.colorProfile === "displayP3") && value.orientation === 1;
}

// ---------------------------------------------------------------------------------------------------------
// Response parts

/** One item as this viewer may see it: the original reference only for its adder, allowed metadata only. */
export function validateAlbumItem(value: unknown, albumId: string): AlbumItem {
  if (!isRecord(value)) invalidResponse();
  const common = ["id", "albumId", "kind", "addedBy", "addedAt", "revision", "source", "state", "rendition"];
  const state = value.state;
  const extra = state === "preparing" || state === "updatePending" ? ["pendingReason"] : state === "removed" ? ["removedAt"] : state === "published" ? [] : invalidResponse();
  const item = exactRecord(value, [...common, ...extra], [...common, ...extra]);
  if (!isOpaqueWireId(item.id) || item.albumId !== albumId || !ITEM_KINDS.has(String(item.kind))) invalidResponse();
  const addedBy = validatePersonLabel(item.addedBy);
  if (!isInstant(item.addedAt) || !safeNonNegative(item.revision)) invalidResponse();
  if (item.source !== null) {
    // The original reference is the adder's alone, and a finished file has none.
    if (!addedBy.isSelf || item.kind === "fileUpload") invalidResponse();
    const source = item.source;
    if (isRecord(source) && source.kind === "libraryPhoto") {
      const library = exactRecord(source, ["kind", "libraryId", "photoId"], ["kind", "libraryId", "photoId"]);
      if (!isOpaqueWireId(library.libraryId) || !isOpaqueWireId(library.photoId)) invalidResponse();
    } else if (isRecord(source) && source.kind === "devicePhoto") {
      const device = exactRecord(source, ["kind", "deviceSourceRef"], ["kind", "deviceSourceRef"]);
      if (!isOpaqueWireId(device.deviceSourceRef)) invalidResponse();
    } else {
      invalidResponse();
    }
  }
  if (extra.includes("pendingReason") && !PENDING_REASONS.has(String(item.pendingReason))) invalidResponse();
  switch (state) {
    case "preparing":
      if (item.rendition !== null || item.revision !== 0) invalidResponse();
      break;
    case "published":
    case "updatePending":
      if (validateRendition(item.rendition).itemRevision !== item.revision || item.revision < 1) invalidResponse();
      break;
    case "removed":
      if (item.rendition !== null || !isInstant(item.removedAt)) invalidResponse();
      break;
  }
  return item as unknown as AlbumItem;
}

export function validateRendition(value: unknown): Rendition {
  const keys = ["id", "itemRevision", "asset", "thumbnail", "metadata", "createdAt"];
  const rendition = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(rendition.id) || !safeNonNegative(rendition.itemRevision) || !isInstant(rendition.createdAt)) invalidResponse();
  const assetKeys = ["sha256", "sizeBytes", "contentType", "width", "height", "fullResolution"];
  const asset = exactRecord(rendition.asset, assetKeys, assetKeys);
  // A preview or a downscale is never published as the finished photo.
  if (asset.fullResolution !== true) invalidResponse();
  validateImageAsset(asset);
  const thumbnailKeys = ["sha256", "sizeBytes", "contentType", "width", "height"];
  const thumbnail = exactRecord(rendition.thumbnail, thumbnailKeys, thumbnailKeys);
  validateImageAsset(thumbnail);
  if (Math.max(thumbnail.width as number, thumbnail.height as number) > SHARING_LIMITS.thumbnailMaxEdge) invalidResponse();
  // Nothing beyond capture time, its offset, colour profile and orientation reaches a viewer.
  if (!isRenditionMetadata(rendition.metadata)) invalidResponse();
  return rendition as unknown as Rendition;
}

function validateImageAsset(asset: Record<string, unknown>): void {
  if (typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256) || !integerBetween(asset.sizeBytes, 1, SHARING_LIMITS.fileUploadMaxBytes)) invalidResponse();
  if (asset.contentType !== "image/jpeg" || !integerBetween(asset.width, 1, SHARING_LIMITS.renditionMaxPixels) || !integerBetween(asset.height, 1, SHARING_LIMITS.renditionMaxPixels)) invalidResponse();
}

export function validateUpload(value: unknown, albumId: string): RenditionUpload {
  const keys = ["id", "albumId", "itemId", "targetItemRevision", "sizeBytes", "sha256", "expiresAt", "state", "uploadedBytes"];
  const upload = exactRecord(value, keys, keys);
  if (!isOpaqueWireId(upload.id) || upload.albumId !== albumId || !isOpaqueWireId(upload.itemId)) invalidResponse();
  if (!integerBetween(upload.targetItemRevision, 1, Number.MAX_SAFE_INTEGER) || !integerBetween(upload.sizeBytes, 1, SHARING_LIMITS.fileUploadMaxBytes)) invalidResponse();
  if (typeof upload.sha256 !== "string" || !SHA256.test(upload.sha256) || !isInstant(upload.expiresAt) || !UPLOAD_STATES.has(String(upload.state))) invalidResponse();
  if (!safeNonNegative(upload.uploadedBytes) || upload.uploadedBytes > upload.sizeBytes) invalidResponse();
  return upload as unknown as RenditionUpload;
}

function validateTicketShape(value: unknown): void {
  const keys = ["url", "method", "headers", "expiresAt", "resumeOffsetBytes"];
  const ticket = exactRecord(value, keys, keys);
  // The trusted provider origin is checked again by the uploader before any byte is sent.
  if (typeof ticket.url !== "string" || !ticket.url.startsWith("https://") || ticket.method !== "PUT" || !isInstant(ticket.expiresAt)) invalidResponse();
  if (!isRecord(ticket.headers) || Object.values(ticket.headers).some((header) => typeof header !== "string") || !safeNonNegative(ticket.resumeOffsetBytes)) invalidResponse();
}

function validateItemMutation(operation: "albumItems.addPhoto" | "albumItems.addFile" | "albumItems.replace", request: unknown, raw: unknown, albumId: string): void {
  const receipt = validateReceipt(raw);
  const mutation = exactRecord(receipt.value, ["item", "upload"], ["item", "upload"]);
  const item = validateAlbumItem(mutation.item, albumId);
  if (!item.addedBy.isSelf || item.state === "removed") invalidResponse();
  const body = request as Record<string, unknown>;
  const source = operation === "albumItems.addPhoto" ? (body.source as Record<string, unknown>) : null;
  const content = operation === "albumItems.replace" ? (body.content as Record<string, unknown>) : null;
  if (operation === "albumItems.addFile" && (item.kind !== "fileUpload" || item.state !== "preparing")) invalidResponse();
  if (source) {
    if (item.kind === "fileUpload" || !isRecord(item.source) || item.source.kind !== source.kind || item.state !== "preparing") invalidResponse();
    if (source.kind === "libraryPhoto" && (item.source.kind !== "libraryPhoto" || item.source.photoId !== source.photoId || item.source.libraryId !== source.libraryId)) invalidResponse();
  }
  if (operation === "albumItems.replace" && item.id !== body.itemId) invalidResponse();
  // A library photo is rendered by the device holding it: no upload. Every other add or replace uploads one file.
  const expectsUpload = !(source && source.kind === "libraryPhoto");
  if (!expectsUpload) {
    if (mutation.upload !== null) invalidResponse();
    return;
  }
  const start = exactRecord(mutation.upload, ["upload", "ticket"], ["upload", "ticket"]);
  const upload = validateUpload(start.upload, albumId);
  const declared = (source?.rendition ?? content?.rendition ?? body.rendition) as Record<string, unknown>;
  if (upload.itemId !== item.id || upload.sizeBytes !== declared.sizeBytes || upload.sha256 !== declared.sha256 || upload.targetItemRevision !== item.revision + 1) invalidResponse();
  // The bearer ticket comes only in the first answer; a replay must not resend it.
  if (receipt.replayed) {
    if (start.ticket !== null) invalidResponse();
  } else {
    validateTicketShape(start.ticket);
  }
}

function validateStorage(raw: unknown): void {
  const keys = ["owner", "quotaBytes", "usedBytes", "previewBytes", "maskBytes", "renditionBytes", "exportStagingBytes", "reservedBytes", "availableBytes"];
  const storage = exactRecord(raw, keys, keys);
  const owner = exactRecord(storage.owner, ["type", "userId"], ["type", "userId"]);
  if (owner.type !== "user" || !isOpaqueWireId(owner.userId)) invalidResponse();
  for (const key of keys.slice(1)) if (!safeNonNegative(storage[key])) invalidResponse();
  const parts = ["previewBytes", "maskBytes", "renditionBytes", "exportStagingBytes"].reduce((sum, key) => sum + (storage[key] as number), 0);
  if (parts !== storage.usedBytes) invalidResponse();
  const available = Math.max(0, (storage.quotaBytes as number) - (storage.usedBytes as number) - (storage.reservedBytes as number));
  if (storage.availableBytes !== available) invalidResponse();
}
