import { describe, expect, it, vi } from "vitest";

import { PersonalPhotoCloudError } from "../src/errors";
import {
  SHARING_CLOUD_PATH_PREFIX,
  createBrowserSharedAlbumMembershipClient,
  createSharedAlbumMockServer,
  type SharedAlbumMembershipClient,
} from "../src/sharing";
import { FakeIdentity, defaultActor } from "./support";

const OWNER = "synthetic-user-owner";
const STAFF = "synthetic-user-staff";
const NOW = Date.parse("2026-11-07T00:00:00.000Z");

function setup() {
  const server = createSharedAlbumMockServer({
    users: [{ userId: OWNER, displayName: "Synthetic Owner" }, { userId: STAFF, displayName: "Synthetic Staff" }],
    now: () => NOW,
    newSecret: () => "synthetic-invite-secret-value",
  });
  const seen: Request[] = [];
  let tamper: ((response: Response, request: Request) => Promise<Response> | Response) | null = null;
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), "https://photo.example.test"), init);
    seen.push(request.clone());
    const response = await server.fetch(request);
    return tamper ? await tamper(response, request) : response;
  });
  const clientFor = (userId: string, identity = new FakeIdentity(defaultActor({ userId }))): SharedAlbumMembershipClient =>
    createBrowserSharedAlbumMembershipClient({ identity, fetch: fetchSpy as typeof fetch, now: () => NOW });
  const signal = new AbortController().signal;
  let keys = 0;
  const key = () => ({ signal, idempotencyKey: `key-${++keys}` });
  return {
    server, seen, fetchSpy, clientFor, signal, key,
    setTamper: (next: typeof tamper) => { tamper = next; },
    async album() {
      return (await server.clientFor(OWNER).request("albums.create", { name: "Synthetic shared album" }, key())).value;
    },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("browser shared album membership client (B05)", () => {
  it("sends each operation on the contract's route with the session headers, keys only on mutations", async () => {
    const t = setup();
    const album = await t.album();
    const owner = t.clientFor(OWNER);
    const created = await owner.request("invites.create", { albumId: album.id, role: "contributor" }, t.key());
    expect(created).toMatchObject({ replayed: false, value: { secret: "synthetic-invite-secret-value", link: { role: "contributor" } } });
    await owner.request("invites.list", { albumId: album.id }, { signal: t.signal });

    const [create, list] = t.seen;
    expect(create.method).toBe("POST");
    expect(new URL(create.url).pathname).toBe(`${SHARING_CLOUD_PATH_PREFIX}/albums/${album.id}/invites`);
    expect(create.headers.get("Idempotency-Key")).toBe("key-2");
    expect(create.headers.get("X-NIHO-Photo-Actor-Id")).toBe(OWNER);
    expect(create.headers.get("X-NIHO-Photo-Session-Epoch")).toBe("epoch-1");
    expect(create.credentials).toBe("same-origin");
    // The album is in the path; the body carries the remaining fields only.
    expect(await create.json()).toEqual({ role: "contributor" });
    expect(list.method).toBe("GET");
    expect(new URL(list.url).pathname).toBe(`${SHARING_CLOUD_PATH_PREFIX}/albums/${album.id}/invites`);
    expect(await list.text()).toBe("");
    expect(list.headers.get("Idempotency-Key")).toBeNull();

    const staff = t.clientFor(STAFF);
    const joined = await staff.request("invites.join", { secret: created.value.secret as string }, t.key());
    expect(joined.value).toMatchObject({ joined: true, membership: { role: "contributor", member: { displayName: "Synthetic Staff", isSelf: true } } });
    const join = t.seen[2];
    // The secret travels in the body only, never in the URL.
    expect(join.method).toBe("POST");
    expect(new URL(join.url).pathname).toBe(`${SHARING_CLOUD_PATH_PREFIX}/invites/join`);
    expect(join.url).not.toContain("synthetic-invite-secret");
    expect(await join.json()).toEqual({ secret: "synthetic-invite-secret-value" });

    // Active members including the owner (B00 memberCount).
    expect(joined.value.album.memberCount).toBe(2);
    t.setTamper(async (response, request) => {
      if (new URL(request.url).pathname !== `${SHARING_CLOUD_PATH_PREFIX}/invites/join`) return response;
      const body = await response.json() as { value: { album: { memberCount: number } } };
      body.value.album.memberCount = 0;
      return json(body);
    });
    expect(((await caught(t.clientFor(STAFF).request("invites.join", { secret: created.value.secret as string }, t.key()))) as PersonalPhotoCloudError).code).toBe("invalid_response");
    t.setTamper(null);

    const members = await owner.request("members.list", { albumId: album.id }, { signal: t.signal });
    expect(members.items.map((member) => member.member)).toEqual([
      { displayName: "Synthetic Owner", isSelf: true },
      { displayName: "Synthetic Staff", isSelf: false },
    ]);
  });

  it("places every membership operation where the route table says, and the server decodes it back", async () => {
    const t = setup();
    const album = await t.album();
    const owner = t.clientFor(OWNER);
    const secret = (await owner.request("invites.create", { albumId: album.id, role: "contributor" }, t.key())).value.secret as string;
    const staff = t.clientFor(STAFF);
    const membership = (await staff.request("invites.join", { secret }, t.key())).value.membership;
    if (!membership) throw new Error("expected a membership");
    const page = await owner.request("members.list", { albumId: album.id, limit: 10 }, { signal: t.signal });
    expect(page.items).toHaveLength(2);
    const changed = await owner.request("members.changeRole", { albumId: album.id, membershipId: membership.id, expectedRevision: membership.revision, role: "viewer" }, t.key());
    const links = await owner.request("invites.list", { albumId: album.id }, { signal: t.signal });
    await owner.request("invites.revoke", { albumId: album.id, inviteLinkId: links.links[0].id }, t.key());
    await owner.request("members.remove", { albumId: album.id, membershipId: changed.value.id }, t.key());
    // A removed member cannot come back through a link; leaving is shown on a second album.
    const second = await t.album();
    const again = (await owner.request("invites.create", { albumId: second.id, role: "viewer" }, t.key())).value.secret as string;
    await staff.request("invites.join", { secret: again }, t.key());
    await staff.request("members.leave", { albumId: second.id }, t.key());

    const placed = await Promise.all(t.seen.map(async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      return [request.method, `${url.pathname.slice(SHARING_CLOUD_PATH_PREFIX.length)}${url.search}`, body === "" ? null : JSON.parse(body)];
    }));
    const a = album.id;
    expect(placed).toEqual([
      ["POST", `/albums/${a}/invites`, { role: "contributor" }],
      ["POST", "/invites/join", { secret }],
      ["GET", `/albums/${a}/members?limit=10`, null],
      ["POST", `/albums/${a}/members/${membership.id}/role`, { expectedRevision: membership.revision, role: "viewer" }],
      ["GET", `/albums/${a}/invites`, null],
      ["POST", `/albums/${a}/invites/${links.links[0].id}/revoke`, {}],
      ["DELETE", `/albums/${a}/members/${changed.value.id}`, null],
      ["POST", `/albums/${second.id}/invites`, { role: "viewer" }],
      ["POST", "/invites/join", { secret: again }],
      ["POST", `/albums/${second.id}/leave`, {}],
    ]);
  });

  it("refuses to send other operations, extra fields, or a key on the wrong kind of operation", async () => {
    const t = setup();
    const album = await t.album();
    const owner = t.clientFor(OWNER);
    const local = async (promise: Promise<unknown>) => ((await caught(promise)) as PersonalPhotoCloudError).code;
    expect(await local(owner.request("albums.get" as never, { albumId: album.id } as never, { signal: t.signal } as never))).toBe("unsupported");
    expect(await local(owner.request("invites.create", { albumId: album.id, role: "contributor", ownerId: OWNER } as never, t.key()))).toBe("invalid_response");
    expect(await local(owner.request("invites.create", { albumId: album.id, role: "owner" as never }, t.key()))).toBe("invalid_response");
    expect(await local(owner.request("invites.create", { albumId: album.id, role: "viewer" }, { signal: t.signal } as never))).toBe("invalid_response");
    expect(await local(owner.request("members.list", { albumId: album.id }, t.key() as never))).toBe("invalid_response");
    expect(await local(owner.request("members.list", { albumId: album.id, limit: 101 }, { signal: t.signal }))).toBe("invalid_response");
    expect(t.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a member list that carries another member's user ID or any extra person field", async () => {
    const t = setup();
    const album = await t.album();
    const owner = t.clientFor(OWNER);
    t.setTamper(async (response) => {
      const body = await response.json() as { items: { member: Record<string, unknown> }[] };
      body.items[0].member.userId = OWNER;
      return json(body);
    });
    expect(((await caught(owner.request("members.list", { albumId: album.id }, { signal: t.signal }))) as PersonalPhotoCloudError).code).toBe("invalid_response");
  });

  it("rejects forged display hints, a first create without a secret, and a replay that resends it", async () => {
    const t = setup();
    const album = await t.album();
    const secret = (await t.server.clientFor(OWNER).request("invites.create", { albumId: album.id, role: "viewer" }, t.key())).value.secret as string;
    const staff = t.clientFor(STAFF);
    t.setTamper(async (response, request) => {
      if (new URL(request.url).pathname !== `${SHARING_CLOUD_PATH_PREFIX}/invites/join`) return response;
      const body = await response.json() as { value: { album: { access: { permissions: Record<string, boolean> } } } };
      body.value.album.access.permissions.addItem = true; // a viewer is never allowed to add
      return json(body);
    });
    expect(((await caught(staff.request("invites.join", { secret }, t.key()))) as PersonalPhotoCloudError).code).toBe("invalid_response");

    const owner = t.clientFor(OWNER);
    t.setTamper(async (response) => {
      const body = await response.json() as { replayed: boolean; value: { secret: string | null } };
      body.value.secret = null;
      return json(body);
    });
    expect(((await caught(owner.request("invites.create", { albumId: album.id, role: "viewer" }, t.key()))) as PersonalPhotoCloudError).code).toBe("invalid_response");
    t.setTamper(async (response) => {
      const body = await response.json() as { replayed: boolean };
      body.replayed = true;
      return json(body);
    });
    expect(((await caught(owner.request("invites.create", { albumId: album.id, role: "viewer" }, t.key()))) as PersonalPhotoCloudError).code).toBe("invalid_response");
  });

  it("rejects answers whose times or join record contradict themselves", async () => {
    const t = setup();
    const album = await t.album();
    const secret = (await t.server.clientFor(OWNER).request("invites.create", { albumId: album.id, role: "viewer" }, t.key())).value.secret as string;
    const staff = t.clientFor(STAFF);
    const code = async (promise: Promise<unknown>) => ((await caught(promise)) as PersonalPhotoCloudError).code;
    t.setTamper(async (response) => {
      const body = await response.json() as { value: { membership: { joinedVia: string | null } } };
      body.value.membership.joinedVia = null; // a new join must name its link
      return json(body);
    });
    expect(await code(staff.request("invites.join", { secret }, t.key()))).toBe("invalid_response");

    const owner = t.clientFor(OWNER);
    t.setTamper(async (response) => {
      const body = await response.json() as { links: { revoked: boolean; revokedAt: string | null; createdAt: string }[] };
      body.links[0] = { ...body.links[0], revoked: true, revokedAt: "2026-11-06T00:00:00.000Z" }; // revoked before it existed
      return json(body);
    });
    expect(await code(owner.request("invites.list", { albumId: album.id }, { signal: t.signal }))).toBe("invalid_response");
    t.setTamper(async (response) => {
      const body = await response.json() as { items: { state: string; endedAt: string | null }[] };
      body.items[0] = { ...body.items[0], state: "left", endedAt: "2026-11-06T00:00:00.000Z" }; // ended before joining
      return json(body);
    });
    expect(await code(owner.request("members.list", { albumId: album.id }, { signal: t.signal }))).toBe("invalid_response");
  });

  it("passes contract errors through and rejects an error whose code does not match its status", async () => {
    const t = setup();
    const album = await t.album();
    const staff = t.clientFor(STAFF);
    const error = await caught(staff.request("invites.join", { secret: "synthetic-unknown-secret" }, t.key()));
    expect(error).toMatchObject({ error: { code: "invite_unavailable", retryable: false } });
    expect(await caught(staff.request("members.list", { albumId: album.id }, { signal: t.signal }))).toMatchObject({ error: { code: "not_found" } });

    t.setTamper(() => json({ error: { code: "invite_unavailable", requestId: "synthetic-request", retryable: false } }, 404));
    expect(((await caught(staff.request("members.list", { albumId: album.id }, { signal: t.signal }))) as PersonalPhotoCloudError).code).toBe("invalid_response");
    t.setTamper(() => json({ error: { code: "share_forbidden", requestId: "synthetic-request", retryable: false } }, 403));
    expect(((await caught(staff.request("members.list", { albumId: album.id }, { signal: t.signal }))) as PersonalPhotoCloudError).code).toBe("invalid_response");
  });

  it("fences the session after an authentication rejection and on an identity change", async () => {
    const t = setup();
    const album = await t.album();
    const owner = t.clientFor(OWNER);
    t.setTamper(() => json({ error: { code: "unauthenticated", requestId: "synthetic-request", retryable: false } }, 401));
    expect(await caught(owner.request("invites.list", { albumId: album.id }, { signal: t.signal }))).toMatchObject({ error: { code: "unauthenticated" } });
    t.setTamper(null);
    expect(((await caught(owner.request("invites.list", { albumId: album.id }, { signal: t.signal }))) as PersonalPhotoCloudError).code).toBe("scope_changed");

    const identity = new FakeIdentity(defaultActor({ userId: OWNER }));
    const other = t.clientFor(OWNER, identity);
    await other.request("invites.list", { albumId: album.id }, { signal: t.signal });
    identity.set(defaultActor({ userId: OWNER, sessionEpoch: "epoch-2" }));
    expect(((await caught(other.request("invites.list", { albumId: album.id }, { signal: t.signal }))) as PersonalPhotoCloudError).code).toBe("scope_changed");
  });

  it("is bound to a live browser session and stops after dispose", async () => {
    const t = setup();
    const album = await t.album();
    const create = (actor: ReturnType<typeof defaultActor> | null) => () =>
      createBrowserSharedAlbumMembershipClient({ identity: new FakeIdentity(actor), fetch: t.fetchSpy as typeof fetch, now: () => NOW });
    expect(create(null)).toThrow(PersonalPhotoCloudError);
    expect(create(defaultActor({ userId: OWNER, transport: "mac-bearer" }))).toThrow(PersonalPhotoCloudError);
    expect(create(defaultActor({ userId: OWNER, expiresAt: "2026-11-06T00:00:00.000Z" }))).toThrow(PersonalPhotoCloudError);
    const owner = t.clientFor(OWNER);
    expect(owner.scope).toEqual({ actorId: OWNER, sessionEpoch: "epoch-1" });
    owner.dispose();
    expect(((await caught(owner.request("invites.list", { albumId: album.id }, { signal: t.signal }))) as PersonalPhotoCloudError).code).toBe("disposed");
  });
});
