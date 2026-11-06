import { describe, expect, it, vi } from "vitest";

import { PersonalPhotoCloudError } from "../src/errors";
import {
  SHARING_CLOUD_PATH_PREFIX,
  createBrowserSharedAlbumClient,
  createSharedAlbumItems,
  createSharedAlbumMembership,
  createSharedAlbumMockServer,
  prepareAlbumFile,
} from "../src/sharing";
import { bindingFor, hex, recipeFor, syntheticJpeg } from "./render-support";
import { FakeIdentity, defaultActor } from "./support";

const OWNER = "synthetic-user-owner";
const VIEWER = "synthetic-user-viewer";
const NOW = Date.parse("2026-11-07T00:00:00.000Z");
const FILE = prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 5 }));

function setup() {
  const server = createSharedAlbumMockServer({
    users: [{ userId: OWNER, displayName: "Synthetic Owner" }, { userId: VIEWER, displayName: "Synthetic Viewer" }],
    now: () => NOW,
    newSecret: () => "synthetic-invite-secret-value",
  });
  const seen: Request[] = [];
  let tamper: ((body: Record<string, unknown>, request: Request) => Record<string, unknown>) | null = null;
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), "https://photo.example.test"), init);
    seen.push(request.clone());
    const response = await server.fetch(request);
    if (!tamper || !response.headers.get("Content-Type")?.includes("json") || !response.ok) return response;
    const body = tamper(await response.json() as Record<string, unknown>, request);
    return new Response(JSON.stringify(body), { status: response.status, headers: { "Content-Type": "application/json" } });
  });
  let keys = 0;
  const clientFor = (userId: string) => createBrowserSharedAlbumClient({ identity: new FakeIdentity(defaultActor({ userId })), fetch: fetchSpy as typeof fetch, now: () => NOW });
  const actionsFor = (userId: string) => createSharedAlbumItems({
    client: clientFor(userId), uploader: server.uploader, newIdempotencyKey: () => `key-${++keys}`, sleep: async () => undefined,
  });
  const signal = new AbortController().signal;
  return { server, seen, fetchSpy, clientFor, actionsFor, signal, setTamper: (next: typeof tamper) => { tamper = next; } };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("browser shared album client (B12)", () => {
  it("sends albums and items on the contract's routes and streams a full-size download with a range", async () => {
    const t = setup();
    const owner = t.actionsFor(OWNER);
    const album = await owner.createAlbum("Synthetic album", t.signal);
    const item = await owner.addFile(album.id, FILE, t.signal);
    await owner.listItems(album.id, { limit: 10 }, t.signal);
    const placed = await Promise.all(t.seen.map(async (request) => {
      const url = new URL(request.url);
      return [request.method, `${url.pathname.slice(SHARING_CLOUD_PATH_PREFIX.length)}${url.search}`, request.headers.get("Idempotency-Key") !== null];
    }));
    expect(placed).toEqual([
      ["POST", "/albums", true],
      ["POST", `/albums/${album.id}/file-items`, true],
      ["POST", expect.stringMatching(new RegExp(`^/albums/${album.id}/uploads/mock-upload-\\d+/commit$`, "u")), true],
      ["GET", `/albums/${album.id}/items?limit=10`, false],
    ]);

    const client = t.clientFor(OWNER);
    const rendition = item.rendition as NonNullable<typeof item.rendition>;
    const content = await client.download({ albumId: album.id, itemId: item.id, renditionId: rendition.id, variant: "full", range: { start: 4, endInclusive: 99 } }, t.signal);
    expect(content).toMatchObject({ sha256: rendition.asset.sha256, totalBytes: rendition.asset.sizeBytes, range: { start: 4, endInclusive: 99 } });
    expect(new Uint8Array(await new Response(content.body).arrayBuffer())).toEqual((t.server.renditionBytes(item.id) as Uint8Array).subarray(4, 100));
    const download = t.seen[t.seen.length - 1] as Request;
    expect(download.method).toBe("GET");
    expect(new URL(download.url).search).toBe("?variant=full");
    expect(download.headers.get("Range")).toBe("bytes=4-99");

    expect(t.server.storageOf(OWNER).reservedBytes).toBe(0);
    await owner.removeItems(album.id, [item.id], t.signal);
    const removal = t.seen[t.seen.length - 1] as Request;
    expect([removal.method, new URL(removal.url).pathname]).toEqual(["DELETE", `${SHARING_CLOUD_PATH_PREFIX}/albums/${album.id}/items/${item.id}`]);
    expect(await removal.text()).toBe("");
  });

  it("refuses answers that show an original to someone else, carry extra metadata, resend a ticket or list a removed item", async () => {
    const t = setup();
    const owner = t.actionsFor(OWNER);
    const album = await owner.createAlbum("Synthetic album", t.signal);
    const owners = createSharedAlbumMembership({ client: t.server.clientFor(OWNER), sleep: async () => undefined });
    await createSharedAlbumMembership({ client: t.server.clientFor(VIEWER), sleep: async () => undefined }).join((await owners.createInvite(album.id, "viewer", t.signal)).secret, t.signal);
    const item = await owner.addFile(album.id, FILE, t.signal);
    const viewer = t.clientFor(VIEWER);
    const local = async (promise: Promise<unknown>) => ((await caught(promise)) as PersonalPhotoCloudError).code;

    t.setTamper((body) => ({ ...body, source: { kind: "devicePhoto", deviceSourceRef: "someone-elses-ref" } }));
    expect(await local(viewer.request("albumItems.get", { albumId: album.id, itemId: item.id }, { signal: t.signal }))).toBe("invalid_response");
    t.setTamper((body) => {
      const rendition = body.rendition as Record<string, unknown>;
      return { ...body, rendition: { ...rendition, metadata: { ...(rendition.metadata as object), gpsLatitude: 35.3 } } };
    });
    expect(await local(viewer.request("albumItems.get", { albumId: album.id, itemId: item.id }, { signal: t.signal }))).toBe("invalid_response");
    t.setTamper((body) => ({ ...body, items: [...(body.items as object[]), { ...(body.items as Record<string, unknown>[])[0], id: "removed-one", state: "removed", rendition: null, removedAt: "2026-11-07T00:00:00.000Z" }] }));
    expect(await local(viewer.request("albumItems.list", { albumId: album.id }, { signal: t.signal }))).toBe("invalid_response");
    t.setTamper((body, request) => {
      if (!new URL(request.url).pathname.endsWith("/file-items")) return body;
      return { ...body, replayed: true };
    });
    expect(await local(t.clientFor(OWNER).request("albumItems.addFile", { albumId: album.id, rendition: FILE.rendition }, { signal: t.signal, idempotencyKey: "tampered-add" }))).toBe("invalid_response");
    // A device photo answered with another device's original reference.
    t.setTamper((body, request) => {
      if (!new URL(request.url).pathname.endsWith("/photo-items")) return body;
      const value = body.value as { item: Record<string, unknown> };
      return { ...body, value: { ...value, item: { ...value.item, source: { kind: "devicePhoto", deviceSourceRef: "another-device-ref" } } } };
    });
    const device = { kind: "devicePhoto" as const, deviceSourceRef: "device-ref-1", binding: bindingFor(hex(FILE.bytes), recipeFor(1)), rendition: FILE.rendition };
    expect(await local(t.clientFor(OWNER).request("albumItems.addPhoto", { albumId: album.id, source: device }, { signal: t.signal, idempotencyKey: "tampered-device" }))).toBe("invalid_response");
    t.setTamper(null);

    // Requests outside the closed shapes are never sent.
    const before = t.fetchSpy.mock.calls.length;
    const owners2 = t.clientFor(OWNER);
    expect(await local(owners2.request("albumItems.addFile", { albumId: album.id, rendition: { ...FILE.rendition, metadata: { ...FILE.rendition.metadata, orientation: 6 as 1 } } }, { signal: t.signal, idempotencyKey: "bad-1" }))).toBe("invalid_response");
    expect(await local(owners2.request("albumItems.addPhoto", { albumId: album.id, source: { kind: "libraryPhoto", libraryId: "library", photoId: "../photo" } }, { signal: t.signal, idempotencyKey: "bad-2" }))).toBe("invalid_response");
    expect(await local(owners2.request("albumItems.remove", { albumId: album.id, itemId: item.id }, { signal: t.signal } as never))).toBe("invalid_response");
    expect(await local(owners2.request("invites.list" as never, { albumId: album.id } as never, { signal: t.signal } as never))).toBe("unsupported");
    expect(t.fetchSpy.mock.calls.length).toBe(before);
  });
});
