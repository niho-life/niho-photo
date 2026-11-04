import type { RenderCapability } from "@niho/photo-personal-cloud-contract";
import { createDevelopEngine, type DevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";
import type { PhotoLibraryEngineAssets } from "niho-photo-editing/library/photo-library";

import type { PhotoCloudBuildProof } from "./cloud-build-proof";

type RendererDeclaration = Omit<RenderCapability, "sdkVersion" | "manifestSha256"> & { readonly schemaVersion: 1 };
type ProbeEngine = Pick<DevelopEngine, "ready" | "dispose"> & {
  readonly renderCapabilities?: () => Promise<RendererDeclaration | null>;
};

export type CameraPhotoRendererBinding = Readonly<{
  capability: RenderCapability;
  engineAssets: PhotoLibraryEngineAssets;
}>;

export function cameraPhotoManifestUrl(proof: PhotoCloudBuildProof, location: Pick<Location, "href"> = globalThis.location): string | null {
  try {
    const base = new URL(location.href);
    const trustedHost = (base.protocol === "http:" && base.hostname === "tauri.localhost" && base.port === "")
      || (base.protocol === "tauri:" && base.hostname === "localhost" && base.port === "");
    if (!trustedHost || base.username || base.password) return null;
    const path = `/develop-engine/${proof.manifestSha256}/manifest-${proof.crateVersion}.json`;
    const url = new URL(path, base);
    return url.protocol === base.protocol && url.host === base.host && url.pathname === path
      && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch {
    return null;
  }
}

/** Publishes only a capability declared by the actual bundled runtime, after its probe is disposed. */
export async function probeCameraPhotoRenderer(options: {
  proof: PhotoCloudBuildProof;
  signal: AbortSignal;
  location?: Pick<Location, "href">;
  createEngine?: (manifestUrl: string) => ProbeEngine;
}): Promise<CameraPhotoRendererBinding | null> {
  const manifestUrl = cameraPhotoManifestUrl(options.proof, options.location);
  if (manifestUrl === null || options.signal.aborted) return null;
  let engine: ProbeEngine | null = null;
  let disposed = false;
  let disposalFailed = false;
  const dispose = () => {
    if (engine === null || disposed) return;
    try { engine.dispose(); disposed = true; } catch { disposalFailed = true; }
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  let result: CameraPhotoRendererBinding | null = null;
  try {
    engine = (options.createEngine ?? ((url) => createDevelopEngine({ manifestUrl: url, preferNative: false })))(manifestUrl);
    if (typeof engine.renderCapabilities !== "function" || !(await engine.ready()) || options.signal.aborted) return null;
    const actual = await engine.renderCapabilities();
    if (!actual || actual.schemaVersion !== 1 || actual.crateVersion !== options.proof.crateVersion || options.signal.aborted) return null;
    result = Object.freeze({
      capability: Object.freeze({
        sdkVersion: options.proof.sdkVersion,
        crateVersion: options.proof.crateVersion,
        manifestSha256: options.proof.manifestSha256,
        settingsVersions: Object.freeze([...actual.settingsVersions]),
        engines: Object.freeze([...actual.engines]),
        features: Object.freeze([...actual.features]),
        maskKinds: Object.freeze([...actual.maskKinds]),
        maskSurfaces: actual.maskSurfaces,
      }),
      engineAssets: Object.freeze({ manifestUrl: () => manifestUrl, preferNative: false }),
    });
  } catch {
    result = null;
  } finally {
    options.signal.removeEventListener("abort", dispose);
    dispose();
  }
  return options.signal.aborted || !disposed || disposalFailed ? null : result;
}
