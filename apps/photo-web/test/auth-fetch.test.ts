import { describe, expect, it, vi } from "vitest";

import { createPhotoWebCloudFetch } from "../src/browser/auth-fetch.ts";

const ORIGIN = "https://photo.example";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function harness(status = 401) {
  const scope = new AbortController();
  const rejected = vi.fn();
  const response = new Response('{"error":{"code":"unauthenticated"}}', { status });
  const raw = vi.fn<typeof fetch>(async () => response);
  const request = createPhotoWebCloudFetch({ origin: ORIGIN, scopeSignal: scope.signal, onAuthenticationRejected: rejected, fetch: raw });
  return { scope, rejected, response, raw, request };
}

describe("Photo BFF authentication notification", () => {
  it("preserves the exact request and unread response while notifying a fixed relative BFF 401", async () => {
    const test = harness();
    const init: RequestInit = { method: "GET", credentials: "same-origin", redirect: "error", signal: new AbortController().signal };
    expect(await test.request("/cloud/v2/library", init)).toBe(test.response);
    expect(test.raw).toHaveBeenCalledWith("/cloud/v2/library", init);
    expect(test.rejected).toHaveBeenCalledTimes(1);
    expect(test.response.bodyUsed).toBe(false);
    expect(await test.response.json()).toEqual({ error: { code: "unauthenticated" } });
  });

  it.each([
    "/cloud/sharing/v1/albums",
    "/cloud/sharing/v1/albums/synthetic-album/items?limit=10",
    "/cloud/sharing/v1/invites/pending/join",
  ])("notifies a 401 of the shared-album BFF the same way: %s", async (path) => {
    const test = harness();
    expect(await test.request(path)).toBe(test.response);
    expect(test.rejected).toHaveBeenCalledTimes(1);
  });

  it.each(["url", "request"] as const)("supports a same-origin %s input", async (kind) => {
    const test = harness();
    const input = kind === "url" ? new URL("/cloud/v2/photos?cursor=synthetic", ORIGIN) : new Request(ORIGIN + "/cloud/v2/usage");
    expect(await test.request(input)).toBe(test.response);
    expect(test.rejected).toHaveBeenCalledTimes(1);
  });

  it.each([200, 400, 403, 409, 500, 503])("passes status %i without an authentication notification", async (status) => {
    const test = harness(status);
    expect(await test.request("/cloud/v2/library")).toBe(test.response);
    expect(test.rejected).not.toHaveBeenCalled();
  });

  it.each([
    "https://storage.googleapis.com/cloud/v2/library",
    "https://other.example/cloud/v2/library",
    "/cloud/v20/library", "/cloud/v2", "/auth/session", "/develop-engine/static.wasm",
    "/cloud/sharing/v1", "/cloud/sharing/v10/albums", "/cloud/sharing/albums", "https://other.example/cloud/sharing/v1/albums",
  ])("does not treat an unrelated request as a Photo BFF rejection: %s", async (input) => {
    const test = harness();
    expect(await test.request(input)).toBe(test.response);
    expect(test.rejected).not.toHaveBeenCalled();
  });

  it("does not notify for synthetic URL userinfo", async () => {
    const test = harness();
    const input = new URL("/cloud/v2/library", ORIGIN);
    input.username = "synthetic";
    input.password = "synthetic";
    expect(await test.request(input)).toBe(test.response);
    expect(test.rejected).not.toHaveBeenCalled();
  });

  it.each(["scope", "request"] as const)("ignores a late 401 after %s abort even if fetch ignores it", async (kind) => {
    const scope = new AbortController();
    const caller = new AbortController();
    const pending = deferred<Response>();
    const rejected = vi.fn();
    const request = createPhotoWebCloudFetch({ origin: ORIGIN, scopeSignal: scope.signal, onAuthenticationRejected: rejected, fetch: async () => pending.promise });
    const response = new Response(null, { status: 401 });
    const result = request("/cloud/v2/library", { signal: caller.signal });
    if (kind === "scope") scope.abort(); else caller.abort();
    pending.resolve(response);
    expect(await result).toBe(response);
    expect(rejected).not.toHaveBeenCalled();
  });

  it("uses a Request signal unless init explicitly replaces it", async () => {
    const test = harness();
    const caller = new AbortController();
    caller.abort();
    const input = new Request(ORIGIN + "/cloud/v2/library", { signal: caller.signal });
    await test.request(input);
    expect(test.rejected).not.toHaveBeenCalled();
    await test.request(input, { signal: null });
    expect(test.rejected).toHaveBeenCalledTimes(1);
  });

  it("captures the target before a mutable URL changes during fetch", async () => {
    const pending = deferred<Response>();
    const rejected = vi.fn();
    const request = createPhotoWebCloudFetch({ origin: ORIGIN, scopeSignal: new AbortController().signal, onAuthenticationRejected: rejected, fetch: async () => pending.promise });
    const input = new URL("/cloud/v2/library", ORIGIN);
    const result = request(input);
    input.hostname = "other.example";
    pending.resolve(new Response(null, { status: 401 }));
    await result;
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("preserves the response even when the notification throws", async () => {
    const response = new Response(null, { status: 401 });
    const request = createPhotoWebCloudFetch({ origin: ORIGIN, scopeSignal: new AbortController().signal, onAuthenticationRejected() { throw new Error("synthetic observer failure"); }, fetch: async () => response });
    expect(await request("/cloud/v2/library")).toBe(response);
  });

  it("preserves the exact transport rejection without notifying", async () => {
    const failure = new TypeError("synthetic transport failure");
    const rejected = vi.fn();
    const request = createPhotoWebCloudFetch({ origin: ORIGIN, scopeSignal: new AbortController().signal, onAuthenticationRejected: rejected, fetch: async () => { throw failure; } });
    await expect(request("/cloud/v2/library")).rejects.toBe(failure);
    expect(rejected).not.toHaveBeenCalled();
  });
});
