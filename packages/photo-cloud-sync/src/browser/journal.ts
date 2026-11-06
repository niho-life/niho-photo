import { sha256 } from "@noble/hashes/sha2.js";
import { awaitBounded, deepEqual, jsonStructuralFingerprint, validateJsonValue, validateRecipeCandidate } from "@niho/photo-cloud-library/protocol";
import { PHOTO_LIMITS } from "@niho/photo-personal-cloud-contract";

import type {
  JournalPutAttempt,
  JournalConflictMetadata,
  JournalKnownResolution,
  JournalResolutionAttempt,
  JournalResolutionProof,
  JournalStage,
  JournalPreviousPendingWriter,
  JournalPreviousPendingWriterPage,
  MaskSurfaceInput,
  MaskSurfacePinLease,
  MaskSurfaceUploadState,
  PendingWriterPage,
  PendingWriterToken,
  PersistedMaskSurface,
  RecipeConflictIntent,
  RecipeJournalScope,
  RecipeSyncJournal,
  RecipeWriterBinding,
  ReopenedJournalWriter,
} from "../types";

const DATABASE_VERSION = 3;
const WRITERS = "writers";
const META = "meta";
const MASKS = "masks";
const SCOPE_FENCES = "scopeFences";
const SCOPE_TOKEN = "scopeToken";
const MASK_SCOPE = "maskScope";
const IDB_TIMEOUT_MS = 15_000;
const MAX_SCOPE_WRITERS = 16;
const MAX_SCOPE_BYTES = 32 * 1024 ** 2;
const MAX_GLOBAL_WRITERS = 64;
const MAX_GLOBAL_BYTES = 128 * 1024 ** 2;
const MAX_SCOPE_MASKS = 128;
const MAX_GLOBAL_MASKS = 512;
const MAX_LIST_COUNT = 16;
const MAX_LIST_BYTES = 4 * 1024 ** 2;
const SHA256 = /^[0-9a-f]{64}$/u;
const NEVER_ABORTS = new AbortController().signal;

interface WriterRecord extends RecipeWriterBinding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly nextGeneration: number;
  readonly lastAckGeneration: number;
  readonly lastAckRevision: number;
  readonly latest: JournalStage | null;
  readonly attempt: JournalPutAttempt | null;
  readonly resolution: JournalResolutionAttempt | null;
  readonly conflicts: readonly JournalConflictMetadata[];
  readonly knownResolution: JournalKnownResolution | null;
  readonly terminalReason: "not-found" | "photo-deleted" | null;
}

interface BudgetRecord {
  readonly key: string;
  readonly writers: number;
  readonly masks: number;
  readonly bytes: number;
}

interface MaskRecord extends RecipeJournalScope {
  readonly schemaVersion: 1 | 2;
  readonly key: string;
  readonly photoId: string;
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly contentType: "image/png";
  readonly bytes: Uint8Array;
  readonly uploadState: MaskSurfaceUploadState | null;
  readonly pinned: boolean;
  readonly pinLeases?: readonly MaskSurfacePinLease[];
}

export class IndexedDbRecipeSyncJournal implements RecipeSyncJournal {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private disposed = false;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = "niho-personal-photo-recipe-sync-v1",
  ) {}

  async stage(
    binding: RecipeWriterBinding,
    stage: JournalStage,
    signal?: AbortSignal,
    releaseMaskLeases: readonly MaskSurfacePinLease[] = [],
  ): Promise<void> {
    validateBinding(binding);
    validateStage(stage);
    validateLeaseList(releaseMaskLeases, binding.token);
    if (releaseMaskLeases.length === 0) {
      await this.mutate(binding, signal, (current) => {
        if (stage.generation < current.nextGeneration) unavailable();
        return {
          ...current,
          revision: current.revision + 1,
          nextGeneration: stage.generation + 1,
          latest: clone(stage),
        };
      }, stage.generation);
      return;
    }
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, MASKS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), binding, transaction, signal);
    const writers = transaction.objectStore(WRITERS);
    const raw = await transactionWait(requestResult(writers.get(recordId(binding))), transaction, signal);
    const current = raw === undefined ? initialRecord(binding, stage.generation) : validateRecord(raw);
    if (!sameBinding(current, binding) || stage.generation < current.nextGeneration) { abort(transaction); unavailable(); }
    const next = {
      ...current,
      revision: current.revision + 1,
      nextGeneration: stage.generation + 1,
      latest: clone(stage),
    };
    validateRecord(next);
    await updateCombinedBudgets(transaction.objectStore(META), binding, raw === undefined ? 1 : 0, 0,
      jsonBytes(next) - (raw === undefined ? 0 : jsonBytes(current)), signal, transaction);
    writers.put(next);
    await releaseLeasesInTransaction(transaction, binding, releaseMaskLeases, signal);
    await transactionWait(barrier, transaction, signal);
  }

  async createAttempt(
    binding: RecipeWriterBinding,
    stage: JournalStage,
    attemptId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<JournalPutAttempt> {
    validateBinding(binding);
    validateStage(stage);
    validateOpaque(attemptId);
    validateKey(idempotencyKey);
    let result: JournalPutAttempt | null = null;
    await this.mutate(binding, signal, (current) => {
      if (current.terminalReason !== null || current.resolution !== null) unavailable();
      if (current.attempt !== null) {
        if (current.attempt.generation !== stage.generation || !deepEqual(current.attempt.candidate, stage.candidate)) unavailable();
        result = current.attempt;
        return current;
      }
      if (stage.generation >= current.nextGeneration || current.lastAckGeneration >= stage.generation) unavailable();
      const expectedRevision = current.lastAckGeneration >= 0 && current.lastAckGeneration < stage.generation
        ? current.lastAckRevision
        : current.initialRevision;
      const requestBody = JSON.stringify({
        expectedRevision,
        settings: stage.candidate.settings,
        baseVersion: stage.candidate.baseVersion,
      });
      const attempt: JournalPutAttempt = {
        kind: "put",
        attemptId,
        idempotencyKey,
        generation: stage.generation,
        candidate: clone(stage.candidate),
        expectedRevision,
        parentAckGeneration: current.lastAckGeneration,
        requestBody,
        requestBytesSha256: digest(requestBody),
        conflictId: null,
      };
      result = attempt;
      return { ...current, revision: current.revision + 1, attempt };
    });
    if (result === null) unavailable();
    return clone(result);
  }

  async acknowledgeAttempt(
    binding: RecipeWriterBinding,
    attemptId: string,
    generation: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let acknowledged = false;
    await this.mutate(binding, signal, (current) => {
      const attempt = current.attempt;
      if (attempt === null) {
        if (current.lastAckGeneration === generation && current.lastAckRevision === revision) acknowledged = true;
        return current;
      }
      if (attempt.attemptId !== attemptId || attempt.generation !== generation) return current;
      if (revision !== attempt.expectedRevision + 1) unavailable();
      acknowledged = true;
      return {
        ...current,
        revision: current.revision + 1,
        lastAckGeneration: generation,
        lastAckRevision: revision,
        latest: current.latest?.generation === generation ? null : current.latest,
        attempt: null,
      };
    });
    return acknowledged;
  }

  async conflictAttempt(
    binding: RecipeWriterBinding,
    attemptId: string,
    generation: number,
    conflictId: string,
    snapshotSha256: string | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    validateOpaque(conflictId);
    if (snapshotSha256 !== null && !SHA256.test(snapshotSha256)) unavailable();
    let settled = false;
    await this.mutate(binding, signal, (current) => {
      const attempt = current.attempt;
      if (attempt === null) {
        if (current.conflicts.some((conflict) => conflict.conflictId === conflictId && conflict.generation === generation)) settled = true;
        return current;
      }
      if (attempt.attemptId !== attemptId || attempt.generation !== generation) return current;
      settled = true;
      if (attempt.conflictId === null && snapshotSha256 === null) {
        return { ...current, revision: current.revision + 1, attempt: { ...attempt, conflictId } };
      }
      if (attempt.conflictId !== conflictId) unavailable();
      if (snapshotSha256 === null) return current;
      const metadata: JournalConflictMetadata = {
        conflictId,
        generation,
        snapshotSha256,
        candidateSha256: jsonStructuralFingerprint(attempt.candidate),
      };
      const conflicts = current.conflicts.some((conflict) => conflict.conflictId === conflictId)
        ? current.conflicts
        : [...current.conflicts, metadata].slice(-64);
      return { ...current, revision: current.revision + 1, attempt: null, conflicts };
    });
    return settled;
  }

  async terminalAttempt(
    binding: RecipeWriterBinding,
    attemptId: string,
    generation: number,
    reason: "not-found" | "photo-deleted",
    signal?: AbortSignal,
  ): Promise<boolean> {
    let settled = false;
    await this.mutate(binding, signal, (current) => {
      const attempt = current.attempt;
      if (attempt === null) {
        if (current.lastAckGeneration < generation) return current;
        settled = true;
        return { ...current, revision: current.revision + 1, terminalReason: reason };
      }
      if (attempt.attemptId !== attemptId || attempt.generation !== generation) return current;
      settled = true;
      return { ...current, revision: current.revision + 1, attempt: null, terminalReason: reason };
    });
    return settled;
  }

  async terminalStage(
    binding: RecipeWriterBinding,
    generation: number,
    reason: "not-found" | "photo-deleted",
    signal?: AbortSignal,
  ): Promise<boolean> {
    let settled = false;
    await this.mutate(binding, signal, (current) => {
      if (generation >= current.nextGeneration) return current;
      settled = true;
      return { ...current, revision: current.revision + 1, terminalReason: reason };
    });
    return settled;
  }

  async terminalConflict(
    binding: RecipeWriterBinding,
    conflictId: string,
    generation: number | null,
    reason: "not-found" | "photo-deleted",
    signal?: AbortSignal,
  ): Promise<boolean> {
    validateOpaque(conflictId);
    let settled = false;
    await this.mutate(binding, signal, (current) => {
      if (generation !== null && !current.conflicts.some((conflict) => conflict.conflictId === conflictId && conflict.generation === generation)) return current;
      settled = true;
      return { ...current, revision: current.revision + 1, resolution: null, terminalReason: reason };
    });
    return settled;
  }

  async createResolution(
    binding: RecipeWriterBinding,
    intent: RecipeConflictIntent,
    proof: JournalResolutionProof,
    attemptId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<JournalResolutionAttempt> {
    validateIntent(intent);
    validateResolutionProof(proof, intent);
    validateOpaque(attemptId);
    validateKey(idempotencyKey);
    let result: JournalResolutionAttempt | null = null;
    await this.mutate(binding, signal, (current) => {
      if (current.terminalReason !== null || current.attempt !== null) unavailable();
      if (current.resolution !== null) {
        if (!sameResolutionIntent(current.resolution, intent)) unavailable();
        result = current.resolution;
        return current;
      }
      if (current.knownResolution !== null && sameKnownIntent(current.knownResolution, intent)) unavailable();
      const conflict = current.conflicts.find((item) => item.conflictId === intent.conflictId);
      if (conflict !== undefined && (conflict.generation !== proof.originGeneration || conflict.snapshotSha256 !== proof.conflictSnapshotSha256)) unavailable();
      if (conflict === undefined && proof.originGeneration !== null) unavailable();
      if (conflict === undefined && current.conflicts.length >= 64) unavailable();
      const conflicts = conflict === undefined
        ? [...current.conflicts, {
          conflictId: intent.conflictId,
          generation: null,
          snapshotSha256: proof.conflictSnapshotSha256,
          candidateSha256: null,
        } satisfies JournalConflictMetadata]
        : current.conflicts;
      const requestBody = JSON.stringify({ expectedRevision: intent.expectedRevision, decision: intent.decision });
      const resolution: JournalResolutionAttempt = {
        kind: "resolve",
        attemptId,
        intentId: intent.intentId,
        idempotencyKey,
        conflictId: intent.conflictId,
        decision: intent.decision,
        expectedRevision: intent.expectedRevision,
        requestBody,
        requestBytesSha256: digest(requestBody),
        proof: clone(proof),
      };
      result = resolution;
      return { ...current, revision: current.revision + 1, conflicts, resolution };
    });
    if (result === null) unavailable();
    return clone(result);
  }

  async settleResolution(
    binding: RecipeWriterBinding,
    attemptId: string,
    outcome: "resolved" | "stale" | "terminal-not-found" | "terminal-photo-deleted",
    signal?: AbortSignal,
  ): Promise<boolean> {
    let settled = false;
    await this.mutate(binding, signal, (current) => {
      if (current.resolution?.attemptId !== attemptId) return current;
      const resolution = current.resolution;
      const conflict = current.conflicts.find((item) => item.conflictId === resolution.conflictId);
      if (conflict === undefined || conflict.generation !== resolution.proof.originGeneration) return current;
      settled = true;
      const resolved = outcome === "resolved";
      const localGeneration = conflict.generation;
      const ownAdopt = resolved && localGeneration !== null && conflict.candidateSha256 !== null &&
        resolution.decision === "adopt" && resolution.proof.decision === "adopt" &&
        jsonStructuralFingerprint({
          settings: resolution.proof.selectedCandidate.settings,
          baseVersion: resolution.proof.selectedCandidate.baseVersion,
          maskSurfaceIds: resolution.proof.selectedCandidate.maskSurfaceIds,
        }) === conflict.candidateSha256;
      const ackGeneration = ownAdopt && localGeneration !== null && localGeneration > current.lastAckGeneration
        ? localGeneration
        : null;
      return {
        ...current,
        revision: current.revision + 1,
        lastAckGeneration: ackGeneration ?? current.lastAckGeneration,
        lastAckRevision: ackGeneration === null ? current.lastAckRevision : resolution.proof.expectedResultingRevision,
        latest: resolved && localGeneration !== null && current.latest?.generation === localGeneration ? null : current.latest,
        resolution: null,
        conflicts: resolved ? current.conflicts.filter((item) => item.conflictId !== resolution.conflictId) : current.conflicts,
        knownResolution: outcome === "resolved" || outcome === "stale" ? {
          intentId: resolution.intentId,
          conflictId: resolution.conflictId,
          decision: resolution.decision,
          expectedRevision: resolution.expectedRevision,
          outcome,
        } : current.knownResolution,
        terminalReason: outcome === "terminal-not-found" ? "not-found" : outcome === "terminal-photo-deleted" ? "photo-deleted" : current.terminalReason,
      };
    });
    return settled;
  }

  async list(
    scope: RecipeJournalScope,
    options: { readonly cursor?: string; readonly limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<PendingWriterPage> {
    validateScope(scope);
    const limit = options.limit ?? MAX_LIST_COUNT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_COUNT) unavailable();
    if (options.cursor !== undefined) validateOpaque(options.cursor);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, SCOPE_FENCES], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const prefix = scopeKey(scope);
    const range = options.cursor === undefined
      ? IDBKeyRange.bound(prefix, [...prefix, []])
      : IDBKeyRange.bound([...prefix, options.cursor], [...prefix, []], true, false);
    const writers: PendingWriterToken[] = [];
    let bytes = 0;
    let nextCursor: string | null = null;
    const walked = new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore(WRITERS).index(SCOPE_TOKEN).openCursor(range, "next");
      request.onerror = () => reject(idbError(request.error));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) { resolve(); return; }
        try {
          const record = validateRecord(cursor.value);
          if (!sameScope(record, scope)) unavailable();
          if (!hasRetainedState(record)) { cursor.continue(); return; }
          const item = tokenOf(record);
          const itemBytes = jsonBytes(item);
          if (itemBytes > MAX_LIST_BYTES) unavailable();
          if (writers.length >= limit || writers.length > 0 && bytes + itemBytes > MAX_LIST_BYTES) {
            nextCursor = writers.at(-1)?.token ?? null;
            resolve();
            return;
          }
          writers.push(item);
          bytes += itemBytes;
          cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    await transactionWait(walked, transaction, signal);
    await transactionWait(barrier, transaction, signal);
    return { writers, nextCursor };
  }

  async listPrevious(
    scope: RecipeJournalScope,
    options: { readonly cursor?: string; readonly limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<JournalPreviousPendingWriterPage> {
    validateScope(scope);
    const limit = options.limit ?? MAX_LIST_COUNT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_COUNT) unavailable();
    const prefix: [string, string] = [scope.actorId, scope.libraryId];
    const after = options.cursor === undefined ? null : parsePreviousCursor(options.cursor, scope);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, SCOPE_FENCES], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const range = after === null
      ? IDBKeyRange.bound(prefix, [...prefix, []])
      : IDBKeyRange.bound(after, [...prefix, []], true, false);
    const writers: JournalPreviousPendingWriter[] = [];
    let bytes = 0;
    let lastKey: PreviousIndexKey | null = null;
    let nextCursor: string | null = null;
    const walked = new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore(WRITERS).index(SCOPE_TOKEN).openCursor(range, "next");
      request.onerror = () => reject(idbError(request.error));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) { resolve(); return; }
        try {
          const record = validateRecord(cursor.value);
          if (!sameCanonicalScope(record, scope)) unavailable();
          if (sameScope(record, scope) || !hasRetainedState(record)) { cursor.continue(); return; }
          const item = { binding: bindingOf(record), summary: tokenOf(record) } satisfies JournalPreviousPendingWriter;
          const itemBytes = jsonBytes(item);
          if (itemBytes > MAX_LIST_BYTES) unavailable();
          if (writers.length >= limit || writers.length > 0 && bytes + itemBytes > MAX_LIST_BYTES) {
            if (lastKey === null) unavailable();
            nextCursor = JSON.stringify(lastKey);
            resolve();
            return;
          }
          writers.push(clone(item));
          bytes += itemBytes;
          lastKey = indexKey(record);
          cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    await transactionWait(walked, transaction, signal);
    await transactionWait(barrier, transaction, signal);
    return { writers, nextCursor };
  }

  async reopen(scope: RecipeJournalScope, token: string, signal?: AbortSignal): Promise<ReopenedJournalWriter | null> {
    validateScope(scope);
    validateOpaque(token);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, SCOPE_FENCES], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const request = transaction.objectStore(WRITERS).index(SCOPE_TOKEN).get([...scopeKey(scope), token]);
    const raw = await transactionWait(requestResult(request), transaction, signal);
    await transactionWait(barrier, transaction, signal);
    if (raw === undefined) return null;
    const record = validateRecord(raw);
    if (!sameScope(record, scope) || record.token !== token) unavailable();
    return {
      binding: bindingOf(record),
      nextGeneration: record.nextGeneration,
      latest: clone(record.latest),
      attempt: clone(record.attempt),
      resolution: clone(record.resolution),
      conflicts: clone(record.conflicts),
      knownResolution: clone(record.knownResolution),
      conflictIds: record.conflicts.map((conflict) => conflict.conflictId),
      terminalReason: record.terminalReason,
    };
  }

  async discard(binding: RecipeWriterBinding, signal?: AbortSignal): Promise<void> {
    validateBinding(binding);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, MASKS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), binding, transaction, signal);
    const store = transaction.objectStore(WRITERS);
    const currentRaw = await transactionWait(requestResult(store.get(recordId(binding))), transaction, signal);
    const maskKeys = new Set<string>();
    if (currentRaw !== undefined) {
      const current = validateRecord(currentRaw);
      if (!sameBinding(current, binding)) { abort(transaction); unavailable(); }
      if (current.attempt !== null || current.resolution !== null) { abort(transaction); unavailable(); }
      for (const sha of current.latest?.candidate.maskSurfaceIds ?? []) maskKeys.add(maskKey(binding, binding.photoId, sha));
      await updateCombinedBudgets(transaction.objectStore(META), binding, -1, 0, -jsonBytes(current), signal, transaction);
      store.delete(current.id);
    }
    const releasedKeys = await releaseLeasesInTransaction(transaction, binding, [], signal, binding.token);
    for (const key of releasedKeys) maskKeys.add(key);
    const masks = transaction.objectStore(MASKS);
    let removedCount = 0;
    let removedBytes = 0;
    for (const key of maskKeys) {
      const raw = await transactionWait(requestResult(masks.get(key)), transaction, signal);
      if (raw === undefined) continue;
      const current = validateMaskRecord(raw);
      if (current.pinned || maskLeases(current).length > 0 || current.uploadState !== null ||
        await anyWriterReferences(store, current.photoId, current.sha256, signal, transaction)) continue;
      masks.delete(key);
      removedCount += 1;
      removedBytes += maskBytes(current);
    }
    if (removedCount > 0) {
      await updateCombinedBudgets(transaction.objectStore(META), binding, 0, -removedCount, -removedBytes, signal, transaction);
    }
    await transactionWait(barrier, transaction, signal);
  }

  async releaseCompleted(binding: RecipeWriterBinding, signal?: AbortSignal): Promise<boolean> {
    validateBinding(binding);
    let released = false;
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), binding, transaction, signal);
    const store = transaction.objectStore(WRITERS);
    const currentRaw = await transactionWait(requestResult(store.get(recordId(binding))), transaction, signal);
    if (currentRaw !== undefined) {
      const current = validateRecord(currentRaw);
      if (!sameBinding(current, binding)) { abort(transaction); unavailable(); }
      if (!hasRetainedState(current) && current.terminalReason === null) {
        await updateCombinedBudgets(transaction.objectStore(META), binding, -1, 0, -jsonBytes(current), signal, transaction);
        store.delete(current.id);
        released = true;
      }
    }
    await transactionWait(barrier, transaction, signal);
    return released;
  }

  async putMaskSurface(
    scope: RecipeJournalScope,
    photoId: string,
    surface: MaskSurfaceInput,
    signal?: AbortSignal,
    lease?: MaskSurfacePinLease | null,
  ): Promise<void> {
    validateScope(scope);
    validateOpaque(photoId);
    const bytes = new Uint8Array(surface.bytes);
    validateMaskInput(photoId, surface, bytes);
    if (lease !== undefined && lease !== null) validateLease(lease);
    if (digestBytes(bytes) !== surface.sha256) unavailable();
    const record: MaskRecord = {
      ...clone(scope),
      schemaVersion: 2,
      key: maskKey(scope, photoId, surface.sha256),
      photoId,
      id: surface.id,
      width: surface.width,
      height: surface.height,
      sha256: surface.sha256,
      contentType: "image/png",
      bytes,
      uploadState: clone(surface.uploadState),
      pinned: lease === undefined,
      pinLeases: lease === undefined || lease === null ? [] : [clone(lease)],
    };
    validateMaskRecord(record);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [MASKS, WRITERS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const store = transaction.objectStore(MASKS);
    const raw = await transactionWait(requestResult(store.get(record.key)), transaction, signal);
    if (raw !== undefined) {
      const current = validateMaskRecord(raw);
      if (!sameMaskScope(current, scope) || current.photoId !== photoId || current.sha256 !== surface.sha256) { abort(transaction); unavailable(); }
      if (
        current.id !== record.id || current.width !== record.width || current.height !== record.height ||
        !equalBytes(current.bytes, record.bytes) ||
        surface.uploadState !== null && !deepEqual(current.uploadState, surface.uploadState)
      ) { abort(transaction); unavailable(); }
      const currentLeases = maskLeases(current);
      const pinLeases = lease === undefined || lease === null || currentLeases.some((item) => sameLease(item, lease))
        ? currentLeases
        : [...currentLeases, clone(lease)];
      const pinned = current.pinned || lease === undefined;
      if (current.pinned !== pinned || pinLeases !== currentLeases || current.schemaVersion !== 2) {
        const next = { ...current, schemaVersion: 2 as const, pinned, pinLeases };
        await updateCombinedBudgets(transaction.objectStore(META), scope, 0, 0, maskBytes(next) - maskBytes(current), signal, transaction);
        store.put(next);
      }
    } else {
      await collectMaskGarbage(transaction, scope, maskBytes(record), signal);
      await updateCombinedBudgets(transaction.objectStore(META), scope, 0, 1, maskBytes(record), signal, transaction);
      store.add(record);
    }
    await transactionWait(barrier, transaction, signal);
  }

  async getMaskSurface(
    scope: RecipeJournalScope,
    photoId: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<PersistedMaskSurface | null> {
    validateScope(scope);
    validateOpaque(photoId);
    validateSha(sha);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [MASKS, SCOPE_FENCES], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const raw = await transactionWait(requestResult(transaction.objectStore(MASKS).get(maskKey(scope, photoId, sha))), transaction, signal);
    await transactionWait(barrier, transaction, signal);
    if (raw === undefined) return null;
    const record = validateMaskRecord(raw);
    if (!sameMaskScope(record, scope) || record.photoId !== photoId || record.sha256 !== sha) unavailable();
    return maskValue(record);
  }

  async compareAndSetMaskUploadState(
    scope: RecipeJournalScope,
    photoId: string,
    sha: string,
    expected: MaskSurfaceUploadState | null,
    next: MaskSurfaceUploadState | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    validateScope(scope);
    validateOpaque(photoId);
    validateSha(sha);
    validateMaskUploadState(expected, photoId, sha);
    validateMaskUploadState(next, photoId, sha);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [MASKS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const store = transaction.objectStore(MASKS);
    const raw = await transactionWait(requestResult(store.get(maskKey(scope, photoId, sha))), transaction, signal);
    if (raw === undefined) { abort(transaction); unavailable(); }
    const current = validateMaskRecord(raw);
    if (!sameMaskScope(current, scope) || current.photoId !== photoId || current.sha256 !== sha) { abort(transaction); unavailable(); }
    if (expected !== null && expected.sizeBytes !== current.bytes.byteLength || next !== null && next.sizeBytes !== current.bytes.byteLength) { abort(transaction); unavailable(); }
    if (!deepEqual(current.uploadState, expected)) { await transactionWait(barrier, transaction, signal); return false; }
    const updated = { ...current, uploadState: clone(next) };
    validateMaskRecord(updated);
    await updateCombinedBudgets(transaction.objectStore(META), scope, 0, 0, maskBytes(updated) - maskBytes(current), signal, transaction);
    store.put(updated);
    await transactionWait(barrier, transaction, signal);
    return true;
  }

  async setMaskSurfacePinned(
    scope: RecipeJournalScope,
    photoId: string,
    sha: string,
    pinned: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    validateScope(scope);
    validateOpaque(photoId);
    validateSha(sha);
    if (typeof pinned !== "boolean") unavailable();
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [MASKS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const store = transaction.objectStore(MASKS);
    const raw = await transactionWait(requestResult(store.get(maskKey(scope, photoId, sha))), transaction, signal);
    if (raw === undefined) { abort(transaction); unavailable(); }
    const current = validateMaskRecord(raw);
    if (!sameMaskScope(current, scope) || current.photoId !== photoId || current.sha256 !== sha) { abort(transaction); unavailable(); }
    if (current.pinned !== pinned) {
      const next = { ...current, pinned };
      await updateCombinedBudgets(transaction.objectStore(META), scope, 0, 0, maskBytes(next) - maskBytes(current), signal, transaction);
      store.put(next);
    }
    await transactionWait(barrier, transaction, signal);
  }

  async releaseMaskSurfaceLeases(
    scope: RecipeJournalScope,
    writerId: string,
    leases: readonly MaskSurfacePinLease[] | undefined = undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    validateScope(scope);
    validateOpaque(writerId);
    if (leases !== undefined) validateLeaseList(leases, writerId);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [MASKS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    await releaseLeasesInTransaction(transaction, scope, leases ?? [{ writerId, pinToken: "*" }], signal, leases === undefined ? writerId : undefined);
    await transactionWait(barrier, transaction, signal);
  }

  async deleteMaskSurface(
    scope: RecipeJournalScope,
    photoId: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    validateScope(scope);
    validateOpaque(photoId);
    validateSha(sha);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [MASKS, WRITERS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), scope, transaction, signal);
    const masks = transaction.objectStore(MASKS);
    const raw = await transactionWait(requestResult(masks.get(maskKey(scope, photoId, sha))), transaction, signal);
    if (raw === undefined) { await transactionWait(barrier, transaction, signal); return false; }
    const current = validateMaskRecord(raw);
    if (!sameMaskScope(current, scope) || current.photoId !== photoId || current.sha256 !== sha) { abort(transaction); unavailable(); }
    if (current.pinned || maskLeases(current).length > 0 || current.uploadState !== null || await anyWriterReferences(transaction.objectStore(WRITERS), photoId, sha, signal, transaction)) {
      await transactionWait(barrier, transaction, signal);
      return false;
    }
    await updateCombinedBudgets(transaction.objectStore(META), scope, 0, -1, -maskBytes(current), signal, transaction);
    masks.delete(current.key);
    await transactionWait(barrier, transaction, signal);
    return true;
  }

  async purgeScope(scope: RecipeJournalScope, signal?: AbortSignal): Promise<number> {
    validateScope(scope);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, MASKS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    transaction.objectStore(SCOPE_FENCES).put({ key: scopeFenceKey(scope), revoked: true });

    let writersRemoved = 0;
    let masksRemoved = 0;
    let bytesRemoved = 0;
    const writerPrefix = scopeKey(scope);
    const writerRange = IDBKeyRange.bound(writerPrefix, [...writerPrefix, []]);
    const writerDeletion = new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore(WRITERS).index(SCOPE_TOKEN).openCursor(writerRange, "next");
      request.onerror = () => reject(idbError(request.error));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) { resolve(); return; }
        try {
          const record = validateRecord(cursor.value);
          if (!sameScope(record, scope)) unavailable();
          bytesRemoved += jsonBytes(record);
          writersRemoved += 1;
          cursor.delete();
          cursor.continue();
        } catch (error) { abort(transaction); reject(error); }
      };
    });
    await transactionWait(writerDeletion, transaction, signal);

    const maskRange = IDBKeyRange.bound(writerPrefix, [...writerPrefix, []]);
    const maskDeletion = new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore(MASKS).index(MASK_SCOPE).openCursor(maskRange, "next");
      request.onerror = () => reject(idbError(request.error));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) { resolve(); return; }
        try {
          const record = validateMaskRecord(cursor.value);
          if (!sameMaskScope(record, scope)) unavailable();
          bytesRemoved += maskBytes(record);
          masksRemoved += 1;
          cursor.delete();
          cursor.continue();
        } catch (error) { abort(transaction); reject(error); }
      };
    });
    await transactionWait(maskDeletion, transaction, signal);
    await updateCombinedBudgets(
      transaction.objectStore(META), scope, -writersRemoved, -masksRemoved, -bytesRemoved, signal, transaction,
    );
    await transactionWait(barrier, transaction, signal);
    return writersRemoved + masksRemoved;
  }

  dispose(): void {
    this.disposed = true;
    if (this.databasePromise !== null) void this.databasePromise.then((database) => database.close(), () => undefined);
  }

  private async mutate(
    binding: RecipeWriterBinding,
    signal: AbortSignal | undefined,
    change: (current: WriterRecord) => WriterRecord,
    initialGeneration = 0,
  ): Promise<void> {
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, META, SCOPE_FENCES], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    await assertScopeNotRevoked(transaction.objectStore(SCOPE_FENCES), binding, transaction, signal);
    const store = transaction.objectStore(WRITERS);
    const raw = await transactionWait(requestResult(store.get(recordId(binding))), transaction, signal);
    const current = raw === undefined ? initialRecord(binding, initialGeneration) : validateRecord(raw);
    if (!sameBinding(current, binding)) { abort(transaction); unavailable(); }
    const next = change(clone(current));
    validateRecord(next);
    if (next.id !== current.id || next.revision < current.revision || !sameBinding(next, binding)) { abort(transaction); unavailable(); }
    if (!deepEqual(next, current)) {
      await updateCombinedBudgets(
        transaction.objectStore(META),
        binding,
        raw === undefined ? 1 : 0,
        0,
        jsonBytes(next) - (raw === undefined ? 0 : jsonBytes(current)),
        signal,
        transaction,
      );
      store.put(next);
    }
    await transactionWait(barrier, transaction, signal);
  }

  private async database(signal?: AbortSignal): Promise<IDBDatabase> {
    if (this.disposed) unavailable();
    this.databasePromise ??= openDatabase(this.factory, this.databaseName);
    const databasePromise = this.databasePromise;
    return await awaitBounded(databasePromise, {
      signal: signal ?? NEVER_ABORTS,
      timeoutMs: IDB_TIMEOUT_MS,
      onLateResolve: (database) => {
        if (this.disposed) {
          database.close();
        }
      },
    });
  }
}

async function updateCombinedBudgets(
  store: IDBObjectStore,
  scope: RecipeJournalScope,
  writerDelta: number,
  maskDelta: number,
  byteDelta: number,
  signal: AbortSignal | undefined,
  transaction: IDBTransaction,
): Promise<void> {
  const scopeBudgetKey = `scope:${JSON.stringify(scopeKey(scope))}`;
  const [globalRaw, scopeRaw] = await Promise.all([
    transactionWait(requestResult(store.get("global")), transaction, signal),
    transactionWait(requestResult(store.get(scopeBudgetKey)), transaction, signal),
  ]);
  const global = budget(globalRaw, "global");
  const scoped = budget(scopeRaw, scopeBudgetKey);
  const nextGlobal = { key: "global", writers: global.writers + writerDelta, masks: global.masks + maskDelta, bytes: global.bytes + byteDelta };
  const nextScope = { key: scopeBudgetKey, writers: scoped.writers + writerDelta, masks: scoped.masks + maskDelta, bytes: scoped.bytes + byteDelta };
  if (
    nextScope.writers < 0 || nextScope.masks < 0 || nextScope.bytes < 0 || nextGlobal.writers < 0 || nextGlobal.masks < 0 || nextGlobal.bytes < 0 ||
    nextScope.writers > MAX_SCOPE_WRITERS || nextScope.bytes > MAX_SCOPE_BYTES ||
    nextGlobal.writers > MAX_GLOBAL_WRITERS || nextGlobal.bytes > MAX_GLOBAL_BYTES ||
    nextScope.masks > MAX_SCOPE_MASKS || nextGlobal.masks > MAX_GLOBAL_MASKS
  ) {
    abort(transaction);
    throw new DOMException("Recipe journal budget exceeded", "QuotaExceededError");
  }
  store.put(nextGlobal);
  store.put(nextScope);
}

function initialRecord(binding: RecipeWriterBinding, firstGeneration: number): WriterRecord {
  return {
    ...clone(binding),
    schemaVersion: 1,
    id: recordId(binding),
    revision: 0,
    nextGeneration: firstGeneration,
    lastAckGeneration: -1,
    lastAckRevision: binding.initialRevision,
    latest: null,
    attempt: null,
    resolution: null,
    conflicts: [],
    knownResolution: null,
    terminalReason: null,
  };
}

function validateRecord(value: unknown): WriterRecord {
  if (!isRecord(value)) unavailable();
  const record = value as unknown as WriterRecord;
  validateBinding(record);
  if (
    !exactKeys(value, [
      "actorId", "libraryId", "sessionId", "sessionEpoch", "transport", "token", "writerId", "photoId", "sourceSha256", "initialRevision",
      "schemaVersion", "id", "revision", "nextGeneration", "lastAckGeneration", "lastAckRevision", "latest", "attempt", "resolution", "conflicts", "knownResolution", "terminalReason",
    ]) ||
    record.schemaVersion !== 1 || record.id !== recordId(record) || !safeNonNegative(record.revision) ||
    !safeNonNegative(record.nextGeneration) || !Number.isSafeInteger(record.lastAckGeneration) || record.lastAckGeneration < -1 ||
    !safeNonNegative(record.lastAckRevision) || record.terminalReason !== null && record.terminalReason !== "not-found" && record.terminalReason !== "photo-deleted" ||
    !Array.isArray(record.conflicts) || record.conflicts.length > 64
  ) unavailable();
  record.conflicts.forEach(validateConflictMetadata);
  if (new Set(record.conflicts.map((conflict) => conflict.conflictId)).size !== record.conflicts.length) unavailable();
  if (record.knownResolution !== null) validateKnownResolution(record.knownResolution);
  if (record.latest !== null) validateStage(record.latest);
  if (record.attempt !== null) validatePutAttempt(record.attempt);
  if (record.resolution !== null) validateResolutionAttempt(record.resolution);
  if (record.attempt !== null && record.resolution !== null) unavailable();
  return record;
}

function validatePutAttempt(value: JournalPutAttempt): void {
  if (!isRecord(value) || !exactKeys(value, ["kind", "attemptId", "idempotencyKey", "generation", "candidate", "expectedRevision", "parentAckGeneration", "requestBody", "requestBytesSha256", "conflictId"]) || value.kind !== "put" || !safeNonNegative(value.generation) || !safeNonNegative(value.expectedRevision) || !Number.isSafeInteger(value.parentAckGeneration) || value.parentAckGeneration < -1 || value.conflictId !== null && !nonEmpty(value.conflictId)) unavailable();
  validateOpaque(value.attemptId);
  validateKey(value.idempotencyKey);
  validateCandidate(value.candidate);
  validateFixedBytes(value.requestBody, value.requestBytesSha256, PHOTO_LIMITS.maxRecipeBodyBytes);
  const parsed = parseJson(value.requestBody);
  if (!isRecord(parsed) || parsed.expectedRevision !== value.expectedRevision || !deepEqual(parsed.settings, value.candidate.settings) || parsed.baseVersion !== value.candidate.baseVersion) unavailable();
}

function validateResolutionAttempt(value: JournalResolutionAttempt): void {
  if (!isRecord(value) || !exactKeys(value, ["kind", "attemptId", "intentId", "idempotencyKey", "conflictId", "decision", "expectedRevision", "requestBody", "requestBytesSha256", "proof"]) || value.kind !== "resolve" || !safeNonNegative(value.expectedRevision) || value.decision !== "adopt" && value.decision !== "keep-current") unavailable();
  validateOpaque(value.attemptId);
  validateOpaque(value.intentId);
  validateOpaque(value.conflictId);
  validateKey(value.idempotencyKey);
  validateFixedBytes(value.requestBody, value.requestBytesSha256, PHOTO_LIMITS.maxOtherBodyBytes);
  const parsed = parseJson(value.requestBody);
  if (!isRecord(parsed) || parsed.expectedRevision !== value.expectedRevision || parsed.decision !== value.decision) unavailable();
  validateResolutionProof(value.proof, value);
}

function validateConflictMetadata(value: JournalConflictMetadata): void {
  if (
    !isRecord(value) || !exactKeys(value, ["conflictId", "generation", "snapshotSha256", "candidateSha256"]) ||
    value.generation !== null && !safeNonNegative(value.generation) || !SHA256.test(value.snapshotSha256) ||
    value.candidateSha256 !== null && !SHA256.test(value.candidateSha256) ||
    (value.generation === null) !== (value.candidateSha256 === null)
  ) unavailable();
  validateOpaque(value.conflictId);
}

function validateKnownResolution(value: JournalKnownResolution): void {
  if (!isRecord(value) || !exactKeys(value, ["intentId", "conflictId", "decision", "expectedRevision", "outcome"]) || value.decision !== "adopt" && value.decision !== "keep-current" || value.outcome !== "resolved" && value.outcome !== "stale" || !safeNonNegative(value.expectedRevision)) unavailable();
  validateOpaque(value.intentId);
  validateOpaque(value.conflictId);
}

function validateResolutionProof(
  value: JournalResolutionProof,
  intent: Pick<RecipeConflictIntent, "decision" | "expectedRevision">,
): void {
  if (
    !isRecord(value) || value.decision !== intent.decision || !SHA256.test(value.conflictSnapshotSha256) ||
    value.originGeneration !== null && !safeNonNegative(value.originGeneration) || !safeNonNegative(value.expectedResultingRevision) ||
    value.expectedResultingRevision !== (intent.decision === "adopt" ? intent.expectedRevision + 1 : intent.expectedRevision)
  ) unavailable();
  if (value.decision === "adopt") {
    if (!exactKeys(value, ["decision", "conflictSnapshotSha256", "originGeneration", "expectedResultingRevision", "selectedCandidate"])) unavailable();
    validateRecipeCandidate(value.selectedCandidate);
  } else {
    if (!exactKeys(value, ["decision", "conflictSnapshotSha256", "originGeneration", "expectedResultingRevision", "selectedRecipe"])) unavailable();
    validateRecipeDocumentProof(value.selectedRecipe);
  }
}

function validateRecipeDocumentProof(value: unknown): void {
  if (
    !isRecord(value) || !exactKeys(value, ["revision", "settings", "settingsSha256", "baseVersion", "maskSurfaceIds", "updatedAt"]) ||
    !safeNonNegative(value.revision) || !SHA256.test(value.settingsSha256 as string) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
  ) unavailable();
  validateRecipeCandidate({
    settings: value.settings,
    settingsSha256: value.settingsSha256,
    baseVersion: value.baseVersion,
    maskSurfaceIds: value.maskSurfaceIds,
  } as never);
}

function validateStage(stage: JournalStage): void {
  if (!isRecord(stage) || !safeNonNegative(stage.generation)) unavailable();
  validateCandidate(stage.candidate);
}

function validateCandidate(candidate: unknown): void {
  if (!isRecord(candidate) || !exactKeys(candidate, ["settings", "baseVersion", "maskSurfaceIds"]) || !isRecord(candidate.settings) || !safeNonNegative(candidate.settings.v) || !nonEmpty(candidate.settings.engine) || candidate.baseVersion !== null && !nonEmpty(candidate.baseVersion) || !Array.isArray(candidate.maskSurfaceIds) || !candidate.maskSurfaceIds.every((item) => typeof item === "string" && SHA256.test(item)) || new Set(candidate.maskSurfaceIds).size !== candidate.maskSurfaceIds.length) unavailable();
  validateJsonValue(candidate.settings, PHOTO_LIMITS.maxRecipeBytes);
  validateJsonValue(candidate, PHOTO_LIMITS.maxRecipeBodyBytes, PHOTO_LIMITS.maxJsonDepth + 1);
}

function validateBinding(binding: RecipeWriterBinding): void {
  validateScope(binding);
  [binding.token, binding.writerId, binding.photoId].forEach(validateOpaque);
  if (!SHA256.test(binding.sourceSha256) || !safeNonNegative(binding.initialRevision)) unavailable();
}

function validateScope(scope: RecipeJournalScope): void {
  if (![scope.actorId, scope.libraryId, scope.sessionId, scope.sessionEpoch].every(nonEmpty) || scope.transport !== "browser-session" && scope.transport !== "mac-bearer") unavailable();
}

function validateIntent(intent: RecipeConflictIntent): void {
  if (!isRecord(intent) || intent.decision !== "adopt" && intent.decision !== "keep-current" || !safeNonNegative(intent.expectedRevision)) unavailable();
  validateOpaque(intent.intentId);
  validateOpaque(intent.conflictId);
}

function validateFixedBytes(body: string, hash: string, maximum: number): void {
  if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > maximum || !SHA256.test(hash) || digest(body) !== hash) unavailable();
}

function sameResolutionIntent(attempt: JournalResolutionAttempt, intent: RecipeConflictIntent): boolean {
  return attempt.intentId === intent.intentId && attempt.conflictId === intent.conflictId && attempt.decision === intent.decision && attempt.expectedRevision === intent.expectedRevision;
}

function sameKnownIntent(attempt: JournalKnownResolution, intent: RecipeConflictIntent): boolean {
  return attempt.intentId === intent.intentId && attempt.conflictId === intent.conflictId && attempt.decision === intent.decision && attempt.expectedRevision === intent.expectedRevision;
}

function hasRetainedState(record: WriterRecord): boolean {
  return record.latest !== null || record.attempt !== null || record.resolution !== null || record.conflicts.length > 0 || record.terminalReason !== null;
}

function tokenOf(record: WriterRecord): PendingWriterToken {
  return {
    token: record.token,
    photoId: record.photoId,
    hasUnknownAttempt: record.attempt !== null || record.resolution !== null,
    hasLatest: record.latest !== null,
    conflictIds: record.conflicts.map((conflict) => conflict.conflictId),
    terminalReason: record.terminalReason,
  };
}

function bindingOf(record: WriterRecord): RecipeWriterBinding {
  const { actorId, libraryId, sessionId, sessionEpoch, transport, token, writerId, photoId, sourceSha256, initialRevision } = record;
  return { actorId, libraryId, sessionId, sessionEpoch, transport, token, writerId, photoId, sourceSha256, initialRevision };
}

function budget(value: unknown, key: string): BudgetRecord {
  if (value === undefined) return { key, writers: 0, masks: 0, bytes: 0 };
  if (!isRecord(value) || value.key !== key || !safeNonNegative(value.writers) || !safeNonNegative(value.bytes) || value.masks !== undefined && !safeNonNegative(value.masks)) unavailable();
  return { key, writers: value.writers, masks: value.masks ?? 0, bytes: value.bytes };
}

function validateMaskInput(photoId: string, surface: MaskSurfaceInput, bytes: Uint8Array): void {
  if (
    !isRecord(surface) || !exactKeys(surface, ["id", "width", "height", "sha256", "bytes", "uploadState"]) ||
    !(surface.bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 ** 2 ||
    !safePositive(surface.width) || surface.width > 4096 || !safePositive(surface.height) || surface.height > 4096 ||
    !SHA256.test(surface.id) || surface.id !== surface.sha256
  ) unavailable();
  validateSha(surface.sha256);
  validateMaskUploadState(surface.uploadState, photoId, surface.sha256);
  if (surface.uploadState !== null && surface.uploadState.sizeBytes !== bytes.byteLength) unavailable();
}

function validateMaskRecord(value: unknown): MaskRecord {
  if (!isRecord(value)) unavailable();
  const record = value as unknown as MaskRecord;
  validateScope(record);
  const legacyKeys = [
    "actorId", "libraryId", "sessionId", "sessionEpoch", "transport", "schemaVersion", "key", "photoId",
    "id", "width", "height", "sha256", "contentType", "bytes", "uploadState", "pinned",
  ];
  const leasedKeys = [...legacyKeys, "pinLeases"];
  if (
    !(record.schemaVersion === 1 ? exactKeys(value, legacyKeys) : record.schemaVersion === 2 && exactKeys(value, leasedKeys)) ||
    record.key !== maskKey(record, record.photoId, record.sha256) ||
    record.contentType !== "image/png" || typeof record.pinned !== "boolean"
  ) unavailable();
  if (record.schemaVersion === 2) validateLeaseList(record.pinLeases ?? []);
  validateOpaque(record.photoId);
  validateMaskInput(record.photoId, {
    id: record.id,
    width: record.width,
    height: record.height,
    sha256: record.sha256,
    bytes: record.bytes,
    uploadState: record.uploadState,
  }, record.bytes);
  if (digestBytes(record.bytes) !== record.sha256) unavailable();
  return record;
}

function validateMaskUploadState(state: MaskSurfaceUploadState | null, photoId: string, sha: string): void {
  if (state === null) return;
  if (
    !isRecord(state) || !exactKeys(state, [
      "target", "sizeBytes", "sha256", "contentType", "startKey", "completeKey", "cancelKey", "uploadId",
      "deadline", "offsetBytes", "phase",
    ]) || !isRecord(state.target) || !exactKeys(state.target, ["kind", "photoId"]) || state.target.kind !== "mask" ||
    state.target.photoId !== photoId || state.sha256 !== sha || state.contentType !== "image/png" ||
    !safePositive(state.sizeBytes) || state.sizeBytes > 8 * 1024 ** 2 || !safeNonNegative(state.offsetBytes) ||
    state.offsetBytes > state.sizeBytes || !["start-pending", "uploading", "complete-pending", "verifying", "cancel-pending", "cancelled", "expired", "rejected"].includes(state.phase) ||
    state.uploadId !== null && !nonEmpty(state.uploadId) || state.deadline !== null && !Number.isFinite(Date.parse(state.deadline))
  ) unavailable();
  validateKey(state.startKey);
  validateKey(state.completeKey);
  validateKey(state.cancelKey);
}

function maskValue(record: MaskRecord): PersistedMaskSurface {
  return {
    photoId: record.photoId,
    id: record.id,
    width: record.width,
    height: record.height,
    sha256: record.sha256,
    contentType: "image/png",
    bytes: new Uint8Array(record.bytes),
    uploadState: clone(record.uploadState),
    pinned: record.pinned,
    pinLeases: clone(maskLeases(record)),
  };
}

function maskBytes(record: MaskRecord): number {
  const { bytes, ...metadata } = record;
  return bytes.byteLength + jsonBytes(metadata);
}

async function releaseLeasesInTransaction(
  transaction: IDBTransaction,
  scope: RecipeJournalScope,
  leases: readonly MaskSurfacePinLease[],
  signal: AbortSignal | undefined,
  writerOnly?: string,
): Promise<readonly string[]> {
  const selected = new Set(leases.map((lease) => `${lease.writerId}\u0000${lease.pinToken}`));
  const releasedKeys: string[] = [];
  let byteDelta = 0;
  await visitScopeMasks(transaction, scope, MAX_SCOPE_MASKS, signal, (raw) => {
    const current = validateMaskRecord(raw);
    const currentLeases = maskLeases(current);
    const pinLeases = currentLeases.filter((lease) => writerOnly === undefined
      ? !selected.has(`${lease.writerId}\u0000${lease.pinToken}`)
      : lease.writerId !== writerOnly);
    if (pinLeases.length === currentLeases.length) return true;
    const next = { ...current, schemaVersion: 2 as const, pinLeases };
    validateMaskRecord(next);
    byteDelta += maskBytes(next) - maskBytes(current);
    transaction.objectStore(MASKS).put(next);
    releasedKeys.push(current.key);
    return true;
  });
  if (byteDelta !== 0) {
    await updateCombinedBudgets(transaction.objectStore(META), scope, 0, 0, byteDelta, signal, transaction);
  }
  return releasedKeys;
}

async function collectMaskGarbage(
  transaction: IDBTransaction,
  scope: RecipeJournalScope,
  incomingBytes: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const scopeBudgetKey = `scope:${JSON.stringify(scopeKey(scope))}`;
  const [globalRaw, scopeRaw] = await Promise.all([
    transactionWait(requestResult(transaction.objectStore(META).get("global")), transaction, signal),
    transactionWait(requestResult(transaction.objectStore(META).get(scopeBudgetKey)), transaction, signal),
  ]);
  const global = budget(globalRaw, "global");
  const scoped = budget(scopeRaw, scopeBudgetKey);
  const needsRoom = scoped.masks + 1 > MAX_SCOPE_MASKS || global.masks + 1 > MAX_GLOBAL_MASKS ||
    scoped.bytes + incomingBytes > MAX_SCOPE_BYTES || global.bytes + incomingBytes > MAX_GLOBAL_BYTES;
  if (!needsRoom) return;

  let removedCount = 0;
  let removedBytes = 0;
  await visitScopeMasks(transaction, scope, MAX_SCOPE_MASKS, signal, async (raw) => {
    const current = validateMaskRecord(raw);
    if (
      current.pinned || maskLeases(current).length > 0 || current.uploadState !== null ||
      await anyWriterReferences(transaction.objectStore(WRITERS), current.photoId, current.sha256, signal, transaction)
    ) return true;
    transaction.objectStore(MASKS).delete(current.key);
    removedCount += 1;
    removedBytes += maskBytes(current);
    return !(
      scoped.masks - removedCount + 1 <= MAX_SCOPE_MASKS && global.masks - removedCount + 1 <= MAX_GLOBAL_MASKS &&
      scoped.bytes - removedBytes + incomingBytes <= MAX_SCOPE_BYTES && global.bytes - removedBytes + incomingBytes <= MAX_GLOBAL_BYTES
    );
  });
  if (removedCount > 0) {
    await updateCombinedBudgets(transaction.objectStore(META), scope, 0, -removedCount, -removedBytes, signal, transaction);
  }
  // A previous session's unreferenced read cache must not permanently consume
  // the shared budget. Draft references, pin leases and unknown uploads remain protected.
  if (scoped.masks - removedCount + 1 > MAX_SCOPE_MASKS || scoped.bytes - removedBytes + incomingBytes > MAX_SCOPE_BYTES) return;
  let globalCount = global.masks - removedCount;
  let globalBytes = global.bytes - removedBytes;
  if (globalCount + 1 <= MAX_GLOBAL_MASKS && globalBytes + incomingBytes <= MAX_GLOBAL_BYTES) return;
  await visitScopeMasks(transaction, null, MAX_GLOBAL_MASKS, signal, async (raw) => {
    const current = validateMaskRecord(raw);
    if (sameMaskScope(current, scope) || current.pinned || maskLeases(current).length > 0 || current.uploadState !== null ||
      await anyWriterReferences(transaction.objectStore(WRITERS), current.photoId, current.sha256, signal, transaction)) return true;
    const bytes = maskBytes(current);
    await updateCombinedBudgets(transaction.objectStore(META), current, 0, -1, -bytes, signal, transaction);
    transaction.objectStore(MASKS).delete(current.key);
    globalCount -= 1;
    globalBytes -= bytes;
    return globalCount + 1 > MAX_GLOBAL_MASKS || globalBytes + incomingBytes > MAX_GLOBAL_BYTES;
  });
}

async function visitScopeMasks(
  transaction: IDBTransaction,
  scope: RecipeJournalScope | null,
  limit: number,
  signal: AbortSignal | undefined,
  visit: (record: unknown) => boolean | Promise<boolean>,
): Promise<void> {
  await transactionWait(new Promise<void>((resolve, reject) => {
    let count = 0;
    const masks = transaction.objectStore(MASKS);
    const prefix = scope === null ? null : scopeKey(scope);
    const request = prefix === null ? masks.openCursor()
      : masks.index(MASK_SCOPE).openCursor(IDBKeyRange.bound(prefix, [...prefix, []]));
    request.onerror = () => reject(idbError(request.error));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || count >= limit) { resolve(); return; }
      count += 1;
      // Visit one PNG at a time; never materialize the combined mask byte budget.
      void Promise.resolve().then(async () => {
        if (await visit(cursor.value)) cursor.continue();
        else resolve();
      }).catch((error: unknown) => { abort(transaction); reject(error); });
    };
  }), transaction, signal);
}

function maskLeases(record: MaskRecord): readonly MaskSurfacePinLease[] {
  return record.schemaVersion === 1 ? [] : record.pinLeases ?? [];
}

function validateLease(value: MaskSurfacePinLease): void {
  if (!isRecord(value) || !exactKeys(value, ["writerId", "pinToken"])) unavailable();
  validateOpaque(value.writerId);
  validateOpaque(value.pinToken);
}

function validateLeaseList(values: readonly MaskSurfacePinLease[], writerId?: string): void {
  if (!Array.isArray(values) || values.length > MAX_SCOPE_MASKS) unavailable();
  values.forEach((value) => {
    validateLease(value);
    if (writerId !== undefined && value.writerId !== writerId) unavailable();
  });
  if (new Set(values.map((value) => `${value.writerId}\u0000${value.pinToken}`)).size !== values.length) unavailable();
}

function sameLease(left: MaskSurfacePinLease, right: MaskSurfacePinLease): boolean {
  return left.writerId === right.writerId && left.pinToken === right.pinToken;
}

async function anyWriterReferences(
  store: IDBObjectStore,
  photoId: string,
  sha: string,
  signal: AbortSignal | undefined,
  transaction: IDBTransaction,
): Promise<boolean> {
  return await transactionWait(new Promise<boolean>((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(idbError(request.error));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) { resolve(false); return; }
      try {
        const record = validateRecord(cursor.value);
        if (record.photoId === photoId && writerReferences(record, sha)) { resolve(true); return; }
        cursor.continue();
      } catch (error) { reject(error); }
    };
  }), transaction, signal);
}

function writerReferences(record: WriterRecord, sha: string): boolean {
  // Conflict metadata retains hashes rather than full candidates. Keep this
  // photo's surfaces until those snapshots are explicitly settled/discarded.
  if (record.conflicts.length > 0) return true;
  if (record.latest?.candidate.maskSurfaceIds.includes(sha) || record.attempt?.candidate.maskSurfaceIds.includes(sha)) return true;
  return record.resolution?.proof.decision === "adopt" && record.resolution.proof.selectedCandidate.maskSurfaceIds.includes(sha);
}

function maskKey(scope: RecipeJournalScope, photoId: string, sha: string): string { return JSON.stringify([...scopeKey(scope), photoId, sha]); }
function sameMaskScope(record: MaskRecord, scope: RecipeJournalScope): boolean { return record.actorId === scope.actorId && record.libraryId === scope.libraryId && record.sessionId === scope.sessionId && record.sessionEpoch === scope.sessionEpoch && record.transport === scope.transport; }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]); }
function validateSha(value: unknown): asserts value is string { if (typeof value !== "string" || !SHA256.test(value)) unavailable(); }
function digestBytes(value: Uint8Array): string { return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(name, DATABASE_VERSION); } catch (error) { reject(idbError(error)); return; }
    request.onupgradeneeded = (event) => {
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion === 0) {
        const writers = request.result.createObjectStore(WRITERS, { keyPath: "id" });
        writers.createIndex(SCOPE_TOKEN, ["actorId", "libraryId", "sessionId", "sessionEpoch", "transport", "token"], { unique: true });
        request.result.createObjectStore(META, { keyPath: "key" });
      } else if (oldVersion !== 1 && oldVersion !== 2) { request.transaction?.abort(); return; }
      if (oldVersion < 2) {
        const masks = request.result.createObjectStore(MASKS, { keyPath: "key" });
        masks.createIndex(MASK_SCOPE, ["actorId", "libraryId", "sessionId", "sessionEpoch", "transport", "photoId", "sha256"], { unique: true });
      }
      if (oldVersion < 3) request.result.createObjectStore(SCOPE_FENCES, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(idbError(request.error));
    request.onblocked = () => reject(new Error("Recipe journal database is blocked"));
  });
}

function strictTransaction(database: IDBDatabase, stores: string[], mode: IDBTransactionMode): IDBTransaction {
  try { return database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined); }
  catch (error) { throw idbError(error); }
}

function transactionBarrier(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(idbError(transaction.error));
    transaction.onerror = () => reject(idbError(transaction.error));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(idbError(request.error));
  });
}

async function transactionWait<T>(promise: Promise<T>, transaction: IDBTransaction, signal?: AbortSignal): Promise<T> {
  return await awaitBounded(promise, {
    signal: signal ?? NEVER_ABORTS,
    timeoutMs: IDB_TIMEOUT_MS,
    onAbort: () => abort(transaction),
    onTimeout: () => abort(transaction),
  });
}

function scopeKey(scope: RecipeJournalScope): [string, string, string, string, string] {
  return [scope.actorId, scope.libraryId, scope.sessionId, scope.sessionEpoch, scope.transport];
}

function scopeFenceKey(scope: RecipeJournalScope): string {
  return JSON.stringify(["niho-photo-recipe-scope-fence-v1", ...scopeKey(scope)]);
}

async function assertScopeNotRevoked(
  fences: IDBObjectStore,
  scope: RecipeJournalScope,
  transaction: IDBTransaction,
  signal?: AbortSignal,
): Promise<void> {
  const key = scopeFenceKey(scope);
  const value = await transactionWait(requestResult(fences.get(key)), transaction, signal);
  if (value === undefined) return;
  if (!isRecord(value) || !exactKeys(value, ["key", "revoked"]) || value.key !== key || value.revoked !== true) {
    abort(transaction);
    unavailable();
  }
  abort(transaction);
  unavailable();
}

type PreviousIndexKey = [string, string, string, string, string, string];

function indexKey(binding: RecipeWriterBinding): PreviousIndexKey {
  return [...scopeKey(binding), binding.token];
}

function parsePreviousCursor(value: string, scope: RecipeJournalScope): PreviousIndexKey {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 4096) unavailable();
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { unavailable(); }
  if (!Array.isArray(parsed) || parsed.length !== 6 || !parsed.every(nonEmpty)) unavailable();
  const cursor = parsed as PreviousIndexKey;
  if (cursor[0] !== scope.actorId || cursor[1] !== scope.libraryId) unavailable();
  if (
    cursor[2] === scope.sessionId && cursor[3] === scope.sessionEpoch && cursor[4] === scope.transport ||
    cursor[4] !== "browser-session" && cursor[4] !== "mac-bearer"
  ) unavailable();
  return cursor;
}

function recordId(binding: RecipeWriterBinding): string {
  return JSON.stringify([...scopeKey(binding), binding.writerId]);
}

function sameScope(record: WriterRecord, scope: RecipeJournalScope): boolean {
  return record.actorId === scope.actorId && record.libraryId === scope.libraryId && record.sessionId === scope.sessionId && record.sessionEpoch === scope.sessionEpoch && record.transport === scope.transport;
}

function sameCanonicalScope(record: WriterRecord, scope: RecipeJournalScope): boolean {
  return record.actorId === scope.actorId && record.libraryId === scope.libraryId;
}

function sameBinding(record: WriterRecord, binding: RecipeWriterBinding): boolean {
  return sameScope(record, binding) && record.token === binding.token && record.writerId === binding.writerId && record.photoId === binding.photoId && record.sourceSha256 === binding.sourceSha256 && record.initialRevision === binding.initialRevision;
}

function digest(body: string): string {
  return Array.from(sha256(new TextEncoder().encode(body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { unavailable(); } }
function jsonBytes(value: unknown): number { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { unavailable(); } }
function clone<T>(value: T): T { return value === null ? value : structuredClone(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safePositive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value); }
function validateOpaque(value: unknown): asserts value is string { if (!nonEmpty(value) || new TextEncoder().encode(value).byteLength > 512) unavailable(); }
function validateKey(value: unknown): asserts value is string { validateOpaque(value); if ((value as string).includes(",") || new TextEncoder().encode(value as string).byteLength > PHOTO_LIMITS.maxIdempotencyKeyBytes) unavailable(); }
function abort(transaction: IDBTransaction): void { try { transaction.abort(); } catch { /* already settled */ } }
function idbError(error: unknown): Error { return error instanceof Error ? error : new Error("Recipe journal unavailable"); }
function unavailable(): never { throw new Error("Recipe journal unavailable"); }
