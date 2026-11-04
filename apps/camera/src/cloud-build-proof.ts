/** Public identity of the verified SDK selected by the official candidate builder. */
export interface PhotoCloudBuildProof {
  readonly sdkVersion: string;
  readonly crateVersion: string;
  readonly manifestSha256: string;
  readonly sdkSourceCommit: string;
}

declare const __NIHO_PHOTO_CLOUD_BUILD_PROOF__: PhotoCloudBuildProof | null;

const KEYS = ["crateVersion", "manifestSha256", "sdkSourceCommit", "sdkVersion"];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

/** Invalid or absent declarations keep cloud closed; local editing needs no proof. */
export function parsePhotoCloudBuildProof(value: unknown): PhotoCloudBuildProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== KEYS.join("\0")) return null;
  const proof = value as Record<string, unknown>;
  if (typeof proof.sdkVersion !== "string" || proof.sdkVersion.length > 64 || !VERSION.test(proof.sdkVersion)
    || typeof proof.crateVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(proof.crateVersion)
    || typeof proof.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(proof.manifestSha256)
    || typeof proof.sdkSourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(proof.sdkSourceCommit)) return null;
  return Object.freeze({ sdkVersion: proof.sdkVersion, crateVersion: proof.crateVersion,
    manifestSha256: proof.manifestSha256, sdkSourceCommit: proof.sdkSourceCommit });
}

/** A compile-time constant, never a mutable server response or account metadata. */
export function readPhotoCloudBuildProof(): PhotoCloudBuildProof | null {
  return typeof __NIHO_PHOTO_CLOUD_BUILD_PROOF__ === "undefined"
    ? null : parsePhotoCloudBuildProof(__NIHO_PHOTO_CLOUD_BUILD_PROOF__);
}
