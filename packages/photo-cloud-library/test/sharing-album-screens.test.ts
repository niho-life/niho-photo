import { describe, expect, it } from "vitest";

import {
  createSharedAlbumItems,
  createSharedAlbumMembership,
  createSharedAlbumMockServer,
  createSharedAlbumScreensPort,
} from "../src/sharing";
import { cameraExifWithLocation, exifPayload, syntheticJpeg } from "./render-support";

const OWNER = "synthetic-user-owner";
const MEMBER = "synthetic-user-member";
const VIEWER = "synthetic-user-viewer";
const START = Date.parse("2026-11-07T00:00:00.000Z");

function setup(options: { extraUsers?: number } = {}) {
  let keys = 0;
  let secrets = 0;
  let clock = START;
  const server = createSharedAlbumMockServer({
    users: [
      { userId: OWNER, displayName: "Synthetic Owner" },
      { userId: MEMBER, displayName: "Synthetic Member" },
      { userId: VIEWER, displayName: "Synthetic Viewer" },
      ...Array.from({ length: options.extraUsers ?? 0 }, (_, index) => ({ userId: `synthetic-user-extra-${index}`, displayName: `Synthetic Extra ${index}` })),
    ],
    now: () => clock,
    newSecret: () => `synthetic-secret-${++secrets}-${"x".repeat(22)}`,
  });
  const created: string[] = [];
  const revoked: string[] = [];
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const memberLists = { count: 0 };
  const portFor = (user: string) => {
    const client = server.clientFor(user);
    const key = () => `${user}-key-${++keys}`;
    const membership = createSharedAlbumMembership({ client, newIdempotencyKey: key, sleep: async () => undefined });
    return createSharedAlbumScreensPort({
      items: createSharedAlbumItems({ client, uploader: server.uploader, newIdempotencyKey: key, sleep: async () => undefined }),
      membership: {
        ...membership,
        listMembers: (...args: Parameters<typeof membership.listMembers>) => {
          memberLists.count += 1;
          return membership.listMembers(...args);
        },
      },
      download: (request, signal) => client.download(request, signal),
      now: () => clock,
      inviteUrl: (secret) => `https://photo.example.test/#invite=${secret}`,
      saveFile: async (name, file) => { saved.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) }); },
      objectUrls: {
        create: () => {
          const url = `blob:synthetic/${created.length + 1}`;
          created.push(url);
          return url;
        },
        revoke: (url) => { revoked.push(url); },
      },
    });
  };
  const signal = new AbortController().signal;
  const file = (seed: number, options: Parameters<typeof syntheticJpeg>[0] = { width: 1200, height: 800 }) =>
    new File([syntheticJpeg({ ...options, seed }).slice()], `IMG_${seed}.JPG`, { type: "image/jpeg" });
  return { server, portFor, signal, file, created, revoked, saved, memberLists, advance: (ms: number) => { clock += ms; } };
}

async function sharedAlbum(t: ReturnType<typeof setup>) {
  const owner = t.portFor(OWNER);
  const albumId = await owner.createAlbum("Synthetic shared album", t.signal);
  const join = async (user: string, role: "contributor" | "viewer") => {
    const url = await owner.copyInviteLink(albumId, role, t.signal);
    const secret = url.slice(url.indexOf("#invite=") + "#invite=".length);
    return await t.portFor(user).join(secret, t.signal);
  };
  return { owner, albumId, join };
}

describe("shared album screens port (B08 on B05/B12)", () => {
  it("maps albums, items and people to the screens' view-models, following the server's permissions", async () => {
    const t = setup();
    const { owner, albumId, join } = await sharedAlbum(t);
    expect(await join(MEMBER, "contributor")).toEqual({ kind: "joined", albumId });
    expect(await join(VIEWER, "viewer")).toEqual({ kind: "joined", albumId });
    expect(await owner.addFile(albumId, t.file(1), t.signal)).toEqual({ ok: true });

    const [summary] = await owner.listAlbums(t.signal);
    expect(summary).toMatchObject({ albumId, name: "Synthetic shared album", role: "owner", owner: { isSelf: true }, memberCount: 3, itemCount: 1, preparing: null });
    expect(summary?.coverUrl).toMatch(/^blob:synthetic\//u);

    const viewer = t.portFor(VIEWER);
    const opened = await viewer.openAlbum(albumId, t.signal);
    expect(opened?.album).toMatchObject({ role: "viewer", owner: { displayName: "Synthetic Owner", isSelf: false }, capacity: { state: "available" }, accessEnded: false });
    expect(opened?.permissions).toEqual({ addItem: false, removeOwnItem: false, removeOthersItem: false, manageInvites: false, leave: true, download: true });
    expect(opened?.items).toEqual([expect.objectContaining({ kind: "fileUpload", state: "published", addedBy: expect.objectContaining({ isSelf: false }), isNew: false, pendingReason: null })]);
    expect(opened?.items[0]?.thumbnailUrl).toMatch(/^blob:synthetic\//u);
    // No user IDs reach the screens.
    expect(JSON.stringify(opened)).not.toContain("synthetic-user-");

    const people = await owner.people(albumId, t.signal);
    expect(people.members.map((member) => [member.displayName, member.role, member.isSelf])).toEqual([
      ["Synthetic Owner", "owner", true], ["Synthetic Member", "contributor", false], ["Synthetic Viewer", "viewer", false],
    ]);
    expect(people.inviteLinks.map((link) => link.role).sort()).toEqual(["contributor", "viewer"]);
    // Links are the owner's to see.
    expect((await viewer.people(albumId, t.signal)).inviteLinks).toEqual([]);
  });

  it("copies the link it already holds, and creates one only when none is usable", async () => {
    const t = setup();
    const { owner, albumId } = await sharedAlbum(t);
    const first = await owner.copyInviteLink(albumId, "contributor", t.signal);
    expect(await owner.copyInviteLink(albumId, "contributor", t.signal)).toBe(first);
    expect(t.server.calls("invites.create")).toBe(1);
    const [link] = (await owner.people(albumId, t.signal)).inviteLinks;
    await owner.revokeInviteLink(albumId, link?.linkId as string, t.signal);
    const next = await owner.copyInviteLink(albumId, "contributor", t.signal);
    expect(next).not.toBe(first);
    expect(t.server.calls("invites.create")).toBe(2);
    expect(await t.portFor(MEMBER).join("not-a-real-secret-value-xxxxxxxxxxxx", t.signal)).toEqual({ kind: "unavailable" });
  });

  it("marks photos others added after this session first saw the album as new", async () => {
    const t = setup();
    const { owner, albumId, join } = await sharedAlbum(t);
    await join(MEMBER, "contributor");
    const member = t.portFor(MEMBER);
    await owner.addFile(albumId, t.file(1), t.signal);
    expect((await member.openAlbum(albumId, t.signal))?.items.map((item) => item.isNew)).toEqual([false]);
    await owner.addFile(albumId, t.file(2), t.signal);
    await member.addFile(albumId, t.file(3), t.signal);
    const items = (await member.openAlbum(albumId, t.signal))?.items ?? [];
    expect(items.map((item) => [item.addedBy.isSelf, item.isNew])).toEqual([[false, false], [false, true], [true, false]]);
  });

  it("reports why a photo was not added: full album, a file it cannot take, an ended membership", async () => {
    const t = setup();
    const { owner, albumId, join } = await sharedAlbum(t);
    await join(MEMBER, "contributor");
    const member = t.portFor(MEMBER);
    t.server.setQuotaBytes(OWNER, 100);
    expect(await member.addFile(albumId, t.file(1), t.signal)).toEqual({ ok: false, reason: "albumFull" });
    expect((await member.openAlbum(albumId, t.signal))?.album.capacity).toEqual({ state: "full", ownerUsage: null });
    t.server.setQuotaBytes(OWNER, 0);
    expect((await owner.openAlbum(albumId, t.signal))?.album.capacity).toEqual({ state: "full", ownerUsage: { usedBytes: 0, quotaBytes: 0 } });
    t.server.setQuotaBytes(OWNER, 1024 ** 3);

    expect(await member.addFile(albumId, new File([new Uint8Array([1, 2, 3])], "notes.txt"), t.signal)).toEqual({ ok: false, reason: "unsupported" });
    // An upright JPEG with a location goes up cleaned on the device.
    const located = exifPayload({
      ifd0: [{ tag: 0x010f, type: 2, value: "Synthetic Camera Co" }],
      exif: [{ tag: 0x9003, type: 2, value: "2026:11:01 09:30:00" }],
      gps: [{ tag: 0x0001, type: 2, value: "N" }, { tag: 0x0002, type: 4, value: 35 }],
    });
    expect(await member.addFile(albumId, t.file(5, { width: 1200, height: 800, exif: located }), t.signal)).toEqual({ ok: true });
    // A sideways JPEG needs the browser's decoder to be turned upright; without one it is not sent.
    expect(await member.addFile(albumId, t.file(7, { width: 1200, height: 800, exif: cameraExifWithLocation() }), t.signal)).toEqual({ ok: false, reason: "unsupported" });

    const people = await owner.people(albumId, t.signal);
    await owner.removeMember(albumId, people.members.find((entry) => !entry.isSelf)?.userId as string, t.signal);
    expect(await member.addFile(albumId, t.file(6), t.signal)).toEqual({ ok: false, reason: "accessEnded" });
    // The album is no longer the member's: the screen shows it ended.
    expect(await member.openAlbum(albumId, t.signal)).toBeNull();
  });

  it("saves the full-size photos and removes items, reporting what it could not do", async () => {
    const t = setup();
    const { owner, albumId, join } = await sharedAlbum(t);
    await join(MEMBER, "contributor");
    const member = t.portFor(MEMBER);
    await owner.addFile(albumId, t.file(1), t.signal);
    await member.addFile(albumId, t.file(2), t.signal);
    const items = (await member.openAlbum(albumId, t.signal))?.items ?? [];
    expect(await member.save(albumId, items.map((item) => item.itemId), t.signal)).toEqual({ failed: 0 });
    expect(t.saved.map((entry) => entry.name)).toEqual(["NIHO-1.jpg", "NIHO-2.jpg"]);
    expect(t.saved[0]?.bytes).toEqual(t.server.renditionBytes(items[0]?.itemId as string));

    // A member removes their own photo; the owner's stays.
    expect(await member.remove(albumId, items.map((item) => item.itemId), t.signal)).toEqual({ failed: 1 });
    expect((await member.openAlbum(albumId, t.signal))?.items.map((item) => item.addedBy.isSelf)).toEqual([false]);
  });

  it("changes a member's role with the revision it read, and the member can leave", async () => {
    const t = setup();
    const { owner, albumId, join } = await sharedAlbum(t);
    await join(MEMBER, "contributor");
    const memberId = (await owner.people(albumId, t.signal)).members.find((entry) => !entry.isSelf)?.userId as string;
    await owner.changeRole(albumId, memberId, "viewer", t.signal);
    await owner.changeRole(albumId, memberId, "contributor", t.signal);
    expect((await owner.people(albumId, t.signal)).members.find((entry) => entry.userId === memberId)?.role).toBe("contributor");
    const member = t.portFor(MEMBER);
    await member.leave(albumId, t.signal);
    expect(await member.listAlbums(t.signal)).toEqual([]);
  });

  it("releases every thumbnail object URL when the scope ends", async () => {
    const t = setup();
    const { owner, albumId } = await sharedAlbum(t);
    await owner.addFile(albumId, t.file(1), t.signal);
    await owner.addFile(albumId, t.file(2), t.signal);
    await owner.openAlbum(albumId, t.signal);
    expect(t.created.length).toBeGreaterThan(0);
    owner.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(new Set(t.revoked)).toEqual(new Set(t.created));
  });

  it("ends an invite only on a definite refusal; a rate limit is thrown so the same link can be retried", async () => {
    const t = setup();
    const { albumId, join } = await sharedAlbum(t);
    const outsider = t.portFor(VIEWER);
    // Ten wrong secrets trip the join rate limit: not a definite answer about the link.
    for (let index = 0; index < 10; index += 1) {
      expect(await outsider.join(`wrong-secret-${index}-${"x".repeat(20)}`, t.signal)).toEqual({ kind: "unavailable" });
    }
    await expect(join(VIEWER, "viewer")).rejects.toMatchObject({ error: { code: "rate_limited" } });
    t.advance(11 * 60 * 1000);
    expect(await join(VIEWER, "viewer")).toEqual({ kind: "joined", albumId });
  });

  it("shows a member the album as full for a while after a refused add, and clears it on the next accepted add", async () => {
    const t = setup();
    const { albumId, join } = await sharedAlbum(t);
    await join(MEMBER, "contributor");
    const member = t.portFor(MEMBER);
    t.server.setQuotaBytes(OWNER, 100);
    expect(await member.addFile(albumId, t.file(1), t.signal)).toEqual({ ok: false, reason: "albumFull" });
    expect((await member.openAlbum(albumId, t.signal))?.album.capacity.state).toBe("full");
    // The owner frees space; once the notice expires the member can try again.
    t.server.setQuotaBytes(OWNER, 1024 ** 3);
    t.advance(61_000);
    expect((await member.openAlbum(albumId, t.signal))?.album.capacity.state).toBe("available");
    t.server.setQuotaBytes(OWNER, 100);
    expect(await member.addFile(albumId, t.file(2), t.signal)).toEqual({ ok: false, reason: "albumFull" });
    t.server.setQuotaBytes(OWNER, 1024 ** 3);
    expect(await member.addFile(albumId, t.file(3), t.signal)).toEqual({ ok: true });
    expect((await member.openAlbum(albumId, t.signal))?.album.capacity.state).toBe("available");
  });

  it("reads every page: more albums than one page, more members than one page", async () => {
    const t = setup({ extraUsers: 101 });
    const owner = t.portFor(OWNER);
    for (let index = 0; index < 61; index += 1) await owner.createAlbum(`Synthetic album ${index}`, t.signal);
    expect(await owner.listAlbums(t.signal)).toHaveLength(61);

    const albumId = await owner.createAlbum("Synthetic crowded album", t.signal);
    const url = await owner.copyInviteLink(albumId, "contributor", t.signal);
    const secret = url.slice(url.indexOf("#invite=") + "#invite=".length);
    for (let index = 0; index < 101; index += 1) await t.portFor(`synthetic-user-extra-${index}`).join(secret, t.signal);
    const people = await owner.people(albumId, t.signal);
    expect(people.members).toHaveLength(102);
    // The 102nd member can still be managed.
    const last = people.members.at(-1);
    await owner.changeRole(albumId, last?.userId as string, "viewer", t.signal);
    expect((await owner.people(albumId, t.signal)).members.find((member) => member.userId === last?.userId)?.role).toBe("viewer");
    // The count comes with the album (B00 memberCount): listing and opening albums never list members.
    t.memberLists.count = 0;
    expect((await owner.listAlbums(t.signal)).find((album) => album.albumId === albumId)?.memberCount).toBe(102);
    expect((await owner.openAlbum(albumId, t.signal))?.album.memberCount).toBe(102);
    expect(t.memberLists.count).toBe(0);
  });
});
