/** Synthetic in-memory ports with fault injection. Not product storage. */
import type { ReplicaChange, ReplicaEntity } from "../../photo-library-sharing-contract/src/v1.ts";
import type { ReplicaBatch, ReplicaRecord, ReplicaReplacement, ReplicaStore } from "../src/replica.ts";
import type { SourceScanner } from "../src/index-recovery.ts";
import { HostedLibraryError, sha256Hex } from "../src/shared.ts";

const keyOf = (entity: ReplicaEntity, id: string): string => `${entity}:${id}`;

function applyChanges(
  data: Map<string, ReplicaRecord>,
  masks: Map<string, Uint8Array>,
  changes: readonly ReplicaChange[],
  maskBytes: ReadonlyMap<string, Uint8Array>,
): void {
  for (const change of changes) {
    const key = keyOf(change.entity, change.id);
    if (change.op === "delete") {
      data.delete(key);
      if (change.entity === "mask") masks.delete(change.id);
      continue;
    }
    data.set(key, change);
    if (change.entity === "mask") {
      const bytes = maskBytes.get(change.id);
      if (!bytes) throw new HostedLibraryError("integrity_mismatch");
      masks.set(change.id, bytes);
    }
  }
}

export class MemoryReplicaStore implements ReplicaStore {
  private current = 0;
  private data = new Map<string, ReplicaRecord>();
  private masks = new Map<string, Uint8Array>();
  /** Fault injection: the next apply fails before anything is written. */
  failNextApply = false;
  applied: ReplicaBatch[] = [];

  async revision(): Promise<number> {
    return this.current;
  }
  async apply(batch: ReplicaBatch): Promise<void> {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error("synthetic disk failure");
    }
    if (batch.fromRevision !== this.current) throw new HostedLibraryError("store_conflict");
    const data = new Map(this.data);
    const masks = new Map(this.masks);
    applyChanges(data, masks, batch.changes, batch.maskBytes);
    this.data = data;
    this.masks = masks;
    this.current = batch.toRevision;
    this.applied.push(batch);
  }
  async beginReplace(): Promise<ReplicaReplacement> {
    const data = new Map<string, ReplicaRecord>();
    const masks = new Map<string, Uint8Array>();
    let open = true;
    return {
      append: async (changes, maskBytes) => {
        if (!open) throw new HostedLibraryError("store_conflict");
        applyChanges(data, masks, changes, maskBytes);
      },
      commit: async (toRevision) => {
        if (!open) throw new HostedLibraryError("store_conflict");
        open = false;
        this.data = data;
        this.masks = masks;
        this.current = toRevision;
      },
      abort: async () => {
        open = false;
      },
    };
  }
  async get<E extends ReplicaEntity>(entity: E, id: string): Promise<ReplicaRecord<E> | null> {
    return (this.data.get(keyOf(entity, id)) as ReplicaRecord<E> | undefined) ?? null;
  }
  async *records<E extends ReplicaEntity>(entity: E): AsyncIterable<ReplicaRecord<E>> {
    for (const record of [...this.data.values()]) if (record.entity === entity) yield record as ReplicaRecord<E>;
  }
  async maskBytes(id: string): Promise<Uint8Array | null> {
    return this.masks.get(id) ?? null;
  }

  /** Test helpers: simulate local corruption that must never reach NIHO. */
  tamperRevision(revision: number): void {
    this.current = revision;
  }
  tamperRecord(record: ReplicaRecord): void {
    this.data.set(keyOf(record.entity, record.id), record);
  }
  dropMaskBytes(id: string): void {
    this.masks.delete(id);
  }
  snapshot(): { readonly revision: number; readonly records: readonly ReplicaRecord[] } {
    return { revision: this.current, records: [...this.data.values()].sort((a, b) => a.revision - b.revision) };
  }
}

/** Synthetic originals under registered roots, addressed by localKey. */
export class MemoryScanner implements SourceScanner {
  files = new Map<string, Uint8Array>();
  unmounted = false;
  unreadable = new Set<string>();
  calls: string[] = [];

  async stat(localKey: string) {
    this.calls.push(`stat:${localKey}`);
    if (this.unreadable.has(localKey)) throw new Error("synthetic permission failure");
    if (this.unmounted) return { state: "unmounted" as const };
    const bytes = this.files.get(localKey);
    return bytes ? { state: "present" as const, sizeBytes: bytes.byteLength } : { state: "missing" as const };
  }
  async sha256(localKey: string): Promise<string> {
    this.calls.push(`hash:${localKey}`);
    const bytes = this.files.get(localKey);
    if (!bytes) throw new Error("synthetic missing file");
    return sha256Hex(bytes);
  }
}

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
