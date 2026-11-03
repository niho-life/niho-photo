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
  PendingWriterPage,
  PendingWriterToken,
  RecipeConflictIntent,
  RecipeJournalScope,
  RecipeSyncJournal,
  RecipeWriterBinding,
  ReopenedJournalWriter,
} from "../types";

const DATABASE_VERSION = 1;
const WRITERS = "writers";
const META = "meta";
const SCOPE_TOKEN = "scopeToken";
const IDB_TIMEOUT_MS = 15_000;
const MAX_SCOPE_WRITERS = 16;
const MAX_SCOPE_BYTES = 32 * 1024 ** 2;
const MAX_GLOBAL_WRITERS = 64;
const MAX_GLOBAL_BYTES = 128 * 1024 ** 2;
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
  readonly bytes: number;
}

export class IndexedDbRecipeSyncJournal implements RecipeSyncJournal {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private disposed = false;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = "niho-personal-photo-recipe-sync-v1",
  ) {}

  async stage(binding: RecipeWriterBinding, stage: JournalStage, signal?: AbortSignal): Promise<void> {
    validateBinding(binding);
    validateStage(stage);
    await this.mutate(binding, signal, (current) => {
      if (stage.generation < current.nextGeneration) unavailable();
      return {
        ...current,
        revision: current.revision + 1,
        nextGeneration: stage.generation + 1,
        latest: clone(stage),
      };
    }, stage.generation);
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
    const transaction = strictTransaction(database, [WRITERS], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
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

  async reopen(scope: RecipeJournalScope, token: string, signal?: AbortSignal): Promise<ReopenedJournalWriter | null> {
    validateScope(scope);
    validateOpaque(token);
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS], "readonly");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
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
    const transaction = strictTransaction(database, [WRITERS, META], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    const store = transaction.objectStore(WRITERS);
    const currentRaw = await transactionWait(requestResult(store.get(recordId(binding))), transaction, signal);
    if (currentRaw !== undefined) {
      const current = validateRecord(currentRaw);
      if (!sameBinding(current, binding)) { abort(transaction); unavailable(); }
      if (current.attempt !== null || current.resolution !== null) { abort(transaction); unavailable(); }
      await updateBudgets(transaction.objectStore(META), binding, current, null, signal, transaction);
      store.delete(current.id);
    }
    await transactionWait(barrier, transaction, signal);
  }

  async releaseCompleted(binding: RecipeWriterBinding, signal?: AbortSignal): Promise<boolean> {
    validateBinding(binding);
    let released = false;
    const database = await this.database(signal);
    const transaction = strictTransaction(database, [WRITERS, META], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    const store = transaction.objectStore(WRITERS);
    const currentRaw = await transactionWait(requestResult(store.get(recordId(binding))), transaction, signal);
    if (currentRaw !== undefined) {
      const current = validateRecord(currentRaw);
      if (!sameBinding(current, binding)) { abort(transaction); unavailable(); }
      if (!hasRetainedState(current) && current.terminalReason === null) {
        await updateBudgets(transaction.objectStore(META), binding, current, null, signal, transaction);
        store.delete(current.id);
        released = true;
      }
    }
    await transactionWait(barrier, transaction, signal);
    return released;
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
    const transaction = strictTransaction(database, [WRITERS, META], "readwrite");
    const barrier = transactionBarrier(transaction);
    void barrier.catch(() => undefined);
    const store = transaction.objectStore(WRITERS);
    const raw = await transactionWait(requestResult(store.get(recordId(binding))), transaction, signal);
    const current = raw === undefined ? initialRecord(binding, initialGeneration) : validateRecord(raw);
    if (!sameBinding(current, binding)) { abort(transaction); unavailable(); }
    const next = change(clone(current));
    validateRecord(next);
    if (next.id !== current.id || next.revision < current.revision || !sameBinding(next, binding)) { abort(transaction); unavailable(); }
    if (!deepEqual(next, current)) {
      await updateBudgets(transaction.objectStore(META), binding, raw === undefined ? null : current, next, signal, transaction);
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

async function updateBudgets(
  store: IDBObjectStore,
  binding: RecipeWriterBinding,
  before: WriterRecord | null,
  after: WriterRecord | null,
  signal: AbortSignal | undefined,
  transaction: IDBTransaction,
): Promise<void> {
  const scopeBudgetKey = `scope:${JSON.stringify(scopeKey(binding))}`;
  const [globalRaw, scopeRaw] = await Promise.all([
    transactionWait(requestResult(store.get("global")), transaction, signal),
    transactionWait(requestResult(store.get(scopeBudgetKey)), transaction, signal),
  ]);
  const global = budget(globalRaw, "global");
  const scoped = budget(scopeRaw, scopeBudgetKey);
  const countDelta = (after === null ? 0 : 1) - (before === null ? 0 : 1);
  const byteDelta = (after === null ? 0 : jsonBytes(after)) - (before === null ? 0 : jsonBytes(before));
  const nextGlobal = { key: "global", writers: global.writers + countDelta, bytes: global.bytes + byteDelta };
  const nextScope = { key: scopeBudgetKey, writers: scoped.writers + countDelta, bytes: scoped.bytes + byteDelta };
  if (
    nextScope.writers < 0 || nextScope.bytes < 0 || nextGlobal.writers < 0 || nextGlobal.bytes < 0 ||
    nextScope.writers > MAX_SCOPE_WRITERS || nextScope.bytes > MAX_SCOPE_BYTES ||
    nextGlobal.writers > MAX_GLOBAL_WRITERS || nextGlobal.bytes > MAX_GLOBAL_BYTES
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
  if (value === undefined) return { key, writers: 0, bytes: 0 };
  if (!isRecord(value) || value.key !== key || !safeNonNegative(value.writers) || !safeNonNegative(value.bytes)) unavailable();
  return value as unknown as BudgetRecord;
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(name, DATABASE_VERSION); } catch (error) { reject(idbError(error)); return; }
    request.onupgradeneeded = (event) => {
      if ((event as IDBVersionChangeEvent).oldVersion !== 0) { request.transaction?.abort(); return; }
      const writers = request.result.createObjectStore(WRITERS, { keyPath: "id" });
      writers.createIndex(SCOPE_TOKEN, ["actorId", "libraryId", "sessionId", "sessionEpoch", "transport", "token"], { unique: true });
      request.result.createObjectStore(META, { keyPath: "key" });
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

function recordId(binding: RecipeWriterBinding): string {
  return JSON.stringify([...scopeKey(binding), binding.writerId]);
}

function sameScope(record: WriterRecord, scope: RecipeJournalScope): boolean {
  return record.actorId === scope.actorId && record.libraryId === scope.libraryId && record.sessionId === scope.sessionId && record.sessionEpoch === scope.sessionEpoch && record.transport === scope.transport;
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
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value); }
function validateOpaque(value: unknown): asserts value is string { if (!nonEmpty(value) || new TextEncoder().encode(value).byteLength > 512) unavailable(); }
function validateKey(value: unknown): asserts value is string { validateOpaque(value); if ((value as string).includes(",") || new TextEncoder().encode(value as string).byteLength > PHOTO_LIMITS.maxIdempotencyKeyBytes) unavailable(); }
function abort(transaction: IDBTransaction): void { try { transaction.abort(); } catch { /* already settled */ } }
function idbError(error: unknown): Error { return error instanceof Error ? error : new Error("Recipe journal unavailable"); }
function unavailable(): never { throw new Error("Recipe journal unavailable"); }
