import { sha256 } from "@noble/hashes/sha2.js";
import {
  PersonalPhotoCloudError,
  PersonalPhotoScope,
  abortReason,
  awaitBounded,
  deepEqual,
  jsonStructuralFingerprint,
  linkedAbortController,
  projectRecipeSettings,
  readPhotoError,
  recipeCandidateBodyMatches,
  recipeCandidateMatches,
  validateJsonValue,
  validateLibrary,
  validatePhoto,
  validateRecipeConflict,
  validateRenderer,
} from "@niho/photo-cloud-library/protocol";
import {
  PHOTO_LIMITS,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoOperationMap,
  type RecipeConflict,
  type VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import { readDevelopMasks } from "niho-photo-editing/develop-engine/develop-masks";

import type {
  CreatePersonalPhotoRecipeSyncOptions,
  JournalPutAttempt,
  JournalResolutionAttempt,
  JournalResolutionProof,
  JournalStage,
  LocalRecipeCandidate,
  PendingWriterPage,
  PersonalPhotoRecipeSync,
  PersonalPhotoRecipeWriter,
  RecipeDraftSnapshot,
  RecipeConflictIntent,
  RecipeJournalScope,
  RecipeStageRef,
  RecipeWriterBinding,
  ReopenedPersonalPhotoRecipeWriter,
  ResolveRecipeConflictResult,
  SaveRecipeResult,
  StageCommitResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const SHA256 = /^[0-9a-f]{64}$/u;

interface RefState {
  readonly writer: Writer;
  readonly generation: number;
  readonly candidate: LocalRecipeCandidate;
  readonly settle: (result: StageCommitResult) => void;
  readonly committed: Promise<StageCommitResult>;
  result: StageCommitResult | null;
  attempt: JournalPutAttempt | null;
}

export function createPersonalPhotoRecipeSync(options: CreatePersonalPhotoRecipeSyncOptions): PersonalPhotoRecipeSync {
  return new Sync(options);
}

class Sync implements PersonalPhotoRecipeSync {
  readonly scope: RecipeJournalScope;
  readonly networkScope: PersonalPhotoScope;
  readonly timeoutMs: number;

  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly refs = new WeakMap<RecipeStageRef, RefState>();
  private readonly localLifecycle = new AbortController();
  private readonly writers = new Set<Writer>();
  private readonly releaseTasks = new Set<Promise<void>>();
  private readonly unsubscribeIdentity: () => void;
  private disposed = false;
  private localInvalid = false;

  constructor(readonly options: CreatePersonalPhotoRecipeSyncOptions) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) invalid();
    validateRenderer(options.hostRenderer);
    const actor = requiredActor(options.identity.getSnapshot(), this.now());
    if (options.client.scope.actorId !== actor.userId || options.client.scope.sessionEpoch !== actor.sessionEpoch || !nonEmpty(options.client.scope.libraryId)) invalidIdentity();
    this.scope = Object.freeze({
      actorId: actor.userId,
      libraryId: options.client.scope.libraryId,
      sessionId: actor.sessionId,
      sessionEpoch: actor.sessionEpoch,
      transport: actor.transport,
    });
    this.networkScope = new PersonalPhotoScope(options.client, options.identity, this.now);
    this.unsubscribeIdentity = options.identity.subscribe(() => this.identityChanged());
  }

  beginEditing(input: { readonly photoId: string; readonly sourceSha256: string; readonly expectedRevision: number }): PersonalPhotoRecipeWriter {
    this.assertBeginAllowed();
    validatePhotoBinding(input.photoId, input.sourceSha256, input.expectedRevision);
    const binding: RecipeWriterBinding = {
      ...this.scope,
      token: this.newId(),
      writerId: this.newId(),
      photoId: input.photoId,
      sourceSha256: input.sourceSha256,
      initialRevision: input.expectedRevision,
    };
    return this.register(new Writer(this, binding, 0));
  }

  async listPending(
    options: { readonly cursor?: string; readonly limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<PendingWriterPage> {
    this.assertLocal();
    const link = this.localLink(signal);
    try { return await this.journal(link.controller.signal, (operationSignal) => this.options.journal.list(this.scope, options, operationSignal)); }
    finally { link.dispose(); }
  }

  async reopen(token: string, signal?: AbortSignal): Promise<ReopenedPersonalPhotoRecipeWriter> {
    this.assertLocal();
    validateOpaque(token);
    const link = this.localLink(signal);
    try {
      const record = await this.journal(link.controller.signal, (operationSignal) => this.options.journal.reopen(this.scope, token, operationSignal));
      this.assertLocal();
      if (record === null) throw new PersonalPhotoCloudError("not_found");
      const writer = this.register(new Writer(this, record.binding, record.nextGeneration));
      const latest = record.latest === null ? null : writer.hydrate(record.latest);
      return {
        writer,
        latest,
        hasUnknownAttempt: record.attempt !== null || record.resolution !== null,
        pendingResolution: record.resolution === null ? null : publicIntent(record.resolution),
      };
    } finally { link.dispose(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.unsubscribeIdentity();
    for (const writer of [...this.writers]) writer.close(new PersonalPhotoCloudError("disposed"));
    this.disposed = true;
    this.localLifecycle.abort(new PersonalPhotoCloudError("disposed"));
    this.networkScope.dispose();
    this.writers.clear();
    const releases = [...this.releaseTasks];
    void Promise.allSettled(releases).then(() => this.options.journal.dispose());
  }

  createRef(writer: Writer, stage: JournalStage, alreadyCommitted = false): RecipeStageRef {
    let settlePromise!: (result: StageCommitResult) => void;
    const committed = new Promise<StageCommitResult>((resolve) => { settlePromise = resolve; });
    const state: RefState = {
      writer,
      generation: stage.generation,
      candidate: clone(stage.candidate),
      committed,
      settle: (result) => {
        if (state.result !== null) return;
        state.result = result;
        settlePromise(result);
      },
      result: null,
      attempt: null,
    };
    const ref = Object.freeze({ committed });
    this.refs.set(ref, state);
    if (alreadyCommitted) state.settle({ status: "committed", generation: stage.generation });
    return ref;
  }

  refState(ref: RecipeStageRef, writer: Writer): RefState {
    const state = this.refs.get(ref);
    if (state === undefined || state.writer !== writer) invalid();
    return state;
  }

  async withWriterLock<T>(
    writer: Writer,
    externalSignal: AbortSignal | undefined,
    run: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    writer.assertOpen();
    const scoped = this.networkScope.begin(externalSignal);
    const operation = linkedAbortController(scoped.signal, writer.signal);
    const lockName = `niho-photo-recipe:${digest(JSON.stringify([
      this.scope.actorId,
      this.scope.libraryId,
      this.scope.sessionId,
      this.scope.sessionEpoch,
      this.scope.transport,
      writer.binding.writerId,
    ]))}`;
    try {
      const promise = this.options.locks.request(lockName, { mode: "exclusive", signal: operation.controller.signal }, async () => {
        if (operation.controller.signal.aborted) throw abortReason(operation.controller.signal);
        scoped.assertCurrent();
        writer.assertOpen();
        return await run(operation.controller.signal, () => {
          if (operation.controller.signal.aborted) throw abortReason(operation.controller.signal);
          scoped.assertCurrent();
          writer.assertOpen();
        });
      });
      return await awaitBounded(promise, {
        signal: operation.controller.signal,
        timeoutMs: this.timeoutMs,
        onTimeout: () => operation.controller.abort(new PersonalPhotoCloudError("unavailable")),
      });
    } finally {
      operation.dispose();
      scoped.release();
    }
  }

  async request<K extends keyof PhotoOperationMap>(
    operation: K,
    request: PhotoOperationMap[K]["request"],
    options: K extends "uploads.start" | "uploads.complete" | "uploads.cancel" | "recipes.put" | "versions.put" | "recipe-conflicts.resolve" | "media.ensure" | "photos.delete"
      ? { readonly signal: AbortSignal; readonly idempotencyKey: string }
      : { readonly signal: AbortSignal },
    signal: AbortSignal,
  ): Promise<PhotoOperationMap[K]["response"]> {
    return await awaitBounded(this.options.client.request(operation, request, options as never), {
      signal,
      timeoutMs: this.timeoutMs,
    }) as PhotoOperationMap[K]["response"];
  }

  async journal<T>(signal: AbortSignal, invoke: (operationSignal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = linkedAbortController(this.localLifecycle.signal, signal);
    try {
      return await awaitBounded(invoke(operation.controller.signal), {
        signal: operation.controller.signal,
        timeoutMs: this.timeoutMs,
        onTimeout: () => operation.controller.abort(new PersonalPhotoCloudError("unavailable")),
      });
    } finally { operation.dispose(); }
  }

  releaseCompleted(binding: RecipeWriterBinding): void {
    const controller = new AbortController();
    let release: Promise<boolean>;
    try { release = this.options.journal.releaseCompleted(binding, controller.signal); }
    catch { return; }
    const task = awaitBounded(release, {
      signal: controller.signal,
      timeoutMs: this.timeoutMs,
      onTimeout: () => controller.abort(new PersonalPhotoCloudError("unavailable")),
    }).then(() => undefined, () => undefined);
    this.releaseTasks.add(task);
    void task.finally(() => this.releaseTasks.delete(task));
  }

  async preflight(
    binding: RecipeWriterBinding,
    candidate: LocalRecipeCandidate,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<{ readonly library: PersonalPhotoLibrary; readonly photo: Photo } | null> {
    const libraryRaw = await this.request("library.get", {}, { signal }, signal);
    assertCurrent();
    const library = validateLibrary(libraryRaw, this.scope.actorId, this.scope.libraryId);
    const photoRaw = await this.request("photos.get", { photoId: binding.photoId }, { signal }, signal);
    assertCurrent();
    const photo = validatePhoto(photoRaw, this.scope.libraryId);
    if (photo.id !== binding.photoId || photo.original.sha256 !== binding.sourceSha256 || !library.capabilities.edits) return null;
    if (projectRecipeSettings(photo, library, this.options.hostRenderer) === null || !candidateUsable(candidate, photo, library, this.options.hostRenderer)) return null;
    return { library, photo };
  }

  assertLocal(): void {
    if (this.disposed) throw new PersonalPhotoCloudError("disposed");
    if (this.localInvalid) throw new PersonalPhotoCloudError("scope_changed");
    const actor = this.options.identity.getSnapshot();
    if (actor === null || !sameActorScope(actor, this.scope) || !sameClientScope(this.options.client.scope, this.scope)) {
      this.invalidateLocal();
      throw new PersonalPhotoCloudError("scope_changed");
    }
  }

  unregister(writer: Writer): void { this.writers.delete(writer); }

  newId(): string {
    const value = this.randomId();
    validateOpaque(value);
    if (new TextEncoder().encode(value).byteLength > PHOTO_LIMITS.maxIdempotencyKeyBytes) invalid();
    return value;
  }

  private register(writer: Writer): Writer { this.writers.add(writer); return writer; }

  private assertBeginAllowed(): void {
    this.assertLocal();
    requiredActor(this.options.identity.getSnapshot(), this.now());
  }

  private localLink(signal?: AbortSignal): ReturnType<typeof linkedAbortController> {
    return signal === undefined ? linkedAbortController(this.localLifecycle.signal) : linkedAbortController(this.localLifecycle.signal, signal);
  }

  private identityChanged(): void {
    if (this.disposed || this.localInvalid) return;
    const actor = this.options.identity.getSnapshot();
    if (actor === null || !sameActorScope(actor, this.scope) || !sameClientScope(this.options.client.scope, this.scope)) this.invalidateLocal();
  }

  private invalidateLocal(): void {
    if (this.localInvalid) return;
    this.localInvalid = true;
    this.localLifecycle.abort(new PersonalPhotoCloudError("scope_changed"));
    for (const writer of this.writers) writer.close(new PersonalPhotoCloudError("scope_changed"));
  }
}

class Writer implements PersonalPhotoRecipeWriter {
  readonly token: string;
  readonly lifecycle = new AbortController();
  readonly signal = this.lifecycle.signal;

  private nextGeneration: number;
  private activeStage = false;
  private queuedStage: RefState | null = null;
  private disposed = false;

  constructor(readonly sync: Sync, readonly binding: RecipeWriterBinding, nextGeneration: number) {
    this.token = binding.token;
    this.nextGeneration = nextGeneration;
  }

  stage(input: LocalRecipeCandidate): RecipeStageRef {
    this.assertOpen();
    this.sync.assertLocal();
    const candidate = validateCandidate(input);
    const stage = { generation: this.nextGeneration, candidate };
    this.nextGeneration += 1;
    const ref = this.sync.createRef(this, stage);
    const state = this.sync.refState(ref, this);
    if (!this.activeStage) this.startStage(state);
    else {
      this.queuedStage?.settle({ status: "superseded" });
      this.queuedStage = state;
    }
    return ref;
  }

  hydrate(stage: JournalStage): RecipeStageRef {
    return this.sync.createRef(this, stage, true);
  }

  async readDraft(signal?: AbortSignal): Promise<RecipeDraftSnapshot> {
    this.assertOpen();
    this.sync.assertLocal();
    const link = signal === undefined
      ? linkedAbortController(this.signal)
      : linkedAbortController(this.signal, signal);
    try {
      const reopened = await this.sync.journal(link.controller.signal, (journalSignal) =>
        this.sync.options.journal.reopen(this.sync.scope, this.token, journalSignal));
      this.sync.assertLocal();
      this.assertOpen();
      if (reopened === null) throw new PersonalPhotoCloudError("not_found");
      return Object.freeze({
        photoId: reopened.binding.photoId,
        sourceSha256: reopened.binding.sourceSha256,
        initialRevision: reopened.binding.initialRevision,
        latest: reopened.latest === null
          ? null
          : Object.freeze({ ...clone(reopened.latest), ref: this.hydrate(reopened.latest) }),
        attempted: reopened.attempt === null
          ? null
          : Object.freeze({
              generation: reopened.attempt.generation,
              candidate: clone(reopened.attempt.candidate),
            }),
        conflictIds: Object.freeze([...reopened.conflictIds]),
        hasUnknownAttempt: reopened.attempt !== null || reopened.resolution !== null,
        pendingResolution: reopened.resolution === null ? null : publicIntent(reopened.resolution),
        terminalReason: reopened.terminalReason,
      });
    } finally {
      link.dispose();
    }
  }

  async save(ref: RecipeStageRef, signal?: AbortSignal): Promise<SaveRecipeResult> {
    this.assertOpen();
    const state = this.sync.refState(ref, this);
    const committed = await state.committed;
    if (committed.status === "superseded") return { status: "superseded" };
    if (committed.status === "unsaved") return { status: "unsaved" };
    try {
      return await this.sync.withWriterLock(this, signal, async (operationSignal, assertCurrent) => {
        return await this.saveStage({ generation: state.generation, candidate: state.candidate }, operationSignal, assertCurrent, state);
      });
    } catch (error) {
      if (isCallerAbort(signal, error)) throw error;
      return { status: "unknown", generation: state.generation };
    }
  }

  async retry(signal?: AbortSignal): Promise<SaveRecipeResult> {
    this.assertOpen();
    try {
      return await this.sync.withWriterLock(this, signal, async (operationSignal, assertCurrent) => {
        const reopened = await this.sync.journal(operationSignal, (journalSignal) => this.sync.options.journal.reopen(this.sync.scope, this.token, journalSignal));
        assertCurrent();
        if (reopened === null) throw new PersonalPhotoCloudError("not_found");
        if (reopened.terminalReason !== null) {
          return { status: "terminal", generation: Math.max(0, this.nextGeneration - 1), reason: reopened.terminalReason };
        }
        if (reopened.resolution !== null) return { status: "unknown", generation: reopened.resolution.proof.originGeneration ?? Math.max(0, this.nextGeneration - 1) };
        if (reopened.attempt !== null) return await this.sendAttempt(reopened.attempt, operationSignal, assertCurrent);
        if (reopened.latest !== null) return await this.saveStage(reopened.latest, operationSignal, assertCurrent);
        return { status: "unsaved" };
      });
    } catch (error) {
      if (isCallerAbort(signal, error)) throw error;
      const generation = Math.max(0, this.nextGeneration - 1);
      return { status: "unknown", generation };
    }
  }

  async retryResolution(signal?: AbortSignal): Promise<ResolveRecipeConflictResult> {
    this.assertOpen();
    try {
      return await this.sync.withWriterLock(this, signal, async (operationSignal, assertCurrent) => {
        const reopened = await this.sync.journal(operationSignal, (journalSignal) => this.sync.options.journal.reopen(this.sync.scope, this.token, journalSignal));
        assertCurrent();
        if (reopened === null) throw new PersonalPhotoCloudError("not_found");
        if (reopened.terminalReason !== null) return { status: "terminal", reason: reopened.terminalReason };
        if (reopened.resolution !== null) return await this.sendResolution(reopened.resolution, operationSignal, assertCurrent);
        if (reopened.knownResolution?.outcome === "stale") return { status: "stale" };
        return { status: "unknown" };
      });
    } catch (error) {
      if (isCallerAbort(signal, error)) throw error;
      return { status: "unknown" };
    }
  }

  async getConflict(conflictId: string, signal?: AbortSignal): Promise<RecipeConflict> {
    validateOpaque(conflictId);
    return await this.sync.withWriterLock(this, signal, async (operationSignal, assertCurrent) => {
      const conflict = await this.sync.request("recipe-conflicts.get", { photoId: this.binding.photoId, conflictId }, { signal: operationSignal }, operationSignal);
      assertCurrent();
      validateRecipeConflict(conflict);
      if (conflict.id !== conflictId) invalidResponse();
      return conflict;
    });
  }

  async resolveConflict(intent: RecipeConflictIntent, signal?: AbortSignal): Promise<ResolveRecipeConflictResult> {
    validateConflictIntent(intent);
    try {
      return await this.sync.withWriterLock(this, signal, async (operationSignal, assertCurrent) => {
        const reopened = await this.sync.journal(operationSignal, (journalSignal) => this.sync.options.journal.reopen(this.sync.scope, this.token, journalSignal));
        assertCurrent();
        if (reopened?.terminalReason !== undefined && reopened.terminalReason !== null) return { status: "terminal", reason: reopened.terminalReason };
        if (reopened?.resolution !== undefined && reopened.resolution !== null) {
          if (!sameIntent(reopened.resolution, intent)) return { status: "unknown" };
          return await this.sendResolution(reopened.resolution, operationSignal, assertCurrent);
        }
        if (reopened?.knownResolution !== undefined && reopened.knownResolution !== null && sameIntent(reopened.knownResolution, intent)) return { status: "stale" };
        if (reopened?.attempt !== undefined && reopened.attempt !== null) {
          const prior = await this.sendAttempt(reopened.attempt, operationSignal, assertCurrent);
          if (prior.status === "unknown") return { status: "unknown" };
          if (prior.status === "terminal") return { status: "terminal", reason: prior.reason };
        }
        const refreshed = await this.sync.journal(operationSignal, (journalSignal) => this.sync.options.journal.reopen(this.sync.scope, this.token, journalSignal));
        assertCurrent();
        const metadata = refreshed?.conflicts.find((item) => item.conflictId === intent.conflictId);
        const originGeneration = metadata?.generation ?? null;
        let photo: Photo;
        try {
          const raw = await this.sync.request("photos.get", { photoId: this.binding.photoId }, { signal: operationSignal }, operationSignal);
          assertCurrent();
          photo = validatePhoto(raw, this.binding.libraryId);
        } catch (error) {
          const terminal = await this.terminalConflictFromPhotoError(originGeneration, intent.conflictId, error, operationSignal, assertCurrent);
          if (terminal !== null) return terminal;
          throw error;
        }
        if (photo.id !== this.binding.photoId || photo.original.sha256 !== this.binding.sourceSha256) return { status: "unsupported" };
        if (photo.recipe.revision !== intent.expectedRevision) return { status: "stale" };
        const libraryRaw = await this.sync.request("library.get", {}, { signal: operationSignal }, operationSignal);
        assertCurrent();
        const library = validateLibrary(libraryRaw, this.binding.actorId, this.binding.libraryId);
        if (!library.capabilities.edits) return { status: "unsupported" };
        let conflict: RecipeConflict;
        try {
          conflict = await this.sync.request("recipe-conflicts.get", {
            photoId: this.binding.photoId,
            conflictId: intent.conflictId,
          }, { signal: operationSignal }, operationSignal);
        } catch (error) {
          const backend = readPhotoError(error);
          if (backend?.code === "photo_deleted") {
            const terminal = await this.terminalConflictFromPhotoError(originGeneration, intent.conflictId, error, operationSignal, assertCurrent);
            return terminal ?? { status: "unknown" };
          }
          if (backend?.code === "not_found") {
            const terminal = await this.confirmConflictPurge(originGeneration, intent.conflictId, operationSignal, assertCurrent);
            return terminal ?? { status: "stale" };
          }
          throw error;
        }
        assertCurrent();
        validateRecipeConflict(conflict);
        if (conflict.id !== intent.conflictId || conflict.resolution !== null) return { status: "stale" };
        const conflictSnapshotSha256 = jsonStructuralFingerprint(conflict);
        if (metadata !== undefined && conflictSnapshotSha256 !== metadata.snapshotSha256) return { status: "unknown" };
        let proof: JournalResolutionProof;
        if (intent.decision === "adopt") {
          const candidate: LocalRecipeCandidate = {
            settings: clone(conflict.conflictingRecipe.settings),
            baseVersion: conflict.conflictingRecipe.baseVersion,
            maskSurfaceIds: clone(conflict.conflictingRecipe.maskSurfaceIds),
          };
          if (!candidateUsable(candidate, photo, library, this.sync.options.hostRenderer)) return { status: "unsupported" };
          proof = {
            decision: "adopt",
            conflictSnapshotSha256,
            originGeneration,
            expectedResultingRevision: intent.expectedRevision + 1,
            selectedCandidate: clone(conflict.conflictingRecipe),
          };
        } else {
          proof = {
            decision: "keep-current",
            conflictSnapshotSha256,
            originGeneration,
            expectedResultingRevision: intent.expectedRevision,
            selectedRecipe: clone(photo.recipe),
          };
        }
        const resolution = await this.sync.journal(operationSignal, (journalSignal) => this.sync.options.journal.createResolution(
          this.binding,
          intent,
          proof,
          this.sync.newId(),
          this.sync.newId(),
          journalSignal,
        ));
        assertCurrent();
        return await this.sendResolution(resolution, operationSignal, assertCurrent);
      });
    } catch (error) {
      if (isCallerAbort(signal, error)) throw error;
      return { status: "unknown" };
    }
  }

  async discard(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const link = signal === undefined ? linkedAbortController(this.signal) : linkedAbortController(this.signal, signal);
    try { await this.sync.journal(link.controller.signal, (journalSignal) => this.sync.options.journal.discard(this.binding, journalSignal)); }
    finally { link.dispose(); }
  }

  dispose(): void { this.close(new PersonalPhotoCloudError("disposed")); }

  close(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort(error);
    this.queuedStage?.settle({ status: "unsaved", reason: "unavailable" });
    this.queuedStage = null;
    this.sync.unregister(this);
    this.sync.releaseCompleted(this.binding);
  }

  assertOpen(): void {
    if (this.disposed) throw new PersonalPhotoCloudError("disposed");
  }

  private startStage(state: RefState): void {
    this.activeStage = true;
    void this.commitStage(state).finally(() => {
      this.activeStage = false;
      const next = this.queuedStage;
      this.queuedStage = null;
      if (next !== null && !this.disposed) this.startStage(next);
      else if (next !== null) next.settle({ status: "unsaved", reason: "unavailable" });
    });
  }

  private async commitStage(state: RefState): Promise<void> {
    try {
      await this.sync.journal(this.signal, (journalSignal) => this.sync.options.journal.stage(this.binding, {
        generation: state.generation,
        candidate: state.candidate,
      }, journalSignal));
      if (this.signal.aborted) throw this.signal.reason;
      state.settle({ status: "committed", generation: state.generation });
    } catch (error) {
      state.settle({ status: "unsaved", reason: isQuota(error) ? "quota" : "unavailable" });
    }
  }

  private async saveStage(
    stage: JournalStage,
    signal: AbortSignal,
    assertCurrent: () => void,
    refState?: RefState,
  ): Promise<SaveRecipeResult> {
    const reopened = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.reopen(this.sync.scope, this.token, journalSignal));
    assertCurrent();
    if (reopened === null) throw new PersonalPhotoCloudError("not_found");
    if (reopened.terminalReason !== null) {
      return { status: "terminal", generation: stage.generation, reason: reopened.terminalReason };
    }
    if (reopened.resolution !== null) return { status: "unknown", generation: stage.generation };
    if (reopened.attempt !== null) {
      if (reopened.attempt.generation === stage.generation && refState !== undefined) refState.attempt = reopened.attempt;
      const old = await this.sendAttempt(reopened.attempt, signal, assertCurrent);
      if (old.status === "unknown" || old.status === "terminal") return old;
      if (reopened.attempt.generation === stage.generation) return old;
    }
    const retainedAttempt = refState?.attempt;
    if (retainedAttempt !== undefined && retainedAttempt !== null) return await this.sendAttempt(retainedAttempt, signal, assertCurrent);
    try {
      if (await this.sync.preflight(this.binding, stage.candidate, signal, assertCurrent) === null) {
        return { status: "unsupported", generation: stage.generation };
      }
    } catch (error) {
      const backend = readPhotoError(error);
      if (backend?.code === "not_found" || backend?.code === "photo_deleted") {
        assertCurrent();
        const reason = backend.code === "not_found" ? "not-found" as const : "photo-deleted" as const;
        const terminal = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.terminalStage(this.binding, stage.generation, reason, journalSignal));
        assertCurrent();
        return terminal ? { status: "terminal", generation: stage.generation, reason } : { status: "unknown", generation: stage.generation };
      }
      throw error;
    }
    const attempt = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.createAttempt(
      this.binding,
      stage,
      this.sync.newId(),
      this.sync.newId(),
      journalSignal,
    ));
    assertCurrent();
    if (refState !== undefined) refState.attempt = attempt;
    return await this.sendAttempt(attempt, signal, assertCurrent);
  }

  private async sendAttempt(
    attempt: JournalPutAttempt,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<SaveRecipeResult> {
    verifyPutAttempt(attempt);
    if (attempt.conflictId !== null) return await this.finishConflict(attempt, attempt.conflictId, signal, assertCurrent);
    const body = parseRecord(attempt.requestBody);
    try {
      const receipt = await this.sync.request("recipes.put", {
        photoId: this.binding.photoId,
        expectedRevision: body.expectedRevision as number,
        settings: body.settings as LocalRecipeCandidate["settings"],
        baseVersion: body.baseVersion as string | null,
      }, { signal, idempotencyKey: attempt.idempotencyKey }, signal);
      assertCurrent();
      const photo = receipt.value;
      if (
        photo.id !== this.binding.photoId || photo.libraryId !== this.binding.libraryId ||
        photo.original.sha256 !== this.binding.sourceSha256 ||
        photo.recipe.revision !== attempt.expectedRevision + 1 ||
        !recipeCandidateBodyMatches(attempt.candidate, photo.recipe)
      ) return { status: "unknown", generation: attempt.generation };
      const acknowledged = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.acknowledgeAttempt(
        this.binding,
        attempt.attemptId,
        attempt.generation,
        photo.recipe.revision,
        journalSignal,
      ));
      assertCurrent();
      return acknowledged
        ? { status: "saved", generation: attempt.generation, recipe: photo.recipe, replayed: receipt.replayed }
        : { status: "unknown", generation: attempt.generation };
    } catch (error) {
      const backend = readPhotoError(error);
      if (backend?.code === "revision_conflict" && backend.conflictId !== null) {
        const conflictId = backend.conflictId;
        assertCurrent();
        const recorded = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.conflictAttempt(
          this.binding,
          attempt.attemptId,
          attempt.generation,
          conflictId,
          null,
          journalSignal,
        ));
        assertCurrent();
        if (!recorded) return { status: "unknown", generation: attempt.generation };
        return await this.finishConflict({ ...attempt, conflictId }, conflictId, signal, assertCurrent);
      }
      if (backend?.code === "not_found" || backend?.code === "photo_deleted") {
        assertCurrent();
        const reason = backend.code === "not_found" ? "not-found" as const : "photo-deleted" as const;
        const terminal = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.terminalAttempt(this.binding, attempt.attemptId, attempt.generation, reason, journalSignal));
        assertCurrent();
        return terminal
          ? { status: "terminal", generation: attempt.generation, reason }
          : { status: "unknown", generation: attempt.generation };
      }
      return { status: "unknown", generation: attempt.generation };
    }
  }

  private async finishConflict(
    attempt: JournalPutAttempt,
    conflictId: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<SaveRecipeResult> {
    try {
      const conflict = await this.sync.request("recipe-conflicts.get", {
        photoId: this.binding.photoId,
        conflictId,
      }, { signal }, signal);
      assertCurrent();
      validateRecipeConflict(conflict);
      if (
        conflict.id !== conflictId || conflict.expectedRevision !== attempt.expectedRevision ||
        !recipeCandidateBodyMatches(attempt.candidate, conflict.conflictingRecipe)
      ) return { status: "unknown", generation: attempt.generation };
      const finalized = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.conflictAttempt(
        this.binding,
        attempt.attemptId,
        attempt.generation,
        conflictId,
        jsonStructuralFingerprint(conflict),
        journalSignal,
      ));
      assertCurrent();
      return finalized
        ? { status: "conflict", generation: attempt.generation, conflict }
        : { status: "unknown", generation: attempt.generation };
    } catch (error) {
      const backend = readPhotoError(error);
      if (backend?.code === "photo_deleted") {
        const reason = "photo-deleted" as const;
        const terminal = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.terminalAttempt(this.binding, attempt.attemptId, attempt.generation, reason, journalSignal));
        assertCurrent();
        return terminal ? { status: "terminal", generation: attempt.generation, reason } : { status: "unknown", generation: attempt.generation };
      }
      if (backend?.code === "not_found") {
        try {
          const photo = await this.sync.request("photos.get", { photoId: this.binding.photoId }, { signal }, signal);
          assertCurrent();
          validatePhoto(photo, this.binding.libraryId);
        } catch (photoError) {
          const photoBackend = readPhotoError(photoError);
          if (photoBackend?.code === "not_found" || photoBackend?.code === "photo_deleted") {
            const reason = photoBackend.code === "not_found" ? "not-found" as const : "photo-deleted" as const;
            const terminal = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.terminalAttempt(this.binding, attempt.attemptId, attempt.generation, reason, journalSignal));
            assertCurrent();
            return terminal ? { status: "terminal", generation: attempt.generation, reason } : { status: "unknown", generation: attempt.generation };
          }
        }
      }
      return { status: "unknown", generation: attempt.generation };
    }
  }

  private async terminalConflictFromPhotoError(
    generation: number | null,
    conflictId: string,
    error: unknown,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<ResolveRecipeConflictResult | null> {
    const backend = readPhotoError(error);
    if (backend?.code !== "not_found" && backend?.code !== "photo_deleted") return null;
    const reason = backend.code === "not_found" ? "not-found" as const : "photo-deleted" as const;
    assertCurrent();
    const terminal = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.terminalConflict(this.binding, conflictId, generation, reason, journalSignal));
    assertCurrent();
    return terminal ? { status: "terminal", reason } : { status: "unknown" };
  }

  private async confirmConflictPurge(
    generation: number | null,
    conflictId: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<ResolveRecipeConflictResult | null> {
    try {
      const photo = await this.sync.request("photos.get", { photoId: this.binding.photoId }, { signal }, signal);
      assertCurrent();
      validatePhoto(photo, this.binding.libraryId);
      return null;
    } catch (error) {
      return await this.terminalConflictFromPhotoError(generation, conflictId, error, signal, assertCurrent);
    }
  }

  private async sendResolution(
    attempt: JournalResolutionAttempt,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<ResolveRecipeConflictResult> {
    verifyResolutionAttempt(attempt);
    const body = parseRecord(attempt.requestBody);
    try {
      const receipt = await this.sync.request("recipe-conflicts.resolve", {
        photoId: this.binding.photoId,
        conflictId: attempt.conflictId,
        expectedRevision: body.expectedRevision as number,
        decision: body.decision as "adopt" | "keep-current",
      }, { signal, idempotencyKey: attempt.idempotencyKey }, signal);
      assertCurrent();
      const value = receipt.value;
      const unresolvedConflict = {
        ...value.conflict,
        resolution: null,
        resolvedAt: null,
        resultingRevision: null,
      };
      const selectedMatches = attempt.proof.decision === "adopt"
        ? recipeCandidateMatches(attempt.proof.selectedCandidate, value.recipe)
        : deepEqual(attempt.proof.selectedRecipe, value.recipe);
      if (
        value.conflict.id !== attempt.conflictId || value.conflict.resolution !== attempt.decision ||
        value.conflict.resultingRevision !== value.recipe.revision ||
        value.recipe.revision !== attempt.proof.expectedResultingRevision ||
        jsonStructuralFingerprint(unresolvedConflict) !== attempt.proof.conflictSnapshotSha256 ||
        !selectedMatches
      ) return { status: "unknown" };
      const settled = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.settleResolution(this.binding, attempt.attemptId, "resolved", journalSignal));
      assertCurrent();
      return settled ? { status: "resolved", resolution: value, replayed: receipt.replayed } : { status: "unknown" };
    } catch (error) {
      const backend = readPhotoError(error);
      if (backend?.code === "revision_conflict") {
        assertCurrent();
        const settled = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.settleResolution(this.binding, attempt.attemptId, "stale", journalSignal));
        assertCurrent();
        return settled ? { status: "stale" } : { status: "unknown" };
      }
      if (backend?.code === "not_found") {
        const terminal = await this.confirmConflictPurge(attempt.proof.originGeneration, attempt.conflictId, signal, assertCurrent);
        if (terminal === null) {
          const settled = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.settleResolution(this.binding, attempt.attemptId, "stale", journalSignal));
          assertCurrent();
          return settled ? { status: "stale" } : { status: "unknown" };
        }
        if (terminal.status !== "terminal") return terminal;
        return terminal;
      }
      if (backend?.code === "photo_deleted") {
        assertCurrent();
        const reason = "photo-deleted" as const;
        const settled = await this.sync.journal(signal, (journalSignal) => this.sync.options.journal.settleResolution(this.binding, attempt.attemptId, "terminal-photo-deleted", journalSignal));
        assertCurrent();
        return settled ? { status: "terminal", reason } : { status: "unknown" };
      }
      return { status: "unknown" };
    }
  }
}

function candidateUsable(
  candidate: LocalRecipeCandidate,
  photo: Photo,
  library: PersonalPhotoLibrary,
  hostRenderer: CreatePersonalPhotoRecipeSyncOptions["hostRenderer"],
): boolean {
  if (photo.format === "raw" || candidate.baseVersion !== null || candidate.maskSurfaceIds.length > 0) return false;
  if (candidate.settings.base !== undefined && candidate.settings.base !== null) return false;
  if (readDevelopMasks(candidate.settings).length > 0) return false;
  const projected: Photo = {
    ...photo,
    recipe: {
      ...photo.recipe,
      settings: candidate.settings,
      baseVersion: candidate.baseVersion,
      maskSurfaceIds: candidate.maskSurfaceIds,
    },
  };
  return projectRecipeSettings(projected, library, hostRenderer) !== null;
}

function validateCandidate(input: LocalRecipeCandidate): LocalRecipeCandidate {
  if (!isRecord(input) || !exactKeys(input, ["settings", "baseVersion", "maskSurfaceIds"]) || !isRecord(input.settings) || !safeNonNegative(input.settings.v) || !nonEmpty(input.settings.engine) || input.baseVersion !== null && !nonEmpty(input.baseVersion) || !Array.isArray(input.maskSurfaceIds) || !input.maskSurfaceIds.every((item) => typeof item === "string" && SHA256.test(item)) || new Set(input.maskSurfaceIds).size !== input.maskSurfaceIds.length) invalid();
  validateJsonValue(input.settings, PHOTO_LIMITS.maxRecipeBytes);
  validateJsonValue(input, PHOTO_LIMITS.maxRecipeBodyBytes, PHOTO_LIMITS.maxJsonDepth + 1);
  return clone(input);
}

function verifyPutAttempt(attempt: JournalPutAttempt): void {
  if (digest(attempt.requestBody) !== attempt.requestBytesSha256) invalidResponse();
  const body = parseRecord(attempt.requestBody);
  if (!exactKeys(body, ["expectedRevision", "settings", "baseVersion"]) || body.expectedRevision !== attempt.expectedRevision || !deepEqual(body.settings, attempt.candidate.settings) || body.baseVersion !== attempt.candidate.baseVersion) invalidResponse();
}

function verifyResolutionAttempt(attempt: JournalResolutionAttempt): void {
  if (digest(attempt.requestBody) !== attempt.requestBytesSha256) invalidResponse();
  const body = parseRecord(attempt.requestBody);
  if (
    !exactKeys(body, ["expectedRevision", "decision"]) || body.expectedRevision !== attempt.expectedRevision || body.decision !== attempt.decision ||
    attempt.proof.decision !== attempt.decision || !SHA256.test(attempt.proof.conflictSnapshotSha256) ||
    attempt.proof.originGeneration !== null && !safeNonNegative(attempt.proof.originGeneration) ||
    attempt.proof.expectedResultingRevision !== (attempt.decision === "adopt" ? attempt.expectedRevision + 1 : attempt.expectedRevision)
  ) invalidResponse();
  validateJsonValue(attempt.proof, PHOTO_LIMITS.maxRecipeBodyBytes, PHOTO_LIMITS.maxJsonDepth + 2);
}

function parseRecord(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); if (isRecord(parsed)) return parsed; }
  catch { /* closed below */ }
  invalidResponse();
}

function validateConflictIntent(intent: RecipeConflictIntent): void {
  if (!isRecord(intent) || !exactKeys(intent, ["intentId", "conflictId", "decision", "expectedRevision"]) || intent.decision !== "adopt" && intent.decision !== "keep-current" || !safeNonNegative(intent.expectedRevision)) invalid();
  validateOpaque(intent.intentId);
  validateOpaque(intent.conflictId);
}

function sameIntent(
  attempt: Pick<JournalResolutionAttempt, "intentId" | "conflictId" | "decision" | "expectedRevision">,
  intent: RecipeConflictIntent,
): boolean {
  return attempt.intentId === intent.intentId && attempt.conflictId === intent.conflictId && attempt.decision === intent.decision && attempt.expectedRevision === intent.expectedRevision;
}

function publicIntent(attempt: JournalResolutionAttempt): RecipeConflictIntent {
  return Object.freeze({
    intentId: attempt.intentId,
    conflictId: attempt.conflictId,
    decision: attempt.decision,
    expectedRevision: attempt.expectedRevision,
  });
}

function requiredActor(actor: VerifiedPhotoActor | null, now: number): VerifiedPhotoActor {
  if (actor === null || !nonEmpty(actor.userId) || !nonEmpty(actor.sessionId) || !nonEmpty(actor.sessionEpoch) || actor.transport !== "browser-session" && actor.transport !== "mac-bearer" || !Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now) invalidIdentity();
  return actor;
}

function sameActorScope(actor: VerifiedPhotoActor, scope: RecipeJournalScope): boolean {
  return actor.userId === scope.actorId && actor.sessionId === scope.sessionId && actor.sessionEpoch === scope.sessionEpoch && actor.transport === scope.transport;
}

function sameClientScope(
  client: { readonly actorId: string; readonly libraryId: string; readonly sessionEpoch: string },
  scope: RecipeJournalScope,
): boolean {
  return client.actorId === scope.actorId && client.libraryId === scope.libraryId && client.sessionEpoch === scope.sessionEpoch;
}

function validatePhotoBinding(photoId: string, sourceSha256: string, expectedRevision: number): void {
  validateOpaque(photoId);
  if (!SHA256.test(sourceSha256) || !safeNonNegative(expectedRevision)) invalid();
}

function digest(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isQuota(error: unknown): boolean { return error instanceof DOMException && error.name === "QuotaExceededError" || error instanceof Error && error.name === "QuotaExceededError"; }
function isCallerAbort(signal: AbortSignal | undefined, error: unknown): boolean { return signal?.aborted === true && (error === signal.reason || error instanceof Error && error.name === "AbortError"); }
function clone<T>(value: T): T { try { return structuredClone(value); } catch { invalid(); } }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value); }
function validateOpaque(value: unknown): asserts value is string { if (!nonEmpty(value) || new TextEncoder().encode(value).byteLength > 512) invalid(); }
function invalid(): never { throw new PersonalPhotoCloudError("invalid_response"); }
function invalidIdentity(): never { throw new PersonalPhotoCloudError("invalid_identity"); }
function invalidResponse(): never { throw new PersonalPhotoCloudError("invalid_response"); }
