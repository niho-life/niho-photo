/**
 * Rebuilds the Mac's local index after it was lost, from the NIHO replica and the originals (B01 #242).
 * A photo is relinked only when the bytes at its registered key match the recorded size and SHA-256. Anything
 * else is reported, never guessed: no new generations, no automatic relinking, no deletions.
 */
import type { IndexEntry, ReplicaPhotoRecord, SourceAvailability } from "../../photo-library-sharing-contract/src/v1.ts";
import type { ReplicaRecord, ReplicaStore } from "./replica.ts";
import { HostedLibraryError, assertNotAborted, sha256Hex } from "./shared.ts";

/** Read-only access to the registered roots (B03). Keys are the connector's opaque localKeys. */
export interface SourceScanner {
  stat(
    localKey: string,
    signal: AbortSignal,
  ): Promise<{ readonly state: "present"; readonly sizeBytes: number } | { readonly state: "missing" } | { readonly state: "unmounted" }>;
  sha256(localKey: string, signal: AbortSignal): Promise<string>;
}

export type IndexRecoveryState = "relinked" | "sourceMismatch" | "sourceUnavailable" | "excluded";
export type IndexRecoveryReason = "size" | "hash" | "unverifiable" | "missing" | "unmounted" | "unreadable";
export interface IndexRecoveryEntry {
  readonly photoId: string;
  readonly localKey: string;
  readonly state: IndexRecoveryState;
  readonly reason: IndexRecoveryReason | null;
  /** The canonical source generation; recovery never invents a new one. */
  readonly sourceGeneration: number;
  readonly recipeRevision: number | null;
  readonly recipeSourceGeneration: number | null;
  /** Mask surfaces the recipe references whose verified bytes are not in the replica. */
  readonly missingMasks: readonly string[];
}
export interface IndexRecoveryReport {
  readonly replicaRevision: number;
  readonly entries: readonly IndexRecoveryEntry[];
  readonly recipes: number;
  readonly albums: number;
  readonly masks: { readonly verified: number; readonly missing: number };
  /** Availability to report through connector.putIndex, with the canonical identity unchanged. */
  readonly indexEntries: readonly IndexEntry[];
}

const availabilityFor = (state: IndexRecoveryState, reason: IndexRecoveryReason | null): SourceAvailability =>
  state === "relinked" ? "available"
    : state === "sourceMismatch" ? "sourceMismatch"
      : reason === "unmounted" ? "volumeUnmounted"
        : "missing";

async function checkSource(
  record: ReplicaPhotoRecord,
  scanner: SourceScanner,
  signal: AbortSignal,
): Promise<{ readonly state: IndexRecoveryState; readonly reason: IndexRecoveryReason | null }> {
  try {
    const stat = await scanner.stat(record.localKey, signal);
    if (stat.state === "unmounted") return { state: "sourceUnavailable", reason: "unmounted" };
    if (stat.state === "missing") return { state: "sourceUnavailable", reason: "missing" };
    if (stat.sizeBytes !== record.source.sizeBytes) return { state: "sourceMismatch", reason: "size" };
    // Without a recorded hash nothing proves these are the same bytes.
    if (record.source.sha256 === null) return { state: "sourceMismatch", reason: "unverifiable" };
    const hash = await scanner.sha256(record.localKey, signal);
    return hash === record.source.sha256 ? { state: "relinked", reason: null } : { state: "sourceMismatch", reason: "hash" };
  } catch (error) {
    if (signal.aborted || (error instanceof HostedLibraryError && error.code === "aborted")) throw new HostedLibraryError("aborted");
    // An unreadable original is unavailable, never deleted or relinked.
    return { state: "sourceUnavailable", reason: "unreadable" };
  }
}

export async function recoverLocalIndex(input: {
  readonly store: ReplicaStore;
  readonly scanner: SourceScanner;
  readonly signal: AbortSignal;
}): Promise<IndexRecoveryReport> {
  const { store, scanner, signal } = input;
  const replicaRevision = await store.revision();
  if (replicaRevision === 0) throw new HostedLibraryError("incomplete_replica");

  const verifiedMasks = new Set<string>();
  let missingMaskCount = 0;
  const masksByPhoto = new Map<string, Map<string, ReplicaRecord<"mask">>>();
  for await (const mask of store.records("mask")) {
    assertNotAborted(signal);
    const bytes = await store.maskBytes(mask.id);
    const ok = bytes !== null && bytes.byteLength === mask.body.sizeBytes && (await sha256Hex(bytes)) === mask.body.surfaceId;
    if (ok) verifiedMasks.add(mask.id);
    else missingMaskCount++;
    const byPhoto = masksByPhoto.get(mask.body.photoId) ?? new Map<string, ReplicaRecord<"mask">>();
    byPhoto.set(mask.body.surfaceId, mask);
    masksByPhoto.set(mask.body.photoId, byPhoto);
  }

  const entries: IndexRecoveryEntry[] = [];
  const indexEntries: IndexEntry[] = [];
  let recipes = 0;
  for await (const photo of store.records("photo")) {
    assertNotAborted(signal);
    const record = photo.body;
    const recipe = await store.get("recipe", photo.id);
    if (recipe) recipes++;
    const missingMasks = (recipe?.body.recipe.maskSurfaceIds ?? []).filter((surfaceId) => {
      const mask = masksByPhoto.get(photo.id)?.get(surfaceId);
      return !mask || !verifiedMasks.has(mask.id);
    });
    const excluded = (await store.get("exclusion", photo.id)) !== null;
    // Excluded photos stay excluded: their originals are not touched or relinked.
    const checked = excluded ? { state: "excluded" as const, reason: null } : await checkSource(record, scanner, signal);
    entries.push({
      photoId: photo.id,
      localKey: record.localKey,
      state: checked.state,
      reason: checked.reason,
      sourceGeneration: record.source.generation,
      recipeRevision: recipe?.body.recipe.revision ?? null,
      recipeSourceGeneration: recipe?.body.recipeSourceGeneration ?? null,
      missingMasks,
    });
    if (!excluded) {
      indexEntries.push({
        localKey: record.localKey,
        fileName: record.fileName,
        source: record.source,
        capturedAt: record.capturedAt,
        availability: availabilityFor(checked.state, checked.reason),
      });
    }
  }
  let albums = 0;
  for await (const album of store.records("albumDefinition")) {
    void album;
    albums++;
  }
  return {
    replicaRevision,
    entries,
    recipes,
    albums,
    masks: { verified: verifiedMasks.size, missing: missingMaskCount },
    indexEntries,
  };
}
