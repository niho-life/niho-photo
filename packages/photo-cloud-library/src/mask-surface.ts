import { PHOTO_LIMITS, type PersonalPhotoCloudClient, type PhotoAsset } from "@niho/photo-personal-cloud-contract";
import { sha256 } from "@noble/hashes/sha2.js";

import { contentBytes } from "./content";
import { PersonalPhotoCloudError, readPhotoError } from "./errors";
import { validateAsset } from "./validation";

export async function readVerifiedMaskSurface(
  client: PersonalPhotoCloudClient,
  photoId: string,
  surfaceId: string,
  signal: AbortSignal,
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
  const bytes = await contentBytes(content);
  if (content.sha256 !== surfaceId || maskPngDimensions(bytes, asset, surfaceId) === null) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  return { asset, bytes };
}

export function hashMaskSurface(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sameMaskSurfaceBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

export function maskPngDimensions(
  bytes: Uint8Array,
  asset?: PhotoAsset,
  expectedSurfaceId?: string,
): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  if (bytes.byteLength < 41 || bytes.byteLength > PHOTO_LIMITS.maxMaskBytes ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    readUint32(bytes, 8, false) !== 13 ||
    bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82 ||
    bytes[24] !== 8 || bytes[25] !== 0 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1 ||
    crc32(bytes.subarray(12, 29)) !== readUint32(bytes, 29, false)) return null;
  const width = readUint32(bytes, 16, false);
  const height = readUint32(bytes, 20, false);
  if (width === null || height === null || width === 0 || height === 0 ||
    width > PHOTO_LIMITS.maxMaskEdge || height > PHOTO_LIMITS.maxMaskEdge) return null;
  if (asset !== undefined && (asset.kind !== "mask" || asset.contentType !== "image/png" ||
    asset.sizeBytes !== bytes.byteLength || asset.width !== width || asset.height !== height)) return null;
  if (expectedSurfaceId !== undefined && hashMaskSurface(bytes) !== expectedSurfaceId) return null;
  for (let offset = 33; offset + 8 <= bytes.byteLength;) {
    const length = readUint32(bytes, offset, false);
    if (length === null || offset + 12 + length > bytes.byteLength) return null;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (type === "IDAT") return { width, height };
    if (type === "IEND" || type === "PLTE" || type === "tRNS" || type === "acTL") return null;
    offset += 12 + length;
  }
  return null;
}

function readUint32(bytes: Uint8Array, offset: number, positive = true): number | null {
  const value = bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
  return Number.isSafeInteger(value) && (!positive || value > 0) ? value : null;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
  }
  return (~crc) >>> 0;
}
