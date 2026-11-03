import { createDevelopEngine, type DevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";
import type { PhotoLibraryEngineAssets } from "niho-photo-editing/library/photo-library";
import type { RenderCapability } from "../../../../packages/photo-library-contract/src/v2.ts";

/** Structural C00 projection of the shared getter; absent on legacy runtimes. */
type RendererDeclaration = Omit<RenderCapability, "sdkVersion" | "manifestSha256"> & { readonly schemaVersion: 1 };
type ProbeEngine = Pick<DevelopEngine, "ready" | "dispose"> & {
  readonly renderCapabilities?: () => Promise<RendererDeclaration | null>;
};
export interface PhotoWebRendererProof {
  readonly sdkVersion: string;
  readonly crateVersion: string;
  readonly manifestSha256: string;
  readonly manifestUrl: string;
}
export interface PhotoWebRendererBinding {
  readonly capability: RenderCapability;
  readonly engineAssets: PhotoLibraryEngineAssets;
}

/** Trusted proof is pinned to this bundle; it must not be fetched from the mutable current build endpoint. */
export async function probePhotoWebRenderer(options: {
  readonly proof: PhotoWebRendererProof;
  readonly signal: AbortSignal;
  readonly createEngine?: typeof createProbeEngine;
}): Promise<PhotoWebRendererBinding | null> {
  const { signal } = options;
  if (signal.aborted) return null;
  let engine: ProbeEngine | undefined;
  let result: PhotoWebRendererBinding | null = null;
  let disposed = false;
  let disposalFailed = false;
  const dispose = (): void => {
    if (!engine || disposed) return;
    try { engine.dispose(); disposed = true; } catch { disposalFailed = true; }
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const { sdkVersion, crateVersion, manifestSha256, manifestUrl } = options.proof;
    if (typeof sdkVersion !== "string" || sdkVersion.length === 0 || sdkVersion.length > 64
      || typeof crateVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(crateVersion)
      || typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifestSha256)
      || typeof manifestUrl !== "string") return null;
    const url = new URL(manifestUrl, globalThis.location.origin);
    if (url.origin !== globalThis.location.origin || url.username || url.password || url.search || url.hash
      || url.pathname !== `/develop-engine/${manifestSha256}/manifest-${crateVersion}.json`) return null;
    const pinnedUrl = url.href;
    engine = (options.createEngine ?? createProbeEngine)(pinnedUrl);
    const readCapabilities = engine.renderCapabilities;
    if (signal.aborted || typeof readCapabilities !== "function") return null;
    if (!(await engine.ready()) || signal.aborted) return null;
    // The shared getter validates the running WASM declaration. C02 alone computes the server/host intersection.
    const actual = await readCapabilities.call(engine);
    if (signal.aborted || !actual || actual.schemaVersion !== 1 || actual.crateVersion !== crateVersion) return null;
    result = Object.freeze({
      capability: Object.freeze({
        sdkVersion, crateVersion, manifestSha256,
        settingsVersions: Object.freeze([...actual.settingsVersions]),
        engines: Object.freeze([...actual.engines]),
        features: Object.freeze([...actual.features]),
        maskKinds: Object.freeze([...actual.maskKinds]),
        maskSurfaces: actual.maskSurfaces,
      }),
      engineAssets: Object.freeze({ manifestUrl: () => pinnedUrl, preferNative: false }),
    });
  } catch {
    result = null;
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
  // No binding is published unless the probe has actually been disposed first.
  return signal.aborted || disposalFailed || !disposed ? null : result;
}

function createProbeEngine(manifestUrl: string): ProbeEngine {
  return createDevelopEngine({ manifestUrl, preferNative: false });
}
