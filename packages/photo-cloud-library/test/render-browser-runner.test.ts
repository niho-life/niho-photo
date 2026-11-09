import { describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";

import { createBrowserRenderJobRunner } from "../src/render-executor";
import type { RecipeDocument } from "../src/render-executor/contract";
import { createSharedAlbumMockServer } from "../src/sharing";
import { CAPABILITY, bindingFor, hex, syntheticJpeg } from "./render-support";
import { FakeIdentity, defaultActor } from "./support";

const OWNER = "synthetic-user-owner";
const LIBRARY = "synthetic-library";
const NOW = Date.parse("2026-11-07T00:00:00.000Z");
const signal = new AbortController().signal;

function setup() {
  const server = createSharedAlbumMockServer({ users: [{ userId: OWNER, displayName: "Synthetic Owner" }], now: () => NOW });
  const originals = new Map<string, Uint8Array>();
  const addPhoto = async (albumId: string, photoId: string) => {
    const bytes = syntheticJpeg({ width: 1200, height: 800, seed: originals.size + 1 });
    originals.set(photoId, bytes);
    const recipe: RecipeDocument = {
      revision: 1, settings: { ...neutralDevelopSettings(), engine: "niho-14" } as unknown as RecipeDocument["settings"],
      settingsSha256: "c".repeat(64), baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-07T00:00:00.000Z",
    };
    server.addLibraryPhoto({ ownerId: OWNER, libraryId: LIBRARY, photoId, recipe, binding: { ...bindingFor(hex(bytes), recipe), engine: "niho-14" }, expectedOutput: { width: 1200, height: 800 } });
    await server.clientFor(OWNER).request("albumItems.addPhoto", { albumId, source: { kind: "libraryPhoto", libraryId: LIBRARY, photoId } }, { signal, idempotencyKey: `add-${photoId}` });
  };
  // The user's NIHO cloud library on this browser: the originals and nothing else.
  const handle = {
    rawPhoto: vi.fn(async (photoId: string) => {
      const bytes = originals.get(photoId);
      return bytes ? ({ id: photoId, original: { sha256: hex(bytes) }, format: "jpeg", width: 1200, height: 800, capturedAt: null } as never) : null;
    }),
    readAsset: vi.fn(async (photoId: string) => {
      const bytes = originals.get(photoId) as Uint8Array;
      return { body: new Blob([bytes.slice()]).stream(), contentType: "image/jpeg", sha256: hex(bytes), totalBytes: bytes.byteLength, range: { start: 0, endInclusive: bytes.byteLength - 1 } };
    }),
  };
  const engines: { dispose: ReturnType<typeof vi.fn> }[] = [];
  const createEngine = () => {
    const engine = {
      ready: vi.fn(async () => true),
      exportJpeg: vi.fn(async (_bytes: ArrayBuffer, _settings: object, options: { maxDimension: number }) => syntheticJpeg({ width: options.maxDimension, height: Math.round(options.maxDimension * 2 / 3) }) as Uint8Array<ArrayBuffer>),
      exportWorkingCopyJpeg: vi.fn(async () => { throw new Error("not used"); }),
      withCaptureExif: vi.fn(async (jpeg: Uint8Array<ArrayBuffer>) => jpeg),
      dispose: vi.fn(),
    };
    engines.push(engine);
    return engine;
  };
  // The provider: the synthetic bucket behind the mock's tickets.
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    await server.uploader.upload({ url: request.url } as never, bytes, request.headers.get("Content-Type") ?? "", signal);
    return new Response(null, { status: 200 });
  };
  const scope = new AbortController();
  const bffRequests: string[] = [];
  const claimBodies: unknown[] = [];
  const runner = createBrowserRenderJobRunner({
    identity: new FakeIdentity(defaultActor({ userId: OWNER })),
    userId: OWNER,
    fetch: async (input, init) => {
      const request = new Request(new URL(String(input), "https://photo.example.test"), init);
      bffRequests.push(new URL(request.url).pathname);
      if (request.url.endsWith("/claim")) claimBodies.push(await request.clone().json());
      return await server.fetch(request);
    },
    providerFetch,
    libraryId: LIBRARY,
    handle,
    capability: CAPABILITY,
    createEngine,
    scopeSignal: scope.signal,
    now: () => NOW,
  });
  const album = async () => (await server.clientFor(OWNER).request("albums.create", { name: "Synthetic album" }, { signal, idempotencyKey: `album-${Math.random()}` })).value;
  const items = async (albumId: string) => (await server.clientFor(OWNER).request("albumItems.list", { albumId }, { signal })).items;
  return { server, runner, scope, handle, engines, addPhoto, album, items, bffRequests, claimBodies };
}

describe("browser render job runner (B07 on the Web)", () => {
  it("renders the user's own added photos from their cloud originals with the pinned engine and commits them", async () => {
    const t = setup();
    const album = await t.album();
    await t.addPhoto(album.id, "photo-1");
    t.runner.wake();
    // A wake while draining runs one more drain afterwards (the second photo was added meanwhile).
    await t.addPhoto(album.id, "photo-2");
    t.runner.wake();
    await t.runner.idle();
    expect((await t.items(album.id)).map((item) => item.state)).toEqual(["published", "published"]);
    expect(t.handle.readAsset).toHaveBeenCalledTimes(2);
    // One engine for the work, released once the device had nothing left.
    expect(t.engines).toHaveLength(1);
    expect(t.engines[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(t.bffRequests.every((path) => path.startsWith("/cloud/sharing/v1/render-jobs/"))).toBe(true);

    // Nothing to do: no engine is created.
    t.runner.wake();
    await t.runner.idle();
    expect(t.engines).toHaveLength(1);
  });

  it("stops with the scope: no further claims, and the engine is released", async () => {
    const t = setup();
    const album = await t.album();
    await t.addPhoto(album.id, "photo-1");
    t.scope.abort();
    t.runner.wake();
    await t.runner.idle();
    expect(t.bffRequests).toEqual([]);
    expect((await t.items(album.id)).map((item) => item.state)).toEqual(["preparing"]);
    t.runner.dispose();
    t.runner.wake();
    await t.runner.idle();
    expect(t.bffRequests).toEqual([]);
  });

  it("names only this library's on-screen photos in the claims", async () => {
    const t = setup();
    const album = await t.album();
    await t.addPhoto(album.id, "photo-1");
    t.runner.prioritize([{ libraryId: LIBRARY, photoId: "photo-1" }, { libraryId: "another-library", photoId: "photo-9" }]);
    t.runner.wake();
    await t.runner.idle();
    expect(t.claimBodies[0]).toMatchObject({ prefer: { photoIds: ["photo-1"] } });
    expect((await t.items(album.id))[0]?.state).toBe("published");
  });
});
