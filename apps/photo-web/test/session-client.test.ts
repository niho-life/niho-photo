import { describe, expect, it, vi } from "vitest";

import type {
  PersonalPhotoCloudClient,
  PhotoContent,
} from "@niho/photo-personal-cloud-contract";
import {
  PhotoSessionController,
  type PhotoIdentity,
  type PhotoSessionHostBridge,
} from "@niho/photo-cloud-session";

import { PersonalPhotoCloudError } from "../../../packages/photo-cloud-library/src/errors.ts";
import {
  createCapturedPhotoWebCloudClient,
  createPhotoWebCloudIdentity,
} from "../src/browser/session-client.ts";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const SHA256 = "a".repeat(64);

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function identity(overrides: Partial<PhotoIdentity> = {}): PhotoIdentity {
  return {
    userId: "synthetic-user-alpha",
    sessionId: "synthetic-parent-session-alpha",
    sessionEpoch: "synthetic-server-epoch-1",
    transport: "browser-session",
    expiresAt: "2026-11-03T01:00:00.000Z",
    ...overrides,
  };
}

function host(overrides: Partial<PhotoSessionHostBridge> = {}): PhotoSessionHostBridge {
  return {
    read: async () => identity(),
    refresh: async () => identity({ expiresAt: "2026-11-03T02:00:00.000Z" }),
    logout: async () => undefined,
    cancel: async () => undefined,
    ...overrides,
  };
}

function controller(bridge: PhotoSessionHostBridge): PhotoSessionController {
  return new PhotoSessionController(bridge, {
    now: () => NOW,
    setTimer: () => Object.freeze({}),
    clearTimer: () => undefined,
  });
}

type RawRequest = (
  operation: string,
  request: unknown,
  options: { readonly signal: AbortSignal; readonly idempotencyKey?: string },
) => Promise<unknown>;

function fakeClient(raw: RawRequest, dispose = vi.fn()): PersonalPhotoCloudClient {
  return {
    scope: Object.freeze({
      actorId: "synthetic-user-alpha",
      libraryId: "synthetic-library-alpha",
      sessionEpoch: "synthetic-server-epoch-1",
    }),
    request: raw as PersonalPhotoCloudClient["request"],
    dispose,
  };
}

async function readyHarness(raw: RawRequest, scopeSignal = new AbortController()) {
  const session = controller(host());
  await session.read();
  const expected = session.getSnapshot().identity!;
  const rawClient = fakeClient(raw);
  const client = createCapturedPhotoWebCloudClient({
    client: rawClient,
    session,
    identity: expected,
    scopeSignal: scopeSignal.signal,
  });
  return { client, expected, rawClient, scopeSignal, session };
}

function content(body: ReadableStream<Uint8Array>, overrides: Partial<PhotoContent> = {}): PhotoContent {
  return {
    body,
    contentType: "image/jpeg",
    sha256: SHA256,
    totalBytes: 4,
    range: { start: 1, endInclusive: 2 },
    ...overrides,
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("photo web session identity bridge", () => {
  it("keeps the current identity during normal refresh and exposes expiry rotation", async () => {
    const refresh = deferred<PhotoIdentity>();
    const session = controller(host({ refresh: () => refresh.promise }));
    const scope = new AbortController();
    try {
      await session.read();
      const expected = session.getSnapshot().identity!;
      const bridge = createPhotoWebCloudIdentity({ session, identity: expected, scopeSignal: scope.signal });
      const pending = session.refresh();
      expect(session.getSnapshot().phase).toBe("verifying");
      expect(bridge.getSnapshot()).toBe(session.getSnapshot().identity);
      refresh.resolve(identity({ expiresAt: "2026-11-03T03:00:00.000Z" }));
      await pending;
      expect(bridge.getSnapshot()?.expiresAt).toBe("2026-11-03T03:00:00.000Z");
    } finally {
      session.dispose();
    }
  });

  it("returns null outside the expected browser tuple or after host abort", async () => {
    const session = controller(host());
    const scope = new AbortController();
    try {
      const expected = identity();
      const bridge = createPhotoWebCloudIdentity({ session, identity: expected, scopeSignal: scope.signal });
      expect(bridge.getSnapshot()).toBeNull();
      await session.read();
      const different = createPhotoWebCloudIdentity({
        session,
        identity: identity({ sessionEpoch: "synthetic-server-epoch-other" }),
        scopeSignal: scope.signal,
      });
      expect(different.getSnapshot()).toBeNull();
      scope.abort();
      expect(bridge.getSnapshot()).toBeNull();
    } finally {
      session.dispose();
    }
  });

  it("notifies session metadata and host abort, then cleans up idempotently", async () => {
    const refresh = deferred<PhotoIdentity>();
    const session = controller(host({ refresh: () => refresh.promise }));
    const scope = new AbortController();
    try {
      await session.read();
      const bridge = createPhotoWebCloudIdentity({
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: scope.signal,
      });
      const listener = vi.fn();
      const unsubscribe = bridge.subscribe(listener);
      const pending = session.refresh();
      refresh.resolve(identity({ expiresAt: "2026-11-03T03:00:00.000Z" }));
      await pending;
      scope.abort();
      expect(listener).toHaveBeenCalledTimes(3);
      unsubscribe();
      unsubscribe();
      session.dispose();
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      session.dispose();
    }
  });
});

describe("captured photo web cloud client", () => {
  it("does not call the raw client for a new request while verifying", async () => {
    const refresh = deferred<PhotoIdentity>();
    const session = controller(host({ refresh: () => refresh.promise }));
    const raw = vi.fn(async () => ({ id: "unused" }));
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: fakeClient(raw),
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      const pending = session.refresh();
      await expect(client.request("library.get", {}, { signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "scope_changed" });
      expect(raw).not.toHaveBeenCalled();
      refresh.resolve(identity());
      await pending;
      client.dispose();
    } finally {
      refresh.resolve(identity());
      session.dispose();
    }
  });

  it("holds an in-flight success until same-tuple refresh is ready", async () => {
    const work = deferred<unknown>();
    const refresh = deferred<PhotoIdentity>();
    const session = controller(host({ refresh: () => refresh.promise }));
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: fakeClient(() => work.promise),
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      let settled = false;
      const operation = client.request("library.get", {}, { signal: new AbortController().signal })
        .then((value) => { settled = true; return value; });
      const verification = session.refresh();
      const value = Object.freeze({ id: "synthetic-library-alpha" });
      work.resolve(value);
      await turn();
      expect(settled).toBe(false);
      refresh.resolve(identity({ expiresAt: "2026-11-03T03:00:00.000Z" }));
      await verification;
      expect(await operation).toBe(value);
      client.dispose();
    } finally {
      refresh.resolve(identity());
      session.dispose();
    }
  });

  it("holds and rethrows the exact conflict object after same-tuple refresh", async () => {
    const work = deferred<unknown>();
    const refresh = deferred<PhotoIdentity>();
    const conflict = Object.freeze({
      error: Object.freeze({ code: "revision_conflict", requestId: "synthetic-request", retryable: false, currentRevision: 7 }),
    });
    const session = controller(host({ refresh: () => refresh.promise }));
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: fakeClient(() => work.promise),
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      let rejected = false;
      const operation = client.request("recipes.put", {
        photoId: "synthetic-photo", expectedRevision: 6,
        settings: { v: 1, engine: "synthetic-engine" }, baseVersion: null,
      }, { signal: new AbortController().signal, idempotencyKey: "synthetic-key" })
        .catch((error: unknown) => { rejected = true; throw error; });
      const verification = session.refresh();
      work.reject(conflict);
      await turn();
      expect(rejected).toBe(false);
      refresh.resolve(identity({ expiresAt: "2026-11-03T03:00:00.000Z" }));
      await verification;
      await expect(operation).rejects.toBe(conflict);
      client.dispose();
    } finally {
      refresh.resolve(identity());
      session.dispose();
    }
  });

  it("drops old results when refresh changes the logical identity", async () => {
    const work = deferred<unknown>();
    const session = controller(host({
      refresh: async () => identity({ sessionEpoch: "synthetic-server-epoch-2" }),
    }));
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: fakeClient(() => work.promise),
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      const operation = client.request("library.get", {}, { signal: new AbortController().signal });
      await session.refresh();
      await expect(operation).rejects.toMatchObject({ code: "scope_changed" });
      work.resolve({ id: "stale-library" });
      await turn();
      client.dispose();
    } finally {
      session.dispose();
    }
  });

  it("propagates caller abort promptly without waiting for a noncooperative raw call", async () => {
    const work = deferred<unknown>();
    const caller = new AbortController();
    const reason = new DOMException("synthetic caller abort", "AbortError");
    const harness = await readyHarness(() => work.promise);
    try {
      const operation = harness.client.request("library.get", {}, { signal: caller.signal });
      caller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      work.resolve({ id: "late-library" });
      await turn();
    } finally {
      harness.client.dispose();
      harness.session.dispose();
    }
  });

  it("cancels a late content response after logout even if raw ignores abort", async () => {
    const work = deferred<unknown>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const session = controller(host());
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: fakeClient(() => work.promise),
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      const operation = client.request("content.get", {
        photoId: "synthetic-photo", assetId: "synthetic-asset",
      }, { signal: new AbortController().signal });
      await session.logout();
      await expect(operation).rejects.toMatchObject({ code: "scope_changed" });
      work.resolve(content(body));
      await turn();
      expect(cancelled).toHaveBeenCalledTimes(1);
      client.dispose();
    } finally {
      session.dispose();
    }
  });

  it("cancels a late content response after the host scope aborts", async () => {
    const work = deferred<unknown>();
    const cancelled = vi.fn();
    const scope = new AbortController();
    const harness = await readyHarness(() => work.promise, scope);
    try {
      const operation = harness.client.request("content.get", {
        photoId: "synthetic-photo", assetId: "synthetic-asset",
      }, { signal: new AbortController().signal });
      scope.abort(new Error("private host fence"));
      await expect(operation).rejects.toEqual(new PersonalPhotoCloudError("scope_changed"));
      work.resolve(content(new ReadableStream<Uint8Array>({ cancel: cancelled })));
      await turn();
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      harness.client.dispose();
      harness.session.dispose();
    }
  });

  it("keeps an accepted body abortable and never exposes a post-abort pending chunk", async () => {
    const releasePull = deferred<void>();
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        await releasePull.promise;
        streamController.enqueue(new Uint8Array([7]));
      },
      cancel: cancelled,
    });
    const scope = new AbortController();
    const harness = await readyHarness(async () => content(source), scope);
    try {
      const accepted = await harness.client.request("content.get", {
        photoId: "synthetic-photo", assetId: "synthetic-asset",
      }, { signal: new AbortController().signal });
      const reader = accepted.body.getReader();
      const pending = reader.read();
      scope.abort();
      await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
      releasePull.resolve();
      await turn();
      expect(cancelled).toHaveBeenCalledTimes(1);
      await expect(reader.read()).rejects.toMatchObject({ code: "scope_changed" });
    } finally {
      releasePull.resolve();
      harness.client.dispose();
      harness.session.dispose();
    }
  });

  it("releases linked signals after JSON settle and content EOF, error, or cancel", async () => {
    const cases: readonly { readonly mode: "eof" | "error" | "cancel" }[] = [
      { mode: "eof" }, { mode: "error" }, { mode: "cancel" },
    ];
    for (const { mode } of cases) {
      const scope = new AbortController();
      const add = vi.spyOn(scope.signal, "addEventListener");
      const remove = vi.spyOn(scope.signal, "removeEventListener");
      const source = mode === "error"
        ? new ReadableStream<Uint8Array>({ start(value) { value.error(new Error("synthetic stream error")); } })
        : new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new Uint8Array([1])); value.close(); } });
      const harness = await readyHarness(async (operation) => operation === "content.get"
        ? content(source, { totalBytes: 1, range: { start: 0, endInclusive: 0 } })
        : { id: "synthetic-library-alpha" }, scope);
      try {
        await harness.client.request("library.get", {}, { signal: new AbortController().signal });
        expect(remove.mock.calls.length).toBe(add.mock.calls.length);
        const accepted = await harness.client.request("content.get", {
          photoId: "synthetic-photo", assetId: "synthetic-asset",
        }, { signal: new AbortController().signal });
        if (mode !== "error") expect(remove.mock.calls.length).toBeLessThan(add.mock.calls.length);
        const reader = accepted.body.getReader();
        if (mode === "cancel") await reader.cancel("synthetic cancel");
        else if (mode === "error") await expect(reader.read()).rejects.toThrow("synthetic stream error");
        else {
          expect((await reader.read()).value).toEqual(new Uint8Array([1]));
          expect((await reader.read()).done).toBe(true);
        }
        expect(remove.mock.calls.length).toBe(add.mock.calls.length);
      } finally {
        harness.client.dispose();
        harness.session.dispose();
      }
    }
  });

  it("preserves and freezes ranged content metadata", async () => {
    const metadata = content(new ReadableStream<Uint8Array>({ start(value) { value.close(); } }), {
      contentType: "image/heic",
      sha256: "b".repeat(64),
      totalBytes: 9_001,
      range: { start: 123, endInclusive: 456 },
    });
    const harness = await readyHarness(async () => metadata);
    try {
      const accepted = await harness.client.request("content.get", {
        photoId: "synthetic-photo", assetId: "synthetic-asset", range: { start: 123, endInclusive: 456 },
      }, { signal: new AbortController().signal });
      expect(accepted).toMatchObject({
        contentType: metadata.contentType,
        sha256: metadata.sha256,
        totalBytes: metadata.totalBytes,
        range: metadata.range,
      });
      expect(Object.isFrozen(accepted)).toBe(true);
      expect(Object.isFrozen(accepted.range)).toBe(true);
      await accepted.body.cancel();
    } finally {
      harness.client.dispose();
      harness.session.dispose();
    }
  });

  it("keeps the captured scope immutable and rejects raw scope rebinding", async () => {
    const raw = fakeClient(async () => ({ id: "synthetic-library-alpha" }));
    const session = controller(host());
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: raw,
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      expect(Object.isFrozen(client.scope)).toBe(true);
      Object.defineProperty(raw, "scope", {
        value: Object.freeze({ ...raw.scope }),
        configurable: true,
      });
      await expect(client.request("library.get", {}, { signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "scope_changed" });
      client.dispose();
    } finally {
      session.dispose();
    }
  });

  it("aborts owned work and delegates raw dispose exactly once", async () => {
    const work = deferred<unknown>();
    const dispose = vi.fn();
    const session = controller(host());
    try {
      await session.read();
      const client = createCapturedPhotoWebCloudClient({
        client: fakeClient(() => work.promise, dispose),
        session,
        identity: session.getSnapshot().identity!,
        scopeSignal: new AbortController().signal,
      });
      const operation = client.request("library.get", {}, { signal: new AbortController().signal });
      client.dispose();
      client.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
      await expect(operation).rejects.toMatchObject({ code: "disposed" });
      work.resolve({ id: "late-library" });
      await turn();
    } finally {
      session.dispose();
    }
  });
});
