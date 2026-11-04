import { PHOTO_LIMITS, type PersonalPhotoCloudClient, type PhotoAsset } from "@niho/photo-personal-cloud-contract";
import { sha256 } from "@noble/hashes/sha2.js";

import { abortReason, awaitBounded } from "./await";
import { contentBytes } from "./content";
import { PersonalPhotoCloudError, readPhotoError } from "./errors";
import type { PersonalPhotoCloudMaskValidator } from "./types";
import { validateAsset } from "./validation";

export async function readVerifiedMaskSurface(
  client: PersonalPhotoCloudClient,
  photoId: string,
  surfaceId: string,
  signal: AbortSignal,
  validator: PersonalPhotoCloudMaskValidator,
): Promise<{ readonly asset: PhotoAsset; readonly bytes: Uint8Array<ArrayBuffer> } | null> {
  let asset: PhotoAsset;
  try {
    asset = validateAsset(await client.request("masks.get", { photoId, surfaceId }, { signal }), "mask");
  } catch (error) {
    if (readPhotoError(error)?.code === "not_found") return null;
    throw error;
  }
  if (asset.sha256 !== surfaceId || asset.contentType !== "image/png" || asset.sizeBytes > PHOTO_LIMITS.maxMaskBytes) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  const content = await client.request("content.get", { photoId, assetId: asset.id }, { signal });
  if (content.sha256 !== surfaceId || content.contentType !== asset.contentType ||
    content.totalBytes !== asset.sizeBytes || content.range.start !== 0 || content.range.endInclusive !== asset.sizeBytes - 1) {
    await content.body.cancel().catch(() => undefined);
    throw new PersonalPhotoCloudError("invalid_response");
  }
  const bytes = await contentBytes(content);
  if (content.sha256 !== surfaceId ||
    await validateMaskSurfaceBytes(bytes, surfaceId, validator, signal, asset) === null) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  return { asset, bytes };
}

/** Verify cloud bytes with the host's actual SDK decoder, without transferring ownership of caller bytes. */
export async function validateMaskSurfaceBytes(
  bytes: Uint8Array,
  expectedSurfaceId: string,
  validator: PersonalPhotoCloudMaskValidator,
  signal: AbortSignal,
  asset?: PhotoAsset,
): Promise<{ readonly width: number; readonly height: number } | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > PHOTO_LIMITS.maxMaskBytes ||
    !/^[0-9a-f]{64}$/u.test(expectedSurfaceId) || hashMaskSurface(bytes) !== expectedSurfaceId) return null;
  if (signal.aborted) throw abortReason(signal);
  let decoded: { readonly id: string; readonly width: number; readonly height: number };
  try {
    decoded = await awaitBounded(validator.validateMaskSurface(bytes.slice(), signal), { signal, timeoutMs: 15_000 });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof PersonalPhotoCloudError && ["unsupported", "unavailable"].includes(error.code)) throw error;
    return null;
  }
  if (signal.aborted) throw abortReason(signal);
  if (typeof decoded !== "object" || decoded === null || decoded.id !== expectedSurfaceId || !Number.isSafeInteger(decoded.width) ||
    !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 ||
    decoded.width > PHOTO_LIMITS.maxMaskEdge || decoded.height > PHOTO_LIMITS.maxMaskEdge ||
    asset !== undefined && (asset.kind !== "mask" || asset.contentType !== "image/png" ||
      asset.sizeBytes !== bytes.byteLength || asset.width !== decoded.width || asset.height !== decoded.height)) return null;
  return { width: decoded.width, height: decoded.height };
}

export function hashMaskSurface(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sameMaskSurfaceBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}
