import { sha256 } from "@noble/hashes/sha2.js";
import { samePhotoIdentityScope } from "@niho/photo-cloud-session";
import {
  PHOTO_LIMITS,
  type PersonalPhotoCloudClient,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoAsset,
  type PhotoFormat,
  type RecipeCandidate,
  type RecipeDocument,
  type StartUploadResponse,
  type Upload,
  type UploadTicket,
  type VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "../errors";
import { abortReason, awaitBounded, cancelResponse, linkedAbortController } from "../await";
import type { PersonalPhotoCloudIdentity } from "../types";
import { GCS_CHUNK_BYTES, TRANSPORT_TIMEOUT_MS, TRUSTED_GCS_UPLOAD_ORIGIN, canonicalContentType, validateTicket } from "../wire";
import { validateAsset } from "../validation";
import {
  IndexedDbTransferJournal,
  makeEntryId,
  validateCandidate,
  type JournalScope,
  type TransferJournalListOptions,
  type TransferJournalEntry,
  type TransferPhase,
} from "./journal";

const HASH_SLICE_BYTES = 1024 ** 2;
const MAX_PROVIDER_ATTEMPTS_WITHOUT_PROGRESS = 3;
const MAX_UPLOAD_STEPS = 64;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 120_000;
const LOCK_WAIT_TIMEOUT_MS = 120_000;
const LOCK_OPERATION_TIMEOUT_MS = 600_000;
const ACCEPTED_EXTENSIONS: Readonly<Record<PhotoFormat, readonly string[]>> = Object.freeze({
  jpeg: ["jpg", "jpeg"], png: ["png"], heic: ["heic"], heif: ["heif"], tiff: ["tif", "tiff"],
  raw: ["rw2", "dng", "arw", "nef", "cr2", "cr3", "raf", "orf", "pef"],
});

export interface PersonalPhotoTransferStatus {
  readonly intentId: string;
  readonly phase: TransferPhase | "needs-file";
  readonly fileName: string;
  readonly format: PhotoFormat;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly uploadedBytes: number;
  readonly photoId: string | null;
  readonly hasPendingRecipe: boolean;
  readonly failure: "not-found" | "stored" | "invalid-response" | null;
}

export interface PendingPersonalPhotoRecipe {
  readonly intentId: string;
  readonly photoId: string;
  readonly candidate: RecipeCandidate;
  readonly cloudRecipe: RecipeDocument;
}

export interface StartPersonalPhotoTransferInput {
  readonly intentId: string;
  readonly file: File;
  readonly format: PhotoFormat;
  readonly fullRecipeCandidate: RecipeCandidate | null;
}

export interface ResumePersonalPhotoTransferInput {
  readonly intentId: string;
  readonly file?: File;
}
export interface PersonalPhotoTransferListOptions { readonly cursor?: string; readonly limit?: number }
export interface PersonalPhotoTransferPage { readonly items: readonly PersonalPhotoTransferStatus[]; readonly nextCursor: string | null }

export interface CreateBrowserPersonalPhotoTransferControllerOptions {
  readonly client: PersonalPhotoCloudClient;
  readonly identity: PersonalPhotoCloudIdentity;
  readonly indexedDB?: IDBFactory;
  readonly locks?: LockManager | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly databaseName?: string;
  readonly trustedUploadOrigin?: string;
}

export interface BrowserPersonalPhotoTransferController {
  checkCapability(format: PhotoFormat, signal?: AbortSignal): Promise<boolean>;
  start(input: StartPersonalPhotoTransferInput, signal?: AbortSignal): Promise<PersonalPhotoTransferStatus>;
  resume(input: ResumePersonalPhotoTransferInput, signal?: AbortSignal): Promise<PersonalPhotoTransferStatus>;
  cancel(intentId: string, signal?: AbortSignal): Promise<PersonalPhotoTransferStatus>;
  list(options?: PersonalPhotoTransferListOptions): Promise<PersonalPhotoTransferPage>;
  readPendingRecipe(intentId: string): Promise<PendingPersonalPhotoRecipe | null>;
  dispose(): void;
}

export function createBrowserPersonalPhotoTransferController(
  options: CreateBrowserPersonalPhotoTransferControllerOptions,
): BrowserPersonalPhotoTransferController {
  return new TransferController(options);
}

class TransferController implements BrowserPersonalPhotoTransferController {
  private readonly journal: IndexedDbTransferJournal;
  private readonly locks: LockManager;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly trustedUploadOrigin: string;
  private readonly lifecycle = new AbortController();
  private readonly unsubscribeIdentity: () => void;
  private disposed = false;

  constructor(private readonly options: CreateBrowserPersonalPhotoTransferControllerOptions) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const locks = options.locks === undefined ? (typeof navigator === "object" ? navigator.locks : null) : options.locks;
    if (factory === undefined || locks === null || locks === undefined) throw new PersonalPhotoCloudError("unavailable");
    this.journal = new IndexedDbTransferJournal(factory, options.databaseName ?? "niho-personal-photo-transfers-v1");
    this.locks = locks;
    this.fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
    this.now = options.now ?? Date.now;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.trustedUploadOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;
    const captured = currentActor(options.identity);
    if (captured.userId !== options.client.scope.actorId || captured.sessionEpoch !== options.client.scope.sessionEpoch) {
      throw new PersonalPhotoCloudError("scope_changed");
    }
    this.unsubscribeIdentity = options.identity.subscribe(() => {
      const next = options.identity.getSnapshot();
      if (next === null || !samePhotoIdentityScope(captured, next)) {
        this.lifecycle.abort(new PersonalPhotoCloudError("scope_changed"));
      }
    });
  }

  async checkCapability(format: PhotoFormat, signal?: AbortSignal): Promise<boolean> {
    const operationLink = linkedAbortController(this.lifecycle.signal, ...(signal === undefined ? [] : [signal]));
    try {
      const library = await this.options.client.request("library.get", {}, { signal: operationLink.controller.signal });
      return library.state === "active" && library.capabilities.formats.some((item) => item.format === format && item.ingest);
    } finally { operationLink.dispose(); }
  }

  async start(input: StartPersonalPhotoTransferInput, signal?: AbortSignal): Promise<PersonalPhotoTransferStatus> {
    this.assertActive();
    validateIntent(input.intentId);
    const contentType = validateFile(input.file, input.format);
    const scope = this.scope();
    const capabilityLink = linkedAbortController(this.lifecycle.signal, ...(signal === undefined ? [] : [signal]));
    const capability: PersonalPhotoLibrary = await (async () => {
      try { return await this.options.client.request("library.get", {}, { signal: capabilityLink.controller.signal }); }
      finally { capabilityLink.dispose(); }
    })();
    const extension = fileExtension(input.file.name);
    const accepted = capability.state === "active" && capability.capabilities.formats.some((item) => item.format === input.format && item.ingest && item.extensions.some((itemExtension) => itemExtension.toLowerCase() === extension));
    if (!accepted) throw new PersonalPhotoCloudError("unsupported");
    this.assertScope(scope);
    return await this.withLock(scope, input.intentId, signal, async (operationSignal) => {
      if (await this.journal.get(scope, input.intentId, operationSignal) !== null) throw new PersonalPhotoCloudError("unavailable");
      const digest = await hashFile(input.file, operationSignal);
      const candidate = validateCandidate(input.fullRecipeCandidate);
      const entry: TransferJournalEntry = {
        schemaVersion: 1,
        id: makeEntryId(scope, input.intentId),
        revision: 0,
        ...scope,
        intentId: input.intentId,
        phase: "start-pending",
        startKey: this.newKey(), completeKey: this.newKey(), cancelKey: this.newKey(),
        fileName: input.file.name,
        format: input.format,
        contentType,
        sizeBytes: input.file.size,
        sha256: digest,
        candidate,
        cloudRecipe: null,
        uploadId: null,
        photoId: null,
        expiresAt: null,
        uploadedBytes: 0,
        failure: null,
      };
      await this.journal.add(entry, operationSignal);
      throwIfAborted(operationSignal);
      return await this.run(entry, input.file, operationSignal);
    });
  }

  async resume(input: ResumePersonalPhotoTransferInput, signal?: AbortSignal): Promise<PersonalPhotoTransferStatus> {
    this.assertActive(); validateIntent(input.intentId);
    const scope = this.scope();
    return await this.withLock(scope, input.intentId, signal, async (operationSignal) => {
      const entry = await this.requiredEntry(scope, input.intentId, operationSignal);
      if (terminal(entry.phase) || entry.phase === "pending-recipe") return status(entry);
      const needsFile = entry.phase === "start-pending" || entry.phase === "uploading";
      if (needsFile && input.file === undefined) return { ...status(entry), phase: "needs-file" };
      if (input.file !== undefined) await verifyReselectedFile(entry, input.file, operationSignal);
      return await this.run(entry, input.file ?? emptyFile(), operationSignal);
    });
  }

  async cancel(intentId: string, signal?: AbortSignal): Promise<PersonalPhotoTransferStatus> {
    this.assertActive(); validateIntent(intentId);
    const scope = this.scope();
    return await this.withLock(scope, intentId, signal, async (operationSignal) => {
      let entry = await this.requiredEntry(scope, intentId, operationSignal);
      if (entry.phase === "cancelled" || entry.phase === "purged" || entry.phase === "rejected" || entry.phase === "expired") return status(entry);
      if (entry.phase === "done" || entry.phase === "pending-recipe") return status(await this.update(entry, { phase: "failed", failure: "stored" }));
      entry = await this.update(entry, { phase: "cancel-pending" });
      if (entry.uploadId === null) {
        const reconciled = await this.reconcileStart(entry, operationSignal);
        entry = reconciled.entry;
        if (reconciled.existing) return status(await this.update(entry, { phase: "failed", failure: "stored" }));
        if (entry.uploadId === null) return status(entry);
        if (entry.phase !== "cancel-pending") entry = await this.update(entry, { phase: "cancel-pending" });
      }
      try {
        const receipt = await this.options.client.request("uploads.cancel", { uploadId: requiredUploadId(entry) }, { signal: operationSignal, idempotencyKey: entry.cancelKey });
        const upload = receipt.value;
        assertUploadBinding(entry, upload);
        if (upload.state === "cancelled") entry = await this.update(entry, { phase: "cancelled" });
        else if (upload.state === "stored" || upload.state === "verifying") entry = await this.update(entry, { phase: upload.state === "stored" ? "failed" : "verifying", failure: upload.state === "stored" ? "stored" : null });
        else if (upload.state === "expired") entry = await this.update(entry, { phase: "expired" });
      } catch (error) { entry = await this.handleKnownFailure(entry, error); }
      return status(entry);
    });
  }

  async list(options: PersonalPhotoTransferListOptions = {}): Promise<PersonalPhotoTransferPage> {
    this.assertActive();
    const scope = this.scope();
    const page = await this.journal.list(scope, options as TransferJournalListOptions, this.lifecycle.signal);
    this.assertScope(scope);
    return { items: page.entries.map(status), nextCursor: page.nextCursor };
  }

  async readPendingRecipe(intentId: string): Promise<PendingPersonalPhotoRecipe | null> {
    this.assertActive();
    const scope = this.scope();
    const entry = await this.journal.get(scope, intentId, this.lifecycle.signal);
    this.assertScope(scope);
    if (entry === null || entry.phase !== "pending-recipe" || entry.photoId === null || entry.candidate === null || entry.cloudRecipe === null) return null;
    return { intentId, photoId: entry.photoId, candidate: structuredClone(entry.candidate), cloudRecipe: structuredClone(entry.cloudRecipe) };
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribeIdentity(); this.lifecycle.abort(new PersonalPhotoCloudError("disposed")); this.journal.dispose(); }

  private async run(initial: TransferJournalEntry, file: File, signal: AbortSignal): Promise<PersonalPhotoTransferStatus> {
    let entry = initial;
    if (entry.phase === "start-pending") {
      const reconciled = await this.reconcileStart(entry, signal);
      entry = reconciled.entry;
      if (reconciled.existing || entry.phase !== "uploading") return status(entry);
      return await this.upload(entry, file, reconciled.ticket, signal);
    }
    if (entry.phase === "uploading") return await this.upload(entry, file, null, signal);
    if (entry.phase === "complete-pending") return status(await this.complete(entry, signal));
    if (entry.phase === "verifying") {
      try {
        const upload = await this.options.client.request("uploads.get", { uploadId: requiredUploadId(entry) }, { signal });
        return status(await this.acceptUploadState(entry, upload, signal));
      } catch (error) { return status(await this.handleKnownFailure(entry, error)); }
    }
    return status(entry);
  }

  private async reconcileStart(entry: TransferJournalEntry, signal: AbortSignal): Promise<{ entry: TransferJournalEntry; ticket: UploadTicket | null; existing: boolean }> {
    try {
      const receipt = await this.options.client.request("uploads.start", startPayload(entry), { signal, idempotencyKey: entry.startKey });
      return await this.acceptStart(entry, receipt.value, signal);
    } catch (error) { return { entry: await this.handleKnownFailure(entry, error), ticket: null, existing: false }; }
  }

  private async acceptStart(entry: TransferJournalEntry, response: StartUploadResponse, signal: AbortSignal): Promise<{ entry: TransferJournalEntry; ticket: UploadTicket | null; existing: boolean }> {
    if (response.kind === "existing") return { entry: await this.finishPhoto(entry, response.photo, signal), ticket: null, existing: true };
    assertUploadBinding(entry, response.upload);
    const upload = response.upload;
    if (entry.uploadId !== null && entry.uploadId !== upload.id || entry.expiresAt !== null && entry.expiresAt !== upload.expiresAt) throw new PersonalPhotoCloudError("invalid_response");
    entry = await this.update(entry, { uploadId: upload.id, expiresAt: entry.expiresAt ?? upload.expiresAt });
    entry = await this.acceptUploadState(entry, upload, signal, false);
    const ticket = response.ticket === null || entry.uploadedBytes === entry.sizeBytes || entry.phase !== "uploading"
      ? null
      : validateTicket(response.ticket, { trustedOrigin: this.trustedUploadOrigin, expectedContentType: entry.contentType, expectedSize: entry.sizeBytes, now: this.now() });
    return { entry, ticket, existing: false };
  }

  private async upload(initial: TransferJournalEntry, file: File, initialTicket: UploadTicket | null, signal: AbortSignal): Promise<PersonalPhotoTransferStatus> {
    let entry = initial; let ticket = initialTicket; let noProgress = 0;
    for (let step = 0; step < MAX_UPLOAD_STEPS && entry.phase === "uploading"; step += 1) {
      if (entry.uploadedBytes === entry.sizeBytes) return status(await this.complete(await this.update(entry, { phase: "complete-pending" }), signal));
      if (entry.expiresAt === null) return status(await this.update(entry, { phase: "expired" }));
      if (this.now() >= Date.parse(entry.expiresAt)) {
        entry = (await this.fetchUpload(entry, signal)).entry;
        if (entry.phase !== "uploading") return status(entry);
        if (entry.uploadedBytes === entry.sizeBytes) continue;
        return status(await this.update(entry, { phase: "expired" }));
      }
      if (ticket === null || ticket.resumeOffsetBytes !== entry.uploadedBytes || Date.parse(ticket.expiresAt) <= this.now()) {
        const current = await this.fetchUpload(entry, signal);
        entry = current.entry;
        if (entry.phase !== "uploading") return status(entry);
        if (entry.uploadedBytes === entry.sizeBytes) continue;
        try {
          const renewed = await this.options.client.request("uploads.renew", { uploadId: requiredUploadId(entry) }, { signal });
          assertUploadBinding(entry, renewed.upload);
          if (renewed.upload.expiresAt !== entry.expiresAt || renewed.upload.uploadedBytes !== entry.uploadedBytes) throw new PersonalPhotoCloudError("invalid_response");
          ticket = validateTicket(renewed.ticket, { trustedOrigin: this.trustedUploadOrigin, expectedContentType: entry.contentType, expectedSize: entry.sizeBytes, now: this.now() });
          if (ticket.resumeOffsetBytes !== entry.uploadedBytes) throw new PersonalPhotoCloudError("invalid_response");
        } catch (error) { return status(await this.handleKnownFailure(entry, error)); }
      }
      const endExclusive = Math.min(entry.uploadedBytes + GCS_CHUNK_BYTES, entry.sizeBytes);
      const endInclusive = endExclusive - 1;
      const uploadUrl = ticket.url;
      let response: Response;
      try {
        const providerLink = linkedAbortController(signal);
        try {
          response = await awaitBounded(Promise.resolve().then(async () => await this.fetchFn(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": entry.contentType, "Content-Range": `bytes ${entry.uploadedBytes}-${endInclusive}/${entry.sizeBytes}` },
          body: file.slice(entry.uploadedBytes, endExclusive),
          signal: providerLink.controller.signal,
          credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "manual",
          })), {
            signal,
            timeoutMs: PROVIDER_ATTEMPT_TIMEOUT_MS,
            onTimeout: () => providerLink.controller.abort(new PersonalPhotoCloudError("unavailable")),
            onLateResolve: cancelResponse,
          });
        } finally { providerLink.dispose(); }
      } catch {
        if (signal.aborted) throw abortReason(signal);
        entry = (await this.fetchUpload(entry, signal)).entry;
        ticket = null;
        if (entry.phase !== "uploading") return status(entry);
        noProgress += 1;
        if (noProgress >= MAX_PROVIDER_ATTEMPTS_WITHOUT_PROGRESS) return status(entry);
        continue;
      }
      void response.body?.cancel().catch(() => undefined);
      const previous = entry.uploadedBytes;
      if (response.status === 308 && response.type !== "opaqueredirect") {
        const next = parseProviderRange(response.headers.get("Range"), entry.uploadedBytes, endInclusive, entry.sizeBytes);
        if (next !== null) entry = await this.update(entry, { uploadedBytes: next });
        else entry = (await this.fetchUpload(entry, signal)).entry;
      } else {
        entry = (await this.fetchUpload(entry, signal)).entry;
      }
      ticket = null;
      if (entry.phase !== "uploading") return status(entry);
      if (entry.uploadedBytes < previous) throw new PersonalPhotoCloudError("invalid_response");
      noProgress = entry.uploadedBytes === previous ? noProgress + 1 : 0;
      if (noProgress >= MAX_PROVIDER_ATTEMPTS_WITHOUT_PROGRESS) return status(entry);
    }
    return status(entry);
  }

  private async fetchUpload(entry: TransferJournalEntry, signal: AbortSignal): Promise<{ entry: TransferJournalEntry }> {
    try {
      const upload = await this.options.client.request("uploads.get", { uploadId: requiredUploadId(entry) }, { signal });
      return { entry: await this.acceptUploadState(entry, upload, signal) };
    } catch (error) { return { entry: await this.handleKnownFailure(entry, error) }; }
  }

  private async acceptUploadState(entry: TransferJournalEntry, upload: Upload, signal: AbortSignal, allowComplete = true): Promise<TransferJournalEntry> {
    assertUploadBinding(entry, upload);
    if (entry.uploadId !== null && upload.id !== entry.uploadId || entry.expiresAt !== null && upload.expiresAt !== entry.expiresAt) throw new PersonalPhotoCloudError("invalid_response");
    if (upload.state === "reserved") {
      if (upload.uploadedBytes < entry.uploadedBytes) throw new PersonalPhotoCloudError("invalid_response");
      entry = await this.update(entry, { phase: "uploading", uploadedBytes: upload.uploadedBytes });
      if (allowComplete && upload.uploadedBytes === upload.sizeBytes) entry = await this.complete(await this.update(entry, { phase: "complete-pending" }), signal);
      return entry;
    }
    if (upload.state === "verifying") return await this.update(entry, { phase: "verifying", uploadedBytes: entry.sizeBytes });
    if (upload.state === "stored") {
      if (upload.result.kind !== "original") throw new PersonalPhotoCloudError("invalid_response");
      return await this.finishPhoto(entry, upload.result.photo, signal);
    }
    if (upload.state === "cancelled") return await this.update(entry, { phase: "cancelled" });
    if (upload.state === "expired") return await this.update(entry, { phase: "expired" });
    return await this.update(entry, { phase: "rejected" });
  }

  private async complete(entry: TransferJournalEntry, signal: AbortSignal): Promise<TransferJournalEntry> {
    if (entry.expiresAt === null || this.now() >= completionDeadline(entry.expiresAt)) return await this.update(entry, { phase: "expired" });
    try {
      const receipt = await this.options.client.request("uploads.complete", { uploadId: requiredUploadId(entry) }, { signal, idempotencyKey: entry.completeKey });
      return await this.acceptUploadState(entry, receipt.value, signal, false);
    } catch (error) { return await this.handleKnownFailure(entry, error); }
  }

  private async finishPhoto(entry: TransferJournalEntry, photo: Photo, signal: AbortSignal): Promise<TransferJournalEntry> {
    if (photo.libraryId !== entry.libraryId || photo.original.sha256 !== entry.sha256 || photo.original.sizeBytes !== entry.sizeBytes) throw new PersonalPhotoCloudError("invalid_response");
    if (entry.candidate === null) return await this.update(entry, { phase: "done", photoId: photo.id, cloudRecipe: null, uploadedBytes: entry.sizeBytes });
    if (recipeMatches(entry.candidate, photo.recipe) && await this.verifyMasks(photo.id, entry.candidate.maskSurfaceIds, signal)) {
      return await this.update(entry, { phase: "done", photoId: photo.id, cloudRecipe: null, uploadedBytes: entry.sizeBytes });
    }
    return await this.update(entry, { phase: "pending-recipe", photoId: photo.id, cloudRecipe: structuredClone(photo.recipe), uploadedBytes: entry.sizeBytes });
  }

  private async verifyMasks(photoId: string, surfaceIds: readonly string[], signal: AbortSignal): Promise<boolean> {
    for (const surfaceId of surfaceIds) {
      let asset: PhotoAsset;
      try {
        asset = await this.options.client.request("masks.get", { photoId, surfaceId }, { signal });
        validateAsset(asset, "mask");
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof PersonalPhotoCloudError && ["scope_changed", "invalid_identity", "disposed"].includes(error.code)) throw error;
        if (photoErrorCode(error) === "unauthenticated") throw new PersonalPhotoCloudError("scope_changed");
        return false;
      }
      if (asset.sha256 !== surfaceId || asset.sizeBytes > PHOTO_LIMITS.maxMaskBytes || asset.width > PHOTO_LIMITS.maxMaskEdge || asset.height > PHOTO_LIMITS.maxMaskEdge) return false;
    }
    return true;
  }

  private async handleKnownFailure(entry: TransferJournalEntry, error: unknown): Promise<TransferJournalEntry> {
    if (error instanceof PersonalPhotoCloudError && error.code === "invalid_response") {
      return await this.update(entry, { phase: "failed", failure: "invalid-response" });
    }
    const code = photoErrorCode(error);
    if (code === "upload_state_conflict" && entry.phase === "cancel-pending") {
      return await this.update(entry, { phase: "failed", failure: "stored" });
    }
    if (code === "upload_expired") return await this.update(entry, { phase: "expired" });
    if (code === "photo_deleted") return await this.update(entry, { phase: "purged" });
    if (code === "not_found" && entry.uploadId !== null) return await this.update(entry, { phase: "failed", failure: "not-found" });
    if (code === "content_rejected" || code === "unsupported_format" || code === "pixel_limit_exceeded") return await this.update(entry, { phase: "rejected" });
    return entry;
  }

  private async update(entry: TransferJournalEntry, patch: Partial<TransferJournalEntry>): Promise<TransferJournalEntry> {
    const next = { ...entry, ...patch, revision: entry.revision + 1 };
    await this.journal.compareAndSet(entry, next, this.lifecycle.signal);
    return next;
  }
  private async requiredEntry(scope: JournalScope, intentId: string, signal: AbortSignal): Promise<TransferJournalEntry> { const entry = await this.journal.get(scope, intentId, signal); if (entry === null) throw new PersonalPhotoCloudError("not_found"); return entry; }
  private scope(): JournalScope { const actor = currentActor(this.options.identity); if (actor.userId !== this.options.client.scope.actorId || actor.sessionEpoch !== this.options.client.scope.sessionEpoch) throw new PersonalPhotoCloudError("scope_changed"); return { actorId: actor.userId, libraryId: this.options.client.scope.libraryId, sessionId: actor.sessionId, sessionEpoch: actor.sessionEpoch }; }
  private async withLock<T>(scope: JournalScope, intentId: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operationLink = linkedAbortController(this.lifecycle.signal, ...(signal === undefined ? [] : [signal]));
    const operationSignal = operationLink.controller.signal;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const lockPromise = this.locks.request(`niho-photo-transfer:${makeEntryId(scope, intentId)}`, { mode: "exclusive", signal: operationSignal }, async () => {
      acquired();
      throwIfAborted(operationSignal);
      const result = await run(operationSignal);
      throwIfAborted(operationSignal);
      this.assertScope(scope);
      return result;
    });
    void lockPromise.catch(() => undefined);
    try {
      await awaitBounded(acquiredPromise, {
        signal: operationSignal,
        timeoutMs: LOCK_WAIT_TIMEOUT_MS,
        onTimeout: () => operationLink.controller.abort(new PersonalPhotoCloudError("unavailable")),
      });
      return await awaitBounded(lockPromise, {
        signal: operationSignal,
        timeoutMs: LOCK_OPERATION_TIMEOUT_MS,
        onTimeout: () => operationLink.controller.abort(new PersonalPhotoCloudError("unavailable")),
      });
    } finally { operationLink.dispose(); }
  }
  private assertScope(scope: JournalScope): void { const current = this.scope(); if (current.actorId !== scope.actorId || current.libraryId !== scope.libraryId || current.sessionId !== scope.sessionId || current.sessionEpoch !== scope.sessionEpoch) throw new PersonalPhotoCloudError("scope_changed"); }
  private newKey(): string { const value = this.randomUUID(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new PersonalPhotoCloudError("unavailable"); return value; }
  private assertActive(): void { if (this.disposed) throw new PersonalPhotoCloudError("disposed"); }
}

async function hashFile(file: File, signal: AbortSignal): Promise<string> { const hash = sha256.create(); for (let offset = 0; offset < file.size; offset += HASH_SLICE_BYTES) { throwIfAborted(signal); const bytes = await awaitBounded(file.slice(offset, Math.min(offset + HASH_SLICE_BYTES, file.size)).arrayBuffer(), { signal, timeoutMs: TRANSPORT_TIMEOUT_MS }); throwIfAborted(signal); hash.update(new Uint8Array(bytes)); } throwIfAborted(signal); return [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function verifyReselectedFile(entry: TransferJournalEntry, file: File, signal: AbortSignal): Promise<void> { if (file.size !== entry.sizeBytes || validateFile(file, entry.format) !== entry.contentType || await hashFile(file, signal) !== entry.sha256) throw new PersonalPhotoCloudError("invalid_response"); }
function startPayload(entry: TransferJournalEntry) { return { target: { kind: "original" as const, fileName: entry.fileName, format: entry.format }, sizeBytes: entry.sizeBytes, sha256: entry.sha256, contentType: entry.contentType }; }
function assertUploadBinding(entry: TransferJournalEntry, upload: Upload): void { if (upload.target.kind !== "original" || upload.target.fileName !== entry.fileName || upload.target.format !== entry.format || upload.sizeBytes !== entry.sizeBytes || upload.sha256 !== entry.sha256) throw new PersonalPhotoCloudError("invalid_response"); }
function requiredUploadId(entry: TransferJournalEntry): string { if (entry.uploadId === null) throw new PersonalPhotoCloudError("invalid_response"); return entry.uploadId; }
function parseProviderRange(value: string | null, offset: number, chunkEnd: number, total: number): number | null { if (value === null || value.includes(",")) return null; const match = /^bytes=0-(\d+)$/u.exec(value); if (!match) return null; const last = Number(match[1]); return Number.isSafeInteger(last) && last + 1 >= offset && last <= chunkEnd && last < total ? last + 1 : null; }
function recipeMatches(candidate: RecipeCandidate, recipe: RecipeDocument): boolean { return candidate.settingsSha256 === recipe.settingsSha256 && candidate.baseVersion === recipe.baseVersion && deepEqual(candidate.settings, recipe.settings) && deepEqual(candidate.maskSurfaceIds, recipe.maskSurfaceIds); }
function deepEqual(left: unknown, right: unknown): boolean { if (Object.is(left, right)) return true; if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index])); if (isRecord(left) && isRecord(right)) { const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort(); return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key])); } return false; }
function status(entry: TransferJournalEntry): PersonalPhotoTransferStatus { return Object.freeze({ intentId: entry.intentId, phase: entry.phase, fileName: entry.fileName, format: entry.format, sizeBytes: entry.sizeBytes, sha256: entry.sha256, uploadedBytes: entry.uploadedBytes, photoId: entry.photoId, hasPendingRecipe: entry.phase === "pending-recipe", failure: entry.failure }); }
function terminal(phase: TransferPhase): boolean { return ["done", "cancelled", "expired", "rejected", "purged", "failed"].includes(phase); }
function completionDeadline(expiresAt: string): number { return Date.parse(expiresAt) + PHOTO_LIMITS.completionGraceSeconds * 1000; }
function currentActor(identity: PersonalPhotoCloudIdentity): VerifiedPhotoActor { const actor = identity.getSnapshot(); if (actor === null || actor.transport !== "browser-session" || Date.parse(actor.expiresAt) <= Date.now()) throw new PersonalPhotoCloudError("scope_changed"); return actor; }
function validateFile(file: File, format: PhotoFormat): string {
  if (!(file instanceof File) || file.size <= 0 || file.size > PHOTO_LIMITS.maxFileBytes || file.name.length === 0 || new TextEncoder().encode(file.name).byteLength > PHOTO_LIMITS.maxFileNameBytes || !Object.prototype.hasOwnProperty.call(ACCEPTED_EXTENSIONS, format)) throw new PersonalPhotoCloudError(file.size > PHOTO_LIMITS.maxFileBytes ? "too_large" : "invalid_response");
  const extension = fileExtension(file.name);
  if (!ACCEPTED_EXTENSIONS[format].includes(extension)) throw new PersonalPhotoCloudError("unsupported");
  const canonical = canonicalContentType(format);
  if (file.type !== "" && (file.type.length > 255 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(file.type) || file.type.toLowerCase() !== canonical)) throw new PersonalPhotoCloudError("invalid_response");
  return canonical;
}
function fileExtension(name: string): string { const index = name.lastIndexOf("."); return index <= 0 || index === name.length - 1 ? "" : name.slice(index + 1).toLowerCase(); }
function emptyFile(): File { return new File([], "resume-placeholder", { type: "application/octet-stream" }); }
function validateIntent(value: string): void { if (typeof value !== "string" || value.length === 0 || value.length > 512 || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) throw new PersonalPhotoCloudError("invalid_response"); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"); }
function photoErrorCode(error: unknown): string | null { return isRecord(error) && isRecord(error.error) && typeof error.error.code === "string" ? error.error.code : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
