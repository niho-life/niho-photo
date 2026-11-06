/**
 * Replica of NIHO metadata on the hosted Mac (Epic §4, B01 #242). NIHO is canonical; the Mac keeps a copy to
 * recover from and to render with. This engine only pulls: it has no path that writes the replica back.
 */
import { PHOTO_LIMITS } from "../../photo-library-contract/src/v2.ts";
import type {
  HostConnectorClient,
  ReplicaChange,
  ReplicaEntity,
  ReplicaPage,
} from "../../photo-library-sharing-contract/src/v1.ts";
import { HostedLibraryError, assertNotAborted, isSha256, readBounded, sha256Hex, sharingErrorCode } from "./shared.ts";

export type ReplicaRecord<E extends ReplicaEntity = ReplicaEntity> = Extract<ReplicaChange, { readonly op: "upsert"; readonly entity: E }>;

/** One atomic step: every change is applied and the revision moves to toRevision, or nothing changes. */
export interface ReplicaBatch {
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly changes: readonly ReplicaChange[];
  /** Verified mask bytes for every mask upsert in `changes`, keyed by the change id. */
  readonly maskBytes: ReadonlyMap<string, Uint8Array>;
}
/** Staged rebuild from a snapshot. The previous replica stays intact until commit swaps it atomically. */
export interface ReplicaReplacement {
  append(changes: readonly ReplicaChange[], maskBytes: ReadonlyMap<string, Uint8Array>): Promise<void>;
  commit(toRevision: number): Promise<void>;
  abort(): Promise<void>;
}
/** Durable storage on the Mac (journal + snapshot). Implemented by the connector (B03). */
export interface ReplicaStore {
  /** NIHO revision the durable replica reflects; 0 when empty. */
  revision(): Promise<number>;
  /** Must reject with store_conflict unless the stored revision equals batch.fromRevision. */
  apply(batch: ReplicaBatch): Promise<void>;
  beginReplace(): Promise<ReplicaReplacement>;
  get<E extends ReplicaEntity>(entity: E, id: string): Promise<ReplicaRecord<E> | null>;
  records<E extends ReplicaEntity>(entity: E): AsyncIterable<ReplicaRecord<E>>;
  maskBytes(id: string): Promise<Uint8Array | null>;
}

export interface ReplicaStatus {
  /** Latest NIHO revision observed (heartbeat or pull). null before the first sync. */
  readonly canonicalRevision: number | null;
  /** Revision durably applied to the replica on this Mac. */
  readonly replicaRevision: number;
  readonly state: "unknown" | "syncing" | "current" | "behind";
}
export interface ReplicaSyncResult {
  readonly mode: "unchanged" | "diff" | "snapshot";
  readonly canonicalRevision: number;
  readonly replicaRevision: number;
  readonly appliedChanges: number;
  /** false when the ack response was lost; the next sync acknowledges the same revision with the same key. */
  readonly acknowledged: boolean;
}
export interface HostedReplicaSync {
  status(): ReplicaStatus;
  /** canonicalRevision comes from connector.heartbeat. Concurrent calls run one after another. */
  sync(input: { readonly canonicalRevision: number; readonly signal: AbortSignal }): Promise<ReplicaSyncResult>;
}
export interface CreateHostedReplicaSyncOptions {
  /** Only connector.pullReplica, connector.getReplicaContent and connector.ackReplica are called. */
  readonly client: Pick<HostConnectorClient, "request">;
  readonly store: ReplicaStore;
  readonly pageLimit?: number;
  /** Safety bound on pages per sync; the next sync continues from the durable revision. */
  readonly maxPages?: number;
}

const ENTITIES: readonly ReplicaEntity[] = ["photo", "recipe", "mask", "albumDefinition", "exclusion"];
const revisionOk = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** `after`: the revision the previous page ended at (equal to since for a diff, 0 for a fresh snapshot). */
function validatePage(page: ReplicaPage, since: number, after: number): void {
  if (!page || page.sinceRevision !== since || !revisionOk(page.nextRevision) || page.nextRevision < after) {
    throw new HostedLibraryError("invalid_response");
  }
  if (!Array.isArray(page.changes) || typeof page.complete !== "boolean") throw new HostedLibraryError("invalid_response");
  // A diff never carries a cursor; an unfinished snapshot always does.
  if (since !== 0 && page.cursor !== null) throw new HostedLibraryError("invalid_response");
  if (since === 0 && !page.complete && (typeof page.cursor !== "string" || !page.cursor)) throw new HostedLibraryError("invalid_response");
  let previous = after;
  for (const change of page.changes) {
    if (!revisionOk(change.revision) || change.revision <= previous || change.revision > page.nextRevision) {
      throw new HostedLibraryError("invalid_response");
    }
    if (!ENTITIES.includes(change.entity) || typeof change.id !== "string" || !change.id) throw new HostedLibraryError("invalid_response");
    if (change.op === "delete") {
      // Deleting something the staged snapshot never received is a no-op.
    } else if (change.op !== "upsert") {
      throw new HostedLibraryError("invalid_response");
    } else if (change.entity === "mask") {
      const body = change.body;
      if (!isSha256(body.surfaceId) || !revisionOk(body.sizeBytes) || body.sizeBytes > PHOTO_LIMITS.maxMaskBytes) {
        throw new HostedLibraryError("invalid_response");
      }
    }
    previous = change.revision;
  }
  if (!page.complete && page.nextRevision === after && page.changes.length === 0) throw new HostedLibraryError("invalid_response");
}

export function createHostedReplicaSync(options: CreateHostedReplicaSyncOptions): HostedReplicaSync {
  const pageLimit = options.pageLimit ?? 500;
  const maxPages = options.maxPages ?? 1000;
  let status: ReplicaStatus = { canonicalRevision: null, replicaRevision: 0, state: "unknown" };
  let queue: Promise<unknown> = Promise.resolve();

  const fetchMasks = async (changes: readonly ReplicaChange[], signal: AbortSignal): Promise<Map<string, Uint8Array>> => {
    const bytes = new Map<string, Uint8Array>();
    for (const change of changes) {
      if (change.op !== "upsert" || change.entity !== "mask") continue;
      assertNotAborted(signal);
      const content = await options.client.request("connector.getReplicaContent", { entity: "mask", id: change.id }, { signal });
      if (content.sha256 !== change.body.surfaceId || content.totalBytes !== change.body.sizeBytes) {
        throw new HostedLibraryError("integrity_mismatch");
      }
      const data = await readBounded(content.body, PHOTO_LIMITS.maxMaskBytes, signal);
      if (data.byteLength !== change.body.sizeBytes || (await sha256Hex(data)) !== change.body.surfaceId) {
        throw new HostedLibraryError("integrity_mismatch");
      }
      bytes.set(change.id, data);
    }
    return bytes;
  };

  const pull = async (since: number, signal: AbortSignal): Promise<ReplicaPage> => {
    assertNotAborted(signal);
    const page = await options.client.request("connector.pullReplica", { sinceRevision: since, limit: pageLimit }, { signal });
    validatePage(page, since, since);
    return page;
  };

  /** One snapshot pass into a staged replacement; the old replica stays readable until commit. */
  const snapshotOnce = async (signal: AbortSignal): Promise<{ revision: number; applied: number }> => {
    const replacement = await options.store.beginReplace();
    try {
      let cursor: string | null = null;
      let after = 0;
      let applied = 0;
      for (let pages = 0; ; pages++) {
        if (pages >= maxPages) throw new HostedLibraryError("incomplete_replica");
        assertNotAborted(signal);
        const request: { sinceRevision: number; limit: number; cursor?: string } = { sinceRevision: 0, limit: pageLimit };
        if (cursor) request.cursor = cursor;
        const page = await options.client.request("connector.pullReplica", request, { signal });
        validatePage(page, 0, after);
        await replacement.append(page.changes, await fetchMasks(page.changes, signal));
        applied += page.changes.length;
        after = page.nextRevision;
        if (page.complete) break;
        cursor = page.cursor;
      }
      assertNotAborted(signal);
      await replacement.commit(after);
      return { revision: after, applied };
    } catch (error) {
      await replacement.abort().catch(() => undefined);
      throw error;
    }
  };

  /** Compaction during a snapshot invalidates its cursor; the snapshot restarts from the beginning. */
  const rebuild = async (signal: AbortSignal): Promise<{ revision: number; applied: number }> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await snapshotOnce(signal);
      } catch (error) {
        if (sharingErrorCode(error) !== "replica_reset_required" || attempt >= 3) throw error;
      }
    }
  };

  const run = async (canonicalRevision: number, signal: AbortSignal): Promise<ReplicaSyncResult> => {
    if (!revisionOk(canonicalRevision)) throw new HostedLibraryError("invalid_request");
    let replica = await options.store.revision();
    let canonical = canonicalRevision;
    status = { canonicalRevision: canonical, replicaRevision: replica, state: "syncing" };
    let mode: ReplicaSyncResult["mode"] = "unchanged";
    let applied = 0;

    // A replica ahead of NIHO did not come from NIHO; rebuild it rather than promote it.
    let reset = replica > canonical;
    if (!reset && replica < canonical) {
      mode = "diff";
      try {
        for (let pages = 0; ; pages++) {
          if (pages >= maxPages) break;
          const page = await pull(replica, signal);
          if (page.changes.length || page.nextRevision !== replica) {
            await options.store.apply({
              fromRevision: replica,
              toRevision: page.nextRevision,
              changes: page.changes,
              maskBytes: await fetchMasks(page.changes, signal),
            });
            applied += page.changes.length;
            replica = page.nextRevision;
            canonical = Math.max(canonical, replica);
            status = { canonicalRevision: canonical, replicaRevision: replica, state: "syncing" };
          }
          if (page.complete) break;
        }
      } catch (error) {
        if (sharingErrorCode(error) !== "replica_reset_required") throw error;
        reset = true;
      }
    }
    if (reset) {
      mode = "snapshot";
      const rebuilt = await rebuild(signal);
      replica = rebuilt.revision;
      applied = rebuilt.applied;
      canonical = Math.max(canonicalRevision, replica);
    }

    let acknowledged = false;
    try {
      assertNotAborted(signal);
      // Deterministic key: a lost ack response is replayed, never recorded twice.
      await options.client.request("connector.ackReplica", { revision: replica }, { signal, idempotencyKey: `replica-ack-${replica}` });
      acknowledged = true;
    } catch (error) {
      if (error instanceof HostedLibraryError && error.code === "aborted") throw error;
    }
    status = { canonicalRevision: canonical, replicaRevision: replica, state: replica >= canonical ? "current" : "behind" };
    return { mode, canonicalRevision: canonical, replicaRevision: replica, appliedChanges: applied, acknowledged };
  };

  return {
    status: () => status,
    sync(input) {
      const next = queue.then(() => run(input.canonicalRevision, input.signal));
      queue = next.catch(() => undefined);
      return next.finally(async () => {
        if (status.state === "syncing") {
          const replicaRevision = await options.store.revision().catch(() => status.replicaRevision);
          status = { ...status, replicaRevision, state: "behind" };
        }
      });
    },
  };
}
