import type { CapturedPhotoActor, PhotoAuthService } from "@niho/photo-cloud-session/server";
import { NIHO_PRODUCTION_ORIGIN, PhotoAuthorizationError } from "@niho/photo-cloud-session/server";
import { describe, expect, it } from "vitest";

import { createSharingCloudProxy, type SharingProxyOperations } from "../src/server";
import { createBrowserSharedAlbumMembershipClient, createSharedAlbumMockServer } from "../src/sharing";
import { FakeIdentity, defaultActor } from "./support";

const PHOTO_ORIGIN = "https://photo.example.test";
const PREFIX = "/synthetic-sharing-backend";
const SHARING = "/cloud/sharing/v1";
const OWNER = "synthetic-user-owner";
const MEMBER = defaultActor().userId;
const START = Date.parse("2026-11-07T00:00:00.000Z");
const signal = new AbortController().signal;

type Upstream = (request: Request) => Promise<Response> | Response;

function setup(options: { upstream?: Upstream; operations?: SharingProxyOperations } = {}) {
  let secrets = 0;
  const server = createSharedAlbumMockServer({
    users: [{ userId: OWNER, displayName: "Synthetic Owner" }, { userId: MEMBER, displayName: "Synthetic Member" }],
    now: () => START,
    newSecret: () => `synthetic-secret-${++secrets}-${"x".repeat(22)}`,
  });
  // The verified session: the captured user unless a test says otherwise.
  const auth = { failure: null as PhotoAuthorizationError | null, failAfter: Number.POSITIVE_INFINITY, sessionUser: null as string | null, calls: 0 };
  const authService: Pick<PhotoAuthService, "withAuthorizedCredential"> = {
    async withAuthorizedCredential<T>(_request: Request, captured: CapturedPhotoActor | null, perform: (credential: string, actor: ReturnType<typeof defaultActor>) => Promise<T>): Promise<T> {
      auth.calls += 1;
      if (auth.failure !== null || auth.calls > auth.failAfter) throw auth.failure ?? new PhotoAuthorizationError(401, "unauthenticated");
      const actor = defaultActor({ userId: auth.sessionUser ?? captured?.userId ?? MEMBER });
      if (captured !== null && captured.userId !== actor.userId) throw new PhotoAuthorizationError(403, "scope_changed");
      return await perform(`server-only-credential-${actor.userId}`, actor);
    },
  };
  const upstreamRequests: { url: string; method: string; headers: Headers; body: string }[] = [];
  const proxy = createSharingCloudProxy({
    authService,
    upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
    upstreamPathPrefix: PREFIX,
    now: () => START,
    ...(options.operations ? { operations: options.operations } : {}),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = request.body === null ? "" : await request.clone().text();
      upstreamRequests.push({ url: request.url, method: request.method, headers: request.headers, body });
      if (options.upstream) return await options.upstream(request);
      // The synthetic server stands in for the upstream: the same suffix under its own prefix.
      const url = new URL(request.url);
      return await server.fetch(new Request(`${PHOTO_ORIGIN}${SHARING}${url.pathname.slice(PREFIX.length)}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body === "" ? {} : { body }),
      }));
    },
  });
  const browserFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), PHOTO_ORIGIN);
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set("Cookie", "__Host-niho-photo-credential=browser-cookie-not-forwarded");
    const response = await proxy(new Request(url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
    if (response === null) throw new Error("unexpected unhandled route");
    return response;
  };
  const clientFor = (userId: string) => createBrowserSharedAlbumMembershipClient({ identity: new FakeIdentity(defaultActor({ userId })), fetch: browserFetch, now: () => START });
  const capture = (userId = MEMBER): Record<string, string> => ({
    "X-NIHO-Photo-Actor-Id": userId,
    "X-NIHO-Photo-Session-Id": "parent-1",
    "X-NIHO-Photo-Session-Epoch": "epoch-1",
  });
  const call = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
    await proxy(new Request(`${PHOTO_ORIGIN}${path}`, { method, headers: { ...capture(), ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) }));
  const album = async () => (await server.clientFor(OWNER).request("albums.create", { name: "Synthetic album" }, { signal, idempotencyKey: `album-${Math.random()}` })).value;
  return { server, proxy, auth, upstreamRequests, clientFor, call, capture, album };
}

async function errorCode(response: Response | null): Promise<string> {
  if (response === null) throw new Error("not handled");
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("shared-album BFF proxy (/cloud/sharing/v1, B00 SHARING_ROUTES)", () => {
  it("forwards membership and invites under the verified session, to the fixed upstream only", async () => {
    const t = setup();
    const album = await t.album();
    const owner = t.clientFor(OWNER);
    const created = (await owner.request("invites.create", { albumId: album.id, role: "contributor" }, { signal, idempotencyKey: "invite-key-1" })).value;
    expect(created.secret).toEqual(expect.any(String));
    const joined = (await t.clientFor(MEMBER).request("invites.join", { secret: created.secret as string }, { signal, idempotencyKey: "join-key-1" })).value;
    expect(joined).toMatchObject({ joined: true, album: { id: album.id, memberCount: 2 } });
    const page = await owner.request("members.list", { albumId: album.id, limit: 1 }, { signal });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));

    expect(t.upstreamRequests.map((request) => `${request.method} ${request.url.slice(NIHO_PRODUCTION_ORIGIN.length)}`)).toEqual([
      `POST ${PREFIX}/albums/${encodeURIComponent(album.id)}/invites`,
      `POST ${PREFIX}/invites/join`,
      `GET ${PREFIX}/albums/${encodeURIComponent(album.id)}/members?limit=1`,
    ]);
    const [create, join, list] = t.upstreamRequests;
    expect(create?.headers.get("Authorization")).toBe(`Bearer server-only-credential-${OWNER}`);
    expect(create?.headers.get("X-NIHO-Photo-Actor-Id")).toBe(OWNER);
    expect(create?.headers.get("Idempotency-Key")).toBe("invite-key-1");
    expect(JSON.parse(create?.body as string)).toEqual({ role: "contributor" });
    expect(join?.headers.get("Authorization")).toBe(`Bearer server-only-credential-${MEMBER}`);
    expect(JSON.parse(join?.body as string)).toEqual({ secret: created.secret });
    expect(join?.url).not.toContain(created.secret as string);
    expect(list?.headers.get("Idempotency-Key")).toBeNull();
    // Caller cookies and headers are never forwarded.
    for (const request of t.upstreamRequests) {
      expect(request.headers.get("Cookie")).toBeNull();
      expect([...request.headers.keys()].sort()).toEqual(expect.arrayContaining(["authorization", "x-niho-photo-actor-id", "x-niho-photo-session-epoch", "x-niho-photo-session-id"]));
      expect([...request.headers.keys()].every((name) => ["authorization", "content-type", "idempotency-key", "range", "x-niho-photo-actor-id", "x-niho-photo-session-epoch", "x-niho-photo-session-id"].includes(name))).toBe(true);
    }

    // The upstream's refusal comes back as the contract's envelope.
    const refused = await t.clientFor(MEMBER).request("invites.create", { albumId: album.id, role: "viewer" }, { signal, idempotencyKey: "invite-key-2" }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ error: { code: "role_forbidden" } });
  });

  it("answers only the route table's paths and the operations it can check", async () => {
    const t = setup();
    const albumId = "synthetic-album";
    for (const [method, path] of [
      ["GET", `${SHARING}/unknown`],
      ["GET", SHARING],
      ["GET", `${SHARING}/albums`], // in the table, but its checks are not in this package yet
      ["GET", `${SHARING}/render-jobs/claim`],
      ["PUT", `${SHARING}/albums/${albumId}/invites`],
      ["GET", `${SHARING}/albums/a%2Fb/invites`],
      ["GET", `${SHARING}/albums/%2E%2E/invites`],
      ["GET", `${SHARING}/albums/%61lbum/invites`],
      ["GET", `${SHARING}/albums//invites`],
    ] as const) {
      const response = await t.call(method, path);
      expect({ path, status: response?.status }).toEqual({ path, status: 404 });
      expect(await errorCode(response)).toBe("not_found");
    }
    expect(await t.proxy(new Request(`${PHOTO_ORIGIN}/cloud/sharing/v1x/albums`))).toBeNull();
    expect(await t.proxy(new Request(`${PHOTO_ORIGIN}/cloud/v2/library`))).toBeNull();
    expect(t.upstreamRequests).toHaveLength(0);
    expect(t.auth.calls).toBe(0);
  });

  it("refuses malformed requests before the session or the upstream is touched", async () => {
    const t = setup();
    const albumId = "synthetic-album";
    const secret = "synthetic-secret-value-xxxxxxxxxxxxxx";
    const json = { "Content-Type": "application/json" };
    const cases: [string, Promise<Response | null>][] = [
      ["mutation without a key", t.call("POST", `${SHARING}/albums/${albumId}/invites`, { headers: json, body: JSON.stringify({ role: "viewer" }) })],
      ["read with a key", t.call("GET", `${SHARING}/albums/${albumId}/invites`, { headers: { "Idempotency-Key": "k" } })],
      ["range on a JSON route", t.call("GET", `${SHARING}/albums/${albumId}/invites`, { headers: { Range: "bytes=0-1" } })],
      ["extra body field", t.call("POST", `${SHARING}/albums/${albumId}/invites`, { headers: { ...json, "Idempotency-Key": "k" }, body: JSON.stringify({ role: "viewer", userId: "x" }) })],
      ["owner role by invite", t.call("POST", `${SHARING}/albums/${albumId}/invites`, { headers: { ...json, "Idempotency-Key": "k" }, body: JSON.stringify({ role: "owner" }) })],
      ["unknown query", t.call("GET", `${SHARING}/albums/${albumId}/members?userId=x`)],
      ["repeated query", t.call("GET", `${SHARING}/albums/${albumId}/members?limit=1&limit=2`)],
      ["limit out of range", t.call("GET", `${SHARING}/albums/${albumId}/members?limit=1000`)],
      ["query on a POST", t.call("POST", `${SHARING}/invites/join?secret=${secret}`, { headers: { ...json, "Idempotency-Key": "k" }, body: JSON.stringify({ secret }) })],
      ["form post", t.call("POST", `${SHARING}/invites/join`, { headers: { "Content-Type": "text/plain", "Idempotency-Key": "k" }, body: JSON.stringify({ secret }) })],
      ["not JSON", t.call("POST", `${SHARING}/invites/join`, { headers: { ...json, "Idempotency-Key": "k" }, body: "{" })],
      ["missing body", t.call("POST", `${SHARING}/albums/${albumId}/leave`, { headers: { "Idempotency-Key": "k" } })],
      ["body on DELETE", t.call("DELETE", `${SHARING}/albums/${albumId}/members/m1`, { headers: { ...json, "Idempotency-Key": "k" }, body: "{}" })],
      ["malformed secret", t.call("POST", `${SHARING}/invites/join`, { headers: { ...json, "Idempotency-Key": "k" }, body: JSON.stringify({ secret: "has spaces in it" }) })],
      ["oversized body", t.call("POST", `${SHARING}/invites/join`, { headers: { ...json, "Idempotency-Key": "k" }, body: JSON.stringify({ secret: "x".repeat(70_000) }) })],
      ["caller authorization", t.call("GET", `${SHARING}/albums/${albumId}/invites`, { headers: { Authorization: "Bearer caller-token" } })],
      ["no capture", t.proxy(new Request(`${PHOTO_ORIGIN}${SHARING}/albums/${albumId}/invites`))],
      ["partial capture", t.proxy(new Request(`${PHOTO_ORIGIN}${SHARING}/albums/${albumId}/invites`, { headers: { "X-NIHO-Photo-Actor-Id": MEMBER } }))],
    ];
    for (const [name, pending] of cases) {
      const response = await pending;
      expect({ name, status: response?.status }).toEqual({ name, status: 400 });
      const text = await response?.text();
      expect(text).toContain("invalid_request");
      expect(text).not.toContain(secret);
    }
    expect(t.upstreamRequests).toHaveLength(0);
    expect(t.auth.calls).toBe(0);
  });

  it("answers unauthenticated or unavailable when the session cannot be verified, sending nothing upstream", async () => {
    const t = setup();
    const path = `${SHARING}/albums/synthetic-album/invites`;
    t.auth.failure = new PhotoAuthorizationError(401, "unauthenticated");
    expect((await t.call("GET", path))?.status).toBe(401);
    t.auth.failure = new PhotoAuthorizationError(503, "unavailable");
    const unavailable = await t.call("GET", path);
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.json()).toMatchObject({ error: { code: "temporarily_unavailable", retryable: true } });
    // Another user signed in on this browser than the page captured.
    t.auth.failure = null;
    t.auth.sessionUser = OWNER;
    const changed = await t.call("GET", path);
    expect(changed?.status).toBe(401);
    expect(await errorCode(changed)).toBe("unauthenticated");
    expect(t.upstreamRequests).toHaveLength(0);
  });

  it("checks every answer before publishing it", async () => {
    const path = `${SHARING}/albums/synthetic-album/invites`;
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
    const leaked = { links: [], joins: [{ inviteLinkId: "l1", membershipId: "m1", member: { displayName: "Someone", isSelf: false, userId: "leaked-user-id" }, joinedAt: "2026-11-07T00:00:00.000Z" }] };
    const cases: [string, Upstream, number][] = [
      ["valid answer", () => json(200, { links: [], joins: [] }), 200],
      ["another person's user ID", () => json(200, leaked), 503],
      ["error with a mismatched status", () => json(403, { error: { code: "not_found", requestId: "r", retryable: false } }), 503],
      ["error outside the envelope", () => json(500, { message: "internal detail" }), 503],
      ["not JSON", () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }), 503],
      ["201", () => json(201, { links: [], joins: [] }), 503],
      ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/" } }), 503],
      ["oversized stream", () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); } }), { status: 200, headers: { "Content-Type": "application/json" } }), 503],
      ["network failure", () => { throw new TypeError("Failed to fetch"); }, 503],
      ["contract error", () => json(410, { error: { code: "invite_unavailable", requestId: "r", retryable: false } }), 410],
    ];
    for (const [name, upstream, status] of cases) {
      const t = setup({ upstream });
      const response = await t.call("GET", path);
      expect({ name, status: response?.status }).toEqual({ name, status });
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      const text = await response?.text();
      expect(text).not.toContain("leaked-user-id");
      expect(text).not.toContain("internal detail");
    }

    // The session ended while the upstream answered: nothing of the answer is published.
    const t = setup({ upstream: () => json(200, { links: [], joins: [] }) });
    t.auth.failAfter = 1;
    const ended = await t.call("GET", path);
    expect(ended?.status).toBe(401);
    expect(await errorCode(ended)).toBe("unauthenticated");
    expect(t.upstreamRequests).toHaveLength(1);
  });

  it("streams content like v2 content.get: whole or the requested range, size and hash checked, never buffered", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
    const sha = "a".repeat(64);
    const download = { kind: "content", validateRequest: () => undefined, contentType: "image/jpeg" } as const;
    const path = `${SHARING}/albums/a1/items/i1/renditions/r1/content`;
    const serve = (overrides: { status?: number; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> } = {}): Upstream => (request) => {
      const range = request.headers.get("Range");
      const match = range === null ? null : /^bytes=(\d+)-(\d*)$/u.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] !== "" ? Number(match[2]) : bytes.length - 1;
      const slice = overrides.body ?? bytes.slice(start, end + 1);
      return new Response(slice, {
        status: overrides.status ?? (range === null ? 200 : 206),
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(end - start + 1),
          "X-NIHO-Photo-Sha256": sha,
          "X-NIHO-Photo-Total-Bytes": String(bytes.length),
          ...(range === null ? {} : { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }),
          ...overrides.headers,
        },
      });
    };

    const whole = setup({ operations: { "albumItems.download": download }, upstream: serve() });
    const full = await whole.call("GET", `${path}?variant=thumbnail`);
    expect(full?.status).toBe(200);
    expect(new Uint8Array(await (full as Response).arrayBuffer())).toEqual(bytes);
    expect(full?.headers.get("X-NIHO-Photo-Sha256")).toBe(sha);
    expect(full?.headers.get("Cache-Control")).toBe("no-store");
    expect(whole.upstreamRequests[0]?.url).toBe(`${NIHO_PRODUCTION_ORIGIN}${PREFIX}/albums/a1/items/i1/renditions/r1/content?variant=thumbnail`);
    expect(whole.upstreamRequests[0]?.headers.get("Range")).toBeNull();

    const ranged = setup({ operations: { "albumItems.download": download }, upstream: serve() });
    const part = await ranged.call("GET", path, { headers: { Range: "bytes=2-5" } });
    expect(part?.status).toBe(206);
    expect(part?.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(new Uint8Array(await (part as Response).arrayBuffer())).toEqual(bytes.slice(2, 6));
    expect(ranged.upstreamRequests[0]?.headers.get("Range")).toBe("bytes=2-5");

    for (const [name, upstream, headers] of [
      ["another range", serve({ headers: { "Content-Range": "bytes 0-3/10" } }), { Range: "bytes=2-5" }],
      ["whole answer to a range", serve({ status: 200 }), { Range: "bytes=2-5" }],
      ["no hash", serve({ headers: { "X-NIHO-Photo-Sha256": "" } }), {}],
      ["another type", serve({ headers: { "Content-Type": "text/html" } }), {}],
      ["size mismatch", serve({ headers: { "X-NIHO-Photo-Total-Bytes": "11" } }), {}],
    ] as const) {
      const t = setup({ operations: { "albumItems.download": download }, upstream });
      const response = await t.call("GET", path, { headers });
      expect({ name, status: response?.status }).toEqual({ name, status: 503 });
    }
    for (const range of ["bytes=5-2", "bytes=0-1,3-4", "items=0-1"]) {
      const t = setup({ operations: { "albumItems.download": download }, upstream: serve() });
      expect((await t.call("GET", path, { headers: { Range: range } }))?.status).toBe(400);
      expect(t.upstreamRequests).toHaveLength(0);
    }

    // A short body never completes as success.
    const short = setup({ operations: { "albumItems.download": download }, upstream: serve({ body: bytes.slice(0, 5) }) });
    const truncated = await short.call("GET", path);
    expect(truncated?.status).toBe(200);
    await expect((truncated as Response).arrayBuffer()).rejects.toThrow();

    // The session ended before the stream was published.
    let cancelled = false;
    const ended = setup({
      operations: { "albumItems.download": download },
      upstream: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }), {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Content-Length": "10", "X-NIHO-Photo-Sha256": sha, "X-NIHO-Photo-Total-Bytes": "10" },
      }),
    });
    ended.auth.failAfter = 1;
    expect((await ended.call("GET", path))?.status).toBe(401);
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it("checks upload tickets against the trusted provider and the upload they belong to", async () => {
    const renew = {
      kind: "json",
      validateRequest: () => undefined,
      requestLimit: 1024,
      responseLimit: 64 * 1024,
      validateResponse: () => undefined,
      tickets: (_request: Record<string, unknown>, raw: unknown) => [{ ticket: (raw as { ticket: unknown }).ticket, contentType: "image/jpeg", sizeBytes: 4096 }],
    } as const;
    const path = `${SHARING}/albums/a1/uploads/u1/renew`;
    const ticket = (url: string, overrides: Record<string, unknown> = {}) => ({
      url, method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: "2026-11-07T00:30:00.000Z", resumeOffsetBytes: 0, ...overrides,
    });
    for (const [name, value, status] of [
      ["trusted provider", ticket("https://storage.googleapis.com/synthetic-album-uploads/u1"), 200],
      ["other origin", ticket("https://uploads.example.test/u1"), 503],
      ["plain HTTP", ticket("http://storage.googleapis.com/u1"), 503],
      ["another type", ticket("https://storage.googleapis.com/u1", { headers: { "Content-Type": "text/html" } }), 503],
      ["extra header", ticket("https://storage.googleapis.com/u1", { headers: { "Content-Type": "image/jpeg", Authorization: "x" } }), 503],
      ["expired", ticket("https://storage.googleapis.com/u1", { expiresAt: "2026-11-06T00:00:00.000Z" }), 503],
      ["offset past the size", ticket("https://storage.googleapis.com/u1", { resumeOffsetBytes: 4097 }), 503],
    ] as const) {
      const t = setup({
        operations: { "albumItems.renewUpload": renew },
        upstream: () => new Response(JSON.stringify({ upload: {}, ticket: value }), { status: 200, headers: { "Content-Type": "application/json" } }),
      });
      const response = await t.call("POST", path, { headers: { "Content-Type": "application/json" }, body: "{}" });
      expect({ name, status: response?.status }).toEqual({ name, status });
    }
  });

  it("starts only with the fixed upstream and a trusted prefix", () => {
    const base = {
      authService: { withAuthorizedCredential: async () => await Promise.reject(new Error("unused")) } as Pick<PhotoAuthService, "withAuthorizedCredential">,
      upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
      upstreamPathPrefix: PREFIX,
    } as const;
    expect(() => createSharingCloudProxy(base)).not.toThrow();
    for (const broken of [
      { upstreamOrigin: "https://other.example.test" },
      { upstreamPathPrefix: "relative" },
      { upstreamPathPrefix: "/trailing/" },
      { upstreamPathPrefix: "/a/../b" },
      { trustedUploadOrigin: "https://uploads.example.test" },
    ]) {
      expect(() => createSharingCloudProxy({ ...base, ...broken } as never)).toThrow("invalid photo sharing startup configuration");
    }
  });
});
