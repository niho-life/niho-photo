import { describe, expect, it, vi } from "vitest";
import type { PhotoLibrary } from "niho-photo-editing/library/photo-library";

import { withNativeOriginalSave } from "./camera-cloud-bootstrap";

const scope = { actorId: "actor", libraryId: "library", sessionId: "session", sessionEpoch: "epoch", transport: "mac-bearer" as const };
const photo = {
  id: "photo", fileName: "original.JPG", sizeBytes: 200 * 1024 * 1024, hasOriginal: true,
  privatePath: "/must-not-cross-ipc/original.JPG",
};

describe("native cloud original Save As", () => {
  it("passes only safe scope and photo metadata and never materializes a Blob", async () => {
    const invoke = vi.fn(async () => ({ saved: true, fileName: "original.JPG" }));
    const library = withNativeOriginalSave({ place: "cloud" } as PhotoLibrary, scope, invoke);
    await expect(library.saveOriginalNative?.(photo)).resolves.toEqual({ saved: true, fileName: "original.JPG" });
    expect(invoke).toHaveBeenCalledWith("camera_photo_original_save", { input: {
      scope: { userId: "actor", sessionId: "session", sessionEpoch: "epoch", transport: "mac-bearer" },
      photo: { id: "photo", fileName: "original.JPG", sizeBytes: 200 * 1024 * 1024, hasOriginal: true },
    } });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/path|token|ticket|url|header|blob/i);
  });

  it("preserves user cancellation and rejects a late native result after the fence aborts", async () => {
    const cancelled = withNativeOriginalSave({ place: "cloud" } as PhotoLibrary, scope, async () => ({ saved: false }));
    await expect(cancelled.saveOriginalNative?.(photo)).resolves.toEqual({ saved: false, fileName: null });
    let finish!: (value: unknown) => void;
    const controller = new AbortController();
    const late = withNativeOriginalSave({ place: "cloud" } as PhotoLibrary, scope, () => new Promise((resolve) => { finish = resolve; }));
    const pending = late.saveOriginalNative?.(photo, { signal: controller.signal });
    controller.abort();
    finish({ saved: true, fileName: "original.JPG" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects path-bearing or malformed native replies", async () => {
    for (const value of [
      { saved: true, fileName: "../original.JPG" },
      { saved: true, fileName: "original.JPG", path: "/synthetic/original.JPG" },
      { saved: false, fileName: "unexpected.JPG" },
    ]) {
      const library = withNativeOriginalSave({ place: "cloud" } as PhotoLibrary, scope, async () => value);
      await expect(library.saveOriginalNative?.(photo)).rejects.toThrow("invalid native save result");
    }
  });
});
