import { sha256 } from "@noble/hashes/sha2.js";
import { samePhotoIdentityScope } from "@niho/photo-cloud-session";
import {
  PHOTO_LIMITS,
  type PersonalPhotoCloudClient,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoFormat,
  type RecipeCandidate,
  type RecipeDocument,
  type Upload,
  type VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";

import { PersonalPhotoCloudError } from "../errors";
import { abortReason, awaitBounded, linkedAbortController } from "../await";
import { recipeCandidateMatches } from "../recipe";
import { readVerifiedMaskSurface } from "../mask-surface";
import type { PersonalPhotoCloudIdentity, PersonalPhotoCloudMaskValidator } from "../types";
import { TRANSPORT_TIMEOUT_MS, TRUSTED_GCS_UPLOAD_ORIGIN, canonicalContentType } from "../wire";
import {
  IndexedDbTransferJournal,
  PERSONAL_PHOTO_TRANSFER_DATABASE_NAME,
  makeEntryId,
  validateCandidate,
  type JournalScope,
  type TransferJournalListOptions,
  type TransferJournalEntry,
  type TransferPhase,
} from "./journal";
import {
  cancelPersonalPhotoResumableUpload,
  runPersonalPhotoResumableUpload,
  type PersonalPhotoResumableUploadResult,
  type PersonalPhotoResumableUploadState,
} from "./resumable-upload";

const HASH_SLICE_BYTES = 1024 ** 2;
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
  /** SDK decoder for masks; a recipe with mask references cannot complete without it. */
  readonly maskValidator?: PersonalPhotoCloudMaskValidator;
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
  /** Fence and erase this controller's captured transfer scope after logout or revocation. */
  revokeScope?(): Promise<void>;
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
  private readonly capturedScope: JournalScope;
  private readonly lifecycle = new AbortController();
  private readonly unsubscribeIdentity: () => void;
  private readonly unsubscribeScopeRevoked: () => void;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private revocationPromise: Promise<void> | null = null;
  private revoked = false;
  private disposed = false;

  constructor(private readonly options: CreateBrowserPersonalPhotoTransferControllerOptions) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const locks = options.locks === undefined ? (typeof navigator === "object" ? navigator.locks : null) : options.locks;
    if (factory === undefined || locks === null || locks === undefined) throw new PersonalPhotoCloudError("unavailable");
    this.journal = new IndexedDbTransferJournal(factory, options.databaseName ?? PERSONAL_PHOTO_TRANSFER_DATABASE_NAME);
    this.locks = locks;
    this.fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
    this.now = options.now ?? Date.now;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.trustedUploadOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;
    const captured = currentActor(options.identity, this.now());
    if (captured.userId !== options.client.scope.actorId || captured.sessionEpoch !== options.client.scope.sessionEpoch) {
      throw new PersonalPhotoCloudError("scope_changed");
    }
    this.capturedScope = Object.freeze({
      actorId: captured.userId,
      libraryId: options.client.scope.libraryId,
      sessionId: captured.sessionId,
      sessionEpoch: captured.sessionEpoch,
    });
    this.unsubscribeIdentity = options.identity.subscribe(() => {
      const next = options.identity.getSnapshot();
      // A null snapshot also represents connection disposal and temporary verification gaps.
      // Only a definitive revocation event or a verifiable replacement identity can purge.
      if (next === null) return;
      const expiresAt = Date.parse(next.expiresAt);
      if (!samePhotoIdentityScope(captured, next) || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        this.invalidateScope();
      } else {
        this.armExpiry(expiresAt);
      }
    });
    this.unsubscribeScopeRevoked = options.identity.subscribeScopeRevoked?.(() => this.invalidateScope()) ?? (() => undefined);
    this.armExpiry(Date.parse(captured.expiresAt));
  }

  async checkCapability(format: PhotoFormat, signal?: AbortSignal): Promise<boolean> {
    this.assertActive();
    const scope = this.scope();
    const operationLink = linkedAbortController(this.lifecycle.signal, ...(signal === undefined ? [] : [signal]));
    try {
      const library = await this.options.client.request("library.get", {}, { signal: operationLink.controller.signal });
      this.assertScope(scope);
      return library.state === "active" && library.capabilities.formats.some((item) => item.format === format && item.ingest);
    } catch (error) {
      if (!operationLink.controller.signal.aborted && isDefinitiveRevocation(error)) this.invalidateScope();
      throw error;
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
      catch (error) {
        if (!capabilityLink.controller.signal.aborted && isDefinitiveRevocation(error)) this.invalidateScope();
        throw error;
      }
      finally { capabilityLink.dispose(); }
    })();
    this.assertScope(scope);
    const extension = fileExtension(input.file.name);
    const accepted = capability.state === "active" && capability.capabilities.formats.some((item) => item.format === input.format && item.ingest && item.extensions.some((itemExtension) => itemExtension.toLowerCase() === extension));
    if (!accepted) throw new PersonalPhotoCloudError("unsupported");
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
      if (entry.phase === "done" || entry.phase === "pending-recipe") return status(await this.markStoredCancellation(entry));
      entry = await this.update(entry, { phase: "cancel-pending" });
      return status(await this.cancelEntry(entry, operationSignal));
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

  async revokeScope(): Promise<void> {
    if (this.disposed && this.revocationPromise === null) throw new PersonalPhotoCloudError("disposed");
    if (this.revocationPromise === null) {
      this.revoked = true;
      this.clearExpiry();
      this.lifecycle.abort(new PersonalPhotoCloudError("scope_changed"));
      this.revocationPromise = this.journal.purgeScope(this.capturedScope).then(() => undefined);
    }
    try { await this.revocationPromise; }
    finally { if (this.disposed) this.journal.dispose(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeIdentity();
    this.unsubscribeScopeRevoked();
    this.clearExpiry();
    this.lifecycle.abort(new PersonalPhotoCloudError("disposed"));
    if (this.revocationPromise === null) this.journal.dispose();
    else void this.revocationPromise.finally(() => this.journal.dispose()).catch(() => undefined);
  }

  private async cancelEntry(initial: TransferJournalEntry, signal: AbortSignal): Promise<TransferJournalEntry> {
    let { entry, result } = await this.executeRunner(initial, undefined, signal, true);
    if (result.existingPhoto !== null) return await this.markStoredCancellation(await this.finishPhoto(entry, result.existingPhoto, signal));
    if (result.stored?.kind === "original") return await this.markStoredCancellation(await this.finishPhoto(entry, result.stored.photo, signal));
    if (result.error !== null) {
      const error = result.error;
      if (photoErrorCode(error) === "upload_state_conflict" && entry.candidate !== null) {
        // A stored original may still have a different local recipe. Read its actual
        // result before closing cancellation, so the complete candidate stays reachable.
        try {
          const upload = await this.options.client.request("uploads.get", { uploadId: requiredUploadId(entry) }, { signal });
          this.assertScope(scopeFromEntry(entry));
          assertUploadBinding(entry, upload);
          if (upload.state === "stored" && upload.result.kind === "original") entry = await this.markStoredCancellation(await this.finishPhoto(entry, upload.result.photo, signal));
          else if (upload.state === "verifying") entry = await this.update(entry, { phase: "verifying", uploadedBytes: entry.sizeBytes });
        } catch (readError) { entry = await this.handleKnownFailure(entry, readError, signal); }
      } else entry = await this.handleKnownFailure(entry, error, signal);
    }
    return entry;
  }

  private async markStoredCancellation(entry: TransferJournalEntry): Promise<TransferJournalEntry> {
    return await this.update(entry, { phase: entry.phase === "pending-recipe" ? "pending-recipe" : "failed", failure: "stored" });
  }

  private async run(initial: TransferJournalEntry, file: File, signal: AbortSignal): Promise<PersonalPhotoTransferStatus> {
    if (initial.phase === "cancel-pending") return status(await this.cancelEntry(initial, signal));
    const executed = await this.executeRunner(initial, file.size === 0 ? undefined : file, signal, false);
    let entry = executed.entry;
    const result = executed.result;
    if (result.existingPhoto !== null) entry = await this.finishPhoto(entry, result.existingPhoto, signal);
    else if (result.stored?.kind === "original") entry = await this.finishPhoto(entry, result.stored.photo, signal);
    else if (result.error !== null) entry = await this.handleKnownFailure(entry, result.error, signal);
    return status(entry);
  }

  private async executeRunner(
    initial: TransferJournalEntry,
    source: Blob | undefined,
    signal: AbortSignal,
    cancelling: boolean,
  ): Promise<{ readonly entry: TransferJournalEntry; readonly result: PersonalPhotoResumableUploadResult }> {
    let entry = initial;
    const state = resumableState(entry);
    const store = {
      compareAndSet: async (expected: PersonalPhotoResumableUploadState, next: PersonalPhotoResumableUploadState) => {
        if (!sameResumableState(expected, resumableState(entry))) throw new PersonalPhotoCloudError("unavailable");
        entry = await this.update(entry, {
          phase: next.phase,
          uploadId: next.uploadId,
          expiresAt: next.deadline,
          uploadedBytes: next.offsetBytes,
        });
      },
    };
    const options = {
      client: this.options.client,
      state,
      ...(source === undefined ? {} : { source }),
      store,
      signal,
      fetch: this.fetchFn,
      now: this.now,
      trustedUploadOrigin: this.trustedUploadOrigin,
      assertCurrent: () => this.assertScope(scopeFromEntry(entry)),
    };
    const result = cancelling
      ? await cancelPersonalPhotoResumableUpload(options)
      : await runPersonalPhotoResumableUpload(options);
    return { entry, result };
  }

  private async finishPhoto(entry: TransferJournalEntry, photo: Photo, signal: AbortSignal): Promise<TransferJournalEntry> {
    if (photo.libraryId !== entry.libraryId || photo.original.sha256 !== entry.sha256 || photo.original.sizeBytes !== entry.sizeBytes) throw new PersonalPhotoCloudError("invalid_response");
    if (entry.candidate === null) {
      const untouched = photo.recipe.revision === 0 &&
        photo.recipe.maskSurfaceIds.length === 0 && photo.hasEdits === false;
      return await this.update(entry, {
        phase: untouched ? "done" : "failed",
        photoId: photo.id,
        cloudRecipe: untouched ? null : structuredClone(photo.recipe),
        uploadedBytes: entry.sizeBytes,
        failure: untouched ? null : "stored",
      });
    }
    if (recipeMatches(entry.candidate, photo.recipe) && await this.verifyMasks(photo.id, entry.candidate.maskSurfaceIds, signal)) {
      return await this.update(entry, { phase: "done", photoId: photo.id, cloudRecipe: null, uploadedBytes: entry.sizeBytes });
    }
    return await this.update(entry, { phase: "pending-recipe", photoId: photo.id, cloudRecipe: structuredClone(photo.recipe), uploadedBytes: entry.sizeBytes });
  }

  private async verifyMasks(photoId: string, surfaceIds: readonly string[], signal: AbortSignal): Promise<boolean> {
    if (surfaceIds.length > 0 && this.options.maskValidator === undefined) return false;
    for (const surfaceId of surfaceIds) {
      try {
        const stored = await readVerifiedMaskSurface(this.options.client, photoId, surfaceId, signal, this.options.maskValidator!);
        if (stored === null || stored.asset.sizeBytes > PHOTO_LIMITS.maxMaskBytes ||
          stored.asset.width > PHOTO_LIMITS.maxMaskEdge || stored.asset.height > PHOTO_LIMITS.maxMaskEdge) return false;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof PersonalPhotoCloudError && ["scope_changed", "invalid_identity", "disposed"].includes(error.code)) throw error;
        if (photoErrorCode(error) === "unauthenticated") throw new PersonalPhotoCloudError("scope_changed");
        return false;
      }
    }
    return true;
  }

  private async handleKnownFailure(entry: TransferJournalEntry, error: unknown, signal: AbortSignal): Promise<TransferJournalEntry> {
    if (signal.aborted) throw abortReason(signal);
    if (isDefinitiveRevocation(error)) {
      this.invalidateScope();
      throw new PersonalPhotoCloudError("scope_changed");
    }
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
  private scope(): JournalScope {
    const actor = this.options.identity.getSnapshot();
    if (actor === null) throw new PersonalPhotoCloudError("scope_changed");
    const expiresAt = Date.parse(actor.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.invalidateScope();
      throw new PersonalPhotoCloudError("scope_changed");
    }
    const scope = { actorId: actor.userId, libraryId: this.options.client.scope.libraryId, sessionId: actor.sessionId, sessionEpoch: actor.sessionEpoch };
    if (
      actor.transport !== "browser-session" ||
      actor.userId !== this.options.client.scope.actorId ||
      actor.sessionEpoch !== this.options.client.scope.sessionEpoch ||
      !sameJournalScope(scope, this.capturedScope)
    ) {
      this.invalidateScope();
      throw new PersonalPhotoCloudError("scope_changed");
    }
    return scope;
  }
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
    } catch (error) {
      if (!operationSignal.aborted && isDefinitiveRevocation(error)) this.invalidateScope();
      throw error;
    } finally { operationLink.dispose(); }
  }
  private assertScope(scope: JournalScope): void {
    const current = this.scope();
    if (!sameJournalScope(current, scope)) {
      this.invalidateScope();
      throw new PersonalPhotoCloudError("scope_changed");
    }
  }
  private newKey(): string { const value = this.randomUUID(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new PersonalPhotoCloudError("unavailable"); return value; }
  private assertActive(): void {
    if (this.disposed) throw new PersonalPhotoCloudError("disposed");
    if (this.revoked) throw new PersonalPhotoCloudError("scope_changed");
  }

  private invalidateScope(): void { void this.revokeScope().catch(() => undefined); }

  private armExpiry(expiresAt: number): void {
    this.clearExpiry();
    const delay = Math.max(0, Math.min(2_147_483_647, expiresAt - this.now()));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.disposed || this.revoked) return;
      const actor = this.options.identity.getSnapshot();
      if (actor === null) {
        if (this.now() >= expiresAt) this.invalidateScope();
        else this.armExpiry(expiresAt);
        return;
      }
      const currentExpiry = Date.parse(actor.expiresAt);
      if (
        !sameActorScope(actor, this.capturedScope) ||
        !Number.isFinite(currentExpiry) || currentExpiry <= this.now()
      ) {
        this.invalidateScope();
      } else {
        this.armExpiry(currentExpiry);
      }
    }, delay);
    const timer = this.expiryTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private clearExpiry(): void {
    if (this.expiryTimer === null) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
}

async function hashFile(file: File, signal: AbortSignal): Promise<string> { const hash = sha256.create(); for (let offset = 0; offset < file.size; offset += HASH_SLICE_BYTES) { throwIfAborted(signal); const bytes = await awaitBounded(file.slice(offset, Math.min(offset + HASH_SLICE_BYTES, file.size)).arrayBuffer(), { signal, timeoutMs: TRANSPORT_TIMEOUT_MS }); throwIfAborted(signal); hash.update(new Uint8Array(bytes)); } throwIfAborted(signal); return [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function verifyReselectedFile(entry: TransferJournalEntry, file: File, signal: AbortSignal): Promise<void> { if (file.size !== entry.sizeBytes || validateFile(file, entry.format) !== entry.contentType || await hashFile(file, signal) !== entry.sha256) throw new PersonalPhotoCloudError("invalid_response"); }
function assertUploadBinding(entry: TransferJournalEntry, upload: Upload): void { if ((entry.uploadId !== null && upload.id !== entry.uploadId) || (entry.expiresAt !== null && upload.expiresAt !== entry.expiresAt) || upload.target.kind !== "original" || upload.target.fileName !== entry.fileName || upload.target.format !== entry.format || upload.sizeBytes !== entry.sizeBytes || upload.sha256 !== entry.sha256) throw new PersonalPhotoCloudError("invalid_response"); }
function requiredUploadId(entry: TransferJournalEntry): string { if (entry.uploadId === null) throw new PersonalPhotoCloudError("invalid_response"); return entry.uploadId; }
function recipeMatches(candidate: RecipeCandidate, recipe: RecipeDocument): boolean { return recipeCandidateMatches(candidate, recipe); }
function status(entry: TransferJournalEntry): PersonalPhotoTransferStatus { return Object.freeze({ intentId: entry.intentId, phase: entry.phase, fileName: entry.fileName, format: entry.format, sizeBytes: entry.sizeBytes, sha256: entry.sha256, uploadedBytes: entry.uploadedBytes, photoId: entry.photoId, hasPendingRecipe: entry.phase === "pending-recipe", failure: entry.failure }); }
function terminal(phase: TransferPhase): boolean { return ["done", "cancelled", "expired", "rejected", "purged", "failed"].includes(phase); }
function resumableState(entry: TransferJournalEntry): PersonalPhotoResumableUploadState {
  if (!["start-pending", "uploading", "complete-pending", "verifying", "cancel-pending", "cancelled", "expired", "rejected"].includes(entry.phase)) throw new PersonalPhotoCloudError("invalid_response");
  return {
    target: { kind: "original", fileName: entry.fileName, format: entry.format },
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    contentType: entry.contentType,
    startKey: entry.startKey,
    completeKey: entry.completeKey,
    cancelKey: entry.cancelKey,
    uploadId: entry.uploadId,
    deadline: entry.expiresAt,
    offsetBytes: entry.uploadedBytes,
    phase: entry.phase as PersonalPhotoResumableUploadState["phase"],
  };
}
function sameResumableState(left: PersonalPhotoResumableUploadState, right: PersonalPhotoResumableUploadState): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function scopeFromEntry(entry: TransferJournalEntry): JournalScope { return { actorId: entry.actorId, libraryId: entry.libraryId, sessionId: entry.sessionId, sessionEpoch: entry.sessionEpoch }; }
function currentActor(identity: PersonalPhotoCloudIdentity, now: number): VerifiedPhotoActor {
  const actor = identity.getSnapshot();
  const expiresAt = actor === null ? Number.NaN : Date.parse(actor.expiresAt);
  if (actor === null || actor.transport !== "browser-session" || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new PersonalPhotoCloudError("scope_changed");
  }
  return actor;
}
function sameJournalScope(left: JournalScope, right: JournalScope): boolean {
  return left.actorId === right.actorId && left.libraryId === right.libraryId && left.sessionId === right.sessionId && left.sessionEpoch === right.sessionEpoch;
}
function sameActorScope(actor: VerifiedPhotoActor, scope: JournalScope): boolean {
  return actor.transport === "browser-session" && actor.userId === scope.actorId && actor.sessionId === scope.sessionId && actor.sessionEpoch === scope.sessionEpoch;
}
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
function isDefinitiveRevocation(error: unknown): boolean {
  return error instanceof PersonalPhotoCloudError && error.code === "invalid_identity" || photoErrorCode(error) === "unauthenticated";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
