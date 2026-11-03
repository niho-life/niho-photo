import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { PHOTO_LIMITS, type Json, type RecipeCandidate, type StartUploadRequest, type Upload } from "@niho/photo-personal-cloud-contract";
import { IDS, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import { describe, expect, it, vi } from "vitest";

import { createBrowserPersonalPhotoTransferController } from "../src/browser";
import { PersonalPhotoCloudError } from "../src/index";
import { IndexedDbTransferJournal, makeEntryId, type JournalScope, type TransferJournalEntry } from "../src/browser/journal";
import { FakeClient, FakeIdentity } from "./support";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const EXPIRES = "2026-11-03T00:30:00.000Z";
const TICKET_EXPIRES = "2026-11-03T00:10:00.000Z";
const UPLOAD_ORIGIN = "https://upload.example.test";

function locks(): LockManager {
  return { request: async (...parameters: unknown[]) => await (parameters.at(-1) as (lock: Lock) => Promise<unknown>)({ name: "synthetic", mode: "exclusive" }) } as unknown as LockManager;
}

function uuids() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function makeController(options: {
  client?: FakeClient; identity?: FakeIdentity; factory?: IDBFactory; name?: string; provider?: typeof fetch; now?: () => number; locks?: LockManager;
} = {}) {
  const client = options.client ?? new FakeClient();
  client.libraryResponse ??= responses["library.get"];
  const identity = options.identity ?? new FakeIdentity();
  const controller = createBrowserPersonalPhotoTransferController({
    client, identity, indexedDB: options.factory ?? new IDBFactory(), locks: options.locks ?? locks(),
    databaseName: options.name ?? `transfer-${Math.random()}`,
    now: options.now ?? (() => NOW), randomUUID: uuids(), trustedUploadOrigin: UPLOAD_ORIGIN,
    fetch: options.provider ?? (async () => { throw new Error("provider should not run"); }),
  });
  return { controller, client, identity };
}

function file(bytes = new Uint8Array([1, 2, 3]), name = "photo.jpg", type = "image/jpeg"): File {
  return new File([bytes], name, { type });
}

function photoFor(request: StartUploadRequest) {
  return {
    ...responses["photos.get"],
    fileName: request.target.kind === "original" ? request.target.fileName : "photo.jpg",
    format: request.target.kind === "original" ? request.target.format : "jpeg" as const,
    original: { ...responses["photos.get"].original, sha256: request.sha256, sizeBytes: request.sizeBytes },
  };
}

function reserved(request: StartUploadRequest, uploadedBytes = 0): Upload {
  return {
    id: "synthetic-upload", target: request.target, sizeBytes: request.sizeBytes, sha256: request.sha256,
    expiresAt: EXPIRES, state: "reserved", uploadedBytes,
  };
}

function ticket(offset = 0) {
  return { url: `${UPLOAD_ORIGIN}/session`, method: "PUT" as const, headers: { "Content-Type": "image/jpeg" }, expiresAt: TICKET_EXPIRES, resumeOffsetBytes: offset };
}

function candidate(overrides: Partial<RecipeCandidate> = {}): RecipeCandidate {
  const recipe = responses["photos.get"].recipe;
  return { settings: recipe.settings, baseVersion: recipe.baseVersion, settingsSha256: recipe.settingsSha256, maskSurfaceIds: recipe.maskSurfaceIds, ...overrides };
}

describe("IndexedDB transfer journal", () => {
  it("separates a near-1MiB settings leaf from its larger candidate envelope", async () => {
    const factory = new IDBFactory();
    const journal = new IndexedDbTransferJournal(factory, "journal-recipe-envelope");
    const scope: JournalScope = { actorId: "a", libraryId: "l", sessionId: "s", sessionEpoch: "e" };
    const settings = { ...responses["photos.get"].recipe.settings, retained: "" };
    const retained = "x".repeat(PHOTO_LIMITS.maxRecipeBytes - new TextEncoder().encode(JSON.stringify(settings)).byteLength - 32);
    const full = candidate({ settings: { ...settings, retained } });
    expect(new TextEncoder().encode(JSON.stringify(full)).byteLength).toBeGreaterThan(PHOTO_LIMITS.maxRecipeBytes);
    await expect(journal.add({ ...journalEntry(scope), candidate: full })).resolves.toBeUndefined();
    await expect(journal.add({
      ...journalEntry(scope),
      id: makeEntryId(scope, "duplicate-mask"),
      intentId: "duplicate-mask",
      candidate: candidate({ maskSurfaceIds: ["d".repeat(64), "d".repeat(64)] }),
    })).rejects.toBeTruthy();
    journal.dispose();
  });

  it.each([31, 32, 33])("keeps depth-%i settings valid through the transfer candidate wrapper", async (depth) => {
    const factory = new IDBFactory();
    const journal = new IndexedDbTransferJournal(factory, `journal-depth-${depth}`);
    const scope: JournalScope = { actorId: "a", libraryId: "l", sessionId: "s", sessionEpoch: "e" };
    let nested: Json = null;
    for (let index = 1; index < depth; index += 1) nested = { next: nested };
    const entry = {
      ...journalEntry(scope),
      candidate: candidate({ settings: { ...responses["photos.get"].recipe.settings, future: nested } }),
    };
    if (depth <= 32) await expect(journal.add(entry)).resolves.toBeUndefined();
    else await expect(journal.add(entry)).rejects.toBeTruthy();
    journal.dispose();
  });

  it("commits, CASes, reopens, and never persists secret-shaped fields", async () => {
    const factory = new IDBFactory();
    const scope: JournalScope = { actorId: "actor", libraryId: "library", sessionId: "session", sessionEpoch: "epoch" };
    const entry = journalEntry(scope);
    const first = new IndexedDbTransferJournal(factory, "journal-reopen");
    await first.add(entry);
    await expect(first.add(entry)).rejects.toBeTruthy();
    const next = { ...entry, revision: 1, phase: "uploading" as const };
    await first.compareAndSet(entry, next);
    await expect(first.compareAndSet(entry, { ...next, revision: 1 })).rejects.toBeTruthy();
    first.dispose();
    const second = new IndexedDbTransferJournal(factory, "journal-reopen");
    const reopened = await second.get(scope, entry.intentId);
    expect(reopened).toMatchObject({ revision: 1, phase: "uploading" });
    expect(JSON.stringify(reopened)).not.toMatch(/credential|ticket|https:|originalFile|headers|provider/i);
    second.dispose();
  });

  it("isolates list/read by actor, library, session, and epoch", async () => {
    const factory = new IDBFactory();
    const journal = new IndexedDbTransferJournal(factory, "journal-scope");
    const scope: JournalScope = { actorId: "a", libraryId: "l", sessionId: "s", sessionEpoch: "e" };
    await journal.add(journalEntry(scope));
    expect((await journal.list(scope)).entries).toHaveLength(1);
    expect((await journal.list({ ...scope, sessionEpoch: "other" })).entries).toHaveLength(0);
    journal.dispose();
  });

  it("pages full entries by the scope-intent cursor without skipping a byte-overflow candidate", async () => {
    const factory = new IDBFactory();
    const journal = new IndexedDbTransferJournal(factory, "journal-pages");
    const scope: JournalScope = { actorId: "a", libraryId: "l", sessionId: "s", sessionEpoch: "e" };
    const padding = "x".repeat(700_000);
    for (let index = 0; index < 5; index += 1) {
      const intentId = `intent-${index}`;
      const base = journalEntry(scope);
      await journal.add({
        ...base,
        id: makeEntryId(scope, intentId), intentId, phase: "pending-recipe", photoId: `photo-${index}`,
        candidate: candidate({ settings: { ...responses["photos.get"].recipe.settings, padding } }),
        cloudRecipe: { ...responses["photos.get"].recipe, settings: { ...responses["photos.get"].recipe.settings, padding } },
      });
    }
    await journal.add({ ...journalEntry({ ...scope, actorId: "other" }), actorId: "other" });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await journal.list(scope, { ...(cursor === undefined ? {} : { cursor }), limit: 16 });
      expect(page.entries.reduce((total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength, 0)).toBeLessThanOrEqual(4 * 1024 ** 2);
      seen.push(...page.entries.map((entry) => entry.intentId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(["intent-0", "intent-1", "intent-2", "intent-3", "intent-4"]);
    expect((await journal.list(scope, { cursor: "zzzzzz" })).entries).toEqual([]);
    await expect(journal.list(scope, { cursor: "x".repeat(513) })).rejects.toBeTruthy();
    journal.dispose();
  });
});

describe("browser original copy controller", () => {
  it("fails closed when Web Locks are unavailable", () => {
    expect(() => createBrowserPersonalPhotoTransferController({
      client: new FakeClient(), identity: new FakeIdentity(), indexedDB: new IDBFactory(), locks: null,
    })).toThrow();
  });

  it("does not mutate the network until the durable entry exists and reuses the start key after an unknown reply", async () => {
    const factory = new IDBFactory();
    const name = "unknown-start";
    const first = makeController({ factory, name });
    first.client.dispatch = async () => { throw new Error("response lost"); };
    const initial = await first.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null });
    expect(initial.phase).toBe("start-pending");
    const firstKey = first.client.calls.find((call) => call.operation === "uploads.start")?.idempotencyKey;
    first.controller.dispose();

    const second = makeController({ factory, name, client: first.client, identity: first.identity });
    second.client.dispatch = async (operation, request) => {
      if (operation !== "uploads.start") throw new Error("unexpected");
      return { value: { kind: "existing", photo: photoFor(request as StartUploadRequest) }, replayed: true };
    };
    const resumed = await second.controller.resume({ intentId: "intent", file: file() });
    expect(resumed.phase).toBe("done");
    expect(second.client.calls.at(-1)?.idempotencyKey).toBe(firstKey);
    second.controller.dispose();
  });

  it("requires a reselected File and rejects a full-hash mismatch before network", async () => {
    const harness = makeController();
    harness.client.dispatch = async () => { throw new Error("lost"); };
    await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null });
    const count = harness.client.calls.length;
    await expect(harness.controller.resume({ intentId: "intent" })).resolves.toMatchObject({ phase: "needs-file" });
    await expect(harness.controller.resume({ intentId: "intent", file: file(new Uint8Array([9, 9, 9])) })).rejects.toBeTruthy();
    expect(harness.client.calls).toHaveLength(count);
    harness.controller.dispose();
  });

  it.each([
    ["jpeg", "photo.jpg", "image/jpeg"],
    ["raw", "photo.dng", "application/octet-stream"],
  ] as const)("canonicalizes an empty browser MIME for %s and replays the persisted type", async (format, name, expectedType) => {
    const harness = makeController();
    let first = true;
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        expect((request as StartUploadRequest).contentType).toBe(expectedType);
        if (first) { first = false; throw new Error("lost"); }
        return { value: { kind: "existing", photo: photoFor(request as StartUploadRequest) }, replayed: true };
      }
      throw new Error(`unexpected ${operation}`);
    };
    const source = file(new Uint8Array([1, 2, 3]), name, "");
    expect((await harness.controller.start({ intentId: "intent", file: source, format, fullRecipeCandidate: null })).phase).toBe("start-pending");
    expect((await harness.controller.resume({ intentId: "intent", file: source })).phase).toBe("done");
    harness.controller.dispose();
  });

  it("rejects a mismatched non-empty MIME, unsupported extension, and changed reselected source before mutation", async () => {
    const harness = makeController();
    await expect(harness.controller.start({ intentId: "bad-mime", file: file(undefined, "photo.jpg", "text/plain"), format: "jpeg", fullRecipeCandidate: null })).rejects.toBeTruthy();
    await expect(harness.controller.start({ intentId: "bad-extension", file: file(undefined, "photo.png"), format: "jpeg", fullRecipeCandidate: null })).rejects.toBeTruthy();
    harness.client.dispatch = async () => { throw new Error("lost"); };
    await harness.controller.start({ intentId: "changed", file: file(undefined, "photo.jpg", ""), format: "jpeg", fullRecipeCandidate: null });
    const mutations = harness.client.calls.filter((call) => call.operation === "uploads.start").length;
    await expect(harness.controller.resume({ intentId: "changed", file: file(new Uint8Array([9, 9, 9]), "other.jpeg", "") })).rejects.toBeTruthy();
    expect(harness.client.calls.filter((call) => call.operation === "uploads.start")).toHaveLength(mutations);
    await expect(harness.controller.start({ intentId: "runtime-format", file: file(), format: "gif" as never, fullRecipeCandidate: null })).rejects.toBeTruthy();
    harness.controller.dispose();
  });

  it("keeps an existing cloud recipe when local candidate is null", async () => {
    const harness = makeController();
    harness.client.dispatch = async (_operation, request) => ({ value: { kind: "existing", photo: photoFor(request as StartUploadRequest) }, replayed: false });
    const result = await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null });
    expect(result).toMatchObject({ phase: "done", hasPendingRecipe: false });
    harness.controller.dispose();
  });

  it("preserves complete candidate and cloud branches as pending-recipe, including masks", async () => {
    const harness = makeController();
    harness.client.dispatch = async (_operation, request) => ({ value: { kind: "existing", photo: photoFor(request as StartUploadRequest) }, replayed: false });
    const local = candidate({ settings: { ...responses["photos.get"].recipe.settings, future: { keep: [1, "opaque"] } }, settingsSha256: "f".repeat(64), maskSurfaceIds: ["e".repeat(64)] });
    const result = await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: local });
    expect(result.phase).toBe("pending-recipe");
    const pending = await harness.controller.readPendingRecipe("intent");
    expect(pending?.candidate).toEqual(local);
    expect(pending?.cloudRecipe).toEqual(responses["photos.get"].recipe);
    harness.controller.dispose();
  });

  it.each(["unavailable", "wrong-sha", "wrong-kind", "oversize"] as const)("does not mark a matching referenced-mask recipe done when mask metadata is %s", async (mode) => {
    const harness = makeController();
    const surfaceId = "e".repeat(64);
    const local = candidate({ maskSurfaceIds: [surfaceId] });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        const photo = photoFor(request as StartUploadRequest);
        return { value: { kind: "existing", photo: { ...photo, recipe: { ...photo.recipe, maskSurfaceIds: [surfaceId] } } }, replayed: false };
      }
      if (operation === "masks.get") {
        if (mode === "unavailable") throw new PersonalPhotoCloudError("unsupported");
        const valid = { ...responses["masks.get"], sha256: surfaceId };
        if (mode === "wrong-sha") return { ...valid, sha256: "f".repeat(64) };
        if (mode === "wrong-kind") return { ...valid, kind: "preview" };
        return { ...valid, sizeBytes: PHOTO_LIMITS.maxMaskBytes + 1 };
      }
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: local })).phase).toBe("pending-recipe");
    harness.controller.dispose();
  });

  it("marks a referenced-mask candidate done only after fresh photo-bound mask metadata matches", async () => {
    const harness = makeController();
    const surfaceId = "e".repeat(64);
    const local = candidate({ maskSurfaceIds: [surfaceId] });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        const photo = photoFor(request as StartUploadRequest);
        return { value: { kind: "existing", photo: { ...photo, recipe: { ...photo.recipe, maskSurfaceIds: [surfaceId] } } }, replayed: false };
      }
      if (operation === "masks.get") {
        expect(request).toEqual({ photoId: responses["photos.get"].id, surfaceId });
        return { ...responses["masks.get"], sha256: surfaceId };
      }
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: local })).phase).toBe("done");
    harness.controller.dispose();
  });

  it("aborts rather than rounding a scope change during mask verification to pending-recipe", async () => {
    const identity = new FakeIdentity();
    const harness = makeController({ identity });
    const surfaceId = "e".repeat(64);
    const local = candidate({ maskSurfaceIds: [surfaceId] });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        const photo = photoFor(request as StartUploadRequest);
        return { value: { kind: "existing", photo: { ...photo, recipe: { ...photo.recipe, maskSurfaceIds: [surfaceId] } } }, replayed: false };
      }
      if (operation === "masks.get") {
        identity.set({ ...identity.getSnapshot()!, sessionEpoch: "epoch-2" });
        throw new PersonalPhotoCloudError("unavailable");
      }
      throw new Error(`unexpected ${operation}`);
    };
    await expect(harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: local })).rejects.toBeTruthy();
    harness.controller.dispose();
  });

  it("returns verifying without polling and resumes it without a File", async () => {
    const harness = makeController();
    let startRequest: StartUploadRequest | null = null;
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        startRequest = request as StartUploadRequest;
        return { value: { kind: "upload", upload: { ...reserved(startRequest), state: "verifying", jobId: "job" }, ticket: null }, replayed: false };
      }
      if (operation === "uploads.get" && startRequest !== null) return { ...reserved(startRequest), state: "stored", result: { kind: "original", photo: photoFor(startRequest) } };
      throw new Error("unexpected");
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).phase).toBe("verifying");
    expect((await harness.controller.resume({ intentId: "intent" })).phase).toBe("done");
    expect(harness.client.calls.filter((call) => call.operation === "uploads.get")).toHaveLength(1);
    harness.controller.dispose();
  });

  it.each([
    ["rejected", "rejected"],
    ["expired", "expired"],
  ] as const)("makes %s terminal", async (state, expected) => {
    const harness = makeController();
    harness.client.dispatch = async (_operation, request) => ({ value: { kind: "upload", upload: state === "rejected" ? { ...reserved(request as StartUploadRequest), state, code: "content_rejected" } : { ...reserved(request as StartUploadRequest), state }, ticket: null }, replayed: false });
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).phase).toBe(expected);
    harness.controller.dispose();
  });

  it("treats an opaque 308 only as a signal to query backend offset, then completes at full size", async () => {
    let requestValue: StartUploadRequest | null = null;
    const harness = makeController({ provider: async () => ({ status: 0, type: "opaqueredirect", headers: new Headers() }) as Response });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") { requestValue = request as StartUploadRequest; return { value: { kind: "upload", upload: reserved(requestValue), ticket: ticket() }, replayed: false }; }
      if (operation === "uploads.get" && requestValue !== null) return reserved(requestValue, requestValue.sizeBytes);
      if (operation === "uploads.complete" && requestValue !== null) return { value: { ...reserved(requestValue), state: "stored", result: { kind: "original", photo: photoFor(requestValue) } }, replayed: false };
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).phase).toBe("done");
    expect(harness.client.calls.some((call) => call.operation === "uploads.renew")).toBe(false);
    harness.controller.dispose();
  });

  it("bounds opaque/no-progress retries and returns pending", async () => {
    let requestValue: StartUploadRequest | null = null;
    let providerCalls = 0;
    const harness = makeController({ provider: async () => { providerCalls += 1; return { status: 0, type: "opaqueredirect", headers: new Headers() } as Response; } });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") { requestValue = request as StartUploadRequest; return { value: { kind: "upload", upload: reserved(requestValue), ticket: ticket() }, replayed: false }; }
      if (operation === "uploads.get" && requestValue !== null) return reserved(requestValue, 0);
      if (operation === "uploads.renew" && requestValue !== null) return { upload: reserved(requestValue, 0), ticket: ticket() };
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).phase).toBe("uploading");
    expect(providerCalls).toBe(3);
    harness.controller.dispose();
  });

  it("keeps complete pending after response loss and reuses its key", async () => {
    let requestValue: StartUploadRequest | null = null;
    let completes = 0;
    const harness = makeController({ provider: async () => ({ status: 0, type: "opaqueredirect", headers: new Headers() }) as Response });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") { requestValue = request as StartUploadRequest; return { value: { kind: "upload", upload: reserved(requestValue), ticket: ticket() }, replayed: false }; }
      if (operation === "uploads.get" && requestValue !== null) return reserved(requestValue, requestValue.sizeBytes);
      if (operation === "uploads.complete" && requestValue !== null) { completes += 1; if (completes === 1) throw new Error("lost"); return { value: { ...reserved(requestValue), state: "stored", result: { kind: "original", photo: photoFor(requestValue) } }, replayed: true }; }
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).phase).toBe("complete-pending");
    const firstKey = harness.client.calls.find((call) => call.operation === "uploads.complete")?.idempotencyKey;
    expect((await harness.controller.resume({ intentId: "intent" })).phase).toBe("done");
    expect(harness.client.calls.filter((call) => call.operation === "uploads.complete").map((call) => call.idempotencyKey)).toEqual([firstKey, firstKey]);
    harness.controller.dispose();
  });

  it.each([
    [60, "done"],
    [89, "done"],
    [90, "expired"],
  ] as const)("uses expiresAt plus the full completion grace at minute %i", async (minute, expectedPhase) => {
    const factory = new IDBFactory();
    const name = `complete-deadline-${minute}`;
    const scope: JournalScope = { actorId: IDS.userA, libraryId: responses["library.get"].id, sessionId: "parent-1", sessionEpoch: "epoch-1" };
    const seeded = { ...journalEntry(scope), phase: "complete-pending" as const, uploadId: "synthetic-upload", expiresAt: EXPIRES, uploadedBytes: 3 };
    const journal = new IndexedDbTransferJournal(factory, name);
    await journal.add(seeded);
    journal.dispose();
    const harness = makeController({ factory, name, now: () => NOW + minute * 60_000 });
    const request = startRequestFor(seeded);
    harness.client.dispatch = async (operation) => {
      if (operation === "uploads.get") return reserved(request, 3);
      if (operation === "uploads.complete") return { value: { ...reserved(request, 3), state: "stored", result: { kind: "original", photo: photoFor(request) } }, replayed: minute > 60 };
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.resume({ intentId: "intent" })).phase).toBe(expectedPhase);
    expect(harness.client.calls.filter((call) => call.operation === "uploads.complete")).toHaveLength(minute < 90 ? 1 : 0);
    harness.controller.dispose();
  });

  it("completes a full-size reserved upload without using its expired provider ticket", async () => {
    const harness = makeController();
    let startRequest: StartUploadRequest | null = null;
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") { startRequest = request as StartUploadRequest; return { value: { kind: "upload", upload: reserved(startRequest, startRequest.sizeBytes), ticket: { ...ticket(startRequest.sizeBytes), expiresAt: "2026-11-02T00:00:00.000Z" } }, replayed: false }; }
      if (operation === "uploads.complete" && startRequest !== null) return { value: { ...reserved(startRequest, startRequest.sizeBytes), state: "stored", result: { kind: "original", photo: photoFor(startRequest) } }, replayed: false };
      throw new Error(`unexpected ${operation}`);
    };
    expect((await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).phase).toBe("done");
    harness.controller.dispose();
  });

  it("settles a provider PUT that ignores abort and reconciles the real backend offset", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let requestValue: StartUploadRequest | null = null;
      let providerAborted = false;
      let providerStarted!: () => void;
      const started = new Promise<void>((resolve) => { providerStarted = resolve; });
      const harness = makeController({ provider: async (_input, init) => await new Promise<Response>(() => { providerStarted(); init?.signal?.addEventListener("abort", () => { providerAborted = true; }, { once: true }); }) });
      harness.client.dispatch = async (operation, request) => {
        if (operation === "uploads.start") { requestValue = request as StartUploadRequest; return { value: { kind: "upload", upload: reserved(requestValue), ticket: ticket() }, replayed: false }; }
        if (operation === "uploads.get" && requestValue !== null) return reserved(requestValue, requestValue.sizeBytes);
        if (operation === "uploads.complete" && requestValue !== null) return { value: { ...reserved(requestValue, requestValue.sizeBytes), state: "stored", result: { kind: "original", photo: photoFor(requestValue) } }, replayed: false };
        throw new Error(`unexpected ${operation}`);
      };
      const pending = harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null });
      const settled = pending.then((value) => value);
      await started;
      await vi.advanceTimersByTimeAsync(120_001);
      await expect(settled).resolves.toMatchObject({ phase: "done" });
      expect(providerAborted).toBe(true);
      expect(harness.client.calls.some((call) => call.operation === "uploads.get")).toBe(true);
      harness.controller.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("releases hashing and Web Lock waits when the captured scope is invalidated", async () => {
    class HangingFile extends File {
      override slice(): Blob { return { arrayBuffer: async () => await new Promise<ArrayBuffer>(() => undefined) } as Blob; }
    }
    const hashingIdentity = new FakeIdentity();
    const hashing = makeController({ identity: hashingIdentity });
    const hashPending = hashing.controller.start({ intentId: "hash", file: new HangingFile([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" }), format: "jpeg", fullRecipeCandidate: null });
    await Promise.resolve();
    hashingIdentity.set({ ...hashingIdentity.getSnapshot()!, sessionEpoch: "epoch-2" });
    await expect(hashPending).rejects.toBeTruthy();
    hashing.controller.dispose();

    const lockIdentity = new FakeIdentity();
    const neverLocks = { request: async () => await new Promise<never>(() => undefined) } as unknown as LockManager;
    const waiting = makeController({ identity: lockIdentity, locks: neverLocks });
    const lockPending = waiting.controller.start({ intentId: "lock", file: file(), format: "jpeg", fullRecipeCandidate: null });
    await Promise.resolve();
    lockIdentity.set({ ...lockIdentity.getSnapshot()!, sessionEpoch: "epoch-2" });
    await expect(lockPending).rejects.toBeTruthy();
    waiting.controller.dispose();

    const idbIdentity = new FakeIdentity();
    let opened!: () => void;
    const openCalled = new Promise<void>((resolve) => { opened = resolve; });
    const hangingFactory = { open: () => { opened(); return {} as IDBOpenDBRequest; } } as unknown as IDBFactory;
    const idb = makeController({ identity: idbIdentity, factory: hangingFactory });
    const idbPending = idb.controller.start({ intentId: "idb", file: file(), format: "jpeg", fullRecipeCandidate: null });
    await openCalled;
    idbIdentity.set({ ...idbIdentity.getSnapshot()!, sessionEpoch: "epoch-2" });
    await expect(idbPending).rejects.toBeTruthy();
    idb.controller.dispose();
  });

  it("closes an offset regression and never accepts a renewed deadline", async () => {
    let startRequest: StartUploadRequest | null = null;
    const harness = makeController({ provider: async () => new Response(null, { status: 308, headers: { Range: "bytes=0-0" } }) });
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") { startRequest = request as StartUploadRequest; return { value: { kind: "upload", upload: reserved(startRequest), ticket: ticket() }, replayed: false }; }
      if (operation === "uploads.renew" && startRequest !== null) return { upload: { ...reserved(startRequest), expiresAt: "2026-11-03T00:40:00.000Z", uploadedBytes: 1 }, ticket: ticket(1) };
      throw new Error(`unexpected ${operation}`);
    };
    expect(await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).toMatchObject({ phase: "failed", failure: "invalid-response" });
    harness.controller.dispose();
  });

  it("writes cancel intent first, reconciles unknown start, and reuses the cancel key after response loss", async () => {
    const harness = makeController();
    let startRequest: StartUploadRequest | null = null;
    let starts = 0;
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") { starts += 1; startRequest = request as StartUploadRequest; if (starts === 1) throw new Error("lost"); return { value: { kind: "upload", upload: reserved(startRequest), ticket: null }, replayed: true }; }
      if (operation === "uploads.cancel") throw new Error("cancel response lost");
      throw new Error("unexpected");
    };
    await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null });
    expect((await harness.controller.cancel("intent")).phase).toBe("cancel-pending");
    const firstCancelKey = harness.client.calls.find((call) => call.operation === "uploads.cancel")?.idempotencyKey;
    await harness.controller.cancel("intent");
    expect(harness.client.calls.filter((call) => call.operation === "uploads.cancel").map((call) => call.idempotencyKey)).toEqual([firstCancelKey, firstCancelKey]);
    harness.controller.dispose();
  });


  it.each(["existing-start", "stored-start", "stored-cancel", "stored-conflict", "stored-conflict-lost", "pending"] as const)("preserves the complete candidate across cancellation via %s and reopen", async (mode) => {
    const factory = new IDBFactory();
    const name = `cancel-candidate-${mode}`;
    const harness = makeController({ factory, name });
    const local = candidate({ settings: { ...responses["photos.get"].recipe.settings, preservedUnknown: { local: true } } });
    let startRequest: StartUploadRequest | null = null;
    let starts = 0;
    let reads = 0;
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        startRequest = request as StartUploadRequest;
        starts += 1;
        if ((mode === "existing-start" || mode === "stored-start") && starts === 1) throw new Error("start response lost");
        const photo = photoFor(startRequest);
        if (mode === "existing-start" || mode === "pending") return { value: { kind: "existing", photo }, replayed: starts > 1 };
        const upload = mode === "stored-start"
          ? { ...reserved(startRequest, 3), state: "stored", result: { kind: "original", photo } }
          : { ...reserved(startRequest, 3), state: "verifying", jobId: "job" };
        return { value: { kind: "upload", upload, ticket: null }, replayed: starts > 1 };
      }
      if (operation === "uploads.cancel" && (mode === "stored-conflict" || mode === "stored-conflict-lost")) throw { error: { code: "upload_state_conflict", requestId: "synthetic", retryable: false } };
      if ((operation === "uploads.cancel" || operation === "uploads.get") && startRequest) {
        if (operation === "uploads.get" && mode === "stored-conflict-lost" && ++reads === 1) throw new Error("read unavailable");
        const upload = { ...reserved(startRequest, 3), state: "stored", result: { kind: "original", photo: photoFor(startRequest) } };
        return operation === "uploads.cancel" ? { value: upload, replayed: false } : upload;
      }
      throw new Error(`unexpected ${operation}`);
    };
    try {
      await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: local });
      const cancelled = await harness.controller.cancel("intent");
      if (mode === "stored-conflict-lost") {
        expect(cancelled).toMatchObject({ phase: "cancel-pending", hasPendingRecipe: false });
        harness.controller.dispose();
        const recovery = makeController({ factory, name, client: harness.client });
        try { expect(await recovery.controller.resume({ intentId: "intent" })).toMatchObject({ phase: "pending-recipe", hasPendingRecipe: true, failure: "stored" }); }
        finally { recovery.controller.dispose(); }
      } else expect(cancelled).toMatchObject({ phase: "pending-recipe", hasPendingRecipe: true, failure: "stored" });
      const expected = { candidate: local, cloudRecipe: responses["photos.get"].recipe };
      if (mode !== "stored-conflict-lost") expect(await harness.controller.readPendingRecipe("intent")).toMatchObject(expected);
      expect(harness.client.calls.filter((call) => call.operation === "photos.delete")).toHaveLength(0);
      harness.controller.dispose();
      const reopened = makeController({ factory, name, client: harness.client });
      try {
        expect((await reopened.controller.list()).items).toMatchObject([{ phase: "pending-recipe", hasPendingRecipe: true }]);
        expect(await reopened.controller.readPendingRecipe("intent")).toMatchObject(expected);
      } finally { reopened.controller.dispose(); }
    } finally { harness.controller.dispose(); }
  });

  it("does not delete an original when cancel reports stored conflict", async () => {
    const harness = makeController();
    harness.client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") return { value: { kind: "upload", upload: { ...reserved(request as StartUploadRequest), state: "verifying", jobId: "job" }, ticket: null }, replayed: false };
      if (operation === "uploads.cancel") throw { error: { code: "upload_state_conflict", requestId: "x", retryable: false } };
      throw new Error("unexpected");
    };
    await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null });
    expect(await harness.controller.cancel("intent")).toMatchObject({ phase: "failed", failure: "stored" });
    harness.controller.dispose();
  });

  it("reports server capability false without creating a journal entry", async () => {
    const harness = makeController();
    harness.client.libraryResponse = { ...responses["library.get"], capabilities: { ...responses["library.get"].capabilities, formats: responses["library.get"].capabilities.formats.map((item) => item.format === "jpeg" ? { ...item, ingest: false } : item) } };
    await expect(harness.controller.checkCapability("jpeg")).resolves.toBe(false);
    await expect(harness.controller.list()).resolves.toMatchObject({ items: [], nextCursor: null });
    harness.controller.dispose();
  });

  it("aborts hashing/network on an epoch flip while preserving the scoped journal boundary", async () => {
    const identity = new FakeIdentity();
    const harness = makeController({ identity });
    harness.client.dispatch = async () => { throw new Error("network must not start"); };
    identity.set({ ...identity.getSnapshot()!, sessionEpoch: "epoch-2" });
    await expect(harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null })).rejects.toBeTruthy();
    harness.controller.dispose();
  });

  it("maps known upload 404 and purge 410 without generating a new key", async () => {
    for (const [code, phase] of [["not_found", "failed"], ["photo_deleted", "purged"]] as const) {
      const harness = makeController();
      let requestValue: StartUploadRequest | null = null;
      harness.client.dispatch = async (operation, request) => {
        if (operation === "uploads.start") { requestValue = request as StartUploadRequest; return { value: { kind: "upload", upload: { ...reserved(requestValue), state: "verifying", jobId: "job" }, ticket: null }, replayed: false }; }
        throw { error: { code, requestId: "x", retryable: false } };
      };
      expect((await harness.controller.resume({ intentId: "intent", ...(await harness.controller.start({ intentId: "intent", file: file(), format: "jpeg", fullRecipeCandidate: null }), {}) })).phase).toBe(phase);
      harness.controller.dispose();
    }
  });
});

function journalEntry(scope: JournalScope): TransferJournalEntry {
  return {
    schemaVersion: 1, id: makeEntryId(scope, "intent"), revision: 0, ...scope, intentId: "intent", phase: "start-pending",
    startKey: "00000000-0000-4000-8000-000000000001", completeKey: "00000000-0000-4000-8000-000000000002", cancelKey: "00000000-0000-4000-8000-000000000003",
    fileName: "photo.jpg", format: "jpeg", contentType: "image/jpeg", sizeBytes: 3, sha256: "a".repeat(64), candidate: null, cloudRecipe: null,
    uploadId: null, photoId: null, expiresAt: null, uploadedBytes: 0, failure: null,
  };
}

function startRequestFor(entry: TransferJournalEntry): StartUploadRequest {
  return { target: { kind: "original", fileName: entry.fileName, format: entry.format }, sizeBytes: entry.sizeBytes, sha256: entry.sha256, contentType: entry.contentType };
}


describe("durable recovery and response upload binding", () => {
  async function seed(phase: "complete-pending" | "cancel-pending" | "uploading", uploadId: string | null = "synthetic-upload") {
    const factory = new IDBFactory();
    const name = `recovery-${Math.random()}`;
    const scope: JournalScope = { actorId: IDS.userA, libraryId: responses["library.get"].id, sessionId: "parent-1", sessionEpoch: "epoch-1" };
    const bytes = await file().arrayBuffer();
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    const entry = { ...journalEntry(scope), sha256, phase, uploadId, expiresAt: uploadId === null ? null : EXPIRES, uploadedBytes: phase === "complete-pending" ? 3 : 0 };
    const journal = new IndexedDbTransferJournal(factory, name);
    await journal.add(entry);
    journal.dispose();
    return { factory, name, entry, request: startRequestFor(entry) };
  }

  it.each(["stored", "verifying", "reserved", "unknown"] as const)("reconciles an unknown complete beyond grace when server is %s", async (state) => {
    const seeded = await seed("complete-pending");
    const harness = makeController({ ...seeded, now: () => NOW + 91 * 60_000 });
    harness.client.dispatch = async (operation) => {
      if (operation !== "uploads.get") throw new Error("no new mutation after grace");
      const upload = reserved(seeded.request, 3);
      if (state === "unknown") throw new Error("temporarily unavailable");
      if (state === "stored") return { ...upload, state, result: { kind: "original", photo: photoFor(seeded.request) } };
      if (state === "verifying") return { ...upload, state, jobId: "job" };
      return upload;
    };
    try {
      const resumed = await harness.controller.resume({ intentId: "intent" });
      expect(resumed.phase).toBe(state === "stored" ? "done" : state === "verifying" ? "verifying" : state === "reserved" ? "expired" : "complete-pending");
      if (state === "stored") expect(resumed.photoId).toBe(photoFor(seeded.request).id);
      expect(harness.client.calls.map((call) => call.operation)).toEqual(["uploads.get"]);
    } finally { harness.controller.dispose(); }
  });

  it.each(["synthetic-upload", null])("resumes a persisted cancellation with upload ID %s using its existing keys", async (uploadId) => {
    const seeded = await seed("cancel-pending", uploadId);
    const harness = makeController(seeded);
    harness.client.dispatch = async (operation) => {
      if (operation === "uploads.start") return { value: { kind: "upload", upload: reserved(seeded.request), ticket: null }, replayed: true };
      if (operation === "uploads.cancel") return { value: { ...reserved(seeded.request), state: "cancelled" }, replayed: true };
      throw new Error(`unexpected ${operation}`);
    };
    try {
      expect(await harness.controller.resume({ intentId: "intent" })).toMatchObject({ phase: "cancelled" });
      expect(harness.client.calls.filter((call) => call.operation === "uploads.cancel").map((call) => call.idempotencyKey)).toEqual([seeded.entry.cancelKey]);
      if (uploadId === null) expect(harness.client.calls.find((call) => call.operation === "uploads.start")?.idempotencyKey).toBe(seeded.entry.startKey);
    } finally { harness.controller.dispose(); }
  });

  it.each(["id", "expiresAt"] as const)("rejects a cancel response with changed %s", async (field) => {
    const seeded = await seed("uploading");
    const harness = makeController(seeded);
    harness.client.dispatch = async () => ({ value: { ...reserved(seeded.request), state: "cancelled", [field]: field === "id" ? "different-upload" : "2026-11-03T00:31:00.000Z" }, replayed: false });
    try {
      expect(await harness.controller.cancel("intent")).toMatchObject({ phase: "failed", failure: "invalid-response" });
    } finally { harness.controller.dispose(); }
  });

  it("rejects a renewed ticket for a different upload before provider PUT", async () => {
    const seeded = await seed("uploading");
    let providerCalls = 0;
    const harness = makeController({ ...seeded, provider: async () => { providerCalls += 1; return new Response(null, { status: 200 }); } });
    harness.client.dispatch = async (operation) => {
      if (operation === "uploads.get") return reserved(seeded.request);
      if (operation === "uploads.renew") return { upload: { ...reserved(seeded.request), id: "different-upload" }, ticket: ticket() };
      throw new Error(`unexpected ${operation}`);
    };
    const input = file();
    try {
      expect(await harness.controller.resume({ intentId: "intent", file: input })).toMatchObject({ phase: "failed", failure: "invalid-response" });
      expect(providerCalls).toBe(0);
    } finally { harness.controller.dispose(); }
  });
});
