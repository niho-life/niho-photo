import { describe, expect, it, vi } from "vitest";

import { PersonalPhotoCloudError } from "../src/errors";
import {
  createBrowserSharedAlbumMembershipClient,
  createSharedAlbumMembership,
  createSharedAlbumMockServer,
  sharingRecoveryOf,
  type SharedAlbumMembershipTransport,
} from "../src/sharing";
import { FakeIdentity, defaultActor } from "./support";

const OWNER = "synthetic-user-owner";
const STAFF = "synthetic-user-staff";
const START = Date.parse("2026-11-07T00:00:00.000Z");

function setup() {
  let now = START;
  let secrets = 0;
  let keys = 0;
  const server = createSharedAlbumMockServer({
    users: [{ userId: OWNER, displayName: "Synthetic Owner" }, { userId: STAFF, displayName: "Synthetic Staff" }],
    now: () => now,
    newSecret: () => `synthetic-secret-${++secrets}-${"y".repeat(20)}`,
  });
  const sleep = vi.fn(async () => undefined);
  const membershipFor = (userId: string) =>
    createSharedAlbumMembership({
      // The real browser client over the mock's wire: lost responses surface as fetch TypeErrors.
      client: createBrowserSharedAlbumMembershipClient({ identity: new FakeIdentity(defaultActor({ userId })), fetch: server.fetch, now: () => now }),
      newIdempotencyKey: () => `${userId}-key-${++keys}`,
      sleep,
      now: () => now,
    });
  const signal = new AbortController().signal;
  return {
    server, sleep, signal, owner: membershipFor(OWNER), staff: membershipFor(STAFF),
    advance: (ms: number) => { now += ms; },
    async album() {
      return (await server.clientFor(OWNER).request("albums.create", { name: "Synthetic shared album" }, { signal, idempotencyKey: `album-${++keys}` })).value;
    },
  };
}

describe("shared album membership actions (B05)", () => {
  it("replays a join whose answer was lost with the same key: one membership, one owner notification", async () => {
    const t = setup();
    const album = await t.album();
    const invite = await t.owner.createInvite(album.id, "contributor", t.signal);
    t.server.loseNextResponse();
    const result = await t.staff.join(invite.secret, t.signal);
    expect(result).toMatchObject({ joined: true, membership: { role: "contributor" } });
    expect(t.sleep).toHaveBeenCalledTimes(1);
    expect(t.server.memberJoinedEvents(OWNER)).toHaveLength(1);
    expect((await t.owner.listMembers(album.id, {}, t.signal)).items).toHaveLength(2);
  });

  it("revokes and recreates an invite whose secret was lost with the first answer", async () => {
    const t = setup();
    const album = await t.album();
    t.server.loseNextResponse();
    const invite = await t.owner.createInvite(album.id, "viewer", t.signal);
    const { links } = await t.owner.listInvites(album.id, t.signal);
    // The link whose secret never arrived is revoked; only the recreated one stays usable.
    expect(links.map((link) => [link.id === invite.link.id, link.revoked])).toEqual([[false, true], [true, false]]);
    expect(t.owner.heldSecret(invite.link.id)).toBe(invite.secret);
    expect((await t.staff.join(invite.secret, t.signal)).membership.role).toBe("viewer");
  });

  it("revokes every link whose secret was lost, even when it happens on each recreation", async () => {
    const t = setup();
    const album = await t.album();
    // Every first answer to a new create (a key not seen before) is lost; replays then withhold the secret.
    const lossyFor = (losses: number) => {
      const seenKeys = new Set<string>();
      let remaining = losses;
      const fetchLossy: typeof fetch = async (input, init) => {
        const request = new Request(new URL(String(input), "https://photo.example.test"), init);
        const key = request.headers.get("Idempotency-Key");
        // invites.create is `POST /albums/{albumId}/invites`.
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/invites") && key !== null && !seenKeys.has(key)) {
          seenKeys.add(key);
          if (remaining-- > 0) t.server.loseNextResponse();
        }
        return await t.server.fetch(request);
      };
      return createSharedAlbumMembership({
        client: createBrowserSharedAlbumMembershipClient({ identity: new FakeIdentity(defaultActor({ userId: OWNER })), fetch: fetchLossy, now: () => START }),
        sleep: t.sleep,
        now: () => START,
      });
    };

    const invite = await lossyFor(2).createInvite(album.id, "contributor", t.signal);
    let { links } = await t.owner.listInvites(album.id, t.signal);
    expect(links.filter((link) => !link.revoked).map((link) => link.id)).toEqual([invite.link.id]);
    expect(links.filter((link) => link.revoked)).toHaveLength(2);

    await expect(lossyFor(Number.POSITIVE_INFINITY).createInvite(album.id, "viewer", t.signal)).rejects.toMatchObject({ code: "unavailable" });
    ({ links } = await t.owner.listInvites(album.id, t.signal));
    // No viewer link is left usable without anyone holding its secret.
    expect(links.filter((link) => link.role === "viewer" && !link.revoked)).toEqual([]);
    expect(links.filter((link) => link.role === "viewer")).toHaveLength(3);
  });

  it("forgets a held secret once its link has expired, without needing another listing", async () => {
    const t = setup();
    const album = await t.album();
    const invite = await t.owner.createInvite(album.id, "viewer", t.signal);
    t.advance(7 * 24 * 60 * 60 * 1000 - 1);
    expect(t.owner.heldSecret(invite.link.id)).toBe(invite.secret);
    t.advance(1);
    expect(t.owner.heldSecret(invite.link.id)).toBeNull();
  });

  it("reuses a usable link whose secret this session holds and creates one otherwise", async () => {
    const t = setup();
    const album = await t.album();
    const first = await t.owner.ensureInvite(album.id, "contributor", t.signal);
    expect(await t.owner.ensureInvite(album.id, "contributor", t.signal)).toEqual(first);
    const viewer = await t.owner.ensureInvite(album.id, "viewer", t.signal);
    expect(viewer.link.id).not.toBe(first.link.id);

    await t.owner.revokeInvite(album.id, first.link.id, t.signal);
    expect(t.owner.heldSecret(first.link.id)).toBeNull();
    const second = await t.owner.ensureInvite(album.id, "contributor", t.signal);
    expect(second.link.id).not.toBe(first.link.id);

    // Expired links are not reused, and their secrets are dropped.
    t.advance(7 * 24 * 60 * 60 * 1000);
    const third = await t.owner.ensureInvite(album.id, "contributor", t.signal);
    expect(third.link.id).not.toBe(second.link.id);
    expect(t.owner.heldSecret(second.link.id)).toBeNull();

    t.owner.forgetSecrets();
    expect(t.owner.heldSecret(third.link.id)).toBeNull();
    expect((await t.owner.ensureInvite(album.id, "contributor", t.signal)).link.id).not.toBe(third.link.id);
  });

  it("changes roles, removes and leaves through the same actions", async () => {
    const t = setup();
    const album = await t.album();
    const invite = await t.owner.createInvite(album.id, "viewer", t.signal);
    const joined = await t.staff.join(invite.secret, t.signal);
    const promoted = await t.owner.changeRole(album.id, joined.membership.id, joined.membership.revision, "contributor", t.signal);
    expect(promoted.role).toBe("contributor");
    expect((await t.staff.leave(album.id, t.signal)).state).toBe("left");
    expect((await t.staff.join(invite.secret, t.signal)).membership.role).toBe("viewer");
    const removed = await t.owner.removeMember(album.id, joined.membership.id, t.signal);
    expect(removed.state).toBe("removed");
  });

  it("does not retry refusals, long rate limits or aborted actions, and maps each to the contract's next step", async () => {
    const t = setup();
    const album = await t.album();
    await expect(t.staff.join("synthetic-unknown-secret", t.signal)).rejects.toMatchObject({ error: { code: "invite_unavailable" } });
    expect(t.sleep).not.toHaveBeenCalled();

    const calls: string[] = [];
    const limited: SharedAlbumMembershipTransport = {
      async request(operation, _request, options) {
        calls.push(`${operation}:${"idempotencyKey" in options ? options.idempotencyKey : "-"}`);
        throw { error: { code: "rate_limited", requestId: "synthetic-request", retryable: true, retryAfterSeconds: 600 } };
      },
      joinPending: async () => await Promise.reject(new Error("unused")),
    };
    const service = createSharedAlbumMembership({ client: limited, newIdempotencyKey: () => "fixed-key", sleep: t.sleep });
    const error = await service.join("synthetic-secret", t.signal).catch((caught: unknown) => caught);
    expect(calls).toEqual(["invites.join:fixed-key"]);
    expect(sharingRecoveryOf(error)).toBe("retrySameKey");

    const controller = new AbortController();
    controller.abort();
    await expect(t.owner.listMembers(album.id, {}, controller.signal)).rejects.toBeInstanceOf(Error);

    expect(sharingRecoveryOf({ error: { code: "invite_unavailable", requestId: "r", retryable: false } })).toBe("askOwner");
    expect(sharingRecoveryOf({ error: { code: "role_forbidden", requestId: "r", retryable: false } })).toBe("refreshAccess");
    expect(sharingRecoveryOf(new PersonalPhotoCloudError("scope_changed"))).toBe("reauthenticate");
    expect(sharingRecoveryOf(new PersonalPhotoCloudError("unavailable"))).toBe("retrySameKey");
    expect(sharingRecoveryOf(new Error("other"))).toBeNull();
  });

  it("replays transient failures with the same key up to the attempt limit", async () => {
    const t = setup();
    const keys: (string | null)[] = [];
    let failures = 2;
    let pendingJoins = 0;
    const flaky: SharedAlbumMembershipTransport = {
      async request(_operation, _request, options) {
        keys.push("idempotencyKey" in options ? options.idempotencyKey ?? null : null);
        if (failures-- > 0) throw { error: { code: "temporarily_unavailable", requestId: "synthetic-request", retryable: true } };
        return { value: { id: "m", albumId: "a" }, replayed: keys.length > 1 } as never;
      },
      async joinPending() {
        pendingJoins += 1;
        throw { error: { code: "temporarily_unavailable", requestId: "synthetic-request", retryable: true } };
      },
    };
    let counter = 0;
    const service = createSharedAlbumMembership({ client: flaky, newIdempotencyKey: () => `key-${++counter}`, sleep: t.sleep });
    await service.leave("a", t.signal);
    expect(keys).toEqual(["key-1", "key-1", "key-1"]);
    // The BFF deletes the pending invite after one attempt: a pending join is never replayed.
    await expect(service.joinPending(t.signal)).rejects.toMatchObject({ error: { code: "temporarily_unavailable" } });
    expect(pendingJoins).toBe(1);

    failures = 5;
    keys.length = 0;
    await expect(service.leave("a", t.signal)).rejects.toMatchObject({ error: { code: "temporarily_unavailable" } });
    expect(keys).toEqual(["key-2", "key-2", "key-2"]);
  });
});
