/**
 * Read-only incremental index of the owner's existing folders (B03 #244). Metadata first, hashes later in bounded
 * background steps, resumable from a checkpoint after a crash or sleep. Originals are never moved, written or copied;
 * an unmounted volume is never treated as deletion; excluded photos are never revived.
 */
import { canonical } from "../../photo-library-sharing-contract/src/policy.ts";
import type { HostConnectorClient, IndexEntry, PhotoFormat, SourceAvailability } from "../../photo-library-sharing-contract/src/v1.ts";
import { localKeyFor, sha256Text } from "./crypto.ts";
import type { Clock, LocalIndexEntry, LocalIndexStore, RegisteredRoot, RootFileSystem, StreamHasher } from "./ports.ts";

/** Formats the index registers. Capability to decode or render is decided elsewhere (B07). */
export const PHOTO_EXTENSIONS: Readonly<Record<string, PhotoFormat>> = {
  jpg: "jpeg", jpeg: "jpeg", png: "png", heic: "heic", heif: "heif", tif: "tiff", tiff: "tiff",
  rw2: "raw", dng: "raw", arw: "raw", nef: "raw", cr2: "raw", cr3: "raw", raf: "raw", orf: "raw", pef: "raw",
};
/** Packages that are databases of other apps: never descended into. */
const SKIPPED_DIRECTORY_SUFFIXES = [".photoslibrary", ".lrlibrary", ".lrdata", ".app"];
const INDEX_BATCH = 200;

/** Hidden entries, names with separators and other apps' library packages are never registered or descended into. */
export const isHiddenName = (name: string): boolean => name.startsWith(".") || name.includes("/") || name.includes("\\");
export const shouldDescend = (name: string): boolean =>
  !isHiddenName(name) && !SKIPPED_DIRECTORY_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));

export const formatOf = (fileName: string): PhotoFormat | null => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? PHOTO_EXTENSIONS[fileName.slice(dot + 1).toLowerCase()] ?? null : null;
};

export interface IndexProgress {
  readonly scan: number;
  readonly scanning: boolean;
  readonly pendingDirectories: number;
  readonly photos: number;
  /** Photos NIHO has a photoId for: listable now. */
  readonly listed: number;
  readonly hashed: number;
  readonly pendingHashBytes: number;
  readonly unmountedRoots: readonly string[];
  readonly excluded: number;
  readonly held: number;
  /** Measured hash throughput, and the time the remaining hashes need at that rate. */
  readonly hashBytesPerSecond: number | null;
  readonly estimatedRemainingMs: number | null;
}

export interface ConnectorIndexer {
  /** Starts a new pass over every registered root unless one is in progress. */
  beginScan(signal: AbortSignal): Promise<void>;
  /** Lists up to maxDirectories directories from the checkpoint; finishes the pass when none remain. */
  scanStep(signal: AbortSignal, maxDirectories: number): Promise<{ readonly complete: boolean }>;
  /** Hashes present, unhashed, non-excluded files within the budget, skipping files that change while read. */
  hashStep(signal: AbortSignal, budget: { readonly maxBytes: number; readonly maxFiles: number }): Promise<{ readonly files: number; readonly bytes: number }>;
  /** Sends changed identity/availability to NIHO and records photoIds and exclusions. */
  report(client: Pick<HostConnectorClient, "request">, signal: AbortSignal): Promise<{ readonly sent: number }>;
  progress(): Promise<IndexProgress>;
}

const sameFile = (
  entry: Pick<LocalIndexEntry, "sizeBytes" | "fileId" | "changeToken">,
  other: { readonly sizeBytes: number; readonly fileId: string; readonly changeToken: string },
): boolean => entry.sizeBytes === other.sizeBytes && entry.fileId === other.fileId && entry.changeToken === other.changeToken;

export function availabilityOf(entry: LocalIndexEntry): SourceAvailability {
  if (entry.hold === "sourceMismatch") return "sourceMismatch";
  return entry.state === "present" ? "available" : entry.state === "unmounted" ? "volumeUnmounted" : "missing";
}

export function createIndexer(options: {
  readonly fs: RootFileSystem;
  readonly roots: readonly RegisteredRoot[];
  readonly store: LocalIndexStore;
  readonly hasher: StreamHasher;
  readonly installSalt: () => Promise<string>;
  readonly clock: Clock;
}): ConnectorIndexer {
  const { fs, store, clock } = options;
  const roots = new Map(options.roots.map((root) => [root.id, root]));
  let hashRate: number | null = null;

  const rootOf = (rootId: string): RegisteredRoot | null => roots.get(rootId) ?? null;

  const finishScan = async (scan: number, unmounted: readonly string[], skipped: readonly { rootId: string; dir: string }[]): Promise<void> => {
    const updates: LocalIndexEntry[] = [];
    const underSkipped = (entry: LocalIndexEntry): boolean =>
      skipped.some((item) => item.rootId === entry.rootId && (item.dir === "" || entry.relativePath.startsWith(`${item.dir}/`)));
    for await (const entry of store.entries()) {
      if (entry.excluded) continue;
      if (unmounted.includes(entry.rootId) || !roots.has(entry.rootId)) {
        if (entry.state !== "unmounted") updates.push({ ...entry, state: "unmounted", dirty: true });
      } else if (entry.seenInScan !== scan && entry.state !== "missing" && !underSkipped(entry)) {
        // Gone from a mounted volume: reported missing, never deleted here or in NIHO.
        updates.push({ ...entry, state: "missing", dirty: true });
      }
    }
    if (updates.length) await store.put(updates);
  };

  return {
    async beginScan(signal) {
      const current = await store.checkpoint();
      if (current && current.pending.length) return;
      const scan = (current?.scan ?? 0) + 1;
      const pending: { rootId: string; dir: string }[] = [];
      const unmountedRoots: string[] = [];
      for (const root of options.roots) {
        if ((await fs.rootStatus(root, signal)) === "available") pending.push({ rootId: root.id, dir: "" });
        else unmountedRoots.push(root.id);
      }
      await store.setCheckpoint({ scan, pending, unmountedRoots, skipped: [], startedAt: clock.now() });
      if (!pending.length) await finishScan(scan, unmountedRoots, []);
    },
    async scanStep(signal, maxDirectories) {
      const checkpoint = await store.checkpoint();
      if (!checkpoint || !checkpoint.pending.length) return { complete: true };
      const salt = await options.installSalt();
      const pending = [...checkpoint.pending];
      let unmountedRoots = [...checkpoint.unmountedRoots];
      const skipped = [...(checkpoint.skipped ?? [])];
      for (let processed = 0; processed < maxDirectories && pending.length; processed++) {
        if (signal.aborted) break;
        const next = pending[0] as { rootId: string; dir: string };
        const root = rootOf(next.rootId);
        if (!root || (await fs.rootStatus(root, signal)) !== "available") {
          // The volume went away mid-scan: skip it without marking anything missing.
          pending.shift();
          if (!unmountedRoots.includes(next.rootId)) unmountedRoots = [...unmountedRoots, next.rootId];
          await store.setCheckpoint({ ...checkpoint, pending, unmountedRoots, skipped });
          continue;
        }
        let listing;
        try {
          listing = await fs.list(root, next.dir, signal);
        } catch {
          // A directory that vanished or failed to list is skipped for this pass; nothing under it becomes missing.
          pending.shift();
          skipped.push(next);
          await store.setCheckpoint({ ...checkpoint, pending, unmountedRoots, skipped });
          continue;
        }
        const updates: LocalIndexEntry[] = [];
        const subdirectories: { rootId: string; dir: string }[] = [];
        for (const item of listing) {
          if (isHiddenName(item.name)) continue;
          const relativePath = next.dir ? `${next.dir}/${item.name}` : item.name;
          if (item.kind === "directory") {
            if (shouldDescend(item.name)) subdirectories.push({ rootId: root.id, dir: relativePath });
            continue;
          }
          // Symlinks and special files are never followed or registered.
          if (item.kind !== "file" || !formatOf(item.name)) continue;
          const localKey = await localKeyFor(salt, root.id, relativePath);
          const existing = await store.get(localKey);
          if (existing?.excluded) {
            updates.push({ ...existing, seenInScan: checkpoint.scan });
          } else if (existing && sameFile(existing, item)) {
            updates.push({ ...existing, seenInScan: checkpoint.scan, ...(existing.state !== "present" ? { state: "present" as const, dirty: true } : {}) });
          } else {
            // New, changed or replaced bytes: identity unknown until hashed; NIHO keeps the last known one meanwhile.
            updates.push({
              localKey, rootId: root.id, relativePath, fileName: item.name, sizeBytes: item.sizeBytes, mtimeMs: item.mtimeMs,
              fileId: item.fileId, changeToken: item.changeToken, sha256: null, photoId: existing?.photoId ?? null, excluded: false, state: "present",
              seenInScan: checkpoint.scan, dirty: true, hold: existing?.hold ?? null, verifyAgainst: existing?.verifyAgainst ?? null,
            });
          }
        }
        if (updates.length) await store.put(updates);
        pending.shift();
        pending.push(...subdirectories);
        await store.setCheckpoint({ ...checkpoint, pending, unmountedRoots, skipped });
      }
      if (pending.length) return { complete: false };
      await finishScan(checkpoint.scan, unmountedRoots, skipped);
      return { complete: true };
    },
    async hashStep(signal, budget) {
      let files = 0;
      let bytes = 0;
      const started = clock.now();
      for await (const entry of store.entries()) {
        if (files >= budget.maxFiles || bytes >= budget.maxBytes || signal.aborted) break;
        if (entry.excluded || entry.hold || entry.state !== "present" || entry.sha256 !== null) continue;
        const root = rootOf(entry.rootId);
        if (!root) continue;
        let opened;
        try {
          opened = await fs.open(root, entry.relativePath, signal);
        } catch {
          continue;
        }
        try {
          if (!sameFile(entry, opened)) continue;
          const result = await options.hasher.hash(opened.read(signal), signal);
          const after = await fs.stat(root, entry.relativePath, signal);
          // Bytes that changed while they were read are hashed again on a later step.
          if (!after || !sameFile(entry, after) || result.bytes !== entry.sizeBytes) continue;
          // After an index rebuild, returning bytes must match NIHO's record or they are held, never relinked.
          if (entry.verifyAgainst !== null && result.sha256 !== entry.verifyAgainst) {
            await store.put([{ ...entry, hold: "sourceMismatch", verifyAgainst: null, dirty: true }]);
            continue;
          }
          await store.put([{ ...entry, sha256: result.sha256, verifyAgainst: null, dirty: true }]);
          files++;
          bytes += result.bytes;
        } finally {
          await opened.close();
        }
      }
      const elapsed = clock.now() - started;
      if (bytes > 0 && elapsed > 0) {
        const rate = (bytes / elapsed) * 1000;
        hashRate = hashRate === null ? rate : hashRate * 0.7 + rate * 0.3;
      }
      return { files, bytes };
    },
    async report(client, signal) {
      let sent = 0;
      for (;;) {
        const batch: LocalIndexEntry[] = [];
        for await (const entry of store.entries()) {
          if (entry.dirty && !entry.excluded) batch.push(entry);
          if (batch.length >= INDEX_BATCH) break;
        }
        if (!batch.length) return { sent };
        const entries: IndexEntry[] = batch.map((entry) => ({
          localKey: entry.localKey,
          fileName: entry.fileName,
          // Generations are assigned by NIHO; the connector reports bytes, never a generation of its own.
          source: { generation: 0, sha256: entry.hold ? null : entry.sha256, sizeBytes: entry.sizeBytes, format: formatOf(entry.fileName) ?? "raw", width: null, height: null },
          capturedAt: null,
          availability: availabilityOf(entry),
        }));
        // The key is derived from the payload, so a lost response is replayed with the same key and body.
        const key = `index-${await sha256Text(canonical(entries))}`;
        const receipt = await client.request("connector.putIndex", { entries }, { signal, idempotencyKey: key });
        const results = new Map(receipt.value.results.map((result) => [result.localKey, result]));
        await store.put(batch.map((entry) => {
          const result = results.get(entry.localKey);
          if (!result) return entry;
          return { ...entry, photoId: result.photoId, excluded: result.state === "excluded", dirty: false };
        }));
        sent += batch.length;
        // An answer that leaves entries unresolved ends this report; they are retried on the next one.
        if (batch.some((entry) => !results.has(entry.localKey))) return { sent };
      }
    },
    async progress() {
      const checkpoint = await store.checkpoint();
      let photos = 0;
      let listed = 0;
      let hashed = 0;
      let pendingHashBytes = 0;
      let excluded = 0;
      let held = 0;
      for await (const entry of store.entries()) {
        if (entry.excluded) {
          excluded++;
          continue;
        }
        photos++;
        if (entry.photoId) listed++;
        if (entry.hold) held++;
        else if (entry.sha256) hashed++;
        else if (entry.state === "present") pendingHashBytes += entry.sizeBytes;
      }
      return {
        scan: checkpoint?.scan ?? 0,
        scanning: Boolean(checkpoint?.pending.length),
        pendingDirectories: checkpoint?.pending.length ?? 0,
        photos, listed, hashed, pendingHashBytes,
        unmountedRoots: checkpoint?.unmountedRoots ?? [],
        excluded, held,
        hashBytesPerSecond: hashRate,
        estimatedRemainingMs: hashRate ? Math.ceil((pendingHashBytes / hashRate) * 1000) : null,
      };
    },
  };
}
