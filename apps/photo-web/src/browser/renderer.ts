import { createDevelopEngine, type DevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";
import type { PhotoLibraryEngineAssets } from "niho-photo-editing/library/photo-library";
import type { RenderCapability } from "../../../../packages/photo-library-contract/src/v2.ts";

/** Structural C00 projection of the shared getter; absent on legacy runtimes. */
type RendererDeclaration = Omit<RenderCapability, "sdkVersion" | "manifestSha256"> & { readonly schemaVersion: 1 };
type ProbeEngine = Pick<DevelopEngine, "ready" | "dispose"> & {
  readonly renderCapabilities?: () => Promise<RendererDeclaration | null>;
};
type MaskSurfaceEngine = Pick<DevelopEngine, "ready" | "dispose"> & {
  readonly validateMaskSurface?: DevelopEngine["validateMaskSurface"];
};
export interface PhotoWebRendererProof {
  readonly sdkVersion: string;
  readonly crateVersion: string;
  readonly sourceCommit: string;
  readonly manifestSha256: string;
  readonly manifestUrl: string;
}
export interface PhotoWebRendererBinding {
  readonly capability: RenderCapability;
  readonly engineAssets: PhotoLibraryEngineAssets;
}
export type PhotoWebMaskSurfaceValidator = {
  readonly validateMaskSurface: NonNullable<DevelopEngine["validateMaskSurface"]>;
  dispose(): void;
};

function pinnedManifestUrl(proof: PhotoWebRendererProof): string | null {
  const { sdkVersion, crateVersion, sourceCommit, manifestSha256, manifestUrl } = proof;
  if (typeof sdkVersion !== "string" || sdkVersion.length === 0 || sdkVersion.length > 64
    || typeof crateVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(crateVersion)
    || typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit)
    || typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifestSha256)
    || typeof manifestUrl !== "string") return null;
  const origin = globalThis.location?.origin;
  if (typeof origin !== "string" || origin.length === 0) return null;
  let url: URL;
  try { url = new URL(manifestUrl, origin); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || url.pathname !== `/develop-engine/${manifestSha256}/manifest-${crateVersion}.json`) return null;
  return url.href;
}

async function readMatchingCapability(
  engine: ProbeEngine,
  proof: PhotoWebRendererProof,
  signal: AbortSignal,
): Promise<RendererDeclaration | null> {
  const readCapabilities = engine.renderCapabilities;
  if (signal.aborted || typeof readCapabilities !== "function") return null;
  if (!(await engine.ready()) || signal.aborted) return null;
  const actual = await readCapabilities.call(engine);
  return signal.aborted || !actual || actual.schemaVersion !== 1 || actual.crateVersion !== proof.crateVersion
    ? null
    : actual;
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
    const { sdkVersion, crateVersion, manifestSha256 } = options.proof;
    const pinnedUrl = pinnedManifestUrl(options.proof);
    if (pinnedUrl === null) return null;
    engine = (options.createEngine ?? createProbeEngine)(pinnedUrl);
    // The shared getter validates the running WASM declaration. C02 alone computes the server/host intersection.
    const actual = await readMatchingCapability(engine, options.proof, signal);
    if (actual === null) return null;
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

/** Creates a scope-owned validator from the same pinned SDK/WASM used by the renderer proof. */
export async function createPhotoWebMaskSurfaceValidator(options: {
  readonly engineAssets: PhotoLibraryEngineAssets;
  readonly signal: AbortSignal;
  readonly createEngine?: (manifestUrl: string) => MaskSurfaceEngine;
}): Promise<PhotoWebMaskSurfaceValidator | null> {
  const { signal, engineAssets } = options;
  if (signal.aborted) return null;

  let manifestUrl: string;
  let engine: MaskSurfaceEngine;
  try {
    const pinnedManifestUrl = engineAssets.manifestUrl();
    if (pinnedManifestUrl === null || pinnedManifestUrl.length === 0) return null;
    manifestUrl = pinnedManifestUrl;
    engine = (options.createEngine ?? createMaskSurfaceEngine)(manifestUrl);
  } catch {
    return null;
  }

  const validate = engine.validateMaskSurface;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", onAbort);
    try { engine.dispose(); } catch { /* Keep the capability closed when release fails. */ }
  };
  const onAbort = (): void => dispose();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (typeof validate !== "function" || !(await engine.ready()) || signal.aborted) {
      dispose();
      return null;
    }
  } catch {
    dispose();
    return null;
  }

  return Object.freeze({
    async validateMaskSurface(png: Uint8Array, operationSignal = signal) {
      if (disposed || signal.aborted || operationSignal.aborted) {
        throw operationSignal.reason ?? signal.reason ?? new Error("Photo Web scope changed");
      }
      const result = await validate.call(engine, png);
      if (disposed || signal.aborted || operationSignal.aborted) {
        throw operationSignal.reason ?? signal.reason ?? new Error("Photo Web scope changed");
      }
      return result;
    },
    dispose,
  });
}

function createProbeEngine(manifestUrl: string): ProbeEngine {
  return createDevelopEngine({ manifestUrl, preferNative: false });
}

function createMaskSurfaceEngine(manifestUrl: string): MaskSurfaceEngine {
  return createDevelopEngine({ manifestUrl, preferNative: false });
}
