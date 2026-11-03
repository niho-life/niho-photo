import type { Json } from "@niho/photo-personal-cloud-contract";
import type { CapturedPhotoActor, PhotoAuthService } from "@niho/photo-cloud-session/server";
import { NIHO_PRODUCTION_ORIGIN, PhotoAuthorizationError } from "@niho/photo-cloud-session/server";
import { IDS, HASH, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import { describe, expect, it, vi } from "vitest";

import { createBrowserPersonalPhotoCloudClient } from "../src/browser";
import { awaitBounded } from "../src/await";
import { createPersonalPhotoCloudProxy } from "../src/server";
import { validateOperationResponse, validateResponseTickets } from "../src/wire";
import { FakeIdentity, defaultActor } from "./support";

const PHOTO_ORIGIN = "https://photo.example.test";
const PREFIX = "/synthetic-photo-backend";
const NOW_FOR_TESTS = Date.parse("2026-11-03T00:00:00.000Z");

function authHarness(failAt = Number.POSITIVE_INFINITY) {
  let calls = 0;
  const service: Pick<PhotoAuthService, "withAuthorizedCredential"> = {
    async withAuthorizedCredential<T>(_request: Request, captured: CapturedPhotoActor | null, perform: (credential: string, actor: ReturnType<typeof defaultActor>) => Promise<T>): Promise<T> {
      calls += 1;
      if (calls === failAt) throw new PhotoAuthorizationError(403, "scope_changed");
      const actor = defaultActor();
      expect(captured).toMatchObject({ userId: actor.userId, sessionId: actor.sessionId, sessionEpoch: actor.sessionEpoch, transport: actor.transport });
      return await perform("server-only-credential", actor);
    },
  };
  return { service, calls: () => calls };
}

function setup(backend: (request: Request) => Promise<Response> | Response, failAt?: number) {
  const auth = authHarness(failAt);
  const seen: Request[] = [];
  const proxy = createPersonalPhotoCloudProxy({
    authService: auth.service,
    upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
    upstreamPathPrefix: PREFIX,
    now: () => NOW_FOR_TESTS,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      return await backend(request);
    },
  });
  const browserFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), PHOTO_ORIGIN);
    const request = new Request(url, init);
    const response = await proxy(request);
    if (response === null) throw new Error("unexpected unhandled route");
    return response;
  };
  return { auth, seen, proxy, browserFetch };
}

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } }); }

async function clientFor(harness: ReturnType<typeof setup>, identity = new FakeIdentity()) {
  return await createBrowserPersonalPhotoCloudClient({ identity, fetch: harness.browserFetch, now: () => Date.parse("2026-11-03T00:00:00.000Z") });
}

describe("same-origin HTTP client and BFF", () => {
  it("routes recipe PUT, direct conflict GET, and conflict resolve through the closed BFF wire", async () => {
    const candidateSettings = { ...responses["photos.get"].recipe.settings, future: { retained: true } };
    const putResponse = {
      ...responses["recipes.put"],
      value: { ...responses["recipes.put"].value, recipe: { ...responses["recipes.put"].value.recipe, settings: candidateSettings } },
    };
    const harness = setup(async (request) => {
      if (request.url.endsWith("/library")) return json(responses["library.get"]);
      if (request.url.endsWith("/recipe")) {
        expect(request.method).toBe("PUT");
        expect(request.headers.get("idempotency-key")).toBe("recipe-key");
        expect(await request.json()).toEqual({ expectedRevision: 0, settings: candidateSettings, baseVersion: null });
        return json(putResponse);
      }
      if (request.url.includes("/recipe-conflicts?")) {
        expect(request.method).toBe("GET");
        expect(new URL(request.url).searchParams.get("cursor")).toBe("page-1");
        expect(new URL(request.url).searchParams.get("limit")).toBe("16");
        return json(responses["recipe-conflicts.list"]);
      }
      if (request.url.endsWith(`/recipe-conflicts/${IDS.recipeConflict}`)) {
        expect(request.method).toBe("GET");
        return json(responses["recipe-conflicts.get"]);
      }
      expect(request.url).toContain(`/recipe-conflicts/${IDS.recipeConflict}/resolve`);
      expect(request.method).toBe("POST");
      expect(request.headers.get("idempotency-key")).toBe("resolve-key");
      expect(await request.json()).toEqual({ expectedRevision: 1, decision: "adopt" });
      return json(responses["recipe-conflicts.resolve"]);
    });
    const client = await clientFor(harness);
    try {
      await expect(client.request("recipes.put", {
        photoId: IDS.photo, expectedRevision: 0, settings: candidateSettings, baseVersion: null,
      }, { signal: new AbortController().signal, idempotencyKey: "recipe-key" })).resolves.toEqual(putResponse);
      await expect(client.request("recipe-conflicts.get", {
        photoId: IDS.photo, conflictId: IDS.recipeConflict,
      }, { signal: new AbortController().signal })).resolves.toEqual(responses["recipe-conflicts.get"]);
      await expect(client.request("recipe-conflicts.list", {
        photoId: IDS.photo, cursor: "page-1", limit: 16,
      }, { signal: new AbortController().signal })).resolves.toEqual(responses["recipe-conflicts.list"]);
      await expect(client.request("recipe-conflicts.resolve", {
        photoId: IDS.photo, conflictId: IDS.recipeConflict, expectedRevision: 1, decision: "adopt",
      }, { signal: new AbortController().signal, idempotencyKey: "resolve-key" })).resolves.toEqual(responses["recipe-conflicts.resolve"]);
    } finally { client.dispose(); }
    expect(harness.auth.calls()).toBe(10);
  });

  it("accepts near-1MiB recipe settings inside the separate 2MiB PUT envelope", async () => {
    const base = responses["photos.get"].recipe.settings;
    const settings = { ...base, retained: "" };
    const padding = "x".repeat(1024 ** 2 - new TextEncoder().encode(JSON.stringify(settings)).byteLength - 32);
    const nearLimit = { ...settings, retained: padding };
    expect(new TextEncoder().encode(JSON.stringify(nearLimit)).byteLength).toBeLessThanOrEqual(1024 ** 2);
    const receipt = {
      ...responses["recipes.put"],
      value: { ...responses["recipes.put"].value, recipe: { ...responses["recipes.put"].value.recipe, settings: nearLimit } },
    };
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(receipt));
    const client = await clientFor(harness);
    try {
      await expect(client.request("recipes.put", {
        photoId: IDS.photo, expectedRevision: 0, settings: nearLimit, baseVersion: null,
      }, { signal: new AbortController().signal, idempotencyKey: "near-limit" })).resolves.toEqual(receipt);
    } finally { client.dispose(); }
  });

  it("passes a conflict resolution response above 3MiB through the 4MiB response boundary", async () => {
    const padding = "x".repeat(1024 ** 2 - 400);
    const source = responses["recipe-conflicts.resolve"];
    const value = {
      conflict: {
        ...source.value.conflict,
        conflictingRecipe: {
          ...source.value.conflict.conflictingRecipe,
          settings: { ...source.value.conflict.conflictingRecipe.settings, retainedCandidate: padding },
        },
        currentRecipe: {
          ...source.value.conflict.currentRecipe,
          settings: { ...source.value.conflict.currentRecipe.settings, retainedCurrent: padding },
        },
      },
      recipe: { ...source.value.recipe, settings: { ...source.value.recipe.settings, retainedResult: padding } },
    };
    const response = { value, replayed: false };
    const bytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
    expect(bytes).toBeGreaterThan(3 * 1024 ** 2);
    expect(bytes).toBeLessThanOrEqual(4 * 1024 ** 2);
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(response));
    const client = await clientFor(harness);
    try {
      await expect(client.request("recipe-conflicts.resolve", {
        photoId: IDS.photo, conflictId: IDS.recipeConflict, expectedRevision: 1, decision: "adopt",
      }, { signal: new AbortController().signal, idempotencyKey: "large-conflict" })).resolves.toEqual(response);
    } finally { client.dispose(); }
  });

  it("closes an oversized resolve body at 64KiB before upstream dispatch", async () => {
    const harness = setup(() => json(responses["recipe-conflicts.resolve"]));
    const headers = captureHeaders();
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", "resolve-key");
    const response = await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/photos/${IDS.photo}/recipe-conflicts/${IDS.recipeConflict}/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, decision: "adopt", padding: "x".repeat(64 * 1024) }),
    }));
    expect(response?.status).toBe(400);
    expect(harness.seen).toHaveLength(0);
  });

  it.each([32, 33])("bounds the recipe itself at depth %i independently of HTTP envelopes", async (depth) => {
    let nested: Json = null;
    for (let index = 1; index < depth; index += 1) nested = { next: nested };
    const photo = { ...responses["photos.get"], recipe: { ...responses["photos.get"].recipe,
      settings: { ...responses["photos.get"].recipe.settings, future: nested } } };
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(photo));
    const client = await clientFor(harness);
    try {
      const result = client.request("photos.get", { photoId: photo.id }, { signal: new AbortController().signal });
      if (depth === 32) await expect(result).resolves.toEqual(photo);
      else await expect(result).rejects.toBeTruthy();
    } finally { client.dispose(); }
  });

  it.each([31, 32, 33])("sends a depth-%i settings leaf through the real PUT client and BFF boundary", async (depth) => {
    let nested: Json = null;
    for (let index = 1; index < depth; index += 1) nested = { next: nested };
    const settings = { ...responses["photos.get"].recipe.settings, future: nested };
    const receipt = {
      ...responses["recipes.put"],
      value: { ...responses["recipes.put"].value, recipe: { ...responses["recipes.put"].value.recipe, settings } },
    };
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(receipt));
    const client = await clientFor(harness);
    try {
      const result = client.request("recipes.put", {
        photoId: IDS.photo, expectedRevision: 0, settings, baseVersion: null,
      }, { signal: new AbortController().signal, idempotencyKey: `depth-${depth}` });
      if (depth <= 32) await expect(result).resolves.toEqual(receipt);
      else await expect(result).rejects.toBeTruthy();
    } finally { client.dispose(); }
    expect(harness.seen.filter((request) => request.url.endsWith("/recipe"))).toHaveLength(depth <= 32 ? 1 : 0);
  });

  it("rejects non-plain recipe JSON before the browser serializer can normalize it", async () => {
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(responses["recipes.put"]));
    const client = await clientFor(harness);
    try {
      for (const future of [new Date(), new Map([["x", 1]]), undefined, Number.POSITIVE_INFINITY]) {
        await expect(client.request("recipes.put", {
          photoId: IDS.photo,
          expectedRevision: 0,
          settings: { ...responses["photos.get"].recipe.settings, future } as never,
          baseVersion: null,
        }, { signal: new AbortController().signal, idempotencyKey: "plain-json" })).rejects.toBeTruthy();
      }
    } finally { client.dispose(); }
    expect(harness.seen.filter((request) => request.url.endsWith("/recipe"))).toHaveLength(0);
  });

  it("preserves a depth-32 recipe inside a stored-upload completion receipt", async () => {
    let nested: Json = null;
    for (let index = 1; index < 32; index += 1) nested = { next: nested };
    const photo = { ...responses["photos.get"], recipe: { ...responses["photos.get"].recipe,
      settings: { ...responses["photos.get"].recipe.settings, future: nested } } };
    const receipt = { replayed: true, value: {
      id: "depth-upload", target: { kind: "original", fileName: photo.fileName, format: photo.format },
      sha256: photo.original.sha256, sizeBytes: photo.original.sizeBytes, expiresAt: "2026-11-03T00:30:00.000Z",
      state: "stored", result: { kind: "original", photo },
    } };
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(receipt));
    const client = await clientFor(harness);
    try {
      await expect(client.request("uploads.complete", { uploadId: "depth-upload" }, {
        signal: new AbortController().signal, idempotencyKey: "depth-completion",
      })).resolves.toEqual(receipt);
    } finally { client.dispose(); }
  });
  it.each([31, 32, 33])("bounds depth-%i recipes in a replayed stored-upload start receipt", async (depth) => {
    let nested: Json = null;
    for (let index = 1; index < depth; index += 1) nested = { next: nested };
    const photo = { ...responses["photos.get"], recipe: { ...responses["photos.get"].recipe,
      settings: { ...responses["photos.get"].recipe.settings, future: nested } } };
    const upload = {
      id: "depth-start-upload", target: { kind: "original" as const, fileName: photo.fileName, format: photo.format },
      sha256: photo.original.sha256, sizeBytes: photo.original.sizeBytes, expiresAt: "2026-11-03T00:30:00.000Z",
      state: "stored", result: { kind: "original", photo },
    };
    const receipt = { replayed: true, value: { kind: "upload", upload, ticket: null } };
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(receipt));
    const client = await clientFor(harness);
    try {
      const result = client.request("uploads.start", {
        target: upload.target, sizeBytes: upload.sizeBytes, sha256: upload.sha256, contentType: photo.original.contentType,
      }, { signal: new AbortController().signal, idempotencyKey: "depth-start-key" });
      if (depth <= 32) await expect(result).resolves.toEqual(receipt);
      else await expect(result).rejects.toBeTruthy();
    } finally { client.dispose(); }
  });
  it("accepts an existing photo start response without an upload ticket", async () => {
    const photo = responses["photos.get"];
    const existing = { value: { kind: "existing", photo }, replayed: true };
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : json(existing));
    const client = await clientFor(harness);
    try {
      await expect(client.request("uploads.start", {
        target: { kind: "original", fileName: photo.fileName, format: photo.format },
        sizeBytes: photo.original.sizeBytes, sha256: photo.original.sha256, contentType: photo.original.contentType,
      }, { signal: new AbortController().signal, idempotencyKey: "existing-key" })).resolves.toEqual(existing);
    } finally { client.dispose(); }
  });

  it.each([[401, "unauthenticated"], [404, "not_found"]] as const)("preserves a content %s envelope through the BFF", async (status, code) => {
    const harness = setup((request) => request.url.endsWith("/library") ? json(responses["library.get"]) : Response.json({
      error: { code, requestId: "content-error", retryable: false },
    }, { status }));
    const client = await clientFor(harness);
    try {
      await expect(client.request("content.get", { photoId: IDS.photo, assetId: responses["photos.get"].original.id }, {
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ error: { code } });
    } finally { client.dispose(); }
  });

  it("disposes a response resolving after an already-aborted bounded wait", async () => {
    const signal = new AbortController();
    signal.abort();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(awaitBounded(Promise.resolve(response), {
      signal: signal.signal, timeoutMs: 15_000,
      onLateResolve: (late) => { void late.body?.cancel(); },
    })).rejects.toBeTruthy();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("probes the real library and confines the credential to both server callbacks", async () => {
    const harness = setup((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer server-only-credential");
      expect(request.headers.get("cookie")).toBeNull();
      return json(responses["library.get"]);
    });
    const client = await clientFor(harness);
    expect(client.scope).toEqual({ actorId: IDS.userA, libraryId: IDS.library, sessionEpoch: "epoch-1" });
    expect(harness.auth.calls()).toBe(2);
    client.dispose();
  });

  it("enforces the 15 second header deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = createBrowserPersonalPhotoCloudClient({
        identity: new FakeIdentity(),
        fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })),
        now: () => NOW_FOR_TESTS,
      });
      const rejected = expect(pending).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
    } finally { vi.useRealTimers(); }
  });

  it("settles a signal-ignoring fetch and cancels a late response body without publishing it", async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch!: (response: Response) => void;
      let cancelled = false;
      const pending = createBrowserPersonalPhotoCloudClient({
        identity: new FakeIdentity(),
        fetch: async () => await new Promise<Response>((resolve) => { resolveFetch = resolve; }),
        now: () => NOW_FOR_TESTS,
      });
      const rejected = expect(pending).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } }));
      await vi.advanceTimersByTimeAsync(1);
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("settles auth introspection that never resolves", async () => {
    vi.useFakeTimers();
    try {
      const proxy = createPersonalPhotoCloudProxy({
        authService: { withAuthorizedCredential: async () => await new Promise<never>(() => undefined) } as Pick<PhotoAuthService, "withAuthorizedCredential">,
        upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
        upstreamPathPrefix: PREFIX,
      });
      const pending = proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/library`, { headers: captureHeaders() }));
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(pending).resolves.toMatchObject({ status: 503 });
    } finally { vi.useRealTimers(); }
  });

  it("settles a BFF upstream fetch that ignores abort and cancels its late body", async () => {
    vi.useFakeTimers();
    try {
      let resolveBackend!: (response: Response) => void;
      let cancelled = false;
      const harness = setup(async () => await new Promise<Response>((resolve) => { resolveBackend = resolve; }));
      const pending = harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/library`, { headers: captureHeaders() }));
      const settled = pending.then((value) => value);
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(settled).resolves.toMatchObject({ status: 503 });
      resolveBackend(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } }));
      await vi.advanceTimersByTimeAsync(1);
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("preserves repeated formats and rejects duplicate scalar and unknown routes", async () => {
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : json(responses["photos.list"]));
    const client = await clientFor(harness);
    await client.request("photos.list", { formats: ["heic", "heif"], limit: 10 }, { signal: new AbortController().signal });
    expect(harness.seen.at(-1)?.url).toContain("formats=heic&formats=heif");
    const headers = captureHeaders();
    const duplicate = await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/photos?limit=1&limit=2`, { headers }));
    expect(duplicate?.status).toBe(400);
    expect(await harness.proxy(new Request(`${PHOTO_ORIGIN}/other`, { headers }))).toBeNull();
    client.dispose();
  });

  it("enforces key/body rules, rejects caller Authorization, and never forwards the auth cookie", async () => {
    const harness = setup((request) => {
      expect(request.headers.get("cookie")).toBeNull();
      return json(responses["photos.delete"]);
    });
    const base = captureHeaders();
    base.set("Cookie", "photo_credential=opaque");
    const missingKey = await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/photos/${IDS.photo}`, { method: "DELETE", headers: base }));
    expect(missingKey?.status).toBe(400);
    const callerAuth = new Headers(base); callerAuth.set("Authorization", "Bearer caller"); callerAuth.set("Idempotency-Key", "delete-key");
    expect((await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/photos/${IDS.photo}`, { method: "DELETE", headers: callerAuth })))?.status).toBe(400);
    const valid = new Headers(base); valid.set("Idempotency-Key", "delete-key");
    expect((await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/photos/${IDS.photo}`, { method: "DELETE", headers: valid })))?.status).toBe(200);
    const renewWithKey = new Headers(base); renewWithKey.set("Content-Type", "application/json"); renewWithKey.set("Idempotency-Key", "forbidden");
    expect((await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/uploads/upload/renew`, { method: "POST", headers: renewWithKey, body: "{}" })))?.status).toBe(400);
  });

  it("rejects a provider ticket containing forbidden wire headers at the BFF boundary", async () => {
    const harness = setup(() => json({
        value: {
          kind: "upload",
          upload: { id: "upload", target: { kind: "original", fileName: "photo.jpg", format: "jpeg" }, sizeBytes: 3, sha256: "a".repeat(64), expiresAt: "2030-01-01T00:00:00.000Z", state: "reserved", uploadedBytes: 0 },
          ticket: { url: "https://storage.googleapis.com/synthetic", method: "PUT", headers: { Authorization: "secret" }, expiresAt: "2030-01-01T00:00:00.000Z", resumeOffsetBytes: 0 },
        },
        replayed: false,
      }));
    const headers = captureHeaders(); headers.set("Content-Type", "application/json"); headers.set("Idempotency-Key", "start-key");
    const response = await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/uploads`, {
      method: "POST", headers, body: JSON.stringify({ target: { kind: "original", fileName: "photo.jpg", format: "jpeg" }, sizeBytes: 3, sha256: "a".repeat(64), contentType: "image/jpeg" }),
    }));
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("secret");
  });

  it("binds start and renew ticket Content-Type exactly at the BFF boundary without inventing a renew key", async () => {
    const startBody = { target: { kind: "original", fileName: "photo.jpg", format: "jpeg" }, sizeBytes: 3, sha256: "a".repeat(64), contentType: "image/jpeg" };
    const upload = { id: "upload", target: startBody.target, sizeBytes: 3, sha256: startBody.sha256, expiresAt: "2030-01-01T00:00:00.000Z", state: "reserved", uploadedBytes: 0 };
    let ticketType = "text/plain";
    const responseValue = () => ({ value: { kind: "upload", upload, ticket: { url: "https://storage.googleapis.com/synthetic", method: "PUT", headers: { "Content-Type": ticketType }, expiresAt: "2030-01-01T00:00:00.000Z", resumeOffsetBytes: 0 } }, replayed: false });
    const harness = setup((request) => json(request.url.endsWith("/renew")
      ? { upload, ticket: responseValue().value.ticket }
      : responseValue()));
    const startHeaders = captureHeaders(); startHeaders.set("Content-Type", "application/json"); startHeaders.set("Idempotency-Key", "start-key");
    expect((await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/uploads`, { method: "POST", headers: startHeaders, body: JSON.stringify(startBody) })))?.status).toBe(503);
    ticketType = "image/jpeg";
    expect(() => validateOperationResponse("uploads.start", responseValue(), IDS.userA, "", { kind: "start", contentType: "image/jpeg" })).not.toThrow();
    expect(() => validateResponseTickets("uploads.start", responseValue(), { kind: "start", contentType: "image/jpeg" }, "https://storage.googleapis.com", NOW_FOR_TESTS)).not.toThrow();
    const validStart = await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/uploads`, { method: "POST", headers: startHeaders, body: JSON.stringify(startBody) }));
    expect({ status: validStart?.status, authCalls: harness.auth.calls() }).toEqual({ status: 200, authCalls: 3 });
    const renewHeaders = captureHeaders(); renewHeaders.set("Content-Type", "application/json");
    expect((await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/uploads/upload/renew`, { method: "POST", headers: renewHeaders, body: "{}" })))?.status).toBe(200);
    ticketType = "text/plain";
    expect((await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/uploads/upload/renew`, { method: "POST", headers: renewHeaders, body: "{}" })))?.status).toBe(503);
  });

  it("rejects an unrequested lookup hash at both BFF and browser client boundaries", async () => {
    const requested = "a".repeat(64);
    const unrequested = "b".repeat(64);
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : json({ matches: [{ sha256: unrequested, photoId: IDS.photo, recipeRevision: 0 }] }));
    const headers = captureHeaders(); headers.set("Content-Type", "application/json");
    const direct = await harness.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/photos/lookup`, { method: "POST", headers, body: JSON.stringify({ sha256s: [requested] }) }));
    expect(direct?.status).toBe(503);
    const client = await clientFor(harness);
    await expect(client.request("photos.lookup", { sha256s: [requested] }, { signal: new AbortController().signal })).rejects.toBeTruthy();
    client.dispose();
  });

  it("independently enforces lookup request context and start ticket MIME in the browser client", async () => {
    const requested = "a".repeat(64);
    let ticketType = "text/plain";
    const startBody = { target: { kind: "original" as const, fileName: "photo.jpg", format: "jpeg" as const }, sizeBytes: 3, sha256: requested, contentType: "image/jpeg" };
    const upload = { id: "upload", target: startBody.target, sizeBytes: 3, sha256: requested, expiresAt: "2030-01-01T00:00:00.000Z", state: "reserved" as const, uploadedBytes: 0 };
    const client = await createBrowserPersonalPhotoCloudClient({
      identity: new FakeIdentity(), now: () => NOW_FOR_TESTS,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/library")) return json(responses["library.get"]);
        if (url.endsWith("/photos/lookup")) return json({ matches: [{ sha256: "b".repeat(64), photoId: IDS.photo, recipeRevision: 0 }] });
        return json({ value: { kind: "upload", upload, ticket: { url: "https://storage.googleapis.com/synthetic", method: "PUT", headers: { "Content-Type": ticketType }, expiresAt: "2030-01-01T00:00:00.000Z", resumeOffsetBytes: 0 } }, replayed: false });
      },
    });
    await expect(client.request("photos.lookup", { sha256s: [requested] }, { signal: new AbortController().signal })).rejects.toBeTruthy();
    await expect(client.request("uploads.start", startBody, { signal: new AbortController().signal, idempotencyKey: "start-key" })).rejects.toBeTruthy();
    ticketType = "image/jpeg";
    await expect(client.request("uploads.start", startBody, { signal: new AbortController().signal, idempotencyKey: "start-key" })).resolves.toMatchObject({ value: { kind: "upload" } });
    client.dispose();
  });

  it("accepts requested lookup hashes and closes duplicate and over-100 requests before dispatch", async () => {
    const hashes = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(64, "0"));
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : json({ matches: [{ sha256: hashes[99], photoId: IDS.photo, recipeRevision: 0 }] }));
    const client = await clientFor(harness);
    await expect(client.request("photos.lookup", { sha256s: hashes }, { signal: new AbortController().signal })).resolves.toMatchObject({ matches: [{ sha256: hashes[99] }] });
    const before = harness.seen.length;
    await expect(client.request("photos.lookup", { sha256s: [hashes[0], hashes[0]] }, { signal: new AbortController().signal })).rejects.toBeTruthy();
    await expect(client.request("photos.lookup", { sha256s: [...hashes, "f".repeat(64)] }, { signal: new AbortController().signal })).rejects.toBeTruthy();
    expect(harness.seen).toHaveLength(before);
    client.dispose();
  });

  it("accepts an exact 4MiB split page without Content-Length and closes at +1", async () => {
    const limit = 4 * 1024 ** 2;
    const page = { ...responses["photos.list"], padding: "" };
    const base = JSON.stringify(page).length;
    const exact = JSON.stringify({ ...page, padding: "x".repeat(limit - base) });
    expect(new TextEncoder().encode(exact)).toHaveLength(limit);
    let oversized = false;
    const harness = setup((request) => {
      if (request.url.includes("/library")) return json(responses["library.get"]);
      const bytes = new TextEncoder().encode(oversized ? `${exact} ` : exact);
      return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 7777) controller.enqueue(bytes.slice(offset, offset + 7777)); controller.close(); } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = await clientFor(harness);
    await expect(client.request("photos.list", {}, { signal: new AbortController().signal })).resolves.toMatchObject({ libraryRevision: responses["photos.list"].libraryRevision });
    oversized = true;
    await expect(client.request("photos.list", {}, { signal: new AbortController().signal })).rejects.toBeTruthy();
    client.dispose();
  });

  it.each([
    ["malformed UTF-8", new Uint8Array([0xc3, 0x28])],
    ["malformed JSON", new TextEncoder().encode("{")],
    ["depth 33", new TextEncoder().encode(`${"[".repeat(33)}0${"]".repeat(33)}`)],
  ])("closes %s before publication", async (_label, bytes) => {
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : new Response(bytes, { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = await clientFor(harness);
    await expect(client.request("photos.list", {}, { signal: new AbortController().signal })).rejects.toBeTruthy();
    client.dispose();
  });

  it("requires status/error-code agreement", async () => {
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : Response.json({ error: { code: "not_found", requestId: "x", retryable: false } }, { status: 503 }));
    const client = await clientFor(harness);
    await expect(client.request("photos.get", { photoId: IDS.photo }, { signal: new AbortController().signal })).rejects.toBeTruthy();
    client.dispose();
  });

  it("rechecks the captured actor after the upstream response", async () => {
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : json(responses["photos.list"]), 4);
    const client = await clientFor(harness);
    await expect(client.request("photos.list", {}, { signal: new AbortController().signal })).rejects.toBeTruthy();
    expect(harness.auth.calls()).toBe(4);
    client.dispose();
  });

  it("keeps the same logical scope across expiry refresh and closes on epoch change", async () => {
    const identity = new FakeIdentity();
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : json(responses["photos.list"]));
    const client = await clientFor(harness, identity);
    identity.set(defaultActor({ expiresAt: "2031-01-01T00:00:00.000Z" }));
    await expect(client.request("photos.list", {}, { signal: new AbortController().signal })).resolves.toBeTruthy();
    identity.set(defaultActor({ sessionEpoch: "epoch-2" }));
    await expect(client.request("photos.list", {}, { signal: new AbortController().signal })).rejects.toBeTruthy();
    client.dispose();
  });

  it("streams a checked range and rejects short and long bodies", async () => {
    let actualLength = 3;
    const harness = setup((request) => {
      if (request.url.includes("/library")) return json(responses["library.get"]);
      return new Response(new Uint8Array(actualLength), { status: 206, headers: {
        "Content-Type": "image/jpeg", "Content-Length": "3", "Content-Range": "bytes 2-4/10",
        "X-NIHO-Photo-Sha256": HASH.original, "X-NIHO-Photo-Total-Bytes": "10",
      } });
    });
    const client = await clientFor(harness);
    const first = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original, range: { start: 2, endInclusive: 4 } }, { signal: new AbortController().signal });
    await expect(new Response(first.body).arrayBuffer()).resolves.toHaveProperty("byteLength", 3);
    actualLength = 2;
    const second = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original, range: { start: 2, endInclusive: 4 } }, { signal: new AbortController().signal });
    await expect(new Response(second.body).arrayBuffer()).rejects.toBeTruthy();
    actualLength = 4;
    const third = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original, range: { start: 2, endInclusive: 4 } }, { signal: new AbortController().signal });
    await expect(new Response(third.body).arrayBuffer()).rejects.toBeTruthy();
    client.dispose();
  });

  it("does not publish the final expected chunk before proving EOF at both stream boundaries", async () => {
    const harness = setup((request) => {
      if (request.url.includes("/library")) return json(responses["library.get"]);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { status: 200, headers: {
        "Content-Type": "image/jpeg", "Content-Length": "3", "X-NIHO-Photo-Sha256": HASH.original, "X-NIHO-Photo-Total-Bytes": "3",
      } });
    });
    const client = await clientFor(harness);
    const content = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, { signal: new AbortController().signal });
    await expect(content.body.getReader().read()).rejects.toBeTruthy();
    client.dispose();

    let directCalls = 0;
    const direct = await createBrowserPersonalPhotoCloudClient({
      identity: new FakeIdentity(), now: () => NOW_FOR_TESTS,
      fetch: async () => {
        directCalls += 1;
        if (directCalls === 1) return json(responses["library.get"]);
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { status: 200, headers: {
          "Content-Type": "image/jpeg", "Content-Length": "3", "X-NIHO-Photo-Sha256": HASH.original, "X-NIHO-Photo-Total-Bytes": "3",
        } });
      },
    });
    const directContent = await direct.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, { signal: new AbortController().signal });
    await expect(directContent.body.getReader().read()).rejects.toBeTruthy();
    direct.dispose();
  });

  it("fails and cancels malformed content headers through the common cleanup path", async () => {
    let cancelled = false;
    const harness = setup((request) => request.url.includes("/library") ? json(responses["library.get"]) : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200, headers: {
      "Content-Type": "image/jpeg", "X-NIHO-Photo-Sha256": HASH.original, "X-NIHO-Photo-Total-Bytes": "3",
    } }));
    const client = await clientFor(harness);
    await expect(client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, { signal: new AbortController().signal })).rejects.toBeTruthy();
    await Promise.resolve();
    expect(cancelled).toBe(true);
    client.dispose();
  });

  it("times out a never-ending final tail without publishing the retained final chunk", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      let calls = 0;
      const client = await createBrowserPersonalPhotoCloudClient({
        identity: new FakeIdentity(), now: () => NOW_FOR_TESTS,
        fetch: async () => {
          calls += 1;
          if (calls === 1) return json(responses["library.get"]);
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } }), { status: 200, headers: {
            "Content-Type": "image/jpeg", "Content-Length": "3", "X-NIHO-Photo-Sha256": HASH.original, "X-NIHO-Photo-Total-Bytes": "3",
          } });
        },
      });
      const content = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, { signal: new AbortController().signal });
      const read = content.body.getReader().read();
      const rejected = expect(read).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      expect(cancelled).toBe(true);
      client.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("propagates caller cancellation through both stream boundaries", async () => {
    let cancelled = false;
    const harness = setup((request) => {
      if (request.url.includes("/library")) return json(responses["library.get"]);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }), { status: 200, headers: {
        "Content-Type": "image/jpeg", "Content-Length": "3", "X-NIHO-Photo-Sha256": HASH.original, "X-NIHO-Photo-Total-Bytes": "3",
      } });
    });
    const client = await clientFor(harness);
    const content = await client.request("content.get", { photoId: IDS.photo, assetId: IDS.original }, { signal: new AbortController().signal });
    await content.body.cancel("stop");
    await Promise.resolve();
    expect(cancelled).toBe(true);
    client.dispose();
  });
});

function captureHeaders(): Headers {
  return new Headers({
    "X-NIHO-Photo-Actor-Id": IDS.userA,
    "X-NIHO-Photo-Session-Id": "parent-1",
    "X-NIHO-Photo-Session-Epoch": "epoch-1",
  });
}
