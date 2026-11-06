import { describe, expect, it } from "vitest";

import { createPhotoCloudSharingPreviewClient } from "niho-photo-editing/cloud-sharing-preview-mock";

import { PersonalPhotoCloudError } from "../src/errors";
import { createSharedAlbumMockServer, type SharedAlbumMockClient } from "../src/sharing";
import type { RenditionUploadRequest, SharingErrorCode } from "../src/sharing/contract";
import { hex, syntheticJpeg } from "./render-support";

const OWNER = "synthetic-user-owner";
const STAFF1 = "synthetic-user-staff-1";
const STAFF2 = "synthetic-user-staff-2";
const OUTSIDER = "synthetic-user-outsider";
const START = Date.parse("2026-11-07T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
/** A synthetic finished JPEG; the server re-decodes it at commit. */
const FILE = syntheticJpeg({ width: 1200, height: 800 });
const RENDITION: RenditionUploadRequest = {
  sizeBytes: FILE.length, sha256: hex(FILE), contentType: "image/jpeg", width: 1200, height: 800,
  metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 },
};

function setup(options: { joinFailures?: number } = {}) {
  let now = START;
  let keys = 0;
  let secrets = 0;
  const server = createSharedAlbumMockServer({
    users: [
      { userId: OWNER, displayName: "Synthetic Owner" },
      { userId: STAFF1, displayName: "Synthetic Staff One" },
      { userId: STAFF2, displayName: "Synthetic Staff Two" },
      { userId: OUTSIDER, displayName: "Synthetic Outsider" },
    ],
    now: () => now,
    newSecret: () => `synthetic-secret-${++secrets}-${"x".repeat(22)}`,
    ...(options.joinFailures === undefined ? {} : { joinAttemptLimit: { failures: options.joinFailures, windowSeconds: 600 } }),
  });
  const signal = new AbortController().signal;
  const key = (): { signal: AbortSignal; idempotencyKey: string } => ({ signal, idempotencyKey: `key-${++keys}` });
  const read = { signal };
  const as = (actor: string | null): SharedAlbumMockClient => server.clientFor(actor);
  /** Adds the synthetic file, uploads its bytes and commits it. */
  const addCommitted = async (client: SharedAlbumMockClient, albumId: string) => {
    const added = (await client.request("albumItems.addFile", { albumId, rendition: RENDITION }, key())).value;
    await server.uploader.upload(added.upload?.ticket as never, FILE, "image/jpeg", signal);
    await client.request("albumItems.commitUpload", { albumId, uploadId: added.upload?.upload.id as string }, key());
    return added;
  };
  return {
    server, signal, key, read, as, addCommitted,
    advance: (ms: number) => { now += ms; },
    owner: as(OWNER), staff1: as(STAFF1), staff2: as(STAFF2), outsider: as(OUTSIDER),
  };
}

async function albumWithLinks(t: ReturnType<typeof setup>) {
  const album = (await t.owner.request("albums.create", { name: "Synthetic shared album" }, t.key())).value;
  const contributorLink = (await t.owner.request("invites.create", { albumId: album.id, role: "contributor" }, t.key())).value;
  const viewerLink = (await t.owner.request("invites.create", { albumId: album.id, role: "viewer" }, t.key())).value;
  return { album, contributorLink, viewerLink };
}

async function rejection(promise: Promise<unknown>): Promise<SharingErrorCode | string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PersonalPhotoCloudError) return `local:${error.code}`;
    return (error as { error: { code: SharingErrorCode } }).error.code;
  }
  throw new Error("expected a rejection");
}

/** Every object that looks like a person must be exactly { displayName, isSelf }. */
function people(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) value.forEach((item) => people(item, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("displayName" in record) found.push(record);
    Object.values(record).forEach((child) => people(child, found));
  }
  return found;
}

describe("shared album membership mock (B05)", () => {
  it("owner and two members: join by link, list, change role, leave, remove and revoke", async () => {
    const t = setup();
    const { album, contributorLink, viewerLink } = await albumWithLinks(t);
    expect(contributorLink.secret).not.toBeNull();

    const joined1 = (await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value;
    expect(joined1).toMatchObject({ joined: true, membership: { role: "contributor", state: "active", member: { isSelf: true } } });
    expect(joined1.album.access.role).toBe("contributor");
    const joined2 = (await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key())).value;
    expect(joined2.membership.role).toBe("viewer");

    const listed = await t.owner.request("members.list", { albumId: album.id }, t.read);
    expect(listed.items.map((member) => [member.member.displayName, member.role, member.member.isSelf])).toEqual([
      ["Synthetic Owner", "owner", true],
      ["Synthetic Staff One", "contributor", false],
      ["Synthetic Staff Two", "viewer", false],
    ]);
    // Other members appear by display name and isSelf only; no user IDs anywhere in the answer.
    expect(JSON.stringify(listed)).not.toMatch(/synthetic-user-/u);
    for (const person of people(listed)) expect(Object.keys(person).sort()).toEqual(["displayName", "isSelf"]);

    const staff2Row = listed.items[2];
    const promoted = (await t.owner.request("members.changeRole", { albumId: album.id, membershipId: staff2Row.id, expectedRevision: staff2Row.revision, role: "contributor" }, t.key())).value;
    expect(promoted).toMatchObject({ role: "contributor", revision: staff2Row.revision + 1 });

    const left = (await t.staff1.request("members.leave", { albumId: album.id }, t.key())).value;
    expect(left).toMatchObject({ state: "left", member: { isSelf: true } });
    const removed = (await t.owner.request("members.remove", { albumId: album.id, membershipId: staff2Row.id }, t.key())).value;
    expect(removed.state).toBe("removed");
    expect((await t.owner.request("members.list", { albumId: album.id }, t.read)).items).toHaveLength(1);

    const revoked = (await t.owner.request("invites.revoke", { albumId: album.id, inviteLinkId: contributorLink.link.id }, t.key())).value;
    expect(revoked).toMatchObject({ revoked: true, joinCount: 1 });
    const invites = await t.owner.request("invites.list", { albumId: album.id }, t.read);
    expect(JSON.stringify(invites)).not.toContain("synthetic-secret");
    expect(invites.joins).toHaveLength(2);

    // The owner was told about each new member once.
    expect(t.server.memberJoinedEvents(OWNER).map((event) => [event.member.displayName, event.role])).toEqual([
      ["Synthetic Staff One", "contributor"],
      ["Synthetic Staff Two", "viewer"],
    ]);
  });

  it("rejects expired, revoked and unknown links and signed-out visitors", async () => {
    const t = setup();
    const { album, contributorLink, viewerLink } = await albumWithLinks(t);
    await t.owner.request("invites.revoke", { albumId: album.id, inviteLinkId: viewerLink.link.id }, t.key());
    expect(await rejection(t.staff1.request("invites.join", { secret: viewerLink.secret as string }, t.key()))).toBe("invite_unavailable");
    expect(await rejection(t.staff1.request("invites.join", { secret: "synthetic-unknown-secret" }, t.key()))).toBe("invite_unavailable");
    expect(await rejection(t.as(null).request("invites.join", { secret: contributorLink.secret as string }, t.key()))).toBe("unauthenticated");
    t.advance(7 * DAY);
    expect(await rejection(t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key()))).toBe("invite_unavailable");
    expect(t.server.memberJoinedEvents(OWNER)).toHaveLength(0);
  });

  it("a removed member cannot rejoin through a link made before the removal, but can through a newer one", async () => {
    const t = setup();
    const { album, contributorLink } = await albumWithLinks(t);
    const first = (await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value;
    t.advance(1000);
    await t.owner.request("members.remove", { albumId: album.id, membershipId: first.membership.id }, t.key());
    expect(await rejection(t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key()))).toBe("invite_unavailable");
    expect(await rejection(t.staff1.request("albums.get", { albumId: album.id }, t.read))).toBe("not_found");

    t.advance(1000);
    const newer = (await t.owner.request("invites.create", { albumId: album.id, role: "viewer" }, t.key())).value;
    const rejoined = (await t.staff1.request("invites.join", { secret: newer.secret as string }, t.key())).value;
    expect(rejoined).toMatchObject({ joined: true, membership: { id: first.membership.id, role: "viewer", state: "active" } });

    // Leaving after the rejoin does not reopen links created before the removal.
    await t.staff1.request("members.leave", { albumId: album.id }, t.key());
    expect(await rejection(t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key()))).toBe("invite_unavailable");
    expect((await t.staff1.request("invites.join", { secret: newer.secret as string }, t.key())).value.joined).toBe(true);
  });

  it("a member who left can come back through a usable link", async () => {
    const t = setup();
    const { album, viewerLink } = await albumWithLinks(t);
    await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key());
    await t.staff2.request("members.leave", { albumId: album.id }, t.key());
    expect(await rejection(t.staff2.request("albums.get", { albumId: album.id }, t.read))).toBe("not_found");
    const back = (await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key())).value;
    expect(back).toMatchObject({ joined: true, membership: { role: "viewer", state: "active" } });
  });

  it("opening a link never changes an existing role and never notifies twice", async () => {
    const t = setup();
    const { album, contributorLink, viewerLink } = await albumWithLinks(t);
    await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key());
    const again = (await t.staff2.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value;
    expect(again).toMatchObject({ joined: false, membership: { role: "viewer" } });
    expect((await t.owner.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value).toMatchObject({ joined: false, membership: { role: "owner" } });

    // A replay of the same join (same key and payload) returns the stored answer without a second member event.
    const joinKey = t.key();
    const first = await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, joinKey);
    const replay = await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, joinKey);
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect(replay.value.membership.id).toBe(first.value.membership.id);
    expect(await rejection(t.staff1.request("invites.join", { secret: viewerLink.secret as string }, joinKey))).toBe("idempotency_conflict");
    expect(t.server.memberJoinedEvents(OWNER)).toHaveLength(2);
    const links = await t.owner.request("invites.list", { albumId: album.id }, t.read);
    expect(links.links.map((link) => link.joinCount).sort()).toEqual([1, 1]);
  });

  it("limits repeated failed joins, even for a valid link, until the window passes", async () => {
    const t = setup({ joinFailures: 3 });
    const { contributorLink } = await albumWithLinks(t);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await rejection(t.staff1.request("invites.join", { secret: `synthetic-guess-${attempt}` }, t.key()))).toBe("invite_unavailable");
    }
    expect(await rejection(t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key()))).toBe("rate_limited");
    t.advance(601 * 1000);
    expect((await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value.joined).toBe(true);
  });

  it("only the owner invites and changes roles; nobody demotes or removes the owner", async () => {
    const t = setup();
    const { album, contributorLink, viewerLink } = await albumWithLinks(t);
    const staff1 = (await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value.membership;
    const staff2 = (await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key())).value.membership;
    const ownerRow = (await t.owner.request("members.list", { albumId: album.id }, t.read)).items[0];

    expect(await rejection(t.staff1.request("invites.create", { albumId: album.id, role: "contributor" }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.staff2.request("invites.list", { albumId: album.id }, t.read))).toBe("role_forbidden");
    expect(await rejection(t.staff1.request("members.changeRole", { albumId: album.id, membershipId: staff2.id, expectedRevision: staff2.revision, role: "contributor" }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.staff1.request("members.remove", { albumId: album.id, membershipId: staff2.id }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.owner.request("members.changeRole", { albumId: album.id, membershipId: ownerRow.id, expectedRevision: ownerRow.revision, role: "viewer" }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.owner.request("members.remove", { albumId: album.id, membershipId: ownerRow.id }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.owner.request("members.leave", { albumId: album.id }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.owner.request("members.changeRole", { albumId: album.id, membershipId: staff1.id, expectedRevision: staff1.revision - 1, role: "viewer" }, t.key()))).toBe("revision_conflict");
    // "owner" is never granted, and owner/role claims outside the closed request shape are rejected.
    expect(await rejection(t.owner.request("members.changeRole", { albumId: album.id, membershipId: staff1.id, expectedRevision: staff1.revision, role: "owner" as never }, t.key()))).toBe("invalid_request");
    expect(await rejection(t.staff1.request("invites.join", { secret: contributorLink.secret as string, role: "contributor" } as never, t.key()))).toBe("invalid_request");
    expect(await rejection(t.outsider.request("members.list", { albumId: album.id }, t.read))).toBe("not_found");
  });

  it("gates items by the current role: viewers cannot add, members cannot remove others' items", async () => {
    const t = setup();
    const { album, contributorLink, viewerLink } = await albumWithLinks(t);
    await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key());
    await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key());

    expect(await rejection(t.staff2.request("albumItems.addFile", { albumId: album.id, rendition: RENDITION }, t.key()))).toBe("role_forbidden");
    const ownerAdd = await t.addCommitted(t.owner, album.id);
    const staffAdd = await t.addCommitted(t.staff1, album.id);

    expect(await rejection(t.staff1.request("albumItems.remove", { albumId: album.id, itemId: ownerAdd.item.id }, t.key()))).toBe("role_forbidden");
    expect(await rejection(t.staff2.request("albumItems.remove", { albumId: album.id, itemId: staffAdd.item.id }, t.key()))).toBe("role_forbidden");
    expect((await t.owner.request("albumItems.remove", { albumId: album.id, itemId: staffAdd.item.id }, t.key())).value.state).toBe("removed");
  });

  it("direct IDs and old cursors never reach photos outside the viewer's shared scope", async () => {
    const t = setup();
    const { album, contributorLink } = await albumWithLinks(t);
    const other = (await t.owner.request("albums.create", { name: "Synthetic unshared album" }, t.key())).value;
    const hidden = await t.addCommitted(t.owner, other.id);
    for (let index = 0; index < 2; index += 1) await t.addCommitted(t.owner, album.id);
    const staff1 = (await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value.membership;

    // An item of an album the member is not in, asked through either album, is indistinguishable from missing.
    expect(await rejection(t.staff1.request("albumItems.get", { albumId: album.id, itemId: hidden.item.id }, t.read))).toBe("not_found");
    expect(await rejection(t.staff1.request("albumItems.get", { albumId: other.id, itemId: hidden.item.id }, t.read))).toBe("not_found");
    expect(await rejection(t.outsider.request("albums.get", { albumId: album.id }, t.read))).toBe("not_found");
    // Another member's preparing item is not visible to a contributor.
    const preparing = (await t.owner.request("albumItems.addFile", { albumId: album.id, rendition: RENDITION }, t.key())).value;
    expect(await rejection(t.staff1.request("albumItems.get", { albumId: album.id, itemId: preparing.item.id }, t.read))).toBe("not_found");

    const firstPage = await t.staff1.request("albumItems.list", { albumId: album.id, limit: 1 }, t.read);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const members = await t.staff1.request("members.list", { albumId: album.id, limit: 1 }, t.read);
    // A role change moves the membership revision; cursors issued before it are refused.
    await t.owner.request("members.changeRole", { albumId: album.id, membershipId: staff1.id, expectedRevision: staff1.revision, role: "viewer" }, t.key());
    expect(await rejection(t.staff1.request("albumItems.list", { albumId: album.id, limit: 1, cursor: firstPage.nextCursor as string }, t.read))).toBe("invalid_cursor");
    expect(await rejection(t.staff1.request("members.list", { albumId: album.id, limit: 1, cursor: members.nextCursor as string }, t.read))).toBe("invalid_cursor");
    // Another actor cannot use the member's cursor either.
    expect(await rejection(t.owner.request("albumItems.list", { albumId: album.id, limit: 1, cursor: firstPage.nextCursor as string }, t.read))).toBe("invalid_cursor");
    t.advance(16 * 60 * 1000);
    const fresh = await t.staff1.request("albumItems.list", { albumId: album.id, limit: 1 }, t.read);
    t.advance(16 * 60 * 1000);
    expect(await rejection(t.staff1.request("albumItems.list", { albumId: album.id, limit: 1, cursor: fresh.nextCursor as string }, t.read))).toBe("cursor_expired");
  });

  it("an add in flight does not commit after the member is removed, leaves or is demoted", async () => {
    const t = setup();
    const { album, contributorLink, viewerLink } = await albumWithLinks(t);
    const staff1 = (await t.staff1.request("invites.join", { secret: contributorLink.secret as string }, t.key())).value.membership;
    await t.staff2.request("invites.join", { secret: viewerLink.secret as string }, t.key());
    const staff2 = (await t.owner.request("members.list", { albumId: album.id }, t.read)).items.find((row) => row.role === "viewer");
    const promoted = (await t.owner.request("members.changeRole", { albumId: album.id, membershipId: staff2?.id as string, expectedRevision: staff2?.revision as number, role: "contributor" }, t.key())).value;

    const removedAdd = (await t.staff1.request("albumItems.addFile", { albumId: album.id, rendition: RENDITION }, t.key())).value;
    const demotedAdd = (await t.staff2.request("albumItems.addFile", { albumId: album.id, rendition: RENDITION }, t.key())).value;
    await t.owner.request("members.remove", { albumId: album.id, membershipId: staff1.id }, t.key());
    await t.owner.request("members.changeRole", { albumId: album.id, membershipId: promoted.id, expectedRevision: promoted.revision, role: "viewer" }, t.key());

    expect(await rejection(t.staff1.request("albumItems.commitUpload", { albumId: album.id, uploadId: removedAdd.upload?.upload.id as string }, t.key()))).toBe("not_found");
    // Demotion ends the member's unpublished adds on the server, so the commit finds the add removed.
    expect(await rejection(t.staff2.request("albumItems.commitUpload", { albumId: album.id, uploadId: demotedAdd.upload?.upload.id as string }, t.key()))).toBe("item_removed");
    const ownerView = await t.owner.request("albumItems.list", { albumId: album.id }, t.read);
    expect(ownerView.items).toEqual([]);

    const leaver = (await t.owner.request("invites.create", { albumId: album.id, role: "contributor" }, t.key())).value;
    await t.outsider.request("invites.join", { secret: leaver.secret as string }, t.key());
    const leftAdd = (await t.outsider.request("albumItems.addFile", { albumId: album.id, rendition: RENDITION }, t.key())).value;
    await t.outsider.request("members.leave", { albumId: album.id }, t.key());
    expect(await rejection(t.outsider.request("albumItems.commitUpload", { albumId: album.id, uploadId: leftAdd.upload?.upload.id as string }, t.key()))).toBe("not_found");
  });

  it("is separate from photo-level link sharing: a photo share link is not an invite and grants no album access", async () => {
    const t = setup();
    const { album } = await albumWithLinks(t);
    const photoShares = createPhotoCloudSharingPreviewClient();
    const share = await photoShares["share.create"](
      {
        resource: { resourceType: "photo", resourceId: "synthetic-photo", ownerType: "user", ownerId: OWNER, tenantId: "synthetic-tenant", workspaceId: null },
        permission: "read",
        expiresAt: "2026-11-14T00:00:00.000Z",
      },
      { "Idempotency-Key": "synthetic-share-key" },
    );
    if (!share.ok) throw new Error("photo share was not created");
    const capability = share.value.shareUrl.split("/").pop() as string;
    for (const secret of [share.value.shareUrl, capability, share.value.share.shareId]) {
      expect(await rejection(t.outsider.request("invites.join", { secret }, t.key()))).toBe("invite_unavailable");
    }
    expect(await rejection(t.outsider.request("albums.get", { albumId: album.id }, t.read))).toBe("not_found");
    // The membership mock has no photo-share operations at all.
    expect(await rejection(t.owner.request("share.create" as never, {} as never, t.key() as never))).toBe("local:unsupported");
  });

  it("requires an idempotency key on mutations and refuses one on reads", async () => {
    const t = setup();
    const { album } = await albumWithLinks(t);
    expect(await rejection(t.owner.request("invites.create", { albumId: album.id, role: "viewer" }, t.read as never))).toBe("invalid_request");
    expect(await rejection(t.owner.request("members.list", { albumId: album.id }, t.key() as never))).toBe("invalid_request");
    expect(await rejection(t.owner.request("invites.create", { albumId: album.id, role: "viewer" }, { signal: t.signal, idempotencyKey: "a,b" }))).toBe("invalid_request");
  });

  it("re-validates required fields and value types like a server facing a modified client", async () => {
    const t = setup();
    const { album } = await albumWithLinks(t);
    const cases: [string, unknown][] = [
      ["albums.create", {}],
      ["albums.create", { name: 42 }],
      ["albums.get", { albumId: { id: album.id } }],
      ["invites.create", { albumId: album.id }],
      ["invites.join", {}],
      ["members.changeRole", { albumId: album.id, membershipId: "m", expectedRevision: -1, role: "viewer" }],
      ["members.list", { albumId: album.id, limit: "10" }],
      ["albumItems.get", { albumId: album.id, itemId: "../other" }],
      ["albumItems.addFile", { albumId: album.id, rendition: { ...RENDITION, contentType: "image/png" } }],
      ["albumItems.addFile", { albumId: album.id, rendition: { ...RENDITION, sha256: "not-a-digest" } }],
    ];
    for (const [operation, request] of cases) {
      const mutation = ["albums.create", "invites.create", "invites.join", "members.changeRole", "albumItems.addFile"].includes(operation);
      expect(await rejection(t.owner.request(operation as never, request as never, (mutation ? t.key() : t.read) as never)), operation).toBe("invalid_request");
    }
    // The same rules apply on the wire: a missing field, a field outside the route's body, a body on a GET.
    const wire = async (method: string, path: string, body?: unknown) => {
      const response = await t.server.fetch(`/cloud/sharing/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-NIHO-Photo-Actor-Id": OWNER, ...(method === "GET" ? {} : { "Idempotency-Key": "wire-key" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return [response.status, ((await response.json()) as { error?: { code: string } }).error?.code ?? "ok"];
    };
    expect(await wire("POST", `/albums/${album.id}/invites`, {})).toEqual([400, "invalid_request"]);
    expect(await wire("POST", `/albums/${album.id}/invites`, { albumId: album.id, role: "viewer" })).toEqual([400, "invalid_request"]);
    expect(await wire("POST", `/albums/${album.id}/members?limit=10`, {})).toEqual([404, "not_found"]);
    expect(await wire("GET", `/albums/${album.id}/members?limit=10&limit=20`)).toEqual([400, "invalid_request"]);
    // The provisional form before the route table is not served.
    expect(await wire("POST", "/invites.create", { albumId: album.id, role: "viewer" })).toEqual([404, "not_found"]);
    expect(await wire("POST", `/albums/${album.id}/invites`, { role: "viewer" })).toEqual([200, "ok"]);
  });
});
