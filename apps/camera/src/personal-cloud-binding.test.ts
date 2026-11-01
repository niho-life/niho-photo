import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalCloudPhotoBinding } from "./App";
import {
  createMacPersonalCloudPhotoBinding,
  type MacPhotoCloudScope,
  type MacPhotoCopyNative,
  type MacPhotoCopyStatus,
} from "./personal-cloud-binding";

const scope: MacPhotoCloudScope = { actorId: "synthetic-user", libraryId: "synthetic-library", sessionEpoch: "session-1" };
const library = { place: "cloud" } as PersonalCloudPhotoBinding["library"];
const host = {} as PersonalCloudPhotoBinding["host"];
const photoId = "opaque-photo";
function stored(requestId: string): MacPhotoCopyStatus {
  return { requestId, photoId, phase: "stored", fraction: 1, completed: {
    original: true, masks: true, recipe: true, cloudPhotoId: "opaque-cloud-photo",
  } };
}
function fixture(overrides: Partial<MacPhotoCopyNative> = {}) {
  let current: MacPhotoCloudScope | null = scope;
  let notify = () => {};
  const native: MacPhotoCopyNative = {
    recover: vi.fn(async () => null), start: vi.fn(async () => {}),
    status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, requestId) => stored(requestId)), cancel: vi.fn(async () => {}), ...overrides,
  };
  const connection = createMacPersonalCloudPhotoBinding({ scope, currentScope: () => current,
    subscribeScopeChange: (listener) => { notify = listener; return () => { notify = () => {}; }; }, native, library, host });
  if (!connection.binding) throw new Error("synthetic setup");
  return { binding: connection.binding, native, dispose: connection.dispose,
    switchScope(next: MacPhotoCloudScope | null) { current = next; notify(); } };
}
const options = (controller = new AbortController()) => ({ signal: controller.signal, onProgress: vi.fn() });
afterEach(() => vi.useRealTimers());

describe("Mac personal cloud binding (synthetic native port only)", () => {
  it("keeps unconfigured production local-only and does no work at construction/login", () => {
    expect(createMacPersonalCloudPhotoBinding(null)).toMatchObject({ state: "not_connected", binding: undefined });
    const { binding, native } = fixture();
    expect(binding.scopeKey).toBe("personal:synthetic-library:synthetic-user");
    expect(native.start).not.toHaveBeenCalled();
    expect(native.recover).not.toHaveBeenCalled();
    expect(native.status).not.toHaveBeenCalled();
  });

  it("starts only the explicitly selected opaque photo then opens only the complete result", async () => {
    let started = false;
    const { binding, native } = fixture({
      status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, id) => started ? stored(id) : null),
      start: vi.fn(async () => { started = true; }),
    });
    await expect(binding.copyLocalPhoto(photoId, options())).resolves.toEqual({ cloudPhotoId: "opaque-cloud-photo" });
    expect(native.start).toHaveBeenCalledWith(scope, { photoId, requestId: expect.any(String) });
    expect(Object.keys(vi.mocked(native.start).mock.calls[0][1]).sort()).toEqual(["photoId", "requestId"]);
  });

  it("reconciles a lost completion with the same journal key across UI remount", async () => {
    const { binding, native } = fixture({ recover: vi.fn(async () => ({ requestId: "durable-request", photoId })) });
    await expect(binding.copyLocalPhoto(photoId, options())).resolves.toEqual({ cloudPhotoId: "opaque-cloud-photo" });
    expect(native.status).toHaveBeenCalledWith(scope, "durable-request");
    expect(native.start).not.toHaveBeenCalled();
  });

  it("retains request identity after an unknown start result, without duplicate start on retry", async () => {
    let journal: string | null = null;
    const { binding, native } = fixture({
      status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, id) => journal ? stored(id) : null),
      start: vi.fn(async (_scope, request) => { journal = request.requestId; throw new Error("synthetic network loss"); }),
    });
    await expect(binding.copyLocalPhoto(photoId, options())).rejects.toThrow();
    await expect(binding.copyLocalPhoto(photoId, options())).resolves.toEqual({ cloudPhotoId: "opaque-cloud-photo" });
    const calls = vi.mocked(native.status).mock.calls;
    expect(calls[0][1]).toBe(calls[1][1]);
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it("rejects deduplicated originals without copied recipe/masks and wrong-photo receipts", async () => {
    const incomplete = fixture({ status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, id) => ({ requestId: id, photoId, phase: "stored", fraction: 1 })) });
    await expect(incomplete.binding.copyLocalPhoto(photoId, options())).rejects.toMatchObject({ code: "incomplete" });
    const wrong = fixture({ status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, id) => ({ ...stored(id), photoId: "another-photo" })) });
    await expect(wrong.binding.copyLocalPhoto(photoId, options())).rejects.toMatchObject({ code: "invalid_result" });
  });

  it("retries a failed transfer with the same key and starts fresh only after confirmed cancellation", async () => {
    for (const phase of ["failed", "cancelled"] as const) {
      let started = false;
      const { binding, native } = fixture({
        recover: vi.fn(async () => ({ requestId: "old-request", photoId })),
        status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, id) => started ? stored(id) : { requestId: id, photoId, phase, fraction: null }),
        start: vi.fn(async () => { started = true; }),
      });
      await expect(binding.copyLocalPhoto(photoId, options())).resolves.toMatchObject({ cloudPhotoId: "opaque-cloud-photo" });
      const request = vi.mocked(native.start).mock.calls[0][1];
      if (phase === "failed") expect(request.requestId).toBe("old-request");
      else expect(request.requestId).not.toBe("old-request");
      expect(request.photoId).toBe(photoId);
    }
  });

  it("reports progress, bounds polling, and prevents concurrent double clicks", async () => {
    vi.useFakeTimers();
    let count = 0;
    const { binding, native } = fixture({ status: vi.fn<MacPhotoCopyNative["status"]>(async (_scope, id) => ++count < 2
      ? { requestId: id, photoId, phase: "verifying", fraction: 0.75 } : stored(id)) });
    const opts = options();
    const result = binding.copyLocalPhoto(photoId, opts);
    await expect(binding.copyLocalPhoto(photoId, options())).rejects.toMatchObject({ code: "incomplete" });
    await vi.advanceTimersByTimeAsync(499);
    expect(native.status).toHaveBeenCalledTimes(1);
    expect(opts.onProgress).toHaveBeenCalledWith(0.75);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ cloudPhotoId: "opaque-cloud-photo" });
  });

  it("cancels stalled IPC promptly and retries by status without rebinding the source", async () => {
    let finish: (status: MacPhotoCopyStatus) => void = () => {};
    const status = vi.fn<MacPhotoCopyNative["status"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockImplementation(async (_scope, id) => stored(id));
    const { binding, native } = fixture({ status });
    const controller = new AbortController();
    const pending = binding.copyLocalPhoto(photoId, options(controller));
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    const key = status.mock.calls[0][1];
    expect(native.cancel).toHaveBeenCalledWith(scope, key);
    finish(stored(key));
    await expect(binding.copyLocalPhoto(photoId, options())).resolves.toMatchObject({ cloudPhotoId: "opaque-cloud-photo" });
    expect(status.mock.calls[1][1]).toBe(key);
    expect(native.start).not.toHaveBeenCalled();
  });

  it.each([
    { ...scope, sessionEpoch: "session-2" },
    { ...scope, libraryId: "another-library" },
    { ...scope, actorId: "another-user" },
    null,
  ])("isolates pending results on account/library/session change (%j)", async (next) => {
    let finish: (value: MacPhotoCopyStatus) => void = () => {};
    const opts = options();
    const { binding, native, switchScope } = fixture({ status: vi.fn<MacPhotoCopyNative["status"]>(() => new Promise((resolve) => { finish = resolve; })) });
    const pending = binding.copyLocalPhoto(photoId, opts);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(native.status).toHaveBeenCalledTimes(1));
    switchScope(next);
    finish(stored(vi.mocked(native.status).mock.calls[0][1]));
    await rejected;
    expect(opts.onProgress).not.toHaveBeenCalled();
    expect(native.cancel).toHaveBeenCalledWith(scope, expect.any(String));
    await expect(binding.copyLocalPhoto(photoId, options())).rejects.toMatchObject({ code: "scope_changed" });
  });

  it("dispose cancels pending work and a pre-aborted copy never starts", async () => {
    const { binding, native, dispose } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(binding.copyLocalPhoto(photoId, options(controller))).rejects.toMatchObject({ code: "cancelled" });
    expect(native.recover).not.toHaveBeenCalled();
    dispose();
    await expect(binding.copyLocalPhoto(photoId, options())).rejects.toMatchObject({ code: "scope_changed" });
  });

  it("does not resurrect a binding when a previous scope returns after switching", async () => {
    const { binding, switchScope } = fixture();
    switchScope({ ...scope, sessionEpoch: "new-session" });
    switchScope(scope);
    await expect(binding.copyLocalPhoto(photoId, options())).rejects.toMatchObject({ code: "scope_changed" });
  });
});
