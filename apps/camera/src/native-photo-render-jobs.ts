import type { DevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";
import type { PersonalPhotoCloudIdentity, PersonalPhotoCloudLibraryHandle } from "@niho/photo-cloud-library";
import {
  createDevelopEngineDeviceRenderer,
  createPersonalCloudRenderSource,
  createRenderJobClientOnTransport,
  createSourceDeviceRenderExecutor,
  SourceDeviceRenderFailure,
  type RenderCapability,
  type SourceDeviceRenderExecutor,
} from "@niho/photo-cloud-library/render-executor";
import type { SharedAlbumRenderJobsHook } from "@niho/photo-cloud-library/sharing";

import {
  createNativeSharingTransport,
  createNativeSharingUploader,
} from "./native-photo-sharing";
import type { NativePhotoInvoke } from "./native-photo-client";
import type { NativePhotoBinaryInvoke } from "./native-photo-mask-uploader";

type RunnerEngine = Pick<
  DevelopEngine,
  "ready" | "exportJpeg" | "exportWorkingCopyJpeg" | "withCaptureExif" | "dispose"
>;

export type NativePhotoRenderJobs = SharedAlbumRenderJobsHook & Readonly<{
  idle(): Promise<void>;
  dispose(): void;
}>;

export type CreateNativePhotoRenderJobsOptions = Readonly<{
  identity: PersonalPhotoCloudIdentity;
  invoke: NativePhotoInvoke;
  invokeBinary: NativePhotoBinaryInvoke;
  userId: string;
  libraryId: string;
  handle: Pick<PersonalPhotoCloudLibraryHandle, "rawPhoto" | "readAsset">;
  loadMaskSurface?: (photoId: string, surfaceId: string) => Promise<Uint8Array | null>;
  capability: RenderCapability;
  createEngine: () => RunnerEngine;
  scopeSignal: AbortSignal;
  now?: () => number;
  createExecutor?: typeof createSourceDeviceRenderExecutor;
}>;

/** Runs this Mac user's own shared-album photos through the app's pinned renderer and native session. */
export function createNativePhotoRenderJobs(options: CreateNativePhotoRenderJobsOptions): NativePhotoRenderJobs {
  const lifetime = new AbortController();
  const stop = (): void => lifetime.abort(options.scopeSignal.reason);
  if (options.scopeSignal.aborted) stop();
  else options.scopeSignal.addEventListener("abort", stop, { once: true });

  let engine: RunnerEngine | null = null;
  let engineReady: Promise<RunnerEngine> | null = null;
  const openEngine = async (): Promise<RunnerEngine> => {
    if (engineReady === null) {
      const created = options.createEngine();
      engine = created;
      engineReady = created.ready().then((ready) => {
        if (!ready) throw new SourceDeviceRenderFailure("renderer_unavailable");
        return created;
      });
    }
    return await engineReady;
  };
  const releaseEngine = (): void => {
    const current = engine;
    engine = null;
    engineReady = null;
    try { current?.dispose(); } catch { /* Best-effort release after drain or scope close. */ }
  };
  const lazyEngine: Pick<DevelopEngine, "exportJpeg" | "exportWorkingCopyJpeg" | "withCaptureExif"> = {
    exportJpeg: async (...parameters) => await (await openEngine()).exportJpeg(...parameters),
    exportWorkingCopyJpeg: async (...parameters) => await (await openEngine()).exportWorkingCopyJpeg(...parameters),
    withCaptureExif: async (...parameters) => await (await openEngine()).withCaptureExif(...parameters),
  };

  const client = createRenderJobClientOnTransport(createNativeSharingTransport({
    identity: options.identity,
    invoke: options.invoke,
    ...(options.now === undefined ? {} : { now: options.now }),
  }));
  const executor: SourceDeviceRenderExecutor = (options.createExecutor ?? createSourceDeviceRenderExecutor)({
    transport: client,
    executor: { kind: "userDevice", userId: options.userId },
    renderer: createDevelopEngineDeviceRenderer({ engine: lazyEngine, capability: options.capability }),
    sources: createPersonalCloudRenderSource({
      libraryId: options.libraryId,
      handle: options.handle,
      ...(options.loadMaskSurface === undefined ? {} : { loadMaskSurface: options.loadMaskSurface }),
    }),
    uploader: createNativeSharingUploader({
      identity: options.identity,
      invokeBinary: options.invokeBinary,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let draining: Promise<void> | null = null;
  let again = false;
  let disposed = false;
  const runner: NativePhotoRenderJobs = {
    wake() {
      if (disposed || lifetime.signal.aborted) return;
      if (draining !== null) {
        again = true;
        return;
      }
      draining = (async () => {
        try {
          do {
            again = false;
            try { await executor.drain(lifetime.signal); } catch { /* The lease expires; a later wake retries. */ }
          } while (again && !disposed && !lifetime.signal.aborted);
        } finally {
          releaseEngine();
          draining = null;
        }
      })();
    },
    prioritize(photos) {
      if (disposed) return;
      executor.prioritize(photos.filter((photo) => photo.libraryId === options.libraryId));
    },
    async idle() {
      while (draining !== null) await draining;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.scopeSignal.removeEventListener("abort", stop);
      lifetime.abort(new Error("render jobs disposed"));
      executor.dispose();
      client.dispose();
      if (draining === null) releaseEngine();
    },
  };
  return runner;
}
