import { PHOTO_LIMITS } from "../../photo-library-contract/src/v2.ts";
import type { JsonObject, Photo, PhotoAsset, Sha256, WorkingCopy } from "../../photo-library-contract/src/v2.ts";

export * from "./types.ts";
import type { CloudRenderInput, CloudRenderSelection, RenderInputLimits } from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ID_BYTES = 512;
const JPEG_MAX_BYTES = 64 * 1024 ** 2;
const PNG_MAX_BYTES = 10 * 1024 ** 2;

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const boundedId = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return new TextEncoder().encode(value).byteLength <= MAX_ID_BYTES;
};

function validAsset(asset: unknown, kind: PhotoAsset["kind"], contentTypes: readonly string[], maxBytes: number, maxEdge?: number): asset is PhotoAsset {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return false;
  const value = asset as PhotoAsset;
  return boundedId(value.id) && value.kind === kind && SHA256.test(value.sha256)
    && positiveInteger(value.sizeBytes) && value.sizeBytes <= maxBytes
    && (contentTypes.length === 0
      ? typeof value.contentType === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value.contentType)
      : contentTypes.includes(value.contentType))
    && positiveInteger(value.width) && positiveInteger(value.height)
    && value.width * value.height <= PHOTO_LIMITS.maxPixels
    && (maxEdge === undefined || Math.max(value.width, value.height) <= maxEdge);
}

function validJsonObject(value: unknown, maxBytes: number): value is JsonObject {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return false;
    if (new TextEncoder().encode(encoded).byteLength > maxBytes) return false;
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (next.depth > PHOTO_LIMITS.maxJsonDepth) return false;
      const item = next.value;
      if (item === null || typeof item === "boolean") continue;
      if (typeof item === "string") {
        if (/\p{Cs}/u.test(item)) return false;
        continue;
      }
      if (typeof item === "number") {
        if (!Number.isFinite(item)) return false;
        continue;
      }
      if (!item || typeof item !== "object" || seen.has(item)) return false;
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (/\p{Cs}/u.test(key)) return false;
        pending.push({ value: child, depth: next.depth + 1 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Shared structural bound only; the installed SDK owns metadata/base compatibility. */
export function isBoundedWorkingCopyMeta(value: unknown): value is JsonObject {
  return validJsonObject(value, PHOTO_LIMITS.maxWorkingCopyMetaBytes);
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) immutable(child, seen);
    Object.freeze(value);
  }
  return value;
}

function cloneAsset(asset: PhotoAsset): PhotoAsset {
  return immutable({ ...asset });
}

function invalidPhotoMetadata(photo: Photo, limits: RenderInputLimits): boolean {
  try {
    return !photo || typeof photo !== "object" || !limits || typeof limits !== "object"
      || !boundedId(photo.id) || !boundedId(photo.libraryId)
      || photo.storageState !== "stored" || photo.lifecycle !== "active"
      || !["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(photo.format)
      || !photo.media || typeof photo.media !== "object"
      || !["pending", "queued", "processing", "ready", "failed", "unsupported"].includes(photo.media.state)
      || !positiveInteger(limits.maxBytes) || limits.maxBytes > PHOTO_LIMITS.maxFileBytes
      || !positiveInteger(limits.maxPixels) || limits.maxPixels > PHOTO_LIMITS.maxPixels
      || !positiveInteger(photo.width) || !positiveInteger(photo.height)
      || photo.width * photo.height > PHOTO_LIMITS.maxPixels
      || !validAsset(photo.original, "original", [], PHOTO_LIMITS.maxFileBytes)
      || photo.original.width !== photo.width || photo.original.height !== photo.height
      || !photo.recipe || typeof photo.recipe !== "object"
      || !Number.isSafeInteger(photo.recipe.revision) || photo.recipe.revision < 0
      || !SHA256.test(photo.recipe.settingsSha256)
      || !Array.isArray(photo.recipe.maskSurfaceIds)
      || new Set(photo.recipe.maskSurfaceIds).size !== photo.recipe.maskSurfaceIds.length
      || photo.recipe.maskSurfaceIds.some((id) => !SHA256.test(id))
      || !validJsonObject(photo.recipe.settings, PHOTO_LIMITS.maxRecipeBytes)
      || typeof photo.recipe.settings.v !== "number" || !Number.isSafeInteger(photo.recipe.settings.v)
      || typeof photo.recipe.settings.engine !== "string" || !boundedId(photo.recipe.settings.engine)
      || (photo.recipe.baseVersion !== null && !boundedId(photo.recipe.baseVersion));
  } catch {
    return true;
  }
}

function workingCopyInput(photo: Photo, copy: WorkingCopy, limits: RenderInputLimits): CloudRenderSelection {
  if (copy.encoding !== "png16" && copy.encoding !== "jpeg8") {
    return { state: "unavailable", reason: "invalid_metadata" };
  }
  const contentType = copy.encoding === "png16" ? "image/png" : "image/jpeg";
  if (!boundedId(copy.baseVersion) || copy.baseVersion !== photo.recipe.baseVersion
    || photo.recipe.settings.base !== copy.baseVersion) {
    return { state: "unavailable", reason: "base_unavailable" };
  }
  if (!isBoundedWorkingCopyMeta(copy.meta)
    || !validAsset(copy.asset, "working-copy", [contentType], PHOTO_LIMITS.maxFileBytes, PHOTO_LIMITS.workingCopyMaxEdge)
    || copy.asset.contentType !== contentType) return { state: "unavailable", reason: "invalid_metadata" };
  if (copy.asset.sizeBytes > limits.maxBytes || copy.asset.width * copy.asset.height > limits.maxPixels) {
    return { state: "unavailable", reason: "input_limit" };
  }
  const meta = structuredClone(copy.meta) as JsonObject;
  const input: CloudRenderInput = {
    kind: "workingCopy",
    photoId: photo.id,
    libraryId: photo.libraryId,
    originalSha256: photo.original.sha256,
    originalAssetId: photo.original.id,
    asset: cloneAsset(copy.asset),
    exportMaxEdge: Math.max(copy.asset.width, copy.asset.height),
    encoding: copy.encoding,
    baseVersion: copy.baseVersion,
    meta: immutable(meta),
  };
  return { state: "ready", input: immutable(input) };
}

/** Select a locator-free, immutable render plan. This is metadata validation, not authorization proof. */
export function selectCloudRenderInput(
  photo: Photo,
  options: { readonly recipeWritable: boolean } & RenderInputLimits,
): CloudRenderSelection {
  if (!options || typeof options !== "object" || typeof options.recipeWritable !== "boolean") {
    return { state: "unavailable", reason: "invalid_metadata" };
  }
  if (!options.recipeWritable) return { state: "unavailable", reason: "unsupported_settings" };
  if (invalidPhotoMetadata(photo, options)) return { state: "unavailable", reason: "invalid_metadata" };

  if (photo.recipe.baseVersion !== null) {
    if (!photo.media || typeof photo.media !== "object") {
      return { state: "unavailable", reason: "invalid_metadata" };
    }
    if (photo.media.state === "pending" || photo.media.state === "queued" || photo.media.state === "processing") {
      return { state: "unavailable", reason: "media_pending" };
    }
    if (photo.media.state !== "ready") {
      return { state: "unavailable", reason: "base_unavailable" };
    }
    if (!photo.media.workingCopy || typeof photo.media.workingCopy !== "object") {
      return { state: "unavailable", reason: "invalid_metadata" };
    }
    return workingCopyInput(photo, photo.media.workingCopy, options);
  }

  if (photo.recipe.settings.base !== null && photo.recipe.settings.base !== undefined) {
    return { state: "unavailable", reason: "invalid_metadata" };
  }
  if (photo.format !== "jpeg" && photo.format !== "png") {
    return photo.media.state === "pending" || photo.media.state === "queued" || photo.media.state === "processing"
      ? { state: "unavailable", reason: "media_pending" }
      : { state: "unavailable", reason: "base_unavailable" };
  }
  const contentType = photo.format === "jpeg" ? "image/jpeg" : "image/png";
  const formatMaxBytes = photo.format === "jpeg" ? JPEG_MAX_BYTES : PNG_MAX_BYTES;
  if (photo.original.contentType !== contentType) {
    return { state: "unavailable", reason: "invalid_metadata" };
  }
  if (photo.original.sizeBytes > Math.min(formatMaxBytes, options.maxBytes)
    || photo.original.width * photo.original.height > Math.min(PHOTO_LIMITS.browserDirectMaxPixels, options.maxPixels)) {
    return { state: "unavailable", reason: "input_limit" };
  }
  const input: CloudRenderInput = {
    kind: "original",
    format: photo.format,
    photoId: photo.id,
    libraryId: photo.libraryId,
    originalSha256: photo.original.sha256,
    originalAssetId: photo.original.id,
    asset: cloneAsset(photo.original),
    exportMaxEdge: Math.max(photo.original.width, photo.original.height),
  };
  return { state: "ready", input: immutable(input) };
}

/** True only for current, bounded preview metadata; working-copy usability is intentionally independent. */
export function isCurrentCloudPreview(photo: Photo, rendererManifestSha256: Sha256): boolean {
  try {
    if (!SHA256.test(rendererManifestSha256) || photo.storageState !== "stored" || photo.lifecycle !== "active"
      || !photo.media || photo.media.state !== "ready"
      || photo.media.recipeRevision !== photo.recipe.revision
      || photo.media.rendererManifestSha256 !== rendererManifestSha256) return false;
    return validAsset(photo.media.thumbnail, "thumbnail", ["image/png", "image/jpeg"], 2 * 1024 ** 2, PHOTO_LIMITS.thumbnailMaxEdge)
      && validAsset(photo.media.preview, "preview", ["image/png", "image/jpeg"], 8 * 1024 ** 2, PHOTO_LIMITS.previewMaxEdge);
  } catch {
    return false;
  }
}
