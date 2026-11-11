/**
 * Durable Mac stores for the hosted connector (B01 #242 / B03 #244). Paths stay in the hidden connector window's
 * native Application Support store; the path-free NIHO replica uses persistent WKWebView IndexedDB.
 */
import type { LocalIndexEntry, LocalIndexStore, ScanCheckpoint } from "@niho/photo-hosted-connector";
import type { Invoke } from "../camera-bridge";
import type {
  ReplicaChange,
  ReplicaEntity,
} from "@niho/photo-library-sharing-contract";
import { HostedLibraryError, type ReplicaRecord, type ReplicaReplacement, type ReplicaStore } from "@niho/photo-hosted-library";

const DATABASE_NAME = "niho-photo-hosted-connector";
const DATABASE_VERSION = 1;
const MAX_NATIVE_INDEX_BATCH_ENTRIES = 5_000;
const MAX_NATIVE_INDEX_BATCH_BYTES = 32 << 20;
const STORES = {
  replicaRecords: "replicaRecords",
  replicaMasks: "replicaMasks",
  replicaMetadata: "replicaMetadata",
} as const;
const INITIAL_GENERATION = "generation-0";

type ConnectorStorageScope = Readonly<{ connectorId: string; libraryId: string }>;
type MetadataRow = Readonly<{ scope: string; key: string; value: unknown }>;
type ReplicaRecordRow = Readonly<{
  scope: string;
  generation: string;
  entity: ReplicaEntity;
  id: string;
  record: ReplicaRecord;
}>;
type ReplicaMaskRow = Readonly<{ scope: string; generation: string; id: string; bytes: Uint8Array }>;

function* nativeIndexBatches(entries: readonly LocalIndexEntry[]): Generator<readonly LocalIndexEntry[]> {
  const encoder = new TextEncoder();
  let batch: LocalIndexEntry[] = [];
  let batchBytes = 2; // JSON array brackets.
  for (const entry of entries) {
    const entryBytes = encoder.encode(JSON.stringify(entry)).byteLength;
    const nextBytes = batchBytes + entryBytes + (batch.length > 0 ? 1 : 0); // Comma between entries.
    if (entryBytes + 2 > MAX_NATIVE_INDEX_BATCH_BYTES) {
      throw new RangeError("hosted connector index entry exceeds the native batch limit");
    }
    if (batch.length > 0 && (batch.length >= MAX_NATIVE_INDEX_BATCH_ENTRIES || nextBytes > MAX_NATIVE_INDEX_BATCH_BYTES)) {
      yield batch;
      batch = [];
      batchBytes = 2;
    }
    batch.push(entry);
    batchBytes += entryBytes + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length > 0) yield batch;
}

function transaction(db: IDBDatabase, names: string[], mode: IDBTransactionMode): IDBTransaction {
  try {
    return db.transaction(names, mode, { durability: "strict" });
  } catch {
    // Older WebKit releases do not accept transaction durability options.
    return db.transaction(names, mode);
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("hosted connector storage transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("hosted connector storage transaction failed"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("hosted connector storage request failed"));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const records = db.createObjectStore(STORES.replicaRecords, { keyPath: ["scope", "generation", "entity", "id"] });
      records.createIndex("byScopeGeneration", ["scope", "generation"]);
      records.createIndex("byScopeGenerationEntity", ["scope", "generation", "entity"]);
      const masks = db.createObjectStore(STORES.replicaMasks, { keyPath: ["scope", "generation", "id"] });
      masks.createIndex("byScopeGeneration", ["scope", "generation"]);
      db.createObjectStore(STORES.replicaMetadata, { keyPath: ["scope", "key"] });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("hosted connector database is unavailable"));
    request.onblocked = () => reject(new Error("hosted connector database upgrade is blocked"));
  });
}

function scopeKey(scope: ConnectorStorageScope): string {
  if (!scope.connectorId || !scope.libraryId) throw new HostedLibraryError("invalid_request");
  return `${scope.connectorId.length}:${scope.connectorId}${scope.libraryId.length}:${scope.libraryId}`;
}

function createNativeLocalIndexStore(invoke: Invoke): LocalIndexStore {
  let scope: ConnectorStorageScope | null = null;
  let loaded = false;
  let loadingScope: ConnectorStorageScope | null = null;
  let loadPromise: Promise<void> | null = null;
  let entryCache = new Map<string, LocalIndexEntry>();
  let photoIds = new Map<string, string>();
  const request = (
    operation: string,
    payload: Record<string, unknown> = {},
    requestedScope = scope,
  ) => {
    if (!requestedScope) throw new Error("hosted connector storage scope is not paired");
    return {
      request: {
        operation,
        connectorId: requestedScope.connectorId,
        libraryId: requestedScope.libraryId,
        ...payload,
      },
    };
  };
  const ensureLoaded = async () => {
    if (loaded) return;
    if (loadPromise && loadingScope === scope) return loadPromise;
    const capturedScope = scope;
    const pending = (async () => {
      const rows = await invoke<LocalIndexEntry[]>("camera_hosted_connector_index_store", request("entries"));
      if (scope !== capturedScope) throw new Error("hosted connector storage scope changed during load");
      entryCache = new Map(rows.map((entry) => [entry.localKey, entry]));
      photoIds = new Map(rows.flatMap((entry) => entry.photoId ? [[entry.photoId, entry.localKey] as const] : []));
      loaded = true;
    })();
    loadPromise = pending;
    loadingScope = capturedScope;
    try {
      await pending;
    } finally {
      if (loadPromise === pending) {
        loadPromise = null;
        loadingScope = null;
      }
    }
  };
  const invalidate = (expectedScope: ConnectorStorageScope) => {
    if (scope !== expectedScope) return;
    loaded = false;
    entryCache = new Map();
    photoIds = new Map();
  };
  return {
    async setScope(next) {
      if (scope?.connectorId === next.connectorId && scope.libraryId === next.libraryId) return;
      scope = { connectorId: next.connectorId, libraryId: next.libraryId };
      loaded = false;
      entryCache = new Map();
      photoIds = new Map();
    },
    async get(localKey) {
      await ensureLoaded();
      return entryCache.get(localKey) ?? null;
    },
    async byPhotoId(photoId) {
      await ensureLoaded();
      const localKey = photoIds.get(photoId);
      return localKey ? entryCache.get(localKey) ?? null : null;
    },
    async put(nextEntries) {
      await ensureLoaded();
      const capturedScope = scope;
      try {
        for (const entries of nativeIndexBatches(nextEntries)) {
          if (scope !== capturedScope) throw new Error("hosted connector storage scope changed during write");
          await invoke("camera_hosted_connector_index_store", request("put", { entries }, capturedScope));
          if (scope !== capturedScope) throw new Error("hosted connector storage scope changed during write");
          for (const entry of entries) {
            const previous = entryCache.get(entry.localKey);
            if (previous?.photoId && previous.photoId !== entry.photoId && photoIds.get(previous.photoId) === entry.localKey) {
              photoIds.delete(previous.photoId);
            }
            entryCache.set(entry.localKey, entry);
            if (entry.photoId) photoIds.set(entry.photoId, entry.localKey);
          }
        }
      } catch (error) {
        if (capturedScope) invalidate(capturedScope);
        throw error;
      }
    },
    async *entries() {
      await ensureLoaded();
      for (const entry of entryCache.values()) yield entry;
    },
    checkpoint() {
      return invoke<ScanCheckpoint | null>("camera_hosted_connector_index_store", request("checkpoint"));
    },
    async setCheckpoint(checkpoint) {
      await invoke("camera_hosted_connector_index_store", request("setCheckpoint", { checkpoint }));
    },
    async clear() {
      const capturedScope = scope;
      try {
        await invoke("camera_hosted_connector_index_store", request("clear"));
      } catch (error) {
        if (capturedScope) invalidate(capturedScope);
        throw error;
      }
      if (scope !== capturedScope) throw new Error("hosted connector storage scope changed during clear");
      entryCache = new Map();
      photoIds = new Map();
      loaded = true;
    },
  };
}

class IndexedDbReplicaStore implements ReplicaStore {
  private scope: string | null = null;

  constructor(private readonly db: IDBDatabase) {}

  async setScope(scope: ConnectorStorageScope): Promise<void> {
    const next = scopeKey(scope);
    if (this.scope === next) return;
    await this.recoverInterruptedWrites(next);
    this.scope = next;
  }

  private currentScope(): string {
    if (this.scope === null) throw new Error("hosted connector storage scope is not paired");
    return this.scope;
  }

  private async readMetadata(scope: string, key: string): Promise<unknown> {
    const tx = transaction(this.db, [STORES.replicaMetadata], "readonly");
    const done = transactionDone(tx);
    const row = await requestResult(tx.objectStore(STORES.replicaMetadata).get([scope, key])) as MetadataRow | undefined;
    await done;
    return row?.value;
  }

  private async clearMetadataIf(scope: string, key: string, expected: unknown): Promise<void> {
    const tx = transaction(this.db, [STORES.replicaMetadata], "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.replicaMetadata);
    const row = await requestResult(store.get([scope, key])) as MetadataRow | undefined;
    if (row?.value === expected) store.delete([scope, key]);
    await done;
  }

  private async deleteGeneration(scope: string, generation: string): Promise<void> {
    const tx = transaction(this.db, [STORES.replicaRecords, STORES.replicaMasks], "readwrite");
    const done = transactionDone(tx);
    const records = tx.objectStore(STORES.replicaRecords);
    const masks = tx.objectStore(STORES.replicaMasks);
    const recordKeys = await requestResult(records.index("byScopeGeneration").getAllKeys([scope, generation]));
    const maskKeys = await requestResult(masks.index("byScopeGeneration").getAllKeys([scope, generation]));
    for (const key of recordKeys) records.delete(key);
    for (const key of maskKeys) masks.delete(key);
    await done;
  }

  /** Cleans generations left by a crash before/after the atomic pointer swap. */
  private async recoverInterruptedWrites(scope: string): Promise<void> {
    const keys = ["previousGeneration", "stagedGeneration", "staleGeneration"] as const;
    for (const key of keys) {
      const candidate = await this.readMetadata(scope, key);
      if (typeof candidate !== "string") continue;
      const active = await this.readMetadata(scope, "activeGeneration");
      if (candidate !== active) await this.deleteGeneration(scope, candidate);
      await this.clearMetadataIf(scope, key, candidate);
    }
  }

  private async activeGeneration(scope: string): Promise<string> {
    const active = await this.readMetadata(scope, "activeGeneration");
    if (active === undefined) return INITIAL_GENERATION;
    if (typeof active === "string" && active.length > 0) return active;
    throw new HostedLibraryError("invalid_response");
  }

  async revision(): Promise<number> {
    const scope = this.currentScope();
    const value = await this.readMetadata(scope, "revision");
    if (value === undefined) return 0;
    if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
    throw new HostedLibraryError("invalid_response");
  }

  async apply(batch: Parameters<ReplicaStore["apply"]>[0]): Promise<void> {
    if (!Number.isSafeInteger(batch.fromRevision) || !Number.isSafeInteger(batch.toRevision) || batch.toRevision < batch.fromRevision) {
      throw new HostedLibraryError("invalid_request");
    }
    const scope = this.currentScope();
    const generation = await this.activeGeneration(scope);
    const tx = transaction(this.db, [STORES.replicaRecords, STORES.replicaMasks, STORES.replicaMetadata], "readwrite");
    const done = transactionDone(tx);
    try {
      const metadata = tx.objectStore(STORES.replicaMetadata);
      const current = await requestResult(metadata.get([scope, "revision"])) as MetadataRow | undefined;
      const currentRevision = current?.value === undefined ? 0 : current.value;
      if (typeof currentRevision !== "number" || !Number.isSafeInteger(currentRevision) || currentRevision < 0) {
        throw new HostedLibraryError("invalid_response");
      }
      if (currentRevision !== batch.fromRevision) throw new HostedLibraryError("store_conflict");
      const records = tx.objectStore(STORES.replicaRecords);
      const masks = tx.objectStore(STORES.replicaMasks);
      for (const change of batch.changes) this.applyChange(scope, generation, change, batch.maskBytes, records, masks);
      metadata.put({ scope, key: "revision", value: batch.toRevision } satisfies MetadataRow);
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }

  private applyChange(
    scope: string,
    generation: string,
    change: ReplicaChange,
    maskBytes: ReadonlyMap<string, Uint8Array>,
    records: IDBObjectStore,
    masks: IDBObjectStore,
  ): void {
    if (change.op === "delete") {
      records.delete([scope, generation, change.entity, change.id]);
      if (change.entity === "mask") masks.delete([scope, generation, change.id]);
      return;
    }
    records.put({ scope, generation, entity: change.entity, id: change.id, record: change } satisfies ReplicaRecordRow);
    if (change.entity === "mask") {
      const bytes = maskBytes.get(change.id);
      if (!bytes) throw new HostedLibraryError("integrity_mismatch");
      masks.put({ scope, generation, id: change.id, bytes: Uint8Array.from(bytes) } satisfies ReplicaMaskRow);
    }
  }

  async beginReplace(): Promise<ReplicaReplacement> {
    const scope = this.currentScope();
    await this.recoverInterruptedWrites(scope);
    const generation = globalThis.crypto.randomUUID();
    const tx = transaction(this.db, [STORES.replicaMetadata], "readwrite");
    const done = transactionDone(tx);
    try {
      const metadata = tx.objectStore(STORES.replicaMetadata);
      const staged = await requestResult(metadata.get([scope, "stagedGeneration"])) as MetadataRow | undefined;
      if (typeof staged?.value === "string") throw new HostedLibraryError("store_conflict");
      metadata.put({ scope, key: "stagedGeneration", value: generation } satisfies MetadataRow);
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
    await done;

    let open = true;
    return {
      append: async (changes, maskBytes) => {
        if (!open) throw new HostedLibraryError("store_conflict");
        const appendTx = transaction(this.db, [STORES.replicaRecords, STORES.replicaMasks, STORES.replicaMetadata], "readwrite");
        const appendDone = transactionDone(appendTx);
        try {
          const metadata = appendTx.objectStore(STORES.replicaMetadata);
          const staged = await requestResult(metadata.get([scope, "stagedGeneration"])) as MetadataRow | undefined;
          if (staged?.value !== generation) throw new HostedLibraryError("store_conflict");
          const records = appendTx.objectStore(STORES.replicaRecords);
          const masks = appendTx.objectStore(STORES.replicaMasks);
          for (const change of changes) this.applyChange(scope, generation, change, maskBytes, records, masks);
        } catch (error) {
          try { appendTx.abort(); } catch { /* The transaction may already have aborted. */ }
          await appendDone.catch(() => undefined);
          throw error;
        }
        await appendDone;
      },
      commit: async (toRevision) => {
        if (!open || !Number.isSafeInteger(toRevision) || toRevision < 0) throw new HostedLibraryError("store_conflict");
        const commitTx = transaction(this.db, [STORES.replicaMetadata], "readwrite");
        const commitDone = transactionDone(commitTx);
        try {
          const metadata = commitTx.objectStore(STORES.replicaMetadata);
          const staged = await requestResult(metadata.get([scope, "stagedGeneration"])) as MetadataRow | undefined;
          const active = await requestResult(metadata.get([scope, "activeGeneration"])) as MetadataRow | undefined;
          if (staged?.value !== generation) throw new HostedLibraryError("store_conflict");
          if (active?.value !== undefined && (typeof active.value !== "string" || !active.value)) {
            throw new HostedLibraryError("invalid_response");
          }
          const previous = typeof active?.value === "string" ? active.value : INITIAL_GENERATION;
          metadata.put({ scope, key: "activeGeneration", value: generation } satisfies MetadataRow);
          metadata.put({ scope, key: "revision", value: toRevision } satisfies MetadataRow);
          metadata.put({ scope, key: "previousGeneration", value: previous } satisfies MetadataRow);
          metadata.delete([scope, "stagedGeneration"]);
        } catch (error) {
          try { commitTx.abort(); } catch { /* The transaction may already have aborted. */ }
          await commitDone.catch(() => undefined);
          throw error;
        }
        await commitDone;
        open = false;
        await this.recoverInterruptedWrites(scope).catch(() => undefined);
      },
      abort: async () => {
        if (!open) return;
        const abortTx = transaction(this.db, [STORES.replicaMetadata], "readwrite");
        const abortDone = transactionDone(abortTx);
        try {
          const metadata = abortTx.objectStore(STORES.replicaMetadata);
          const staged = await requestResult(metadata.get([scope, "stagedGeneration"])) as MetadataRow | undefined;
          if (staged?.value === generation) {
            metadata.put({ scope, key: "staleGeneration", value: generation } satisfies MetadataRow);
            metadata.delete([scope, "stagedGeneration"]);
          }
        } catch (error) {
          try { abortTx.abort(); } catch { /* The transaction may already have aborted. */ }
          await abortDone.catch(() => undefined);
          throw error;
        }
        await abortDone;
        open = false;
        await this.recoverInterruptedWrites(scope).catch(() => undefined);
      },
    };
  }

  async get<E extends ReplicaEntity>(entity: E, id: string): Promise<ReplicaRecord<E> | null> {
    const scope = this.currentScope();
    const generation = await this.activeGeneration(scope);
    const tx = transaction(this.db, [STORES.replicaRecords], "readonly");
    const done = transactionDone(tx);
    const row = await requestResult(tx.objectStore(STORES.replicaRecords).get([scope, generation, entity, id])) as ReplicaRecordRow | undefined;
    await done;
    if (row && (row.record.entity !== entity || row.record.id !== id || row.record.op !== "upsert")) {
      throw new HostedLibraryError("invalid_response");
    }
    return (row?.record as ReplicaRecord<E> | undefined) ?? null;
  }

  async *records<E extends ReplicaEntity>(entity: E): AsyncIterable<ReplicaRecord<E>> {
    const scope = this.currentScope();
    const generation = await this.activeGeneration(scope);
    const tx = transaction(this.db, [STORES.replicaRecords], "readonly");
    const done = transactionDone(tx);
    const rows = await requestResult(tx.objectStore(STORES.replicaRecords).index("byScopeGenerationEntity").getAll([scope, generation, entity])) as ReplicaRecordRow[];
    await done;
    for (const row of rows) {
      if (row.record.entity !== entity || row.record.id !== row.id || row.record.op !== "upsert") {
        throw new HostedLibraryError("invalid_response");
      }
      yield row.record as ReplicaRecord<E>;
    }
  }

  async maskBytes(id: string): Promise<Uint8Array | null> {
    const scope = this.currentScope();
    const generation = await this.activeGeneration(scope);
    const tx = transaction(this.db, [STORES.replicaMasks], "readonly");
    const done = transactionDone(tx);
    const row = await requestResult(tx.objectStore(STORES.replicaMasks).get([scope, generation, id])) as ReplicaMaskRow | undefined;
    await done;
    if (row && !(row.bytes instanceof Uint8Array)) throw new HostedLibraryError("invalid_response");
    return row ? Uint8Array.from(row.bytes) : null;
  }
}

/** Creates the durable stores. No in-memory fallback is provided if IndexedDB is unavailable or quota is exhausted. */
export async function createPersistentHostedConnectorStores(invoke: Invoke, factory: IDBFactory = globalThis.indexedDB): Promise<{
  readonly index: LocalIndexStore;
  readonly replica: ReplicaStore;
}> {
  if (!factory) throw new Error("hosted connector persistent storage is unavailable");
  const db = await openDatabase(factory);
  await invoke("camera_hosted_connector_index_store", { request: { operation: "health" } });
  return { index: createNativeLocalIndexStore(invoke), replica: new IndexedDbReplicaStore(db) };
}
