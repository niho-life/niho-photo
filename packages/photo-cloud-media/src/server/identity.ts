import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PHOTO_LIMITS } from "../../../photo-library-contract/src/v2.ts";
import type { PhotoAsset, Sha256 } from "../../../photo-library-contract/src/v2.ts";
import type { CloudRenderInput, ValidatedMediaRecipe } from "../types.ts";
import { isBoundedWorkingCopyMeta } from "../index.ts";
import type { MediaIdentity, MediaSource } from "./types.ts";
import { sha256 } from "./runtime.ts";

const HASH = /^[a-f0-9]{64}$/;
const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const validAsset = (asset: unknown): asset is PhotoAsset => !!asset && typeof asset === "object" && !Array.isArray(asset)
  && bounded((asset as PhotoAsset).id) && HASH.test((asset as PhotoAsset).sha256)
  && bounded((asset as PhotoAsset).contentType) && (asset as PhotoAsset).contentType.length <= 128
  && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test((asset as PhotoAsset).contentType)
  && Number.isSafeInteger((asset as PhotoAsset).sizeBytes) && (asset as PhotoAsset).sizeBytes > 0
  && (asset as PhotoAsset).sizeBytes <= PHOTO_LIMITS.maxFileBytes
  && Number.isSafeInteger((asset as PhotoAsset).width) && Number.isSafeInteger((asset as PhotoAsset).height)
  && (asset as PhotoAsset).width > 0 && (asset as PhotoAsset).height > 0
  && (asset as PhotoAsset).width * (asset as PhotoAsset).height <= PHOTO_LIMITS.maxPixels;
const exactAsset = (left: PhotoAsset, right: PhotoAsset): boolean => isDeepStrictEqual(assetTuple(left), assetTuple(right));

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) immutable(child, seen);
    Object.freeze(value);
  }
  return value;
}

const assetTuple = (asset: PhotoAsset): readonly unknown[] => [
  asset.id, asset.kind, asset.sha256, asset.sizeBytes, asset.contentType, asset.width, asset.height,
];

function assertIdentity(identity: MediaIdentity): void {
  try {
    const masks = Array.isArray(identity.maskSurfaceIds) ? [...identity.maskSurfaceIds] : [];
    const validFormat = ["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(identity.format);
    const direct = identity.encoding === "original";
    if (identity.version !== 1 || !bounded(identity.ownerId) || !bounded(identity.libraryId) || !bounded(identity.photoId)
      || !bounded(identity.originalGeneration) || !Number.isSafeInteger(identity.lifecycleGeneration)
      || identity.lifecycleGeneration < 0 || !validFormat || !validAsset(identity.original)
      || identity.original.kind !== "original" || !validAsset(identity.inputAsset)
      || !Number.isSafeInteger(identity.width) || !Number.isSafeInteger(identity.height)
      || identity.width < 1 || identity.height < 1
      || identity.original.width !== identity.width || identity.original.height !== identity.height
      || !Number.isSafeInteger(identity.recipeRevision) || identity.recipeRevision < 0
      || !HASH.test(identity.settingsSha256) || !HASH.test(identity.rendererManifestSha256)
      || masks.length !== identity.maskSurfaceIds.length || masks.some((id) => !HASH.test(id))
      || new Set(masks).size !== masks.length || !isDeepStrictEqual(masks, [...masks].sort())
      || identity.outputPolicy.thumbnailMaxEdge !== PHOTO_LIMITS.thumbnailMaxEdge
      || identity.outputPolicy.previewMaxEdge !== PHOTO_LIMITS.previewMaxEdge
      || (direct && (identity.baseVersion !== null || identity.workingCopyMetaSha256 !== null
        || (identity.format !== "jpeg" && identity.format !== "png") || !exactAsset(identity.inputAsset, identity.original)
        || identity.inputAsset.kind !== "original"
        || identity.inputAsset.contentType !== (identity.format === "jpeg" ? "image/jpeg" : "image/png")))
      || (!direct && ((identity.encoding !== "png16" && identity.encoding !== "jpeg8")
        || !bounded(identity.baseVersion) || !HASH.test(identity.workingCopyMetaSha256 ?? "")
        || identity.inputAsset.kind !== "working-copy"
        || identity.inputAsset.contentType !== (identity.encoding === "png16" ? "image/png" : "image/jpeg")
        || Math.max(identity.inputAsset.width, identity.inputAsset.height) > PHOTO_LIMITS.workingCopyMaxEdge))) {
      throw new Error();
    }
  } catch {
    throw new TypeError("photo-cloud-media: invalid identity");
  }
}

export function createMediaIdentity(
  source: MediaSource,
  input: CloudRenderInput,
  recipe: ValidatedMediaRecipe,
  rendererManifestSha256: Sha256,
): MediaIdentity {
  const photo = source.photo;
  if (!Array.isArray(photo.recipe.maskSurfaceIds) || !Array.isArray(recipe.maskSurfaceIds)
    || typeof recipe.canonicalSettings !== "string") throw new TypeError("photo-cloud-media: invalid identity");
  const expectedMasks = [...photo.recipe.maskSurfaceIds].sort();
  const actualMasks = [...recipe.maskSurfaceIds].sort();
  let canonicalSettings: unknown;
  try { canonicalSettings = JSON.parse(recipe.canonicalSettings); } catch { throw new TypeError("photo-cloud-media: invalid identity"); }
  if (!canonicalSettings || typeof canonicalSettings !== "object" || Array.isArray(canonicalSettings)) {
    throw new TypeError("photo-cloud-media: invalid identity");
  }
  const settingsRecord = canonicalSettings as Record<string, unknown>;
  if (!bounded(source.ownerId) || !bounded(source.originalGeneration) || !bounded(photo.id) || !bounded(photo.libraryId)
    || !Number.isSafeInteger(source.lifecycleGeneration)
    || source.lifecycleGeneration < 0 || !HASH.test(rendererManifestSha256) || !HASH.test(recipe.settingsSha256)
    || photo.storageState !== "stored" || photo.lifecycle !== "active"
    || !["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(photo.format)
    || !validAsset(photo.original) || photo.original.kind !== "original" || !validAsset(input.asset)
    || photo.original.width !== photo.width || photo.original.height !== photo.height
    || !Number.isSafeInteger(photo.recipe.revision) || photo.recipe.revision < 0
    || sha256(recipe.canonicalSettings) !== recipe.settingsSha256 || !isDeepStrictEqual(canonicalSettings, photo.recipe.settings)
    || recipe.settingsSha256 !== photo.recipe.settingsSha256 || recipe.baseVersion !== photo.recipe.baseVersion
    || actualMasks.some((id) => !HASH.test(id)) || expectedMasks.some((id) => !HASH.test(id))
    || !isDeepStrictEqual(actualMasks, expectedMasks) || new Set(actualMasks).size !== actualMasks.length
    || (input.kind !== "original" && input.kind !== "workingCopy")
    || input.photoId !== photo.id || input.libraryId !== photo.libraryId
    || input.originalAssetId !== photo.original.id || input.originalSha256 !== photo.original.sha256
    || input.exportMaxEdge !== Math.max(input.asset.width, input.asset.height)
    || (input.kind === "original" && (!exactAsset(input.asset, photo.original) || recipe.baseVersion !== null
      || input.format !== photo.format || (input.format !== "jpeg" && input.format !== "png")
      || input.asset.kind !== "original"
      || input.asset.contentType !== (input.format === "jpeg" ? "image/jpeg" : "image/png")
      || settingsRecord.base !== null))
    || (input.kind === "workingCopy" && (photo.media.state !== "ready" || photo.media.workingCopy === null
      || input.asset.kind !== "working-copy" || Math.max(input.asset.width, input.asset.height) > PHOTO_LIMITS.workingCopyMaxEdge
      || (input.encoding !== "png16" && input.encoding !== "jpeg8")
      || input.asset.contentType !== (input.encoding === "png16" ? "image/png" : "image/jpeg")
      || (photo.media.workingCopy.encoding !== "png16" && photo.media.workingCopy.encoding !== "jpeg8")
      || !exactAsset(input.asset, photo.media.workingCopy.asset) || input.baseVersion !== photo.media.workingCopy.baseVersion
      || input.baseVersion !== recipe.baseVersion || settingsRecord.base !== input.baseVersion
      || input.encoding !== photo.media.workingCopy.encoding || !isBoundedWorkingCopyMeta(input.meta)
      || !isDeepStrictEqual(input.meta, photo.media.workingCopy.meta)))) {
    throw new TypeError("photo-cloud-media: invalid identity");
  }
  const maskSurfaceIds = [...recipe.maskSurfaceIds].sort();
  const workingCopyMetaSha256 = input.kind === "workingCopy"
    ? sha256(JSON.stringify(input.meta)) as Sha256
    : null;
  const identity: MediaIdentity = {
    version: 1,
    ownerId: source.ownerId,
    libraryId: photo.libraryId,
    photoId: photo.id,
    lifecycleGeneration: source.lifecycleGeneration,
    originalGeneration: source.originalGeneration,
    original: { ...photo.original },
    format: photo.format,
    width: photo.width,
    height: photo.height,
    inputAsset: { ...input.asset },
    baseVersion: input.kind === "workingCopy" ? input.baseVersion : null,
    encoding: input.kind === "workingCopy" ? input.encoding : "original",
    workingCopyMetaSha256,
    recipeRevision: photo.recipe.revision,
    settingsSha256: recipe.settingsSha256,
    maskSurfaceIds,
    rendererManifestSha256,
    outputPolicy: {
      thumbnailMaxEdge: PHOTO_LIMITS.thumbnailMaxEdge,
      previewMaxEdge: PHOTO_LIMITS.previewMaxEdge,
    },
  };
  return immutable(identity);
}

/** Hash an explicitly ordered identity tuple; this is not a generic JSON canonicalizer. */
export function mediaIdentityKey(identity: MediaIdentity): Sha256 {
  assertIdentity(identity);
  const tuple = [
    identity.version,
    identity.ownerId,
    identity.libraryId,
    identity.photoId,
    identity.lifecycleGeneration,
    identity.originalGeneration,
    assetTuple(identity.original),
    identity.format,
    identity.width,
    identity.height,
    assetTuple(identity.inputAsset),
    identity.baseVersion,
    identity.encoding,
    identity.workingCopyMetaSha256,
    identity.recipeRevision,
    identity.settingsSha256,
    [...identity.maskSurfaceIds],
    identity.rendererManifestSha256,
    identity.outputPolicy.thumbnailMaxEdge,
    identity.outputPolicy.previewMaxEdge,
  ];
  return sha256(JSON.stringify(tuple)) as Sha256;
}

export function matchesMediaSource(
  identity: MediaIdentity,
  source: MediaSource | null,
  input: CloudRenderInput,
  recipe: ValidatedMediaRecipe,
): source is MediaSource {
  if (!source) return false;
  try {
    const current = mediaIdentityKey(createMediaIdentity(source, input, recipe, identity.rendererManifestSha256));
    const expected = mediaIdentityKey(identity);
    return timingSafeEqual(Buffer.from(current, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
