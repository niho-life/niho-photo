import "fake-indexeddb/auto";
import { HASH, IDS, library, maskedPhoto, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  PersonalPhotoCloudClient,
  PhotoOperation,
  PhotoOperationMap,
  PhotoRequestOptions,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import type { DevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";
import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import { describe, expect, it } from "vitest";
import type { PersonalPhotoResumableUploadState, PersonalPhotoResumableUploadTransport } from "@niho/photo-cloud-library/browser";

import { createPersonalPhotoCloudLibrary } from "../src/binding";
import { IndexedDbRecipeSyncJournal } from "../src/browser";
import type { RecipeSyncLocks } from "../src/types";

class Identity {
  private readonly listeners = new Set<() => void>();
  constructor(private actor: VerifiedPhotoActor | null = defaultActor()) {}
  getSnapshot(): VerifiedPhotoActor | null { return this.actor; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(actor: VerifiedPhotoActor | null): void { this.actor = actor; for (const listener of this.listeners) listener(); }
}

class Locks implements RecipeSyncLocks {
  async request<T>(_name: string, options: { mode: "exclusive"; signal: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    if (options.signal.aborted) throw options.signal.reason;
    return await callback();
  }
}

function setup(
  handler?: <K extends PhotoOperation>(operation: K, request: PhotoOperationMap[K]["request"]) => Promise<PhotoOperationMap[K]["response"]>,
  databaseName = `binding-${crypto.randomUUID()}`,
  identity = new Identity(),
  epoch = "epoch-1",
  masks?: {
    validator: { validateMaskSurface(png: Uint8Array): Promise<{ id: string; width: number; height: number }> };
    transport?: PersonalPhotoResumableUploadTransport;
  },
) {
  const calls: PhotoOperation[] = [];
  const client: PersonalPhotoCloudClient = {
    scope: { actorId: IDS.userA, libraryId: IDS.library, sessionEpoch: epoch },
    async request<K extends PhotoOperation>(operation: K, _request: PhotoOperationMap[K]["request"], _options: PhotoRequestOptions<K>) {
      calls.push(operation);
      return handler ? await handler(operation, _request) : defaultResponse(operation);
    },
    dispose() {},
  };
  let id = 0;
  const handle = createPersonalPhotoCloudLibrary({
    client,
    identity,
    hostRenderer: library.capabilities.renderer,
    engineAssets: { manifestUrl: () => "/manifest.json" },
    presets,
    memoryBudgets: { originalBytes: 1024 ** 2, workingCopyBytes: 1024 ** 2, previewBytes: 1024 ** 2 },
    clock: { now: () => Date.parse("2026-11-03T00:00:00.000Z") },
    journal: new IndexedDbRecipeSyncJournal(indexedDB, databaseName),
    locks: new Locks(),
    randomId: () => `binding-${++id}`,
    ...(masks === undefined ? {} : {
      maskSurfaceValidator: masks.validator,
      ...(masks.transport === undefined ? {} : { maskSurfaceTransport: masks.transport }),
    }),
  });
  const port = handle.library.durableDevelopDrafts!;
  return { handle, port, identity, calls };
}

describe("photo library durable binding", () => {
  it.each(["start-pending", "expired", "cancelled"] as const)("reconciles a persisted %s mask checkpoint before saving the recipe", async (phase) => {
    const databaseName = `binding-mask-reconcile-${crypto.randomUUID()}`;
    const png = new Uint8Array([5, 8, 13]);
    const surfaceId = Array.from(sha256(png), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const asset = { ...responses["masks.get"], id: surfaceId, sha256: surfaceId, sizeBytes: png.byteLength, width: 2, height: 2 };
    let stored = phase === "start-pending";
    const starts: PersonalPhotoResumableUploadState[] = [];
    const unused = async (): Promise<never> => { throw new Error("unexpected upload operation"); };
    const transport: PersonalPhotoResumableUploadTransport = {
      async start(state) {
        starts.push(structuredClone(state));
        stored = true;
        return { kind: "upload", upload: {
          id: "new-upload", target: state.target, sizeBytes: state.sizeBytes, sha256: state.sha256,
          expiresAt: "2030-01-01T00:00:00.000Z", state: "stored", result: { kind: "mask", photoId: IDS.photo, asset },
        }, lease: null };
      },
      read: unused, renew: unused, uploadChunk: unused, complete: unused, cancel: unused,
    };
    const fixture = setup(async (operation, request) => {
      if (operation === "masks.get") {
        if (!stored) throw { error: { code: "not_found", requestId: "mask", retryable: false } };
        return asset as PhotoOperationMap[typeof operation]["response"];
      }
      if (operation === "recipes.put") {
        const put = request as PhotoOperationMap["recipes.put"]["request"];
        return { ...responses["recipes.put"], value: { ...responses["recipes.put"].value, recipe: {
          ...maskedPhoto.recipe, revision: put.expectedRevision + 1, settings: put.settings,
          baseVersion: put.baseVersion, maskSurfaceIds: [surfaceId],
        } } } as PhotoOperationMap[typeof operation]["response"];
      }
      return defaultResponse(operation);
    }, databaseName, new Identity(), "epoch-1", {
      transport, validator: { async validateMaskSurface() { return { id: surfaceId, width: 2, height: 2 }; } },
    });
    const journal = new IndexedDbRecipeSyncJournal(indexedDB, databaseName);
    const actor = defaultActor();
    const scope = { actorId: actor.userId, libraryId: IDS.library, sessionId: actor.sessionId, sessionEpoch: actor.sessionEpoch, transport: actor.transport };
    try {
      const writer = fixture.port.open({ photoId: IDS.photo, sourceSha256: HASH.original, expectedRevision: 0 });
      await fixture.handle.library.saveMaskSurface!(IDS.photo, png);
      const staged = writer.stage({
        ...structuredClone(maskedPhoto.recipe.settings),
        masks: [{ id: "synthetic-sky", kind: "sky", surface: { id: surfaceId, width: 2, height: 2 }, adjust: { exposure: -0.5 } }],
      } as DevelopSettings);
      await staged.committed;
      const previous: PersonalPhotoResumableUploadState = {
        target: { kind: "mask", photoId: IDS.photo }, sizeBytes: png.byteLength, sha256: surfaceId, contentType: "image/png",
        startKey: "old-start", completeKey: "old-complete", cancelKey: "old-cancel", uploadId: null,
        deadline: null, offsetBytes: 0, phase,
      };
      expect(await journal.compareAndSetMaskUploadState(scope, IDS.photo, surfaceId, null, previous)).toBe(true);
      await expect(writer.save(staged)).resolves.toMatchObject({ kind: "saved" });
      expect((await journal.getMaskSurface(scope, IDS.photo, surfaceId))?.uploadState).toBeNull();
      if (phase === "start-pending") expect(starts).toEqual([]);
      else {
        expect(starts).toHaveLength(1);
        expect(starts[0]).toMatchObject({ phase: "start-pending", uploadId: null, offsetBytes: 0 });
        for (const key of ["startKey", "completeKey", "cancelKey"] as const) expect(starts[0]![key]).not.toBe(previous[key]);
      }
    } finally { fixture.handle.dispose(); journal.dispose(); }
  });

  it("persists validated mask bytes across reconstruction and waits for fresh STORED proof before recipe PUT", async () => {
    const databaseName = `binding-mask-${crypto.randomUUID()}`;
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const expectedPng = png.slice();
    const surfaceId = Array.from(sha256(png), (byte) => byte.toString(16).padStart(2, "0")).join("");
    let stored = false;
    const order: string[] = [];
    const asset = { ...responses["masks.get"], id: surfaceId, sha256: surfaceId, sizeBytes: png.byteLength, width: 2, height: 2 };
    const transport: PersonalPhotoResumableUploadTransport = {
      async start(state) {
        order.push("upload.start");
        stored = true;
        return { kind: "upload", upload: {
          id: "mask-upload", target: state.target, sizeBytes: state.sizeBytes, sha256: state.sha256,
          expiresAt: "2030-01-01T00:00:00.000Z", state: "stored", result: { kind: "mask", photoId: IDS.photo, asset },
        }, lease: null };
      },
      async read() { throw new Error("unexpected read"); },
      async renew() { throw new Error("unexpected renew"); },
      async uploadChunk() { throw new Error("unexpected chunk"); },
      async complete() { throw new Error("unexpected complete"); },
      async cancel() { throw new Error("unexpected cancel"); },
    };
    const validator = { async validateMaskSurface(bytes: Uint8Array) {
      return { id: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), width: 2, height: 2 };
    } };
    const handler = async <K extends PhotoOperation>(operation: K, request: PhotoOperationMap[K]["request"]): Promise<PhotoOperationMap[K]["response"]> => {
      if (operation === "masks.get") {
        const get = request as PhotoOperationMap["masks.get"]["request"];
        order.push(stored ? "mask.stored" : "mask.missing");
        if (!stored || get.photoId !== IDS.photo || get.surfaceId !== surfaceId) {
          throw { error: { code: "not_found", requestId: "mask", retryable: false } };
        }
        return asset as PhotoOperationMap[K]["response"];
      }
      if (operation === "recipes.put") {
        order.push("recipe.put");
        const put = request as PhotoOperationMap["recipes.put"]["request"];
        return { ...responses["recipes.put"], value: { ...responses["recipes.put"].value, recipe: {
          ...maskedPhoto.recipe,
          revision: put.expectedRevision + 1,
          settings: put.settings,
          baseVersion: put.baseVersion,
          maskSurfaceIds: [surfaceId],
        } } } as PhotoOperationMap[K]["response"];
      }
      return defaultResponse(operation);
    };
    const first = setup(handler, databaseName, new Identity(), "epoch-1", { validator, transport });
    const writer = first.port.open({ photoId: IDS.photo, sourceSha256: HASH.original, expectedRevision: 0 });
    try {
      await expect(first.handle.library.saveMaskSurface!(IDS.photo, png)).resolves.toEqual({ id: surfaceId, width: 2, height: 2 });
      png.fill(0);
      const settings = {
        ...structuredClone(maskedPhoto.recipe.settings),
        masks: [{ id: "synthetic-sky", kind: "sky", surface: { id: surfaceId, width: 2, height: 2 }, adjust: { exposure: -0.5 } }],
      } as DevelopSettings;
      const staged = writer.stage(settings);
      await expect(staged.committed).resolves.toBe("committed");
      await expect(writer.save(staged)).resolves.toMatchObject({ kind: "saved" });
      expect(order).toEqual(["mask.missing", "upload.start", "mask.stored", "recipe.put"]);
    } finally { first.handle.dispose(); }

    const reopened = setup(handler, databaseName, new Identity(), "epoch-1", { validator, transport });
    try {
      const loaded = await reopened.handle.library.loadMaskSurface!(IDS.photo, surfaceId);
      expect(loaded).toEqual(expectedPng);
      loaded?.fill(0);
      await expect(reopened.handle.library.loadMaskSurface!(IDS.photo, surfaceId)).resolves.toEqual(expectedPng);
      await expect(reopened.handle.library.loadMaskSurface!("other-photo", surfaceId)).resolves.toBeNull();
      await expect(reopened.handle.library.loadMaskSurface!(IDS.photo, "f".repeat(64))).resolves.toBeNull();
    } finally { reopened.handle.dispose(); }

    const mismatched = setup(handler, databaseName, new Identity(), "epoch-1", {
      transport,
      validator: { async validateMaskSurface(bytes: Uint8Array) {
        return { id: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), width: 3, height: 2 };
      } },
    });
    try {
      await expect(mismatched.handle.library.loadMaskSurface!(IDS.photo, surfaceId)).rejects.toEqual(
        expect.objectContaining({ code: "invalid_response" }),
      );
    } finally { mismatched.handle.dispose(); }
  });

  it("keeps mask bitmap editing closed when the actual SDK validator is absent", async () => {
    const fixture = setup();
    try {
      expect(fixture.handle.library.saveMaskSurface).toBeUndefined();
      expect(fixture.handle.library.loadMaskSurface).toBeUndefined();
      await expect(fixture.handle.library.capabilities()).resolves.not.toHaveProperty("maskSurfaces", true);
    } finally { fixture.handle.dispose(); }
  });

  it("keeps native mask editing closed without an opaque native upload transport", async () => {
    const fixture = setup(undefined, undefined, new Identity(defaultActor({ transport: "mac-bearer" })), "epoch-1", {
      validator: { async validateMaskSurface() { throw new Error("not called"); } },
    });
    try {
      await expect(fixture.handle.library.capabilities()).resolves.not.toHaveProperty("maskSurfaces", true);
    } finally { fixture.handle.dispose(); }
  });

  it("releases completed saves replaced before staging while retaining the staged mask reference", async () => {
    const databaseName = `binding-mask-replaced-${crypto.randomUUID()}`;
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    const validator = { async validateMaskSurface(bytes: Uint8Array) {
      return { id: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), width: 2, height: 2 };
    } };
    const fixture = setup(undefined, databaseName, new Identity(), "epoch-1", { validator });
    const journal = new IndexedDbRecipeSyncJournal(indexedDB, databaseName);
    const actor = defaultActor();
    const scope = {
      actorId: actor.userId, libraryId: IDS.library, sessionId: actor.sessionId,
      sessionEpoch: actor.sessionEpoch, transport: actor.transport,
    };
    try {
      const writer = fixture.port.open({ photoId: IDS.photo, sourceSha256: HASH.original, expectedRevision: 0 });
      const oldMask = await fixture.handle.library.saveMaskSurface!(IDS.photo, first);
      const currentMask = await fixture.handle.library.saveMaskSurface!(IDS.photo, second);
      const settings = {
        ...structuredClone(maskedPhoto.recipe.settings),
        masks: [{ id: "synthetic-sky", kind: "sky", surface: currentMask, adjust: { exposure: -0.5 } }],
      } as DevelopSettings;
      await expect(writer.stage(settings).committed).resolves.toBe("committed");
      expect((await journal.getMaskSurface(scope, IDS.photo, oldMask.id))?.pinLeases).toEqual([]);
      await expect(journal.deleteMaskSurface(scope, IDS.photo, oldMask.id)).resolves.toBe(true);
      await expect(journal.deleteMaskSurface(scope, IDS.photo, currentMask.id)).resolves.toBe(false);
    } finally { fixture.handle.dispose(); journal.dispose(); }
  });

  it("stages a full synchronous clone and returns only the exact ACK", async () => {
    const fixture = setup();
    try {
      const writer = fixture.port.open({
        photoId: IDS.photo,
        sourceSha256: responses["photos.get"].original.sha256,
        expectedRevision: 0,
      });
      const input = structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings;
      const originalExposure = input.exposure;
      const staged = writer.stage(input);
      input.exposure = 99;
      await expect(staged.committed).resolves.toBe("committed");
      const snapshot = await writer.read();
      expect(snapshot.latest?.settings.exposure).toBe(originalExposure);
      await expect(writer.save(staged)).resolves.toEqual({
        kind: "saved",
        revision: responses["recipes.put"].value.recipe.revision,
        updatedAt: responses["recipes.put"].value.recipe.updatedAt,
      });
    } finally { fixture.handle.dispose(); }
  });

  it("rejects another writer's stage and forged tokens", async () => {
    const fixture = setup();
    try {
      const input = { photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 };
      const first = fixture.port.open(input);
      const second = fixture.port.open(input);
      const staged = first.stage(structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings);
      await expect(second.save(staged)).rejects.toBeDefined();
      await expect(fixture.port.reopen(Object.freeze({ kind: "develop-draft" }))).rejects.toBeDefined();
    } finally { fixture.handle.dispose(); }
  });

  it("reopens the full latest snapshot and refuses discard while PUT outcome is unknown", async () => {
    const fixture = setup(async (operation) => {
      if (operation === "recipes.put") throw new Error("response lost");
      return defaultResponse(operation);
    });
    try {
      const writer = fixture.port.open({
        photoId: IDS.photo,
        sourceSha256: responses["photos.get"].original.sha256,
        expectedRevision: 0,
      });
      const staged = writer.stage(structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings);
      await staged.committed;
      await expect(writer.save(staged)).resolves.toMatchObject({ kind: "unknown" });
      const summary = (await fixture.port.list()).items[0]!;
      const reopened = await fixture.port.reopen(summary.token);
      const snapshot = await reopened.read();
      expect(snapshot).toMatchObject({ hasUnknownAttempt: true, latest: { settings: responses["photos.get"].recipe.settings }, attempted: { settings: responses["photos.get"].recipe.settings } });
      await expect(reopened.discard()).rejects.toBeDefined();
    } finally { fixture.handle.dispose(); }
  });

  it("hides all old-scope tokens and late reads after logout", async () => {
    const fixture = setup();
    try {
      const writer = fixture.port.open({ photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 });
      const staged = writer.stage(structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings);
      await staged.committed;
      fixture.identity.set(null);
      expect(fixture.port.isCurrent()).toBe(false);
      await expect(writer.read()).rejects.toBeDefined();
      await expect(fixture.port.list()).rejects.toBeDefined();
    } finally { fixture.handle.dispose(); }
  });

  it("projects previous recovery through a token map separate from normal drafts", async () => {
    const databaseName = `binding-previous-${crypto.randomUUID()}`;
    const old = setup(undefined, databaseName);
    const oldWriter = old.port.open({ photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 });
    await oldWriter.stage(structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings).committed;
    old.handle.dispose();

    const identity = new Identity(defaultActor({ sessionId: "parent-2", sessionEpoch: "epoch-2" }));
    const current = setup(undefined, databaseName, identity, "epoch-2");
    try {
      expect(current.port.previous).toBeDefined();
      await expect(current.port.list()).resolves.toEqual({ items: [], nextCursor: null });
      const previous = await current.port.previous!.list();
      expect(previous.items).toHaveLength(1);
      await expect(current.port.reopen(previous.items[0]!.token)).rejects.toBeDefined();

      const normalWriter = current.port.open({ photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 });
      await normalWriter.stage(structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings).committed;
      const normal = await current.port.list();
      await expect(current.port.previous!.reopen(normal.items[0]!.token)).rejects.toBeDefined();

      const recovered = await current.port.previous!.reopen(previous.items[0]!.token);
      expect(() => recovered.stage(structuredClone(responses["photos.get"].recipe.settings) as DevelopSettings)).toThrow();
      await expect(recovered.read()).resolves.toMatchObject({ latest: { settings: responses["photos.get"].recipe.settings } });
    } finally { current.handle.dispose(); }
  });

  it("uses an explicit previous grant to copy only its referenced PNG into the new scope", async () => {
    const databaseName = `binding-previous-mask-${crypto.randomUUID()}`;
    const png = new Uint8Array([137, 80, 78, 71, 9, 8, 7]);
    const surfaceId = Array.from(sha256(png), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const validator = { async validateMaskSurface(bytes: Uint8Array) {
      return { id: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), width: 2, height: 2 };
    } };
    let stored = false;
    const asset = { ...responses["masks.get"], id: surfaceId, sha256: surfaceId, sizeBytes: png.byteLength, width: 2, height: 2 };
    const transport: PersonalPhotoResumableUploadTransport = {
      async start(state) {
        stored = true;
        return { kind: "upload", upload: {
          id: "previous-mask-upload", target: state.target, sizeBytes: state.sizeBytes, sha256: state.sha256,
          expiresAt: "2030-01-01T00:00:00.000Z", state: "stored", result: { kind: "mask", photoId: IDS.photo, asset },
        }, lease: null };
      },
      async read() { throw new Error("unexpected read"); },
      async renew() { throw new Error("unexpected renew"); },
      async uploadChunk() { throw new Error("unexpected chunk"); },
      async complete() { throw new Error("unexpected complete"); },
      async cancel() { throw new Error("unexpected cancel"); },
    };
    const handler = async <K extends PhotoOperation>(operation: K, request: PhotoOperationMap[K]["request"]): Promise<PhotoOperationMap[K]["response"]> => {
      if (operation === "masks.get") {
        if (!stored) throw { error: { code: "not_found", requestId: "previous-mask", retryable: false } };
        return asset as PhotoOperationMap[K]["response"];
      }
      if (operation === "recipes.put") {
        const put = request as PhotoOperationMap["recipes.put"]["request"];
        return { ...responses["recipes.put"], value: { ...responses["recipes.put"].value, recipe: {
          ...maskedPhoto.recipe, revision: put.expectedRevision + 1, settings: put.settings,
          baseVersion: put.baseVersion, maskSurfaceIds: [surfaceId],
        } } } as PhotoOperationMap[K]["response"];
      }
      return defaultResponse(operation);
    };
    const settings = {
      ...structuredClone(maskedPhoto.recipe.settings),
      masks: [{ id: "synthetic-sky", kind: "sky", surface: { id: surfaceId, width: 2, height: 2 }, adjust: { exposure: -0.5 } }],
    } as DevelopSettings;
    const old = setup(handler, databaseName, new Identity(), "epoch-1", { validator, transport });
    const oldWriter = old.port.open({ photoId: IDS.photo, sourceSha256: HASH.original, expectedRevision: 0 });
    await old.handle.library.saveMaskSurface!(IDS.photo, png);
    await expect(oldWriter.stage(settings).committed).resolves.toBe("committed");
    old.handle.dispose();

    const currentIdentity = new Identity(defaultActor({ sessionId: "parent-2", sessionEpoch: "epoch-2" }));
    const current = setup(handler, databaseName, currentIdentity, "epoch-2", { validator, transport });
    try {
      await expect(current.handle.library.loadMaskSurface!(IDS.photo, surfaceId)).resolves.toBeNull();
      const previous = await current.port.previous!.list();
      const recovered = await current.port.previous!.reopen(previous.items[0]!.token);
      const snapshot = await recovered.read();
      if (snapshot.latestStage === null) throw new Error("missing previous stage");
      await expect(recovered.save(snapshot.latestStage)).resolves.toMatchObject({ kind: "saved" });
      await expect(current.handle.library.loadMaskSurface!(IDS.photo, surfaceId)).resolves.toEqual(png);

      const observer = new IndexedDbRecipeSyncJournal(indexedDB, databaseName);
      const oldRecord = await observer.getMaskSurface({
        actorId: IDS.userA, libraryId: IDS.library, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session",
      }, IDS.photo, surfaceId);
      expect(oldRecord?.uploadState).toBeNull();
      observer.dispose();
    } finally { current.handle.dispose(); }
  });

  it("binds conflicts and choices to one writer and fixes the fresh revision at comparison time", async () => {
    const conflict = responses["recipe-conflicts.get"];
    let currentRecipe = conflict.currentRecipe;
    const fixture = setup(async (operation) => {
      if (operation === "recipes.put") {
        throw { error: { code: "revision_conflict", requestId: "binding", retryable: false, currentRevision: conflict.currentRevision, conflictId: conflict.id } };
      }
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: currentRecipe } as never;
      return defaultResponse(operation);
    });
    try {
      const input = { photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: conflict.expectedRevision };
      const writer = fixture.port.open(input);
      const staged = writer.stage(structuredClone(conflict.conflictingRecipe.settings) as DevelopSettings);
      const saved = await writer.save(staged);
      expect(saved.kind).toBe("conflict");
      if (saved.kind !== "conflict") throw new Error("expected conflict");
      const comparison = await writer.compare(saved.conflict);
      expect(comparison.expectedRevision).toBe(conflict.currentRevision);

      const other = fixture.port.open(input);
      await expect(other.resolve(comparison.choice, "keep-current")).rejects.toBeDefined();

      currentRecipe = { ...currentRecipe, revision: currentRecipe.revision + 1 };
      await expect(writer.resolve(comparison.choice, "keep-current")).resolves.toEqual({ kind: "stale" });
      // adapter は観測中の写真が変わった最初の読みを fence し、同じ明示操作の再試行で新しい世代を返す。
      await expect(writer.compare(saved.conflict)).rejects.toBeDefined();
      const next = await writer.compare(saved.conflict);
      expect(next.expectedRevision).toBe(currentRecipe.revision);
      expect(next.choice).not.toBe(comparison.choice);
    } finally { fixture.handle.dispose(); }
  });
});

function defaultActor(overrides: Partial<VerifiedPhotoActor> = {}): VerifiedPhotoActor {
  return { userId: IDS.userA, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session", expiresAt: "2030-01-01T00:00:00.000Z", ...overrides };
}

function defaultResponse<K extends PhotoOperation>(operation: K): PhotoOperationMap[K]["response"] {
  if (operation === "library.get") return responses["library.get"] as PhotoOperationMap[K]["response"];
  if (operation === "photos.get") return responses["photos.get"] as PhotoOperationMap[K]["response"];
  if (operation === "recipes.put") return responses["recipes.put"] as PhotoOperationMap[K]["response"];
  if (operation === "recipe-conflicts.get") return responses["recipe-conflicts.get"] as PhotoOperationMap[K]["response"];
  if (operation === "recipe-conflicts.resolve") return responses["recipe-conflicts.resolve"] as PhotoOperationMap[K]["response"];
  throw new Error(`unexpected operation: ${operation}`);
}

const presets: PhotoLibraryPresets = {
  list: async () => [],
  create: async (value) => ({ id: "preset", name: value.name, xmp: value.xmp, source: value.source ?? "xmp", createdAt: "2026-11-03T00:00:00.000Z" }),
  rename: async (_id, name) => ({ id: "preset", name, xmp: "", source: "xmp", createdAt: "2026-11-03T00:00:00.000Z" }),
  delete: async () => undefined,
  nameMaxChars: 40,
  xmpMaxBytes: 1024,
  describeError: (_error, fallback) => fallback,
  isNameTaken: () => false,
};
