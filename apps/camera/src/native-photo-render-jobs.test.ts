import { describe, expect, it, vi } from "vitest";
import type { VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import type {
  CreateSourceDeviceRenderExecutorOptions,
  RenderCapability,
  SourceDeviceRenderExecutor,
} from "@niho/photo-cloud-library/render-executor";

import type { NativePhotoBinaryInvoke } from "./native-photo-mask-uploader";
import type { NativePhotoInvoke } from "./native-photo-client";
import { createNativePhotoRenderJobs } from "./native-photo-render-jobs";

const actor: VerifiedPhotoActor = {
  userId: "synthetic-user",
  sessionId: "synthetic-session",
  sessionEpoch: "synthetic-epoch",
  transport: "mac-bearer",
  expiresAt: "2099-11-11T00:00:00.000Z",
};

describe("native Mac render-job runner", () => {
  it("uses the signed-in native route, prioritizes this library, and never opens an idle engine", async () => {
    const identity: PersonalPhotoCloudIdentity = { getSnapshot: () => actor, subscribe: () => () => undefined };
    const request = vi.fn<NativePhotoInvoke>(async (command) => {
      expect(command).toBe("camera_sharing_request");
      return { status: 200, body: { value: { jobs: [] }, replayed: false } };
    });
    const invokeBinary: NativePhotoBinaryInvoke = vi.fn(async () => undefined);
    const createEngine = vi.fn(() => {
      throw new Error("engine must remain lazy while the queue is empty");
    });
    const controller = new AbortController();
    let executorOptions: CreateSourceDeviceRenderExecutorOptions | null = null;
    const executor: SourceDeviceRenderExecutor = {
      async drain(signal) {
        const options = executorOptions;
        if (!options) throw new Error("executor options were not captured");
        await options.transport.request("renderJobs.claim", { maxJobs: 1 }, { signal, idempotencyKey: "native-claim" });
        return { committed: 0, failed: 0, discarded: 0, deferredForQuota: 0, cancelled: 0, interrupted: 0 };
      },
      prioritize: vi.fn(),
      supersede: vi.fn(),
      cancelAlbumItem: vi.fn(),
      dispose: vi.fn(),
    };
    const capability = {
      sdkVersion: "sdk-1", crateVersion: "engine-1", manifestSha256: "a".repeat(64),
      settingsVersions: [1], engines: ["niho-1"], features: [], maskKinds: [], maskSurfaces: false,
    } satisfies RenderCapability;

    const runner = createNativePhotoRenderJobs({
      identity,
      invoke: request,
      invokeBinary,
      userId: actor.userId,
      libraryId: "library-1",
      handle: { rawPhoto: vi.fn(), readAsset: vi.fn() },
      capability,
      createEngine,
      scopeSignal: controller.signal,
      createExecutor(options) {
        executorOptions = options;
        return executor;
      },
    });

    runner.prioritize([
      { libraryId: "library-1", photoId: "visible-photo" },
      { libraryId: "another-library", photoId: "other-photo" },
    ]);
    expect(executor.prioritize).toHaveBeenCalledWith([{ libraryId: "library-1", photoId: "visible-photo" }]);
    runner.wake();
    await runner.idle();
    expect(request).toHaveBeenCalledWith("camera_sharing_request", expect.objectContaining({ input: expect.objectContaining({
      method: "POST",
      path: "/cloud/sharing/v1/render-jobs/claim",
      body: { maxJobs: 1 },
    }) }));
    expect(createEngine).not.toHaveBeenCalled();

    runner.dispose();
    expect(executor.dispose).toHaveBeenCalledOnce();
  });
});
