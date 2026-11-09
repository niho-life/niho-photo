/**
 * Render jobs on a signed-in browser (B07 #248): the user's own photos added to shared albums (owner photos and
 * member edits) are rendered here from the original in the user's NIHO cloud library, with the same pinned engine the
 * editor uses, and committed through the BFF's render-job routes.
 *
 * - Woken, never polling: when photos were added, an album with this device's preparing photos was opened, a correction
 *   reached the cloud (the server then queues the replacement), or the connection started. A wake while draining runs
 *   one more drain afterwards, so nothing queued meanwhile is missed.
 * - Photos on screen are named in the claims and started first (`prioritize`).
 * - The engine is created for a drain and released when the device has nothing left, so an idle tab holds no worker.
 * - Everything stops with the scope (sign-out, another user, page close); a job in flight is interrupted and its lease
 *   expires, so the server hands it to the next drain.
 */
import type { DevelopEngine } from "niho-photo-editing/develop-engine/develop-engine-client";

import type { PersonalPhotoCloudIdentity, PersonalPhotoCloudLibraryHandle } from "../types";

import type { RenderCapability } from "./contract";
import { createDevelopEngineDeviceRenderer } from "./engine-renderer";
import { createPersonalCloudRenderSource } from "./personal-cloud-source";
import { createBrowserRenderJobClient } from "./render-client";
import { createSourceDeviceRenderExecutor, type SourceDeviceRenderExecutor } from "./render-executor";
import { SourceDeviceRenderFailure } from "./render-output";
import { createTicketUploader } from "./ticket-upload";

type RunnerEngine = Pick<DevelopEngine, "ready" | "exportJpeg" | "exportWorkingCopyJpeg" | "withCaptureExif" | "dispose">;

export interface CreateBrowserRenderJobRunnerOptions {
  /** The verified session; render jobs are this user's own device's only. */
  readonly identity: PersonalPhotoCloudIdentity;
  readonly userId: string;
  /** Same-origin BFF fetch (render-job routes). */
  readonly fetch?: typeof fetch;
  /** Provider fetch for the output upload (default: global fetch). */
  readonly providerFetch?: typeof fetch;
  /** The user's NIHO cloud library the originals are read from. */
  readonly libraryId: string;
  readonly handle: Pick<PersonalPhotoCloudLibraryHandle, "rawPhoto" | "readAsset">;
  readonly loadMaskSurface?: (photoId: string, surfaceId: string) => Promise<Uint8Array | null>;
  /** The probed renderer this bundle pins (jobs bound to another manifest are reported, never rendered). */
  readonly capability: RenderCapability;
  /** Creates the pinned engine when there is work. */
  readonly createEngine: () => RunnerEngine;
  /** Stops everything when aborted (the connection's scope). */
  readonly scopeSignal: AbortSignal;
  readonly now?: () => number;
  /** For tests: replaces the executor built from the pieces above. */
  readonly createExecutor?: typeof createSourceDeviceRenderExecutor;
}

export interface BrowserRenderJobRunner {
  /** New jobs may be waiting for this device. */
  wake(): void;
  /** This device's own photos on screen: claimed and started first. */
  prioritize(photos: readonly { readonly libraryId: string; readonly photoId: string }[]): void;
  /** Resolves when no drain is running (tests and orderly shutdown). */
  idle(): Promise<void>;
  dispose(): void;
}

export function createBrowserRenderJobRunner(options: CreateBrowserRenderJobRunnerOptions): BrowserRenderJobRunner {
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
    try {
      current?.dispose();
    } catch {
      // The worker is gone either way.
    }
  };
  // The renderer asks for the engine only when a job is actually rendered.
  const lazyEngine: Pick<DevelopEngine, "exportJpeg" | "exportWorkingCopyJpeg" | "withCaptureExif"> = {
    exportJpeg: async (...parameters) => await (await openEngine()).exportJpeg(...parameters),
    exportWorkingCopyJpeg: async (...parameters) => await (await openEngine()).exportWorkingCopyJpeg(...parameters),
    withCaptureExif: async (...parameters) => await (await openEngine()).withCaptureExif(...parameters),
  };

  const client = createBrowserRenderJobClient({
    identity: options.identity,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const executor: SourceDeviceRenderExecutor = (options.createExecutor ?? createSourceDeviceRenderExecutor)({
    transport: client,
    executor: { kind: "userDevice", userId: options.userId },
    renderer: createDevelopEngineDeviceRenderer({ engine: lazyEngine, capability: options.capability }),
    sources: createPersonalCloudRenderSource({
      libraryId: options.libraryId,
      handle: options.handle,
      ...(options.loadMaskSurface ? { loadMaskSurface: options.loadMaskSurface } : {}),
    }),
    uploader: createTicketUploader(options.providerFetch ? { fetch: options.providerFetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  let draining: Promise<void> | null = null;
  let again = false;
  let disposed = false;

  const runner: BrowserRenderJobRunner = {
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
            try {
              await executor.drain(lifetime.signal);
            } catch {
              // A lost connection or a stopped scope: the server keeps the jobs; the next wake drains again.
            }
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
