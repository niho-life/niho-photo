import { indexedDB } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { IDS, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import type {
  PersonalPhotoCloudClient,
  PhotoOperation,
  PhotoOperationMap,
  PhotoRequestOptions,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import { PHOTO_LIMITS } from "@niho/photo-personal-cloud-contract";
import { describe, expect, it, vi } from "vitest";

import { IndexedDbRecipeSyncJournal } from "../src/browser";
import { createPersonalPhotoRecipeSync } from "../src/sync";
import type { JournalResolutionProof, LocalRecipeCandidate, RecipeJournalScope, RecipeSyncLocks, RecipeWriterBinding } from "../src/types";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");

class Identity {
  private listeners = new Set<() => void>();
  constructor(private actor: VerifiedPhotoActor | null = defaultActor()) {}
  getSnapshot(): VerifiedPhotoActor | null { return this.actor; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(actor: VerifiedPhotoActor | null): void { this.actor = actor; for (const listener of this.listeners) listener(); }
}

class Locks implements RecipeSyncLocks {
  private tails = new Map<string, Promise<void>>();
  async request<T>(name: string, options: { readonly mode: "exclusive"; readonly signal: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(name, prior.then(() => next));
    await prior;
    if (options.signal.aborted) throw options.signal.reason;
    try { return await callback(); }
    finally { release(); if (this.tails.get(name) === next) this.tails.delete(name); }
  }
}

type Handler = <K extends PhotoOperation>(operation: K, request: PhotoOperationMap[K]["request"], options: PhotoRequestOptions<K>) => Promise<PhotoOperationMap[K]["response"]>;

function harness(overrides: {
  readonly identity?: Identity;
  readonly handler?: Handler;
  readonly databaseName?: string;
  readonly locks?: RecipeSyncLocks;
  readonly timeoutMs?: number;
  readonly epoch?: string;
} = {}) {
  const identity = overrides.identity ?? new Identity(defaultActor({ sessionEpoch: overrides.epoch ?? "epoch-1" }));
  const calls: Array<{ operation: PhotoOperation; request: unknown; key: string | null }> = [];
  const handler: Handler = overrides.handler ?? (async (operation) => defaultResponse(operation));
  const client: PersonalPhotoCloudClient = {
    scope: { actorId: IDS.userA, libraryId: IDS.library, sessionEpoch: overrides.epoch ?? "epoch-1" },
    async request(operation, request, options) {
      calls.push({ operation, request: structuredClone(request), key: "idempotencyKey" in options ? options.idempotencyKey ?? null : null });
      return await handler(operation, request, options);
    },
    dispose() {},
  };
  const journal = new IndexedDbRecipeSyncJournal(indexedDB, overrides.databaseName ?? `sync-${crypto.randomUUID()}`);
  let id = 0;
  const sync = createPersonalPhotoRecipeSync({
    client,
    identity,
    hostRenderer: responses["library.get"].capabilities.renderer,
    journal,
    locks: overrides.locks ?? new Locks(),
    now: () => NOW,
    randomId: () => `synthetic-${++id}`,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
  return { sync, journal, identity, client, calls };
}

function candidate(overrides: Partial<LocalRecipeCandidate> = {}): LocalRecipeCandidate {
  return {
    settings: structuredClone(responses["photos.get"].recipe.settings),
    baseVersion: null,
    maskSurfaceIds: [],
    ...overrides,
  };
}

function begin(setup: ReturnType<typeof harness>) {
  return setup.sync.beginEditing({ photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 });
}

describe("durable recipe sync", () => {
  it.each(["adopt", "keep-current"] as const)("resolves another device's retained conflict with %s without staging or PUT", async (decision) => {
    const conflict = responses["recipe-conflicts.get"];
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: conflict.currentRecipe } as never;
      if (operation === "recipe-conflicts.resolve" && decision === "keep-current") return {
        replayed: false, value: { conflict: { ...conflict, resolution: "keep-current", resolvedAt: conflict.createdAt,
          resultingRevision: conflict.currentRevision }, recipe: conflict.currentRecipe },
      } as never;
      return defaultResponse(operation);
    } });
    const writer = setup.sync.beginEditing({ photoId: IDS.photo,
      sourceSha256: responses["photos.get"].original.sha256, expectedRevision: conflict.currentRevision });
    try {
      await expect(writer.getConflict(conflict.id)).resolves.toMatchObject({ id: conflict.id });
      await expect(writer.resolveConflict({ intentId: "remote-choice", conflictId: conflict.id,
        decision, expectedRevision: conflict.currentRevision })).resolves.toMatchObject({ status: "resolved" });
      expect(setup.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    } finally { setup.sync.dispose(); }
  });

  it("compares conflict snapshots structurally when JSON object key order changes", async () => {
    const conflict = responses["recipe-conflicts.get"];
    let reads = 0;
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
      return value;
    };
    const setup = harness({ handler: async (operation) => {
      if (operation === "recipes.put") throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false,
        currentRevision: conflict.currentRevision, conflictId: conflict.id } };
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: conflict.currentRecipe } as never;
      if (operation === "recipe-conflicts.get") return (reads++ === 0 ? conflict : reverseKeys(conflict)) as never;
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    try {
      const ref = writer.stage(candidate({ settings: conflict.conflictingRecipe.settings }));
      await expect(writer.save(ref)).resolves.toMatchObject({ status: "conflict" });
      await expect(writer.resolveConflict({ intentId: "reordered-choice", conflictId: conflict.id,
        decision: "adopt", expectedRevision: conflict.currentRevision })).resolves.toMatchObject({ status: "resolved" });
    } finally { setup.sync.dispose(); }
  });

  it("saves a finite negative-zero setting through JSON numeric semantics", async () => {
    const setup = harness();
    const writer = begin(setup);
    try {
      const ref = writer.stage(candidate({ settings: { ...candidate().settings, exposure: -0 } }));
      await expect(writer.save(ref)).resolves.toMatchObject({ status: "saved" });
      expect(setup.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(1);
    } finally { setup.sync.dispose(); }
  });

  it.each(["adopt", "keep-current"] as const)("keeps local B and its original CAS after resolving another device's conflict with %s", async (decision) => {
    const conflict = responses["recipe-conflicts.get"];
    const putRevisions: number[] = [];
    const setup = harness({ handler: async (operation, request) => {
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: conflict.currentRecipe } as never;
      if (operation === "recipe-conflicts.resolve") {
        return resolutionReceipt(decision, conflict.currentRevision, conflict.currentRecipe) as never;
      }
      if (operation === "recipes.put") {
        putRevisions.push((request as PhotoOperationMap["recipes.put"]["request"]).expectedRevision);
        throw { error: { code: "temporarily_unavailable", requestId: "synthetic", retryable: true } };
      }
      return defaultResponse(operation);
    } });
    const writer = setup.sync.beginEditing({
      photoId: IDS.photo,
      sourceSha256: responses["photos.get"].original.sha256,
      expectedRevision: 0,
    });
    try {
      const b = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.75 } }));
      await b.committed;
      await expect(writer.resolveConflict({
        intentId: `remote-b-${decision}`,
        conflictId: conflict.id,
        decision,
        expectedRevision: conflict.currentRevision,
      })).resolves.toMatchObject({ status: "resolved" });
      const reopened = await setup.sync.reopen(writer.token);
      await expect(reopened.latest?.committed).resolves.toMatchObject({ status: "committed", generation: 0 });
      await expect(writer.save(b)).resolves.toMatchObject({ status: "unknown", generation: 0 });
      expect(putRevisions).toEqual([0]);
    } finally { setup.sync.dispose(); }
  });

  it("reopens a server-only unknown resolution and retries its fixed key without PUT", async () => {
    const conflict = responses["recipe-conflicts.get"];
    const databaseName = `remote-resolve-reload-${crypto.randomUUID()}`;
    const resolveKeys: Array<string | undefined> = [];
    let loseResponse = true;
    const handler: Handler = async (operation, _request, options) => {
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: conflict.currentRecipe } as never;
      if (operation === "recipes.put") throw new Error("server-only resolve must not PUT");
      if (operation === "recipe-conflicts.resolve") {
        resolveKeys.push("idempotencyKey" in options ? options.idempotencyKey : undefined);
        if (loseResponse) throw { error: { code: "temporarily_unavailable", requestId: "synthetic", retryable: true } };
        return resolutionReceipt("adopt", conflict.currentRevision, conflict.currentRecipe) as never;
      }
      return defaultResponse(operation);
    };
    const first = harness({ databaseName, handler });
    const writer = first.sync.beginEditing({ photoId: IDS.photo,
      sourceSha256: responses["photos.get"].original.sha256, expectedRevision: conflict.currentRevision });
    const intent = { intentId: "remote-reload", conflictId: conflict.id,
      decision: "adopt" as const, expectedRevision: conflict.currentRevision };
    await expect(writer.resolveConflict(intent)).resolves.toEqual({ status: "unknown" });
    first.sync.dispose();

    loseResponse = false;
    const second = harness({ databaseName, handler });
    try {
      const pending = (await second.sync.listPending()).writers;
      expect(pending).toContainEqual(expect.objectContaining({ token: writer.token, hasUnknownAttempt: true }));
      const reopened = await second.sync.reopen(writer.token);
      expect(reopened.pendingResolution).toEqual(intent);
      await expect(reopened.writer.retryResolution()).resolves.toMatchObject({ status: "resolved" });
      expect(resolveKeys).toEqual([resolveKeys[0], resolveKeys[0]]);
      expect(second.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    } finally { second.sync.dispose(); }
  });

  it("rejects a server-only conflict when the fresh Photo source does not match", async () => {
    const conflict = responses["recipe-conflicts.get"];
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: conflict.currentRecipe } as never;
      return defaultResponse(operation);
    } });
    const writer = setup.sync.beginEditing({ photoId: IDS.photo, sourceSha256: "f".repeat(64), expectedRevision: 0 });
    try {
      await expect(writer.resolveConflict({ intentId: "remote-wrong-source", conflictId: conflict.id,
        decision: "adopt", expectedRevision: conflict.currentRevision })).resolves.toEqual({ status: "unsupported" });
      expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.get")).toHaveLength(0);
      expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.resolve")).toHaveLength(0);
    } finally { setup.sync.dispose(); }
  });

  it("persists a terminal fence when the fresh Photo for a server-only conflict is gone", async () => {
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    try {
      await expect(writer.resolveConflict({ intentId: "remote-photo-gone", conflictId: IDS.recipeConflict,
        decision: "adopt", expectedRevision: 1 })).resolves.toEqual({ status: "terminal", reason: "not-found" });
      const reopened = await setup.sync.reopen(writer.token);
      await expect(reopened.writer.retryResolution()).resolves.toEqual({ status: "terminal", reason: "not-found" });
      expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.resolve")).toHaveLength(0);
    } finally { setup.sync.dispose(); }
  });

  it.each([false, true])("distinguishes a missing server-only conflict from parent Photo purge (purged=%s)", async (purged) => {
    const conflict = responses["recipe-conflicts.get"];
    let photoReads = 0;
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") {
        photoReads += 1;
        if (purged && photoReads > 1) throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
        return { ...responses["photos.get"], recipe: conflict.currentRecipe } as never;
      }
      if (operation === "recipe-conflicts.get") throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      return defaultResponse(operation);
    } });
    const writer = setup.sync.beginEditing({ photoId: IDS.photo,
      sourceSha256: responses["photos.get"].original.sha256, expectedRevision: conflict.currentRevision });
    try {
      await expect(writer.resolveConflict({ intentId: `remote-missing-${purged}`, conflictId: conflict.id,
        decision: "keep-current", expectedRevision: conflict.currentRevision })).resolves.toEqual(
        purged ? { status: "terminal", reason: "not-found" } : { status: "stale" },
      );
      expect(photoReads).toBe(2);
      expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.resolve")).toHaveLength(0);
    } finally { setup.sync.dispose(); }
  });

  it.each([31, 32, 33])("counts depth %i from the settings root before and after durable reopen", async (depth) => {
    const setup = harness();
    const writer = begin(setup);
    let nested: unknown = null;
    for (let index = 1; index < depth; index += 1) nested = { next: nested };
    const input = candidate({ settings: { ...candidate().settings, future: nested } as never });
    try {
      if (depth <= 32) {
        await expect(writer.stage(input).committed).resolves.toMatchObject({ status: "committed" });
        const reopened = await setup.sync.reopen(writer.token);
        expect(reopened.latest).not.toBeNull();
        await expect(reopened.latest!.committed).resolves.toMatchObject({ status: "committed" });
      } else expect(() => writer.stage(input)).toThrow();
    } finally { setup.sync.dispose(); }
  });

  it.each(["stage", "list", "reopen"] as const)("bounds a signal-ignoring journal %s port", async (operation) => {
    vi.useFakeTimers();
    const setup = harness({ timeoutMs: 10 });
    const settled = vi.fn();
    try {
      vi.spyOn(setup.journal, operation).mockImplementation(() => new Promise<never>(() => undefined));
      if (operation === "stage") void begin(setup).stage(candidate()).committed.then(settled, settled);
      else if (operation === "list") void setup.sync.listPending().then(settled, settled);
      else void setup.sync.reopen("synthetic-token").then(settled, settled);
      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally { setup.sync.dispose(); vi.useRealTimers(); }
  });

  it("releases ACKed empty writer records on dispose so later photos can be edited", async () => {
    let revision = 0;
    const setup = harness({ handler: async (operation, request) => {
      if (operation === "photos.get") return { ...responses["photos.get"], recipe: { ...responses["photos.get"].recipe, revision } } as never;
      if (operation === "recipes.put") {
        const put = request as PhotoOperationMap["recipes.put"]["request"];
        revision = put.expectedRevision + 1;
        return { replayed: false, value: { ...responses["photos.get"], recipe: {
          ...responses["photos.get"].recipe, settings: put.settings, revision,
        } } } as never;
      }
      return defaultResponse(operation);
    } });
    try {
      for (let index = 0; index < 17; index += 1) {
        const writer = setup.sync.beginEditing({ photoId: IDS.photo,
          sourceSha256: responses["photos.get"].original.sha256, expectedRevision: revision });
        const ref = writer.stage(candidate());
        await expect(ref.committed, `writer ${index}`).resolves.toMatchObject({ status: "committed" });
        await expect(writer.save(ref)).resolves.toMatchObject({ status: "saved" });
        writer.dispose();
      }
    } finally { setup.sync.dispose(); }
  });

  it("releases all ACKed empty records when the sync controller is disposed", async () => {
    const databaseName = `sync-release-${crypto.randomUUID()}`;
    const first = harness({ databaseName });
    for (let index = 0; index < 16; index += 1) {
      const writer = first.sync.beginEditing({ photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 });
      await expect(writer.save(writer.stage(candidate()))).resolves.toMatchObject({ status: "saved" });
    }
    first.sync.dispose();
    const second = harness({ databaseName });
    const ref = second.sync.beginEditing({ photoId: IDS.photo, sourceSha256: responses["photos.get"].original.sha256, expectedRevision: 0 }).stage(candidate());
    await expect(ref.committed).resolves.toMatchObject({ status: "committed" });
    second.sync.dispose();
  });

  it("does not discard an unknown fixed-key attempt", async () => {
    const setup = harness({ handler: async (operation) => {
      if (operation === "recipes.put") throw new Error("response lost");
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    try {
      const ref = writer.stage(candidate());
      await ref.committed;
      await expect(writer.save(ref)).resolves.toMatchObject({ status: "unknown" });
      await writer.discard().catch(() => undefined);
      const page = await setup.sync.listPending();
      expect(page.writers).toContainEqual(expect.objectContaining({ token: writer.token, hasUnknownAttempt: true }));
    } finally { setup.sync.dispose(); }
  });

  it("commits the stage strictly before dispatching a mutation", async () => {
    const setup = harness();
    const original = setup.journal.stage.bind(setup.journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setup.journal.stage = async (...parameters) => { await gate; await original(...parameters); };
    const writer = begin(setup);
    const ref = writer.stage(candidate());
    const saving = writer.save(ref);
    await Promise.resolve();
    expect(setup.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    release();
    await expect(ref.committed).resolves.toMatchObject({ status: "committed" });
    await expect(saving).resolves.toMatchObject({ status: "saved" });
    expect(setup.calls.map((call) => call.operation)).toEqual(["library.get", "photos.get", "recipes.put"]);
    setup.sync.dispose();
  });

  it("stages B while A is in flight, ACKs only A, then derives B expectedRevision from A", async () => {
    let resolveA!: (value: PhotoOperationMap["recipes.put"]["response"]) => void;
    let puts = 0;
    const setup = harness({ handler: async (operation, request) => {
      if (operation === "recipes.put") {
        puts += 1;
        if (puts === 1) return await new Promise<PhotoOperationMap["recipes.put"]["response"]>((resolve) => { resolveA = resolve; }) as never;
        expect((request as PhotoOperationMap["recipes.put"]["request"]).expectedRevision).toBe(1);
        return recipeReceipt(2, (request as PhotoOperationMap["recipes.put"]["request"]).settings) as never;
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    const a = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.1 } }));
    const savingA = writer.save(a);
    await vi.waitFor(() => expect(setup.calls.some((call) => call.operation === "recipes.put")).toBe(true));
    const b = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.2 } }));
    await expect(b.committed).resolves.toMatchObject({ status: "committed" });
    resolveA(recipeReceipt(1, candidate({ settings: { ...candidate().settings, exposure: 0.1 } }).settings));
    await expect(savingA).resolves.toMatchObject({ status: "saved", generation: 0 });
    const reopened = await setup.sync.reopen(writer.token);
    expect(await reopened.latest?.committed).toMatchObject({ status: "committed", generation: 1 });
    await expect(writer.save(b)).resolves.toMatchObject({ status: "saved", generation: 1 });
    setup.sync.dispose();
  });

  it("reopens an unknown attempt after reload and reuses its exact key and body", async () => {
    const databaseName = `reload-${crypto.randomUUID()}`;
    let fail = true;
    const keys: Array<string | undefined> = [];
    const handler: Handler = async (operation, _request, options) => {
      if (operation === "recipes.put") {
        keys.push("idempotencyKey" in options ? options.idempotencyKey : undefined);
        if (fail) throw { error: { code: "temporarily_unavailable", requestId: "synthetic", retryable: true } };
        return recipeReceipt(1) as never;
      }
      return defaultResponse(operation);
    };
    const first = harness({ databaseName, handler });
    const writer = begin(first);
    const ref = writer.stage(candidate());
    await expect(writer.save(ref)).resolves.toMatchObject({ status: "unknown" });
    writer.dispose();
    first.sync.dispose();
    fail = false;
    const second = harness({ databaseName, handler });
    const page = await second.sync.listPending();
    expect(page.writers).toHaveLength(1);
    const reopened = await second.sync.reopen(page.writers[0]!.token);
    expect(reopened.hasUnknownAttempt).toBe(true);
    await expect(reopened.writer.retry()).resolves.toMatchObject({ status: "saved" });
    expect(keys).toEqual([keys[0], keys[0]]);
    second.sync.dispose();
  });

  it("does not expose or auto-replay an old epoch writer", async () => {
    const databaseName = `epoch-${crypto.randomUUID()}`;
    const old = harness({ databaseName });
    const writer = begin(old);
    await writer.stage(candidate()).committed;
    writer.dispose();
    old.sync.dispose();
    const nextIdentity = new Identity(defaultActor({ sessionEpoch: "epoch-2" }));
    const next = harness({ databaseName, identity: nextIdentity, epoch: "epoch-2" });
    await expect(next.sync.listPending()).resolves.toEqual({ writers: [], nextCursor: null });
    expect(next.calls).toHaveLength(0);
    next.sync.dispose();
  });

  it("allows local staging after expiry but closes on logout", async () => {
    const identity = new Identity(defaultActor());
    const setup = harness({ identity });
    const writer = begin(setup);
    identity.set(defaultActor({ expiresAt: "2026-11-02T00:00:00.000Z" }));
    await expect(writer.stage(candidate()).committed).resolves.toMatchObject({ status: "committed" });
    identity.set(null);
    expect(() => writer.stage(candidate())).toThrow();
    setup.sync.dispose();
  });

  it("preserves unknown JSON, separates settings and envelope byte limits, and closes depth 33", async () => {
    const setup = harness();
    const writer = begin(setup);
    const padding = "x".repeat(PHOTO_MIB - JSON.stringify(candidate().settings).length - 256);
    const near = candidate({ settings: { ...candidate().settings, future: { padding } } });
    await expect(writer.stage(near).committed).resolves.toMatchObject({ status: "committed" });
    const persisted = await setup.journal.reopen({ actorId: IDS.userA, libraryId: IDS.library, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session" }, writer.token);
    expect(persisted?.latest?.candidate.settings.future).toEqual({ padding });
    let nested: unknown = null;
    for (let index = 0; index < 33; index += 1) nested = { next: nested };
    expect(() => writer.stage(candidate({ settings: { ...candidate().settings, nested } as never }))).toThrow();
    setup.sync.dispose();
  });

  it("rejects non-JSON values instead of normalizing them through serialization", () => {
    const setup = harness();
    const writer = begin(setup);
    try {
      const classLike = Object.assign(Object.create({ inherited: true }) as object, { value: 1 });
      const invalidValues: unknown[] = [new Date(), new Map([["x", 1]]), classLike, undefined, Number.POSITIVE_INFINITY];
      for (const future of invalidValues) {
        expect(() => writer.stage(candidate({ settings: { ...candidate().settings, future } as never }))).toThrow();
      }
    } finally { setup.sync.dispose(); }
  });

  it("uses direct conflict GET and never depends on history pages", async () => {
    let put = 0;
    const setup = harness({ handler: async (operation) => {
      if (operation === "recipes.put") {
        put += 1;
        throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    const conflictCandidate = responses["recipe-conflicts.get"].conflictingRecipe;
    await expect(writer.save(writer.stage({
      settings: structuredClone(conflictCandidate.settings),
      baseVersion: conflictCandidate.baseVersion,
      maskSurfaceIds: structuredClone(conflictCandidate.maskSurfaceIds),
    }))).resolves.toMatchObject({ status: "conflict", conflict: { id: IDS.recipeConflict } });
    expect(put).toBe(1);
    expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.get")).toHaveLength(1);
    expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.list")).toHaveLength(0);
    setup.sync.dispose();
  });

  it("keeps an unknown resolve on one intent/key and permits a new key only after known stale", async () => {
    let resolveCalls = 0;
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") return {
        ...responses["photos.get"],
        recipe: { ...responses["photos.get"].recipe, revision: 1 },
      } as never;
      if (operation === "recipes.put") throw {
        error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict },
      };
      if (operation === "recipe-conflicts.resolve") {
        resolveCalls += 1;
        if (resolveCalls === 1) throw { error: { code: "temporarily_unavailable", requestId: "synthetic", retryable: true } };
        if (resolveCalls === 2) throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 2 } };
        return responses["recipe-conflicts.resolve"] as never;
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    const conflict = responses["recipe-conflicts.get"].conflictingRecipe;
    await expect(writer.save(writer.stage({
      settings: structuredClone(conflict.settings),
      baseVersion: conflict.baseVersion,
      maskSurfaceIds: structuredClone(conflict.maskSurfaceIds),
    }))).resolves.toMatchObject({ status: "conflict" });
    const first = { intentId: "choice-1", conflictId: IDS.recipeConflict, decision: "adopt" as const, expectedRevision: 1 };
    await expect(writer.resolveConflict(first)).resolves.toEqual({ status: "unknown" });
    await expect(writer.resolveConflict({ ...first, intentId: "choice-2" })).resolves.toEqual({ status: "unknown" });
    await expect(writer.resolveConflict(first)).resolves.toEqual({ status: "stale" });
    const before = setup.calls.filter((call) => call.operation === "recipe-conflicts.resolve");
    expect(before[0]?.key).toBe(before[1]?.key);
    await expect(writer.resolveConflict({ ...first, intentId: "choice-2" })).resolves.toMatchObject({ status: "resolved" });
    const after = setup.calls.filter((call) => call.operation === "recipe-conflicts.resolve");
    expect(after[2]?.key).not.toBe(after[1]?.key);
    setup.sync.dispose();
  });

  it("reopens an unknown resolve and retries only its fixed resolve key", async () => {
    const databaseName = `resolve-reload-${crypto.randomUUID()}`;
    const resolveKeys: Array<string | undefined> = [];
    let loseResponse = true;
    let puts = 0;
    const handler: Handler = async (operation, _request, options) => {
      if (operation === "photos.get") return photoAtRevision(1) as never;
      if (operation === "recipes.put") {
        puts += 1;
        throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      }
      if (operation === "recipe-conflicts.resolve") {
        resolveKeys.push("idempotencyKey" in options ? options.idempotencyKey : undefined);
        if (loseResponse) throw { error: { code: "temporarily_unavailable", requestId: "synthetic", retryable: true } };
        return responses["recipe-conflicts.resolve"] as never;
      }
      return defaultResponse(operation);
    };
    const first = harness({ databaseName, handler });
    const writer = begin(first);
    const conflict = responses["recipe-conflicts.get"].conflictingRecipe;
    await expect(writer.save(writer.stage(localCandidate(conflict)))).resolves.toMatchObject({ status: "conflict" });
    const intent = { intentId: "reload-choice", conflictId: IDS.recipeConflict, decision: "adopt" as const, expectedRevision: 1 };
    await expect(writer.resolveConflict(intent)).resolves.toEqual({ status: "unknown" });
    await writer.discard().catch(() => undefined);
    expect((await first.sync.listPending()).writers).toContainEqual(expect.objectContaining({ token: writer.token, hasUnknownAttempt: true }));
    first.sync.dispose();

    loseResponse = false;
    const second = harness({ databaseName, handler });
    const token = (await second.sync.listPending()).writers[0]!.token;
    const reopened = await second.sync.reopen(token);
    expect(reopened.pendingResolution).toEqual(intent);
    await expect(reopened.writer.retryResolution()).resolves.toMatchObject({ status: "resolved" });
    expect(resolveKeys).toEqual([resolveKeys[0], resolveKeys[0]]);
    expect(puts).toBe(1);
    second.sync.dispose();
  });

  it.each(["adopt", "keep-current"] as const)("resolves A with %s without deleting later B or rebasing keep-current", async (decision) => {
    let putCalls = 0;
    const expectedRevisions: number[] = [];
    const setup = harness({ handler: async (operation, request) => {
      if (operation === "photos.get") return photoAtRevision(1) as never;
      if (operation === "recipes.put") {
        putCalls += 1;
        const put = request as PhotoOperationMap["recipes.put"]["request"];
        if (putCalls === 1) throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
        expectedRevisions.push(put.expectedRevision);
        throw { error: { code: "temporarily_unavailable", requestId: "synthetic", retryable: true } };
      }
      if (operation === "recipe-conflicts.resolve") return resolutionReceipt(decision, 1, photoAtRevision(1).recipe) as never;
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    const conflict = responses["recipe-conflicts.get"].conflictingRecipe;
    await expect(writer.save(writer.stage(localCandidate(conflict)))).resolves.toMatchObject({ status: "conflict", generation: 0 });
    const b = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.75 } }));
    await b.committed;
    await expect(writer.resolveConflict({
      intentId: `choice-${decision}`,
      conflictId: IDS.recipeConflict,
      decision,
      expectedRevision: 1,
    })).resolves.toMatchObject({ status: "resolved" });
    const reopened = await setup.sync.reopen(writer.token);
    expect(await reopened.latest?.committed).toMatchObject({ status: "committed", generation: 1 });
    await expect(writer.save(b)).resolves.toMatchObject({ status: "unknown", generation: 1 });
    expect(expectedRevisions).toEqual([decision === "adopt" ? 2 : 0]);
    setup.sync.dispose();
  });

  it.each(["adopt", "keep-current"] as const)("clears only resolved A after %s when no later draft exists", async (decision) => {
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") return photoAtRevision(1) as never;
      if (operation === "recipes.put") throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      if (operation === "recipe-conflicts.resolve") return resolutionReceipt(decision, 1, photoAtRevision(1).recipe) as never;
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(localCandidate(responses["recipe-conflicts.get"].conflictingRecipe)))).resolves.toMatchObject({ status: "conflict" });
    await expect(writer.resolveConflict({ intentId: `only-${decision}`, conflictId: IDS.recipeConflict, decision, expectedRevision: 1 })).resolves.toMatchObject({ status: "resolved" });
    const reopened = await setup.sync.reopen(writer.token);
    expect(reopened.latest).toBeNull();
    expect((await setup.sync.listPending()).writers).toHaveLength(0);
    setup.sync.dispose();
  });

  it("accepts a fresh revision-4 choice over an immutable revision-1 conflict and rejects a wrong receipt first", async () => {
    const keys: Array<string | undefined> = [];
    let resolveCalls = 0;
    const fresh = photoAtRevision(4);
    const setup = harness({ handler: async (operation, _request, options) => {
      if (operation === "photos.get") return fresh as never;
      if (operation === "recipes.put") throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      if (operation === "recipe-conflicts.resolve") {
        resolveCalls += 1;
        keys.push("idempotencyKey" in options ? options.idempotencyKey : undefined);
        const correct = resolutionReceipt("adopt", 4, fresh.recipe);
        if (resolveCalls === 1) return {
          ...correct,
          value: { ...correct.value, recipe: { ...correct.value.recipe, revision: 6 } },
        } as never;
        return correct as never;
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(localCandidate(responses["recipe-conflicts.get"].conflictingRecipe)))).resolves.toMatchObject({ status: "conflict" });
    await expect(writer.resolveConflict({ intentId: "fresh-four", conflictId: IDS.recipeConflict, decision: "adopt", expectedRevision: 4 })).resolves.toEqual({ status: "unknown" });
    await expect(writer.retryResolution()).resolves.toMatchObject({ status: "resolved", resolution: { recipe: { revision: 5 } } });
    expect(keys).toEqual([keys[0], keys[0]]);
    setup.sync.dispose();
  });

  it("binds keep-current replay to the exact fresh unknown JSON snapshot", async () => {
    const fresh = {
      ...photoAtRevision(4),
      recipe: {
        ...photoAtRevision(4).recipe,
        settings: { ...photoAtRevision(4).recipe.settings, future: { retained: [1, { value: true }] } },
      },
    };
    let resolveCalls = 0;
    let conflictEstablished = false;
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") return (conflictEstablished ? fresh : photoAtRevision(4)) as never;
      if (operation === "recipes.put") {
        conflictEstablished = true;
        throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      }
      if (operation === "recipe-conflicts.resolve") {
        resolveCalls += 1;
        const correct = resolutionReceipt("keep-current", 4, fresh.recipe);
        if (resolveCalls === 1) return {
          ...correct,
          value: { ...correct.value, recipe: { ...correct.value.recipe, settings: { ...correct.value.recipe.settings, future: { retained: [] } } } },
        } as never;
        return correct as never;
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(localCandidate(responses["recipe-conflicts.get"].conflictingRecipe)))).resolves.toMatchObject({ status: "conflict" });
    await expect(writer.resolveConflict({ intentId: "keep-unknown", conflictId: IDS.recipeConflict, decision: "keep-current", expectedRevision: 4 })).resolves.toEqual({ status: "unknown" });
    await expect(writer.retryResolution()).resolves.toMatchObject({ status: "resolved", resolution: { recipe: { settings: fresh.recipe.settings } } });
    setup.sync.dispose();
  });

  it("turns a preflight Photo 404 into a terminal fence without creating a PUT key", async () => {
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(candidate()))).resolves.toMatchObject({ status: "terminal", reason: "not-found" });
    await expect(writer.save(writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.9 } })))).resolves.toMatchObject({ status: "terminal" });
    expect(setup.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    setup.sync.dispose();
  });

  it("distinguishes a missing conflict from a purged Photo and fences the purged binding", async () => {
    let photoGets = 0;
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get") {
        photoGets += 1;
        if (photoGets > 1) throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
        return responses["photos.get"] as never;
      }
      if (operation === "recipes.put") throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      if (operation === "recipe-conflicts.get") throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(localCandidate(responses["recipe-conflicts.get"].conflictingRecipe)))).resolves.toMatchObject({ status: "terminal", reason: "not-found" });
    await expect(writer.save(writer.stage(candidate()))).resolves.toMatchObject({ status: "terminal" });
    expect(setup.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(1);
    setup.sync.dispose();
  });

  it("fences a Photo purged before resolve starts and never sends the resolve mutation", async () => {
    let purged = false;
    const setup = harness({ handler: async (operation) => {
      if (operation === "photos.get" && purged) throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      if (operation === "recipes.put") throw { error: { code: "revision_conflict", requestId: "synthetic", retryable: false, currentRevision: 1, conflictId: IDS.recipeConflict } };
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(localCandidate(responses["recipe-conflicts.get"].conflictingRecipe)))).resolves.toMatchObject({ status: "conflict" });
    purged = true;
    await expect(writer.resolveConflict({ intentId: "purged", conflictId: IDS.recipeConflict, decision: "adopt", expectedRevision: 1 })).resolves.toEqual({ status: "terminal", reason: "not-found" });
    expect(setup.calls.filter((call) => call.operation === "recipe-conflicts.resolve")).toHaveLength(0);
    setup.sync.dispose();
  });

  it("keeps unsupported source/base/mask/RAW candidates durable without PUT", async () => {
    const wrongSource = harness();
    const writer = wrongSource.sync.beginEditing({ photoId: IDS.photo, sourceSha256: "f".repeat(64), expectedRevision: 0 });
    await expect(writer.save(writer.stage(candidate()))).resolves.toMatchObject({ status: "unsupported" });
    const based = begin(wrongSource);
    await expect(based.save(based.stage(candidate({ baseVersion: "raster-v1", settings: { ...candidate().settings, base: "raster-v1" } })))).resolves.toMatchObject({ status: "unsupported" });
    const masked = begin(wrongSource);
    await expect(masked.save(masked.stage(candidate({ maskSurfaceIds: ["d".repeat(64)] })))).resolves.toMatchObject({ status: "unsupported" });
    expect(wrongSource.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    wrongSource.sync.dispose();

    const raw = harness({ handler: async (operation) => {
      if (operation === "photos.get") return { ...responses["photos.get"], format: "raw" } as never;
      return defaultResponse(operation);
    } });
    const rawWriter = begin(raw);
    await expect(rawWriter.save(rawWriter.stage(candidate()))).resolves.toMatchObject({ status: "unsupported" });
    expect(raw.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    raw.sync.dispose();

    const unknownCurrent = harness({ handler: async (operation) => {
      if (operation === "photos.get") return {
        ...responses["photos.get"],
        recipe: { ...responses["photos.get"].recipe, settings: { ...responses["photos.get"].recipe.settings, v: 999, unknown: true } },
      } as never;
      return defaultResponse(operation);
    } });
    const unknownWriter = begin(unknownCurrent);
    await expect(unknownWriter.save(unknownWriter.stage(candidate()))).resolves.toMatchObject({ status: "unsupported" });
    expect(unknownCurrent.calls.filter((call) => call.operation === "recipes.put")).toHaveLength(0);
    unknownCurrent.sync.dispose();
  });

  it("settles a signal-ignoring lock at the finite deadline without dispatch", async () => {
    const locks: RecipeSyncLocks = { request: async () => await new Promise<never>(() => undefined) };
    const setup = harness({ locks, timeoutMs: 100 });
    const writer = begin(setup);
    const ref = writer.stage(candidate());
    await ref.committed;
    vi.useFakeTimers();
    try {
      const pending = writer.save(ref);
      await vi.advanceTimersByTimeAsync(101);
      await expect(pending).resolves.toMatchObject({ status: "unknown" });
      expect(setup.calls).toHaveLength(0);
      setup.sync.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("does not publish a late ACK from a signal-ignoring client and retries the same fixed key", async () => {
    let resolveLate!: (value: PhotoOperationMap["recipes.put"]["response"]) => void;
    let first = true;
    const keys: Array<string | undefined> = [];
    const setup = harness({ timeoutMs: 100, handler: async (operation, _request, options) => {
      if (operation === "recipes.put") {
        keys.push("idempotencyKey" in options ? options.idempotencyKey : undefined);
        if (first) {
          first = false;
          return await new Promise<PhotoOperationMap["recipes.put"]["response"]>((resolve) => { resolveLate = resolve; }) as never;
        }
        return recipeReceipt(1) as never;
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    const ref = writer.stage(candidate());
    await ref.committed;
    vi.useFakeTimers();
    try {
      const pending = writer.save(ref);
      await vi.advanceTimersByTimeAsync(101);
      await expect(pending).resolves.toMatchObject({ status: "unknown" });
      resolveLate(recipeReceipt(1));
      await vi.advanceTimersByTimeAsync(1);
    } finally { vi.useRealTimers(); }
    const persisted = await setup.journal.reopen({ actorId: IDS.userA, libraryId: IDS.library, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session" }, writer.token);
    expect(persisted?.attempt).not.toBeNull();
    await expect(writer.retry()).resolves.toMatchObject({ status: "saved" });
    expect(keys).toEqual([keys[0], keys[0]]);
    setup.sync.dispose();
  });

  it("keeps one active stage plus the latest queued stage and settles the replaced payload", async () => {
    const setup = harness();
    const original = setup.journal.stage.bind(setup.journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    setup.journal.stage = async (...parameters) => {
      calls += 1;
      if (calls === 1) await gate;
      await original(...parameters);
    };
    const writer = begin(setup);
    const a = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.1 } }));
    const b = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.2 } }));
    const c = writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.3 } }));
    await expect(b.committed).resolves.toEqual({ status: "superseded" });
    release();
    await expect(a.committed).resolves.toMatchObject({ status: "committed", generation: 0 });
    await expect(c.committed).resolves.toMatchObject({ status: "committed", generation: 2 });
    const persisted = await setup.journal.reopen({ actorId: IDS.userA, libraryId: IDS.library, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session" }, writer.token);
    expect(persisted?.latest?.candidate.settings.exposure).toBe(0.3);
    setup.sync.dispose();
  });

  it("aborts a delayed stage on logout without a late journal mutation", async () => {
    const setup = harness();
    const original = setup.journal.stage.bind(setup.journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setup.journal.stage = async (...parameters) => { await gate; await original(...parameters); };
    const writer = begin(setup);
    const ref = writer.stage(candidate());
    setup.identity.set(null);
    release();
    await expect(ref.committed).resolves.toMatchObject({ status: "unsaved" });
    await expect(setup.journal.reopen({ actorId: IDS.userA, libraryId: IDS.library, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session" }, writer.token)).resolves.toBeNull();
    setup.sync.dispose();
  });

  it("serializes two tabs on the same writer and CAS-ACKs the exact generation once", async () => {
    const databaseName = `multitab-${crypto.randomUUID()}`;
    const locks = new Locks();
    let puts = 0;
    const handler: Handler = async (operation) => {
      if (operation === "recipes.put") { puts += 1; return recipeReceipt(1) as never; }
      return defaultResponse(operation);
    };
    const first = harness({ databaseName, locks, handler });
    const writerA = begin(first);
    const refA = writerA.stage(candidate());
    await refA.committed;
    const second = harness({ databaseName, locks, handler });
    const token = (await second.sync.listPending()).writers[0]!.token;
    const reopened = await second.sync.reopen(token);
    const [a, b] = await Promise.all([
      writerA.save(refA),
      reopened.writer.save(reopened.latest!),
    ]);
    expect([a.status, b.status].sort()).toEqual(["saved", "unknown"]);
    expect(puts).toBe(1);
    first.sync.dispose();
    second.sync.dispose();
  });

  it("persists a 404 terminal fence and never creates a new key for a later draft", async () => {
    let puts = 0;
    const setup = harness({ handler: async (operation) => {
      if (operation === "recipes.put") {
        puts += 1;
        throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    await expect(writer.save(writer.stage(candidate()))).resolves.toMatchObject({ status: "terminal", reason: "not-found" });
    await expect(writer.save(writer.stage(candidate({ settings: { ...candidate().settings, exposure: 0.4 } })))).resolves.toMatchObject({ status: "terminal", reason: "not-found" });
    expect(puts).toBe(1);
    setup.sync.dispose();
  });

  it("replays an ACKed ref with the same key and turns a later purge into terminal", async () => {
    let puts = 0;
    const keys: Array<string | undefined> = [];
    const setup = harness({ handler: async (operation, _request, options) => {
      if (operation === "recipes.put") {
        puts += 1;
        keys.push("idempotencyKey" in options ? options.idempotencyKey : undefined);
        if (puts === 1) return recipeReceipt(1) as never;
        throw { error: { code: "not_found", requestId: "synthetic", retryable: false } };
      }
      return defaultResponse(operation);
    } });
    const writer = begin(setup);
    const ref = writer.stage(candidate());
    await expect(writer.save(ref)).resolves.toMatchObject({ status: "saved" });
    await expect(writer.save(ref)).resolves.toMatchObject({ status: "terminal", reason: "not-found" });
    expect(keys).toEqual([keys[0], keys[0]]);
    setup.sync.dispose();
  });

  it("enforces 16 writers per scope without evicting earlier drafts", async () => {
    const setup = harness();
    const refs = [];
    for (let index = 0; index < 17; index += 1) refs.push(setup.sync.beginEditing({ photoId: `photo-${index}`, sourceSha256: "a".repeat(64), expectedRevision: 0 }).stage(candidate()));
    const results = await Promise.all(refs.map((ref) => ref.committed));
    expect(results.slice(0, 16).every((result) => result.status === "committed")).toBe(true);
    expect(results[16]).toMatchObject({ status: "unsaved", reason: "quota" });
    expect((await setup.sync.listPending()).writers).toHaveLength(16);
    setup.sync.dispose();
  });

  it("pages pending writers by opaque cursor without skipping records", async () => {
    const setup = harness();
    for (let index = 0; index < 5; index += 1) {
      await setup.sync.beginEditing({ photoId: `page-${index}`, sourceSha256: "a".repeat(64), expectedRevision: 0 }).stage(candidate()).committed;
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await setup.sync.listPending({ ...(cursor === undefined ? {} : { cursor }), limit: 2 });
      seen.push(...page.writers.map((writer) => writer.photoId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen.sort()).toEqual(["page-0", "page-1", "page-2", "page-3", "page-4"]);
    setup.sync.dispose();
  });

  it("settles a default IndexedDB open that never produces a database when aborted", async () => {
    const neverFactory = { open: () => ({}) } as unknown as IDBFactory;
    const journal = new IndexedDbRecipeSyncJournal(neverFactory, "never-open");
    const abort = new AbortController();
    const pending = journal.reopen({
      actorId: IDS.userA,
      libraryId: IDS.library,
      sessionId: "parent-1",
      sessionEpoch: "epoch-1",
      transport: "browser-session",
    }, "never-token", abort.signal);
    abort.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    journal.dispose();
  });

  it("enforces the 64-writer global budget across distinct session scopes", async () => {
    const databaseName = `global-budget-${crypto.randomUUID()}`;
    const setups: Array<ReturnType<typeof harness>> = [];
    for (let scopeIndex = 0; scopeIndex < 4; scopeIndex += 1) {
      const identity = new Identity(defaultActor({ sessionId: `session-${scopeIndex}` }));
      const setup = harness({ databaseName, identity });
      setups.push(setup);
      for (let index = 0; index < 16; index += 1) {
        const ref = setup.sync.beginEditing({ photoId: `photo-${scopeIndex}-${index}`, sourceSha256: "a".repeat(64), expectedRevision: 0 }).stage(candidate());
        await expect(ref.committed).resolves.toMatchObject({ status: "committed" });
      }
    }
    const fifth = harness({ databaseName, identity: new Identity(defaultActor({ sessionId: "session-5" })) });
    setups.push(fifth);
    const overflow = fifth.sync.beginEditing({ photoId: "overflow", sourceSha256: "a".repeat(64), expectedRevision: 0 }).stage(candidate());
    await expect(overflow.committed).resolves.toMatchObject({ status: "unsaved", reason: "quota" });
    for (const setup of setups) setup.sync.dispose();
  });

  it("enforces the 32MiB scope budget using actual serialized draft and resolve-proof bytes", async () => {
    const journal = new IndexedDbRecipeSyncJournal(indexedDB, `scope-byte-budget-${crypto.randomUUID()}`);
    const scope: RecipeJournalScope = { actorId: IDS.userA, libraryId: IDS.library, sessionId: "byte-scope", sessionEpoch: "epoch-1", transport: "browser-session" };
    const large = maximumCandidate();
    for (let index = 0; index < 15; index += 1) await storePendingResolution(journal, scope, index, large);
    await expect(storePendingResolution(journal, scope, 15, large)).rejects.toMatchObject({ name: "QuotaExceededError" });
    journal.dispose();
  });

  it("enforces the 128MiB global budget with 64 actual serialized records before the count limit", async () => {
    const journal = new IndexedDbRecipeSyncJournal(indexedDB, `global-byte-budget-${crypto.randomUUID()}`);
    const large = maximumCandidate();
    let index = 0;
    for (let scopeIndex = 0; scopeIndex < 4; scopeIndex += 1) {
      const scope: RecipeJournalScope = { actorId: IDS.userA, libraryId: IDS.library, sessionId: `global-byte-${scopeIndex}`, sessionEpoch: "epoch-1", transport: "browser-session" };
      for (let item = 0; item < 15; item += 1) await storePendingResolution(journal, scope, index++, large);
    }
    const tailScope: RecipeJournalScope = { actorId: IDS.userA, libraryId: IDS.library, sessionId: "global-byte-tail", sessionEpoch: "epoch-1", transport: "browser-session" };
    for (let item = 0; item < 3; item += 1) await storePendingResolution(journal, tailScope, index++, large);
    await expect(storePendingResolution(journal, tailScope, index, large)).rejects.toMatchObject({ name: "QuotaExceededError" });
    journal.dispose();
  }, 20_000);
});

const PHOTO_MIB = 1024 ** 2;

function defaultActor(overrides: Partial<VerifiedPhotoActor> = {}): VerifiedPhotoActor {
  return { userId: IDS.userA, sessionId: "parent-1", sessionEpoch: "epoch-1", transport: "browser-session", expiresAt: "2031-01-01T00:00:00.000Z", ...overrides };
}

function defaultResponse<K extends PhotoOperation>(operation: K): PhotoOperationMap[K]["response"] {
  if (operation === "content.get") throw new Error("not used");
  const values = responses as unknown as Record<Exclude<PhotoOperation, "content.get">, unknown>;
  return values[operation as Exclude<PhotoOperation, "content.get">] as PhotoOperationMap[K]["response"];
}

function photoAtRevision(revision: number): PhotoOperationMap["photos.get"]["response"] {
  return {
    ...structuredClone(responses["photos.get"]),
    recipe: { ...structuredClone(responses["photos.get"].recipe), revision },
  };
}

function localCandidate(value: typeof responses["recipe-conflicts.get"]["conflictingRecipe"]): LocalRecipeCandidate {
  return {
    settings: structuredClone(value.settings),
    baseVersion: value.baseVersion,
    maskSurfaceIds: structuredClone(value.maskSurfaceIds),
  };
}

function resolutionReceipt(
  decision: "adopt" | "keep-current",
  expectedRevision: number,
  currentRecipe: PhotoOperationMap["photos.get"]["response"]["recipe"],
): PhotoOperationMap["recipe-conflicts.resolve"]["response"] {
  const source = structuredClone(responses["recipe-conflicts.get"]);
  const resultingRevision = decision === "adopt" ? expectedRevision + 1 : expectedRevision;
  const recipe = decision === "adopt" ? {
    ...structuredClone(source.currentRecipe),
    revision: resultingRevision,
    settings: structuredClone(source.conflictingRecipe.settings),
    settingsSha256: source.conflictingRecipe.settingsSha256,
    baseVersion: source.conflictingRecipe.baseVersion,
    maskSurfaceIds: structuredClone(source.conflictingRecipe.maskSurfaceIds),
  } : { ...structuredClone(currentRecipe), revision: resultingRevision };
  return {
    replayed: false,
    value: {
      conflict: {
        ...source,
        resolution: decision,
        resolvedAt: responses["recipe-conflicts.resolve"].value.conflict.resolvedAt,
        resultingRevision,
      },
      recipe,
    },
  };
}

function maximumCandidate(): LocalRecipeCandidate {
  const base = { ...candidate().settings, budgetPadding: "" };
  const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  return candidate({ settings: { ...base, budgetPadding: "x".repeat(PHOTO_LIMITS.maxRecipeBytes - baseBytes) } });
}

async function storePendingResolution(
  journal: IndexedDbRecipeSyncJournal,
  scope: RecipeJournalScope,
  index: number,
  value: LocalRecipeCandidate,
): Promise<void> {
  const binding: RecipeWriterBinding = {
    ...scope,
    token: `budget-token-${index}`,
    writerId: `budget-writer-${index}`,
    photoId: `budget-photo-${index}`,
    sourceSha256: "a".repeat(64),
    initialRevision: 0,
  };
  const stage = { generation: 0, candidate: value };
  await journal.stage(binding, stage);
  const attempt = await journal.createAttempt(binding, stage, `put-attempt-${index}`, `put-key-${index}`);
  await journal.conflictAttempt(binding, attempt.attemptId, 0, `conflict-${index}`, null);
  await journal.conflictAttempt(binding, attempt.attemptId, 0, `conflict-${index}`, "b".repeat(64));
  const proof: JournalResolutionProof = {
    decision: "adopt",
    conflictSnapshotSha256: "b".repeat(64),
    originGeneration: 0,
    expectedResultingRevision: 2,
    selectedCandidate: {
      settings: value.settings,
      baseVersion: value.baseVersion,
      maskSurfaceIds: value.maskSurfaceIds,
      settingsSha256: "c".repeat(64),
    },
  };
  await journal.createResolution(binding, {
    intentId: `choice-${index}`,
    conflictId: `conflict-${index}`,
    decision: "adopt",
    expectedRevision: 1,
  }, proof, `resolve-attempt-${index}`, `resolve-key-${index}`);
}

function recipeReceipt(revision: number, settings = responses["recipes.put"].value.recipe.settings): PhotoOperationMap["recipes.put"]["response"] {
  const value = structuredClone(responses["recipes.put"]);
  return { ...value, value: { ...value.value, recipe: { ...value.value.recipe, revision, settings } } };
}
