import { describe, expect, it, vi } from "vitest";

import { createMacPhotoCopyNative } from "./native-photo-copy";
import type { MacPhotoCloudScope } from "./personal-cloud-binding";

const scope: MacPhotoCloudScope = {
  actorId: "synthetic-user",
  libraryId: "synthetic-library",
  sessionId: "synthetic-session",
  sessionEpoch: "synthetic-epoch",
  transport: "mac-bearer",
};

describe("native photo copy safe bridge", () => {
  it("sends only the fixed safe scope and opaque IDs", async () => {
    const invoke = vi.fn(async (command: string) => command === "camera_photo_copy_recover"
      ? { requestId: "synthetic-request", photoId: "synthetic-photo" }
      : command === "camera_photo_copy_status"
        ? { requestId: "synthetic-request", photoId: "synthetic-photo", phase: "stored", fraction: 1,
            completed: { original: true, masks: true, recipe: true, cloudPhotoId: "synthetic-cloud-photo" } }
        : null);
    const native = createMacPhotoCopyNative(invoke);
    await expect(native.recover(scope, "synthetic-photo")).resolves.toEqual({ requestId: "synthetic-request", photoId: "synthetic-photo" });
    await native.start(scope, { requestId: "synthetic-request", photoId: "synthetic-photo" });
    await expect(native.status(scope, "synthetic-request")).resolves.toMatchObject({
      phase: "stored", completed: { original: true, masks: true, recipe: true, cloudPhotoId: "synthetic-cloud-photo" },
    });
    await native.cancel(scope, "synthetic-request");
    expect(invoke.mock.calls[0]).toEqual(["camera_photo_copy_recover", { input: {
      scope: { userId: "synthetic-user", libraryId: "synthetic-library", sessionId: "synthetic-session",
        sessionEpoch: "synthetic-epoch", transport: "mac-bearer" },
      photoId: "synthetic-photo",
    } }]);
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/token|ticket|authorization|https:|path/i);
  });

  it.each([
    { requestId: "r", photoId: "p", phase: "stored", fraction: 1 },
    { requestId: "r", photoId: "p", phase: "copying", fraction: 2 },
    { requestId: "r", photoId: "p", phase: "copying", fraction: null, path: "/private/source" },
    { requestId: "r", photoId: "p", phase: "stored", fraction: 1,
      completed: { original: true, masks: false, recipe: true, cloudPhotoId: "cloud" } },
  ])("rejects incomplete or expanded native status %#", async (value) => {
    const native = createMacPhotoCopyNative(async command => command === "camera_photo_copy_status" ? value : null);
    await expect(native.status(scope, "request")).rejects.toThrow("invalid native copy response");
  });

  it("keeps a disabled native authority out of the existing binding", async () => {
    const { createMacPersonalCloudPhotoBinding } = await import("./personal-cloud-binding");
    const connection = createMacPersonalCloudPhotoBinding({
      scope, currentScope: () => scope, subscribeScopeChange: () => () => undefined,
      library: { place: "cloud" } as never, host: {} as never,
    });
    expect(connection.binding?.copyLocalPhoto).toBeUndefined();
    connection.dispose();
  });
});
