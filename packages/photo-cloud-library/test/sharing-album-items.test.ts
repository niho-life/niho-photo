import { describe, expect, it } from "vitest";

import { PersonalPhotoCloudError } from "../src/errors";
import { createSourceDeviceRenderExecutor, renderFinishedOutput, renditionMetadataViolations, scanJpegMetadata } from "../src/render-executor";
import type { RenderOutputUploader } from "../src/render-executor";
import {
  SharedAlbumFileError,
  type SharedAlbumItemsTransport,
  createSharedAlbumItems,
  createSharedAlbumMembership,
  createSharedAlbumMockServer,
  deviceRenderFile,
  prepareAlbumFile,
  type SharedAlbumItemResult,
} from "../src/sharing";
import type { AlbumItem, SharingErrorCode } from "../src/sharing/contract";
import {
  bindingFor,
  cameraExifWithLocation,
  engineCaptureExif,
  exifPayload,
  fakeRenderer,
  hex,
  insertExif,
  recipeFor,
  sourcePort,
  syntheticJpeg,
  syntheticSource,
  type SyntheticSource,
} from "./render-support";

const OWNER = "synthetic-user-owner";
const MEMBER = "synthetic-user-member";
const VIEWER = "synthetic-user-viewer";
const START = Date.parse("2026-11-07T00:00:00.000Z");

function setup(options: { quotaBytes?: number } = {}) {
  let now = START;
  let keys = 0;
  let secrets = 0;
  const server = createSharedAlbumMockServer({
    users: [
      { userId: OWNER, displayName: "Synthetic Owner" },
      { userId: MEMBER, displayName: "Synthetic Member" },
      { userId: VIEWER, displayName: "Synthetic Viewer" },
    ],
    now: () => now,
    newSecret: () => `synthetic-secret-${++secrets}-${"x".repeat(22)}`,
    ...(options.quotaBytes === undefined ? {} : { quotaBytes: options.quotaBytes }),
  });
  const signal = new AbortController().signal;
  const key = () => `key-${++keys}`;
  const actions = (user: string, uploader: RenderOutputUploader = server.uploader) =>
    createSharedAlbumItems({ client: server.clientFor(user), uploader, newIdempotencyKey: key, sleep: async () => undefined });
  const membership = (user: string) => createSharedAlbumMembership({ client: server.clientFor(user), newIdempotencyKey: key, sleep: async () => undefined });
  // Originals stay on each user's own device; the device renders them with the B07 executor.
  const originals = new Map<string, Map<string, SyntheticSource>>([[OWNER, new Map()], [MEMBER, new Map()]]);
  const renderer = fakeRenderer();
  const device = (user: string) => createSourceDeviceRenderExecutor({
    transport: server.renderTransportFor(user), executor: { kind: "userDevice", userId: user }, renderer: renderer.renderer,
    sources: sourcePort(originals.get(user) as Map<string, SyntheticSource>), uploader: server.uploader, now: () => now, newIdempotencyKey: key,
    sleep: async () => undefined,
  });
  /** A photo in the user's own library (its original on the user's device) at a recipe revision. */
  const libraryPhoto = (user: string, photoId: string, revision = 1) => {
    const own = originals.get(user) as Map<string, SyntheticSource>;
    const source = own.get(photoId) ?? syntheticSource(photoId);
    own.set(photoId, source);
    const recipe = recipeFor(revision);
    return {
      ownerId: user, libraryId: `library-${user}`, photoId, recipe, binding: bindingFor(hex(source.bytes), recipe),
      expectedOutput: { width: source.width, height: source.height },
    };
  };
  const owner = actions(OWNER);
  const member = actions(MEMBER);
  const viewer = actions(VIEWER);
  async function sharedAlbum() {
    const album = await owner.createAlbum("Synthetic shared album", signal);
    const owners = membership(OWNER);
    await membership(MEMBER).join((await owners.createInvite(album.id, "contributor", signal)).secret, signal);
    await membership(VIEWER).join((await owners.createInvite(album.id, "viewer", signal)).secret, signal);
    return album;
  }
  return {
    server, signal, owner, member, viewer, actions, membership, device, libraryPhoto, renderer, originals, sharedAlbum,
    advance: (ms: number) => { now += ms; },
  };
}

/** A finished file, cleaned on the device like the UI does. */
const FILE = prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 7 }));

async function rejection(promise: Promise<unknown>): Promise<SharingErrorCode | string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PersonalPhotoCloudError) return `local:${error.code}`;
    if (error instanceof SharedAlbumFileError) return `file:${error.problem}`;
    if (error instanceof TypeError) return "network";
    return (error as { error: { code: SharingErrorCode } }).error.code;
  }
  throw new Error("expected a rejection");
}

const ids = (items: readonly AlbumItem[]) => items.map((item) => item.id).sort();
const okItems = (results: readonly SharedAlbumItemResult[]) => results.map((result) => (result.ok ? result.item : null));

describe("shared album items (B12)", () => {
  it("adds the owner's photo, a member's edited photo and a finished file; other members only ever see finished photos", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const ownerPhoto = t.libraryPhoto(OWNER, "owner-photo");
    const memberPhoto = t.libraryPhoto(MEMBER, "member-photo");
    t.server.addLibraryPhoto(ownerPhoto);
    t.server.addLibraryPhoto(memberPhoto);

    const [ownerItem] = okItems(await t.owner.addLibraryPhotos(album.id, [ownerPhoto, ownerPhoto], t.signal));
    const [memberItem] = okItems(await t.member.addLibraryPhotos(album.id, [memberPhoto], t.signal));
    const fileItem = await t.member.addFile(album.id, FILE, t.signal);
    expect(ownerItem).toMatchObject({ kind: "ownerPhoto", state: "preparing", pendingReason: "rendering", source: { kind: "libraryPhoto", photoId: "owner-photo" } });
    expect(memberItem).toMatchObject({ kind: "memberEdit", state: "preparing" });
    expect(fileItem).toMatchObject({ kind: "fileUpload", state: "published", revision: 1, source: null });

    // Until rendered, a preparing item is the owner's and its adder's only.
    expect(ids((await t.viewer.listItems(album.id, {}, t.signal)).items)).toEqual([fileItem.id]);
    expect(ids((await t.member.listItems(album.id, {}, t.signal)).items)).toEqual(ids([memberItem as AlbumItem, fileItem]));
    expect((await t.owner.getAlbum(album.id, t.signal)).access.preparation).toEqual({ prepared: 1, total: 3 });
    expect((await t.viewer.getAlbum(album.id, t.signal)).access.preparation).toBeNull();

    // Each original is rendered on its own adder's device; nothing renders another user's photo.
    expect(await t.device(OWNER).drain(t.signal)).toMatchObject({ committed: 1, failed: 0 });
    expect(await t.device(MEMBER).drain(t.signal)).toMatchObject({ committed: 1, failed: 0 });
    const seen = (await t.viewer.listItems(album.id, {}, t.signal)).items;
    expect(seen.map((item) => [item.kind, item.state, item.source, item.addedBy.isSelf])).toEqual(expect.arrayContaining([
      ["ownerPhoto", "published", null, false], ["memberEdit", "published", null, false], ["fileUpload", "published", null, false],
    ]));
    expect(seen).toHaveLength(3);
    // The original reference is the adder's alone.
    const own = await t.member.getItem(album.id, (memberItem as AlbumItem).id, t.signal);
    expect(own.source).toEqual({ kind: "libraryPhoto", libraryId: `library-${MEMBER}`, photoId: "member-photo" });
    expect((await t.owner.getItem(album.id, (memberItem as AlbumItem).id, t.signal)).source).toBeNull();

    // A library photo of someone else cannot be added.
    expect((await t.member.addLibraryPhotos(album.id, [ownerPhoto], t.signal))[0]).toMatchObject({ ok: false, error: { error: { code: "not_found" } } });
    // Viewers add nothing and reserve nothing.
    expect(await rejection(t.viewer.addFile(album.id, FILE, t.signal))).toBe("role_forbidden");
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
  });

  it("a member's photo rendered on its device is uploaded as a device photo and replaced by a newer render", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const source = syntheticSource("device-only");
    const render = async (revision: number) => {
      const recipe = recipeFor(revision);
      const binding = bindingFor(hex(source.bytes), recipe);
      const output = await renderFinishedOutput({ renderer: t.renderer.renderer, source, recipe, binding, kind: "rendition", loadMaskSurface: async () => null, signal: t.signal });
      return { binding, file: deviceRenderFile(output) };
    };
    const first = await render(1);
    const item = await t.member.addDevicePhoto(album.id, { deviceSourceRef: "device-ref-1", ...first }, t.signal);
    expect(item).toMatchObject({ kind: "memberEdit", state: "published", revision: 1, source: { kind: "devicePhoto", deviceSourceRef: "device-ref-1" } });

    const newer = await render(2);
    const replaced = await t.member.replaceDeviceRender(album.id, item, newer, t.signal);
    expect(replaced).toMatchObject({ state: "published", revision: 2 });
    expect(t.server.item(item.id).renditionBinding).toEqual(newer.binding);
    // An older render can never replace a newer one.
    expect(await rejection(t.member.replaceDeviceRender(album.id, replaced, first, t.signal))).toBe("stale_render");
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
  });

  it("a saved recipe re-renders the photo; others keep the previous one, an offline device waits, and an older render never wins", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    t.server.addLibraryPhoto(t.libraryPhoto(OWNER, "edited"));
    const [added] = okItems(await t.owner.addLibraryPhotos(album.id, [t.libraryPhoto(OWNER, "edited")], t.signal));
    const itemId = (added as AlbumItem).id;
    await t.device(OWNER).drain(t.signal);
    const firstRendition = (await t.viewer.getItem(album.id, itemId, t.signal)).rendition;

    // The owner saves revision 2: the owner sees the update pending, everyone else the published rendition.
    t.server.saveLibraryRecipe(t.libraryPhoto(OWNER, "edited", 2));
    expect(await t.owner.getItem(album.id, itemId, t.signal)).toMatchObject({ state: "updatePending", pendingReason: "rendering" });
    expect(await t.viewer.getItem(album.id, itemId, t.signal)).toMatchObject({ state: "published", rendition: firstRendition });

    // The device holding the original sleeps: 更新待ち until it comes back. Revision 3 is saved meanwhile.
    t.server.setDeviceOnline(OWNER, false);
    expect(await t.owner.getItem(album.id, itemId, t.signal)).toMatchObject({ state: "updatePending", pendingReason: "waitingForDevice" });
    t.server.saveLibraryRecipe(t.libraryPhoto(OWNER, "edited", 3));
    expect(await t.device(OWNER).drain(t.signal)).toMatchObject({ committed: 1 });
    expect(t.server.item(itemId)).toMatchObject({ state: "published", revision: 2, renditionBinding: t.libraryPhoto(OWNER, "edited", 3).binding });
    expect(t.server.renderJobs().filter((job) => job.itemId === itemId).map((job) => job.state)).toEqual(["committed", "superseded", "committed"]);

    // A render of revision 4 still in progress when revision 5 is saved is dropped, and 5 is published.
    t.server.saveLibraryRecipe(t.libraryPhoto(OWNER, "edited", 4));
    const release = t.renderer.hold("edited");
    const slow = t.device(OWNER).drain(t.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.server.saveLibraryRecipe(t.libraryPhoto(OWNER, "edited", 5));
    release();
    // The late revision-4 output is refused and dropped; the same drain then renders revision 5.
    expect(await slow).toMatchObject({ committed: 1, discarded: 1 });
    expect(t.server.item(itemId)).toMatchObject({ revision: 3, renditionBinding: t.libraryPhoto(OWNER, "edited", 5).binding });
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
  });

  it("a lost answer adds once; a lost upload ticket restarts the upload on the same item", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    t.server.loseNextResponse();
    const item = await t.member.addFile(album.id, FILE, t.signal);
    // addFile (answer lost) → replay without ticket → cancel → replace on the same item → upload → commit.
    expect(t.server.calls("albumItems.addFile")).toBe(2);
    expect(t.server.calls("albumItems.cancelUpload")).toBe(1);
    expect(t.server.calls("albumItems.replace")).toBe(1);
    expect(item).toMatchObject({ state: "published", revision: 1 });
    expect(ids((await t.owner.listItems(album.id, {}, t.signal)).items)).toEqual([item.id]);
    expect(t.server.storageOf(OWNER)).toEqual({ usedBytes: FILE.bytes.length, reservedBytes: 0 });

    // A library photo whose add answer is lost is added once too.
    t.server.addLibraryPhoto(t.libraryPhoto(MEMBER, "once"));
    t.server.loseNextResponse();
    expect(okItems(await t.member.addLibraryPhotos(album.id, [t.libraryPhoto(MEMBER, "once")], t.signal))).toHaveLength(1);
    expect((await t.member.listItems(album.id, {}, t.signal)).items.filter((entry) => entry.kind === "memberEdit")).toHaveLength(1);
  });

  it("an interrupted upload or a cancelled add releases the reservation and leaves no unfinished item", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const broken: RenderOutputUploader = { async upload() { throw new TypeError("Failed to fetch"); } };
    expect(await rejection(t.actions(MEMBER, broken).addFile(album.id, FILE, t.signal))).toBe("network");
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
    expect((await t.member.listItems(album.id, {}, t.signal)).items).toEqual([]);

    // The user cancels while the bytes are going up: the same clean-up, even though the action's signal is aborted.
    const controller = new AbortController();
    const cancelling: RenderOutputUploader = {
      async upload() {
        controller.abort(new DOMException("Aborted", "AbortError"));
        throw new DOMException("Aborted", "AbortError");
      },
    };
    await expect(t.actions(MEMBER, cancelling).addFile(album.id, FILE, controller.signal)).rejects.toThrow();
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
    expect((await t.member.listItems(album.id, {}, t.signal)).items).toEqual([]);
  });

  it("a full album storage tells the owner the numbers and a member only that it is full; renders wait and resume", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    t.server.setQuotaBytes(OWNER, 100);
    const memberError = await t.member.addFile(album.id, FILE, t.signal).catch((error: unknown) => error);
    expect(memberError).toMatchObject({ error: { code: "quota_exceeded" } });
    expect((memberError as { error: object }).error).not.toHaveProperty("storage");
    const ownerError = await t.owner.addFile(album.id, FILE, t.signal).catch((error: unknown) => error);
    expect(ownerError).toMatchObject({ error: { code: "quota_exceeded", storage: { availableBytes: 100, requiredBytes: FILE.bytes.length } } });
    expect((await t.owner.listItems(album.id, {}, t.signal)).items).toEqual([]);

    // A photo rendered later waits as 準備中（容量不足） instead of failing, and resumes when capacity frees.
    t.server.addLibraryPhoto(t.libraryPhoto(MEMBER, "waits"));
    const [item] = okItems(await t.member.addLibraryPhotos(album.id, [t.libraryPhoto(MEMBER, "waits")], t.signal));
    expect(await t.device(MEMBER).drain(t.signal)).toMatchObject({ deferredForQuota: 1, failed: 0 });
    expect(await t.owner.getItem(album.id, (item as AlbumItem).id, t.signal)).toMatchObject({ state: "preparing", pendingReason: "quotaExceeded" });
    t.server.setQuotaBytes(OWNER, 1024 ** 3);
    expect(await t.owner.getItem(album.id, (item as AlbumItem).id, t.signal)).toMatchObject({ pendingReason: "rendering" });
    expect(await t.device(MEMBER).drain(t.signal)).toMatchObject({ committed: 1 });
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
  });

  it("an add never commits after the member was removed or made a viewer while uploading, and its reservation is freed", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const owners = t.membership(OWNER);
    const memberships = (await owners.listMembers(album.id, {}, t.signal)).items;
    const memberId = memberships.find((entry) => entry.member.displayName === "Synthetic Member")?.id as string;
    const removing: RenderOutputUploader = {
      async upload(ticket, bytes, contentType, signal) {
        await t.server.uploader.upload(ticket, bytes, contentType, signal);
        await owners.removeMember(album.id, memberId, t.signal);
      },
    };
    expect(await rejection(t.actions(MEMBER, removing).addFile(album.id, FILE, t.signal))).toBe("not_found");
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);

    const viewerId = memberships.find((entry) => entry.member.displayName === "Synthetic Viewer")?.id as string;
    const promoted = await owners.changeRole(album.id, viewerId, (memberships.find((entry) => entry.id === viewerId)?.revision) as number, "contributor", t.signal);
    const demoting: RenderOutputUploader = {
      async upload(ticket, bytes, contentType, signal) {
        await t.server.uploader.upload(ticket, bytes, contentType, signal);
        await owners.changeRole(album.id, viewerId, promoted.revision, "viewer", t.signal);
      },
    };
    // Demotion drops the unpublished add on the server; the commit finds it removed.
    expect(await rejection(t.actions(VIEWER, demoting).addFile(album.id, FILE, t.signal))).toBe("item_removed");
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
    // Adds that can never commit are not left behind as 準備中 for the owner.
    expect((await t.owner.listItems(album.id, {}, t.signal)).items).toEqual([]);
  });

  it("removing items or the album keeps every original and library photo; the owner may remove others' items, members their own", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    t.server.addLibraryPhoto(t.libraryPhoto(OWNER, "kept"));
    t.server.addLibraryPhoto(t.libraryPhoto(MEMBER, "pending"));
    const [ownerItem] = okItems(await t.owner.addLibraryPhotos(album.id, [t.libraryPhoto(OWNER, "kept")], t.signal));
    await t.device(OWNER).drain(t.signal);
    const memberFile = await t.member.addFile(album.id, FILE, t.signal);
    const second = await t.member.addFile(album.id, prepareAlbumFile(syntheticJpeg({ width: 640, height: 480, seed: 9 })), t.signal);
    // Not rendered yet: removing it cancels its render job.
    const [pending] = okItems(await t.member.addLibraryPhotos(album.id, [t.libraryPhoto(MEMBER, "pending")], t.signal));

    const byMember = await t.member.removeItems(album.id, [memberFile.id, (ownerItem as AlbumItem).id, (pending as AlbumItem).id], t.signal);
    expect(byMember.map((result) => (result.ok ? result.item.state : (result.error as { error: { code: string } }).error.code))).toEqual(["removed", "role_forbidden", "removed"]);
    expect(await rejection(t.viewer.removeItems(album.id, [second.id], t.signal).then((results) => { throw results[0]?.ok ? new Error("removed") : (results[0] as { error: unknown }).error; }))).toBe("role_forbidden");
    expect((await t.owner.removeItems(album.id, [second.id], t.signal))[0]).toMatchObject({ ok: true, item: { state: "removed", addedBy: { displayName: "Synthetic Member" } } });
    expect(await t.device(MEMBER).drain(t.signal)).toMatchObject({ committed: 0 });
    expect(t.server.renderJobs().find((job) => job.itemId === (pending as AlbumItem).id)?.state).toBe("cancelled");
    expect(t.server.hasLibraryPhoto(`library-${MEMBER}`, "pending")).toBe(true);
    expect(t.originals.get(MEMBER)?.has("pending")).toBe(true);

    // Deleting the album removes its finished photos only.
    const current = await t.owner.getAlbum(album.id, t.signal);
    await t.owner.deleteAlbum(album.id, current.revision, t.signal);
    expect(await rejection(t.owner.getAlbum(album.id, t.signal))).toBe("not_found");
    expect(t.server.storageOf(OWNER)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(t.server.hasLibraryPhoto(`library-${OWNER}`, "kept")).toBe(true);
    expect(t.originals.get(OWNER)?.has("kept")).toBe(true);
  });

  it("a JPEG with a location added directly is published without it, keeping only the capture time", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const located = insertExif(
      syntheticJpeg({ width: 1200, height: 800, exif: cameraExifWithLocation(), xmp: '<x exif:GPSLatitude="35"/>', comment: "/DCIM/100SYNTH/IMG_0001.JPG", iptc: true, icc: true, seed: 3 }),
      engineCaptureExif("2026:11:01 09:30:00", "+09:00", 1200, 800),
    );
    // Cleaned on the device: nothing but the capture time leaves it.
    const prepared = prepareAlbumFile(located);
    expect(renditionMetadataViolations(prepared.bytes)).toEqual([]);
    expect(prepared.rendition.metadata).toEqual({ capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00", colorProfile: "sRGB", orientation: 1 });
    const item = await t.member.addFile(album.id, prepared, t.signal);
    expect(item.rendition?.metadata).toEqual(prepared.rendition.metadata);

    // A client that skips the device step: the server rebuilds the file at commit, so the location still never lands.
    const raw = { bytes: located, rendition: { ...prepared.rendition, sizeBytes: located.length, sha256: hex(located) } };
    const unscrubbed = await t.member.addFile(album.id, raw, t.signal);
    const stored = t.server.renditionBytes(unscrubbed.id) as Uint8Array;
    expect(renditionMetadataViolations(stored)).toEqual([]);
    expect(scanJpegMetadata(stored)?.exif).toBeNull();
    const text = new TextDecoder("latin1").decode(stored);
    for (const leaked of ["SERIAL-0001", "GPSLatitude", "/DCIM", "8BIM"]) expect(text).not.toContain(leaked);
    expect(unscrubbed.rendition?.asset.sha256).toBe(hex(stored));

    // Files that cannot be added as they are never leave the device.
    const sideways = insertExif(syntheticJpeg({ width: 800, height: 1200 }), exifPayload({ ifd0: [{ tag: 0x0112, type: 3, value: 6 }] }));
    expect(() => prepareAlbumFile(sideways)).toThrow(expect.objectContaining({ problem: "notUpright" }));
    expect(() => prepareAlbumFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(expect.objectContaining({ problem: "notJpeg" }));
    // A broken upload is refused at commit and its reservation released.
    const broken = { bytes: new Uint8Array(400).fill(7), rendition: { ...prepared.rendition, sizeBytes: 400, sha256: hex(new Uint8Array(400).fill(7)) } };
    expect(await rejection(t.member.addFile(album.id, broken, t.signal))).toBe("content_rejected");
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
  });

  it("a file is replaced by its adder only; others see the old file until the new one commits, and an older replace never wins", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const item = await t.member.addFile(album.id, FILE, t.signal);
    const next = prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 21 }));
    expect(await rejection(t.owner.replaceFile(album.id, item, next, t.signal))).toBe("role_forbidden");
    expect(await rejection(t.member.replaceFile(album.id, { id: item.id, revision: 0 }, next, t.signal))).toBe("revision_conflict");

    // Two replaces in flight: only the latest one may commit.
    const client = t.server.clientFor(MEMBER);
    const content = (file: typeof next) => ({ kind: "file" as const, rendition: file.rendition });
    const older = (await client.request("albumItems.replace", { albumId: album.id, itemId: item.id, expectedRevision: 1, content: content(next) }, { signal: t.signal, idempotencyKey: "replace-a" })).value;
    expect(await t.viewer.getItem(album.id, item.id, t.signal)).toMatchObject({ state: "published", rendition: { id: item.rendition?.id } });
    const latest = prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 22 }));
    const newer = (await client.request("albumItems.replace", { albumId: album.id, itemId: item.id, expectedRevision: 1, content: content(latest) }, { signal: t.signal, idempotencyKey: "replace-b" })).value;
    await t.server.uploader.upload(newer.upload?.ticket as never, latest.bytes, "image/jpeg", t.signal);
    await expect(t.server.uploader.upload(older.upload?.ticket as never, next.bytes, "image/jpeg", t.signal)).rejects.toThrow();
    expect(await rejection(client.request("albumItems.commitUpload", { albumId: album.id, uploadId: older.upload?.upload.id as string }, { signal: t.signal, idempotencyKey: "commit-a" }))).toBe("upload_expired");
    const committed = (await client.request("albumItems.commitUpload", { albumId: album.id, uploadId: newer.upload?.upload.id as string }, { signal: t.signal, idempotencyKey: "commit-b" })).value;
    expect(committed).toMatchObject({ state: "published", revision: 2, rendition: { asset: { sha256: latest.rendition.sha256 } } });
    expect(t.server.storageOf(OWNER)).toEqual({ usedBytes: latest.bytes.length, reservedBytes: 0 });
  });

  it("an action aborted while its commit is in flight keeps the photo the server may already have published", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const controller = new AbortController();
    const base = t.server.clientFor(MEMBER);
    const client = {
      async request(operation: string, request: unknown, requestOptions: never) {
        const answer = await base.request(operation as never, request as never, requestOptions);
        if (operation === "albumItems.commitUpload") {
          // Published on the server; the user cancels before the answer arrives.
          controller.abort(new DOMException("Aborted", "AbortError"));
          throw new DOMException("Aborted", "AbortError");
        }
        return answer;
      },
      download: base.download,
    } as unknown as SharedAlbumItemsTransport;
    const actions = createSharedAlbumItems({ client, uploader: t.server.uploader, sleep: async () => undefined });
    await expect(actions.addFile(album.id, FILE, controller.signal)).rejects.toThrow();
    const listed = (await t.owner.listItems(album.id, {}, t.signal)).items;
    expect(listed.map((item) => item.state)).toEqual(["published"]);
    expect(t.server.calls("albumItems.remove")).toBe(0);
    expect(t.server.storageOf(OWNER)).toEqual({ usedBytes: FILE.bytes.length, reservedBytes: 0 });
  });

  it("a render output with anything outside the allow-list is refused at commit, not only location", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const photo = t.libraryPhoto(OWNER, "commented");
    t.server.addLibraryPhoto(photo);
    const [item] = okItems(await t.owner.addLibraryPhotos(album.id, [photo], t.signal));
    const transport = t.server.renderTransportFor(OWNER);
    const [claimed] = (await transport.request("renderJobs.claim", { maxJobs: 1 }, { signal: t.signal, idempotencyKey: "claim-1" })).value.jobs;
    // A camera make in a comment block: no location, serial or path key, still not an allowed rendition field.
    const bytes = syntheticJpeg({ width: 1200, height: 800, comment: "Synthetic Camera Co" });
    const start = (await transport.request("renderJobs.startOutput", {
      jobId: claimed.job.id, leaseToken: claimed.lease.leaseToken,
      output: { kind: "rendition", sizeBytes: bytes.length, sha256: hex(bytes), contentType: "image/jpeg", width: 1200, height: 800, metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 } },
    }, { signal: t.signal, idempotencyKey: "start-1" })).value;
    await t.server.uploader.upload(start.ticket as never, bytes, "image/jpeg", t.signal);
    expect(await rejection(transport.request("renderJobs.commit", { jobId: claimed.job.id, leaseToken: claimed.lease.leaseToken, uploadId: start.uploadId }, { signal: t.signal, idempotencyKey: "commit-1" }))).toBe("content_rejected");
    expect(t.server.item((item as AlbumItem).id)).toMatchObject({ state: "preparing", rendition: null });
    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
  });

  it("saving hashes the bytes themselves: a stream with the right header but other bytes is not saved", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    const item = await t.member.addFile(album.id, FILE, t.signal);
    const base = t.server.clientFor(OWNER);
    const forged = {
      request: base.request,
      async download(request: never, signal: AbortSignal) {
        const content = await base.download(request, signal);
        const bytes = new Uint8Array(await new Response(content.body).arrayBuffer());
        bytes[bytes.length - 3] ^= 0xff; // same length, same headers, different bytes
        return { ...content, body: new Blob([bytes]).stream() };
      },
    } as unknown as SharedAlbumItemsTransport;
    const actions = createSharedAlbumItems({ client: forged, uploader: t.server.uploader, sleep: async () => undefined });
    let kept = false;
    const [result] = await actions.saveItems(album.id, [item], async (_item, content) => {
      await new Response(content.body).arrayBuffer();
      kept = true; // a sink keeps the file only once the stream closed cleanly
    }, t.signal);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    expect(kept).toBe(false);
  });

  it("saves several finished photos at full size; an unfinished one is reported, not saved", async () => {
    const t = setup();
    const album = await t.sharedAlbum();
    t.server.addLibraryPhoto(t.libraryPhoto(OWNER, "not-yet"));
    const finished = await t.member.addFile(album.id, FILE, t.signal);
    const [waiting] = okItems(await t.owner.addLibraryPhotos(album.id, [t.libraryPhoto(OWNER, "not-yet")], t.signal));
    const saved = new Map<string, Uint8Array>();
    const results = await t.owner.saveItems(album.id, [finished, waiting as AlbumItem], async (item, content) => {
      saved.set(item.id, new Uint8Array(await new Response(content.body).arrayBuffer()));
    }, t.signal);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(saved.get(finished.id)).toEqual(t.server.renditionBytes(finished.id));
    // Viewers save too.
    expect((await t.viewer.saveItems(album.id, [finished], async (_item, content) => { await content.body.cancel(); }, t.signal))[0]?.ok).toBe(true);
  });
});
