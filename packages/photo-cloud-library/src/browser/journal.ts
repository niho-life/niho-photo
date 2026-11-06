import { sha256 } from "@noble/hashes/sha2.js";
import { PHOTO_LIMITS, type PhotoFormat, type RecipeCandidate, type RecipeDocument } from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "../errors";
import { awaitBounded } from "../await";
import { validateRecipe, validateRecipeCandidate } from "../validation";

const DATABASE_VERSION = 2;
const STORE = "entries";
const FENCES = "scopeFences";
const SCOPE_INDEX = "scope";
const SCOPE_INTENT_INDEX = "scopeIntent";
const SHA256 = /^[0-9a-f]{64}$/u;
const DEFAULT_PAGE_LIMIT = 16;
const MAX_PAGE_LIMIT = 16;
const MAX_PAGE_BYTES = 4 * 1024 ** 2;
const IDB_WAIT_TIMEOUT_MS = 120_000;
const NEVER_ABORTS = new AbortController().signal;
export const PERSONAL_PHOTO_TRANSFER_DATABASE_NAME = "niho-personal-photo-transfers-v1";

export type TransferPhase =
  | "start-pending" | "uploading" | "complete-pending" | "verifying" | "pending-recipe"
  | "done" | "cancel-pending" | "cancelled" | "expired" | "rejected" | "purged" | "failed";

export interface TransferJournalEntry {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly actorId: string;
  readonly libraryId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly intentId: string;
  readonly phase: TransferPhase;
  readonly startKey: string;
  readonly completeKey: string;
  readonly cancelKey: string;
  readonly fileName: string;
  readonly format: PhotoFormat;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly candidate: RecipeCandidate | null;
  readonly cloudRecipe: RecipeDocument | null;
  readonly uploadId: string | null;
  readonly photoId: string | null;
  readonly expiresAt: string | null;
  readonly uploadedBytes: number;
  readonly failure: "not-found" | "stored" | "invalid-response" | null;
}

export type JournalScope = Pick<TransferJournalEntry, "actorId" | "libraryId" | "sessionId" | "sessionEpoch">;
export interface TransferJournalListOptions { readonly cursor?: string; readonly limit?: number }
export interface TransferJournalPage { readonly entries: readonly TransferJournalEntry[]; readonly nextCursor: string | null }

export class IndexedDbTransferJournal {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private disposed = false;

  constructor(private readonly factory: IDBFactory, private readonly databaseName: string) {}

  async add(entry: TransferJournalEntry, signal?: AbortSignal): Promise<void> {
    validateEntry(entry);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [STORE, FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(FENCES), scopeFromEntry(entry), transaction, signal);
    transaction.objectStore(STORE).add(entry);
    await transactionWait(barrier, transaction, signal);
  }

  async get(scope: JournalScope, intentId: string, signal?: AbortSignal): Promise<TransferJournalEntry | null> {
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [STORE, FENCES], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(FENCES), scope, transaction, signal);
    const request = transaction.objectStore(STORE).get(entryId(scope, intentId));
    const result = await transactionWait(requestResult(request), transaction, signal);
    await transactionWait(barrier, transaction, signal);
    if (result === undefined) return null;
    validateEntry(result);
    if (!sameScope(result, scope) || result.intentId !== intentId) unavailable();
    return clone(result);
  }

  async list(scope: JournalScope, options: TransferJournalListOptions = {}, signal?: AbortSignal): Promise<TransferJournalPage> {
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) unavailable();
    if (options.cursor !== undefined && !validIntent(options.cursor)) unavailable();
    validateScope(scope);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [STORE, FENCES], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(FENCES), scope, transaction, signal);
    const index = transaction.objectStore(STORE).index(SCOPE_INTENT_INDEX);
    const prefix = scopeKey(scope);
    const range = options.cursor === undefined
      ? IDBKeyRange.bound(prefix, [...prefix, []])
      : IDBKeyRange.bound([...prefix, options.cursor], [...prefix, []], true, false);
    const entries: TransferJournalEntry[] = [];
    let bytes = 0;
    let nextCursor: string | null = null;
    const cursorPromise = new Promise<void>((resolve, reject) => {
      const request = index.openCursor(range, "next");
      request.onerror = () => reject(new PersonalPhotoCloudError("unavailable"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) { resolve(); return; }
        const value: unknown = cursor.value;
        try {
          validateEntry(value);
          if (!sameScope(value, scope)) unavailable();
          const serializedBytes = encodedJsonBytes(value);
          if (serializedBytes > MAX_PAGE_BYTES) unavailable();
          if (entries.length >= limit || entries.length > 0 && bytes + serializedBytes > MAX_PAGE_BYTES) {
            nextCursor = entries.at(-1)?.intentId ?? null;
            resolve();
            return;
          }
          entries.push(value);
          bytes += serializedBytes;
          cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    await transactionWait(cursorPromise, transaction, signal);
    await transactionWait(barrier, transaction, signal);
    return { entries, nextCursor };
  }

  async compareAndSet(expected: TransferJournalEntry, next: TransferJournalEntry, signal?: AbortSignal): Promise<void> {
    validateEntry(expected); validateEntry(next);
    if (expected.id !== next.id || expected.revision + 1 !== next.revision || !immutableBindingEqual(expected, next)) unavailable();
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [STORE, FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(FENCES), scopeFromEntry(expected), transaction, signal);
    const store = transaction.objectStore(STORE);
    const current = await transactionWait(requestResult(store.get(expected.id)), transaction, signal);
    if (current === undefined) { transaction.abort(); unavailable(); }
    validateEntry(current);
    if (current.revision !== expected.revision || JSON.stringify(current) !== JSON.stringify(expected)) { transaction.abort(); unavailable(); }
    store.put(next);
    await transactionWait(barrier, transaction, signal);
  }

  /** Atomically fences this exact identity tuple and removes only its persisted transfers. */
  async purgeScope(scope: JournalScope, signal?: AbortSignal): Promise<number> {
    validateScope(scope);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [STORE, FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    transaction.objectStore(FENCES).put({ key: scopeFenceKey(scope), revoked: true });
    const index = transaction.objectStore(STORE).index(SCOPE_INDEX);
    let removed = 0;
    const deletion = new Promise<void>((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(scopeKey(scope)), "next");
      request.onerror = () => reject(new PersonalPhotoCloudError("unavailable"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) { resolve(); return; }
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
    });
    await transactionWait(deletion, transaction, signal);
    await transactionWait(barrier, transaction, signal);
    return removed;
  }

  dispose(): void {
    this.disposed = true;
    if (this.databasePromise !== null) void this.databasePromise.then((database) => database.close(), () => undefined);
  }

  private async database(signal?: AbortSignal): Promise<IDBDatabase> {
    if (this.disposed) unavailable();
    this.databasePromise ??= openDatabase(this.factory, this.databaseName);
    return await awaitBounded(this.databasePromise, {
      signal: signal ?? NEVER_ABORTS,
      timeoutMs: IDB_WAIT_TIMEOUT_MS,
      onLateResolve: (database) => { if (this.disposed || signal?.aborted) database.close(); },
    });
  }
}

export function makeEntryId(scope: JournalScope, intentId: string): string { return entryId(scope, intentId); }

export function validateCandidate(value: unknown): RecipeCandidate | null {
  if (value === null) return null;
  validateRecipeCandidate(value as RecipeCandidate);
  return clone(value as RecipeCandidate);
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(name, DATABASE_VERSION); } catch { reject(new PersonalPhotoCloudError("unavailable")); return; }
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion === 0) {
        const store = database.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex(SCOPE_INDEX, ["actorId", "libraryId", "sessionId", "sessionEpoch"], { unique: false });
        store.createIndex(SCOPE_INTENT_INDEX, ["actorId", "libraryId", "sessionId", "sessionEpoch", "intentId"], { unique: true });
      } else if (oldVersion !== 1) { request.transaction?.abort(); return; }
      database.createObjectStore(FENCES, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(new PersonalPhotoCloudError("unavailable"));
    request.onblocked = () => reject(new PersonalPhotoCloudError("unavailable"));
  });
}

function strictTransaction(database: IDBDatabase, stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
  try { return database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined); }
  catch { unavailable(); }
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new PersonalPhotoCloudError("unavailable")); }); }
function transactionBarrier(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(new PersonalPhotoCloudError("unavailable")); transaction.onerror = () => reject(new PersonalPhotoCloudError("unavailable")); }); }
async function transactionWait<T>(promise: Promise<T>, transaction: IDBTransaction, signal?: AbortSignal): Promise<T> {
  const abort = (): void => { try { transaction.abort(); } catch { /* transaction already settled */ } };
  return await awaitBounded(promise, {
    signal: signal ?? NEVER_ABORTS,
    timeoutMs: IDB_WAIT_TIMEOUT_MS,
    onAbort: abort,
    onTimeout: abort,
  });
}

async function assertScopeNotRevoked(
  fences: IDBObjectStore,
  scope: JournalScope,
  transaction: IDBTransaction,
  signal?: AbortSignal,
): Promise<void> {
  const fence = await transactionWait(requestResult(fences.get(scopeFenceKey(scope))), transaction, signal);
  if (fence !== undefined) {
    try { transaction.abort(); } catch { /* transaction already settled */ }
    throw new PersonalPhotoCloudError("scope_changed");
  }
}

function validateEntry(value: unknown): asserts value is TransferJournalEntry {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "id", "revision", "actorId", "libraryId", "sessionId", "sessionEpoch", "intentId", "phase", "startKey", "completeKey", "cancelKey", "fileName", "format", "contentType", "sizeBytes", "sha256", "candidate", "cloudRecipe", "uploadId", "photoId", "expiresAt", "uploadedBytes", "failure"]) || value.schemaVersion !== 1 || !safeNonNegative(value.revision) || ![value.id, value.actorId, value.libraryId, value.sessionId, value.sessionEpoch, value.intentId, value.startKey, value.completeKey, value.cancelKey, value.fileName, value.contentType].every(nonEmpty) || !["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(value.format as string) || !safePositive(value.sizeBytes) || value.sizeBytes > PHOTO_LIMITS.maxFileBytes || typeof value.sha256 !== "string" || !SHA256.test(value.sha256) || !safeNonNegative(value.uploadedBytes) || value.uploadedBytes > value.sizeBytes || !["start-pending", "uploading", "complete-pending", "verifying", "pending-recipe", "done", "cancel-pending", "cancelled", "expired", "rejected", "purged", "failed"].includes(value.phase as string)) unavailable();
  const scope = value as unknown as JournalScope;
  if (value.id !== entryId(scope, value.intentId as string)) unavailable();
  validateCandidate(value.candidate);
  if (value.cloudRecipe !== null) {
    validateRecipe(value.cloudRecipe as RecipeDocument);
    if (encodedJsonBytes(value.cloudRecipe) > PHOTO_LIMITS.maxRecipeBodyBytes) unavailable();
  }
  if (value.uploadId !== null && !nonEmpty(value.uploadId) || value.photoId !== null && !nonEmpty(value.photoId) || value.expiresAt !== null && !Number.isFinite(Date.parse(value.expiresAt as string)) || value.failure !== null && !["not-found", "stored", "invalid-response"].includes(value.failure as string)) unavailable();
}
function immutableBindingEqual(left: TransferJournalEntry, right: TransferJournalEntry): boolean { return ["id", "schemaVersion", "actorId", "libraryId", "sessionId", "sessionEpoch", "intentId", "startKey", "completeKey", "cancelKey", "fileName", "format", "contentType", "sizeBytes", "sha256", "candidate"].every((key) => JSON.stringify(Reflect.get(left, key)) === JSON.stringify(Reflect.get(right, key))); }
function entryId(scope: JournalScope, intentId: string): string { validateScope(scope); if (!validIntent(intentId)) unavailable(); return JSON.stringify([...scopeKey(scope), intentId]); }
function scopeKey(scope: JournalScope): [string, string, string, string] { return [scope.actorId, scope.libraryId, scope.sessionId, scope.sessionEpoch]; }
function scopeFenceKey(scope: JournalScope): string {
  const bytes = new TextEncoder().encode(JSON.stringify(["niho-photo-transfer-scope-fence-v1", ...scopeKey(scope)]));
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function scopeFromEntry(entry: TransferJournalEntry): JournalScope {
  return { actorId: entry.actorId, libraryId: entry.libraryId, sessionId: entry.sessionId, sessionEpoch: entry.sessionEpoch };
}
function validateScope(scope: JournalScope): void { if (![scope.actorId, scope.libraryId, scope.sessionId, scope.sessionEpoch].every(nonEmpty)) unavailable(); }
function validIntent(value: unknown): value is string { return nonEmpty(value) && value.length <= 512; }
function sameScope(entry: TransferJournalEntry, scope: JournalScope): boolean { return entry.actorId === scope.actorId && entry.libraryId === scope.libraryId && entry.sessionId === scope.sessionId && entry.sessionEpoch === scope.sessionEpoch; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value); }
function safeNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safePositive(value: unknown): value is number { return safeNonNegative(value) && value > 0; }
function clone<T>(value: T): T { return structuredClone(value); }
function encodedJsonBytes(value: unknown): number { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { unavailable(); } }
function unavailable(): never { throw new PersonalPhotoCloudError("unavailable"); }
