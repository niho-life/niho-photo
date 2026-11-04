import { sha256 } from "@noble/hashes/sha2.js";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { IndexedDbRecipeSyncJournal } from "../src/browser";
import type {
  JournalPutAttempt,
  JournalStage,
  MaskSurfaceInput,
  MaskSurfaceUploadState,
  RecipeJournalScope,
  RecipeWriterBinding,
} from "../src/types";

const SHA = /^[0-9a-f]{64}$/u;

function digest(bytes: Uint8Array | string): string {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(sha256(input), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scope(overrides: Partial<RecipeJournalScope> = {}): RecipeJournalScope {
  return { actorId: "actor", libraryId: "library", sessionId: "session", sessionEpoch: "epoch", transport: "browser-session", ...overrides };
}

function binding(value = scope()): RecipeWriterBinding {
  return { ...value, token: "token", writerId: "writer", photoId: "photo", sourceSha256: "f".repeat(64), initialRevision: 0 };
}

function stage(maskSurfaceIds: readonly string[] = []): JournalStage {
  return { generation: 0, candidate: { settings: { v: 1, engine: "engine", full: { unknown: [1, true, "kept"] } }, baseVersion: null, maskSurfaceIds } };
}

function uploadState(photoId: string, sha: string, sizeBytes: number, overrides: Partial<MaskSurfaceUploadState> = {}): MaskSurfaceUploadState {
  return {
    target: { kind: "mask", photoId }, sizeBytes, sha256: sha, contentType: "image/png",
    startKey: "start-key", completeKey: "complete-key", cancelKey: "cancel-key",
    uploadId: null, deadline: null, offsetBytes: 0, phase: "start-pending", ...overrides,
  };
}

function surface(bytes: Uint8Array, photoId = "photo", withUpload = true): MaskSurfaceInput {
  const hash = digest(bytes);
  return { id: hash, width: 2, height: 2, sha256: hash, bytes, uploadState: withUpload ? uploadState(photoId, hash, bytes.byteLength) : null };
}

describe("IndexedDB v2 mask journal", () => {
  it("upgrades a v1 writer without changing full JSON, unknown attempt, or previous-scope metadata", async () => {
    const factory = new IDBFactory();
    const name = "journal-v1-upgrade";
    const oldScope = scope({ sessionId: "old-session", sessionEpoch: "old-epoch" });
    const oldBinding = binding(oldScope);
    const latest = stage();
    const requestBody = JSON.stringify({ expectedRevision: 0, settings: latest.candidate.settings, baseVersion: null });
    const attempt: JournalPutAttempt = {
      kind: "put", attemptId: "attempt", idempotencyKey: "put-key", generation: 0,
      candidate: structuredClone(latest.candidate), expectedRevision: 0, parentAckGeneration: -1,
      requestBody, requestBytesSha256: digest(requestBody), conflictId: null,
    };
    await seedV1(factory, name, {
      ...oldBinding, schemaVersion: 1, id: JSON.stringify([...Object.values(oldScope), oldBinding.writerId]), revision: 2,
      nextGeneration: 1, lastAckGeneration: -1, lastAckRevision: 0, latest, attempt, resolution: null,
      conflicts: [], knownResolution: null, terminalReason: null,
    });

    const journal = new IndexedDbRecipeSyncJournal(factory, name);
    const reopened = await journal.reopen(oldScope, oldBinding.token);
    expect(reopened?.latest).toEqual(latest);
    expect(reopened?.attempt).toEqual(attempt);
    const previous = await journal.listPrevious(scope({ sessionId: "new-session", sessionEpoch: "new-epoch" }));
    expect(previous.writers).toMatchObject([{ binding: oldBinding, summary: { token: "token", hasUnknownAttempt: true, hasLatest: true } }]);
    journal.dispose();
  });

  it("copies PNG bytes, survives reconstruction, and isolates the full scope tuple", async () => {
    const factory = new IDBFactory();
    const name = "mask-reopen";
    const current = scope();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const input = surface(bytes);
    const first = new IndexedDbRecipeSyncJournal(factory, name);
    await first.putMaskSurface(current, "photo", input);
    bytes.fill(9);
    first.dispose();

    const second = new IndexedDbRecipeSyncJournal(factory, name);
    expect((await second.getMaskSurface(current, "photo", input.sha256))?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    for (const different of [
      { actorId: "other" }, { libraryId: "other" }, { sessionId: "other" }, { sessionEpoch: "other" }, { transport: "mac-bearer" as const },
    ]) expect(await second.getMaskSurface(scope(different), "photo", input.sha256)).toBeNull();
    second.dispose();
  });

  it("deduplicates one hash, rejects stale upload CAS, and keeps PNG budget across writer stage/discard", async () => {
    const factory = new IDBFactory();
    const journal = new IndexedDbRecipeSyncJournal(factory, "mask-cas-budget");
    const current = scope();
    const input = surface(new Uint8Array([4, 3, 2, 1]));
    await journal.putMaskSurface(current, "photo", input);
    await journal.putMaskSurface(current, "photo", input);
    const stale = uploadState("photo", input.sha256, input.bytes.byteLength, { offsetBytes: 1, phase: "uploading" });
    const next = uploadState("photo", input.sha256, input.bytes.byteLength, { uploadId: "upload", deadline: "2026-11-03T00:30:00.000Z", phase: "uploading" });
    await expect(journal.compareAndSetMaskUploadState(current, "photo", input.sha256, stale, next)).resolves.toBe(false);
    await expect(journal.compareAndSetMaskUploadState(current, "photo", input.sha256, input.uploadState, next)).resolves.toBe(true);
    expect((await journal.getMaskSurface(current, "photo", input.sha256))?.uploadState).toEqual(next);

    const writer = binding(current);
    await journal.stage(writer, stage([input.sha256]));
    await journal.discard(writer);
    expect(await journal.getMaskSurface(current, "photo", input.sha256)).not.toBeNull();
    journal.dispose();
  });

  it("protects pinned and referenced surfaces, then deletes only an explicitly unpinned unreferenced record", async () => {
    const journal = new IndexedDbRecipeSyncJournal(new IDBFactory(), "mask-pin-delete");
    const current = scope();
    const input = surface(new Uint8Array([8, 7, 6]), "photo", false);
    await journal.putMaskSurface(current, "photo", input);
    await expect(journal.deleteMaskSurface(current, "photo", input.sha256)).resolves.toBe(false);
    await journal.setMaskSurfacePinned(current, "photo", input.sha256, false);
    await journal.stage(binding(current), stage([input.sha256]));
    await expect(journal.deleteMaskSurface(current, "photo", input.sha256)).resolves.toBe(false);
    await journal.discard(binding(current));
    await expect(journal.deleteMaskSurface(current, "photo", input.sha256)).resolves.toBe(true);
    expect(await journal.getMaskSurface(current, "photo", input.sha256)).toBeNull();
    journal.dispose();
  });

  it("rejects combined scope overflow and leaves no partial mask or leaked counter after abort", async () => {
    const factory = new IDBFactory();
    const journal = new IndexedDbRecipeSyncJournal(factory, "mask-quota-rollback");
    const current = scope();
    const accepted: MaskSurfaceInput[] = [];
    for (let index = 0; index < 4; index += 1) {
      const bytes = new Uint8Array(7 * 1024 ** 2);
      bytes[0] = index;
      const input = surface(bytes, "photo", false);
      accepted.push(input);
      await journal.putMaskSurface(current, "photo", input);
    }
    const overflowBytes = new Uint8Array(7 * 1024 ** 2);
    overflowBytes[0] = 9;
    const overflow = surface(overflowBytes, "photo", false);
    await expect(journal.putMaskSurface(current, "photo", overflow)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await journal.getMaskSurface(current, "photo", overflow.sha256)).toBeNull();

    const aborted = surface(new Uint8Array([9, 9, 9]), "photo", false);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(journal.putMaskSurface(current, "photo", aborted, controller.signal)).rejects.toBeTruthy();
    expect(await journal.getMaskSurface(current, "photo", aborted.sha256)).toBeNull();
    expect(accepted.every((item) => SHA.test(item.sha256))).toBe(true);
    journal.dispose();
  });

  it("retains an unpinned unknown upload until its scalar state is explicitly settled", async () => {
    const journal = new IndexedDbRecipeSyncJournal(new IDBFactory(), "mask-unknown-retained");
    const current = scope();
    const input = surface(new Uint8Array([1, 7, 3]));
    await journal.putMaskSurface(current, "photo", input);
    await journal.setMaskSurfacePinned(current, "photo", input.sha256, false);
    expect(await journal.deleteMaskSurface(current, "photo", input.sha256)).toBe(false);
    expect(await journal.compareAndSetMaskUploadState(current, "photo", input.sha256, input.uploadState, null)).toBe(true);
    expect(await journal.deleteMaskSurface(current, "photo", input.sha256)).toBe(true);
    journal.dispose();
  });

  it("retains conflict surfaces after a newer stage stops referencing them", async () => {
    const journal = new IndexedDbRecipeSyncJournal(new IDBFactory(), "mask-conflict-retained");
    const current = scope();
    const input = surface(new Uint8Array([1, 8, 3]), "photo", false);
    const writer = binding(current);
    const first = stage([input.sha256]);
    await journal.putMaskSurface(current, "photo", input);
    await journal.setMaskSurfacePinned(current, "photo", input.sha256, false);
    await journal.stage(writer, first);
    await journal.createAttempt(writer, first, "attempt", "put-key");
    await journal.conflictAttempt(writer, "attempt", 0, "conflict", null);
    await journal.conflictAttempt(writer, "attempt", 0, "conflict", "a".repeat(64));
    await journal.stage(writer, { ...stage(), generation: 1 });
    expect(await journal.deleteMaskSurface(current, "photo", input.sha256)).toBe(false);
    await journal.discard(writer);
    expect(await journal.deleteMaskSurface(current, "photo", input.sha256)).toBe(true);
    journal.dispose();
  });
});

async function seedV1(factory: IDBFactory, name: string, writer: Record<string, unknown>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const writers = request.result.createObjectStore("writers", { keyPath: "id" });
      writers.createIndex("scopeToken", ["actorId", "libraryId", "sessionId", "sessionEpoch", "transport", "token"], { unique: true });
      request.result.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["writers", "meta"], "readwrite");
    transaction.objectStore("writers").put(writer);
    transaction.objectStore("meta").put({ key: "global", writers: 1, bytes: JSON.stringify(writer).length });
    transaction.objectStore("meta").put({ key: `scope:${JSON.stringify([writer.actorId, writer.libraryId, writer.sessionId, writer.sessionEpoch, writer.transport])}`, writers: 1, bytes: JSON.stringify(writer).length });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}
