import "fake-indexeddb/auto";
import { IDS, library, responses } from "@niho/photo-personal-cloud-contract/fixtures";
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
  handler?: <K extends PhotoOperation>(operation: K) => Promise<PhotoOperationMap[K]["response"]>,
  databaseName = `binding-${crypto.randomUUID()}`,
  identity = new Identity(),
  epoch = "epoch-1",
) {
  const calls: PhotoOperation[] = [];
  const client: PersonalPhotoCloudClient = {
    scope: { actorId: IDS.userA, libraryId: IDS.library, sessionEpoch: epoch },
    async request<K extends PhotoOperation>(operation: K, _request: PhotoOperationMap[K]["request"], _options: PhotoRequestOptions<K>) {
      calls.push(operation);
      return handler ? await handler(operation) : defaultResponse(operation);
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
  });
  const port = handle.library.durableDevelopDrafts!;
  return { handle, port, identity, calls };
}

describe("photo library durable binding", () => {
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
