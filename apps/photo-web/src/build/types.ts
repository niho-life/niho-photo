import type { PhotoStaticAsset, PhotoStaticManifest } from "../pwa/types";

/** Trusted build paths, never deserialized from an HTTP request. */
export interface PreparePhotoStaticBundleOptions {
  readonly builtWebDirectory: string;
  readonly outputDirectory: string;
  readonly sdkPackageDirectory: string;
  /** Shared photo-editing-copy supplies these values; generator HTML-escapes them. */
  readonly offlineCopy: { readonly title: string; readonly message: string };
  readonly applicationCopy: { readonly name: string; readonly shortName: string; readonly description: string };
}
export interface PhotoPublicNotice {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: "text/plain";
  readonly kind: "notice";
}
export interface PhotoStaticBuildResult {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly document: { readonly file: "index.html"; readonly sha256: string; readonly sizeBytes: number; readonly contentType: "text/html" };
  readonly files: readonly (PhotoStaticAsset | PhotoPublicNotice)[];
  readonly pwa: PhotoStaticManifest;
  readonly worker: { readonly path: "/photo-sw.js"; readonly sha256: string; readonly sizeBytes: number; readonly contentType: "application/javascript" };
  readonly webManifest: { readonly path: "/manifest.webmanifest"; readonly sha256: string; readonly sizeBytes: number; readonly contentType: "application/manifest+json" };
  /** Verified asset proof only. Actual browser capability must still be observed at runtime. */
  readonly sdk: { readonly sdkVersion: string; readonly crateVersion: string; readonly sourceCommit: string; readonly manifestSha256: string; readonly manifestUrl: string };
}
export type PhotoStaticBuildErrorCode = "invalid_input" | "invalid_artifact" | "budget_exceeded" | "output_exists" | "io_failure";
