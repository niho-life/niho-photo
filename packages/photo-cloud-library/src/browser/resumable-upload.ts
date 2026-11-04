import type {
  PersonalPhotoCloudClient,
  Photo,
  StartUploadRequest,
  StoredUploadResult,
  Upload,
  UploadTarget,
  UploadTicket,
} from "@niho/photo-personal-cloud-contract";
import { PHOTO_LIMITS } from "@niho/photo-personal-cloud-contract";

import { abortReason, awaitBounded, cancelResponse, linkedAbortController } from "../await";
import { PersonalPhotoCloudError } from "../errors";
import { validateAsset } from "../validation";
import { GCS_CHUNK_BYTES, TRUSTED_GCS_UPLOAD_ORIGIN, validateTicket } from "../wire";

const MAX_PROVIDER_ATTEMPTS_WITHOUT_PROGRESS = 3;
const MAX_UPLOAD_STEPS = 64;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 120_000;

export type PersonalPhotoResumableUploadPhase =
  | "start-pending"
  | "uploading"
  | "complete-pending"
  | "verifying"
  | "cancel-pending"
  | "cancelled"
  | "expired"
  | "rejected";

/** Durable scalar state. UploadTicket and provider response data must never be added here. */
export interface PersonalPhotoResumableUploadState {
  readonly target: UploadTarget;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly startKey: string;
  readonly completeKey: string;
  readonly cancelKey: string;
  readonly uploadId: string | null;
  readonly deadline: string | null;
  readonly offsetBytes: number;
  readonly phase: PersonalPhotoResumableUploadPhase;
}

export interface PersonalPhotoResumableUploadStorePort {
  /** Strict durable CAS, including an equal-state write used as the pre-network barrier. */
  compareAndSet(
    expected: PersonalPhotoResumableUploadState,
    next: PersonalPhotoResumableUploadState,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface PersonalPhotoResumableUploadOptions {
  readonly client: PersonalPhotoCloudClient;
  readonly state: PersonalPhotoResumableUploadState;
  readonly source?: Blob;
  readonly store: PersonalPhotoResumableUploadStorePort;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly trustedUploadOrigin?: string;
  /** Re-check the caller's captured identity/scope after every asynchronous boundary. */
  readonly assertCurrent?: () => void;
}

export interface PersonalPhotoResumableUploadResult {
  readonly state: PersonalPhotoResumableUploadState;
  readonly stored: StoredUploadResult | null;
  readonly existingPhoto: Photo | null;
  /** Non-durable transport/domain error for the caller's existing policy mapping. */
  readonly error: unknown | null;
}

export async function runPersonalPhotoResumableUpload(
  options: PersonalPhotoResumableUploadOptions,
): Promise<PersonalPhotoResumableUploadResult> {
  return await new Runner(options).run();
}

export async function cancelPersonalPhotoResumableUpload(
  options: PersonalPhotoResumableUploadOptions,
): Promise<PersonalPhotoResumableUploadResult> {
  return await new Runner(options).cancel();
}

class Runner {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly trustedUploadOrigin: string;

  constructor(private readonly options: PersonalPhotoResumableUploadOptions) {
    validateState(options.state);
    if (options.source !== undefined && options.source.size !== options.state.sizeBytes) invalid();
    this.fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
    this.now = options.now ?? Date.now;
    this.trustedUploadOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;
    this.current();
  }

  async run(): Promise<PersonalPhotoResumableUploadResult> {
    let state = this.options.state;
    await this.wait(this.options.store.compareAndSet(state, state, this.options.signal));
    let ticket: UploadTicket | null = null;
    if (state.phase === "start-pending") {
      const started = await this.start(state);
      if (started.result !== null) return started.result;
      state = started.state;
      ticket = started.ticket;
    }
    if (state.phase === "uploading") return await this.upload(state, ticket);
    if (state.phase === "complete-pending") return await this.complete(state, true);
    if (state.phase === "verifying") return await this.read(state, true);
    if (state.phase === "cancel-pending") return await this.cancelFrom(state);
    return result(state);
  }

  async cancel(): Promise<PersonalPhotoResumableUploadResult> {
    let state = this.options.state;
    if (state.phase !== "cancel-pending") invalid();
    await this.wait(this.options.store.compareAndSet(state, state, this.options.signal));
    if (state.uploadId === null) {
      const started = await this.start(state);
      if (started.result !== null) return started.result;
      state = started.state;
      if (state.uploadId === null || terminal(state.phase)) return result(state);
      if (state.phase !== "cancel-pending") state = await this.persist(state, { phase: "cancel-pending" });
    }
    return await this.cancelFrom(state);
  }

  private async start(state: PersonalPhotoResumableUploadState): Promise<{
    readonly state: PersonalPhotoResumableUploadState;
    readonly ticket: UploadTicket | null;
    readonly result: PersonalPhotoResumableUploadResult | null;
  }> {
    try {
      const receipt = await this.wait(this.options.client.request("uploads.start", payload(state), {
        signal: this.options.signal,
        idempotencyKey: state.startKey,
      }));
      const response = receipt.value;
      if (response.kind === "existing") {
        if (state.target.kind !== "original") invalid();
        assertOriginalPhoto(state, response.photo);
        return { state, ticket: null, result: result(state, null, response.photo) };
      }
      assertUploadBinding(state, response.upload);
      state = await this.persist(state, {
        uploadId: response.upload.id,
        deadline: state.deadline ?? response.upload.expiresAt,
      });
      const accepted = await this.accept(state, response.upload, false, state.phase === "cancel-pending");
      if (accepted.stored !== null || accepted.state.phase !== "uploading" && accepted.state.phase !== "cancel-pending") {
        return { state: accepted.state, ticket: null, result: accepted };
      }
      const uploadTicket = accepted.state.phase === "cancel-pending" || response.ticket === null || accepted.state.offsetBytes === accepted.state.sizeBytes
        ? null
        : validateTicket(response.ticket, {
          trustedOrigin: this.trustedUploadOrigin,
          expectedContentType: accepted.state.contentType,
          expectedSize: accepted.state.sizeBytes,
          now: this.now(),
        });
      return { state: accepted.state, ticket: uploadTicket, result: null };
    } catch (error) {
      return { state, ticket: null, result: result(state, null, null, error) };
    }
  }

  private async upload(
    initial: PersonalPhotoResumableUploadState,
    initialTicket: UploadTicket | null,
  ): Promise<PersonalPhotoResumableUploadResult> {
    let state = initial;
    let ticket = initialTicket;
    let noProgress = 0;
    for (let step = 0; step < MAX_UPLOAD_STEPS && state.phase === "uploading"; step += 1) {
      if (state.offsetBytes === state.sizeBytes) return await this.complete(await this.persist(state, { phase: "complete-pending" }), false);
      if (state.deadline === null) return result(state, null, null, new PersonalPhotoCloudError("invalid_response"));
      if (this.now() >= Date.parse(state.deadline)) {
        const current = await this.read(state, false);
        state = current.state;
        if (current.error !== null || current.stored !== null || state.phase !== "uploading") return current;
        if (state.offsetBytes === state.sizeBytes) continue;
        return result(await this.persist(state, { phase: "expired" }));
      }
      if (ticket === null || ticket.resumeOffsetBytes !== state.offsetBytes || Date.parse(ticket.expiresAt) <= this.now()) {
        const current = await this.read(state, false);
        state = current.state;
        if (current.stored !== null || state.phase !== "uploading") return current;
        if (current.error !== null && fatalReconcileError(current.error)) return current;
        if (state.offsetBytes === state.sizeBytes) continue;
        try {
          const renewed = await this.wait(this.options.client.request("uploads.renew", { uploadId: requiredUploadId(state) }, { signal: this.options.signal }));
          assertUploadBinding(state, renewed.upload);
          if (renewed.upload.expiresAt !== state.deadline || renewed.upload.state !== "reserved" || renewed.upload.uploadedBytes !== state.offsetBytes) invalid();
          ticket = validateTicket(renewed.ticket, {
            trustedOrigin: this.trustedUploadOrigin,
            expectedContentType: state.contentType,
            expectedSize: state.sizeBytes,
            now: this.now(),
          });
          if (ticket.resumeOffsetBytes !== state.offsetBytes) invalid();
        } catch (error) { return result(state, null, null, error); }
      }
      if (this.options.source === undefined) invalid();
      const endExclusive = Math.min(state.offsetBytes + GCS_CHUNK_BYTES, state.sizeBytes);
      const endInclusive = endExclusive - 1;
      let response: Response;
      try {
        const providerLink = linkedAbortController(this.options.signal);
        try {
          response = await this.wait(awaitBounded(Promise.resolve().then(async () => await this.fetchFn(ticket.url, {
            method: "PUT",
            headers: { "Content-Type": state.contentType, "Content-Range": `bytes ${state.offsetBytes}-${endInclusive}/${state.sizeBytes}` },
            body: this.options.source.slice(state.offsetBytes, endExclusive),
            signal: providerLink.controller.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            redirect: "manual",
          })), {
            signal: this.options.signal,
            timeoutMs: PROVIDER_ATTEMPT_TIMEOUT_MS,
            onTimeout: () => providerLink.controller.abort(new PersonalPhotoCloudError("unavailable")),
            onLateResolve: cancelResponse,
          }));
        } finally { providerLink.dispose(); }
      } catch {
        if (this.options.signal.aborted) throw abortReason(this.options.signal);
        const current = await this.read(state, false);
        state = current.state;
        if (current.stored !== null || state.phase !== "uploading") return current;
        if (current.error !== null && fatalReconcileError(current.error)) return current;
        ticket = null;
        noProgress += 1;
        if (noProgress >= MAX_PROVIDER_ATTEMPTS_WITHOUT_PROGRESS) return result(state);
        continue;
      }
      void response.body?.cancel().catch(() => undefined);
      const previous = state.offsetBytes;
      if (response.status === 308 && response.type !== "opaqueredirect") {
        const next = parseProviderRange(response.headers.get("Range"), state.offsetBytes, endInclusive, state.sizeBytes);
        if (next !== null) state = await this.persist(state, { offsetBytes: next });
        else {
          const current = await this.read(state, false);
          if (current.stored !== null || current.state.phase !== "uploading" || current.error !== null && fatalReconcileError(current.error)) return current;
          state = current.state;
        }
      } else {
        const current = await this.read(state, false);
        if (current.stored !== null || current.state.phase !== "uploading" || current.error !== null && fatalReconcileError(current.error)) return current;
        state = current.state;
      }
      ticket = null;
      if (state.phase !== "uploading") return result(state);
      if (state.offsetBytes < previous) invalid();
      noProgress = state.offsetBytes === previous ? noProgress + 1 : 0;
      if (noProgress >= MAX_PROVIDER_ATTEMPTS_WITHOUT_PROGRESS) return result(state);
    }
    return result(state);
  }

  private async read(state: PersonalPhotoResumableUploadState, allowComplete: boolean): Promise<PersonalPhotoResumableUploadResult> {
    try {
      const upload = await this.wait(this.options.client.request("uploads.get", { uploadId: requiredUploadId(state) }, { signal: this.options.signal }));
      return await this.accept(state, upload, allowComplete);
    } catch (error) { return result(state, null, null, error); }
  }

  private async accept(
    state: PersonalPhotoResumableUploadState,
    upload: Upload,
    allowComplete: boolean,
    preserveCancelIntent = false,
  ): Promise<PersonalPhotoResumableUploadResult> {
    assertUploadBinding(state, upload);
    if (upload.state === "reserved") {
      if (upload.uploadedBytes < state.offsetBytes) invalid();
      state = await this.persist(state, { phase: state.phase === "cancel-pending" ? "cancel-pending" : "uploading", offsetBytes: upload.uploadedBytes });
      if (allowComplete && upload.uploadedBytes === upload.sizeBytes) {
        return await this.complete(await this.persist(state, { phase: "complete-pending" }), false);
      }
      return result(state);
    }
    if (upload.state === "verifying") return result(await this.persist(state, { phase: preserveCancelIntent ? "cancel-pending" : "verifying", offsetBytes: state.sizeBytes }));
    if (upload.state === "stored") {
      assertStoredBinding(state, upload.result);
      return result(await this.persist(state, { phase: "verifying", offsetBytes: state.sizeBytes }), upload.result);
    }
    if (upload.state === "cancelled") return result(await this.persist(state, { phase: "cancelled" }));
    if (upload.state === "expired") return result(await this.persist(state, { phase: "expired" }));
    return result(await this.persist(state, { phase: "rejected" }));
  }

  private async complete(state: PersonalPhotoResumableUploadState, reconcileFirst: boolean): Promise<PersonalPhotoResumableUploadResult> {
    if (state.deadline === null) return result(state, null, null, new PersonalPhotoCloudError("invalid_response"));
    try {
      if (reconcileFirst || this.now() >= completionDeadline(state.deadline)) {
        const current = await this.read(state, false);
        if (current.error !== null || current.stored !== null || current.state.phase !== "uploading") return current;
        if (current.state.offsetBytes !== current.state.sizeBytes) invalid();
        if (this.now() >= completionDeadline(state.deadline)) return result(await this.persist(current.state, { phase: "expired" }));
        state = await this.persist(current.state, { phase: "complete-pending" });
      }
      const receipt = await this.wait(this.options.client.request("uploads.complete", { uploadId: requiredUploadId(state) }, {
        signal: this.options.signal,
        idempotencyKey: state.completeKey,
      }));
      return await this.accept(state, receipt.value, false);
    } catch (error) { return result(state, null, null, error); }
  }

  private async cancelFrom(state: PersonalPhotoResumableUploadState): Promise<PersonalPhotoResumableUploadResult> {
    try {
      const receipt = await this.wait(this.options.client.request("uploads.cancel", { uploadId: requiredUploadId(state) }, {
        signal: this.options.signal,
        idempotencyKey: state.cancelKey,
      }));
      return await this.accept(state, receipt.value, false);
    } catch (error) { return result(state, null, null, error); }
  }

  private async persist(
    expected: PersonalPhotoResumableUploadState,
    patch: Partial<PersonalPhotoResumableUploadState>,
  ): Promise<PersonalPhotoResumableUploadState> {
    const next = { ...expected, ...patch };
    validateTransition(expected, next);
    if (sameState(expected, next)) return expected;
    await this.wait(this.options.store.compareAndSet(expected, next, this.options.signal));
    return next;
  }

  private async wait<T>(promise: Promise<T>): Promise<T> {
    const value = await promise;
    this.current();
    return value;
  }

  private current(): void {
    throwIfAborted(this.options.signal);
    this.options.assertCurrent?.();
  }
}

function payload(state: PersonalPhotoResumableUploadState): StartUploadRequest {
  return { target: state.target, sizeBytes: state.sizeBytes, sha256: state.sha256, contentType: state.contentType };
}

function result(
  state: PersonalPhotoResumableUploadState,
  stored: StoredUploadResult | null = null,
  existingPhoto: Photo | null = null,
  error: unknown | null = null,
): PersonalPhotoResumableUploadResult {
  return { state, stored, existingPhoto, error };
}

function assertUploadBinding(state: PersonalPhotoResumableUploadState, upload: Upload): void {
  const targetMatches = upload.target.kind === "original" && state.target.kind === "original"
    ? upload.target.format === state.target.format
    : sameTarget(upload.target, state.target);
  if (
    (state.uploadId !== null && upload.id !== state.uploadId) ||
    (state.deadline !== null && upload.expiresAt !== state.deadline) ||
    upload.sizeBytes !== state.sizeBytes || upload.sha256 !== state.sha256 || !targetMatches
  ) invalid();
}

function assertStoredBinding(state: PersonalPhotoResumableUploadState, stored: StoredUploadResult): void {
  if (state.target.kind === "original") {
    if (stored.kind !== "original") invalid();
    assertOriginalPhoto(state, stored.photo);
    return;
  }
  if (stored.kind !== "mask" || stored.photoId !== state.target.photoId) invalid();
  validateAsset(stored.asset, "mask");
  if (
    stored.asset.sha256 !== state.sha256 || stored.asset.sizeBytes !== state.sizeBytes ||
    stored.asset.contentType !== "image/png" || stored.asset.width > PHOTO_LIMITS.maxMaskEdge ||
    stored.asset.height > PHOTO_LIMITS.maxMaskEdge
  ) invalid();
}

function assertOriginalPhoto(state: PersonalPhotoResumableUploadState, photo: Photo): void {
  // Content-addressed deduplication preserves the first cloud file name.
  if (state.target.kind !== "original" || photo.format !== state.target.format || photo.original.kind !== "original" ||
    photo.original.contentType !== state.contentType || photo.original.sha256 !== state.sha256 || photo.original.sizeBytes !== state.sizeBytes) invalid();
}

function validateState(state: PersonalPhotoResumableUploadState): void {
  if (
    !isTarget(state.target) || !Number.isSafeInteger(state.sizeBytes) || state.sizeBytes < 1 ||
    state.sizeBytes > (state.target.kind === "mask" ? PHOTO_LIMITS.maxMaskBytes : PHOTO_LIMITS.maxFileBytes) ||
    !/^[0-9a-f]{64}$/u.test(state.sha256) || typeof state.contentType !== "string" || state.contentType.length < 1 ||
    ![state.startKey, state.completeKey, state.cancelKey].every((key) => typeof key === "string" && key.length > 0) ||
    state.uploadId !== null && (typeof state.uploadId !== "string" || state.uploadId.length === 0) ||
    state.deadline !== null && !Number.isFinite(Date.parse(state.deadline)) ||
    !Number.isSafeInteger(state.offsetBytes) || state.offsetBytes < 0 || state.offsetBytes > state.sizeBytes ||
    !["start-pending", "uploading", "complete-pending", "verifying", "cancel-pending", "cancelled", "expired", "rejected"].includes(state.phase)
  ) invalid();
  if (state.target.kind === "mask" && state.contentType !== "image/png") invalid();
}

function validateTransition(before: PersonalPhotoResumableUploadState, after: PersonalPhotoResumableUploadState): void {
  validateState(after);
  if (
    !sameTarget(before.target, after.target) || before.sizeBytes !== after.sizeBytes || before.sha256 !== after.sha256 ||
    before.contentType !== after.contentType || before.startKey !== after.startKey || before.completeKey !== after.completeKey ||
    before.cancelKey !== after.cancelKey || before.uploadId !== null && before.uploadId !== after.uploadId ||
    before.deadline !== null && before.deadline !== after.deadline || after.offsetBytes < before.offsetBytes
  ) invalid();
}

function isTarget(value: UploadTarget): boolean {
  return value.kind === "original"
    ? typeof value.fileName === "string" && value.fileName.length > 0 && typeof value.format === "string"
    : value.kind === "mask" && typeof value.photoId === "string" && value.photoId.length > 0;
}
function sameTarget(left: UploadTarget, right: UploadTarget): boolean {
  return left.kind === "original" && right.kind === "original"
    ? left.fileName === right.fileName && left.format === right.format
    : left.kind === "mask" && right.kind === "mask" && left.photoId === right.photoId;
}
function sameState(left: PersonalPhotoResumableUploadState, right: PersonalPhotoResumableUploadState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function requiredUploadId(state: PersonalPhotoResumableUploadState): string { if (state.uploadId === null) invalid(); return state.uploadId; }
function parseProviderRange(value: string | null, offset: number, chunkEnd: number, total: number): number | null { if (value === null || value.includes(",")) return null; const match = /^bytes=0-(\d+)$/u.exec(value); if (!match) return null; const last = Number(match[1]); return Number.isSafeInteger(last) && last + 1 >= offset && last <= chunkEnd && last < total ? last + 1 : null; }
function completionDeadline(deadline: string): number { return Date.parse(deadline) + PHOTO_LIMITS.completionGraceSeconds * 1000; }
function terminal(phase: PersonalPhotoResumableUploadPhase): boolean { return ["cancelled", "expired", "rejected"].includes(phase); }
function fatalReconcileError(error: unknown): boolean {
  if (error instanceof PersonalPhotoCloudError && error.code === "invalid_response") return true;
  if (!isRecord(error) || !isRecord(error.error) || typeof error.error.code !== "string") return false;
  return ["upload_expired", "photo_deleted", "not_found", "content_rejected", "unsupported_format", "pixel_limit_exceeded"].includes(error.error.code);
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(): never { throw new PersonalPhotoCloudError("invalid_response"); }
