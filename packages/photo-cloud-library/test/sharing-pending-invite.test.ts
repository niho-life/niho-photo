import type { CapturedPhotoActor, PhotoAuthService } from "@niho/photo-cloud-session/server";
import { NIHO_PRODUCTION_ORIGIN, PhotoAuthorizationError } from "@niho/photo-cloud-session/server";
import { describe, expect, it } from "vitest";

import { PENDING_INVITE_BINDING_COOKIE_NAME, PENDING_INVITE_COOKIE_NAME, createPendingInviteHandler } from "../src/server";
import { createBrowserSharedAlbumMembershipClient, createSharedAlbumMockServer } from "../src/sharing";
import { FakeIdentity, defaultActor } from "./support";

const PHOTO_ORIGIN = "https://photo.example.test";
const PREFIX = "/synthetic-sharing-backend";
const OWNER = "synthetic-user-owner";
const MEMBER = defaultActor().userId;
const OTHER = "synthetic-user-other";
const START = Date.parse("2026-11-07T00:00:00.000Z");
const PENDING_PATH = "/cloud/sharing/v1/invites/pending";

function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

type MockServer = ReturnType<typeof createSharedAlbumMockServer>;

function setup(options: { keys?: readonly Uint8Array[]; upstream?: (request: Request) => Promise<Response>; server?: MockServer } = {}) {
  let clock = START;
  let secrets = 0;
  const server = options.server ?? createSharedAlbumMockServer({
    users: [
      { userId: OWNER, displayName: "Synthetic Owner" },
      { userId: MEMBER, displayName: "Synthetic Member" },
      { userId: OTHER, displayName: "Synthetic Other" },
    ],
    now: () => clock,
    newSecret: () => `synthetic-secret-${++secrets}-${"x".repeat(22)}`,
  });
  // Who is signed in on the browser (the auth service's verified session); null = signed out.
  let signedIn: string | null = null;
  const auth: Pick<PhotoAuthService, "withAuthorizedCredential"> = {
    async withAuthorizedCredential<T>(_request: Request, captured: CapturedPhotoActor | null, perform: (credential: string, actor: ReturnType<typeof defaultActor>) => Promise<T>): Promise<T> {
      if (signedIn === null) throw new PhotoAuthorizationError(401, "unauthenticated");
      const actor = defaultActor({ userId: signedIn });
      if (captured !== null && captured.userId !== actor.userId) throw new PhotoAuthorizationError(403, "scope_changed");
      return await perform(`server-only-credential-${signedIn}`, actor);
    },
  };
  const upstreamRequests: { url: string; headers: Headers; body: string }[] = [];
  const handler = createPendingInviteHandler({
    photoOrigin: PHOTO_ORIGIN,
    authService: auth,
    upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
    upstreamPathPrefix: PREFIX,
    keys: options.keys ?? [key(1)],
    now: () => clock,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.clone().text();
      upstreamRequests.push({ url: request.url, headers: request.headers, body });
      if (options.upstream) return await options.upstream(request);
      // The synthetic server stands in for the upstream: same suffix under its own prefix.
      const url = new URL(request.url);
      expect(url.origin).toBe(NIHO_PRODUCTION_ORIGIN);
      return await server.fetch(new Request(`${PHOTO_ORIGIN}/cloud/sharing/v1${url.pathname.slice(PREFIX.length)}`, { method: request.method, headers: request.headers, body }));
    },
  });

  // A browser: one cookie jar for this origin, honouring the pending cookie's path and Max-Age.
  const jar = new Map<string, { value: string; path: string }>();
  const setCookies: string[] = [];
  const browserFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), PHOTO_ORIGIN);
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    if (!headers.has("Origin")) headers.set("Origin", PHOTO_ORIGIN);
    const cookies = [...jar.entries()].filter(([, cookie]) => cookie.path === "/" || url.pathname === cookie.path || url.pathname.startsWith(`${cookie.path}/`));
    // An explicit Cookie header stands for a copied or forged cookie and replaces the jar.
    if (cookies.length > 0 && !headers.has("Cookie")) headers.set("Cookie", cookies.map(([name, cookie]) => `${name}=${cookie.value}`).join("; "));
    const response = await handler(new Request(url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
    if (response === null) throw new Error("unexpected unhandled route");
    for (const cookie of response.headers.getSetCookie()) {
      setCookies.push(cookie);
      const [pair = "", ...attributes] = cookie.split(";").map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const path = attributes.find((attribute) => attribute.startsWith("Path="))?.slice(5) ?? "/";
      if (attributes.includes("Max-Age=0")) jar.delete(name);
      else jar.set(name, { value, path });
    }
    return response;
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    await browserFetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const hold = async (secret: string, headers: Record<string, string> = {}) => await post(PENDING_PATH, { secret }, headers);
  const joinPending = async (headers: Record<string, string> = {}) => await post(`${PENDING_PATH}/join`, {}, headers);
  const createInvite = async (role: "contributor" | "viewer" = "contributor") => {
    const owner = server.clientFor(OWNER);
    let n = 0;
    const album = (await owner.request("albums.create", { name: "Synthetic album" }, { signal: new AbortController().signal, idempotencyKey: `album-${++n}-${Math.random()}` })).value;
    const created = (await owner.request("invites.create", { albumId: album.id, role }, { signal: new AbortController().signal, idempotencyKey: `invite-${Math.random()}` })).value;
    return { album, secret: created.secret as string, link: created.link };
  };
  /** The Cookie header this browser would send to the pending path (to copy, forge or plant cookies). */
  const cookieHeader = (pending = jar.get(PENDING_INVITE_COOKIE_NAME)?.value, binding = jar.get(PENDING_INVITE_BINDING_COOKIE_NAME)?.value): string =>
    [pending === undefined ? null : `${PENDING_INVITE_COOKIE_NAME}=${pending}`, binding === undefined ? null : `${PENDING_INVITE_BINDING_COOKIE_NAME}=${binding}`].filter(Boolean).join("; ");
  return {
    server, handler, jar, setCookies, upstreamRequests, hold, joinPending, post, browserFetch, createInvite, cookieHeader,
    signIn: (user: string | null) => { signedIn = user; },
    advance: (ms: number) => { clock += ms; },
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("pending invite in the BFF (B00 PENDING_INVITE_ROUTES, B05 #246)", () => {
  it("holds the secret in an encrypted httpOnly cookie and joins with it after sign-in, then deletes it", async () => {
    const t = setup();
    const { album, secret } = await t.createInvite();

    const held = await t.hold(secret);
    expect(held.status).toBe(200);
    expect(await body(held)).toEqual({ expiresAt: "2026-11-07T00:15:00.000Z" });
    expect(held.headers.get("Cache-Control")).toBe("no-store");
    const cookie = t.setCookies[0] as string;
    expect(cookie.startsWith(`${PENDING_INVITE_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain("; Max-Age=900; Path=/cloud/sharing/v1/invites/pending; HttpOnly; Secure; SameSite=Lax");
    // The host-only binding carries the pending ID only.
    expect(t.setCookies[1]).toMatch(new RegExp(`^${PENDING_INVITE_BINDING_COOKIE_NAME}=[A-Za-z0-9_-]{22}; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax$`, "u"));
    // Neither the secret nor any encoding of it is readable in the cookie.
    const value = t.jar.get(PENDING_INVITE_COOKIE_NAME)?.value as string;
    expect(cookie).not.toContain(secret);
    expect(Buffer.from(value, "base64url").toString("latin1")).not.toContain(secret);
    expect(Buffer.from(value, "base64url").toString("latin1")).not.toContain("synthetic-secret");
    expect(t.upstreamRequests).toHaveLength(0);

    t.signIn(MEMBER);
    const client = createBrowserSharedAlbumMembershipClient({ identity: new FakeIdentity(), fetch: t.browserFetch, now: () => START });
    const joined = await client.joinPending(new AbortController().signal);
    expect(joined).toMatchObject({ joined: true, album: { id: album.id, memberCount: 2 }, membership: { role: "contributor", member: { isSelf: true } } });
    expect(t.jar.size).toBe(0);
    expect(t.setCookies.slice(-2)).toEqual([
      `${PENDING_INVITE_COOKIE_NAME}=; Max-Age=0; Path=/cloud/sharing/v1/invites/pending; HttpOnly; Secure; SameSite=Lax`,
      `${PENDING_INVITE_BINDING_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);

    // Upstream got the normal invites.join under the verified session, keyed by the pending ID, with the secret in the body.
    expect(t.upstreamRequests).toHaveLength(1);
    const upstream = t.upstreamRequests[0] as (typeof t.upstreamRequests)[number];
    expect(upstream.url).toBe(`${NIHO_PRODUCTION_ORIGIN}${PREFIX}/invites/join`);
    expect(upstream.url).not.toContain(secret);
    expect(JSON.parse(upstream.body)).toEqual({ secret });
    expect(upstream.headers.get("Authorization")).toBe(`Bearer server-only-credential-${MEMBER}`);
    expect(upstream.headers.get("Idempotency-Key")).toMatch(/^pending-invite-[A-Za-z0-9_-]{22}$/u);
    expect(t.server.memberJoinedEvents(OWNER)).toHaveLength(1);
  });

  it("keeps the cookie while signed out and joins once signed in", async () => {
    const t = setup();
    const { album, secret } = await t.createInvite("viewer");
    await t.hold(secret);
    const before = await t.joinPending();
    expect(before.status).toBe(401);
    expect((await body(before)).error).toMatchObject({ code: "unauthenticated", retryable: false });
    expect(before.headers.getSetCookie()).toEqual([]);
    expect(t.jar.has(PENDING_INVITE_COOKIE_NAME)).toBe(true);
    expect(t.upstreamRequests).toHaveLength(0);

    t.signIn(MEMBER);
    const after = await t.joinPending();
    expect(after.status).toBe(200);
    expect(await body(after)).toMatchObject({ joined: true, album: { id: album.id }, membership: { role: "viewer" } });
  });

  it("refuses a copied cookie, an expired one, someone else's and a missing one, deleting it each time", async () => {
    const t = setup();
    const { secret } = await t.createInvite();
    t.signIn(MEMBER);

    // Copied: the same cookies used twice.
    await t.hold(secret);
    const copy = t.cookieHeader();
    expect((await t.joinPending()).status).toBe(200);
    const replayed = await t.joinPending({ Cookie: copy });
    expect(replayed.status).toBe(410);
    expect((await body(replayed)).error).toMatchObject({ code: "invite_unavailable", retryable: false });
    expect(replayed.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(t.upstreamRequests).toHaveLength(1);

    // Expired after 15 minutes.
    await t.hold(secret);
    t.advance(15 * 60 * 1000);
    const expired = await t.joinPending();
    expect(expired.status).toBe(410);
    expect(t.jar.has(PENDING_INVITE_COOKIE_NAME)).toBe(false);

    // Held while signed in as one person, joined by another on the same browser.
    await t.hold(secret);
    const own = await t.joinPending();
    expect(own.status).toBe(200);
    t.signIn(MEMBER);
    await t.hold(secret, { "X-NIHO-Photo-Actor-Id": MEMBER, "X-NIHO-Photo-Session-Id": "parent-1", "X-NIHO-Photo-Session-Epoch": "epoch-1" });
    t.signIn(OTHER);
    const other = await t.joinPending();
    expect(other.status).toBe(410);
    expect(t.jar.has(PENDING_INVITE_COOKIE_NAME)).toBe(false);

    // No cookie at all.
    const none = await t.joinPending();
    expect(none.status).toBe(410);
    expect(t.upstreamRequests).toHaveLength(2);
  });

  it("opens only cookies sealed with its keys: tampered or foreign ones are unavailable, a previous key still opens", async () => {
    // Before the rotation the BFF sealed with key 2; after it, key 3 seals and key 2 still opens.
    const old = setup({ keys: [key(2)] });
    const rotated = setup({ keys: [key(3), key(2)] });
    const invite = await rotated.createInvite();
    await old.hold(invite.secret);
    const sealedWithOld = old.cookieHeader();
    rotated.signIn(MEMBER);
    const previous = await rotated.joinPending({ Cookie: sealedWithOld });
    expect(previous.status).toBe(200);
    expect(rotated.upstreamRequests).toHaveLength(1);

    await rotated.hold(invite.secret);
    const sealedWithNew = rotated.jar.get(PENDING_INVITE_COOKIE_NAME)?.value as string;
    const binding = rotated.jar.get(PENDING_INVITE_BINDING_COOKIE_NAME)?.value as string;

    const flipped = Buffer.from(sealedWithNew, "base64url");
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
    for (const forged of [Buffer.from(flipped).toString("base64url"), "not-a-sealed-value", `${sealedWithNew}x`]) {
      const response = await rotated.joinPending({ Cookie: rotated.cookieHeader(forged, binding) });
      expect(response.status).toBe(410);
    }
    // Only the current key seals: a handler with key 2 alone cannot open a cookie sealed with key 3.
    old.signIn(MEMBER);
    expect((await old.joinPending({ Cookie: old.cookieHeader(sealedWithNew, binding) })).status).toBe(410);
    // Without the host-only binding, or with one that matches no sealed cookie, nothing is opened.
    expect((await rotated.joinPending({ Cookie: `${PENDING_INVITE_COOKIE_NAME}=${sealedWithNew}` })).status).toBe(410);
    expect((await rotated.joinPending({ Cookie: rotated.cookieHeader(sealedWithNew, "A".repeat(22)) })).status).toBe(410);
    expect(rotated.upstreamRequests).toHaveLength(1);
  });

  it("ignores a same-named cookie planted from another host: only the one bound to this browser is used", async () => {
    const t = setup();
    const victimInvite = await t.createInvite("viewer");
    const attackerInvite = await t.createInvite("contributor");
    // The attacker holds their own invite (a validly sealed cookie) and plants it under the parent domain.
    await t.hold(attackerInvite.secret);
    const planted = t.jar.get(PENDING_INVITE_COOKIE_NAME)?.value as string;
    t.jar.clear();
    // The victim opens their link signed out, then signs in. The browser sends both same-named cookies.
    await t.hold(victimInvite.secret);
    const own = t.jar.get(PENDING_INVITE_COOKIE_NAME)?.value as string;
    const binding = t.jar.get(PENDING_INVITE_BINDING_COOKIE_NAME)?.value as string;
    t.signIn(MEMBER);
    const joined = await t.joinPending({ Cookie: `${PENDING_INVITE_COOKIE_NAME}=${planted}; ${t.cookieHeader(own, binding)}` });
    expect(joined.status).toBe(200);
    expect(await body(joined)).toMatchObject({ album: { id: victimInvite.album.id }, membership: { role: "viewer" } });
    expect(JSON.parse(t.upstreamRequests[0]?.body as string)).toEqual({ secret: victimInvite.secret });

    // A planted cookie alone (with the victim's binding) is not used, and cannot be made to look bound.
    await t.hold(victimInvite.secret);
    const nextBinding = t.jar.get(PENDING_INVITE_BINDING_COOKIE_NAME)?.value as string;
    expect((await t.joinPending({ Cookie: t.cookieHeader(planted, nextBinding) })).status).toBe(410);
    expect(t.upstreamRequests).toHaveLength(1);
  });

  it("refuses the same cookies used on another instance (the upstream replays the pending ID's key)", async () => {
    const first = setup();
    const second = setup({ server: first.server });
    const { secret } = await first.createInvite();
    await first.hold(secret);
    const copy = first.cookieHeader();
    first.signIn(MEMBER);
    second.signIn(MEMBER);
    expect((await first.joinPending()).status).toBe(200);
    // The second instance has not seen this pending ID, so it asks upstream with the same key and gets a replay.
    const replayed = await second.joinPending({ Cookie: copy });
    expect(replayed.status).toBe(410);
    expect((await body(replayed)).error).toMatchObject({ code: "invite_unavailable" });
    expect(second.upstreamRequests).toHaveLength(1);
    expect(second.upstreamRequests[0]?.headers.get("Idempotency-Key")).toBe(first.upstreamRequests[0]?.headers.get("Idempotency-Key"));
    expect(first.server.memberJoinedEvents(OWNER)).toHaveLength(1);
  });

  it("refuses cross-site and malformed requests without setting a cookie", async () => {
    const t = setup();
    const { secret } = await t.createInvite();
    const cases: [string, Promise<Response>, number][] = [
      ["other origin", t.hold(secret, { Origin: "https://attacker.example.test" }), 403],
      ["cross-site fetch", t.hold(secret, { "Sec-Fetch-Site": "cross-site" }), 403],
      ["form post", t.browserFetch(PENDING_PATH, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ secret }) }), 400],
      ["idempotency key", t.hold(secret, { "Idempotency-Key": "synthetic-key" }), 400],
      ["query", t.post(`${PENDING_PATH}?secret=x`, { secret }), 400],
      ["extra field", t.post(PENDING_PATH, { secret, role: "owner" }), 400],
      ["missing secret", t.post(PENDING_PATH, {}), 400],
      ["malformed secret", t.hold("has spaces in it"), 400],
      ["not json", t.browserFetch(PENDING_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), 400],
      ["oversized", t.hold("x".repeat(4096)), 400],
      ["join with a body", t.post(`${PENDING_PATH}/join`, { secret }), 400],
      ["partial capture", t.hold(secret, { "X-NIHO-Photo-Actor-Id": MEMBER }), 400],
    ];
    for (const [name, pending, status] of cases) {
      const response = await pending;
      expect({ name, status: response.status }).toEqual({ name, status });
      expect(response.headers.getSetCookie()).toEqual([]);
      const text = await response.text();
      expect(text).not.toContain(secret);
    }
    expect(t.jar.size).toBe(0);
    // Other paths and methods are not this handler's.
    expect(await t.handler(new Request(`${PHOTO_ORIGIN}/cloud/sharing/v1/invites/join`, { method: "POST" }))).toBeNull();
    expect(await t.handler(new Request(`${PHOTO_ORIGIN}${PENDING_PATH}`, { method: "GET" }))).toBeNull();
  });

  it("passes the upstream's refusal through, maps a failed upstream to unavailable, and deletes the cookie either way", async () => {
    const t = setup();
    const { album, secret, link } = await t.createInvite();
    await t.server.clientFor(OWNER).request("invites.revoke", { albumId: album.id, inviteLinkId: link.id }, { signal: new AbortController().signal, idempotencyKey: "revoke-1" });
    await t.hold(secret);
    t.signIn(MEMBER);
    const revoked = await t.joinPending();
    expect(revoked.status).toBe(410);
    expect((await body(revoked)).error).toMatchObject({ code: "invite_unavailable" });
    expect(t.jar.has(PENDING_INVITE_COOKIE_NAME)).toBe(false);

    const failing = setup({ upstream: async () => { throw new TypeError("Failed to fetch"); } });
    const invite = await failing.createInvite();
    await failing.hold(invite.secret);
    failing.signIn(MEMBER);
    const unavailable = await failing.joinPending();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(invite.secret);
    expect(failing.jar.has(PENDING_INVITE_COOKIE_NAME)).toBe(false);

    const forged = setup({ upstream: async () => new Response(JSON.stringify({ value: { joined: true }, replayed: false }), { status: 200, headers: { "Content-Type": "application/json" } }) });
    const other = await forged.createInvite();
    await forged.hold(other.secret);
    forged.signIn(MEMBER);
    const malformed = await forged.joinPending();
    expect(malformed.status).toBe(503);
    expect(forged.jar.has(PENDING_INVITE_COOKIE_NAME)).toBe(false);
  });

  it("answers the browser client with the contract's errors", async () => {
    const t = setup();
    t.signIn(MEMBER);
    const client = createBrowserSharedAlbumMembershipClient({ identity: new FakeIdentity(), fetch: t.browserFetch, now: () => START });
    const error = await client.joinPending(new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ error: { code: "invite_unavailable", retryable: false } });
  });

  it("starts only with a complete private configuration", () => {
    const base = {
      photoOrigin: PHOTO_ORIGIN,
      authService: { withAuthorizedCredential: async () => await Promise.reject(new Error("unused")) } as Pick<PhotoAuthService, "withAuthorizedCredential">,
      upstreamOrigin: NIHO_PRODUCTION_ORIGIN,
      upstreamPathPrefix: PREFIX,
      keys: [key(1)],
    } as const;
    expect(() => createPendingInviteHandler(base)).not.toThrow();
    for (const broken of [
      { keys: [] },
      { keys: [new Uint8Array(16).fill(1)] },
      { keys: [new Uint8Array(32)] },
      { keys: [key(1), key(2), key(3)] },
      { upstreamPathPrefix: "/trailing/" },
      { upstreamPathPrefix: "relative" },
      { upstreamPathPrefix: "/a/../b" },
      { photoOrigin: "http://photo.example.test" },
      { photoOrigin: `${PHOTO_ORIGIN}/path` },
      { upstreamOrigin: "https://other.example.test" },
    ]) {
      expect(() => createPendingInviteHandler({ ...base, ...broken } as never)).toThrow("invalid pending invite configuration");
    }
  });
});
