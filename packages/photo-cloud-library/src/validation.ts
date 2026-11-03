import {
  PHOTO_LIBRARY_CONTRACT_VERSION,
  PHOTO_LIMITS,
  type MediaState,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoAsset,
  type PhotoInfo,
  type PhotoLookupMatch,
  type PhotoPage,
  type QuotaUsage,
  type RecipeDocument,
  type RenderCapability,
  type StartUploadResponse,
  type Upload,
  type UploadTicket,
  type WorkingCopy,
} from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "./errors";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const textEncoder = new TextEncoder();

export function validateLibrary(value: PersonalPhotoLibrary, ownerId: string, libraryId: string): PersonalPhotoLibrary {
  if (
    !isRecord(value) ||
    !isRecord(value.owner) ||
    !isRecord(value.limits) ||
    !isRecord(value.usage) ||
    !isRecord(value.capabilities) ||
    value.contractVersion !== PHOTO_LIBRARY_CONTRACT_VERSION ||
    value.id !== libraryId ||
    value.owner.type !== "user" ||
    value.owner.userId !== ownerId ||
    (value.state !== "active" && value.state !== "deleting") ||
    !safeNonNegative(value.revision)
  ) {
    invalid();
  }
  for (const [key, expected] of Object.entries(PHOTO_LIMITS)) {
    if (Reflect.get(value.limits, key) !== expected) invalid();
  }
  validateUsage(value.usage);
  validateCapabilities(value.capabilities);
  return value;
}

export function validateUsage(value: QuotaUsage): QuotaUsage {
  if (!isRecord(value)) invalid();
  const numbers = [
    value.quotaBytes,
    value.usedBytes,
    value.originalBytes,
    value.maskBytes,
    value.pendingPurgeBytes,
    value.reservedBytes,
    value.availableBytes,
  ];
  if (
    !numbers.every(safeNonNegative) ||
    value.quotaBytes !== PHOTO_LIMITS.quotaBytes ||
    value.usedBytes !== value.originalBytes + value.maskBytes ||
    value.pendingPurgeBytes > value.usedBytes ||
    value.usedBytes + value.reservedBytes > value.quotaBytes ||
    value.availableBytes !== value.quotaBytes - value.usedBytes - value.reservedBytes
  ) {
    invalid();
  }
  return value;
}

export function validatePage(value: PhotoPage, libraryId: string): PhotoPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > PHOTO_LIMITS.listMaxCount) invalid();
  if (value.nextCursor !== null && !boundedString(value.nextCursor, 1, 4096)) invalid();
  if (!safeNonNegative(value.libraryRevision)) invalid();
  validateUsage(value.usage);
  for (const photo of value.items) validatePhoto(photo, libraryId);
  return value;
}

export function validatePhoto(value: Photo, libraryId: string): Photo {
  if (
    !isRecord(value) ||
    !isRecord(value.original) ||
    !isRecord(value.recipe) ||
    !isRecord(value.media) ||
    !boundedString(value.id, 1, 512) ||
    value.libraryId !== libraryId ||
    value.storageState !== "stored" ||
    value.lifecycle !== "active" ||
    !boundedString(value.fileName, 1, PHOTO_LIMITS.maxFileNameBytes) ||
    !["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(value.format) ||
    typeof value.hasEdits !== "boolean" ||
    !instant(value.addedAt) ||
    (value.capturedAt !== null && !instant(value.capturedAt)) ||
    !positiveInteger(value.width) ||
    !positiveInteger(value.height) ||
    value.width * value.height > PHOTO_LIMITS.maxPixels
  ) {
    invalid();
  }
  validateAsset(value.original, "original");
  if (value.original.width !== value.width || value.original.height !== value.height) invalid();
  validateRecipe(value.recipe);
  validateMediaState(value.media);
  return value;
}

export function validateAsset(value: PhotoAsset, expectedKind?: PhotoAsset["kind"]): PhotoAsset {
  if (
    !isRecord(value) ||
    !boundedString(value.id, 1, 512) ||
    (expectedKind !== undefined && value.kind !== expectedKind) ||
    !["original", "mask", "thumbnail", "preview", "working-copy"].includes(value.kind) ||
    !sha256(value.sha256) ||
    !positiveInteger(value.sizeBytes) ||
    value.sizeBytes > PHOTO_LIMITS.maxFileBytes ||
    !boundedString(value.contentType, 1, 255) ||
    !positiveInteger(value.width) ||
    !positiveInteger(value.height) ||
    value.width * value.height > PHOTO_LIMITS.maxPixels
  ) {
    invalid();
  }
  if (value.kind === "mask" && (value.sizeBytes > PHOTO_LIMITS.maxMaskBytes || value.width > PHOTO_LIMITS.maxMaskEdge || value.height > PHOTO_LIMITS.maxMaskEdge)) {
    invalid();
  }
  const maxEdge = Math.max(value.width, value.height);
  if (value.kind === "thumbnail" && maxEdge > PHOTO_LIMITS.thumbnailMaxEdge) invalid();
  if (value.kind === "preview" && maxEdge > PHOTO_LIMITS.previewMaxEdge) invalid();
  if (value.kind === "working-copy" && maxEdge > PHOTO_LIMITS.workingCopyMaxEdge) invalid();
  return value;
}

export function validateLookup(matches: readonly PhotoLookupMatch[], requested: ReadonlySet<string>): readonly PhotoLookupMatch[] {
  if (!Array.isArray(matches) || matches.length > PHOTO_LIMITS.lookupMaxCount) invalid();
  const seen = new Set<string>();
  for (const match of matches) {
    if (!isRecord(match)) invalid();
    if (!sha256(match.sha256) || !requested.has(match.sha256) || seen.has(match.sha256)) invalid();
    if (!boundedString(match.photoId, 1, 512) || !safeNonNegative(match.recipeRevision)) invalid();
    seen.add(match.sha256);
  }
  return matches;
}

export function validateInfo(value: PhotoInfo): PhotoInfo {
  if (!isRecord(value)) invalid();
  if (value.camera !== undefined && value.camera !== null) {
    if (!isRecord(value.camera)) invalid();
    nullableString(value.camera.make);
    nullableString(value.camera.model);
  }
  nullableOptionalString(value.lens);
  nullableOptionalFinite(value.iso, 0);
  nullableOptionalFinite(value.exposureTimeSeconds, 0);
  nullableOptionalFinite(value.fNumber, 0);
  nullableOptionalFinite(value.focalLengthMm, 0);
  if (value.capturedAt !== undefined && value.capturedAt !== null && !instant(value.capturedAt)) invalid();
  nullableOptionalInteger(value.width);
  nullableOptionalInteger(value.height);
  if (value.gps !== undefined && value.gps !== null) {
    if (!isRecord(value.gps)) invalid();
    if (!finiteBetween(value.gps.latitude, -90, 90) || !finiteBetween(value.gps.longitude, -180, 180)) invalid();
  }
  return value;
}

export function validateUpload(value: Upload, libraryId: string): Upload {
  if (
    !isRecord(value) ||
    !boundedString(value.id, 1, 512) ||
    !isRecord(value.target) ||
    !positiveInteger(value.sizeBytes) ||
    value.sizeBytes > PHOTO_LIMITS.maxFileBytes ||
    !sha256(value.sha256) ||
    !instant(value.expiresAt)
  ) invalid();
  if (value.target.kind === "original") {
    if (!boundedString(value.target.fileName, 1, PHOTO_LIMITS.maxFileNameBytes) || !isPhotoFormat(value.target.format)) invalid();
  } else if (value.target.kind === "mask") {
    if (!boundedString(value.target.photoId, 1, 512) || value.sizeBytes > PHOTO_LIMITS.maxMaskBytes) invalid();
  } else invalid();
  if (value.state === "reserved") {
    if (!safeNonNegative(value.uploadedBytes) || value.uploadedBytes > value.sizeBytes) invalid();
  } else if (value.state === "verifying") {
    if (!boundedString(value.jobId, 1, 512)) invalid();
  } else if (value.state === "stored") {
    if (!isRecord(value.result)) invalid();
    if (value.result.kind === "original") validatePhoto(value.result.photo, libraryId);
    else if (value.result.kind === "mask") {
      if (!boundedString(value.result.photoId, 1, 512)) invalid();
      validateAsset(value.result.asset, "mask");
    } else invalid();
  } else if (value.state === "rejected") {
    if (!["content_rejected", "unsupported_format", "pixel_limit_exceeded"].includes(value.code)) invalid();
  } else if (value.state !== "cancelled" && value.state !== "expired") invalid();
  return value;
}

export function validateStartUploadResponse(value: StartUploadResponse, libraryId: string): StartUploadResponse {
  if (!isRecord(value)) invalid();
  if (value.kind === "existing") {
    validatePhoto(value.photo, libraryId);
  } else if (value.kind === "upload") {
    validateUpload(value.upload, libraryId);
    if (value.ticket !== null && !isUploadTicketShape(value.ticket)) invalid();
  } else invalid();
  return value;
}

export function isUploadTicketShape(value: unknown): value is UploadTicket {
  return isRecord(value)
    && boundedString(value.url, 1, 8192)
    && value.method === "PUT"
    && isRecord(value.headers)
    && Object.values(value.headers).every((item) => boundedString(item, 0, 1024))
    && instant(value.expiresAt)
    && safeNonNegative(value.resumeOffsetBytes);
}

export function validateJsonValue(value: unknown, maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || jsonBytes(value) > maximumBytes) invalid();
  validateJson(value, 0);
}

export function validateJsonDepth(value: unknown): void {
  validateJson(value, 0);
}

export function validateRenderer(value: RenderCapability): RenderCapability {
  if (
    !isRecord(value) ||
    !boundedString(value.sdkVersion, 1, 128) ||
    !boundedString(value.crateVersion, 1, 128) ||
    !sha256(value.manifestSha256) ||
    !integerList(value.settingsVersions) ||
    !stringList(value.engines) ||
    !stringList(value.features) ||
    !stringList(value.maskKinds) ||
    typeof value.maskSurfaces !== "boolean"
  ) {
    invalid();
  }
  return value;
}

function validateCapabilities(value: PersonalPhotoLibrary["capabilities"]): void {
  if (
    !isRecord(value) ||
    !Array.isArray(value.formats) ||
    typeof value.edits !== "boolean" ||
    typeof value.versions !== "boolean" ||
    typeof value.maskSurfaces !== "boolean" ||
    value.albums !== false ||
    value.publicSharing !== false
  ) {
    invalid();
  }
  const formats = new Set<string>();
  for (const capability of value.formats) {
    if (
      !isRecord(capability) ||
      !isPhotoFormat(capability.format) ||
      formats.has(capability.format) ||
      !stringList(capability.extensions) ||
      typeof capability.ingest !== "boolean" ||
      typeof capability.workingCopy !== "boolean"
    ) {
      invalid();
    }
    formats.add(capability.format);
  }
  validateRenderer(value.renderer);
}

function validateRecipe(value: RecipeDocument): void {
  if (
    !isRecord(value) ||
    !safeNonNegative(value.revision) ||
    !isRecord(value.settings) ||
    !safeNonNegative(value.settings.v) ||
    !boundedString(value.settings.engine, 1, 128) ||
    !sha256(value.settingsSha256) ||
    (value.baseVersion !== null && !boundedString(value.baseVersion, 1, 512)) ||
    !Array.isArray(value.maskSurfaceIds) ||
    !value.maskSurfaceIds.every(sha256) ||
    !instant(value.updatedAt) ||
    jsonBytes(value.settings) > PHOTO_LIMITS.maxRecipeBytes
  ) {
    invalid();
  }
  validateJson(value.settings, 0);
}

export function validateMediaState(value: MediaState): MediaState {
  if (!isRecord(value)) invalid();
  if (value.state === "pending") return value;
  if (value.state === "queued" || value.state === "processing") {
    if (!boundedString(value.jobId, 1, 512)) invalid();
    return value;
  }
  if (value.state === "failed" || value.state === "unsupported") {
    if (!["decoder_failed", "renderer_unavailable", "unsupported_settings"].includes(value.code)) invalid();
    return value;
  }
  if (value.state !== "ready") invalid();
  validateAsset(value.thumbnail, "thumbnail");
  validateAsset(value.preview, "preview");
  if (value.workingCopy !== null) validateWorkingCopy(value.workingCopy);
  if (!safeNonNegative(value.recipeRevision) || !sha256(value.rendererManifestSha256)) invalid();
  return value;
}

function validateWorkingCopy(value: WorkingCopy): void {
  if (!isRecord(value)) invalid();
  validateAsset(value.asset, "working-copy");
  if (!boundedString(value.baseVersion, 1, 512) || (value.encoding !== "png16" && value.encoding !== "jpeg8")) invalid();
  if (!isRecord(value.meta) || jsonBytes(value.meta) > PHOTO_LIMITS.maxWorkingCopyMetaBytes) invalid();
  validateJson(value.meta, 0);
}

function validateJson(value: unknown, depth: number): void {
  if (depth > PHOTO_LIMITS.maxJsonDepth) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (!isRecord(value)) invalid();
  for (const item of Object.values(value)) validateJson(item, depth + 1);
}

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) invalid();
    return textEncoder.encode(json).byteLength;
  } catch {
    invalid();
  }
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => boundedString(item, 1, 256)) && new Set(value).size === value.length;
}

function integerList(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(positiveInteger) && new Set(value).size === value.length;
}

function nullableString(value: unknown): void {
  if (value !== null && !boundedString(value, 0, 4096)) invalid();
}

function nullableOptionalString(value: unknown): void {
  if (value !== undefined) nullableString(value);
}

function nullableOptionalFinite(value: unknown, minimum: number): void {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < minimum)) invalid();
}

function nullableOptionalInteger(value: unknown): void {
  if (value !== undefined && value !== null && !positiveInteger(value)) invalid();
}

function finiteBetween(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isPhotoFormat(value: unknown): value is "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw" {
  return typeof value === "string" && ["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(value);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && textEncoder.encode(value).byteLength <= maximum;
}

function instant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function safeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new PersonalPhotoCloudError("invalid_response");
}
