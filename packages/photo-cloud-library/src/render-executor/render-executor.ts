/**
 * Render-job executor on the device that holds the original (B07 #248): the member's Mac app or browser for their own
 * photos, and (embedded by the connector, B03) the hosted Mac for the owner's library. It claims jobs, renders each
 * with the device's existing engine, uploads the output and commits it under the job's binding.
 *
 * - Bound inputs only: a job whose recipe/binding disagree, that needs another renderer, or whose original changed is
 *   reported (`renderJobs.fail`) and never rendered with different inputs.
 * - No stale overwrite: the server commits only the target's current binding (`decideRenderCommit`); a job superseded
 *   by a newer recipe, a removed item or an expired lease is discarded here without retrying.
 * - Order: at most `maxConcurrent` jobs per device. The server's claim order is kept (it ranks photos people are viewing
 *   and new additions); `prioritize` names this device's on-screen photos in each claim (`prefer`) so the server
 *   serves them first even from a large backlog, and starts the ones already claimed first.
 * - Local cancellation: `supersede` (a newer recipe saved on this device) and `cancelAlbumItem` (an item or album this
 *   device removed) abort work in flight and drop queued jobs; the server cancels and releases reservations itself.
 * - A full album owner's storage defers the job (`quota_exceeded`) without failing it; the server resumes it when
 *   capacity frees, so a later `drain` picks it up.
 * - Lost answers are replayed with the same idempotency key, claims included (the server returns the same jobs and
 *   leases). A replayed `startOutput` has no ticket; `renderJobs.renewOutput` gives a fresh one for the same upload.
 * - Full resolution is checked against NIHO's `expectedOutput` before any upload; a different size is reported.
 */
import { PersonalPhotoCloudError } from "../errors";

import {
  SHARING_ERROR_RECOVERY,
  SHARING_LIMITS,
  canonical,
  compareRenderBinding,
  type ClaimedRenderJob,
  type LibraryId,
  type PhotoId,
  type RenderBinding,
  type RenderExecutor,
  type RenderExecutorOperation,
  type RenderExecutorOperationMap,
  type RenderExecutorRequestOptions,
  type RenderFailureCode,
  type SharingErrorEnvelope,
} from "./contract";
import { SourceDeviceRenderFailure, renderFinishedOutput, type DeviceRenderer, type RenderSource } from "./render-output";
import type { RenderOutputUploader } from "./ticket-upload";

export type RenderExecutorTransport = {
  request<K extends RenderExecutorOperation>(
    operation: K,
    request: RenderExecutorOperationMap[K]["request"],
    options: RenderExecutorRequestOptions<K>,
  ): Promise<RenderExecutorOperationMap[K]["response"]>;
};

export interface PhotoRef {
  readonly libraryId: LibraryId;
  readonly photoId: PhotoId;
}

/** Opens the original a job is bound to. It checks the generation and hash; it never substitutes other bytes. */
export interface RenderSourcePort {
  open(
    photo: PhotoRef,
    expected: { readonly generation: number; readonly sha256: string },
    signal: AbortSignal,
  ): Promise<{ readonly kind: "ok"; readonly source: RenderSource } | { readonly kind: "missing" } | { readonly kind: "changed" }>;
  /** Mask surface bitmaps referenced by the recipe (hash IDs). */
  loadMaskSurface?(photo: PhotoRef, surfaceId: string, signal: AbortSignal): Promise<Uint8Array | null>;
}

export interface CreateSourceDeviceRenderExecutorOptions {
  readonly transport: RenderExecutorTransport;
  /** This device as the server assigns jobs to it; jobs for another executor are never run. */
  readonly executor: RenderExecutor;
  readonly renderer: DeviceRenderer;
  readonly sources: RenderSourcePort;
  readonly uploader: RenderOutputUploader;
  /** Jobs rendering at once on this device (default 1). */
  readonly maxConcurrent?: number;
  /** Jobs claimed per request (default 2 × maxConcurrent). Small windows keep leases short and order fresh. */
  readonly claimBatch?: number;
  readonly previewMaxEdge?: number;
  readonly now?: () => number;
  readonly newIdempotencyKey?: () => string;
  /** Attempts per protocol call when the answer was lost (default 3). */
  readonly maxAttempts?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onEvent?: (event: SourceDeviceRenderEvent) => void;
}

export type SourceDeviceRenderOutcome =
  | "committed"
  /** Reported to the server with this code; the server decides whether another device can do it. */
  | { readonly failed: RenderFailureCode }
  /** Superseded, removed, lease expired or no longer accepted: the result was dropped, nothing was overwritten. */
  | "discarded"
  /** The album owner's storage is full; the server keeps the job waiting and resumes it when capacity frees. */
  | "deferredForQuota"
  /** Cancelled on this device (newer recipe, removed item/album, dispose). */
  | "cancelled"
  /** The output could not be delivered (upload or protocol failure); the lease will expire and the server requeues it. */
  | "interrupted";

export interface SourceDeviceRenderEvent {
  readonly jobId: string;
  readonly photo: PhotoRef;
  readonly outcome: SourceDeviceRenderOutcome;
}

export interface SourceDeviceRenderSummary {
  readonly committed: number;
  readonly failed: number;
  readonly discarded: number;
  readonly deferredForQuota: number;
  readonly cancelled: number;
  readonly interrupted: number;
}

export interface SourceDeviceRenderExecutor {
  /** Claims and runs jobs until the server has none for this device; resolves with what happened. */
  drain(signal: AbortSignal): Promise<SourceDeviceRenderSummary>;
  /**
   * Photos on this device's screen: named in the next claims (`prefer`, at most `SHARING_LIMITS.claimPreferMaxPhotos`)
   * and started first among claimed jobs. Replaces the previous set.
   */
  prioritize(photos: readonly PhotoRef[]): void;
  /** A newer recipe was saved on this device: drop and abort work bound to an older one. */
  supersede(photo: PhotoRef, binding: RenderBinding): void;
  /** An item (or, without itemId, every item of the album) was removed on this device. */
  cancelAlbumItem(albumId: string, itemId?: string): void;
  dispose(): void;
}

type Entry = {
  readonly claimed: ClaimedRenderJob;
  readonly order: number;
  readonly abort: AbortController;
};

const DEFAULT_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;
const MAX_AUTOMATIC_RETRY_AFTER_SECONDS = 5;

export function createSourceDeviceRenderExecutor(options: CreateSourceDeviceRenderExecutorOptions): SourceDeviceRenderExecutor {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
  const claimBatch = Math.max(1, Math.floor(options.claimBatch ?? maxConcurrent * 2));
  const now = options.now ?? Date.now;
  const newKey = options.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_ATTEMPTS));
  const sleep = options.sleep ?? abortableSleep;
  const executorKey = canonical(options.executor);
  const queued: Entry[] = [];
  const running = new Map<string, Entry>();
  const carried: Entry[] = [];
  let prioritized = new Set<string>();
  let preferPhotoIds: readonly string[] = [];
  let order = 0;
  let disposed = false;

  const photoKey = (photo: PhotoRef): string => `${photo.libraryId}\u001f${photo.photoId}`;
  const emit = (claimed: ClaimedRenderJob, outcome: SourceDeviceRenderOutcome): SourceDeviceRenderOutcome => {
    options.onEvent?.({ jobId: claimed.job.id, photo: claimed.job.photo, outcome });
    return outcome;
  };

  /** Same request and key until the answer arrives, while the failure only means it was lost or delayed. */
  async function send<K extends RenderExecutorOperation>(
    operation: K,
    request: RenderExecutorOperationMap[K]["request"],
    signal: AbortSignal,
    key: string | null,
  ): Promise<RenderExecutorOperationMap[K]["response"]> {
    for (let attempt = 1; ; attempt += 1) {
      const requestOptions = (key === null ? { signal } : { signal, idempotencyKey: key }) as unknown as RenderExecutorRequestOptions<K>;
      try {
        return await options.transport.request(operation, request, requestOptions);
      } catch (error) {
        if (signal.aborted || attempt >= maxAttempts) throw error;
        const wait = replayDelay(error, attempt);
        if (wait === null) throw error;
        await sleep(wait, signal);
      }
    }
  }

  /** Reports a refusal. Counted as failed only when the server accepted the report. */
  async function report(claimed: ClaimedRenderJob, code: RenderFailureCode, signal: AbortSignal): Promise<SourceDeviceRenderOutcome> {
    try {
      await send("renderJobs.fail", { jobId: claimed.job.id, leaseToken: claimed.lease.leaseToken, code }, signal, newKey());
      return { failed: code };
    } catch (error) {
      if (signal.aborted) return "cancelled";
      // Superseded, removed or lease gone: the job is no longer this device's to report.
      if (isDiscardCode(errorCode(error))) return "discarded";
      // Not delivered: the lease expires, the server offers the job again and the refusal is reported then.
      return "interrupted";
    }
  }

  async function run(entry: Entry, drainSignal: AbortSignal): Promise<SourceDeviceRenderOutcome> {
    const { claimed } = entry;
    const { job, lease } = claimed;
    const link = new AbortController();
    const abort = (): void => link.abort();
    drainSignal.addEventListener("abort", abort, { once: true });
    entry.abort.signal.addEventListener("abort", abort, { once: true });
    if (drainSignal.aborted || entry.abort.signal.aborted) link.abort();
    const signal = link.signal;
    const leaseLeft = (): boolean => now() < Date.parse(lease.expiresAt);
    try {
      if (canonical(job.executor) !== executorKey) return "discarded";
      if (!leaseLeft()) return "discarded";
      const opened = await options.sources.open(job.photo, { generation: job.binding.sourceGeneration, sha256: job.binding.sourceSha256 }, signal);
      if (signal.aborted) return "cancelled";
      if (opened.kind === "missing") return await report(claimed, "source_missing", signal);
      if (opened.kind === "changed") return await report(claimed, "source_changed", signal);

      let output;
      try {
        output = await renderFinishedOutput({
          renderer: options.renderer,
          source: opened.source,
          recipe: job.recipe,
          binding: job.binding,
          kind: job.purpose.kind === "preview" ? "preview" : "rendition",
          ...(options.previewMaxEdge === undefined ? {} : { previewMaxEdge: options.previewMaxEdge }),
          loadMaskSurface: async (surfaceId) => (await options.sources.loadMaskSurface?.(job.photo, surfaceId, signal)) ?? null,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return "cancelled";
        // Engine errors without a contract code mean this device could not produce the output.
        return await report(claimed, error instanceof SourceDeviceRenderFailure ? error.code : "renderer_unavailable", signal);
      }
      if (signal.aborted) return "cancelled";
      if (!leaseLeft()) return "discarded";
      // NIHO computes the full-resolution size with the engine's rule; the commit rejects any other size, so a
      // mismatch is reported now instead of uploading bytes that can never be published.
      const expected = job.purpose.kind === "preview" ? null : job.expectedOutput;
      if (expected && (output.request.width !== expected.width || output.request.height !== expected.height)) {
        const smaller = output.request.width * output.request.height < expected.width * expected.height;
        return await report(claimed, smaller ? "full_resolution_unavailable" : "renderer_unavailable", signal);
      }

      const start = (await send("renderJobs.startOutput", { jobId: job.id, leaseToken: lease.leaseToken, output: output.request }, signal, newKey())).value;
      // The first answer (with the ticket) was lost and the replay carries none: a fresh ticket for the same upload and
      // reservation, rather than a second output.
      const ticket = start.ticket ?? (await send("renderJobs.renewOutput", { jobId: job.id, leaseToken: lease.leaseToken, uploadId: start.uploadId }, signal, null)).ticket;
      await options.uploader.upload(ticket, output.bytes, output.request.contentType, signal);
      if (signal.aborted) return "cancelled";
      if (!leaseLeft()) return "discarded";
      try {
        await send("renderJobs.commit", { jobId: job.id, leaseToken: lease.leaseToken, uploadId: start.uploadId }, signal, newKey());
      } catch (error) {
        // The server's re-decode refused what this renderer produced. The same inputs would give the same bytes, so the
        // job is reported as one this renderer cannot do instead of being rendered again on every claim.
        if (errorCode(error) === "content_rejected" && !signal.aborted) return await report(claimed, "renderer_unavailable", signal);
        throw error;
      }
      return "committed";
    } catch (error) {
      if (signal.aborted) return "cancelled";
      const code = errorCode(error);
      if (code === "quota_exceeded") return "deferredForQuota";
      if (isDiscardCode(code)) return "discarded";
      return "interrupted";
    } finally {
      drainSignal.removeEventListener("abort", abort);
      entry.abort.signal.removeEventListener("abort", abort);
    }
  }

  function next(): Entry | undefined {
    let index = queued.findIndex((entry) => prioritized.has(photoKey(entry.claimed.job.photo)));
    if (index < 0) index = queued.length > 0 ? 0 : -1;
    return index < 0 ? undefined : queued.splice(index, 1)[0];
  }

  function dropQueued(match: (entry: Entry) => boolean): void {
    for (const list of [queued, carried]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (match(list[index])) {
          const [entry] = list.splice(index, 1);
          entry.abort.abort();
          emit(entry.claimed, "cancelled");
        }
      }
    }
    for (const entry of running.values()) if (match(entry)) entry.abort.abort();
  }

  let active: Promise<SourceDeviceRenderSummary> | null = null;

  async function drainOnce(signal: AbortSignal): Promise<SourceDeviceRenderSummary> {
    const counts = { committed: 0, failed: 0, discarded: 0, deferredForQuota: 0, cancelled: 0, interrupted: 0 };
    const inFlight = new Map<string, Promise<void>>();
    // One attempt per job per drain: a job offered again (its lease ran out while this device rendered it) waits for
    // the next drain instead of being re-rendered in a loop by a device too slow for it.
    const attempted = new Set<string>();
    // Jobs carried over from the previous drain start first (their leases are checked before any work).
    queued.unshift(...carried.splice(0));
    let exhausted = false;
    const count = (outcome: SourceDeviceRenderOutcome): void => {
      if (typeof outcome === "object") counts.failed += 1;
      else counts[outcome] += 1;
    };
    while (!signal.aborted && !disposed) {
      while (running.size < maxConcurrent && !signal.aborted) {
        if (queued.length === 0 && !exhausted) {
          const capacity = Math.max(claimBatch, maxConcurrent - running.size);
          let claimed: readonly ClaimedRenderJob[];
          try {
            // Keyed: a lost answer is replayed and the server returns the same jobs and leases.
            const prefer = preferPhotoIds.length > 0 ? { prefer: { photoIds: [...preferPhotoIds] } } : {};
            claimed = (await send("renderJobs.claim", { maxJobs: capacity, ...prefer }, signal, newKey())).value.jobs;
          } catch (error) {
            if (signal.aborted) break;
            throw error;
          }
          const fresh = claimed.filter((item) => !attempted.has(item.job.id));
          // A job offered again in the same drain (its lease ran out while this device rendered it) is kept, with its
          // new lease, for the next drain rather than re-rendered in a loop or left idle until the lease expires.
          for (const item of claimed) if (attempted.has(item.job.id)) carried.push({ claimed: item, order: order++, abort: new AbortController() });
          if (fresh.length === 0) exhausted = true;
          for (const item of fresh) queued.push({ claimed: item, order: order++, abort: new AbortController() });
        }
        const entry = next();
        if (!entry) break;
        attempted.add(entry.claimed.job.id);
        running.set(entry.claimed.job.id, entry);
        inFlight.set(entry.claimed.job.id, run(entry, signal).then((outcome) => {
          running.delete(entry.claimed.job.id);
          inFlight.delete(entry.claimed.job.id);
          count(emit(entry.claimed, outcome));
          // Finishing a job may make new work claimable (a newer recipe, a freed slot); ask again.
          exhausted = false;
        }));
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight.values());
    }
    await Promise.allSettled(inFlight.values());
    return counts;
  }

  return {
    drain(signal) {
      if (disposed) return Promise.reject(new PersonalPhotoCloudError("disposed"));
      // One drain at a time per device: a second call joins the running one, so a job is never run twice and the
      // concurrency limit holds across callers.
      if (active) return active;
      active = drainOnce(signal).finally(() => {
        active = null;
      });
      return active;
    },
    prioritize(photos) {
      prioritized = new Set(photos.map(photoKey));
      preferPhotoIds = [...new Set(photos.map((photo) => photo.photoId))].slice(0, SHARING_LIMITS.claimPreferMaxPhotos);
    },
    supersede(photo, binding) {
      const key = photoKey(photo);
      dropQueued((entry) => photoKey(entry.claimed.job.photo) === key && compareRenderBinding(entry.claimed.job.binding, binding) === "older");
    },
    cancelAlbumItem(albumId, itemId) {
      dropQueued((entry) => {
        const purpose = entry.claimed.job.purpose;
        return purpose.kind === "albumItem" && purpose.albumId === albumId && (itemId === undefined || purpose.itemId === itemId);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dropQueued(() => true);
    },
  };
}

/** Answers meaning the job or its output is no longer accepted (stale, superseded, removed, lease gone): drop the result. */
function isDiscardCode(code: SharingErrorEnvelope["error"]["code"] | null): boolean {
  return code !== null && (SHARING_ERROR_RECOVERY[code] === "discardResult" || code === "item_removed" || code === "not_found");
}

function errorCode(error: unknown): SharingErrorEnvelope["error"]["code"] | null {
  if (typeof error !== "object" || error === null || !("error" in error)) return null;
  const code = (error as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" && Object.hasOwn(SHARING_ERROR_RECOVERY, code) ? (code as SharingErrorEnvelope["error"]["code"]) : null;
}

/** ms before replaying the same request, or null when the failure is an answer rather than a lost one. */
function replayDelay(error: unknown, attempt: number): number | null {
  const code = errorCode(error);
  if (code !== null) {
    const envelope = (error as SharingErrorEnvelope).error;
    if (!envelope.retryable || SHARING_ERROR_RECOVERY[code] !== "retrySameKey") return null;
    if (envelope.retryAfterSeconds !== undefined) {
      return envelope.retryAfterSeconds <= MAX_AUTOMATIC_RETRY_AFTER_SECONDS ? envelope.retryAfterSeconds * 1000 : null;
    }
    return RETRY_BASE_MS * attempt;
  }
  if (error instanceof PersonalPhotoCloudError) return error.code === "unavailable" ? RETRY_BASE_MS * attempt : null;
  if (error instanceof TypeError) return RETRY_BASE_MS * attempt;
  return null;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
