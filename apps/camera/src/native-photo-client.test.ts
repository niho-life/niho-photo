import { describe, expect, it, vi } from "vitest";
import { IDS, HASH, library, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import type { VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";

import {
  createNativePersonalPhotoCloudClient,
  type NativePhotoInvoke,
} from "./native-photo-client";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const actor: VerifiedPhotoActor = {
  userId: IDS.userA,
  sessionId: "synthetic-session",
  sessionEpoch: "synthetic-epoch",
  transport: "mac-bearer",
  expiresAt: "2026-11-04T00:00:00.000Z",
};

function identity(initial: VerifiedPhotoActor | null = actor) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    port: {
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies PersonalPhotoCloudIdentity,
    set(next: VerifiedPhotoActor | null) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function jsonAdapter(overrides: Partial<Record<string, unknown>> = {}) {
  const invoke = vi.fn<NativePhotoInvoke>(async (command, args) => {
    expect(command).toBe("camera_photo_request");
    const input = args.input as { operation: keyof typeof responses };
    return overrides[input.operation] ?? { status: 200, body: responses[input.operation] };
  });
  return invoke;
}

async function clientWith(invoke: NativePhotoInvoke, source = identity()) {
  const client = await createNativePersonalPhotoCloudClient({
    identity: source.port,
    invoke,
    now: () => NOW,
    requestId: () => "synthetic-request",
  });
  return { client, source };
}

describe("native fixed C00 JSON transport", () => {
  it("probes the real library and sends the exact captured safe scope and canonical request", async () => {
    const invoke = jsonAdapter();
    const { client } = await clientWith(invoke);
    invoke.mockClear();
    await expect(client.request("photos.list", {
      limit: 60,
      sort: "added-desc",
      formats: ["jpeg", "raw"],
      edited: false,
    }, { signal: new AbortController().signal })).resolves.toEqual(responses["photos.list"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("camera_photo_request", {
      input: {
        scope: {
          userId: IDS.userA,
          sessionId: actor.sessionId,
          sessionEpoch: actor.sessionEpoch,
          transport: "mac-bearer",
        },
        operation: "photos.list",
        request: { limit: 60, sort: "added-desc", formats: ["jpeg", "raw"], edited: false },
      },
    });
    expect(client.scope).toEqual({ actorId: IDS.userA, libraryId: IDS.library, sessionEpoch: actor.sessionEpoch });
  });

  it("keeps the logical scope across an ordinary same-epoch expiry refresh", async () => {
    const source = identity();
    const invoke = jsonAdapter();
    const { client } = await clientWith(invoke, source);
    source.set({ ...actor, expiresAt: "2026-11-05T00:00:00.000Z" });
    await expect(client.request("photos.get", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(responses["photos.get"]);
  });

  it.each([
    ["other owner", { ...actor, userId: IDS.userB }],
    ["other session", { ...actor, sessionId: "other-session" }],
    ["other epoch", { ...actor, sessionEpoch: "other-epoch" }],
    ["logout", null],
  ] as const)("fences pending and future calls after %s", async (_name, next) => {
    const source = identity();
    let finish: (value: unknown) => void = () => undefined;
    const invoke = vi.fn<NativePhotoInvoke>(async (_command, args) => {
      const operation = (args.input as { operation: string }).operation;
      if (operation === "library.get") return { status: 200, body: library };
      return await new Promise((resolve) => { finish = resolve; });
    });
    const { client } = await clientWith(invoke, source);
    const pending = client.request("photos.get", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
    });
    source.set(next);
    finish({ status: 200, body: responses["photos.get"] });
    await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
    await expect(client.request("library.get", {}, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "scope_changed" });
  });

  it("discards late JSON after abort and dispose", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const invoke = vi.fn<NativePhotoInvoke>(async (_command, args) => {
      const operation = (args.input as { operation: string }).operation;
      if (operation === "library.get") return { status: 200, body: library };
      return await new Promise((resolve) => { finish = resolve; });
    });
    const { client } = await clientWith(invoke);
    const controller = new AbortController();
    const pending = client.request("photos.info", { photoId: IDS.photo }, { signal: controller.signal });
    controller.abort();
    finish({ status: 200, body: responses["photos.info"] });
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    client.dispose();
    await expect(client.request("library.get", {}, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "disposed" });
  });

  it("rejects unsupported capability operations without IPC", async () => {
    const invoke = jsonAdapter();
    const { client } = await clientWith(invoke);
    invoke.mockClear();
    await expect(client.request("uploads.start", {
      target: { kind: "original", fileName: "synthetic.jpg", format: "jpeg" },
      sizeBytes: 10,
      sha256: "a".repeat(64),
      contentType: "image/jpeg",
    }, { signal: new AbortController().signal, idempotencyKey: "synthetic-key" }))
      .rejects.toMatchObject({ code: "unsupported" });
    await expect(client.request("versions.get", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "unsupported" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes only the canonical mutation key", async () => {
    const invoke = jsonAdapter();
    const { client } = await clientWith(invoke);
    invoke.mockClear();
    await client.request("photos.delete", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
      idempotencyKey: "delete-synthetic",
    });
    expect(invoke).toHaveBeenCalledWith("camera_photo_request", {
      input: expect.objectContaining({ operation: "photos.delete", idempotencyKey: "delete-synthetic" }),
    });
  });

  it("allows only closed masks.get metadata and binds its opaque asset id to the requested surface", async () => {
    const mask = responses["masks.get"];
    for (const bad of [
      { ...mask, id: "" },
      { ...mask, kind: "preview" },
      { ...mask, sha256: "b".repeat(64) },
      { ...mask, width: 4097 },
      { ...mask, token: "must-not-cross" },
    ]) {
      const invoke = jsonAdapter({ "masks.get": { status: 200, body: bad } });
      const { client } = await clientWith(invoke);
      await expect(client.request("masks.get", { photoId: IDS.photo, surfaceId: HASH.mask }, {
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it.each([
    { status: 200, body: { ...library, token: "must-not-cross" } },
    { status: 200, body: { ...library, ticket: { url: "https://example.test" } } },
    { status: 200, body: library, headers: { authorization: "secret" } },
  ])("rejects unknown, secret, or ticket-bearing native DTOs", async (bad) => {
    const invoke = jsonAdapter({ "photos.get": bad });
    const { client } = await clientWith(invoke);
    await expect(client.request("photos.get", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects oversized/deep wrappers before the canonical response validator", async () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next = {};
      cursor.next = next;
      cursor = next;
    }
    const invoke = jsonAdapter({ "photos.info": { status: 200, body: deep } });
    const { client } = await clientWith(invoke);
    await expect(client.request("photos.info", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
    })).rejects.toBeTruthy();
  });

  it("invalidates authentication only for a canonical unauthenticated envelope", async () => {
    const invoke = jsonAdapter({
      "photos.info": {
        status: 401,
        body: { error: { code: "unauthenticated", requestId: "synthetic", retryable: false } },
      },
    });
    const { client } = await clientWith(invoke);
    await expect(client.request("photos.info", { photoId: IDS.photo }, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ error: { code: "unauthenticated" } });
    await expect(client.request("library.get", {}, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "scope_changed" });
  });
});

describe("native verified content cache bridge", () => {
  function contentAdapter(options: { mismatch?: Partial<Record<string, unknown>>; chunks?: Uint8Array[] } = {}) {
    const chunks = [...(options.chunks ?? [new Uint8Array([1, 2]), new Uint8Array([3, 4])])];
    const invoke = vi.fn<NativePhotoInvoke>(async (command, args) => {
      if (command === "camera_photo_request") return { status: 200, body: library };
      if (command === "camera_photo_content_open") {
        return {
          handle: "native-handle",
          contentType: "image/jpeg",
          sha256: HASH.original,
          totalBytes: 4,
          range: { start: 0, endInclusive: 3 },
          sizeBytes: 4,
          ...options.mismatch,
        };
      }
      if (command === "camera_photo_content_read") {
        const chunk = chunks.shift() ?? new Uint8Array();
        return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      }
      if (command === "camera_photo_content_close" || command === "camera_photo_content_cancel") return {};
      throw new Error(`unexpected ${command} ${JSON.stringify(args)}`);
    });
    return invoke;
  }

  it("streams one bounded raw chunk per pull and closes after exact EOF", async () => {
    const invoke = contentAdapter();
    const { client } = await clientWith(invoke);
    const content = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
      signal: new AbortController().signal,
    });
    expect(content).toMatchObject({ contentType: "image/jpeg", sha256: HASH.original, totalBytes: 4, range: { start: 0, endInclusive: 3 } });
    const reader = content.body.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([1, 2]) });
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([3, 4]) });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(invoke.mock.calls.filter(([command]) => command === "camera_photo_content_read")).toHaveLength(2);
    expect(invoke.mock.calls.filter(([command]) => command === "camera_photo_content_close")).toHaveLength(1);
  });

  it("passes a mask selector only after this scoped client resolved the same photo and opaque asset", async () => {
    const mask = responses["masks.get"];
    const invoke = vi.fn<NativePhotoInvoke>(async (command, args) => {
      if (command === "camera_photo_request") {
        const operation = (args.input as { operation: string }).operation;
        return { status: 200, body: operation === "library.get" ? library : mask };
      }
      if (command === "camera_photo_content_open") {
        return {
          handle: "mask-handle", contentType: "image/png", sha256: HASH.mask,
          totalBytes: mask.sizeBytes, range: { start: 0, endInclusive: mask.sizeBytes - 1 }, sizeBytes: mask.sizeBytes,
        };
      }
      if (command === "camera_photo_content_close" || command === "camera_photo_content_cancel") return {};
      if (command === "camera_photo_content_read") return new Uint8Array(mask.sizeBytes).buffer;
      throw new Error(`unexpected ${command}`);
    });
    const { client } = await clientWith(invoke);
    await client.request("masks.get", { photoId: IDS.photo, surfaceId: HASH.mask }, {
      signal: new AbortController().signal,
    });
    const content = await client.request("content.get", { photoId: IDS.photo, assetId: mask.id }, {
      signal: new AbortController().signal,
    });
    expect(invoke).toHaveBeenCalledWith("camera_photo_content_open", {
      input: expect.objectContaining({ photoId: IDS.photo, assetId: mask.id, maskSurfaceId: HASH.mask }),
    });
    await content.body.cancel();

    await client.request("content.get", { photoId: IDS.photo, assetId: "unresolved-asset" }, {
      signal: new AbortController().signal,
    }).then((value) => value.body.cancel());
    const opens = invoke.mock.calls.filter(([command]) => command === "camera_photo_content_open");
    expect(opens.at(-1)?.[1].input).not.toHaveProperty("maskSurfaceId");
  });

  it("validates requested range and all returned metadata before exposing a stream", async () => {
    for (const mismatch of [
      { totalBytes: 0 },
      { sha256: "secret" },
      { range: { start: 1, endInclusive: 3 }, sizeBytes: 3 },
      { sizeBytes: 3 },
      { token: "must-not-cross" },
    ]) {
      const invoke = contentAdapter({ mismatch });
      const { client } = await clientWith(invoke);
      await expect(client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("rejects short/empty native reads and closes the verified handle", async () => {
    const invoke = contentAdapter({ chunks: [new Uint8Array()] });
    const { client } = await clientWith(invoke);
    const content = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
      signal: new AbortController().signal,
    });
    const reader = content.body.getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: "invalid_response" });
    expect(invoke.mock.calls.some(([command]) => command === "camera_photo_content_close")).toBe(true);
  });

  it("cancels a pending open and closes a late verified handle", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const invoke = vi.fn<NativePhotoInvoke>(async (command) => {
      if (command === "camera_photo_request") return { status: 200, body: library };
      if (command === "camera_photo_content_open") return await new Promise((resolve) => { finish = resolve; });
      return {};
    });
    const { client } = await clientWith(invoke);
    const controller = new AbortController();
    const pending = client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(invoke.mock.calls.some(([command]) => command === "camera_photo_content_cancel")).toBe(true);
    finish({
      handle: "late-handle", contentType: "image/jpeg", sha256: HASH.original,
      totalBytes: 4, range: { start: 0, endInclusive: 3 }, sizeBytes: 4,
    });
    await vi.waitFor(() => {
      expect(invoke.mock.calls.some(([command, args]) => command === "camera_photo_content_close"
        && (args.input as { handle?: string }).handle === "late-handle")).toBe(true);
    });
  });

  it("allows full-original verification to take longer than the control header deadline", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => undefined;
    const invoke = vi.fn<NativePhotoInvoke>(async command => {
      if (command === "camera_photo_request") return { status: 200, body: library };
      if (command === "camera_photo_content_open") return await new Promise(resolve => { finish = resolve; });
      return {};
    });
    const { client } = await clientWith(invoke);
    const outcome = client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
      signal: new AbortController().signal,
    }).then(value => ({ value }), error => ({ error }));
    try {
      await vi.advanceTimersByTimeAsync(16_000);
      expect(invoke.mock.calls.some(([command]) => command === "camera_photo_content_cancel")).toBe(false);
    } finally {
      finish({ handle: "slow-verified-handle", contentType: "image/jpeg", sha256: HASH.original,
        totalBytes: 4, range: { start: 0, endInclusive: 3 }, sizeBytes: 4 });
      const result = await outcome;
      if ("value" in result) await result.value.body.cancel();
      client.dispose(); vi.useRealTimers();
    }
  });

  it("closes a verified handle if scope expires before it can be published", async () => {
    let now = NOW;
    const invoke = vi.fn<NativePhotoInvoke>(async command => {
      if (command === "camera_photo_request") return { status: 200, body: library };
      if (command === "camera_photo_content_open") {
        now = Date.parse(actor.expiresAt);
        return { handle: "expired-before-publish", contentType: "image/jpeg", sha256: HASH.original,
          totalBytes: 4, range: { start: 0, endInclusive: 3 }, sizeBytes: 4 };
      }
      return {};
    });
    const client = await createNativePersonalPhotoCloudClient({ identity: identity().port, invoke,
      now: () => now, requestId: () => "synthetic-expiry" });
    try {
      await expect(client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "scope_changed" });
      expect(invoke.mock.calls.some(([command, args]) => command === "camera_photo_content_close"
        && (args.input as {handle?: string}).handle === "expired-before-publish")).toBe(true);
    } finally { client.dispose(); }
  });

  it("rejects native original metadata above the canonical 200MiB bound", async () => {
    const bytes = 200 * 1024 * 1024 + 1;
    const invoke = contentAdapter({ mismatch: { totalBytes: bytes,
      range: { start: 0, endInclusive: bytes - 1 }, sizeBytes: bytes } });
    const { client } = await clientWith(invoke);
    try {
      await expect(client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "invalid_response" });
      expect(invoke.mock.calls.some(([command, args]) => command === "camera_photo_content_close"
        && (args.input as { handle?: string }).handle === "native-handle")).toBe(true);
    } finally { client.dispose(); }
  });

  it("checks scope on every chunk and closes on epoch change", async () => {
    const source = identity();
    const invoke = contentAdapter({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])] });
    const { client } = await clientWith(invoke, source);
    const content = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, {
      signal: new AbortController().signal,
    });
    const reader = content.body.getReader();
    await reader.read();
    source.set({ ...actor, sessionEpoch: "new-epoch" });
    await expect(reader.read()).rejects.toMatchObject({ code: "scope_changed" });
    expect(invoke.mock.calls.some(([command]) => command === "camera_photo_content_close")).toBe(true);
  });
});
