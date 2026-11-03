import { describe, expect, it, vi } from "vitest";

import {
  invalidateNativePhotoIdentity,
  PHOTO_IDENTITY_INVALIDATED_EVENT,
  readNativePhotoIdentity,
  watchNativePhotoIdentityInvalidation,
} from "./native-photo-session";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const valid = {
  userId: "synthetic-user",
  sessionId: "synthetic-session",
  sessionEpoch: "synthetic-epoch",
  transport: "mac-bearer",
  expiresAt: "2026-11-04T00:00:00.000Z",
} as const;

describe("native photo identity reader", () => {
  it("returns only a valid closed five-field mac identity", async () => {
    const invoke = vi.fn(async () => valid);
    await expect(readNativePhotoIdentity(new AbortController().signal, { invoke, now: () => NOW })).resolves.toEqual(valid);
    expect(invoke).toHaveBeenCalledWith("camera_photo_identity");
  });

  it.each([
    { ...valid, token: "synthetic-secret" },
    { ...valid, transport: "browser-session" },
    { ...valid, sessionId: "" },
    { ...valid, sessionEpoch: "hidden\u200bseparator" },
    { ...valid, expiresAt: "2026-02-30T00:00:00.000Z" },
    { ...valid, expiresAt: "2026-11-03T00:00:00.000Z" },
    { ...valid, expiresAt: "2026-12-05T00:00:00.001Z" },
    { actor: { id: "synthetic-user" }, sessionId: "synthetic-session" },
    null,
  ])("rejects unknown or invalid native metadata (%j)", async (value) => {
    await expect(readNativePhotoIdentity(new AbortController().signal, {
      invoke: async () => value,
      now: () => NOW,
    })).resolves.toBeNull();
  });

  it("discards a pending native read after the synchronous logout fence without relying on caller abort", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const controller = new AbortController();
    const result = readNativePhotoIdentity(controller.signal, {
      invoke: () => new Promise((resolve) => { finish = resolve; }),
      now: () => NOW,
    });
    invalidateNativePhotoIdentity();
    expect(controller.signal.aborted).toBe(false);
    finish(valid);
    await expect(result).resolves.toBeNull();
  });

  it("discards a valid late result after abort", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const controller = new AbortController();
    const result = readNativePhotoIdentity(controller.signal, {
      invoke: () => new Promise((resolve) => { finish = resolve; }),
      now: () => NOW,
    });
    controller.abort();
    finish(valid);
    await expect(result).resolves.toBeNull();
  });
});

describe("native photo identity invalidation", () => {
  it("discards a pending identity when native emits an exact invalidation event", async () => {
    let nativeHandler: (event: { payload: unknown }) => void = () => undefined;
    const stop = await watchNativePhotoIdentityInvalidation(() => undefined, {
      listen: async (_event, listener) => { nativeHandler = listener; return () => undefined; },
    });
    let finish: (value: unknown) => void = () => undefined;
    try {
      const result = readNativePhotoIdentity(new AbortController().signal, {
        invoke: () => new Promise(resolve => { finish = resolve; }), now: () => NOW,
      });
      nativeHandler({ payload: { invalidated: true } });
      finish(valid);
      await expect(result).resolves.toBeNull();
    } finally { stop(); }
  });

  it("delivers the synchronous logout fence and only the exact native signal", async () => {
    let nativeHandler: (event: { payload: unknown }) => void = () => undefined;
    const handler = vi.fn();
    const unlisten = vi.fn();
    const stop = await watchNativePhotoIdentityInvalidation(handler, {
      listen: async (event, listener) => {
        expect(event).toBe(PHOTO_IDENTITY_INVALIDATED_EVENT);
        nativeHandler = listener;
        return unlisten;
      },
    });

    invalidateNativePhotoIdentity();
    nativeHandler({ payload: { invalidated: true, reason: "secret" } });
    nativeHandler({ payload: { invalidated: true } });
    expect(handler).toHaveBeenCalledTimes(2);
    stop();
    invalidateNativePhotoIdentity();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
