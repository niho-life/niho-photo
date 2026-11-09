import { describe, expect, it, vi } from "vitest";

import { requestInit } from "../src/browser/client";
import { PersonalPhotoCloudError } from "../src/errors";
import {
  createSharedAlbumClientOnTransport,
  createSharedAlbumItems,
  createSharedAlbumMembership,
  createSharedAlbumMembershipClientOnTransport,
  createSharedAlbumMockServer,
  isSharingErrorEnvelope,
  prepareAlbumFile,
  type SharingTransport,
} from "../src/sharing";
import { syntheticJpeg } from "./render-support";
import { defaultActor } from "./support";

const OWNER = "synthetic-user-owner";
const NOW = Date.parse("2026-11-07T00:00:00.000Z");
const FILE = prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 7 }));

/** A transport that is not the browser session: it hands each encoded route to the synthetic server (like native code would). */
function fakeTransport() {
  const server = createSharedAlbumMockServer({
    users: [{ userId: OWNER, displayName: "Synthetic Owner" }],
    now: () => NOW,
    newSecret: () => "synthetic-invite-secret-value",
  });
  const actor = defaultActor({ userId: OWNER });
  const sent: { readonly method: string; readonly path: string; readonly key: string | null; readonly limit: number }[] = [];
  let disposed = 0;
  const transport: SharingTransport = {
    scope: { actorId: OWNER, sessionEpoch: actor.sessionEpoch },
    async exchange(encoded, limit, signal) {
      sent.push({ method: encoded.method, path: encoded.path, key: encoded.idempotencyKey, limit });
      const response = await server.fetch(new Request(new URL(encoded.path, "https://photo.example.test"), requestInit(actor, encoded.method, encoded.body, null, encoded.idempotencyKey, signal)));
      return { status: response.status, value: await response.json() };
    },
    async stream() {
      throw new PersonalPhotoCloudError("unsupported");
    },
    dispose: () => { disposed += 1; },
  };
  return { server, transport, sent, disposed: () => disposed };
}

describe("shared clients on another transport", () => {
  it("use the same routes, keys and answer checks as the browser client", async () => {
    const t = fakeTransport();
    const client = createSharedAlbumClientOnTransport(t.transport);
    let keys = 0;
    const items = createSharedAlbumItems({ client, uploader: t.server.uploader, newIdempotencyKey: () => `key-${++keys}`, sleep: async () => undefined });
    const signal = new AbortController().signal;
    const album = await items.createAlbum("Synthetic album", signal);
    await items.addFile(album.id, FILE, signal);
    expect(t.sent.map(({ method, path }) => `${method} ${path.split("?")[0]?.replace(/\/[^/]*-[0-9a-f-]{8,}[^/]*/gu, "/{id}")}`)[0]).toBe("POST /cloud/sharing/v1/albums");
    expect(t.sent.every(({ path }) => path.startsWith("/cloud/sharing/v1/"))).toBe(true);
    expect(t.sent.filter(({ key }) => key !== null).every(({ key }) => /^key-\d+$/u.test(key ?? ""))).toBe(true);
    expect(t.sent.every(({ limit }) => limit > 0)).toBe(true);

    const membership = createSharedAlbumMembership({ client: createSharedAlbumMembershipClientOnTransport(t.transport), newIdempotencyKey: () => `key-${++keys}`, sleep: async () => undefined });
    const invite = await membership.createInvite(album.id, "contributor", signal);
    expect(invite.secret).toBe("synthetic-invite-secret-value");
  });

  it("turns error answers into the contract's envelope and refuses unchecked answers", async () => {
    const t = fakeTransport();
    const client = createSharedAlbumClientOnTransport(t.transport);
    const signal = new AbortController().signal;
    const missing = await client.request("albums.get", { albumId: "synthetic-missing-album" }, { signal }).catch((error: unknown) => error);
    expect(isSharingErrorEnvelope(missing) && missing.error.code).toBe("not_found");

    const odd = createSharedAlbumClientOnTransport({ ...t.transport, exchange: vi.fn(async () => ({ status: 200, value: { unexpected: true } })) });
    await expect(odd.request("albums.list", {}, { signal })).rejects.toBeInstanceOf(PersonalPhotoCloudError);
    const created = createSharedAlbumClientOnTransport({ ...t.transport, exchange: vi.fn(async () => ({ status: 201, value: {} })) });
    await expect(created.request("albums.list", {}, { signal })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("disposes the transport once and refuses use after", async () => {
    const t = fakeTransport();
    const client = createSharedAlbumClientOnTransport(t.transport);
    client.dispose();
    client.dispose();
    expect(t.disposed()).toBe(1);
    await expect(client.request("albums.list", {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "disposed" });
  });
});
