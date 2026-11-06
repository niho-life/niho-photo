/**
 * Synthetic in-memory render-job queue for development and tests of the source-device executor (B07 #248). Not the
 * server: the real queue, credentials, re-decode at commit and storage live behind the existing private boundary.
 * Commits are decided by the contract's reference policy (`decideRenderCommit`) using metadata decoded from the
 * uploaded bytes, so stale, removed or metadata-carrying outputs are refused the same way the server must refuse them.
 *
 * Server-side behaviour it models: claim order (photos being viewed, then new additions, then the backlog), leases,
 * superseding older jobs when a recipe is saved, cancelling jobs and releasing reservations when an item or album is
 * removed, holding jobs while the album owner's storage is full and resuming them when it frees, and lost answers.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  canonical,
  compareIdempotency,
  compareRenderBinding,
  decideRenderCommit,
  type AlbumItemState,
  type RecipeDocument,
  type RenderBinding,
  type RenderExecutor,
  type RenderExecutorOperation,
  type RenderExecutorOperationMap,
  type RenderFailureCode,
  type RenderJob,
  type RenderJobPurpose,
  type SharingErrorCode,
  type SharingErrorEnvelope,
} from "./contract";
import { jpegMetadataRecord } from "./jpeg-metadata";
import type { PhotoRef, RenderExecutorTransport } from "./render-executor";
import type { RenderOutputUploader } from "./ticket-upload";

export interface CreateRenderJobMockServerOptions {
  readonly executor: RenderExecutor;
  readonly now: () => number;
  readonly leaseSeconds?: number;
  /** The album owner's shared storage for renditions (default unlimited). */
  readonly quotaBytes?: number;
}

export interface RenderJobMockItem {
  readonly state: AlbumItemState;
  readonly revision: number;
  readonly desired: RenderBinding;
  readonly published: RenderBinding | null;
  readonly pendingReason: "rendering" | "quotaExceeded" | null;
  readonly bytes: Uint8Array | null;
}

export interface RenderJobMockServer {
  readonly transport: RenderExecutorTransport;
  /** Accepts this mock's tickets only. */
  readonly uploader: RenderOutputUploader;
  addAlbumItem(input: { albumId: string; itemId: string; photo: PhotoRef; binding: RenderBinding; recipe: RecipeDocument; isNew?: boolean }): string;
  requestPreview(photo: PhotoRef, binding: RenderBinding, recipe: RecipeDocument): string;
  /** Items people are looking at: their jobs are claimed first. */
  markVisible(itemIds: readonly string[]): void;
  /** A newer recipe was saved: older jobs for the photo are superseded and new ones queued. */
  saveRecipe(photo: PhotoRef, binding: RenderBinding, recipe: RecipeDocument): void;
  removeItem(albumId: string, itemId: string): void;
  removeAlbum(albumId: string): void;
  setQuotaBytes(bytes: number): void;
  item(albumId: string, itemId: string): RenderJobMockItem;
  preview(photo: PhotoRef): { readonly published: RenderBinding | null; readonly bytes: Uint8Array | null };
  jobs(): readonly { readonly id: string; readonly state: RenderJob["state"]; readonly purpose: RenderJobPurpose; readonly failure: RenderFailureCode | null }[];
  /** Storage reserved for outputs that are neither committed nor released. */
  reservedBytes(): number;
  /** Item IDs in the order their renditions were committed. */
  readonly commitOrder: readonly string[];
  /** The next call of this operation is applied but its answer is lost. */
  loseNextResponse(operation: Exclude<RenderExecutorOperation, "renderJobs.claim">): void;
  /** Counts of calls by operation (for tests). */
  calls(operation: RenderExecutorOperation): number;
}

type JobRecord = {
  job: RenderJob;
  leaseToken: string | null;
  tier: number;
  readonly seq: number;
  blockedForQuota: boolean;
};
type ItemRecord = {
  readonly albumId: string;
  readonly itemId: string;
  readonly photo: PhotoRef;
  state: AlbumItemState;
  revision: number;
  desired: RenderBinding;
  published: RenderBinding | null;
  pendingReason: "rendering" | "quotaExceeded" | null;
  bytes: Uint8Array | null;
};
type UploadRecord = {
  readonly id: string;
  readonly jobId: string;
  readonly kind: "rendition" | "preview";
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly expiresAtMs: number;
  state: "reserved" | "uploaded" | "expired" | "rejected" | "released";
  bytes: Uint8Array | null;
  readonly reservedBytes: number;
};

const TICKET_PREFIX = "https://storage.googleapis.com/synthetic-render-uploads/";

export function createRenderJobMockServer(options: CreateRenderJobMockServerOptions): RenderJobMockServer {
  const leaseMs = (options.leaseSeconds ?? 600) * 1000;
  let quotaBytes = options.quotaBytes ?? Number.POSITIVE_INFINITY;
  let usedBytes = 0;
  let sequence = 0;
  const jobs = new Map<string, JobRecord>();
  const items = new Map<string, ItemRecord>();
  const previews = new Map<string, { desired: RenderBinding; published: RenderBinding | null; bytes: Uint8Array | null }>();
  const uploads = new Map<string, UploadRecord>();
  const stored = new Map<string, { readonly record: Parameters<typeof compareIdempotency>[1]; readonly response: unknown }>();
  const lose = new Set<string>();
  const callCounts = new Map<string, number>();
  const commitOrder: string[] = [];
  const visible = new Set<string>();

  const instant = (ms = options.now()): string => new Date(ms).toISOString();
  const nextId = (prefix: string): string => `synthetic-${prefix}-${++sequence}`;
  const itemKey = (albumId: string, itemId: string): string => `${albumId}\u001f${itemId}`;
  const photoKey = (photo: PhotoRef): string => `${photo.libraryId}\u001f${photo.photoId}`;
  const fail = (code: SharingErrorCode): never => {
    throw { error: { code, requestId: nextId("request"), retryable: false } } satisfies SharingErrorEnvelope;
  };
  const releaseFor = (jobId: string): void => {
    for (const upload of uploads.values()) if (upload.jobId === jobId && (upload.state === "reserved" || upload.state === "uploaded")) upload.state = "released";
  };
  const endJobs = (match: (record: JobRecord) => boolean, state: "superseded" | "cancelled"): void => {
    for (const record of jobs.values()) {
      if ((record.job.state === "queued" || record.job.state === "claimed" || record.job.state === "waitingForHost") && match(record)) {
        record.job = { ...record.job, state, leaseExpiresAt: null };
        record.leaseToken = null;
        releaseFor(record.job.id);
      }
    }
  };
  const enqueue = (purpose: RenderJobPurpose, photo: PhotoRef, binding: RenderBinding, recipe: RecipeDocument, tier: number): string => {
    const id = nextId("job");
    jobs.set(id, {
      job: {
        id, purpose, executor: options.executor, photo, binding, recipe, state: "queued", attempt: 0, createdAt: instant(), leaseExpiresAt: null,
        failure: null,
      },
      leaseToken: null, tier, seq: sequence, blockedForQuota: false,
    });
    return id;
  };
  const claimedRecord = (jobId: string, leaseToken: string): JobRecord => {
    const record = jobs.get(jobId);
    if (!record || record.leaseToken !== leaseToken) return fail("not_found");
    if (record.job.state !== "claimed") return fail("stale_render");
    if (options.now() >= Date.parse(record.job.leaseExpiresAt as string)) return fail("lease_expired");
    return record;
  };

  function execute<K extends RenderExecutorOperation>(operation: K, request: RenderExecutorOperationMap[K]["request"]): unknown {
    switch (operation) {
      case "renderJobs.claim": {
        const { maxJobs = 1 } = request as RenderExecutorOperationMap["renderJobs.claim"]["request"];
        // Expired leases go back to the queue for another attempt; their output reservations are released.
        for (const record of jobs.values()) {
          if (record.job.state === "claimed" && options.now() >= Date.parse(record.job.leaseExpiresAt as string)) {
            record.job = { ...record.job, state: "queued", leaseExpiresAt: null };
            record.leaseToken = null;
            releaseFor(record.job.id);
          }
        }
        const candidates = [...jobs.values()]
          .filter((record) => record.job.state === "queued" && !record.blockedForQuota && canonical(record.job.executor) === canonical(options.executor))
          .sort((a, b) => a.tier - b.tier || a.seq - b.seq)
          .slice(0, maxJobs);
        return {
          jobs: candidates.map((record) => {
            record.leaseToken = nextId("lease");
            record.job = { ...record.job, state: "claimed", attempt: record.job.attempt + 1, leaseExpiresAt: instant(options.now() + leaseMs) };
            return { job: record.job, lease: { jobId: record.job.id, leaseToken: record.leaseToken, expiresAt: record.job.leaseExpiresAt as string } };
          }),
        };
      }
      case "renderJobs.startOutput": {
        const { jobId, leaseToken, output } = request as RenderExecutorOperationMap["renderJobs.startOutput"]["request"];
        const record = claimedRecord(jobId, leaseToken);
        const expected = record.job.purpose.kind === "preview" ? "preview" : "rendition";
        if (output.kind !== expected) return fail("invalid_request");
        let reserve = 0;
        if (record.job.purpose.kind === "albumItem") {
          const item = items.get(itemKey(record.job.purpose.albumId, record.job.purpose.itemId));
          if (!item || item.state === "removed") return fail("item_removed");
          reserve = output.sizeBytes;
          if (usedBytes + reservedBytes() + reserve > quotaBytes) {
            // Not a failure: the job waits (準備中（容量不足）) and comes back when capacity frees.
            item.pendingReason = "quotaExceeded";
            record.blockedForQuota = true;
            record.job = { ...record.job, state: "queued", leaseExpiresAt: null };
            record.leaseToken = null;
            return fail("quota_exceeded");
          }
        }
        const upload: UploadRecord = {
          id: nextId("upload"), jobId, kind: output.kind, sizeBytes: output.sizeBytes, sha256: output.sha256,
          expiresAtMs: options.now() + 60 * 60 * 1000, state: "reserved", bytes: null, reservedBytes: reserve,
        };
        uploads.set(upload.id, upload);
        return {
          value: {
            uploadId: upload.id, expiresAt: instant(upload.expiresAtMs),
            ticket: { url: `${TICKET_PREFIX}${upload.id}`, method: "PUT", headers: { "Content-Type": output.contentType }, expiresAt: instant(upload.expiresAtMs), resumeOffsetBytes: 0 },
          },
          replayed: false,
        };
      }
      case "renderJobs.commit": {
        const { jobId, leaseToken, uploadId } = request as RenderExecutorOperationMap["renderJobs.commit"]["request"];
        const record = jobs.get(jobId);
        if (!record || record.leaseToken !== leaseToken) return fail("not_found");
        const upload = uploads.get(uploadId);
        const purpose = record.job.purpose;
        const item = purpose.kind === "albumItem" ? items.get(itemKey(purpose.albumId, purpose.itemId)) : undefined;
        const preview = purpose.kind === "preview" ? previews.get(photoKey(record.job.photo)) : undefined;
        const decision = decideRenderCommit({
          job: record.job,
          actor: options.executor,
          claimedGeneration: 1,
          executor: { lifecycle: "active", credentialGeneration: 1 },
          upload: upload && upload.state !== "released"
            ? { jobId: upload.jobId, kind: upload.kind, state: options.now() >= upload.expiresAtMs ? "expired" : upload.state === "uploaded" ? "uploaded" : upload.state === "rejected" ? "rejected" : "reserved" }
            : null,
          bytesMetadata: upload?.bytes ? jpegMetadataRecord(upload.bytes) : {},
          desired: purpose.kind === "albumItem" ? (item && item.state !== "removed" ? item.desired : null) : purpose.kind === "preview" ? preview?.desired ?? null : record.job.binding,
          ...(purpose.kind === "albumItem"
            ? {
                item: {
                  state: item ? item.state : null, revision: item?.revision ?? 0,
                  adder: { userId: "synthetic-adder", membership: { role: "contributor", state: "active", revision: 1 } },
                },
              }
            : {}),
          now: instant(),
        });
        if (!decision.ok) return fail(decision.code);
        const accepted = upload as UploadRecord;
        record.job = { ...record.job, state: "committed", leaseExpiresAt: null };
        record.leaseToken = null;
        // Every other output reserved for this job (e.g. one whose ticket was lost) is released with the commit.
        releaseFor(jobId);
        accepted.state = "released";
        if (item) {
          usedBytes += accepted.sizeBytes;
          item.published = record.job.binding;
          item.revision += 1;
          item.state = "published";
          item.pendingReason = null;
          item.bytes = accepted.bytes;
          commitOrder.push(item.itemId);
        }
        if (preview) {
          preview.published = record.job.binding;
          preview.bytes = accepted.bytes;
        }
        return { value: record.job, replayed: false };
      }
      case "renderJobs.fail": {
        const { jobId, leaseToken, code } = request as RenderExecutorOperationMap["renderJobs.fail"]["request"];
        const record = claimedRecord(jobId, leaseToken);
        record.job = { ...record.job, state: "failed", failure: code, leaseExpiresAt: null };
        record.leaseToken = null;
        releaseFor(jobId);
        return { value: record.job, replayed: false };
      }
    }
    return fail("invalid_request");
  }

  const transport: RenderExecutorTransport = {
    async request(operation, request, requestOptions) {
      callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
      if (requestOptions.signal.aborted) throw requestOptions.signal.reason instanceof Error ? requestOptions.signal.reason : new DOMException("Aborted", "AbortError");
      const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
      if (operation === "renderJobs.claim") return structuredClone(execute(operation, request)) as never;
      if (typeof key !== "string" || key.length === 0) return fail("invalid_request");
      const record = {
        actor: { kind: "user", userId: "synthetic-device" }, scope: { kind: "account" }, operation, key, payloadSha256: bytesToHex(sha256(new TextEncoder().encode(canonical(request)))),
      } as Parameters<typeof compareIdempotency>[1];
      const identity = canonical({ operation, key });
      const previous = stored.get(identity) ?? null;
      const comparison = compareIdempotency(previous?.record ?? null, record);
      if (comparison === "conflict") return fail("idempotency_conflict");
      let response: unknown;
      if (comparison === "replay" && previous) {
        const value = (previous.response as { value: Record<string, unknown> }).value;
        // A replayed start carries no bearer ticket.
        response = { value: operation === "renderJobs.startOutput" ? { ...value, ticket: null } : value, replayed: true };
      } else {
        response = execute(operation, request);
        stored.set(identity, { record, response });
      }
      if (lose.delete(operation)) throw new TypeError("Failed to fetch");
      return structuredClone(response) as never;
    },
  };

  const uploader: RenderOutputUploader = {
    async upload(ticket, bytes, contentType, signal) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      const upload = ticket.url.startsWith(TICKET_PREFIX) ? uploads.get(ticket.url.slice(TICKET_PREFIX.length)) : undefined;
      if (!upload || upload.state !== "reserved" || contentType !== "image/jpeg" && upload.kind === "rendition") throw new TypeError("synthetic upload refused");
      if (bytes.byteLength !== upload.sizeBytes || bytesToHex(sha256(bytes)) !== upload.sha256) {
        upload.state = "rejected";
        throw new TypeError("synthetic upload hash mismatch");
      }
      upload.bytes = bytes.slice();
      upload.state = "uploaded";
    },
  };

  function reservedBytes(): number {
    let total = 0;
    // An expired ticket no longer holds storage.
    for (const upload of uploads.values()) {
      if ((upload.state === "reserved" || upload.state === "uploaded") && options.now() < upload.expiresAtMs) total += upload.reservedBytes;
    }
    return total;
  }

  return {
    transport,
    uploader,
    addAlbumItem({ albumId, itemId, photo, binding, recipe, isNew = false }) {
      items.set(itemKey(albumId, itemId), {
        albumId, itemId, photo, state: "preparing", revision: 0, desired: binding, published: null, pendingReason: "rendering", bytes: null,
      });
      return enqueue({ kind: "albumItem", albumId, itemId, itemRevision: 0 }, photo, binding, recipe, visible.has(itemId) ? 0 : isNew ? 1 : 2);
    },
    requestPreview(photo, binding, recipe) {
      previews.set(photoKey(photo), { desired: binding, published: previews.get(photoKey(photo))?.published ?? null, bytes: null });
      return enqueue({ kind: "preview" }, photo, binding, recipe, 1);
    },
    markVisible(itemIds) {
      for (const id of itemIds) visible.add(id);
      for (const record of jobs.values()) {
        if (record.job.purpose.kind === "albumItem" && visible.has(record.job.purpose.itemId)) record.tier = 0;
      }
    },
    saveRecipe(photo, binding, recipe) {
      const key = photoKey(photo);
      for (const item of items.values()) {
        if (photoKey(item.photo) !== key || item.state === "removed" || compareRenderBinding(binding, item.desired) !== "newer") continue;
        item.desired = binding;
        if (item.state === "published") item.state = "updatePending";
        item.pendingReason = "rendering";
        endJobs((record) => record.job.purpose.kind === "albumItem" && record.job.purpose.itemId === item.itemId && record.job.purpose.albumId === item.albumId, "superseded");
        enqueue({ kind: "albumItem", albumId: item.albumId, itemId: item.itemId, itemRevision: item.revision }, photo, binding, recipe, visible.has(item.itemId) ? 0 : 1);
      }
      const preview = previews.get(key);
      if (preview && compareRenderBinding(binding, preview.desired) === "newer") {
        preview.desired = binding;
        endJobs((record) => record.job.purpose.kind === "preview" && photoKey(record.job.photo) === key, "superseded");
        enqueue({ kind: "preview" }, photo, binding, recipe, 1);
      }
    },
    removeItem(albumId, itemId) {
      const item = items.get(itemKey(albumId, itemId));
      if (item) item.state = "removed";
      endJobs((record) => record.job.purpose.kind === "albumItem" && record.job.purpose.albumId === albumId && record.job.purpose.itemId === itemId, "cancelled");
    },
    removeAlbum(albumId) {
      for (const item of items.values()) if (item.albumId === albumId) item.state = "removed";
      endJobs((record) => record.job.purpose.kind === "albumItem" && record.job.purpose.albumId === albumId, "cancelled");
    },
    setQuotaBytes(bytes) {
      quotaBytes = bytes;
      for (const record of jobs.values()) {
        if (!record.blockedForQuota) continue;
        record.blockedForQuota = false;
        if (record.job.purpose.kind === "albumItem") {
          const item = items.get(itemKey(record.job.purpose.albumId, record.job.purpose.itemId));
          if (item && item.pendingReason === "quotaExceeded") item.pendingReason = "rendering";
        }
      }
    },
    item(albumId, itemId) {
      const item = items.get(itemKey(albumId, itemId));
      if (!item) throw new Error("unknown synthetic item");
      return { state: item.state, revision: item.revision, desired: item.desired, published: item.published, pendingReason: item.pendingReason, bytes: item.bytes };
    },
    preview(photo) {
      const preview = previews.get(photoKey(photo));
      return { published: preview?.published ?? null, bytes: preview?.bytes ?? null };
    },
    jobs: () => [...jobs.values()].map((record) => ({ id: record.job.id, state: record.job.state, purpose: record.job.purpose, failure: record.job.failure })),
    reservedBytes,
    commitOrder,
    loseNextResponse(operation) {
      lose.add(operation);
    },
    calls: (operation) => callCounts.get(operation) ?? 0,
  };
}
